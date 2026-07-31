/**
 * grove — the MUTATING half: protect, rescue, clean.
 *
 * Everything else in grove diagnoses. These three act, and they exist because a measured A/B
 * showed diagnosis alone is not enough:
 *
 *   - a grove-arm agent ignored AGENTS.md and the plugin sitting in its own repository, and
 *     reasoned from `git log` instead                              -> PROTECT
 *   - agents repeatedly tried to rescue the valuable file by hand before deleting the worktree,
 *     inventing three different ad-hoc schemes                     -> RESCUE
 *   - a grove-arm agent got the right answer and then asked for confirmation instead of acting,
 *     scoring zero utility                                         -> CLEAN
 *
 * THE READ-ONLY GUARANTEE IS NOT WEAKENED. Every call here passes allowMutation:true explicitly;
 * the scanner cannot reach the MUTATE tier at all, and test/unit/safety.test.mjs still proves a
 * full scan changes nothing byte-for-byte. Adding write features widened one clearly-marked door,
 * not the default.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { git, gitOk, pmap } from './git.mjs';
import { discover } from './discover.mjs';
import { scan } from './scan.mjs';
import { analyze, uniqueWork, safeToDelete } from './analyze.mjs';

const LOCK_PREFIX = 'grove:';

/** One scan shared by every action, so protect/rescue/clean cannot disagree with each other. */
async function assess(cwd, opts = {}) {
  const disc = await discover(cwd, opts);
  if (!disc.root) throw Object.assign(new Error(`not a git repository: ${cwd}`), { code: 'ENOTREPO' });
  const scanned = await scan(disc, opts);
  const report = await analyze(scanned, opts);
  return { disc, scanned, report };
}

/* ============================================================== PROTECT ==== */

/**
 * Why `git worktree lock` and not a hook.
 *
 * VERIFIED against git 2.55: a locked worktree refuses `git worktree remove --force`, printing
 *
 *     fatal: cannot remove a locked working tree, lock reason: <ours>
 *     use 'remove -f -f' to override or unlock first
 *
 * That single fact does more than the entire integration layer:
 *   - it needs NO plugin, NO MCP, NO AGENTS.md, and no cooperation from the model;
 *   - it works identically for Claude Code, Codex, Cursor, crush, a shell script and a human;
 *   - git prints OUR reason, so the agent learns why and what to do about it;
 *   - and it defeats exactly the failure mode the eval measured — both naked-arm losses were a
 *     SINGLE `--force`.
 *
 * What it does not stop: `rm -rf`. That is filesystem-level and only a PreToolUse hook can catch
 * it. Stated plainly rather than papered over.
 */
export async function protect(cwd, { dryRun = false, ...opts } = {}) {
  const { report } = await assess(cwd, opts);
  const uniq = new Map(report.unique.map((u) => [u.id, u]));

  const shouldProtect = report.safe.filter((s) => !s.safe && s.confidence !== 'unknown');
  const unknown = report.safe.filter((s) => s.confidence === 'unknown');

  const actions = [];
  for (const s of shouldProtect) {
    const ws = report.graph.nodes.find((n) => n.id === s.id);
    if (!ws?.path) continue;

    const already = await lockState(ws.path, cwd);
    if (already.locked) {
      actions.push({ id: s.id, path: ws.path, action: 'already-locked', reason: already.reason });
      continue;
    }

    const u = uniq.get(s.id);
    const sample = u
      ? [...u.byLayer.uncommitted, ...u.byLayer.untracked, ...u.byLayer.committed]
        .slice(0, 2).map((x) => x.key).join(', ')
      : '';
    // The reason string is the entire user interface of this feature: it is what git prints to
    // whoever tries to delete this. It has to say what is at stake and how to resolve it.
    const reason = `${LOCK_PREFIX} holds work found nowhere else`
      + (sample ? ` (e.g. ${sample})` : '')
      + `. Run 'grove rescue ${s.id}' to preserve it, or 'grove risk' to inspect.`;

    if (!dryRun) {
      const r = await git(['worktree', 'lock', '--reason', reason, ws.path],
        { cwd, allowMutation: true });
      if (r.code !== 0) {
        actions.push({ id: s.id, path: ws.path, action: 'failed', reason: r.stderr.trim() });
        continue;
      }
    }
    actions.push({ id: s.id, path: ws.path, action: dryRun ? 'would-lock' : 'locked', reason });
  }

  return {
    dryRun,
    protected: actions.filter((a) => a.action === 'locked' || a.action === 'would-lock').length,
    alreadyProtected: actions.filter((a) => a.action === 'already-locked').length,
    failed: actions.filter((a) => a.action === 'failed').length,
    // Never silently skip what we could not assess — that is the failure this tool exists for.
    unknown: unknown.map((u) => ({ id: u.id, why: u.reasons[0] })),
    actions,
    note: 'A locked worktree refuses `git worktree remove --force`. It does NOT stop `rm -rf`; '
      + 'the PreToolUse hook covers that.',
  };
}

