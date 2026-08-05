// SPDX-License-Identifier: LicenseRef-holt-Commercial
// Commercial license — see src/team/LICENSE. NOT covered by the repository FSL-1.1-MIT grant.
/**
 * holt Team — policy as code.  (Commercial license: see src/team/LICENSE)
 *
 * Inline CI flags answer "fail this build if anything is abandoned", and that stays free.
 * A team needs something flags cannot express: rules that live in the repository, are reviewed
 * like code, differ per branch pattern, and produce an auditable verdict with a stated reason
 * for every rule that fired.
 *
 * `.holt/policy.json`:
 * {
 *   "version": 1,
 *   "rules": [
 *     { "id": "no-abandoned-work",  "type": "no-unlanded",       "severity": "error",
 *       "exempt": ["spike/*", "archive/*"] },
 *     { "id": "stale-branches",     "type": "max-branch-age",    "days": 30, "severity": "warn" },
 *     { "id": "protected-paths",    "type": "protected-paths",
 *       "paths": ["infra/**", "src/billing/**"], "severity": "error" },
 *     { "id": "no-unknown",         "type": "require-classified", "severity": "error" }
 *   ]
 * }
 *
 * DESIGN RULES, each learned from a real failure class:
 *  - An unparseable or unknown-version policy REFUSES; it never silently applies nothing.
 *    A policy file that quietly does nothing is worse than no policy file, because the team
 *    believes they are covered.
 *  - An unknown rule TYPE is an error, not a skip — same reason.
 *  - Every violation names the rule id, the subject, and the evidence, so a red build is
 *    actionable without re-running anything locally.
 *  - THE SUBJECT OF A GATE NEVER SUPPLIES ITS OWN RULES. See loadGatePolicy below.
 *
 * ---------------------------------------------------------------------------------------------
 * ADJUDICATED 2026-08-01 — WHY THIS IS HAND-ROLLED AND NOT OPA/REGO OR CEDAR
 *
 * The right instinct is to take an existing policy engine rather than grow a bespoke one, and it
 * was evaluated properly. Measured live against the npm registry on 2026-08-01 (re-derive with
 * `npm view <pkg> dist.unpackedSize dependencies time.modified`; these numbers rot, the
 * reasoning does not):
 *
 *   @open-policy-agent/opa-wasm  1.10.0, last published 2024-11-08, 950 KB, 2 runtime deps.
 *     DISQUALIFYING: it only EVALUATES pre-compiled WASM. Its own README says to produce that
 *     with `opa build -t wasm example.rego` — the Go binary. A policy file is written by the
 *     USER, so adopting Rego would require every holt user to install the OPA toolchain merely
 *     to author one. That is not a local-first CLI.
 *
 *   @cedar-policy/cedar-wasm     4.12.0, last published 2026-07-28, 0 runtime deps, Apache-2.0.
 *     Genuinely strong: actively developed, no dependencies, parses and evaluates policy text
 *     in-process with no external compiler, and formally verified. It is 12,745 KB unpacked
 *     against holt's entire shipped surface of 487 KB (bin + src + README) — 26x the whole
 *     product to express four rules.
 *
 * THE DECIDING ARGUMENT IS NOT SIZE, IT IS FIT, AND IT IS THIS: not one of the defects this
 * module has ever had was an EXPRESSIVENESS defect. The gate read its rules from the candidate;
 * a rule matched globs against symbol identities and could never fire; an empty path list
 * validated and passed; unknown keys were silently ignored. Every one of those would have existed
 * identically under Rego or Cedar, because they are defects of PROVENANCE (who wrote the rules)
 * and REACHABILITY (can this rule fire at all) — questions no policy language answers for you.
 * Adopting either engine would have fixed exactly zero of them while adding a language users must
 * learn and a dependency the free tier cannot carry.
 *
 * There is also a semantic mismatch worth naming: Cedar answers "may this principal take this
 * action on this resource", one decision per request. holt's rules are aggregate assertions over
 * a scan result ("no branch may hold unlanded work"). Encoding those means synthesising one
 * authorization request per rule per subject and reassembling the answers here — which is this
 * file, with a 12 MB dependency underneath it.
 *
 * WHAT WOULD HAVE TO BE TRUE TO CHANGE THE ANSWER — adopt Cedar (not Rego, for the compiler
 * reason above), as an OPTIONAL dependency so the free tier stays dependency-free, when ANY of:
 *   1. Users need rules these four types cannot express: conditionals, arithmetic, cross-rule
 *      logic, per-branch-pattern overrides, or their own predicates. One request is an anecdote;
 *      the trigger is the third distinct one that cannot be expressed by adding a rule type.
 *   2. The rule-type count passes ~10, where a hand-rolled validator stops being reviewable in
 *      one sitting and an off-the-shelf grammar starts being cheaper than the one here.
 *   3. A buyer requires a formally verified engine, or wants to reuse an existing Cedar/Rego
 *      corpus they already maintain. This is a real procurement ask and it outranks every
 *      argument above on its own.
 *   4. Policy needs to be authored or analysed OUTSIDE holt — a central service, a policy
 *      linter, "which repositories would this rule change break" — where a standard language
 *      and its tooling are the product rather than an implementation detail.
 * ---------------------------------------------------------------------------------------------
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { git } from '../git.mjs';

/**
 * jsonc-parser is an exact required runtime dependency. It remains dynamically loaded and cached
 * so a damaged installation reaches an actionable reinstall error instead of dying inside Node's
 * module loader before Holt can explain what is missing.
 */
/** @type {any} */
let _jsonc = null;
async function loadJsonc() {
  if (_jsonc !== null) return _jsonc;
  try {
    _jsonc = await import('jsonc-parser');
  } catch {
    _jsonc = false; // sentinel: loaded but absent
  }
  return _jsonc;
}
// Preload at module init so the synchronous parsePolicy() can read the cache.
await loadJsonc();
function missingJsonc() {
  throw new Error(
    "holt requires its exact 'jsonc-parser' runtime dependency to parse policy files; " +
    'reinstall Holt from an intact release',
  );
}
export const POLICY_PATHS = ['.holt/policy.json', '.holt/policy.jsonc'];

const RULE_TYPES = new Set(['no-unlanded', 'max-branch-age', 'protected-paths', 'require-classified']);
const SEVERITIES = new Set(['error', 'warn']);
const MAX_POLICY_BYTES = 1024 * 1024;
const MAX_POLICY_DEPTH = 32;
const MAX_POLICY_NODES = 20_000;
const MAX_POLICY_RULES = 512;
const MAX_GLOBS_PER_FIELD = 128;
const MAX_GLOB_LENGTH = 512;
const MAX_DESCRIPTION_LENGTH = 4096;
const MAX_GLOB_MATCH_STEPS = 10_000_000;
const MAX_GLOB_SUBJECT_LENGTH = 64 * 1024;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/u;

