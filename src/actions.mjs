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
import { discover } from './discover.mjs';
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

/** Release protection. Only ever unlocks locks holt placed. */
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
    if (!st.reason.startsWith(LOCK_PREFIX) && !force) {
      actions.push({ id: ws.id, action: 'skipped-foreign-lock', reason: st.reason });
      continue;
    }
    const r = await git(['worktree', 'unlock', ws.path], { cwd, allowMutation: true });
    actions.push({ id: ws.id, action: r.code === 0 ? 'unlocked' : 'failed', reason: r.stderr.trim() || st.reason });
  }
  return { actions, unlocked: actions.filter((a) => a.action === 'unlocked').length };
}

/**
 * Un-C-quote a porcelain value.
 *
 * MEASURED: when a lock reason contains a character git treats as special (newline, quote,
 * non-ASCII — and holt's own reasons embed symbol names, which can be non-ASCII), porcelain
 * emits it C-QUOTED: `locked "holt: …"`. Read naively, the quotes arrive in the string,
 * startsWith('holt:') fails, and unprotect classifies holt's OWN lock as foreign — leaving
 * `rescue --release` unable to release it. The quoting is also what keeps a reason containing
 * `\nworktree /etc/passwd` from corrupting the porcelain stream (verified live) — a feature to
 * decode, not a quirk.
 */
function unquotePorcelain(s) {
  if (!s.startsWith('"') || !s.endsWith('"') || s.length < 2) return s;
  const body = s.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') { out += ch; continue; }
    const next = body[++i];
    if (next === 'n') out += '\n';
    else if (next === 't') out += '\t';
    else if (next === '\\') out += '\\';
    else if (next === '"') out += '"';
    else if (/[0-7]/.test(next)) {
      let oct = next;
      while (oct.length < 3 && /[0-7]/.test(body[i + 1] ?? '')) oct += body[++i];
      out += String.fromCharCode(parseInt(oct, 8));
    } else out += next;
  }
  return out;
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
