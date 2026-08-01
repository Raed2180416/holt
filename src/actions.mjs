// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — the MUTATING half: protect, rescue, clean.
 *
 * Everything else in holt diagnoses. These three act, and they exist because a measured A/B
 * showed diagnosis alone is not enough:
 *
 *   - a holt-arm agent ignored AGENTS.md and the plugin sitting in its own repository, and
 *     reasoned from `git log` instead                              -> PROTECT
 *   - agents repeatedly tried to rescue the valuable file by hand before deleting the worktree,
 *     inventing three different ad-hoc schemes                     -> RESCUE
 *   - a holt-arm agent got the right answer and then asked for confirmation instead of acting,
 *     scoring zero utility                                         -> CLEAN
 *
 * THE READ-ONLY GUARANTEE IS NOT WEAKENED. Every call here passes allowMutation:true explicitly;
 * the scanner cannot reach the MUTATE tier at all, and test/unit/safety.test.mjs still proves a
 * full scan changes nothing byte-for-byte. Adding write features widened one clearly-marked door,
 * not the default.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { git, gitOk, pmap, authorEnv } from './git.mjs';
import { discover, isHoltLock, unquotePorcelain } from './discover.mjs';
import {
  underOrEqualAsync, relativeWithinAsync, relativeLinkAwareAsync, canonicalPath, samePathSync,
} from './paths.mjs';
import { appendEvent } from './journal.mjs';
import { scan } from './scan.mjs';
import { analyze, uniqueWork, safeToDelete, contentAtRisk } from './analyze.mjs';

const LOCK_PREFIX = 'holt:';

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
      + `. Run 'holt rescue ${s.id}' to preserve it, or 'holt risk' to inspect.`;

    if (!dryRun) {
      const r = await git(['worktree', 'lock', '--reason', reason, ws.path],
        { cwd, allowMutation: true });
      if (r.code !== 0) {
        actions.push({ id: s.id, path: ws.path, action: 'failed', reason: r.stderr.trim() });
        continue;
      }
    }
    actions.push({ id: s.id, path: ws.path, action: dryRun ? 'would-lock' : 'locked', reason });
    if (!dryRun) await appendEvent(cwd, { action: 'protect', id: s.id, path: ws.path, reason });
  }

  // RECONCILE — protect is the one command that makes the lock set EQUAL the risk set, in both
  // directions. A lock that outlives its justification is not a safety measure: it freezes the
  // worktree permanently, `clean` can never reclaim it, and the only escape (`unprotect`) disarms
  // every tree including the ones that still need protecting. Following holt's own quick-start on
  // holt's own repository produced 20 locked worktrees, 18 of them holding nothing at all.
  //
  // Three independent conditions gate every release, and each is load-bearing:
  //   - the verdict is `safe` — computed from CONTENT, since holt's own lock stopped counting
  //     as a reason (see safeToDelete)
  //   - confidence is 'measured' — never 'unverifiable' (gitignored or unreadable content) and
  //     never 'unknown' (the scan failed). No evidence is not evidence of none.
  //   - git itself still reports the lock as holt's. A lock somebody else placed is never
  //     touched, whatever the verdict says.
  const released = [];
  for (const s of report.safe) {
    if (!s.safe || s.confidence !== 'measured') continue;
    const ws = report.graph.nodes.find((n) => n.id === s.id);
    if (!ws?.path) continue;
    const st = await lockState(ws.path, cwd);
    if (!st.locked || !isHoltLock(st.reason)) continue;

    if (!dryRun) {
      const r = await git(['worktree', 'unlock', ws.path], { cwd, allowMutation: true });
      if (r.code !== 0) {
        actions.push({ id: s.id, path: ws.path, action: 'release-failed', reason: r.stderr.trim() });
        continue;
      }
      // Journalled as an unprotect, flagged `stale` so an audit can tell an automatic
      // reconciliation apart from a human deliberately dropping a guard.
      await appendEvent(cwd, {
        action: 'unprotect', id: s.id, path: ws.path,
        reason: st.reason, stale: true, forced: false, foreignLock: false,
      });
    }
    released.push({ id: s.id, path: ws.path, was: st.reason });
    actions.push({ id: s.id, path: ws.path, action: dryRun ? 'would-release' : 'released', reason: st.reason });
  }

  return {
    dryRun,
    protected: actions.filter((a) => a.action === 'locked' || a.action === 'would-lock').length,
    alreadyProtected: actions.filter((a) => a.action === 'already-locked').length,
    released: released.length,
    releasedDetail: released,
    failed: actions.filter((a) => a.action === 'failed' || a.action === 'release-failed').length,
    // Never silently skip what we could not assess — that is the failure this tool exists for.
    unknown: unknown.map((u) => ({ id: u.id, why: u.reasons[0] })),
    actions,
    note: 'A locked worktree refuses `git worktree remove --force`. It does NOT stop `rm -rf`; '
      + 'the PreToolUse hook covers that.',
  };
}

