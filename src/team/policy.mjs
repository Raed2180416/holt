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
 * Validate one policy document. `label` is how the source is named in every refusal, so a
 * message stays actionable whether the bytes came from disk or from a git ref.
 */
export function parsePolicy(raw, label) {
  let doc;
  try {
    // Tolerate // and /* */ comments so a policy can explain itself to reviewers.
    doc = JSON.parse(raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1'));
  } catch (e) {
    throw Object.assign(new Error(`${label} is not valid JSON (${e.message}) — refusing to run with a policy nobody can read`), { code: 'POLICY_PARSE' });
  }
  if (doc?.version !== 1) {
    throw Object.assign(new Error(`${label}: unsupported policy version ${JSON.stringify(doc?.version)} — upgrade holt rather than run an unenforced policy`), { code: 'POLICY_VERSION' });
  }
  if (!Array.isArray(doc.rules) || doc.rules.length === 0) {
    throw Object.assign(new Error(`${label}: no rules defined — an empty policy would pass everything silently`), { code: 'POLICY_EMPTY' });
  }
  const seen = new Set();
  for (const r of doc.rules) {
    if (!r?.id || typeof r.id !== 'string') throw Object.assign(new Error(`${label}: every rule needs a string id`), { code: 'POLICY_RULE' });
    if (seen.has(r.id)) throw Object.assign(new Error(`${label}: duplicate rule id '${r.id}'`), { code: 'POLICY_RULE' });
    seen.add(r.id);
    if (!RULE_TYPES.has(r.type)) {
      throw Object.assign(new Error(`${label}: rule '${r.id}' has unknown type '${r.type}'. Known: ${[...RULE_TYPES].join(', ')}`), { code: 'POLICY_RULE' });
    }
    if (r.severity && !SEVERITIES.has(r.severity)) {
      throw Object.assign(new Error(`${label}: rule '${r.id}' has unknown severity '${r.severity}'`), { code: 'POLICY_RULE' });
    }
    if (r.type === 'max-branch-age' && !(Number(r.days) > 0)) {
      throw Object.assign(new Error(`${label}: rule '${r.id}' needs a positive 'days'`), { code: 'POLICY_RULE' });
    }
    if (r.type === 'protected-paths' && !Array.isArray(r.paths)) {
      throw Object.assign(new Error(`${label}: rule '${r.id}' needs a 'paths' array`), { code: 'POLICY_RULE' });
    }
  }
  return doc;
}

/** Load and validate from the WORKING TREE. Returns {found:false} when absent — absence is not an error. */
export async function loadPolicy(root) {
  for (const rel of POLICY_PATHS) {
    let raw;
    try { raw = await fs.readFile(path.join(root, rel), 'utf8'); } catch { continue; }
    return { found: true, path: rel, policy: parsePolicy(raw, rel), source: 'worktree', trusted: false };
  }
  return { found: false };
}

/**
 * Load and validate the policy AS IT EXISTS IN `ref` — never from the working tree.
 *
 * Fails CLOSED in the one case that matters: when the ref DECLARES a policy path but the blob
 * cannot be read (a partial clone, a pruned object). "I cannot read the rules" must never
 * collapse into "there are no rules"; that is the same absent-evidence-reads-as-pass defect the
 * whole module exists to prevent. The two states are separated by asking the TREE whether the
 * path exists, which needs no blob, before asking for the content.
 */
export async function loadPolicyFromRef(root, ref) {
  for (const rel of POLICY_PATHS) {
    const ls = await git(['ls-tree', '--name-only', ref, '--', rel], { cwd: root }).catch((e) => ({ code: -1, stderr: e.message }));
    if (ls.code !== 0) {
      throw Object.assign(
        new Error(`cannot inspect '${ref}' for ${rel} (${String(ls.stderr).trim() || `exit ${ls.code}`}) — refusing to judge a change against a base holt cannot read`),
        { code: 'POLICY_BASE_UNREADABLE' },
      );
    }
    if (!ls.stdout.trim()) continue; // the base genuinely does not carry this path

    const show = await git(['show', `${ref}:${rel}`], { cwd: root }).catch((e) => ({ code: -1, stderr: e.message }));
    if (show.code !== 0) {
      throw Object.assign(
        new Error(`${ref}:${rel} exists in the base tree but its content is unreadable (${String(show.stderr).trim() || `exit ${show.code}`}) — refusing to pass a build against a policy that could not be loaded`),
        { code: 'POLICY_BASE_UNREADABLE' },
      );
    }
    return { found: true, path: rel, policy: parsePolicy(show.stdout, `${ref}:${rel}`), source: 'base', ref, trusted: true };
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
export async function loadGatePolicy(root, { baseRef = null } = {}) {
  if (baseRef) {
    const fromBase = await loadPolicyFromRef(root, baseRef);
    if (fromBase.found) return fromBase;
  }
  const fromTree = await loadPolicy(root);
  if (!fromTree.found) return { found: false };
  return {
    ...fromTree,
    trusted: false,
    note: baseRef
      ? `no policy exists in the base (${baseRef}); using the working-tree copy, which cannot suppress any other check`
      : 'no base ref available; using the working-tree copy, which cannot suppress any other check',
  };
}

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
export function gateVerdict({ policyResult, flagFailures = [], trusted = false } = {}) {
  const carried = trusted ? [] : [...flagFailures];
  return {
    ok: !!policyResult?.ok && carried.length === 0,
    carriedFlagFailures: carried,
    errors: (policyResult?.errors ?? 0) + carried.length,
    warnings: policyResult?.warnings ?? 0,
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

  for (const rule of policy.rules) {
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
        const files = [...(u.byLayer?.uncommitted ?? []), ...(u.byLayer?.untracked ?? [])]
          .map((x) => x.path ?? x.key ?? '').filter(Boolean);
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
    rulesEvaluated: policy.rules.map((r) => r.id),
  };
}
