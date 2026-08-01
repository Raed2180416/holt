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
import { discover } from '../discover.mjs';
import { scan } from '../scan.mjs';
import { analyze } from '../analyze.mjs';
import { branchAudit } from '../branches.mjs';
import { git } from '../git.mjs';
import { checkEntitlement } from '../license.mjs';

export class EntitlementError extends Error {
  constructor(entitlement) {
    super(entitlement.reason);
    this.name = 'EntitlementError';
    this.entitlement = entitlement;
  }
}

/**
 * Find git repositories under `roots`, bounded in depth so a home directory cannot be walked.
 *
 * ONE REPOSITORY IS COUNTED ONCE, and that is not free. A linked worktree is a directory with
 * its own `.git` (a file rather than a directory), so the walker finds `proj/` and
 * `proj-worktrees/feature-x` and reports TWO repositories — which is exactly the layout holt
 * exists for. Every per-repo total was then inflated by the number of worktrees parked under the
 * fleet root, and a journal, which is shared by every worktree of a repository, was read once
 * per worktree: the same refused `rm -rf` counted four times.
 *
 * git's own answer to "which repository is this" is the COMMON git dir, so that is what
 * de-duplication keys on. It costs one `rev-parse` per candidate, which is nothing next to the
 * full scan each candidate would otherwise trigger. Candidates git cannot answer for are kept
 * (an unreadable repo must reach the scanner and be reported as a failure, never dropped here).
 */
export async function findRepos(roots, { maxDepth = 3 } = {}) {
  const candidates = [];
  const seen = new Set();

  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    const isRepo = entries.some((e) => e.name === '.git');
    if (isRepo) {
      const real = path.resolve(dir);
      if (!seen.has(real)) { seen.add(real); candidates.push(real); }
      return; // never descend into a repository: its worktrees are holt's business, not the walker's
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      await walk(path.join(dir, e.name), depth + 1);
    }
  }

  for (const r of roots) await walk(path.resolve(r), 0);
  candidates.sort();

  const byCommonDir = new Map();
  const out = [];
  for (const dir of candidates) {
    const r = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: dir })
      .catch(() => null);
    const common = (r && r.code === 0) ? r.stdout.trim() : null;
    if (!common) { out.push(dir); continue; } // cannot tell -> keep it; the scanner will report why
    if (byCommonDir.has(common)) continue;    // a linked worktree of one already listed
    byCommonDir.set(common, dir);
    out.push(dir);
  }
  return out;
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
        if (!disc.root) { failures.push({ repo: root, error: 'not a git repository' }); continue; }
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