/**
 * Compile Holt's deliberately small glob language into tokens, not a regular expression.
 *
 * The previous translator emitted chains such as `.*a.*a.*a…b`. JavaScript's backtracking
 * engine took seconds to reject a 31-byte subject against a 46-byte policy glob. This matcher is
 * a bounded dynamic program: every pattern/input state is visited at most once, and each policy
 * evaluation carries a total work budget. Literal prefix/suffix checks make ordinary repository
 * globs such as a recursive infrastructure directory or a JavaScript suffix fast without
 * weakening the worst-case bound.
 */
function compileGlob(glob) {
  const tokens = [];
  let hasWildcard = false;
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*') {
      hasWildcard = true;
      if (glob[i + 1] === '*') {
        tokens.push({ type: 'globstar' });
        i++;
        // Preserve the legacy double-star-then-slash spelling: the slash is part of the
        // cross-segment wildcard, so that pattern before `x` matches both `x` and `a/x`.
        if (glob[i + 1] === '/') i++;
      } else tokens.push({ type: 'star' });
    } else if (char === '?') {
      hasWildcard = true;
      tokens.push({ type: 'one' });
    } else tokens.push({ type: 'literal', value: char });
  }

  let prefix = '';
  for (const token of tokens) {
    if (token.type !== 'literal') break;
    prefix += token.value;
  }
  let suffix = '';
  for (let i = tokens.length - 1; i >= 0 && tokens[i].type === 'literal'; i--) {
    suffix = tokens[i].value + suffix;
  }
  return Object.freeze({ glob, tokens: Object.freeze(tokens), hasWildcard, prefix, suffix });
}

function safeGlobTest(compiled, rawValue, budget) {
  const value = String(rawValue);
  if (value.length > MAX_GLOB_SUBJECT_LENGTH) {
    refuse('POLICY_COMPLEXITY', `glob subject exceeds ${MAX_GLOB_SUBJECT_LENGTH} characters`);
  }
  // Even a prefix/suffix rejection consumes work. Otherwise an attacker could submit millions
  // of deliberately mismatching subjects and stay outside the deterministic budget entirely.
  const guardSteps = 1 + compiled.prefix.length + compiled.suffix.length;
  if (!Number.isSafeInteger(guardSteps) || guardSteps > budget.remaining) {
    refuse(
      'POLICY_COMPLEXITY',
      `glob evaluation exceeds the ${MAX_GLOB_MATCH_STEPS}-state deterministic work budget`,
    );
  }
  budget.remaining -= guardSteps;
  if (!compiled.hasWildcard) return value === compiled.glob;
  if (compiled.prefix && !value.startsWith(compiled.prefix)) return false;
  if (compiled.suffix && !value.endsWith(compiled.suffix)) return false;

  const steps = (compiled.tokens.length + 1) * (value.length + 1);
  if (!Number.isSafeInteger(steps) || steps > budget.remaining) {
    refuse(
      'POLICY_COMPLEXITY',
      `glob evaluation exceeds the ${MAX_GLOB_MATCH_STEPS}-state deterministic work budget`,
    );
  }
  budget.remaining -= steps;

  let current = new Uint8Array(value.length + 1);
  current[0] = 1;
  for (const token of compiled.tokens) {
    const next = new Uint8Array(value.length + 1);
    if (token.type === 'star' || token.type === 'globstar') next[0] = current[0];
    for (let index = 1; index <= value.length; index++) {
      const char = value[index - 1];
      if (token.type === 'literal') next[index] = current[index - 1] && char === token.value ? 1 : 0;
      else if (token.type === 'one') next[index] = current[index - 1] && char !== '/' ? 1 : 0;
      else {
        const mayConsume = token.type === 'globstar' || char !== '/';
        next[index] = current[index] || (mayConsume && next[index - 1]) ? 1 : 0;
      }
    }
    current = next;
  }
  return current[value.length] === 1;
}

/**
 * Compatibility name retained for internal/tests callers. The returned object intentionally has
 * only the RegExp-like `.test()` surface; it is a deterministic matcher, never a backtracking
 * regular expression.
 */
export function globToRegExp(glob) {
  const compiled = compileGlob(glob);
  return Object.freeze({
    source: `holt-safe-glob:${glob}`,
    flags: '',
    test: (value) => safeGlobTest(compiled, value, { remaining: MAX_GLOB_MATCH_STEPS }),
  });
}

function matchesAny(value, globs, budget) {
  return (globs ?? []).some((glob) => {
    let compiled = budget.compiled.get(glob);
    if (!compiled) {
      compiled = compileGlob(glob);
      budget.compiled.set(glob, compiled);
    }
    return safeGlobTest(compiled, value, budget);
  });
}

function newGlobBudget() {
  return { remaining: MAX_GLOB_MATCH_STEPS, compiled: new Map() };
}

/**
 * THE PATHS A WORKSTREAM IS CARRYING — the input every path-shaped rule must read.
 *
 * A path rule matched against something that is not a path cannot fire, and it cannot say so:
 * it reports a clean build, which is the worst possible failure for a policy engine. That is
 * exactly what happened here. `report.unique[].byLayer` holds SYMBOLS, whose path field is
 * `file`; the rule read `x.path ?? x.key`, `path` does not exist on a symbol, and `key` is a
 * `kind:name` identity like `callable:deployProductionCluster`. No repository glob can ever match
 * one, so `protected-paths` passed every real repository it was ever pointed at.
 *
 * Reading `file` instead would still not be enough, and that is the general rule worth stating:
 * THE SYMBOL LAYER CANNOT REPRESENT PATH RISK. A file no parser understands (`infra/*.env`, a
 * CSV, a design asset) yields no symbol at all, and a symbol two workstreams share is not unique
 * so it never reaches `byLayer` either. So the file layer is the primary source and the symbol
 * layer is only a fallback — and in the fallback a symbol's real path field is read, never its
 * identity key. Hand-built callers that supply `{path}` keep working unchanged.
 */
function pathsCarriedBy(u, layers) {
  const out = new Set();
  for (const layer of layers) {
    const pathRows = u?.pathsByLayer?.[layer];
    const symbolRows = u?.byLayer?.[layer];
    if (pathRows !== undefined && !Array.isArray(pathRows)) return null;
    if (symbolRows !== undefined && !Array.isArray(symbolRows)) return null;
    for (const p of pathRows ?? []) {
      if (typeof p !== 'string' || !p || p.includes('\0')) return null;
      out.add(p);
    }
    for (const s of symbolRows ?? []) {
      const p = typeof s === 'string' ? s : (s?.file ?? s?.path);
      if (typeof p !== 'string' || !p || p.includes('\0')) return null;
      out.add(p);
    }
  }
  // Sorted, so the evidence a reviewer is shown is the same on every run and across machines.
  return [...out].sort();
}

