// SPDX-License-Identifier: LicenseRef-holt-Commercial
// Commercial license — see src/team/LICENSE. NOT covered by the repository FSL-1.1-MIT grant.
/**
 * holt Team — policy as code.  (Commercial license: see src/team/LICENSE-TEAM.md)
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

export const POLICY_PATHS = ['.holt/policy.json', '.holt/policy.jsonc'];

const RULE_TYPES = new Set(['no-unlanded', 'max-branch-age', 'protected-paths', 'require-classified']);
const SEVERITIES = new Set(['error', 'warn']);

/** Minimal glob: `*` within a segment, `**` across segments. Anchored, no backtracking blowup. */
export function globToRegExp(glob) {
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { out += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${out}$`);
}

const matchesAny = (value, globs) => (globs ?? []).some((g) => globToRegExp(g).test(value));

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
    for (const p of u?.pathsByLayer?.[layer] ?? []) {
      if (typeof p === 'string' && p) out.add(p);
    }
    for (const s of u?.byLayer?.[layer] ?? []) {
      const p = typeof s === 'string' ? s : (s?.file ?? s?.path);
      if (typeof p === 'string' && p) out.add(p);
    }
  }
  // Sorted, so the evidence a reviewer is shown is the same on every run and across machines.
  return [...out].sort();
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

/** A glob that matches every possible subject. A rule exempting one of these exempts everything. */
const UNIVERSAL_GLOBS = new Set(['*', '**', '**/*', '*/**']);

const refuse = (code, message) => { throw Object.assign(new Error(message), { code }); };

/**
 * Every glob in `list` must be a non-empty string. A non-string here used to reach
 * `globToRegExp`, where `glob.length` on `null` threw a TypeError from the middle of evaluation —
 * a stack trace in place of an actionable refusal, and fail-closed only by accident.
 */
function checkGlobs(list, { label, ruleId, field }) {
  list.forEach((g, i) => {
    if (typeof g !== 'string' || !g.trim()) {
      refuse('POLICY_RULE', `${label}: rule '${ruleId}' ${field}[${i}] must be a non-empty string glob, got ${JSON.stringify(g)}`);
    }
  });
}

/**
 * Validate one policy document. `label` names the source in every refusal, so the message stays
 * actionable whether the bytes came from a file on disk or from a git ref.
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
 *   that CANNOT FIRE — a green build from a rule that never ran, which is this module's entire
 *   reason to exist. A rule that is off must say so in words: `"enabled": false`, which is
 *   honoured and then REPORTED in the verdict, so the off switch is visible in the output rather
 *   than hidden in the shape of the data.
 *
 *   NON-STRING GLOBS REFUSE, at load time, instead of crashing the evaluator mid-run.
 */
export function parsePolicy(raw, label) {
  let doc;
  try {
    // Tolerate // and /* */ comments so a policy can explain itself to reviewers.
    doc = JSON.parse(String(raw).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1'));
  } catch (e) {
    refuse('POLICY_PARSE', `${label} is not valid JSON (${e.message}) — refusing to run with a policy nobody can read`);
  }
  if (doc?.version !== 1) {
    refuse('POLICY_VERSION', `${label}: unsupported policy version ${JSON.stringify(doc?.version)} — upgrade holt rather than run an unenforced policy`);
  }
  for (const k of Object.keys(doc)) {
    if (!TOP_LEVEL_KEYS.has(k)) {
      refuse('POLICY_SCHEMA', `${label}: unknown top-level key '${k}'. Known: ${[...TOP_LEVEL_KEYS].join(', ')}. holt refuses rather than ignore it — a key holt does not act on is a rule you believe you have and do not.`);
    }
  }
  if (!Array.isArray(doc.rules) || doc.rules.length === 0) {
    refuse('POLICY_EMPTY', `${label}: no rules defined — an empty policy would pass everything silently`);
  }

  const seen = new Set();
  for (const r of doc.rules) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      refuse('POLICY_RULE', `${label}: every entry of 'rules' must be an object, got ${JSON.stringify(r)}`);
    }
    if (!r.id || typeof r.id !== 'string') refuse('POLICY_RULE', `${label}: every rule needs a string id`);
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

    if (r.type === 'max-branch-age' && !(Number(r.days) > 0)) {
      refuse('POLICY_RULE', `${label}: rule '${r.id}' needs a positive 'days'`);
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
    if (Array.isArray(r.exempt) && r.exempt.some((g) => UNIVERSAL_GLOBS.has(g.trim()))) {
      refuse('POLICY_VACUOUS', `${label}: rule '${r.id}' exempts every possible subject (${r.exempt.join(', ')}), so it can never fire. Narrow the exemption, or set "enabled": false to turn it off deliberately.`);
    }
  }
  return doc;
}

/**
 * Load and validate from the WORKING TREE.
 * Returns {found:false} when absent — absence of a policy is not an error.
 */
export async function loadPolicy(root) {
  for (const rel of POLICY_PATHS) {
    let raw;
    try { raw = await fs.readFile(path.join(root, rel), 'utf8'); } catch { continue; }
    return { found: true, path: rel, policy: parsePolicy(raw, rel), source: 'worktree', trusted: false, raw };
  }
  return { found: false };
}

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
 * @param {string|null} headRef  the checked-out branch's short name, or null when detached.
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

  const fromBase = await loadPolicyFromRef(root, base.oid);
  if (fromBase.found) {
    // Did the candidate propose a change to the gate? Read the working tree WITHOUT validating
    // it: a candidate's malformed proposal must not be able to fail a build for the base's rules.
    let headDiffers = false;
    for (const rel of POLICY_PATHS) {
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
    note: `no policy exists in the base (${base.ref}); using the working-tree copy, which is NOT trusted and cannot suppress any other check`,
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
 */
export function evaluatePolicy(policy, { audit, report = null, ignore = [] } = {}) {
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
        if (matchesAny(b.name, rule.exempt)) { exempted.push({ rule: rule.id, subject: b.name }); continue; }
        violations.push({
          rule: rule.id, severity: sev, subject: b.name,
          message: `branch '${b.name}' holds ${b.fileCount} file(s) of unlanded content`,
          evidence: b.files?.slice(0, 5) ?? [],
        });
      }
    }

    if (rule.type === 'max-branch-age') {
      for (const b of unlanded) {
        if (matchesAny(b.name, rule.exempt)) { exempted.push({ rule: rule.id, subject: b.name }); continue; }
        if (b.ageDays != null && b.ageDays > Number(rule.days)) {
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
        const hits = (b.files ?? []).filter((f) => matchesAny(f, rule.paths));
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
        const hits = files.filter((f) => matchesAny(f, rule.paths));
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