/** Release protection. Only ever unlocks locks grove placed. */
export async function unprotect(cwd, { id = null, force = false, ...opts } = {}) {
  const { report } = await assess(cwd, opts);
  const targets = report.graph.nodes.filter((n) => (id ? n.id === id : true));

  const actions = [];
  for (const ws of targets) {
    if (!ws.path) continue;
    const st = await lockState(ws.path, cwd);
    if (!st.locked) continue;
    // Locks placed by something else are left alone: grove must not quietly disarm a protection
    // a human or another tool put there deliberately.
    if (!st.reason.startsWith(LOCK_PREFIX) && !force) {
      actions.push({ id: ws.id, action: 'skipped-foreign-lock', reason: st.reason });
      continue;
    }
    const r = await git(['worktree', 'unlock', ws.path], { cwd, allowMutation: true });
    actions.push({ id: ws.id, action: r.code === 0 ? 'unlocked' : 'failed', reason: r.stderr.trim() || st.reason });
  }
  return { actions, unlocked: actions.filter((a) => a.action === 'unlocked').length };
}

/** Read a worktree's lock state from the porcelain listing. */
async function lockState(wtPath, cwd) {
  const r = await git(['worktree', 'list', '--porcelain'], { cwd });
  if (r.code !== 0) return { locked: false, reason: '' };
  const target = path.resolve(wtPath);
  let current = null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) current = path.resolve(line.slice(9));
    else if (line.startsWith('locked') && current === target) {
      return { locked: true, reason: line.length > 6 ? line.slice(7) : '' };
    }
  }
  return { locked: false, reason: '' };
}

/* =============================================================== RESCUE ==== */

/**
 * Capture a worktree's full state so the worktree itself becomes disposable.
 *
 * WHY A REF AND NOT A STASH OR A FILE COPY. In the eval, agents invented three different rescue
 * schemes on the fly — copy into the main repo, copy under a new name, copy to a sibling
 * directory. All three "work" and all three lose the git context, leave no record, and are
 * impossible to verify or undo. A commit on a dedicated ref is:
 *
 *   - complete       tracked modifications AND untracked files, in one object
 *   - verifiable     the ref is diffed against the worktree before anything is released
 *   - discoverable   `git log refs/grove/rescue/<id>` months later
 *   - reversible     `git checkout refs/grove/rescue/<id> -- .` restores it
 *   - inert          it is not a branch, so it never appears in normal branch listings
 *
 * The index is built in a TEMPORARY index file, so the worktree's own index is untouched — the
 * user's staged changes are not disturbed by a rescue.
 */