/**
 * The complete authoritative path set from branchAudit(), never its UI sample.
 *
 * `branch.files` is capped for terminal/JSON readability.  A policy that checks only that
 * sample can pass a branch which changes its 26th file under a protected path.  Older callers
 * may not yet supply `carriedPaths`; their `files` are acceptable only when the declared count
 * proves that the list is complete.  Otherwise the policy must fail closed rather than turn a
 * truncated display into an authorization decision.
 */
function authoritativeBranchPaths(branch) {
  if (!Number.isSafeInteger(branch?.fileCount) || branch.fileCount < 0) return null;
  const inventory = Array.isArray(branch?.carriedPaths) ? branch.carriedPaths : branch?.files;
  if (!Array.isArray(inventory)) return null;
  if (inventory.some((p) => typeof p !== 'string' || !p || p.includes('\0'))) return null;
  const unique = new Set(inventory);
  if (unique.size !== inventory.length || inventory.length !== branch.fileCount) return null;
  return [...unique].sort();
}

/* ============================================================== VALIDATION ==== */

/** Keys every rule may carry, plus the keys each TYPE adds. Anything else is a refusal. */
const COMMON_RULE_KEYS = new Set(['id', 'type', 'severity', 'enabled', 'description']);
const TYPE_RULE_KEYS = {
  'no-unlanded': new Set(['exempt']),
  'max-branch-age': new Set(['exempt', 'days']),
  'protected-paths': new Set(['paths']),
  'require-classified': new Set([]),
};
const TOP_LEVEL_KEYS = new Set(['version', 'rules', 'description']);

/** Does this glob's actual compiler match empty, slash-only, flat and nested subjects? */
function universalGlob(glob) {
  const compiled = compileGlob(glob);
  const budget = newGlobBudget();
  return ['', '/', 'plain', 'a/b'].every((subject) => safeGlobTest(compiled, subject, budget));
}

const refuse = (code, message) => { throw Object.assign(new Error(message), { code }); };

/**
 * Every glob in `list` must be a non-empty string. A non-string here used to reach
 * `globToRegExp`, where `glob.length` on `null` threw a TypeError from the middle of evaluation.
 */
function checkGlobs(list, { label, ruleId, field }) {
  if (list.length > MAX_GLOBS_PER_FIELD) {
    refuse('POLICY_LIMIT', `${label}: rule '${ruleId}' ${field} exceeds ${MAX_GLOBS_PER_FIELD} globs`);
  }
  list.forEach((g, i) => {
    if (typeof g !== 'string' || !g.trim()) {
      refuse('POLICY_RULE', `${label}: rule '${ruleId}' ${field}[${i}] must be a non-empty string glob, got ${JSON.stringify(g)}`);
    }
    if (g.length > MAX_GLOB_LENGTH || CONTROL_RE.test(g)) {
      refuse('POLICY_LIMIT', `${label}: rule '${ruleId}' ${field}[${i}] must be at most ${MAX_GLOB_LENGTH} control-free characters`);
    }
  });
}

/**
 * Validate one policy document. `label` names the source in every refusal.
 *
 * Uses jsonc-parser (not regex) so a string containing `//` is not truncated mid-literal.
 *
 * THE STANDARD: a policy must be incapable of reading as strict to its author while running as
 * inert in the binary. Three additions over the original validator, each reproduced first:
 *
 *   UNKNOWN KEYS REFUSE. `{"sevrity":"warn"}` and a top-level `"defaultSeverity"` were silently
 *   ignored. Silent tolerance of a typo means the file a security reviewer reads and the rules
 *   the binary runs are two different documents, and nothing anywhere says so.
 *
 *   VACUOUS RULES REFUSE. `{"type":"protected-paths","paths":[]}` validated, matched nothing and
 *   passed every build; `{"exempt":["**"]}` exempts every subject there can be. Both are rules
 *   that CANNOT FIRE — a green build from a rule that never ran.
 *
 *   NON-STRING GLOBS REFUSE, at load time, instead of crashing the evaluator mid-run.
 */
