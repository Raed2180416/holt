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
 */

import fs from 'node:fs/promises';
import path from 'node:path';

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

/** Load and validate. Returns {found:false} when absent — absence is not an error. */
export async function loadPolicy(root) {
  for (const rel of POLICY_PATHS) {
    const p = path.join(root, rel);
    let raw;
    try { raw = await fs.readFile(p, 'utf8'); } catch { continue; }

    let doc;
    try {
      // Tolerate // and /* */ comments so a policy can explain itself to reviewers.
      doc = JSON.parse(raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1'));
    } catch (e) {
      throw Object.assign(new Error(`${rel} is not valid JSON (${e.message}) — refusing to run with a policy nobody can read`), { code: 'POLICY_PARSE' });
    }
    if (doc?.version !== 1) {
      throw Object.assign(new Error(`${rel}: unsupported policy version ${JSON.stringify(doc?.version)} — upgrade holt rather than run an unenforced policy`), { code: 'POLICY_VERSION' });
    }
    if (!Array.isArray(doc.rules) || doc.rules.length === 0) {
      throw Object.assign(new Error(`${rel}: no rules defined — an empty policy would pass everything silently`), { code: 'POLICY_EMPTY' });
    }
    const seen = new Set();
    for (const r of doc.rules) {
      if (!r?.id || typeof r.id !== 'string') throw Object.assign(new Error(`${rel}: every rule needs a string id`), { code: 'POLICY_RULE' });
      if (seen.has(r.id)) throw Object.assign(new Error(`${rel}: duplicate rule id '${r.id}'`), { code: 'POLICY_RULE' });
      seen.add(r.id);
      if (!RULE_TYPES.has(r.type)) {
        throw Object.assign(new Error(`${rel}: rule '${r.id}' has unknown type '${r.type}'. Known: ${[...RULE_TYPES].join(', ')}`), { code: 'POLICY_RULE' });
      }
      if (r.severity && !SEVERITIES.has(r.severity)) {
        throw Object.assign(new Error(`${rel}: rule '${r.id}' has unknown severity '${r.severity}'`), { code: 'POLICY_RULE' });
      }
      if (r.type === 'max-branch-age' && !(Number(r.days) > 0)) {
        throw Object.assign(new Error(`${rel}: rule '${r.id}' needs a positive 'days'`), { code: 'POLICY_RULE' });
      }
      if (r.type === 'protected-paths' && !Array.isArray(r.paths)) {
        throw Object.assign(new Error(`${rel}: rule '${r.id}' needs a 'paths' array`), { code: 'POLICY_RULE' });
      }
    }
    return { found: true, path: rel, policy: doc };
  }
  return { found: false };
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