export async function rescue(cwd, id, { dryRun = false, release = false, ...opts } = {}) {
  const { report, scanned } = await assess(cwd, opts);
  const ws = scanned.workstreams.find((w) => w.id === id);
  if (!ws) {
    return { ok: false, error: `no workstream '${id}'`, known: scanned.workstreams.map((w) => w.id) };
  }
  if (!ws.ok) return { ok: false, error: `'${id}' could not be scanned: ${ws.reason}` };

  const files = [...new Set([...ws.uncommitted.files, ...ws.uncommitted.untracked])]
    .filter(Boolean);
  const committedDelta = ws.committed.count;

  if (files.length === 0 && committedDelta === 0) {
    return { ok: true, nothingToRescue: true, id, note: 'this worktree holds nothing base lacks' };
  }

  const ref = `refs/grove/rescue/${id.replace(/[^A-Za-z0-9._/-]/g, '_')}`;
  if (dryRun) {
    return { ok: true, dryRun: true, id, ref, wouldCapture: { files, committedDelta } };
  }

  // Build a tree from the worktree's CURRENT state in a scratch index.
  const tmpIndex = path.join(ws.path, '.git-grove-rescue-index');
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    // Seed from HEAD so committed content is included, then overlay everything on disk.
    await gitOk(['read-tree', 'HEAD'], { cwd: ws.path, env, allowMutation: true });
    // --force so .gitignore'd files are captured too: a rescue that honoured ignore rules would
    // silently drop exactly the local config an agent might have spent an hour on.
    //
    // Deliberately NOT gitOk: a PARTIAL add must reach verification rather than throw. Measured
    // case — a nested git repository inside the worktree (a vendored checkout, a stray
    // `git init`) makes add exit non-zero with "'nested/' does not have a commit checked out"
    // while still indexing everything else. Throwing there would report a generic failure;
    // continuing to verification reports exactly WHICH files were not captured, which is the
    // information that decides whether this worktree may be released.
    const added = await git(['add', '--all', '--force', '--', '.'],
      { cwd: ws.path, env, allowMutation: true });

    const treeR = await gitOk(['write-tree'], { cwd: ws.path, env, allowMutation: true });
    const tree = treeR.stdout.trim();

    const msg = `grove rescue: ${id}\n\n`
      + `Captured ${files.length} uncommitted/untracked file(s) and the worktree's committed state.\n`
      + `Restore with:  git checkout ${ref} -- .\n`;
    const commitR = await gitOk(
      ['commit-tree', tree, '-p', ws.head, '-m', msg],
      { cwd: ws.path, env, allowMutation: true },
    );
    const commit = commitR.stdout.trim();

    await gitOk(['update-ref', ref, commit], { cwd: ws.path, allowMutation: true });

    // VERIFY before claiming success. A rescue that silently captured nothing is worse than no
    // rescue at all, because it licenses a deletion.
    const captured = await git(['ls-tree', '-r', '--name-only', commit], { cwd: ws.path });
    const capturedFiles = captured.code === 0 ? captured.stdout.split('\n').filter(Boolean) : [];
    const capturedSet = new Set(capturedFiles);

    // `git status` reports an unaddable directory as `nested/`; the tree lists files. Count a
    // directory entry as captured only if SOMETHING beneath it made it in.
    const isCaptured = (f) => (f.endsWith('/')
      ? capturedFiles.some((c) => c.startsWith(f))
      : capturedSet.has(f));
    const missing = files.filter((f) => !isCaptured(f));

    if (missing.length) {
      return {
        ok: false, id, ref, commit,
        error: `rescue is INCOMPLETE — ${missing.length} path(s) not captured: ${missing.slice(0, 5).join(', ')}`,
        missing,
        addWarnings: added.code === 0 ? [] : added.stderr.split('\n').filter(Boolean).slice(0, 5),
        note: 'the worktree has NOT been released and nothing was deleted. '
          + 'A nested git repository inside the worktree is the usual cause — commit or move it, '
          + 'then rescue again.',
      };
    }

    let released = null;
    if (release) {
      const un = await unprotect(cwd, { id, ...opts });
      released = un.unlocked > 0;
    }

    return {
      ok: true, id, ref, commit,
      capturedFiles: files.length,
      verified: true,
      released,
      restore: `git checkout ${ref} -- .`,
      inspect: `git show ${commit} --stat`,
      note: released
        ? 'work is captured and verified; protection released, the worktree is now disposable'
        : 'work is captured and verified. Pass --release to also unlock the worktree.',
    };
  } finally {
    await fs.rm(tmpIndex, { force: true }).catch(() => {});
  }
}