export function validatePolicyObject(doc, label = 'policy') {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    refuse('POLICY_SCHEMA', `${label} must be a policy object`);
  }
  if (doc?.version !== 1) {
    refuse('POLICY_VERSION', `${label}: unsupported policy version ${JSON.stringify(doc?.version)} — upgrade holt rather than run an unenforced policy`);
  }
  for (const k of Object.keys(doc)) {
    if (!TOP_LEVEL_KEYS.has(k)) {
      refuse('POLICY_SCHEMA', `${label}: unknown top-level key '${k}'. Known: ${[...TOP_LEVEL_KEYS].join(', ')}. holt refuses rather than ignore it — a key holt does not act on is a rule you believe you have and do not.`);
    }
  }
  if (doc.description !== undefined
    && (typeof doc.description !== 'string' || doc.description.length > MAX_DESCRIPTION_LENGTH
      || CONTROL_RE.test(doc.description))) {
    refuse('POLICY_LIMIT', `${label}: description must be a control-free string no longer than ${MAX_DESCRIPTION_LENGTH} characters`);
  }
  if (!Array.isArray(doc.rules) || doc.rules.length === 0) {
    refuse('POLICY_EMPTY', `${label}: no rules defined — an empty policy would pass everything silently`);
  }
  if (doc.rules.length > MAX_POLICY_RULES) {
    refuse('POLICY_LIMIT', `${label}: rules exceeds the ${MAX_POLICY_RULES}-entry policy limit`);
  }

  const seen = new Set();
  for (const r of doc.rules) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      refuse('POLICY_RULE', `${label}: every entry of 'rules' must be an object, got ${JSON.stringify(r)}`);
    }
    if (typeof r.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(r.id)) {
      refuse('POLICY_RULE', `${label}: every rule needs a 1-128 character canonical id (letters, digits, dot, underscore or hyphen)`);
    }
    if (seen.has(r.id)) refuse('POLICY_RULE', `${label}: duplicate rule id '${r.id}'`);
    seen.add(r.id);
    if (!RULE_TYPES.has(r.type)) {
      refuse('POLICY_RULE', `${label}: rule '${r.id}' has unknown type '${r.type}'. Known: ${[...RULE_TYPES].join(', ')}`);
    }

    const allowed = new Set([...COMMON_RULE_KEYS, ...TYPE_RULE_KEYS[r.type]]);
    for (const k of Object.keys(r)) {
      if (!allowed.has(k)) {
        refuse('POLICY_SCHEMA', `${label}: rule '${r.id}' has unknown key '${k}'. A rule of type '${r.type}' accepts: ${[...allowed].sort().join(', ')}`);
      }
    }
    if (r.description !== undefined
      && (typeof r.description !== 'string' || r.description.length > MAX_DESCRIPTION_LENGTH
        || CONTROL_RE.test(r.description))) {
      refuse('POLICY_LIMIT', `${label}: rule '${r.id}' description must be a control-free string no longer than ${MAX_DESCRIPTION_LENGTH} characters`);
    }
    if (r.severity !== undefined && !SEVERITIES.has(r.severity)) {
      refuse('POLICY_RULE', `${label}: rule '${r.id}' has unknown severity '${r.severity}'`);
    }
    if (r.enabled !== undefined && typeof r.enabled !== 'boolean') {
      refuse('POLICY_RULE', `${label}: rule '${r.id}' has a non-boolean 'enabled' (${JSON.stringify(r.enabled)})`);
    }
    if (r.exempt !== undefined && !Array.isArray(r.exempt)) {
      refuse('POLICY_RULE', `${label}: rule '${r.id}' has a non-array 'exempt'`);
    }
    if (Array.isArray(r.exempt)) checkGlobs(r.exempt, { label, ruleId: r.id, field: 'exempt' });

    if (r.type === 'max-branch-age'
      && (typeof r.days !== 'number' || !Number.isFinite(r.days) || r.days <= 0 || r.days > 365_000)) {
      refuse('POLICY_RULE', `${label}: rule '${r.id}' needs a positive 'days' that is a finite number no greater than 365000`);
    }
    if (r.type === 'protected-paths') {
      if (!Array.isArray(r.paths)) refuse('POLICY_RULE', `${label}: rule '${r.id}' needs a 'paths' array`);
      checkGlobs(r.paths, { label, ruleId: r.id, field: 'paths' });
    }

    // ---- can this rule fire at all? -------------------------------------------------
    if (r.enabled === false) continue; // switched off in words; honoured and reported later
    if (r.type === 'protected-paths' && r.paths.length === 0) {
      refuse('POLICY_VACUOUS', `${label}: rule '${r.id}' protects an EMPTY list of paths, so it can never fire — a rule that cannot fail is a green build nobody earned. Give it paths, or set "enabled": false to turn it off deliberately.`);
    }
    if (Array.isArray(r.exempt) && r.exempt.some((g) => universalGlob(g.trim()))) {
      refuse('POLICY_VACUOUS', `${label}: rule '${r.id}' exempts every possible subject (${r.exempt.join(', ')}), so it can never fire. Narrow the exemption, or set "enabled": false to turn it off deliberately.`);
    }
  }
  return doc;
}

function policyTreeValue(raw, label) {
  const text = String(raw);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_POLICY_BYTES) {
    refuse('POLICY_LIMIT', `${label} is ${bytes} bytes; policy files are limited to ${MAX_POLICY_BYTES}`);
  }

  if (!_jsonc) missingJsonc();
  const errors = [];
  const root = _jsonc.parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length || !root) {
    refuse('POLICY_PARSE', `${label} is not valid JSON/JSONC (${errors.length} parse error(s)) — refusing to run with a policy nobody can read`);
  }

  let nodes = 0;
  const stack = [{ node: root, depth: 0, path: '$' }];
  while (stack.length) {
    const frame = stack.pop();
    if (!frame) break; // narrowed for static analysis; the loop condition makes this unreachable.
    const { node, depth, path: jsonPath } = frame;
    nodes++;
    if (nodes > MAX_POLICY_NODES) {
      refuse('POLICY_LIMIT', `${label} exceeds the ${MAX_POLICY_NODES}-node structural limit`);
    }
    if (depth > MAX_POLICY_DEPTH) {
      refuse('POLICY_LIMIT', `${label} exceeds the ${MAX_POLICY_DEPTH}-level nesting limit at ${jsonPath}`);
    }
    if (node.type === 'object') {
      const seen = new Set();
      for (const property of node.children ?? []) {
        const keyNode = property.children?.[0];
        const valueNode = property.children?.[1];
        const key = keyNode?.value;
        if (typeof key !== 'string' || !valueNode) {
          refuse('POLICY_PARSE', `${label} contains a malformed object member at ${jsonPath}`);
        }
        if (seen.has(key)) {
          refuse('POLICY_DUPLICATE_KEY', `${label} repeats key '${key}' at ${jsonPath}; duplicate JSON members are ambiguous and refuse`);
        }
        seen.add(key);
        stack.push({ node: valueNode, depth: depth + 1, path: `${jsonPath}.${key}` });
      }
    } else if (node.type === 'array') {
      for (let index = 0; index < (node.children ?? []).length; index++) {
        stack.push({ node: node.children[index], depth: depth + 1, path: `${jsonPath}[${index}]` });
      }
    }
  }
  return _jsonc.getNodeValue(root);
}

export function parsePolicy(raw, label) {
  // Parse the syntax tree first. Materialising an object directly discards duplicate keys, so a
  // reviewed `"enabled": true, "enabled": false` document previously ran as disabled while
  // still looking enabled to a human. Tree inspection also gives one bounded structural gate.
  return validatePolicyObject(policyTreeValue(raw, label), label);
}

/** Internal alias for callers that still use the old name. */
function validatePolicy(raw, rel) { return parsePolicy(raw, rel); }

/**
 * THE RULES MUST NOT COME FROM THE THING BEING JUDGED.
 *
 * `holt ci` read `.holt/policy.json` off the working tree — which, in the only place this gate
 * runs, is a checkout of the PULL REQUEST. The branch under review supplied the rules that judged
 * it. So the policy is read from the BASE REF using `git show <base>:<path>`, which reads the
 * committed object and never touches the working tree.
 *
 * `readAt` is injected rather than imported so this module stays free of a git dependency and can
 * still be unit-tested on plain objects. When it is absent the behaviour is unchanged, which is
 * what keeps `holt ci` working outside a PR (running on the base branch itself, the working tree
 * IS the authority).
 */
export async function loadPolicyFrom(readAt) {
  for (const rel of POLICY_PATHS) {
    let raw;
    try { raw = await readAt(rel); } catch { continue; }
    if (raw == null) continue;
    const policy = parsePolicy(raw, rel);
    return { found: true, path: rel, policy, source: 'base-ref', trusted: true };
  }
  return { found: false };
}

