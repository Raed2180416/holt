// SPDX-License-Identifier: LicenseRef-holt-Commercial
// Commercial license — see src/team/LICENSE. NOT covered by the repository FSL-1.1-MIT grant.
/**
 * holt Team — fleet view.  (Commercial license: see src/team/LICENSE-TEAM.md)
 *
 * One repository's answer is a developer question. "Across all 40 repositories this team owns,
 * where is work sitting unlanded, which are unprotected, and what is the total exposure" is the
 * question a lead or a compliance reviewer actually has, and no single-repo tool can answer it.
 *
 * Deliberately built on the same instruments as the single-repo path — the fleet is an
 * aggregation, never a second implementation, so a fleet number can never disagree with the
 * number the developer sees locally. Repositories that fail to scan are reported as ERRORS in
 * their own bucket and are never counted as clean; a fleet report that hides a failed repo is
 * exactly the "silent partial coverage" failure this project refuses everywhere else.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { git } from '../git.mjs';
import { discover, repoAbsenceError } from '../discover.mjs';
import { scan } from '../scan.mjs';
import { analyze } from '../analyze.mjs';
import { branchAudit } from '../branches.mjs';
import { checkEntitlement } from '../license.mjs';

export class EntitlementError extends Error {
  constructor(entitlement) {
    super(entitlement.reason);
    this.name = 'EntitlementError';
    this.entitlement = entitlement;
  }
}

/**
 * A directory's REPOSITORY IDENTITY — the thing that makes two directories the same repo.
 *
 * A linked worktree has a `.git` too (a file, not a directory), so "contains .git" answers
 * "is this a working tree", never "is this a distinct repository". `--git-common-dir` is git's
 * own answer to the second question: every worktree of one repository — main and linked alike —
 * reports the SAME common dir, and two unrelated repositories can never share one.
 *
 * Returns null when git cannot answer (a stray file literally named `.git`, an unreadable dir, no
 * git on PATH). Null is never treated as "same as something else": the caller falls back to the
 * path so the directory is still REPORTED and fails loudly downstream. Silently dropping a
 * directory holt could not identify would be the fail-open shape this project refuses everywhere.
 */
async function repoIdentity(dir) {
  try {
    const r = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: dir });
    if (r.code !== 0) return null;
    const out = r.stdout.trim();
    return out ? path.resolve(out) : null;
  } catch {
    return null; // GitRefused/GitFailed — unidentifiable, not "already seen"
  }
}

/**
 * Find git repositories under `roots`, bounded in depth so a home directory cannot be walked.
 *
 * ONE REPOSITORY IS ONE ROW, however many worktrees it has. Keying the seen-set on the directory
 * path counted every linked worktree as its own repository, so a team running holt on the very
 * layout holt exists for — one repo, N agent worktrees parked beside it — saw `repositories: 4`
 * where git reports 3, and every total derived from those rows (workstreams, atRisk, disposable,
 * collisions) double-counted the same work. An inflated exposure number is not a harmless
 * cosmetic: it is the first number an enterprise buyer checks against `git worktree list`.
 *
 * When several working trees of one repository are found, the MAIN one is kept — it is the tree
 * whose own `.git` is the common dir — falling back to the shortest path (then lexicographic) so
 * the answer never depends on readdir order.
 */
export async function findRepos(roots, { maxDepth = 3 } = {}) {
  const byRepo = new Map(); // repository identity -> chosen working-tree path
  const candidates = [];

  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    const isRepo = entries.some((e) => e.name === '.git');
    if (isRepo) {
      candidates.push(path.resolve(dir));
      return; // never descend into a repository: its worktrees are holt's business, not the walker's
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      await walk(path.join(dir, e.name), depth + 1);
    }
  }

  for (const r of roots) await walk(path.resolve(r), 0);

  // Rank: the main working tree first, then the shortest path, then lexicographic. Every term is
  // a property of the candidate itself, so the winner is the same whatever order the walk found
  // them in — a fleet total that changed with filesystem ordering would be unauditable.
  const rank = (p, id) => [id && path.dirname(id) === p ? 0 : 1, p.length, p];
  const better = (a, b) => {
    for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) return a[i] < b[i]; }
    return false;
  };

  for (const p of candidates) {
    const id = await repoIdentity(p);
    const key = id ?? `unidentified:${p}`;
    const prev = byRepo.get(key);
    if (!prev || better(rank(p, id), rank(prev, id))) byRepo.set(key, p);
  }

  return [...byRepo.values()].sort();
}

/**
 * Scan every repository and aggregate. Concurrency-bounded: a fleet scan must not fork-bomb a
 * laptop, and git is I/O bound anyway.
 */
export async function fleetScan(roots, { concurrency = 4, maxDepth = 3, env = process.env, ...opts } = {}) {
  // The entitlement check lives HERE, at the feature, not only in the CLI dispatcher — so that
  // importing this module directly is gated the same way the command is. It is still
  // tamper-evident rather than tamper-proof (the source is public and can be edited), but a
  // developer must now deliberately remove the check, not merely bypass the CLI to reach the
  // paid feature by import.
  const ent = checkEntitlement('fleet', { env });
  if (!ent.entitled) throw new EntitlementError(ent);

  const repos = await findRepos(roots, { maxDepth });
  const rows = [];
  const failures = [];

  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, 16)) }, async () => {
    while (cursor < repos.length) {
      const root = repos[cursor++];
      try {
        const disc = await discover(root, opts);
        if (!disc.root) { failures.push({ repo: root, error: repoAbsenceError(disc, root).message }); continue; }
        const scanned = await scan(disc, opts);
        const report = await analyze(scanned, opts);
        let branches = null;
        try { branches = await branchAudit(root, opts); } catch (e) { branches = { ok: false, reason: e.message }; }

        const atRisk = report.unique.filter((u) => u.uncommittedOnlyCount > 0);
        rows.push({
          repo: root,
          name: path.basename(root),
          workstreams: report.counts.scanned,
          atRisk: atRisk.length,
          atRiskIds: atRisk.map((u) => u.id),
          disposable: report.counts.safeToDelete,
          collisions: report.counts.collisions,
          unlandedBranches: branches?.ok ? branches.unlanded.length : null,
          unknownBranches: branches?.ok ? branches.unknown.length : null,
          unscannable: report.skipped.length,
        });
      } catch (e) {
        failures.push({ repo: root, error: e.message });
      }
    }
  });
  await Promise.all(workers);

  rows.sort((a, b) => b.atRisk - a.atRisk || a.name.localeCompare(b.name));
  const sum = (k) => rows.reduce((n, r) => n + (r[k] ?? 0), 0);

  return {
    scannedAt: new Date().toISOString(),
    roots: roots.map((r) => path.resolve(r)),
    repositories: rows.length,
    totals: {
      workstreams: sum('workstreams'),
      atRisk: sum('atRisk'),
      disposable: sum('disposable'),
      collisions: sum('collisions'),
      unlandedBranches: sum('unlandedBranches'),
      unscannable: sum('unscannable'),
    },
    repos: rows,
    failures,
    note: failures.length
      ? `${failures.length} repository(ies) FAILED to scan and are excluded from every total above — they are not clean, they are unknown`
      : 'every discovered repository scanned successfully',
  };
}