/**
 * Release protection. Only ever unlocks locks holt placed.
 *
 * JOURNALLED LIKE EVERY OTHER MUTATION, and this is the one that most needs it. protect, rescue,
 * clean-remove and branch-delete all wrote an audit line; unprotect — the single action that
 * REMOVES the guard standing between irreplaceable work and a `--force` — wrote none. An audit
 * trail whose only gap is the risky action is not a partial audit trail, it is a misleading one:
 * a reviewer reading it sees protections applied and never released, so the record positively
 * asserts a safer state than the repository is in. Same shape as the others (action, id, path,
 * reason, actor), so one reader parses all of them.
 */
export async function unprotect(cwd, { id = null, force = false, ...opts } = {}) {
  const { report } = await assess(cwd, opts);
  const targets = report.graph.nodes.filter((n) => (id ? n.id === id : true));

  const actions = [];
  for (const ws of targets) {
    if (!ws.path) continue;
    const st = await lockState(ws.path, cwd);
    if (!st.locked) continue;
    // Locks placed by something else are left alone: holt must not quietly disarm a protection
    // a human or another tool put there deliberately.
    const foreign = !isHoltLock(st.reason);
    if (foreign && !force) {
      actions.push({ id: ws.id, action: 'skipped-foreign-lock', reason: st.reason });
      continue;
    }
    const r = await git(['worktree', 'unlock', ws.path], { cwd, allowMutation: true });
    actions.push({ id: ws.id, action: r.code === 0 ? 'unlocked' : 'failed', reason: r.stderr.trim() || st.reason });
    if (r.code === 0) {
      // `forced` and `foreignLock` are recorded because overriding a protection somebody else
      // placed is a materially different act from releasing holt's own, and a compliance review
      // that cannot tell them apart is not a review.
      await appendEvent(cwd, {
        action: 'unprotect', id: ws.id, path: ws.path,
        reason: st.reason, forced: !!force, foreignLock: foreign,
      });
    }
  }
  return { actions, unlocked: actions.filter((a) => a.action === 'unlocked').length };
}

/** Read a worktree's lock state from the porcelain listing. */
async function lockState(wtPath, cwd) {
  const r = await git(['worktree', 'list', '--porcelain'], { cwd });
  if (r.code !== 0) return { locked: false, reason: '' };
  // Canonicalised, not path.resolve'd. git reports /private/var/... on macOS while the caller
  // holds /var/...; a raw comparison finds no worktree, lockState reports "not locked", and
  // protect/unprotect/clean silently act as though a lock that exists is not there.
  const target = await canonicalPath(wtPath);
  let current = null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) current = await canonicalPath(line.slice(9));
    else if (line.startsWith('locked') && current && samePathSync(current, target)) {
      const raw = line.length > 6 ? line.slice(7) : '';
      return { locked: true, reason: unquotePorcelain(raw) };
    }
  }
  return { locked: false, reason: '' };
}

/* =============================================================== RESCUE ==== */

/**
 * Map a workstream id to a component git will accept in a refname.
 *
 * FOUND BY ATTACKING IT: the old sanitizer only stripped characters, so an id of `..` passed
 * straight through and `update-ref refs/holt/rescue/..` failed — git refuses `..`, leading
 * dots, and `.lock` suffixes in refnames (verified with `git check-ref-format`). A worktree
 * genuinely can be named `..something` or `x.lock` (detached — git refuses .lock in branch
 * names too), and a rescue that dies at update-ref AFTER building its capture is a confusing
 * failure in the one flow that must not confuse.
 */