/** Load and validate from the WORKING TREE. Returns {found:false} when absent. */
export async function loadPolicy(root) {
  for (const rel of POLICY_PATHS) {
    let raw;
    try { raw = await fs.readFile(path.join(root, rel), 'utf8'); } catch { continue; }
    return { found: true, path: rel, policy: parsePolicy(raw, rel), source: 'worktree', trusted: false, raw };
  }
  return { found: false };
}

/**
 * THE GATE LOADER — the policy `holt ci` is entitled to enforce.
 *
 * MEASURED DEFECT: `holt ci` read `.holt/policy.json` from the WORKING TREE, which in a pull
 * request is the CANDIDATE's copy. A branch that deleted or weakened that file was then judged
 * by its own edited rules: on main the gate refused, and on a branch whose only change was
 * `rm .holt/policy.json` it went green. The subject of a gate had write access to the gate.
 *
 * The rule, and it is the same one GitHub applies to CODEOWNERS: RULES COME FROM THE BASE, the
 * ref the work will be merged INTO, because that is the copy reviewers already approved. A pull
 * request may propose new rules; it may not enact them upon itself.
 *
 * The working tree is a FALLBACK, reachable only when the base declares no policy at all — a
 * repository adopting policy for the first time, or a developer running holt locally before
 * committing one. That fallback cannot be turned into a bypass, in either direction:
 *
 *   - it is never consulted when the base HAS a policy, so a head-side edit or deletion is
 *     invisible to the gate; and
 *   - what it returns is marked `trusted: false`, and the caller must not let an untrusted
 *     policy SUPPRESS any check that would otherwise have run. An added policy can only make a
 *     build redder — otherwise "add a permissive .holt/policy.json" becomes the same bypass
 *     through a different door.
 *
 * @param {string} root  repository root
 * @param {string|null} baseRef  the ref/oid the audit compared against — the same base, so the
 *   policy and the evidence it judges can never come from two different worlds.
 */
/**
 * Compose the final `holt ci` verdict from the policy result and the inline-flag result.
 *
 * THE RULE, stated once and enforced here rather than remembered at the call site: a policy
 * holt does not TRUST — one the base ref does not carry, so it arrived from the candidate's own
 * working tree — may ADD failures and may never remove them. Without this, "the PR deletes
 * .holt/policy.json" is merely swapped for "the PR adds a permissive .holt/policy.json", and the
 * gate is neutralised through the other door: policy mode short-circuits the flags, so a rule
 * file the candidate wrote would switch off the `--fail-on-unlanded` the user asked for.
 *
 * A TRUSTED policy keeps the original behaviour exactly — it is the reviewed statement of what
 * this repository wants enforced, so it supersedes the flags as it always did.
 */
/**
 * Load and validate the policy AS IT EXISTS IN `ref` — never from the working tree.
 *
 * FAILS CLOSED on the case that matters: the ref carries the path but the blob cannot be read
 * (partial clone, pruned object, shallow fetch). "I cannot read the rules" must never collapse
 * into "there are no rules" — that is the absent-evidence-reads-as-pass defect this whole module
 * exists to prevent. The two states are told apart by asking the TREE whether the path exists,
 * which needs no blob, before asking for content.
 */
export async function loadPolicyFromRef(root, ref) {
  for (const rel of POLICY_PATHS) {
    const ls = await git(['ls-tree', '--name-only', ref, '--', rel], { cwd: root })
      .catch((e) => ({ code: -1, stdout: '', stderr: e.message }));
    if (ls.code !== 0) {
      refuse('POLICY_BASE_UNREADABLE',
        `cannot inspect '${ref}' for ${rel} (${String(ls.stderr).trim() || `exit ${ls.code}`}) — refusing to judge a change against a base holt cannot read`);
    }
    if (!ls.stdout.trim()) continue; // the base genuinely does not carry this path

    const show = await git(['show', `${ref}:${rel}`], { cwd: root })
      .catch((e) => ({ code: -1, stdout: '', stderr: e.message }));
    if (show.code !== 0) {
      refuse('POLICY_BASE_UNREADABLE',
        `${ref}:${rel} exists in the base tree but its content is unreadable (${String(show.stderr).trim() || `exit ${show.code}`}) — refusing to pass a build against a policy that could not be loaded`);
    }
    return {
      found: true, path: rel, policy: parsePolicy(show.stdout, `${ref}:${rel}`),
      source: 'base', ref, trusted: true, raw: show.stdout,
    };
  }
  return { found: false };
}

/* =============================================================== AUTHORITY ==== */

/** Environment variables by which a CI provider declares "this run judges a proposed change". */
const CI_BASE_VARS = ['GITHUB_BASE_REF', 'CHANGE_TARGET', 'CI_MERGE_REQUEST_TARGET_BRANCH_NAME',
  'BITBUCKET_PR_DESTINATION_BRANCH', 'SYSTEM_PULLREQUEST_TARGETBRANCH'];

const declaredBase = (env) => {
  for (const k of CI_BASE_VARS) {
    const v = env?.[k]?.trim();
    if (v) return { var: k, ref: v };
  }
  return null;
};

/**
 * IS THIS BASE AN INDEPENDENT AUTHORITY — may the rules it carries judge this commit?
 *
 * Reading policy from the base ref instead of the working tree is the right fix for "a pull
 * request edits the gate that judges it", and it is worth exactly nothing if the base and the
 * candidate are THE SAME COMMIT. `resolveBase` ends in a `primary-head-fallback`, reached by any
 * repository with no `origin/HEAD` and no branch named main/master/trunk/develop/default — a
 * fork, a mirror, a `release`-only repo, a bare CI checkout. Measured on a real repository: on
 * such a branch `base.oid === HEAD`, so "load the rules from the base" loads the candidate's own
 * committed policy, and the fix defeats itself in silence.
 *
 * THE RULE, and it is about REFS, not about commits: A BASE IS AN AUTHORITY ONLY IF THE
 * CANDIDATE CANNOT WRITE TO IT.
 *
 * Refs, not commits, because `base.oid === HEAD` on its own is innocent and common — a branch cut
 * ten seconds ago and edited only in the working tree sits exactly there, and the base commit it
 * points at was still written by somebody else. What actually removes authority is the candidate
 * being able to MOVE the ref the rules come from: holt fell back to HEAD (there is no base ref at
 * all), or the base ref IS the branch that is checked out, so its next commit rewrites the rules
 * that judge it. Treating equal OIDs as the test instead flagged every freshly-cut branch and
 * would have taught users to ignore the warning — the way a smoke alarm in a kitchen gets
 * unplugged.
 *
 * The consequence is deliberately asymmetric, because the two situations are not the same:
 *
 *   - Running holt locally on your own tip is not an attack, it is Tuesday. Refusing there would
 *     make the tool unusable, so it DEGRADES: the policy still runs and can still fail the build,
 *     but it is marked untrusted and may not suppress anything.
 *
 *   - In CI, where the environment DECLARES the branch this work is proposed against, the right
 *     base was knowable and holt used something else. That is a misconfiguration producing a
 *     meaningless verdict, so it REFUSES and names the flag that fixes it. A gate whose own
 *     preconditions failed must not render a verdict at all.
 *
 * @param {{base?: any, headOid?: string|null, headRef?: string|null, env?: object}} [opts]
 */