/** List every rescue grove has ever taken in this repo. */
export async function rescues(cwd) {
  const r = await git(['for-each-ref', '--format=%(refname) %(objectname) %(creatordate:iso)', 'refs/grove/rescue'],
    { cwd });
  if (r.code !== 0) return [];
  return r.stdout.split('\n').filter(Boolean).map((line) => {
    const [refname, oid, ...date] = line.split(' ');
    return { ref: refname, commit: oid, at: date.join(' '), id: refname.replace('refs/grove/rescue/', '') };
  });
}

/* ================================================================ CLEAN ==== */

/**
 * Remove provably-disposable worktrees, and their branches.
 *
 * The documented everyday pain is not danger, it is friction: "add is one command, rm is two
 * more (worktree + branch), and almost no one runs both reliably across ten merged PRs." Grove
 * already knows exactly which worktrees hold nothing base lacks — it just never acted on it, and
 * a measured trial showed an agent reaching the right answer and then stalling for confirmation.
 *
 * DRY RUN BY DEFAULT. A cleanup tool whose first behaviour is deletion does not get a second use.
 */
/**
 * @param {object}   opts
 * @param {boolean}  opts.apply     actually delete (default: dry run)
 * @param {boolean}  opts.branches  also delete the worktree's branch when merged
 * @param {Function} opts.onBeforeRemove  called with each candidate immediately before its
 *   re-verification. A destructive loop over N worktrees should be able to report progress, and
 *   it is also the seam that makes the TOCTOU re-check testable DETERMINISTICALLY rather than by
 *   racing a timer — a flaky test for this would be worse than none, because the behaviour it
 *   guards is "do not delete on a stale verdict".
 */
export async function clean(cwd, { apply = false, branches = true, onBeforeRemove = null, ...opts } = {}) {
  const { report } = await assess(cwd, opts);

  const disposable = report.safe.filter((s) => s.safe);
  const held = report.safe.filter((s) => !s.safe && s.confidence !== 'unknown');
  const unknown = report.safe.filter((s) => s.confidence === 'unknown');

  const plan = [];
  for (const s of disposable) {
    const node = report.graph.nodes.find((n) => n.id === s.id);
    if (!node?.path) continue;
    plan.push({
      id: s.id,
      path: node.path,
      branch: node.branch ?? null,
      why: s.reasons[0],
    });
  }

  if (!apply) {
    return {
      dryRun: true,
      wouldRemove: plan,
      keeping: held.map((h) => ({ id: h.id, why: h.reasons.join('; ') })),
      unknown: unknown.map((u) => ({ id: u.id, why: u.reasons[0] })),
      note: `${plan.length} worktree(s) hold nothing base lacks. Re-run with --apply to remove them`
        + `${branches ? ' and their branches' : ''}.`,
    };
  }

  const done = [];
  for (const p of plan) {
    if (onBeforeRemove) await onBeforeRemove(p);

    // Re-verify immediately before deleting. The scan may be seconds old and a worktree can gain
    // work in that window; for a destructive action, a stale verdict is not good enough.
    const fresh = await assess(cwd, opts);
    const still = fresh.report.safe.find((s) => s.id === p.id);
    if (!still?.safe) {
      done.push({ ...p, action: 'skipped', why: `no longer disposable: ${still?.reasons?.[0] ?? 'unknown'}` });
      continue;
    }

    const rm = await git(['worktree', 'remove', p.path], { cwd, allowMutation: true });
    if (rm.code !== 0) {
      done.push({ ...p, action: 'failed', why: rm.stderr.trim() });
      continue;
    }

    let branchRemoved = false;
    if (branches && p.branch) {
      // -d, never -D: git refuses to delete an unmerged branch, and that refusal is a feature.
      const br = await git(['branch', '-d', p.branch], { cwd, allowMutation: true });
      branchRemoved = br.code === 0;
    }
    done.push({ ...p, action: 'removed', branchRemoved });
  }

  return {
    dryRun: false,
    removed: done.filter((d) => d.action === 'removed').length,
    branchesRemoved: done.filter((d) => d.branchRemoved).length,
    skipped: done.filter((d) => d.action === 'skipped'),
    failed: done.filter((d) => d.action === 'failed'),
    actions: done,
    unknown: unknown.map((u) => ({ id: u.id, why: u.reasons[0] })),
  };
}