export function refSafeId(id) {
  const cleaned = String(id).replace(/[^A-Za-z0-9._/-]/g, '_').replace(/\.\.+/g, '.');
  const parts = cleaned.split('/')
    .map((p2) => p2.replace(/^\.+/, '').replace(/\.lock$/i, '_lock'))
    .filter((p2) => p2.length > 0);
  return parts.length ? parts.join('/') : 'unnamed';
}

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
 *   - discoverable   `git log refs/holt/rescue/<id>` months later
 *   - reversible     `git checkout refs/holt/rescue/<id> -- .` restores it
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

  // THE SAME CONTENT COMPUTATION `gate` USES. rescue used to build its own set from the
  // uncommitted layer alone, so a worktree whose only unique content was gitignored got
  // "✗ HOLDS UNIQUE WORK, exit 1" from gate and "nothing to rescue, exit 0" from rescue — and
  // exit 0 is what a `holt rescue X && git worktree remove X` chain acts on. Deriving the set
  // here instead of in contentAtRisk() is what allowed the drift; it is not done here any more.
  const risk = contentAtRisk(ws);
  const files = risk.files;
  const committedDelta = risk.committedCount;

  // AN INSTRUMENT THAT FAILED IS NOT AN EMPTY WORKTREE. Both look like zero paths from here, and
  // only one of them makes deletion safe — so a probe failure must produce a NAMED refusal with
  // a non-zero exit, never the cheerful nothing-to-rescue that licenses the deletion.
  if (risk.blind.length) {
    return {
      ok: false,
      id,
      error: `holt could not enumerate this worktree's content: ${risk.blind.join('; ')}`,
      blind: risk.blind,
      note: 'nothing was captured and nothing was released. holt cannot tell an empty worktree '
        + 'from one it failed to look inside, so it refuses rather than report nothing-to-rescue.',
    };
  }

  if (files.length === 0 && committedDelta === 0) {
    return { ok: true, nothingToRescue: true, id, note: 'this worktree holds nothing base lacks' };
  }

  // A workstream id is only a DIRECTORY BASENAME, so it is reused constantly: delete `wt/feat`,
  // create a new `wt/feat` later, and both map to refs/holt/rescue/feat. Writing that ref
  // unconditionally silently destroyed the earlier capture — a rescue overwriting a rescue,
  // which is the exact opposite of this command's promise ("discoverable months later"). Live-
  // reproduced against the real binary, so the ref is now allocated NEVER-DESTRUCTIVELY: if the
  // name is taken by a DIFFERENT commit, suffix it. Re-rescuing identical content reuses the
  // same ref (idempotent, no ref sprawl); genuinely new content always gets its own.
  const baseRef = `refs/holt/rescue/${refSafeId(id)}`;
  let ref = baseRef;
  if (dryRun) {
    return { ok: true, dryRun: true, id, ref, wouldCapture: { files, committedDelta } };
  }

  // Build a tree from the worktree's CURRENT state in a scratch index.
  const tmpIndex = path.join(ws.path, '.git-holt-rescue-index');
  // holt authors this capture; a repo with no configured identity must still be rescuable.
  const env = { GIT_INDEX_FILE: tmpIndex, ...(await authorEnv(ws.path)) };
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

    const msg = `holt rescue: ${id}\n\n`
      + `Captured ${files.length} at-risk path(s) `
      + `(${risk.layers.uncommitted.length} modified, ${risk.layers.untracked.length} untracked, `
      + `${risk.layers.ignored.length} gitignored) and the worktree's committed state.\n`
      + `Restore with:  git checkout <this-ref> -- .   (see 'holt rescued')\n`;
    const commitR = await gitOk(
      ['commit-tree', tree, '-p', ws.head, '-m', msg],
      { cwd: ws.path, env, allowMutation: true },
    );
    const commit = commitR.stdout.trim();

    // Allocate the ref non-destructively, now that the commit exists:
    //   - name free            -> use it
    //   - name holds THIS commit -> reuse it (re-rescuing identical content is idempotent)
    //   - name holds ANOTHER commit -> suffix, never overwrite
    // Without this, a reused directory basename silently destroyed the earlier capture.
    for (let n = 2; n < 1000; n++) {
      const cur = await git(['rev-parse', '--verify', '--quiet', ref], { cwd: ws.path });
      const oid = cur.code === 0 ? cur.stdout.trim() : '';
      if (!oid || oid === commit) break;
      ref = `${baseRef}-${n}`;
    }

    // `--create-reflog` forces a reflog for this ref even though refs/holt/* is outside git's
    // default logged namespaces. Belt-and-braces on top of the never-overwrite rule above: if a
    // future change ever did move one of these refs, the previous value would still be
    // recoverable from `git reflog show <ref>` instead of becoming unreachable silently.
    await gitOk(['update-ref', '--create-reflog', ref, commit], { cwd: ws.path, allowMutation: true });

    // VERIFY before claiming success. A rescue that silently captured nothing is worse than no
    // rescue at all, because it licenses a deletion.
    // -z is LOAD-BEARING: without it ls-tree C-quotes non-ASCII paths ("src/\303\274ni.js"),
    // while the `files` list (from status --porcelain -z) carries them raw. The comparison then
    // mismatches and rescue refuses a capture that actually succeeded — found by the monster
    // round on a worktree named ünïcode-3. NUL-separated output is never quoted.
    const captured = await git(['ls-tree', '-r', '--name-only', '-z', commit], { cwd: ws.path });
    const capturedFiles = captured.code === 0 ? captured.stdout.split('\0').filter(Boolean) : [];
    const capturedSet = new Set(capturedFiles);

    // `git status` reports an unaddable directory as `nested/`; the tree lists files. Count a
    // directory entry as captured only if SOMETHING beneath it made it in.
    const isCaptured = (f) => (f.endsWith('/')
      ? capturedFiles.some((c) => c.startsWith(f))
      : capturedSet.has(f));

    // A GITLINK SATISFIES "THE PATH IS IN THE TREE" WITHOUT CAPTURING ANYTHING.
    //
    // `git add --all --force` cannot record a submodule's UNCOMMITTED work: the only thing it can
    // write for a submodule is the gitlink, and the gitlink only moves when something is COMMITTED
    // inside. So for a dirty submodule the rescue commit contains the same `160000 commit <sha>`
    // it started with — the path IS present, capturedSet.has(f) is true, and verification passed
    // while nothing whatsoever had been captured.
    //
    // Reproduced end to end: rescue returned {ok:true, verified:true, capturedFiles:1} for a
    // submodule holding an untracked file; the rescue commit's diff contained no trace of it, and
    // removing the worktree afterwards — which is exactly what rescue's own output invites — left
    // the content in no git object in either repository. The comment above this function sets the
    // standard it was failing: "a rescue that silently captured nothing is worse than no rescue
    // at all, because it licenses a deletion."
    //
    // holt does not try to recurse and capture the submodule's state: a submodule is a separate
    // repository with its own history, and quietly committing into it would be a mutation the
    // user never asked for. It REFUSES instead, and names the command that does work.
    const dirtySubmodules = [];
    for (const f of files) {
      const rel = f.replace(/\/$/, '');
      const inTree = await git(['ls-tree', '-z', commit, '--', rel], { cwd: ws.path });
      if (inTree.code !== 0 || !/^160000 /.test(inTree.stdout)) continue;   // not a gitlink
      const sub = path.join(ws.path, rel);
      const dirty = await git(['status', '--porcelain', '--untracked-files=all'], { cwd: sub })
        .catch(() => ({ code: 1, stdout: '' }));
      if (dirty.code === 0 && dirty.stdout.trim()) dirtySubmodules.push(rel);
    }

    const missing = files.filter((f) => !isCaptured(f))
      .concat(dirtySubmodules.map((d) => `${d} (submodule with uncommitted work)`));

    if (missing.length) {
      return {
        ok: false, id, ref, commit,
        error: `rescue is INCOMPLETE — ${missing.length} path(s) not captured: ${missing.slice(0, 5).join(', ')}`,
        missing,
        addWarnings: added.code === 0 ? [] : added.stderr.split('\n').filter(Boolean).slice(0, 5),
        note: 'the worktree has NOT been released and nothing was deleted. '
          + 'A nested git repository or a SUBMODULE holding uncommitted work is the usual cause: '
          + 'git can only record a submodule\'s committed state, so its working-tree changes '
          + 'cannot be captured from here. Commit inside the submodule (or move the work out), '
          + 'then rescue again.',
      };
    }

    let released = null;
    if (release) {
      const un = await unprotect(cwd, { id, ...opts });
      released = un.unlocked > 0;
    }

    // Record WHICH worktree this was, not just its (reusable) basename: path, branch and head
    // make two rescues under a recycled id distinguishable in the audit trail. Without them the
    // journal printed two identical lines for two different captures — live-reproduced.
    await appendEvent(cwd, {
      action: 'rescue', id, ref, commit,
      path: ws.path, branch: ws.branch ?? null, head: ws.head ?? null,
      capturedFiles: files.length, released: release,
    });
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