export function baseAuthority({ base = null, headOid = null, headRef = null, env = process.env } = {}) {
  const declared = declaredBase(env);
  const ci = !!declared;
  const shortRef = (r) => String(r ?? '').replace(/^refs\/heads\//, '').replace(/^origin\//, '');

  if (!base?.oid) {
    return {
      independent: false, ci, kind: 'no-base',
      reason: 'holt could not resolve any base ref, so there is nothing to take the rules FROM',
      fix: 'Pass --base <ref> (in GitHub Actions: --base "origin/$GITHUB_BASE_REF").',
    };
  }

  // Checked FIRST because it is the most specific and the most actionable: the environment named
  // the target branch, so if holt judged against something else the verdict is about the wrong
  // comparison entirely, whatever colour it comes out.
  if (declared && shortRef(declared.ref) !== shortRef(base.ref)) {
    return {
      independent: false, ci, kind: 'base-mismatch',
      reason: `${declared.var} declares this change is proposed against '${declared.ref}', but holt judged it against '${base.ref}' — the rules and the evidence would come from a branch nobody is merging into`,
      fix: `Pass --base "origin/${shortRef(declared.ref)}".`,
    };
  }
  if (base.how === 'primary-head-fallback') {
    return {
      independent: false, ci, kind: 'head-fallback',
      reason: `holt found no base branch and fell back to HEAD (base.how=${base.how}), so the "base" IS the candidate commit — any policy read from it is the candidate's own`,
      fix: 'Pass --base <ref> (in GitHub Actions: --base "origin/$GITHUB_BASE_REF"), or create/track the default branch.',
    };
  }
  if (headRef && shortRef(headRef) === shortRef(base.ref)) {
    return {
      independent: false, ci, kind: 'self-base',
      reason: `the base ref (${base.ref}) is the branch that is checked out, so this branch supplies the rules that judge it — its next commit rewrites its own gate`,
      fix: 'Pass --base <ref> naming the branch this work will be merged INTO.',
    };
  }
  return {
    independent: true, ci, kind: 'independent',
    // Reported, never acted on: equal OIDs are the innocent freshly-cut-branch case, and a
    // reviewer looking at a verdict should be able to see that without re-deriving it.
    sameCommitAsHead: !!headOid && base.oid === headOid,
    base: { ref: base.ref, oid: base.oid, how: base.how },
  };
}

/** The checked-out branch's short name, or null when HEAD is detached. A pure read. */
export async function currentBranch(root) {
  const r = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root }).catch(() => null);
  if (!r || r.code !== 0) return null;
  const name = r.stdout.trim();
  return !name || name === 'HEAD' ? null : name;
}

/**
 * THE GATE LOADER — the policy `holt ci` is entitled to enforce, and where it came from.
 *
 * RULES COME FROM THE BASE, which is the same rule GitHub applies to CODEOWNERS: the copy on the
 * ref the work merges INTO is the copy reviewers already approved. A pull request may PROPOSE new
 * rules; it may not enact them upon itself.
 *
 * The working tree is a FALLBACK for exactly one honest case — a repository adopting policy for
 * the first time, or a developer running holt before committing one — and it cannot become a
 * bypass in either direction:
 *
 *   - it is never consulted when the base HAS a policy, so a head-side edit or deletion is
 *     invisible to the gate; and
 *   - what it returns is `trusted: false`, and `gateVerdict` forbids an untrusted policy from
 *     SUPPRESSING any check that would otherwise have run. Otherwise "delete the policy" is
 *     merely swapped for "add a permissive policy", and the gate falls through the other door.
 *
 * `headDiffers` is reported whenever the working tree's copy is not the enforced one, so a
 * reviewer is told, in the build output, that this change proposes altering the gate.
 */
/**
 * @param {string} root
 * @param {{base?: any, headOid?: string|null, headRef?: string|null, env?: object}} [opts]
 */
export async function loadGatePolicy(root, { base = null, headOid = null, headRef, env = process.env } = {}) {
  const ref = headRef === undefined ? await currentBranch(root) : headRef;
  const authority = baseAuthority({ base, headOid, headRef: ref, env });

  if (!authority.independent) {
    // In CI the correct base was knowable. Refuse rather than render a meaningless verdict.
    if (authority.ci) {
      refuse('POLICY_NO_AUTHORITY',
        `holt ci cannot establish an independent base for this change: ${authority.reason}. ${authority.fix} Refusing to judge a change by rules that may have come from itself.`);
    }
    const fromTree = await loadPolicy(root);
    if (!fromTree.found) return { found: false, authority };
    return {
      ...fromTree, trusted: false, authority, headDiffers: false,
      note: `${authority.reason} — the working-tree policy is being used, is NOT trusted, and cannot suppress any other check`,
    };
  }

  const fromBase = await loadPolicyFromRef(root, base?.oid);
  if (fromBase.found) {
    // Did the candidate propose a change to the gate? Read the working tree WITHOUT validating
    // it: a candidate's malformed proposal must not be able to fail a build for the base's rules.
    let headDiffers = false;
    for (const rel of POLICY_PATHS) {
      /** @type {string|null} */
      let raw = null;
      try { raw = await fs.readFile(path.join(root, rel), 'utf8'); } catch { /* absent */ }
      if (rel === fromBase.path) headDiffers = raw !== fromBase.raw;
      else if (raw !== null) headDiffers = true;
    }
    return { ...fromBase, authority, headDiffers };
  }

  const fromTree = await loadPolicy(root);
  if (!fromTree.found) return { found: false, authority };
  return {
    ...fromTree, trusted: false, authority, headDiffers: true,
    note: `no policy exists in the base (${base?.ref}); using the working-tree copy, which is NOT trusted and cannot suppress any other check`,
  };
}

/**
 * Compose the final `holt ci` verdict from the policy result and the inline-flag result.
 *
 * Stated once and enforced here rather than remembered at the call site: A POLICY holt DOES NOT
 * TRUST MAY ADD FAILURES AND MAY NEVER REMOVE THEM. Policy mode short-circuits the inline flags,
 * so without this a candidate that adds a permissive `.holt/policy.json` switches off the
 * `--fail-on-unlanded` the repository owner asked for — the same bypass through the other door.
 *
 * A TRUSTED policy keeps the original behaviour exactly: it is the reviewed statement of what
 * this repository wants enforced, so it supersedes the flags as it always did.
 */
