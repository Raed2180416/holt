// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — the branch janitor: worktree-grade honesty for the OTHER graveyard.
 *
 * Every repository accumulates local branches nobody dares delete. `git branch -d` refuses
 * anything not ANCESTRY-merged — but ancestry is the wrong question in a squash-merge or
 * cherry-pick world: a branch whose every line already landed still looks "unmerged" to git,
 * and a branch git happily fast-forwarded past may be the only home of nothing at all.
 * holt asks the content question instead, with the same instrument the worktree layer uses
 * (`merge-tree --write-tree` against the base) and the same fail-closed rules:
 *
 *   landed          — content delta vs base is EMPTY and the tip is an ancestor of base.
 *                     `git branch -d` is safe; --apply runs exactly that (never -D).
 *   content-landed  — content delta is EMPTY but the tip is NOT an ancestor (squash/cherry-
 *                     pick). git's own -d will refuse. holt reports the evidence and prints
 *                     the -D command for a HUMAN to run; --apply never force-deletes.
 *   unlanded        — the branch holds content base does not have. Named file by file.
 *   unknown         — the instrument failed (missing objects, merge-tree error). REFUSED,
 *                     never bucketed as safe. Absence of evidence is not evidence of absence.
 *
 * Branches checked out in ANY worktree are audited here too, but never auto-deleted: this lets a
 * fan-out see landed content while the worktree layer remains responsible for its live files.
 */

import { git, gitOk } from './git.mjs';
import { discover, repoAbsenceError } from './discover.mjs';
import { resolveBase, committedDelta } from './scan.mjs';
import { appendEvent } from './journal.mjs';

const FILE_CAP = 25;

/**
 * Same rule as actions.mjs: appendEvent() already refuses to throw and already writes a loud
 * line to stderr, but a caller that discards its {ok, error} return value hides that failure
 * from everyone who only reads the result object (a `--json` script, an MCP client). Recorded
 * here so a branch actually deleted, but not journalled, still says so in the response.
 */
async function journal(cwd, event, failures) {
  const r = await appendEvent(cwd, event);
  if (!r.ok) failures.push({ action: event.action, name: event.name ?? null, error: r.error });
  return r;
}

/**
 * @param {string} cwd
 * @param {{apply?: boolean, base?: string|null, strictReadOnly?: boolean, timeout?: number,
 *          familyOverrides?: any[], includeJj?: boolean, familyWindowMs?: number, [key: string]: any}} [opts]
 */
export async function branchAudit(cwd, { apply = false, base: baseRef = null, ...opts } = {}) {
  const disc = await discover(cwd, opts);
  if (!disc.root) throw repoAbsenceError(disc, cwd);
  const root = disc.root;

  const base = await resolveBase(root, baseRef);
  if (!base?.oid) {
    return { ok: false, reason: 'no usable base to compare against — pass --base <ref>', branches: [] };
  }

  const checkedOut = new Set(disc.workstreams.map((w) => w.branch).filter(Boolean));
  const baseShort = base.ref?.replace(/^refs\/heads\//, '');
  const checkedOutReason = (name) => checkedOut.has(name)
    ? ' checked out in a worktree — report-only; holt will not delete it until that worktree is gone'
    : '';

  const refs = await git(['for-each-ref', 'refs/heads', '--format=%(refname:short)%00%(objectname)%00%(committerdate:unix)'],
    { cwd: root });
  const lines = refs.stdout.split('\n').filter(Boolean);

  const branches = [];
  for (const line of lines) {
    const [name, tip, cdate] = line.split('\0');
    if (!name || !tip) continue;
    const ageDays = cdate ? Math.floor((Date.now() / 1000 - Number(cdate)) / 86400) : null;
    if (name === baseShort) continue;
    const isCheckedOut = checkedOut.has(name);

    const delta = await committedDelta(root, base.oid, tip, {
      strictReadOnly: opts.strictReadOnly === true, timeout: opts.timeout ?? 30_000,
    });

    const failed = typeof delta.how === 'string' && delta.how.endsWith('-failed');
    if (failed || delta.how === 'merge-tree-no-tree') {
      branches.push({
        name, tip, ageDays, status: 'unknown', safe: false, checkedOut: isCheckedOut,
        reason: `instrument failed (${delta.how}) — refusing to classify; nothing here licenses a deletion${checkedOutReason(name)}`,
      });
      continue;
    }

    if (delta.files.length === 0) {
      const anc = await git(['merge-base', '--is-ancestor', tip, base.oid], { cwd: root });
      if (anc.code === 0) {
        branches.push({
          name, tip, ageDays, status: 'landed', safe: !isCheckedOut, checkedOut: isCheckedOut,
          reason: `content delta vs ${baseShort ?? base.oid.slice(0, 12)} is empty and the tip is an ancestor${checkedOutReason(name)}`,
          command: isCheckedOut ? undefined : `git branch -d ${name}`,
        });
      } else {
        branches.push({
          name, tip, ageDays, status: 'content-landed', safe: false, checkedOut: isCheckedOut,
          reason: 'every line of content already exists in base, but the tip is NOT an ancestor '
            + '(squash-merge or cherry-pick) — git branch -d will refuse; deleting needs -D, which '
            + 'holt never runs for you' + checkedOutReason(name),
          command: `git branch -D ${name}  # evidence: merge-tree delta vs base is empty`,
        });
      }
      continue;
    }

    branches.push({
      name, tip, ageDays, status: 'unlanded', safe: false, checkedOut: isCheckedOut,
      reason: `holds ${delta.files.length} file(s) of content base does not have${checkedOutReason(name)}`,
      files: delta.files.slice(0, FILE_CAP),
      fileCount: delta.files.length,
      how: delta.how,
    });
  }

  const journalFailures = [];
  const applied = [];
  if (apply) {
    for (const b of branches.filter((x) => x.status === 'landed' && !x.checkedOut)) {
      // Re-derive safety at deletion time from git's OWN check: -d refuses non-ancestors, so
      // even a stale verdict cannot force-delete anything (-D never appears here).
      const del = await gitOk(['branch', '-d', b.name], { cwd: root, allowMutation: true })
        .then(() => ({ ok: true }))
        .catch((e) => ({ ok: false, error: e.message }));
      applied.push({ name: b.name, ...del });
      if (del.ok) {
        await journal(root, {
          action: 'branch-delete', name: b.name, tip: b.tip, evidence: b.reason,
        }, journalFailures);
      }
    }
  }

  const by = (s) => branches.filter((b) => b.status === s);
  const result = {
    ok: true,
    base: { ref: base.ref, oid: base.oid, how: base.how },
    audited: branches.length,
    // Kept under the old field for machine compatibility; checked-out branches are now included in
    // the audit, but the field still names the set that cannot be auto-deleted.
    excludedCheckedOut: [...checkedOut].sort(),
    checkedOut: branches.filter((b) => b.checkedOut).map((b) => b.name).sort(),
    landed: by('landed'),
    contentLanded: by('content-landed'),
    unlanded: by('unlanded'),
    unknown: by('unknown'),
    applied,
    note: apply
      ? 'applied deletes use git branch -d only; git itself re-verifies ancestry at deletion time'
      : 'dry run — nothing was deleted. --apply deletes the landed bucket only (-d, never -D)',
  };
  if (!journalFailures.length) return result;
  return {
    ...result,
    journalFailures,
    journalWarning: `${journalFailures.length} journal write(s) FAILED — the branch delete(s) `
      + 'above still happened; only the audit-trail record of them did not. Recover manually '
      + 'using the branch name(s) in journalFailures.',
  };
}