/* ============================================================== DISCARD ==== */

/**
 * The escape hatch. Delete something holt is guarding, with the content captured first.
 *
 * WHY THIS EXISTS. The guard refused a scratch file with:
 *
 *     holt blocked this: rm (deletes the file) would destroy 1 file(s) whose only copy is on disk.
 *     … If it is genuinely disposable, discard it explicitly rather than through this command.
 *
 * and there was no such command. No flag, no environment variable, no allow-once anywhere in the
 * source. The instruction named an action the product did not have, which leaves a user exactly
 * one way out: uninstall the hook. That is the failure this README already names — "because a
 * gate that only refuses gets switched off" — and the same lesson the A/B measured, where the
 * warnings-only arm froze at 0% cleanup while the arm with a PERMITTED ACTION cleaned 73%.
 *
 * So this is not a bypass, and deliberately not shaped like one. A bypass takes the guard away;
 * this takes the LOSS away and leaves the guard intact:
 *
 *   - the content is captured to refs/holt/discard/* BEFORE anything is removed;
 *   - the capture is VERIFIED by reading the tree back, exactly as rescue does, and a capture
 *     that cannot be verified aborts with nothing deleted — the refusal must be the failure mode;
 *   - it is journalled, so "who deleted this, and where did it go" is answerable months later;
 *   - the restore command is printed.
 *
 * The result is an action an agent is allowed to take, which is the only kind of gate that
 * survives contact with someone in a hurry.
 */