/**
 * @param {{policyResult?: any, flagFailures?: any[], trusted?: boolean}} [opts]
 */
export function gateVerdict({ policyResult = null, flagFailures = [], trusted = false } = {}) {
  const carried = trusted === true ? [] : [...flagFailures];
  return {
    ok: !!policyResult?.ok && carried.length === 0,
    carriedFlagFailures: carried,
    errors: (policyResult?.errors ?? 0) + carried.length,
    warnings: policyResult?.warnings ?? 0,
  };
}

/** Where the rules came from — reported on EVERY `holt ci` outcome, including the refusals. */
export function policySourceOf(loaded) {
  return {
    from: loaded?.source ?? null,
    ref: loaded?.ref ?? null,
    trusted: loaded?.trusted ?? null,
    authority: loaded?.authority?.kind ?? null,
    headProposesChange: loaded?.headDiffers ?? null,
    note: loaded?.note ?? null,
  };
}

/**
 * The complete `holt ci` policy-mode outcome — verdict, provenance and the payload the CLI
 * prints. It lives HERE, not in bin/, for a reason discovered by mutation: with the composition
 * inline in the CLI, flipping `trusted: loaded.trusted` to `trusted: true` — the exact bypass
 * this module exists to prevent — killed no test, because the CLI's policy branch is unreachable
 * without a paid license and the suite has none. A behaviour that cannot be reached by a test is
 * not covered by one, however many tests surround it. Moving the composition into a pure function
 * shrinks the untestable surface to a single call expression, and pins everything else.
 *
 * `trusted` is derived here rather than passed in, so no call site can supply the wrong one.
 */
/**
 * @param {{loaded?: any, policyResult?: any, flagFailures?: any[], entitlement?: any}} [opts]
 */
export function ciPolicyOutcome({ loaded, policyResult, flagFailures = [], entitlement = null } = {}) {
  const verdict = gateVerdict({ policyResult, flagFailures, trusted: loaded?.trusted === true });
  return {
    verdict,
    payload: {
      ok: verdict.ok,
      mode: 'policy',
      policy: loaded?.path ?? null,
      policySource: policySourceOf(loaded),
      entitlement: entitlement ? { tier: entitlement.tier, org: entitlement.org ?? null } : null,
      rulesEvaluated: policyResult?.rulesEvaluated ?? [],
      disabledRules: policyResult?.disabledRules ?? [],
      errors: verdict.errors,
      warnings: verdict.warnings,
      violations: policyResult?.violations ?? [],
      exempted: policyResult?.exempted ?? [],
      carriedFlagFailures: verdict.carriedFlagFailures,
      note: 'requires full refs (actions/checkout with fetch-depth: 0)',
    },
  };
}

/**
 * Evaluate a loaded policy against a branch audit (+ optional worktree report).
 * Pure function: all I/O happened upstream, so this is exhaustively testable.
 *
 * @param {any} policy
 * @param {{audit?: any, report?: any, ignore?: any[]}} opts
 * @param {{remaining: number, compiled: Map<string, any>}} matchBudget
 */
function evaluatePolicyWithBudget(
  policy,
  { audit, report = null, ignore = [] },
  matchBudget,
) {
  const violations = [];
  const exempted = [];

  const unlanded = (audit?.unlanded ?? []).filter((b) => !ignore.includes(b.name));
  const unknown = audit?.unknown ?? [];

  // A rule turned off in words is honoured — and then NAMED in the verdict. Validation refuses
  // every OTHER way a rule can fail to fire (an empty path list, an exemption that swallows
  // everything), so this is the single route to a dormant rule and it leaves a mark in the
  // output. The failure being designed against is not a disabled rule; it is a rule everybody
  // believes is running.
  const enabled = policy.rules.filter((r) => r.enabled !== false);
  const disabledRules = policy.rules.filter((r) => r.enabled === false).map((r) => r.id);

  for (const rule of enabled) {
    const sev = rule.severity ?? 'error';

    if (rule.type === 'no-unlanded') {
      for (const b of unlanded) {
        if (matchesAny(b.name, rule.exempt, matchBudget)) { exempted.push({ rule: rule.id, subject: b.name }); continue; }
        violations.push({
          rule: rule.id, severity: sev, subject: b.name,
          message: `branch '${b.name}' holds ${b.fileCount} file(s) of unlanded content`,
          evidence: b.files?.slice(0, 5) ?? [],
        });
      }
    }

    if (rule.type === 'max-branch-age') {
      for (const b of unlanded) {
        if (matchesAny(b.name, rule.exempt, matchBudget)) { exempted.push({ rule: rule.id, subject: b.name }); continue; }
        if (typeof b.ageDays !== 'number' || !Number.isFinite(b.ageDays) || b.ageDays < 0) {
          violations.push({
            rule: rule.id, severity: 'error', subject: b.name,
            message: `branch '${b.name}' has no finite non-negative age evidence — refusing to pass max-branch-age policy`,
            evidence: ['ageDays missing or invalid'],
          });
        } else if (b.ageDays > rule.days) {
          violations.push({
            rule: rule.id, severity: sev, subject: b.name,
            message: `branch '${b.name}' holds unlanded work and is ${b.ageDays} days old (limit ${rule.days})`,
            evidence: [`last commit ${b.ageDays}d ago`],
          });
        }
      }
    }

    if (rule.type === 'protected-paths') {
      for (const b of unlanded) {
        const carried = authoritativeBranchPaths(b);
        if (carried === null) {
          violations.push({
            rule: rule.id, severity: 'error', subject: b.name,
            message: `branch '${b.name}' has a truncated carried-path inventory — refusing to pass protected-path policy without complete evidence`,
            evidence: [`declared ${b.fileCount ?? 'unknown'} carried path(s); supplied inventory is missing, invalid, duplicate, or has a different cardinality`],
          });
          continue;
        }
        const hits = carried.filter((f) => matchesAny(f, rule.paths, matchBudget));
        if (hits.length) {
          violations.push({
            rule: rule.id, severity: sev, subject: b.name,
            message: `branch '${b.name}' holds unlanded changes under protected paths`,
            evidence: hits.slice(0, 5),
          });
        }
      }
      // Worktrees count too: uncommitted work under a protected path is the riskiest of all.
      for (const u of report?.unique ?? []) {
        const files = pathsCarriedBy(u, ['uncommitted', 'untracked']);
        if (files === null) {
          violations.push({
            rule: rule.id, severity: 'error', subject: u?.id ?? 'unknown-workstream',
            message: 'workstream carried-path evidence is invalid — refusing to pass protected-path policy',
            evidence: ['uncommitted/untracked path or symbol inventories are not valid arrays of paths'],
          });
          continue;
        }
        const hits = files.filter((f) => matchesAny(f, rule.paths, matchBudget));
        if (hits.length) {
          violations.push({
            rule: rule.id, severity: sev, subject: u.id,
            message: `workstream '${u.id}' holds UNCOMMITTED changes under protected paths`,
            evidence: hits.slice(0, 5),
          });
        }
      }
    }

    if (rule.type === 'require-classified' && unknown.length) {
      for (const b of unknown) {
        violations.push({
          rule: rule.id, severity: sev, subject: b.name,
          message: `branch '${b.name}' could not be classified — policy refuses to pass on missing evidence`,
          evidence: [b.reason ?? 'instrument failure'],
        });
      }
    }
  }

  const errors = violations.filter((v) => v.severity === 'error');
  return {
    ok: errors.length === 0,
    violations,
    errors: errors.length,
    warnings: violations.length - errors.length,
    exempted,
    rulesEvaluated: enabled.map((r) => r.id),
    disabledRules,
  };
}