export async function discard(cwd, paths, { dryRun = false, ...opts } = {}) {
  const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
  if (!list.length) return { ok: false, error: 'discard needs at least one path' };

  const disc = await discover(cwd, opts);
  if (!disc.root) throw Object.assign(new Error(`not a git repository: ${cwd}`), { code: 'ENOTREPO' });

  // Every path must sit inside ONE worktree: the capture is a tree built in that worktree's
  // index, and silently splitting a discard across two of them would produce two half-captures.
  const resolved = [];
  for (const p of list) {
    const abs = path.resolve(cwd, p);
    // lstat, NOT stat: stat follows the link and answers about its target. Which entry the user
    // named is the whole question here.
    let st;
    try {
      st = await fs.lstat(abs);
    } catch {
      return { ok: false, error: `no such path: ${p}` };
    }
    const isSymlink = st.isSymbolicLink();
    const owner = await findOwningWorktree(abs, disc);
    if (!owner) return { ok: false, error: `'${p}' is not inside a worktree of this repository` };
    resolved.push({ input: p, abs, owner, isSymlink });
  }
  const owners = [...new Set(resolved.map((r) => r.owner.path))];
  if (owners.length > 1) {
    return { ok: false, error: `paths span ${owners.length} worktrees; discard one worktree's paths at a time`, owners };
  }

  const ws = resolved[0].owner;
  const rel = await Promise.all(resolved.map((r) => relativeLinkAwareAsync(ws.path, r.abs)));

  if (dryRun) {
    return { ok: true, dryRun: true, worktree: ws.id, paths: rel, note: 'nothing was captured or removed' };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const baseRef = `refs/holt/discard/${refSafeId(ws.id)}-${stamp}`;
  const tmpIndex = path.join(ws.path, '.git-holt-discard-index');
  const env = { GIT_INDEX_FILE: tmpIndex, ...(await authorEnv(ws.path)) };

  try {
    // An EMPTY index, not HEAD: a discard captures the paths being discarded and nothing else,
    // so the ref reads as exactly what was thrown away rather than a whole worktree snapshot.
    await gitOk(['read-tree', '--empty'], { cwd: ws.path, env, allowMutation: true });
    // --force so gitignored paths are captured too — those are precisely the ones git cannot
    // bring back, and the ones the guard refuses hardest.
    const added = await git(['add', '--all', '--force', '--', ...rel],
      { cwd: ws.path, env, allowMutation: true });

    const treeR = await gitOk(['write-tree'], { cwd: ws.path, env, allowMutation: true });
    const tree = treeR.stdout.trim();
    const msg = `holt discard: ${rel.length} path(s) from ${ws.id}\n\n`
      + `${rel.join('\n')}\n\nRestore with:  git checkout <this-ref> -- .\n`;
    const commitR = await gitOk(['commit-tree', tree, '-m', msg],
      { cwd: ws.path, env, allowMutation: true });
    const commit = commitR.stdout.trim();

    // VERIFY BEFORE DELETING — the whole point. Read the tree back and confirm every path asked
    // for is really in it. -z because ls-tree C-quotes non-ASCII paths otherwise, which made an
    // earlier verification refuse captures that had actually succeeded.
    const captured = await git(['ls-tree', '-r', '--name-only', '-z', commit], { cwd: ws.path });
    const capturedFiles = captured.code === 0 ? captured.stdout.split('\0').filter(Boolean) : [];
    const capturedSet = new Set(capturedFiles);
    const isCaptured = (f) => capturedSet.has(f) || capturedFiles.some((c) => c.startsWith(`${f}/`));
    const missing = rel.filter((f) => !isCaptured(f));
    if (missing.length) {
      return {
        ok: false,
        error: `capture is INCOMPLETE — ${missing.length} path(s) not captured: ${missing.slice(0, 5).join(', ')}`,
        missing,
        addWarnings: added.code === 0 ? [] : added.stderr.split('\n').filter(Boolean).slice(0, 5),
        note: 'NOTHING WAS DELETED. A discard that cannot prove it captured the content must not '
          + 'proceed — that would be the loss this command exists to prevent.',
      };
    }

    await gitOk(['update-ref', '--create-reflog', baseRef, commit],
      { cwd: ws.path, allowMutation: true });

    // ONLY NOW IS ANYTHING TOUCHED — and what "discard" MEANS depends on what the path is.
    //
    // For an UNTRACKED path, discarding is deleting: nothing else holds it.
    //
    // For a TRACKED path with local modifications, deleting would be wrong and surprising. What
    // a user means is "throw away my edits", and the standard way to say that — `git checkout --
    // <path>` — is refused by holt's own guard for the correct reason: it destroys uncommitted
    // work. Refusing that with no permitted alternative is the same hole `discard` was added to
    // close, one level down; hit twice in real use while building this. So a tracked path is
    // RESTORED from HEAD after its modified content is captured, and the file stays where it is.
    const removed = [];
    const reverted = [];
    for (const r of resolved) {
      const relPath = await relativeLinkAwareAsync(ws.path, r.abs);
      const tracked = await git(['cat-file', '-e', `HEAD:${relPath}`], { cwd: ws.path });
      // A SYMLINK IS NEVER FOLLOWED. Reverting a tracked path writes its committed bytes back to
      // the named path — and writing to a symlink writes THROUGH it. Reproduced: `holt discard
      // link.txt` restored the committed content of link.txt's TARGET over the target, destroying
      // the target's uncommitted work, while the symlink the user named was left in place. The
      // link itself is content (a pointer), so it is captured and removed like any untracked
      // entry; fs.rm on a symlink unlinks the link and never touches what it points at.
      if (tracked.code === 0 && !r.isSymlink) {
        // The blob is read with plumbing and written with fs, NOT with `git checkout`.
        // `git checkout -- <path>` is refused by the classifier's FIRST gate, which cannot be
        // opened even with allowMutation — deliberately, because that gate is what stopped a
        // mutation test from running a live `reset --hard` in this repository. holt does not get
        // an exception to its own destructive-command rule; it reaches the same result through
        // a read (`cat-file`) plus an ordinary file write, after the content is already captured.
        const blob = await git(['cat-file', 'blob', `HEAD:${relPath}`], { cwd: ws.path });
        if (blob.code !== 0) {
          return {
            ok: false, ref: baseRef, commit,
            error: `captured, but could not read '${relPath}' from HEAD: ${blob.stderr.trim()}`,
            note: 'NOTHING WAS CHANGED. The content is safe in the ref above.',
          };
        }
        await fs.writeFile(r.abs, blob.stdout, 'utf8');
        reverted.push(r.input);
      } else {
        await fs.rm(r.abs, { recursive: true, force: true });
        removed.push(r.input);
      }
    }

    await appendEvent(cwd, {
      action: 'discard', id: ws.id, path: ws.path,
      ref: baseRef, commit, paths: rel, count: rel.length,
    });

    return {
      ok: true,
      worktree: ws.id,
      ref: baseRef,
      commit,
      discarded: removed,
      reverted,
      verified: true,
      restore: `git checkout ${baseRef} -- .`,
      inspect: `git show ${commit} --stat`,
      note: reverted.length
        ? 'tracked path(s) were RESTORED from HEAD rather than deleted — the edits you threw away '
          + 'are captured in the ref above and recoverable. Untracked path(s), if any, were removed.'
        : 'content captured and verified before removal; it is recoverable from the ref above.',
    };
  } finally {
    await fs.rm(tmpIndex, { force: true }).catch(() => {});
  }
}

/** The worktree a path lives in, chosen by the LONGEST match so nested worktrees resolve right. */
async function findOwningWorktree(abs, disc) {
  let best = null;
  for (const w of disc.workstreams) {
    if (!w.path) continue;
    if (!(await underOrEqualAsync(abs, w.path))) continue;
    if (!best || w.path.length > best.path.length) best = w;
  }
  return best;
}

/** List every rescue holt has ever taken in this repo. */
export async function rescues(cwd) {
  const r = await git(['for-each-ref', '--format=%(refname) %(objectname) %(creatordate:iso)', 'refs/holt/rescue'],
    { cwd });
  if (r.code !== 0) return [];
  return r.stdout.split('\n').filter(Boolean).map((line) => {
    const [refname, oid, ...date] = line.split(' ');
    return { ref: refname, commit: oid, at: date.join(' '), id: refname.replace('refs/holt/rescue/', '') };
  });
}

/* ================================================================ CLEAN ==== */

/**
 * Remove provably-disposable worktrees, and their branches.
 *
 * The documented everyday pain is not danger, it is friction: "add is one command, rm is two
 * more (worktree + branch), and almost no one runs both reliably across ten merged PRs." Holt
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

    // A tree holt locked earlier can be genuinely disposable now — its lock is holt's own past
    // verdict, not evidence (see safeToDelete). Release it here, immediately after the re-verify
    // and immediately before the removal, so the window in which the guard is down is as short
    // as it can be. `git worktree remove` refuses a locked tree, so without this the reclaim
    // silently fails on every worktree protect ever touched.
    //
    // The foreign-lock check is a SECOND, structurally independent gate: a foreign lock already
    // keeps the tree out of this plan by making the verdict unsafe, and it is repeated here
    // because no single defect should be able to open both.
    const lock = await lockState(p.path, cwd);
    if (lock.locked) {
      if (!isHoltLock(lock.reason)) {
        done.push({ ...p, action: 'skipped', why: `locked by something other than holt: ${lock.reason}` });
        continue;
      }
      const ul = await git(['worktree', 'unlock', p.path], { cwd, allowMutation: true });
      if (ul.code !== 0) {
        done.push({ ...p, action: 'failed', why: `could not release holt's own lock: ${ul.stderr.trim()}` });
        continue;
      }
      await appendEvent(cwd, {
        action: 'unprotect', id: p.id, path: p.path,
        reason: lock.reason, stale: true, forced: false, foreignLock: false,
      });
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
    await appendEvent(cwd, {
      action: 'clean-remove', id: p.id, path: p.path, branch: p.branch ?? null, branchRemoved,
      evidence: still.reasons?.length ? still.reasons : ['re-verified disposable at removal time'],
    });
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