export function evaluatePolicy(policy, opts = {}) {
  return evaluatePolicyWithBudget(policy, opts, newGlobBudget());
}

/**
 * Evaluate independent policy sources additively and namespace every result.
 *
 * A central managed policy, a reviewed base policy, and a candidate policy are separate
 * authorities. None is allowed to replace another: every enabled rule runs and every error is
 * retained. This is deliberately different from the legacy single-policy gate, whose trusted
 * base policy may supersede inline flags for backwards compatibility.
 *
 * @param {{namespace: string, policy: any}[]} sources
 * @param {{audit?: any, report?: any, ignore?: any[], inlineFailures?: any[]}} opts
 * @param {{remaining: number, compiled: Map<string, any>}} matchBudget
 */
function evaluatePolicySourcesWithBudget(
  sources,
  { audit, report = null, ignore = [], inlineFailures = [] },
  matchBudget,
) {
  if (!Array.isArray(sources)) refuse('POLICY_SOURCES', 'policy sources must be an array');
  if (!Array.isArray(inlineFailures)) refuse('POLICY_SOURCES', 'inline failures must be an array');

  const seen = new Set();
  const sourceResults = [];
  const violations = [];
  const exempted = [];
  const disabledRules = [];
  const rulesEvaluated = [];
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      refuse('POLICY_SOURCES', `policy source ${i} must be an object`);
    }
    const unknown = Object.keys(source).filter((key) => key !== 'namespace' && key !== 'policy');
    if (unknown.length) refuse('POLICY_SOURCES', `policy source ${i} has unknown key '${unknown[0]}'`);
    if (typeof source.namespace !== 'string'
      || !/^[a-z][a-z0-9._:-]{0,191}$/u.test(source.namespace)) {
      refuse('POLICY_SOURCES', `policy source ${i} needs a canonical lowercase namespace`);
    }
    if (seen.has(source.namespace)) {
      refuse('POLICY_SOURCES', `duplicate policy source namespace '${source.namespace}'`);
    }
    seen.add(source.namespace);
    validatePolicyObject(source.policy, `${source.namespace} policy`);

    const result = evaluatePolicyWithBudget(source.policy, { audit, report, ignore }, matchBudget);
    const qualify = (rule) => `${source.namespace}:${rule}`;
    const qualifiedViolations = result.violations.map((violation) => ({
      ...violation,
      source: source.namespace,
      ruleId: violation.rule,
      rule: qualify(violation.rule),
    }));
    const qualifiedExempted = result.exempted.map((entry) => ({
      ...entry,
      source: source.namespace,
      ruleId: entry.rule,
      rule: qualify(entry.rule),
    }));
    violations.push(...qualifiedViolations);
    exempted.push(...qualifiedExempted);
    disabledRules.push(...result.disabledRules.map(qualify));
    rulesEvaluated.push(...result.rulesEvaluated.map(qualify));
    sourceResults.push({
      namespace: source.namespace,
      ok: result.ok,
      errors: result.errors,
      warnings: result.warnings,
      rulesEvaluated: result.rulesEvaluated.map(qualify),
      disabledRules: result.disabledRules.map(qualify),
    });
  }

  for (let i = 0; i < inlineFailures.length; i++) {
    const failure = inlineFailures[i];
    const message = typeof failure === 'string' ? failure : failure?.message;
    if (typeof message !== 'string' || !message.trim()) {
      refuse('POLICY_SOURCES', `inline failure ${i} needs a non-empty message`);
    }
    violations.push({
      source: 'inline',
      rule: `inline:failure-${i + 1}`,
      ruleId: `failure-${i + 1}`,
      severity: 'error',
      subject: failure?.subject ?? null,
      message,
      evidence: Array.isArray(failure?.evidence) ? failure.evidence : [],
    });
  }

  const errors = violations.filter((violation) => violation.severity === 'error').length;
  return {
    ok: errors === 0,
    violations,
    errors,
    warnings: violations.length - errors,
    exempted,
    rulesEvaluated,
    disabledRules,
    sourceResults,
    additive: true,
  };
}

export function evaluatePolicySources(sources, opts = {}) {
  return evaluatePolicySourcesWithBudget(sources, opts, newGlobBudget());
}

/**
 * The managed-policy gate has two different ignore semantics: centrally assigned rules ignore a
 * repository's exemption list, while reviewed/candidate rules retain the existing CLI behavior.
 * They still constitute ONE verdict and therefore share ONE work budget. Keeping this composition
 * here prevents a caller from multiplying the complexity allowance by evaluating each authority
 * independently.
 *
 * @param {{managedSources?: any[], lowerSources?: any[], audit?: any, report?: any,
 *   lowerIgnore?: any[], inlineFailures?: any[]}} [opts]
 */
export function evaluatePolicyAuthoritySources({
  managedSources = [],
  lowerSources = [],
  audit,
  report = null,
  lowerIgnore = [],
  inlineFailures = [],
} = {}) {
  const matchBudget = newGlobBudget();
  return {
    managedResult: evaluatePolicySourcesWithBudget(
      managedSources,
      { audit, report, ignore: [], inlineFailures: [] },
      matchBudget,
    ),
    lowerResult: evaluatePolicySourcesWithBudget(
      lowerSources,
      { audit, report, ignore: lowerIgnore, inlineFailures },
      matchBudget,
    ),
  };
}
