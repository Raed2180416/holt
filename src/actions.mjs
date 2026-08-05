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
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { git, gitOk, gitPathBatched, catFileBatch, pmap, authorEnv } from './git.mjs';
import {
  discover, isHoltLock, isHoltCleanQuarantineLock, HOLT_CLEAN_QUARANTINE_LOCK_PREFIX,
  HOLT_CLEAN_QUARANTINE_MARKER_PREFIX, parseWorktreePorcelain, unquotePorcelain, repoAbsenceError,
  disambiguate,
} from './discover.mjs';
import {
  underOrEqualAsync, relativeWithinAsync, relativeLinkAwareAsync, canonicalPath, samePathSync,
} from './paths.mjs';
import { appendEvent } from './journal.mjs';
import { scan } from './scan.mjs';
import { analyze, uniqueWork, safeToDelete, contentAtRisk } from './analyze.mjs';

const LOCK_PREFIX = 'holt:';

// Counter for scratch-index filenames. holt is invoked from agent hooks, and running multiple
// agents at once in the SAME worktree is the normal case, not an edge case — so a scratch index
// name must be unique PER INVOCATION, not just per worktree. A name of the form
// `.git-holt-rescue-index` (no pid, no per-call component) is shared by every concurrent
// `holt rescue`/`holt discard` on that worktree: two processes then read-tree/add/write-tree
// against the SAME file, and one process's write-tree can capture a mix of both processes'
// staged content, or capture NEITHER because a concurrent `read-tree` reset the index between
// this call's `add` and its own `write-tree`. Reproduced live: 16-20 concurrent `discard()` calls
// against one worktree, each discarding a distinct file, produced refs holding up to 10 other
// calls' files apiece plus several outright "capture is INCOMPLETE" failures — proven with
// `git ls-tree` on the resulting refs (see test/e2e/actions.test.mjs, "CONCURRENT CAPTURES").
// `process.pid` alone is not enough either: a single process can run more than one capture
// concurrently (e.g. `auto()` over several workstreams), so a same-process, same-pid counter is
// added on top, mirroring the pattern `worktreeSnapshot` in git.mjs already uses for exactly
// this reason.
// AND THE SCRATCH INDEX MUST LIVE OUTSIDE THE WORKTREE IT PHOTOGRAPHS. Per-invocation names
// fixed the index-sharing corruption; placing them inside the worktree left two failure modes,
// both caught by CI's cross-platform matrix running the concurrent-rescue test:
//   1. THE ENUMERATION RACE. rescue A's `git add --all` walks the worktree and lstats rescue B's
//      live `.lock` file; B finishes and removes it between readdir and lstat; A's add dies with
//      "fatal: unable to stat '.git-holt-rescue-index-<pid>-<n>.lock': No such file or directory"
//      and the capture reports INCOMPLETE for files it never reached. Intermittent by nature —
//      reproduced locally at roughly 1 in 12 runs, and on every CI OS.
//   2. SELF-POLLUTION. Even when the race does not fire, each capture photographs its SIBLINGS'
//      scratch indices as if they were the worktree's content, so a rescue ref could contain
//      other rescues' temp bytes.
// A scratch index has no reason to be under the tree at all — GIT_INDEX_FILE accepts any path,
// and git writes its transient `.lock` beside it. HOLT_TMPDIR is honoured the same way every
// other holt scratch file honours it.
let scratchCounter = 0;
function scratchIndexPath(wsPath, label) {
  const dir = process.env.HOLT_TMPDIR || process.env.TMPDIR || os.tmpdir();
  // The worktree path is hashed into the name only to keep names collision-free across repos.
  const wsKey = Buffer.from(wsPath).toString('hex').slice(-16);
  return path.join(dir, `holt-${label}-index-${wsKey}-${process.pid}-${scratchCounter++}`);
}

/**
 * A journal write failing must not look like SILENCE to whoever called this.
 *
 * appendEvent() already refuses to throw and already writes a loud line to stderr on failure —
 * but every call site here used to do `await appendEvent(...)` and discard the {ok, error} it
 * returned. That is invisible to exactly the callers who most need it: an MCP client and a
 * `--json` script never see this process's stderr, only the result object. So a disk-full or
 * read-only journal directory produced a JSON response indistinguishable from "captured AND
 * recorded" — the action succeeded, the audit line describing it did not, and nothing in the
 * response said so. This collects what stderr already said INTO the result, which is the one
 * channel every caller (human terminal, `--json`, MCP) actually reads.
 *
 * The action itself is never affected: this only ever runs after the mutation it is recording,
 * and a failure here never becomes a reason to undo, retry, or refuse the mutation.
 */
async function journal(cwd, event, failures) {
  const r = await appendEvent(cwd, event);
  if (!r.ok) {
    failures.push({
      action: event.action, id: event.id ?? null, path: event.path ?? null, ref: event.ref ?? null,
      error: r.error,
    });
  }
  return r;
}

/**
 * Attach journal-write failures to a result, loudly and by name, without touching anything else
 * the result already says. Empty when nothing failed, so the common case is byte-identical to
 * before this existed.
 */
function withJournalWarning(result, failures) {
  if (!failures.length) return result;
  return {
    ...result,
    journalFailures: failures,
    journalWarning: `${failures.length} journal write(s) FAILED — the action(s) above still `
      + 'happened; only the audit-trail record of them did not. holt roi/journal will NOT show '
      + 'these. Recover manually using the id/path/ref named in journalFailures.',
  };
}

/** One scan shared by every action, so protect/rescue/clean cannot disagree with each other. */
async function assess(cwd, opts = {}) {
  const disc = await discover(cwd, opts);
  if (!disc.root) throw repoAbsenceError(disc, cwd);
  const scanned = await scan(disc, opts);
  const report = await analyze(scanned, opts);
  return { disc, scanned, report };
}

/**
 * Clean's authority must ignore worktrees it already quarantined.
 *
 * A quarantined worktree remains registered and byte-for-byte intact on purpose. If it were left
 * in the sibling-identity set, three mutually redundant active worktrees would all appear safe:
 * after moving the first two, the quarantine copies would keep authorising the third. Filtering
 * only Holt's exact quarantine marker preserves the original invariant — the active set drains to
 * one durable survivor — without hiding those recovery copies from ordinary status/risk scans.
 */
async function assessForClean(cwd, opts = {}) {
  const disc = await discover(cwd, opts);
  if (!disc.root) throw repoAbsenceError(disc, cwd);
  const quarantined = disc.workstreams.filter(
    (w) => w.quarantined === true || w.quarantineTransition === true);
  const activeDisc = {
    ...disc,
    workstreams: disc.workstreams.filter(
      (w) => w.quarantined !== true && w.quarantineTransition !== true),
  };
  const scanned = await scan(activeDisc, opts);
  const report = await analyze(scanned, opts);
  return { disc: activeDisc, scanned, report, quarantined };
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

  const journalFailures = [];
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
    const reason = `${LOCK_PREFIX} holds work with no durable copy elsewhere`
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
    if (!dryRun) await journal(cwd, { action: 'protect', id: s.id, path: ws.path, reason }, journalFailures);
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
    if (st.locked && isHoltCleanQuarantineLock(st.reason)) continue;
    if (!st.locked || !isHoltLock(st.reason)) continue;

    if (!dryRun) {
      const r = await git(['worktree', 'unlock', ws.path], { cwd, allowMutation: true });
      if (r.code !== 0) {
        actions.push({ id: s.id, path: ws.path, action: 'release-failed', reason: r.stderr.trim() });
        continue;
      }
      // Journalled as an unprotect, flagged `stale` so an audit can tell an automatic
      // reconciliation apart from a human deliberately dropping a guard.
      await journal(cwd, {
        action: 'unprotect', id: s.id, path: ws.path,
        reason: st.reason, stale: true, forced: false, foreignLock: false,
      }, journalFailures);
    }
    released.push({ id: s.id, path: ws.path, was: st.reason });
    actions.push({ id: s.id, path: ws.path, action: dryRun ? 'would-release' : 'released', reason: st.reason });
  }

  return withJournalWarning({
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
  }, journalFailures);
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
 * reason, actor), so one reader parses all of them. `--force`, which releases a lock holt did
 * NOT place, is recorded distinctly, because overriding another tool's or another human's
 * protection is a different act from releasing your own.
 */
export async function unprotect(cwd, { id = null, force = false, dryRun = false, reason: overrideReason = null, ...opts } = {}) {
  const { report } = await assess(cwd, opts);
  const targets = report.graph.nodes.filter((n) => (id ? n.id === id : true));

  const journalFailures = [];
  const actions = [];
  for (const ws of targets) {
    if (!ws.path) continue;
    const st = await lockState(ws.path, cwd);
    if (!st.locked) continue;
    // Locks placed by something else are left alone: holt must not quietly disarm a protection
    // a human or another tool put there deliberately.
    const foreign = !isHoltLock(st.reason);
    if (foreign && !force) {
      // The refusal NAMES the escape hatch. A guard with no documented way through it is not
      // conservative, it is unused — the whole reason `--force` exists is so this line never
      // leaves someone stuck holding a worktree they legitimately want to release.
      actions.push({
        id: ws.id, action: 'skipped-foreign-lock', reason: st.reason,
        hint: `this lock was not placed by holt; run 'holt unprotect ${ws.id} --force --reason "<why>"' `
          + `(or add --yes to confirm without a written reason) to override it`,
      });
      continue;
    }
    // A dry run answers "what would this release, and is any of it somebody else's lock" without
    // releasing anything. The CLI needs that answer BEFORE it can decide whether `--force` is a
    // real override that must be justified or a no-op flag on holt's own locks — demanding
    // justification for the second case refuses a legitimate release for a reason that is not
    // true of it, which is how a guard stops being used at all.
    if (dryRun) {
      actions.push({ id: ws.id, action: 'would-unlock', reason: st.reason, foreignLock: foreign });
      continue;
    }
    const r = await git(['worktree', 'unlock', ws.path], { cwd, allowMutation: true });
    actions.push({ id: ws.id, action: r.code === 0 ? 'unlocked' : 'failed', reason: r.stderr.trim() || st.reason });
    if (r.code === 0) {
      // `forced` and `foreignLock` are recorded because overriding a protection somebody else
      // placed is a materially different act from releasing holt's own, and a compliance review
      // that cannot tell them apart is not a review. `overrideReason` carries the human's own
      // words for WHY, when the CLI collected one — the fact of an override is not the same
      // record as the justification for it.
      await journal(cwd, {
        action: 'unprotect', id: ws.id, path: ws.path,
        branch: ws.branch ?? null, head: ws.head ?? null,
        reason: st.reason, forced: !!force, foreignLock: foreign,
        overrideReason: (foreign && overrideReason) ? String(overrideReason).trim() : null,
        evidence: foreign
          ? 'released a lock holt did NOT place (--force) — a protection set by another tool or person was overridden'
          : 'released a lock holt placed to protect work found nowhere else',
      }, journalFailures);
    }
  }
  return withJournalWarning(
    {
      actions,
      dryRun,
      unlocked: actions.filter((a) => a.action === 'unlocked').length,
      foreignLocks: actions.filter((a) => a.foreignLock || a.action === 'skipped-foreign-lock').length,
    },
    journalFailures,
  );
}

/** Read a worktree's lock state from the porcelain listing. */
async function lockState(wtPath, cwd) {
  const r = await git(['worktree', 'list', '--porcelain'], { cwd });
  if (r.code !== 0) return { locked: false, reason: '' };
  // Canonicalised, not path.resolve'd. git reports /private/var/... on macOS while the caller
  // holds /var/...; a raw comparison finds no worktree, lockState reports "not locked", and
  // protect/unprotect/clean silently act as though a lock that exists is not there.
  const target = await canonicalPath(wtPath);
  /** @type {string | null} */
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
 *
 * FOUND BY ATTACKING IT AGAIN: the leading-dot strip left the SYMMETRIC rule unhandled — git
 * also refuses a refname whose final component ENDS in a dot (`git check-ref-format
 * refs/holt/rescue/release-1.0.` fails: "refusing to update ref with bad name"). A worktree
 * named `release-1.0.`, `v2.`, or anything ending in `.` is entirely ordinary on Linux and
 * macOS, and it drove `rescue` into exactly the post-capture update-ref failure this function
 * exists to prevent: the capture commit was built, then thrown away as a dangling object, and
 * the one tool holt offers to preserve work-that-exists-nowhere-else refused with a raw git
 * bad-name error. So trailing dots are stripped per component too (before the `.lock` rewrite,
 * so `foo.lock.` collapses to `foo_lock` rather than re-growing a `.lock` suffix). The class is
 * "a refname component that violates git's grammar in a way the sanitizer does not model"; the
 * structural close is to neutralise BOTH ends of every component, then let the empty-component
 * filter and the `unnamed` fallback guarantee a non-empty, git-valid result for any input.
 */
export function refSafeId(id) {
  const cleaned = String(id).replace(/[^A-Za-z0-9._/-]/g, '_').replace(/\.\.+/g, '.');
  const parts = cleaned.split('/')
    .map((p2) => p2
      .replace(/^\.+/, '')            // no component may BEGIN with a dot
      .replace(/\.+$/, '')            // ...nor END with one — git refuses a refname ending in `.`
      .replace(/\.lock$/i, '_lock'))  // ...nor end in `.lock`
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
/**
 * Give a finished capture a durable ref, without ever destroying another one.
 *
 * THE WRITE IS THE PROOF. `git update-ref <ref> <new> ""` is a compare-and-swap against "must not
 * exist" which git evaluates WHILE HOLDING THE REF LOCK. Exit 0 means the name was free at the
 * instant it was taken. Nothing read afterwards can strengthen that: a later unlocked read reports
 * a LATER state, so it can manufacture a false failure while being unable to detect a real one.
 *
 * This replaces a read of whether the name was free followed by an unconditional write. The whole
 * interval between the two was unprotected, and it was not theoretical — 8 agents x 3 trials on one
 * worktree lost 14 of 48 captures, while all 48 reported `verified: true`.
 *
 * `""`, NOT FORTY ZEROS. Measured on git 2.55.0: the all-zero oldvalue is rejected outright in a
 * SHA-256 repository ("not a valid old SHA1") and the ref is never created — so the obvious
 * spelling would refuse 100% of rescues in a repository format that works today. The empty string
 * is the documented must-not-exist form and returns 0 on both object formats.
 *
 * NO ERROR-STRING TABLE. After a failed CAS the state read is exact — the ref either exists (the
 * name is genuinely taken) or it does not (transient lock contention) — and that is version-,
 * backend- and locale-proof. Matching git's prose is not: git wraps EVERY lockfile errno in the
 * same `Unable to create '…lock'` sentence, so a regex table reports a full disk as contention and
 * spins on it.
 *
 * NEVER THROWS. A ref failure AFTER the commit exists used to throw a raw git error and orphan a
 * finished capture. Every failure path returns the commit oid, because a capture with no ref is
 * still recoverable BY OID until gc — and this writes a fallback ref rather than telling the user to.
 *
 * @returns {Promise<{ok:true, ref:string, commit:string, idempotent:boolean}
 *                 |{ok:false, reason:string, commit:string, fallbackRef:string|null, gitError:string}>}
 */
async function captureRef(cwd, { baseRef, commit, tree, kind, id }) {
  const MAX_RETRIES = 24;
  let ref = baseRef;
  let lastErr = '';
  for (let n = 1; n < 1000; n++) {
    for (let attempt = 0; ; attempt++) {
      const w = await git(['update-ref', '--create-reflog', ref, commit, ''],
        { cwd, allowMutation: true }).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
      if (w.code === 0) return { ok: true, ref, commit, idempotent: false };
      lastErr = String(w.stderr ?? '').trim();

      const cur = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd })
        .catch(() => ({ code: 1, stdout: '' }));
      if (cur.code === 0) break;                    // TAKEN — fall through to the tree comparison
      if (attempt >= MAX_RETRIES) {
        // ABSENT and still failing, so this is not contention. A D/F conflict is the one shape
        // worth one more try: `refs/holt/rescue/p0` as a FILE blocks every name under `p0/`, so
        // the counter can never escape it. Flattening the id gives a valid sibling in one step.
        const flat = String(id).replace(/[/\\]/g, '_');
        if (flat !== String(id)) {
          const alt = baseRef.replace(/[^/]*$/, flat);
          const w2 = await git(['update-ref', '--create-reflog', alt, commit, ''],
            { cwd, allowMutation: true }).catch(() => ({ code: 1 }));
          if (w2.code === 0) return { ok: true, ref: alt, commit, idempotent: false };
        }
        return { ok: false, reason: 'ref-write-failed', commit, fallbackRef: null, gitError: lastErr };
      }
      await new Promise((r) => { setTimeout(r, 2 + Math.random() * 25); });
    }

    // TAKEN. Compare TREES, not commits. `commit-tree` embeds the wall clock, so two captures of
    // byte-identical content ALWAYS have different commit oids — which is why the previous
    // `oid === commit` idempotence branch was dead in practice (measured: 3 serial rescues of
    // unchanged content produced 3 refs and 1 tree). The tree IS the content, so comparing it makes
    // the idempotence this function's contract already claimed actually true.
    const held = (await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd })).stdout.trim();
    const ht = await git(['rev-parse', '--verify', '--quiet', `${held}^{tree}`], { cwd })
      .catch(() => ({ code: 1, stdout: '' }));
    if (ht.code === 0 && ht.stdout.trim() === tree) {
      return { ok: true, ref, commit: held, idempotent: true };
    }
    ref = `${baseRef}-${n + 1}`;
  }
  return { ok: false, reason: 'name-space-exhausted', commit, fallbackRef: null, gitError: lastErr };
}

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
  // A NAMED path whose comparison semantics are untrusted can still be rescued: the exact-capture
  // path below reads its filesystem bytes without Git conversion and independently verifies the
  // resulting blob. A failed whole-layer instrument is different because it may have hidden paths
  // Holt cannot name; that remains a hard refusal. This distinction keeps gate conservative while
  // letting rescue remediate the very uncertainty gate reports.
  const files = [...new Set([...risk.files, ...risk.unmeasured])].sort();
  const committedDelta = risk.committedCount;

  // AN INSTRUMENT THAT FAILED IS NOT AN EMPTY WORKTREE. Both look like zero paths from here, and
  // only one of them makes deletion safe — so a probe failure must produce a NAMED refusal with
  // a non-zero exit, never the cheerful nothing-to-rescue that licenses the deletion.
  if (risk.instrumentBlind.length) {
    return {
      ok: false,
      id,
      error: `holt could not enumerate this worktree's content: ${risk.instrumentBlind.join('; ')}`,
      blind: risk.instrumentBlind,
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

  // Build a tree from the worktree's CURRENT state in a scratch index. UNIQUE per invocation —
  // see the comment on scratchIndexPath() above for why a fixed name here is a data-loss bug,
  // not a style nit.
  //
  // `git add` is deliberately absent. It enters the check-in conversion pipeline: repository
  // clean/process commands can execute, and built-in eol/ident/encoding rules can rewrite the
  // sole-copy bytes a rescue promises to preserve. The exact path below seeds the scratch index
  // from the real index tree, removes each at-risk selection, hashes filesystem leaves with
  // --no-filters, and writes explicit mode/object/path tuples through update-index --cacheinfo.
  const tmpIndex = scratchIndexPath(ws.path, 'rescue');
  // `git write-tree` normally refreshes the repository's live index and can therefore contend on
  // its shared `.lock` file when two agents rescue the same worktree at once. Snapshot the index
  // file first: Git writes indexes by atomic rename, so this copy observes either the old or the
  // new complete index, never a half-written buffer; every subsequent tree operation is against
  // the per-invocation copy. This preserves staged additions/deletions without serialising agent
  // hooks on a process-global lock.
  const seedIndex = scratchIndexPath(ws.path, 'rescue-seed');
  // holt authors this capture; a repo with no configured identity must still be rescuable.
  const env = { GIT_INDEX_FILE: tmpIndex, ...(await authorEnv(ws.path)) };
  try {
    // The real index already carries staged additions, deletions, and both sides of renames. Its
    // tree is object-only evidence and needs no working-tree conversion. Starting from HEAD would
    // resurrect a staged rename's source unless Holt reimplemented the entire index delta.
    const indexPathR = await gitOk(['rev-parse', '--git-path', 'index'], {
      cwd: ws.path, allowMutation: true,
    });
    const namedIndex = indexPathR.stdout.trim();
    const liveIndex = path.isAbsolute(namedIndex)
      ? namedIndex : path.resolve(ws.path, namedIndex);
    try {
      await fs.copyFile(liveIndex, seedIndex);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      // A newly-created worktree can have no index yet. There are no staged entries to preserve,
      // so an explicit HEAD seed is the exact empty-index equivalent.
      await gitOk(['read-tree', 'HEAD'], {
        cwd: ws.path, env: { ...env, GIT_INDEX_FILE: seedIndex }, allowMutation: true,
      });
    }
    const indexTreeR = await gitOk(['write-tree'], {
      cwd: ws.path, env: { ...env, GIT_INDEX_FILE: seedIndex }, allowMutation: true,
    });
    await gitOk(['read-tree', indexTreeR.stdout.trim()], { cwd: ws.path, env, allowMutation: true });

    const selected = [...new Set(files.map((file) => file.replace(/\/+$/, '')).filter(Boolean))].sort();
    /** @type {any[]} */
    let sourceLeaves;
    try {
      const rawLeaves = await selectedFilesystemManifest(ws.path, selected);

      const seeded = await indexEntriesFor(ws.path, selected, env);
      for (const entry of seeded) {
        await gitOk(['update-index', '--force-remove', '--', entry.path],
          { cwd: ws.path, env, allowMutation: true });
      }
      // Rescue and discard share the same raw-object capture primitive and therefore the same
      // process budget. A large ignored/vendor tree is not unusual rescue input; launching one
      // `git hash-object` per leaf at once can exhaust descriptors/process slots before Holt has
      // made anything durable. Keep the bound identical to discard so neither recovery route
      // turns corpus size into a false refusal.
      sourceLeaves = await pmap(
        rawLeaves,
        (leaf) => hashRawManifestLeaf(ws.path, ws.path, leaf),
        8,
      );
      sourceLeaves.sort((a, b) => a.path.localeCompare(b.path));
      for (const leaf of sourceLeaves) {
        await gitOk(['update-index', '--add', '--cacheinfo', `${leaf.mode},${leaf.oid},${leaf.path}`],
          { cwd: ws.path, env, allowMutation: true });
      }
      const indexed = await indexEntriesFor(ws.path, selected, env);
      if (!sameEntryTuples(sourceLeaves, indexed)) {
        throw new Error('scratch index does not contain the exact raw mode/object/path tuples');
      }
    } catch (error) {
      return {
        ok: false,
        id,
        error: `rescue is INCOMPLETE — exact raw capture failed: ${error?.message ?? error}`,
        missing: selected,
        note: 'the worktree has NOT been released and nothing was deleted. Holt never executes repository '
          + 'content filters while rescuing. A submodule, embedded Git repository, unsupported '
          + 'filesystem node, or concurrently changing path must be handled at its own boundary.',
      };
    }

    const treeR = await gitOk(['write-tree'], { cwd: ws.path, env, allowMutation: true });
    const tree = treeR.stdout.trim();

    const msg = `holt rescue: ${id}\n\n`
      + `Captured ${files.length} at-risk or named-unmeasured path(s) `
      + `(${risk.layers.uncommitted.length} modified, ${risk.layers.untracked.length} untracked, `
      + `${risk.layers.ignored.length} gitignored, ${risk.unmeasured.length} unmeasured) `
      + `and the worktree's committed state.\n`
      + `Restore with:  git checkout <this-ref> -- .   (see 'holt rescued')\n`;
    const commitR = await gitOk(
      ['commit-tree', tree, '-p', ws.head, '-m', msg],
      { cwd: ws.path, env, allowMutation: true },
    );
    // `let`: captureRef may hand back the commit ALREADY held by the ref when an identical capture
    // is reused, and reporting the one we built rather than the one that is reachable is the same
    // class of lie this whole change exists to remove.
    let commit = commitR.stdout.trim();

    // Verification is identity and bytes, not mere path containment. The old check was satisfied
    // by a clean-filter replacement blob because the requested pathname still existed in the
    // tree. Compare exact tuples, then independently digest every captured blob.
    try {
      let capturedEntries = await treeEntriesFor(ws.path, commit, selected);
      if (!sameEntryTuples(sourceLeaves, capturedEntries)) {
        throw new Error('capture commit does not contain the exact raw mode/object/path tuples');
      }
      capturedEntries = await hydrateBlobEntries(ws.path, capturedEntries);
      const expectedByPath = new Map(sourceLeaves.map((entry) => [entry.path, entry]));
      for (const entry of capturedEntries) {
        const expected = expectedByPath.get(entry.path);
        if (!expected || !Buffer.isBuffer(entry.content)) {
          throw new Error(`capture blob for '${entry.path}' is unreadable`);
        }
        const digest = createHash('sha256').update(entry.content).digest('hex');
        if (digest !== expected.sha256 || entry.content.length !== expected.size) {
          throw new Error(`capture blob for '${entry.path}' differs from the filesystem bytes`);
        }
      }
      const finalLeaves = await selectedFilesystemManifest(ws.path, selected);
      if (!sameRawLeafTuples(sourceLeaves, finalLeaves)) {
        throw new Error('selected filesystem content changed while the capture was being verified');
      }
    } catch (error) {
      return {
        ok: false,
        id,
        commit,
        error: `rescue is INCOMPLETE — exact verification failed: ${error?.message ?? error}`,
        missing: selected,
        note: 'the worktree has NOT been released and nothing was deleted. The unreferenced commit oid is '
          + 'reported for forensics, but Holt will not call an unverified capture recoverable.',
      };
    }

    // Declared before the capture because the failure path below reports through it too: a rescue
    // that could not write its ref still has to say so, and still has to carry any journal warning.
    const journalFailures = [];

    // THE WRITE IS THE PROOF — see captureRef. This replaces a READ of whether the name was free
    // followed by an unconditional write, which left the whole interval between them unprotected:
    // measured, 14 of 48 concurrent captures were silently overwritten while all 48 reported
    // verified. `ref` and `commit` are whatever actually landed, which is not always what we built.
    const alloc = await captureRef(ws.path, { baseRef, commit, tree, kind: 'rescue', id });
    if (!alloc.ok) {
      return withJournalWarning({
        ok: false, id, commit, ref: alloc.fallbackRef,
        capturedFiles: files.length,
        verified: false,
        reason: alloc.reason,
        gitError: alloc.gitError,
        note: alloc.fallbackRef
          ? `the capture SUCCEEDED and is held by ${alloc.fallbackRef}, but its intended name could `
            + `not be written. Nothing was released and nothing was deleted.`
          : `the capture succeeded as commit ${commit} but NO ref could be written, so it is `
            + `reachable only by that oid until gc. Nothing was released and nothing was deleted.`,
      }, journalFailures);
    }
    ref = alloc.ref;
    commit = alloc.commit;

    /** @type {boolean | null} */
    let released = null;
    if (release) {
      const un = await unprotect(cwd, { id, ...opts });
      released = un.unlocked > 0;
      // unprotect() surfaces its OWN journal failures on its own result; fold them into this
      // call's report too, or a --release rescue could swallow a released-but-unrecorded lock.
      if (un.journalFailures?.length) journalFailures.push(...un.journalFailures);
    }

    // Record WHICH worktree this was, not just its (reusable) basename: path, branch and head
    // make two rescues under a recycled id distinguishable in the audit trail. Without them the
    // journal printed two identical lines for two different captures — live-reproduced.
    await journal(cwd, {
      action: 'rescue', id, ref, commit,
      path: ws.path, branch: ws.branch ?? null, head: ws.head ?? null,
      capturedFiles: files.length, released: release,
    }, journalFailures);
    // `verified` IS DERIVED, NOT ASSERTED. This was the literal `true`, computed from nothing and
    // printed even for the 14 of 48 concurrent captures whose ref had been overwritten. It now
    // means one checkable thing: the ref resolves, right now, to the commit being reported.
    //
    // The CAS above already proved the write landed; this re-read is what makes the WORD honest
    // rather than a restatement of the same fact — if anything moved the ref between then and now,
    // the caller is told, instead of being handed a sentence it cannot check.
    const readback = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: ws.path })
      .catch(() => ({ code: 1, stdout: '' }));
    const verified = readback.code === 0 && readback.stdout.trim() === commit;

    return withJournalWarning({
      ok: true, id, ref, commit,
      capturedFiles: files.length,
      verified,
      released,
      // THE IMMUTABLE HANDLE COMES FIRST. A ref is the one part of a capture that can still move;
      // the commit oid cannot. `git checkout <ref> -- .` was also a command holt's own guard
      // refuses whenever the worktree is dirty — which is exactly the state a user reaching for
      // this is in — and it copies bytes onto themselves while leaving the commit reachable from
      // nothing. `git worktree add` gives the content back somewhere safe without touching the
      // tree that is already in trouble.
      restore: `git worktree add /tmp/holt-restore-${id} ${commit}`,
      restoreInPlace: `git checkout ${commit} -- .`,
      inspect: `git show ${commit} --stat`,
      note: verified
        ? (released
          ? 'work is captured and verified; protection released, the worktree is now disposable'
          : 'work is captured and verified. Pass --release to also unlock the worktree.')
        // Says the true thing rather than the reassuring one. The capture exists — the commit is
        // named above and `inspect` reads it — but something moved the ref, so the NAME is not a
        // handle to trust. Nothing is released on this path.
        : `work is captured as commit ${commit}, but ${ref} no longer resolves to it. `
          + 'Use the commit oid, not the ref.',
    }, journalFailures);
  } finally {
    await fs.rm(tmpIndex, { force: true }).catch(() => {});
    await fs.rm(seedIndex, { force: true }).catch(() => {});
  }
}


/* ================================================================= AUTO ==== */

/**
 * The autopilot. Everything holt can do without a human, and nothing it cannot.
 *
 * THE LINE, AND WHY IT IS WHERE IT IS. holt already acts — it locks, captures, releases and
 * removes. The question is which of those it may do UNPROMPTED, and the answer is not a
 * preference, it follows from one asymmetry:
 *
 *   LOSSLESS actions are safe to automate because being wrong is recoverable. A lock placed on a
 *   worktree that did not need one costs nothing and is released by the next run. A capture is
 *   purely additive. Reconciliation only ever removes holt's own lock, and only where the verdict
 *   is measured. If holt is wrong about any of these, nothing is destroyed.
 *
 *   DESTRUCTIVE actions must not be automated, however confident the verdict, because being wrong
 *   is final. `clean --apply` is gated on "provably disposable" — and holt was wrong about 8 of 10
 *   worktrees on its own repository the day this was written. An automatic sweep is exactly as
 *   safe as the verdict, and the verdict is the thing that keeps turning out to be wrong. A tool
 *   that deletes on its own is one bad verdict away from being the disaster it exists to prevent.
 *
 * So: holt does the lossless half by itself, every session, with no command typed — and hands the
 * destructive half to a human or an agent WITH THE EVIDENCE AND THE EXACT COMMAND. That is not
 * timidity, it is the measured design. This project's own A/B found that warning alone freezes an
 * agent at 0% cleanup while giving it a PERMITTED ACTION reached 73%: the win came from handing
 * over a concrete, safe move, not from acting unilaterally and not from nagging.
 */
export async function auto(cwd, opts = {}) {
  const { report } = await assess(cwd, opts);

  // The lossless half, done. protect() both locks what is at risk and releases holt's own locks
  // whose justification has expired, so one call converges the lock set in both directions.
  const p = await protect(cwd, opts);

  const disposable = report.safe.filter((s) => s.safe);
  const unknown = report.safe.filter((s) => s.confidence === 'unknown');
  const atRisk = report.unique.filter((u) => u.verdict === 'unique-work-uncommitted');

  return {
    did: {
      protected: p.protected,
      released: p.released ?? 0,
      note: 'lossless only — a lock is reversible and a release only ever undoes holt\'s own lock',
    },
    needsYou: {
      disposable: disposable.length,
      ids: disposable.map((s) => s.id),
      command: disposable.length ? 'holt clean --apply' : null,
      why: disposable.length
        ? `${disposable.length} workstream(s) hold nothing base lacks. holt will not remove them by `
          + 'itself: deleting is final, and a verdict is only as good as the scan behind it.'
        : null,
    },
    // THE NOTE IS COMPUTED FROM WHAT ACTUALLY HAPPENED, not from the fact that anything was at
    // risk. It used to read "locked — git itself now refuses to remove these" whenever atRisk was
    // non-empty, two fields below `protected: 0` in the same JSON object. Both cannot be true, and
    // `git worktree list --porcelain` shows which one is not.
    //
    // In a single-worktree repository this is not a race, it is permanent: `git worktree lock`
    // refuses the main working tree outright ("fatal: The main working tree cannot be locked or
    // unlocked"), so `holt auto` told every solo user their at-risk work was protected by git when
    // git had declined and holt knew it. A false all-clear about protection is worse than no
    // protection, because it is acted on.
    atRisk: (() => {
      if (!atRisk.length) return { count: 0, ids: [], note: null };
      const lockedNow = (p.actions ?? []).filter((a) => a.action === 'locked' || a.action === 'already-locked');
      const unlockable = (p.actions ?? []).filter((a) => a.action === 'failed'
        && /main working tree cannot be locked/i.test(a.reason ?? ''));
      const parts = [];
      if (lockedNow.length) parts.push(`${lockedNow.length} locked — git itself now refuses to remove those`);
      if (unlockable.length) {
        parts.push(`${unlockable.length} could NOT be locked: git refuses to lock a main working tree. `
          + 'holt\'s own guard still refuses destructive commands against it, but git will not stop `rm`. '
          + 'Commit, or `holt rescue <id>`, to make this work durable.');
      }
      const otherFailures = (p.actions ?? []).filter((a) => a.action === 'failed').length - unlockable.length;
      if (otherFailures > 0) parts.push(`${otherFailures} lock attempt(s) FAILED — run \`holt protect\` to see why`);
      return {
        count: atRisk.length,
        ids: atRisk.map((u) => u.id),
        locked: lockedNow.length,
        note: parts.length ? parts.join('; ') : 'at risk, and NOT locked — run `holt protect` to see why',
      };
    })(),
    unknown: unknown.map((u) => ({ id: u.id, why: u.reasons[0] })),
  };
}

/* ============================================================== DISCARD ==== */

const isSelectedPath = (candidate, selected) => candidate === selected
  || candidate.startsWith(`${selected}/`);

function parseTreeRecords(raw, source) {
  const out = [];
  for (const record of raw.split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t');
    const meta = tab < 0 ? null : /^(\d+) ([^ ]+) ([0-9a-f]+)$/.exec(record.slice(0, tab));
    if (!meta) throw new Error(`could not parse ${source} tree entry`);
    out.push({ mode: meta[1], type: meta[2], oid: meta[3], path: record.slice(tab + 1) });
  }
  return out;
}

async function treeEntriesFor(cwd, treeish, selectedPaths) {
  const byPath = new Map();
  for (const selected of selectedPaths) {
    const r = await git(
      ['ls-tree', '-r', '-z', '--full-tree', treeish, '--', `:(literal)${selected}`],
      { cwd },
    );
    if (r.code !== 0) throw new Error(r.stderr.trim() || `git ls-tree ${treeish} failed`);
    for (const entry of parseTreeRecords(r.stdout, treeish)) {
      if (!isSelectedPath(entry.path, selected)) {
        throw new Error(`tree lookup for '${selected}' returned unrelated path '${entry.path}'`);
      }
      byPath.set(entry.path, entry);
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

async function indexEntriesFor(cwd, selectedPaths, env) {
  const byPath = new Map();
  for (const selected of selectedPaths) {
    const r = await git(
      ['ls-files', '--stage', '-z', '--', `:(literal)${selected}`],
      { cwd, env },
    );
    if (r.code !== 0) throw new Error(r.stderr.trim() || 'git ls-files --stage failed');
    for (const record of r.stdout.split('\0').filter(Boolean)) {
      const m = /^(\d+) ([0-9a-f]+) ([0-3])\t([\s\S]*)$/.exec(record);
      if (!m) throw new Error(`could not parse scratch-index entry for '${selected}'`);
      const entry = { mode: m[1], oid: m[2], stage: Number(m[3]), path: m[4] };
      if (!isSelectedPath(entry.path, selected)) {
        throw new Error(`index lookup for '${selected}' returned unrelated path '${entry.path}'`);
      }
      if (entry.stage !== 0) throw new Error(`'${entry.path}' has an unmerged index entry`);
      byPath.set(entry.path, entry);
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

const entryTuple = (entry) => `${entry.mode} ${entry.oid}\t${entry.path}`;

function sameEntryTuples(indexEntries, treeEntries) {
  const left = indexEntries.map(entryTuple);
  const right = treeEntries.map(entryTuple);
  return left.length === right.length && left.every((v, i) => v === right[i]);
}

async function directoryIdentity(dir) {
  const st = await fs.lstat(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new Error(`parent '${dir}' is not a real directory`);
  }
  return {
    path: dir,
    canonical: await canonicalPath(dir),
    dev: String(st.dev),
    ino: String(st.ino),
  };
}

async function sameDirectoryIdentity(identity) {
  try {
    const now = await directoryIdentity(identity.path);
    return samePathSync(now.canonical, identity.canonical)
      && now.dev === identity.dev && now.ino === identity.ino;
  } catch {
    return false;
  }
}

async function openDirectoryAnchor(identity) {
  if (!(await sameDirectoryIdentity(identity))) {
    throw new Error(`parent '${identity.path}' changed before quarantine`);
  }
  // Linux exposes an open directory descriptor as a traversable path. Keeping that descriptor
  // open turns subsequent mkdir/rename/restore calls into operations relative to the directory
  // inode we measured, even if an adversary renames the path and replaces it with a symlink.
  // Linux's /proc/self/fd/<n> is a traversable directory anchor. macOS and the BSDs expose
  // /dev/fd, but Node's pathname stat/open semantics do not make that pseudo-path reliably
  // traversable across the hosted runners (the descriptor itself is still valid). Falling back
  // to the identity-checked path on those platforms keeps the operation usable; the immediate
  // identity check below remains the fail-closed boundary, and Linux retains the stronger
  // descriptor-anchored rename where the kernel contract is available.
  const fdRoot = process.platform === 'linux' ? '/proc/self/fd' : null;
  if (!fdRoot) return { handle: null, path: identity.path };
  const handle = await fs.open(identity.path, 'r');
  try {
    const st = await handle.stat();
    if (String(st.dev) !== identity.dev || String(st.ino) !== identity.ino || !st.isDirectory()) {
      throw new Error(`parent '${identity.path}' changed while its directory handle was opened`);
    }
    const anchored = `${fdRoot}/${handle.fd}`;
    const anchoredStat = await fs.stat(anchored);
    if (String(anchoredStat.dev) !== identity.dev || String(anchoredStat.ino) !== identity.ino
      || !anchoredStat.isDirectory()) {
      throw new Error(`could not anchor '${identity.path}' by descriptor`);
    }
    return { handle, path: anchored };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

async function validateCaptureNode(abs, logicalPath) {
  const st = await fs.lstat(abs);
  if (st.isSymbolicLink() || st.isFile()) return;
  if (!st.isDirectory()) {
    throw new Error(`'${logicalPath}' has unsupported filesystem type; only files, directories, and symlinks can be captured`);
  }
  const names = (await fs.readdir(abs)).sort();
  // Git stores leaves, not empty directory entries. An empty directory therefore contains no
  // bytes, link target, mode-bearing file, or special node for a capture ref to preserve. Refusing
  // the whole discard because ONE nested package directory is empty made the documented recovery
  // route unusable on ordinary generated trees (npm leaves these behind in real installs). The
  // quarantine below still proves the directory is empty and removes it atomically; the result
  // explicitly names empty directory paths as non-Git-representable instead of pretending the ref
  // can recreate them.
  for (const name of names) {
    const childLogical = `${logicalPath}/${name}`;
    if (name === '.git') {
      throw new Error(`'${childLogical}' is an embedded Git boundary; run Holt inside that repository first`);
    }
    await validateCaptureNode(path.join(abs, name), childLogical);
  }
}

async function selectedFilesystemManifest(wsPath, selected) {
  const byPath = new Map();
  for (const logicalPath of selected) {
    if (path.isAbsolute(logicalPath)
      || logicalPath.split('/').some((piece) => piece === '' || piece === '.' || piece === '..')) {
      throw new Error(`Git reported an unsafe capture path '${logicalPath}'`);
    }
    const abs = path.join(wsPath, ...logicalPath.split('/'));
    try {
      await validateCaptureNode(abs, logicalPath);
      for (const leaf of await filesystemManifest(abs, logicalPath)) byPath.set(leaf.path, leaf);
    } catch (error) {
      // Missing means a real deletion. Removing the seeded entry and adding no leaf is the exact
      // Git-tree representation of that state; a later recheck detects an appearing replacement.
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

const rawLeafTuple = (leaf) => [
  leaf.path, leaf.type, leaf.mode, leaf.size, leaf.sha256,
].join('\0');

function sameRawLeafTuples(left, right) {
  const a = left.map(rawLeafTuple);
  const b = right.map(rawLeafTuple);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

async function embeddedBoundaryAbove(wsPath, abs) {
  let dir = path.dirname(abs);
  const root = await canonicalPath(wsPath);
  for (let n = 0; n < 256; n++) {
    const canonical = await canonicalPath(dir);
    if (samePathSync(canonical, root)) return null;
    if (!(await underOrEqualAsync(dir, wsPath))) return `path escaped worktree while checking '${abs}'`;
    try {
      await fs.lstat(path.join(dir, '.git'));
      return path.join(dir, '.git');
    } catch (error) {
      if (error?.code !== 'ENOENT') return `could not inspect ${path.join(dir, '.git')}: ${error?.message ?? error}`;
    }
    const parent = path.dirname(dir);
    if (samePathSync(await canonicalPath(parent), await canonicalPath(dir))) break;
    dir = parent;
  }
  return null;
}

/**
 * @param {string} abs
 * @param {string} logicalPath
 * @param {any[]} [out]
 * @param {string[]|null} [emptyDirectories]
 */
async function filesystemManifest(abs, logicalPath, out = [], emptyDirectories = null) {
  const before = await fs.lstat(abs);
  if (before.isDirectory() && !before.isSymbolicLink()) {
    const names = (await fs.readdir(abs)).sort();
    for (const name of names) {
      await filesystemManifest(path.join(abs, name), `${logicalPath}/${name}`, out, emptyDirectories);
    }
    // Re-read the directory after its children. A disappearing/replaced child must invalidate the
    // snapshot; accepting empty directories must not turn a concurrent deletion into a clean
    // capture. Pure empty-directory topology is named separately because Git cannot encode it.
    const after = await fs.lstat(abs);
    const afterNames = (await fs.readdir(abs)).sort();
    if (!after.isDirectory() || after.isSymbolicLink()
      || String(before.dev) !== String(after.dev) || String(before.ino) !== String(after.ino)
      || before.mtimeMs !== after.mtimeMs
      || names.length !== afterNames.length || names.some((name, i) => name !== afterNames[i])) {
      throw new Error(`'${logicalPath}' changed while it was being captured`);
    }
    if (names.length === 0 && emptyDirectories) emptyDirectories.push(logicalPath);
    return out;
  }

  let type;
  let bytes;
  let mode;
  if (before.isSymbolicLink()) {
    type = 'symlink';
    mode = '120000';
    bytes = Buffer.from(await fs.readlink(abs, { encoding: 'buffer' }));
  } else if (before.isFile()) {
    type = 'file';
    mode = (before.mode & 0o111) !== 0 ? '100755' : '100644';
    bytes = await fs.readFile(abs);
  } else {
    throw new Error(`'${logicalPath}' changed to an unsupported filesystem type during capture`);
  }

  const after = await fs.lstat(abs);
  if (String(before.dev) !== String(after.dev) || String(before.ino) !== String(after.ino)
    || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error(`'${logicalPath}' changed while it was being captured`);
  }
  out.push({
    path: logicalPath,
    type,
    mode,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  return out;
}

const sameManifest = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function hashRawManifestLeaf(cwd, stageRoot, leaf) {
  const source = path.join(stageRoot, ...leaf.path.split('/'));
  let hashPath = source;
  /** @type {string|null} */
  let temp = null;
  if (leaf.type === 'symlink') {
    temp = scratchIndexPath(cwd, 'discard-link-blob');
    const target = Buffer.from(await fs.readlink(source, { encoding: 'buffer' }));
    await fs.writeFile(temp, target, { flag: 'wx' });
    hashPath = temp;
  }
  try {
    const r = await gitOk(['hash-object', '-w', '--no-filters', '--', hashPath],
      { cwd, allowMutation: true });
    const oid = r.stdout.trim();
    // Object-format independent: SHA-1 repositories return 40 hex bytes, SHA-256 repositories
    // return 64. A successful process with missing/malformed evidence is still a failed
    // instrument; do not hand an empty oid to update-index and report the later parser error as if
    // it were the cause.
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) {
      throw new Error(`git hash-object returned an invalid object id for '${leaf.path}'`);
    }
    return { ...leaf, oid };
  } finally {
    if (temp) await fs.rm(temp, { force: true }).catch(() => {});
  }
}

async function hydrateBlobEntries(cwd, entries) {
  const blobs = entries.filter((entry) => entry.type === 'blob');
  const content = new Map();
  if (blobs.length) {
    await catFileBatch([...new Set(blobs.map((entry) => entry.oid))], { cwd }, (spec, bytes) => {
      if (Buffer.isBuffer(bytes)) content.set(spec, bytes);
    });
  }
  return entries.map((entry) => ({ ...entry, content: content.get(entry.oid) ?? null }));
}

async function materialiseHeadLeaf(abs, relPath, entry) {
  if (!['100644', '100755', '120000'].includes(entry.mode)
    || entry.type !== 'blob' || !Buffer.isBuffer(entry.content)) {
    throw new Error(`HEAD entry '${relPath}' has unsupported or unreadable ${entry.mode} ${entry.type}`);
  }
  if (entry.mode === '120000') {
    await fs.symlink(entry.content, Buffer.from(abs));
  } else {
    const permissions = entry.mode === '100755' ? 0o755 : 0o644;
    await fs.writeFile(abs, entry.content, { flag: 'wx', mode: permissions });
    await fs.chmod(abs, permissions);
  }
}

async function verifyHeadLeaf(abs, relPath, entry) {
  const st = await fs.lstat(abs);
  if (entry.mode === '120000') {
    if (!st.isSymbolicLink()) throw new Error(`restored '${relPath}' is not a symbolic link`);
    const target = Buffer.from(await fs.readlink(abs, { encoding: 'buffer' }));
    if (!target.equals(entry.content)) throw new Error(`restored '${relPath}' link target differs from HEAD`);
    return;
  }
  if (!st.isFile() || st.isSymbolicLink()) throw new Error(`restored '${relPath}' is not a regular file`);
  if (!(await fs.readFile(abs)).equals(entry.content)) throw new Error(`restored '${relPath}' bytes differ from HEAD`);
  if (process.platform !== 'win32') {
    const executable = (st.mode & 0o111) !== 0;
    if (executable !== (entry.mode === '100755')) {
      throw new Error(`restored '${relPath}' executable mode differs from HEAD`);
    }
  }
}

async function ensureOwnedDirectory(root, segments) {
  let cursor = root;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    try {
      await fs.mkdir(cursor);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const st = await fs.lstat(cursor);
    if (!st.isDirectory() || st.isSymbolicLink()) {
      throw new Error(`restore path '${cursor}' is not a real directory`);
    }
  }
}

async function restoreHeadSelection(abs, relPath, entries) {
  if (!entries.length) return;
  const exact = entries.find((entry) => entry.path === relPath);
  if (exact) {
    if (entries.length !== 1) throw new Error(`HEAD contains both '${relPath}' and descendants`);
    await materialiseHeadLeaf(abs, relPath, exact);
    await verifyHeadLeaf(abs, relPath, exact);
    return;
  }

  await fs.mkdir(abs); // exclusive: a concurrent replacement makes this fail, never get erased.
  for (const entry of entries) {
    if (!entry.path.startsWith(`${relPath}/`)) throw new Error(`unrelated HEAD entry '${entry.path}'`);
    const child = entry.path.slice(relPath.length + 1).split('/');
    const leaf = child.pop();
    await ensureOwnedDirectory(abs, child);
    await materialiseHeadLeaf(path.join(abs, ...child, leaf), entry.path, entry);
  }
  for (const entry of entries) {
    const child = entry.path.slice(relPath.length + 1).split('/');
    await verifyHeadLeaf(path.join(abs, ...child), entry.path, entry);
  }
  const restored = await filesystemManifest(abs, relPath);
  const expectedPaths = entries.map((entry) => entry.path).sort();
  const actualPaths = restored.map((entry) => entry.path).sort();
  if (JSON.stringify(expectedPaths) !== JSON.stringify(actualPaths)) {
    throw new Error(`restored '${relPath}' contains concurrent or missing paths`);
  }
}

async function rollbackQuarantines(quarantines) {
  const failures = [];
  for (const q of [...quarantines].reverse()) {
    if (!q.payload) continue;
    if (!(await sameDirectoryIdentity(q.parentIdentity))) {
      failures.push({ path: q.abs, quarantine: q.payload, error: 'parent directory identity changed' });
      continue;
    }
    try {
      await fs.lstat(q.anchoredAbs ?? q.abs);
      failures.push({ path: q.abs, quarantine: q.payload, error: 'original path was recreated concurrently' });
      continue;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        failures.push({ path: q.abs, quarantine: q.payload, error: error?.message ?? String(error) });
        continue;
      }
    }
    try {
      await fs.rename(q.payload, q.anchoredAbs ?? q.abs);
      await fs.rmdir(q.dir);
    } catch (error) {
      failures.push({ path: q.abs, quarantine: q.payload, error: error?.message ?? String(error) });
    }
  }
  return failures;
}

async function activeLinuxHandlesUnder(paths) {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function') return [];
  const roots = [];
  for (const p of paths) {
    try { roots.push(await fs.realpath(p)); } catch { roots.push(p); }
  }
  const underRoot = async (target) => {
    for (const root of roots) {
      if (await underOrEqualAsync(target, root)) return true;
    }
    return false;
  };
  const active = [];
  let procEntries;
  try { procEntries = await fs.readdir('/proc'); } catch { return [{ pid: null, kind: 'unverifiable', path: '/proc' }]; }
  const ownUid = process.getuid();
  for (const name of procEntries) {
    if (!/^\d+$/.test(name)) continue;
    const proc = `/proc/${name}`;
    let status;
    try { status = await fs.readFile(path.join(proc, 'status'), 'utf8'); } catch { continue; }
    const uid = /^Uid:\s+(\d+)/m.exec(status);
    if (!uid || Number(uid[1]) !== ownUid) continue;
    for (const kind of ['cwd']) {
      try {
        const target = (await fs.readlink(path.join(proc, kind))).replace(/ \(deleted\)$/, '');
        if (await underRoot(target)) active.push({ pid: Number(name), kind, path: target });
      } catch { /* process exited or has no readable cwd */ }
    }
    let fds;
    try { fds = await fs.readdir(path.join(proc, 'fd')); } catch { continue; }
    for (const fd of fds) {
      try {
        const target = (await fs.readlink(path.join(proc, 'fd', fd))).replace(/ \(deleted\)$/, '');
          if (await underRoot(target)) active.push({ pid: Number(name), kind: `fd:${fd}`, path: target });
      } catch { /* descriptor/process disappeared between listing and readlink */ }
    }
  }
  return active;
}

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
export async function discard(cwd, paths, {
  dryRun = false,
  stamp: stampOverride = null,
  onBeforeQuarantine = null,
  onAfterCapture = null,
  ...opts
} = {}) {
  const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
  if (!list.length) return { ok: false, error: 'discard needs at least one path' };

  const disc = await discover(cwd, opts);
  if (!disc.root) throw repoAbsenceError(disc, cwd);

  // Every path must sit inside ONE worktree. Missing paths are accepted only when HEAD proves
  // they are tracked: absence is itself a change (a tombstone), and the old lstat-first gate made
  // that change impossible to capture or discard.
  const resolved = [];
  for (const p of list) {
    const abs = path.resolve(cwd, p);
    let exists = false;
    try {
      await fs.lstat(abs);
      exists = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        return { ok: false, error: `could not inspect '${p}': ${error?.message ?? error}` };
      }
    }
    const owner = await findOwningWorktree(abs, disc);
    if (!owner) return { ok: false, error: `'${p}' is not inside a worktree of this repository` };
    let parentIdentity;
    try {
      parentIdentity = await directoryIdentity(path.dirname(abs));
    } catch (error) {
      return { ok: false, error: `cannot safely address '${p}': ${error?.message ?? error}` };
    }
    resolved.push({ input: p, abs, owner, exists, parentIdentity });
  }
  const owners = [...new Set(resolved.map((r) => r.owner.path))];
  if (owners.length > 1) {
    return { ok: false, error: `paths span ${owners.length} worktrees; discard one worktree's paths at a time`, owners };
  }

  const ws = resolved[0].owner;
  for (const r of resolved) r.relPath = await relativeLinkAwareAsync(ws.path, r.abs);
  const rel = resolved.map((r) => r.relPath);

  // NAMING THE WORKTREE ITSELF IS A DIFFERENT COMMAND, AND SAYING SO IS THE WHOLE FIX.
  //
  // A worktree root resolves to the empty relative path, which reached git as `add --force -- ''`
  // and came back "fatal: empty string is not a valid pathspec". holt then reported
  // `capture is INCOMPLETE — 1 path(s) not captured: ` with an empty name, which tells the reader
  // nothing about what they did or what to do instead.
  //
  // WHY THIS MATTERS MORE THAN A BAD ERROR STRING: this is the ESCAPE HATCH, and the escape hatch
  // is what keeps the guard installed. The refusal a developer just hit says "commit or discard it
  // explicitly first", so `holt discard ../my-worktree` is the obvious next thing to type — and it
  // dead-ended. Every failed escape is a step toward switching the guard off, which costs all of
  // the protection rather than some of it.
  //
  // It is NOT fixed by making discard swallow a whole worktree. `discard` captures PATHS and
  // reverts or removes them, leaving the worktree registered; `rescue` captures a WORKTREE so it
  // can then be removed. Those are different operations and conflating them would make the
  // dangerous one reachable by accident.
  const namedWorktreeRoot = resolved.find((r, i) => rel[i] === '' || rel[i] === '.');
  if (namedWorktreeRoot) {
    return {
      ok: false,
      error: `'${namedWorktreeRoot.input}' is a worktree, not a path inside one — discard captures paths`,
      hint: `to throw away the whole worktree: holt rescue ${ws.id}   (captures and verifies it to a ref)`
        + `, then remove it with git. To discard only its contents, name them:`
        + ` holt discard ${namedWorktreeRoot.input}/<file> …`,
      worktree: ws.id,
      note: 'NOTHING WAS CAPTURED OR REMOVED.',
    };
  }

  // The repository metadata is not worktree content. Quarantining `.git` would sever the very
  // object database needed to finish and verify the capture. This also closes selection of a file
  // *under* `.git`, plus a selected nested-repository root that the child-only check cannot see.
  const metadataPath = resolved.find((r) => r.relPath.split('/').includes('.git'));
  if (metadataPath) {
    return {
      ok: false,
      error: `'${metadataPath.input}' is Git repository metadata, not discardable worktree content`,
      note: 'NOTHING WAS CAPTURED OR REMOVED.',
    };
  }

  for (const r of resolved) {
    if (r.relPath.startsWith('../') || path.posix.isAbsolute(r.relPath)) {
      return { ok: false, error: `'${r.input}' escapes worktree '${ws.id}'` };
    }
  }

  // Normalize aliases before touching the filesystem. `dir` plus `dir/file` cannot be
  // quarantined independently: the first rename makes the second disappear. Refusing is clearer
  // than silently collapsing the user's requested result lists.
  const byRel = [...resolved].sort((a, b) => a.relPath.localeCompare(b.relPath));
  for (let i = 0; i < byRel.length; i++) {
    for (let j = i + 1; j < byRel.length; j++) {
      if (byRel[j].relPath === byRel[i].relPath || isSelectedPath(byRel[j].relPath, byRel[i].relPath)) {
        return {
          ok: false,
          error: `discard paths overlap or name the same entry: '${byRel[i].input}' and '${byRel[j].input}'`,
          note: 'name the ancestor once; NOTHING WAS CAPTURED OR REMOVED.',
        };
      }
    }
  }

  let head = null;
  const headProbe = await git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { cwd: ws.path });
  if (headProbe.code === 0 && headProbe.stdout.trim()) {
    head = headProbe.stdout.trim();
  } else {
    // A failed HEAD probe is not automatically an unborn repository. Prove the one legitimate
    // absence shape: symbolic HEAD names a branch and show-ref proves that branch does not exist.
    // Timeouts, corrupt refs, detached-HEAD failures, and injected instrument errors all refuse.
    const symbolic = await git(['symbolic-ref', '--quiet', 'HEAD'], { cwd: ws.path })
      .catch(() => ({ code: -1, stdout: '', stderr: '' }));
    const branchRef = symbolic.code === 0 ? symbolic.stdout.trim() : '';
    const absent = branchRef
      ? await git(['show-ref', '--verify', '--quiet', branchRef], { cwd: ws.path })
        .catch(() => ({ code: -1 }))
      : { code: -1 };
    if (!branchRef || absent.code !== 1) {
      return {
        ok: false,
        error: `could not resolve worktree HEAD exactly: ${headProbe.stderr?.trim() || `exit ${headProbe.code}`}`,
        note: 'NOTHING WAS CAPTURED OR REMOVED.',
      };
    }
  }

  let headEntries;
  let actualIndexEntries;
  try {
    headEntries = head ? await treeEntriesFor(ws.path, head, rel) : [];
    actualIndexEntries = await indexEntriesFor(ws.path, rel, undefined);
  } catch (error) {
    return { ok: false, error: `could not inspect exact Git state: ${error?.message ?? error}` };
  }
  const unsupportedGitlink = [...headEntries, ...actualIndexEntries]
    .find((entry) => entry.mode === '160000');
  if (unsupportedGitlink) {
    return {
      ok: false,
      error: `'${unsupportedGitlink.path}' is a Git link/submodule; its repository bytes are not in the outer tree`,
      hint: 'run Holt inside the nested repository and make its work durable before discarding the outer path',
      note: 'NOTHING WAS CAPTURED OR REMOVED.',
    };
  }

  for (const r of resolved) {
    const heldByHead = headEntries.some((entry) => isSelectedPath(entry.path, r.relPath));
    if (!r.exists && !heldByHead) return { ok: false, error: `no such path: ${r.input}` };
    const boundary = await embeddedBoundaryAbove(ws.path, r.abs);
    if (boundary) {
      return {
        ok: false,
        error: `'${r.input}' crosses an embedded Git boundary (${boundary})`,
        hint: 'run Holt inside that repository first',
        note: 'NOTHING WAS CAPTURED OR REMOVED.',
      };
    }
    if (r.exists) {
      try {
        await validateCaptureNode(r.abs, r.relPath);
      } catch (error) {
        return { ok: false, error: error?.message ?? String(error), note: 'NOTHING WAS CAPTURED OR REMOVED.' };
      }
    }
  }

  try {
    headEntries = await hydrateBlobEntries(ws.path, headEntries);
  } catch (error) {
    return { ok: false, error: `could not read HEAD content exactly: ${error?.message ?? error}` };
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      worktree: ws.id,
      paths: rel,
      tracked: resolved.filter((r) => headEntries.some((entry) => isSelectedPath(entry.path, r.relPath)))
        .map((r) => r.input),
      note: 'nothing was captured or removed',
    };
  }

  // INJECTABLE ONLY SO THE COLLISION IS TESTABLE. A ref name derived from the wall clock cannot
  // be made to collide on purpose, which is precisely why this path went untested; the same
  // seam evictCacheFiles() already uses for `now`.
  const stamp = stampOverride ?? new Date().toISOString().replace(/[:.]/g, '-');
  const baseRef = `refs/holt/discard/${refSafeId(ws.id)}-${stamp}`;
  const tmpIndex = scratchIndexPath(ws.path, 'discard');
  /** @type {string|null} */
  let stageRoot = null;
  /** @type {Awaited<ReturnType<typeof captureRef>>|null} */
  let allocated = null;
  /** @type {any[]} */
  const quarantines = [];
  /** @type {string|null} */
  let tree = null;
  /** @type {string|null} */
  let commit = null;

  try {
    for (const r of resolved) r.parentAnchor = await openDirectoryAnchor(r.parentIdentity);
    if (onBeforeQuarantine) {
      await /** @type {(detail:any)=>any} */ (onBeforeQuarantine)({
        worktree: ws.id,
        paths: resolved.map((r) => ({ input: r.input, path: r.abs, relative: r.relPath })),
      });
    }

    // Rename is the destructive action's linearisation point. The old bytes leave the user path
    // atomically and stay in a same-parent quarantine. A concurrent process recreating the
    // original path writes a NEW entry which Holt never removes or overwrites.
    for (const r of resolved) {
      const anchoredAbs = path.join(r.parentAnchor.path, path.basename(r.abs));
      const q = { ...r, anchoredAbs, dir: null, payload: null, manifest: [], emptyDirectories: [] };
      quarantines.push(q);
      if (!r.exists) continue;
      if (!(await sameDirectoryIdentity(r.parentIdentity))) {
        throw new Error(`parent '${path.dirname(r.abs)}' changed immediately before quarantine`);
      }
      q.dir = await fs.mkdtemp(path.join(r.parentAnchor.path, `.holt-discard-${path.basename(r.abs)}-`));
      q.payload = path.join(q.dir, 'payload');
      try {
        // Descriptor-anchored on Linux: neither operand can be redirected through a replacement
        // parent symlink between the identity check and this syscall.
        await fs.rename(anchoredAbs, q.payload);
        q.visiblePayload = await fs.realpath(q.payload).catch(() => q.payload);
      } catch (error) {
        await fs.rmdir(q.dir).catch(() => {});
        q.dir = null;
        q.payload = null;
        throw new Error(`could not quarantine '${r.input}': ${error?.message ?? error}`);
      }
      q.manifest = await filesystemManifest(q.payload, q.relPath, [], q.emptyDirectories);
    }

    // Capture from a private mirror, never by putting the quarantined bytes back at their old
    // names. The user's real index stays untouched. HEAD seeds every unselected path; selected
    // entries are removed and rebuilt with filter-free object plumbing, so deletions and directory
    // type changes are exact deltas and a clean filter/EOL rule cannot replace sole-copy bytes.
    stageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-discard-stage-'));
    const activeStageRoot = stageRoot;
    for (const q of quarantines) {
      if (!q.payload) continue;
      const destination = path.join(activeStageRoot, ...q.relPath.split('/'));
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.cp(q.payload, destination, {
        recursive: true,
        force: false,
        errorOnExist: true,
        preserveTimestamps: true,
        verbatimSymlinks: true,
      });
      const mirroredEmptyDirectories = [];
      const mirrored = await filesystemManifest(destination, q.relPath, [], mirroredEmptyDirectories);
      if (!sameManifest(q.manifest, mirrored)) {
        throw new Error(`private capture mirror for '${q.input}' differs from the quarantined bytes`);
      }
      if (JSON.stringify(q.emptyDirectories) !== JSON.stringify(mirroredEmptyDirectories)) {
        throw new Error(`private capture mirror for '${q.input}' differs in empty-directory shape`);
      }
    }

    const env = {
      GIT_INDEX_FILE: tmpIndex,
      GIT_WORK_TREE: stageRoot,
      ...(await authorEnv(ws.path)),
    };
    if (head) await gitOk(['read-tree', head], { cwd: ws.path, env, allowMutation: true });
    else await gitOk(['read-tree', '--empty'], { cwd: ws.path, env, allowMutation: true });

    // Remove every selected HEAD leaf one exact argv at a time. `update-index` file operands are
    // literal after `--`; there is no shell and therefore no glob/pathspec expansion to turn a
    // filename like `[x]` into its neighbours.
    const seeded = await indexEntriesFor(ws.path, rel, env);
    for (const entry of seeded) {
      await gitOk(['update-index', '--force-remove', '--', entry.path],
        { cwd: ws.path, env, allowMutation: true });
    }

    let sourceLeaves = quarantines.flatMap((q) => q.manifest);
    // A package tree can contain tens of thousands of leaves. Promise.all here launched one Git
    // process per file at once; measured on a 200 MB npm install, a child eventually exited 0 with
    // no oid and the whole documented recovery path rolled back after more than a minute. This is
    // the same bounded fan-out rule used by the scanner: eight object writers keep throughput while
    // preventing file-descriptor/process exhaustion and object-store lock storms.
    sourceLeaves = await pmap(
      sourceLeaves,
      (leaf) => hashRawManifestLeaf(ws.path, activeStageRoot, leaf),
      8,
    );
    sourceLeaves.sort((a, b) => a.path.localeCompare(b.path));
    for (const leaf of sourceLeaves) {
      await gitOk(['update-index', '--add', '--cacheinfo', `${leaf.mode},${leaf.oid},${leaf.path}`],
        { cwd: ws.path, env, allowMutation: true });
    }

    const indexed = await indexEntriesFor(ws.path, rel, env);
    if (!sameEntryTuples(sourceLeaves, indexed)) {
      throw new Error('capture index does not contain the exact selected path/mode/object tuples');
    }
    const treeR = await gitOk(['write-tree'], { cwd: ws.path, env, allowMutation: true });
    const captureTree = treeR.stdout.trim();
    tree = captureTree;
    const msg = `holt discard: ${rel.length} path(s) from ${ws.id}\n\n`
      + `${rel.join('\n')}\n\nBase: ${head ?? '(unborn repository)'}\n`
      + 'Inspect/reapply with: git diff <this-ref>^ <this-ref> -- <path>\n';
    const commitArgs = ['commit-tree', captureTree];
    if (head) commitArgs.push('-p', head);
    commitArgs.push('-m', msg);
    const commitR = await gitOk(commitArgs,
      { cwd: ws.path, env, allowMutation: true });
    const captureCommit = commitR.stdout.trim();
    commit = captureCommit;

    let captured = await treeEntriesFor(ws.path, captureCommit, rel);
    if (!sameEntryTuples(sourceLeaves, captured)) {
      throw new Error('capture commit does not contain the exact selected index tuples');
    }
    captured = await hydrateBlobEntries(ws.path, captured);
    for (const entry of captured) {
      const expected = sourceLeaves.find((leaf) => leaf.path === entry.path);
      const digest = Buffer.isBuffer(entry.content)
        ? createHash('sha256').update(entry.content).digest('hex') : null;
      if (!expected || digest !== expected.sha256) {
        throw new Error(`capture blob for '${entry.path}' differs from quarantined bytes`);
      }
    }
    const ancestry = await git(['rev-list', '--parents', '-n', '1', captureCommit], { cwd: ws.path });
    const parents = ancestry.code === 0 ? ancestry.stdout.trim().split(/\s+/) : [];
    if (parents[0] !== captureCommit
      || (head ? parents.length !== 2 || parents[1] !== head : parents.length !== 1)) {
      throw new Error('capture commit parent does not exactly bind the worktree HEAD');
    }

    // A CAPTURE REF IS ALLOCATED, NEVER OVERWRITTEN — the class captureRef() already closed for
    // `rescue`, reached here through a different door. This wrote the ref with NO old-value, so a
    // second discard landing on the same name silently replaced the first capture's only pointer,
    // and `discard` DELETES untracked files: nothing else holds that content, so the orphaned
    // commit survives only until gc. `-${stamp}` makes that collision unlikely, and unlikely is
    // exactly the argument captureRef's own comment refuses — "the write is the proof".
    //
    // captureRef NEVER THROWS, where gitOk did. That difference is load-bearing: the throw was what
    // stopped the deletion below, so the explicit refusal here is not defensive decoration, it is
    // the thing that keeps a failed allocation from costing the user their files.
    allocated = await captureRef(ws.path, {
      baseRef, commit: captureCommit, tree: captureTree, kind: 'discard', id: ws.id,
    });
    if (!allocated.ok) throw new Error(`capture ref could not be allocated (${allocated.reason}): ${allocated.gitError ?? ''}`.trim());
    const ref = allocated.ref;
    const capturedCommit = allocated.commit ?? captureCommit;

    // Re-read the quarantined bytes after Git has finished. An already-open writer follows the
    // inode through rename; if it changed A to B during capture, B remains in quarantine and this
    // call refuses rather than deleting a version the ref does not hold.
    for (const q of quarantines) {
      if (!q.payload) continue;
      const now = await filesystemManifest(q.payload, q.relPath);
      if (!sameManifest(q.manifest, now)) {
        return {
          ok: false, ref, commit: capturedCommit,
          error: `'${q.input}' changed through an open handle after capture`,
          quarantine: q.visiblePayload ?? q.payload,
          note: 'The ref holds the captured version and the later bytes remain in quarantine. Nothing was erased.',
        };
      }
    }

    if (onAfterCapture) {
      try {
        await /** @type {(detail:any)=>any} */ (onAfterCapture)({
          worktree: ws.id, ref, commit: capturedCommit,
          paths: resolved.map((r) => ({ input: r.input, path: r.abs, relative: r.relPath })),
        });
      } catch (error) {
        return {
          ok: false, ref, commit: capturedCommit,
          error: `post-capture hook failed: ${error?.message ?? error}`,
          quarantine: quarantines.filter((q) => q.payload).map((q) => q.visiblePayload ?? q.payload),
          note: 'The capture and quarantine were retained; no replacement path was touched.',
        };
      }
    }

    for (const q of quarantines) {
      if (!(await sameDirectoryIdentity(q.parentIdentity))) {
        q.visiblePayload = await fs.realpath(q.payload).catch(() => q.visiblePayload ?? q.payload);
        return {
          ok: false, ref, commit: capturedCommit,
          error: `parent directory identity changed for '${q.input}' after capture`,
          quarantine: q.visiblePayload ?? q.payload,
          note: 'Holt will not follow a replaced parent or symlink. The capture/quarantine were retained.',
        };
      }
    }

    const removed = [];
    const reverted = [];
    for (const q of quarantines) {
      const entries = headEntries.filter((entry) => isSelectedPath(entry.path, q.relPath));
      if (entries.length) {
        try {
          await restoreHeadSelection(q.anchoredAbs, q.relPath, entries);
        } catch (error) {
          return {
            ok: false, ref, commit: capturedCommit,
            error: `captured, but could not restore '${q.relPath}' without overwriting concurrent work: ${error?.message ?? error}`,
            discarded: removed,
            reverted,
            quarantine: quarantines.filter((held) => held.payload)
              .map((held) => held.visiblePayload ?? held.payload),
            note: 'The discarded version is safe in the ref/quarantine. No concurrent replacement was erased.',
          };
        }
        reverted.push(q.input);
      } else {
        // The original untracked entry already left this path at the atomic rename. If another
        // process recreated the name, that is new work and is deliberately left alone.
        if (q.exists) removed.push(q.input);
      }
    }

    // A final exact re-read catches open-handle writes that landed while HEAD was being restored.
    // On mismatch the physical quarantine is retained even though the earlier version is in Git.
    for (const q of quarantines) {
      if (!q.payload) continue;
      const now = await filesystemManifest(q.payload, q.relPath);
      if (!sameManifest(q.manifest, now)) {
        return {
          ok: false, ref, commit: capturedCommit,
          error: `'${q.input}' changed in quarantine before cleanup`,
          quarantine: q.visiblePayload ?? q.payload,
          note: 'The later bytes remain on disk; Holt refused physical cleanup.',
        };
      }
    }

    const activeHandles = await activeLinuxHandlesUnder(
      quarantines.filter((q) => q.payload).map((q) => q.payload),
    );
    if (activeHandles.length) {
      return {
        ok: false, ref, commit: capturedCommit,
        error: 'physical quarantine is still held by an active process',
        activeHandles,
        quarantine: quarantines.filter((q) => q.payload).map((q) => q.visiblePayload ?? q.payload),
        note: 'The capture is durable, but Holt retained the quarantine so a writer with an open '
          + 'descriptor cannot add bytes after the last manifest check and lose them during cleanup.',
      };
    }

    const refCheck = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: ws.path });
    if (refCheck.code !== 0 || refCheck.stdout.trim() !== capturedCommit) {
      return {
        ok: false, ref, commit: capturedCommit,
        error: 'capture ref changed before quarantined bytes could be removed',
        quarantine: quarantines.filter((q) => q.payload).map((q) => q.visiblePayload ?? q.payload),
        note: 'Physical quarantine was retained.',
      };
    }

    for (const q of quarantines) {
      if (!q.payload) continue;
      try {
        await fs.rm(q.payload, { recursive: true, force: false });
        await fs.rmdir(q.dir);
      } catch (error) {
        return {
          ok: false, ref, commit: capturedCommit,
          error: `capture is durable, but physical quarantine cleanup failed: ${error?.message ?? error}`,
          quarantine: q.dir,
          discarded: removed,
          reverted,
        };
      }
    }

    const journalFailures = [];
    await journal(cwd, {
      action: 'discard', id: ws.id, path: ws.path,
      ref, commit: capturedCommit, paths: rel, count: rel.length,
    }, journalFailures);

    const literalPathspecs = rel.map((p) => `:(literal)${p}`);
    const restoreArgv = ['git', 'restore', `--source=${capturedCommit}`, '--worktree', '--', ...literalPathspecs];
    const diffArgv = head ? ['git', 'diff', head, capturedCommit, '--', ...literalPathspecs] : null;

    const emptyDirectoriesOmitted = quarantines.flatMap((q) => q.emptyDirectories ?? []);
    return withJournalWarning({
      ok: true,
      worktree: ws.id,
      ref,
      commit: capturedCommit,
      discarded: removed,
      reverted,
      verified: true,
      restore: restoreArgv.map(shellQuote).join(' '),
      restoreArgv,
      reapplyDelta: diffArgv
        ? `${diffArgv.map(shellQuote).join(' ')} | ${['git', 'apply'].map(shellQuote).join(' ')}` : null,
      reapplyDeltaArgv: diffArgv ? { diff: diffArgv, apply: ['git', 'apply'] } : null,
      inspect: `git show ${capturedCommit} --stat`,
      emptyDirectoriesOmitted,
      note: emptyDirectoriesOmitted.length
        ? `file content was captured and verified before removal; ${emptyDirectoriesOmitted.length} empty director${emptyDirectoriesOmitted.length === 1 ? 'y was' : 'ies were'} removed but cannot be represented or recreated by a Git ref.`
        : reverted.length
        ? 'tracked path(s) were RESTORED from HEAD rather than deleted — the edits you threw away '
          + 'are captured in the ref above and recoverable. Untracked path(s), if any, were removed.'
        : 'content captured and verified before removal; it is recoverable from the ref above.',
    }, journalFailures);
  } catch (error) {
    const rollbackFailures = allocated ? [] : await rollbackQuarantines(quarantines);
    return {
      ok: false,
      ref: allocated?.ok ? allocated.ref : null,
      commit: allocated?.ok ? (allocated.commit ?? commit) : commit,
      error: error?.message ?? String(error),
      rollbackFailures,
      quarantine: rollbackFailures.map((failure) => failure.quarantine),
      note: allocated
        ? 'The capture ref and physical quarantine were retained; no concurrent replacement was erased.'
        : (rollbackFailures.length
          ? 'Capture failed and some paths could not be rolled back safely; their quarantine paths are reported.'
          : 'Capture failed before a durable ref was allocated; every quarantined path was restored.'),
    };
  } finally {
    await fs.rm(tmpIndex, { force: true }).catch(() => {});
    if (stageRoot) await fs.rm(stageRoot, { recursive: true, force: true }).catch(() => {});
    for (const r of resolved) await r.parentAnchor?.handle?.close().catch(() => {});
  }
}

/** The worktree a path lives in, chosen by the LONGEST match so nested worktrees resolve right. */
async function findOwningWorktree(abs, disc) {
  /** @type {{path:string, id?:string}|null} */
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

async function pathKind(p) {
  try {
    const st = await fs.lstat(p);
    if (st.isDirectory()) return 'directory';
    if (st.isSymbolicLink()) return 'symlink';
    return 'other';
  } catch (error) {
    return error?.code === 'ENOENT' ? 'missing' : 'unknown';
  }
}

/** Is `wtPath` still a registered Git worktree? Exact canonical path, no basename inference. */
async function registeredWorktree(wtPath, cwd) {
  const listed = await git(['worktree', 'list', '--porcelain'], { cwd }).catch(() => null);
  if (!listed || listed.code !== 0) return false;
  const target = await canonicalPath(wtPath);
  for (const record of parseWorktreePorcelain(listed.stdout)) {
    if (samePathSync(await canonicalPath(record.path), target)) return true;
  }
  return false;
}

/**
 * Allocate an unpredictable destination on the SAME filesystem as the source.
 *
 * Prefer the common Git directory: it is durable with the repository, hidden from the working
 * tree, and discoverable from Git's own registration. A linked worktree may live on another
 * volume, so compare device ids first and fall back to an exclusive hidden sibling. `mkdtemp`
 * creates the parent itself; no attacker-chosen intermediate symlink can redirect the move.
 */
async function allocateCleanQuarantine(cwd, wtPath) {
  const sourceParent = path.dirname(wtPath);
  let base = sourceParent;
  const common = await git(['rev-parse', '--git-common-dir'], { cwd: wtPath }).catch(() => null);
  if (common?.code === 0 && common.stdout.trim()) {
    const raw = common.stdout.trim();
    const commonDir = await canonicalPath(path.isAbsolute(raw) ? raw : path.resolve(wtPath, raw));
    try {
      const [a, b] = await Promise.all([fs.stat(sourceParent), fs.stat(commonDir)]);
      const sameDevice = a.dev === b.dev;
      const sameVolume = process.platform !== 'win32'
        || path.parse(sourceParent).root.toLowerCase() === path.parse(commonDir).root.toLowerCase();
      if (sameDevice && sameVolume) base = commonDir;
    } catch {
      // A failed device probe is not evidence that two paths share a filesystem. The existing
      // source parent is the only conservative destination; rename within it cannot cross devices.
      base = sourceParent;
    }
  }

  let root;
  try {
    root = await fs.mkdtemp(path.join(base, '.holt-clean-quarantine-'));
  } catch (error) {
    if (samePathSync(base, sourceParent)) throw error;
    root = await fs.mkdtemp(path.join(sourceParent, '.holt-clean-quarantine-'));
  }
  await fs.chmod(root, 0o700).catch(() => {});
  return { root, path: path.join(root, 'worktree') };
}

async function removeEmptyQuarantineRoot(root) {
  await fs.rmdir(root).catch(() => {});
}

async function cleanAdminDir(wtPath) {
  const r = await git(['rev-parse', '--absolute-git-dir'], { cwd: wtPath }).catch(() => null);
  const dir = r?.code === 0 ? r.stdout.trim() : '';
  if (!dir || !path.isAbsolute(dir)) {
    throw new Error('Git did not return an absolute private worktree admin directory');
  }
  return dir;
}

async function worktreeBinding(wtPath) {
  const [adminDir, stat] = await Promise.all([cleanAdminDir(wtPath), fs.lstat(wtPath)]);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('registered worktree root is not a physical directory');
  }
  return {
    adminDir: await canonicalPath(adminDir),
    device: String(stat.dev),
    inode: String(stat.ino),
  };
}

const sameWorktreeBinding = (a, b) => !!a && !!b
  && samePathSync(a.adminDir, b.adminDir)
  && a.device === b.device
  && a.inode === b.inode;

async function reportNodeAt(report, wtPath) {
  const target = await canonicalPath(wtPath);
  for (const node of report.graph.nodes) {
    if (!node?.path) continue;
    if (samePathSync(await canonicalPath(node.path), target)) return node;
  }
  return null;
}

async function syncDirectory(dir) {
  let handle;
  try {
    handle = await fs.open(dir, 'r');
    await handle.sync();
  } catch {
    // Directory fsync is unavailable on some Windows filesystems. The marker FILE is fsynced;
    // failure here cannot turn an in-flight record into a completed one.
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeExclusiveMarker(markerPath, record) {
  const handle = await fs.open(markerPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(markerPath));
}

async function completeMarker(markerPath, token, record) {
  const tmp = `${markerPath}.${token}.tmp`;
  const handle = await fs.open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmp, markerPath);
    await syncDirectory(path.dirname(markerPath));
  } catch (error) {
    await fs.unlink(tmp).catch(() => {});
    throw error;
  }
}

/**
 * Atomically move one worktree into recoverable quarantine, then lock and verify it.
 *
 * The rename is the destructive-boundary fix: bytes or commits that arrive after the final scan
 * move WITH the directory instead of falling into a scan→recursive-delete race. The destination
 * is on the same filesystem, so Git's physical move is a rename rather than copy-then-delete.
 * Nothing here removes a file, unregisters the moved worktree, or deletes its branch.
 */
async function quarantineWorktree(cwd, candidate) {
  let bound;
  try { bound = await worktreeBinding(candidate.path); } catch (error) {
    return { ok: false, retained: false, why: `worktree identity could not be revalidated: ${error?.message ?? error}` };
  }
  if (!sameWorktreeBinding(bound, candidate.binding)) {
    return { ok: false, retained: false, why: 'worktree identity changed after the final verdict' };
  }

  let q;
  try {
    q = await allocateCleanQuarantine(cwd, candidate.path);
  } catch (error) {
    return { ok: false, retained: false, why: `could not allocate quarantine: ${error?.message ?? error}` };
  }

  const token = randomUUID();
  const adminDir = bound.adminDir;
  const markerPath = path.join(adminDir, `${HOLT_CLEAN_QUARANTINE_MARKER_PREFIX}${token}.json`);
  const transit = {
    version: 1,
    kind: 'holt-clean-quarantine',
    state: 'transit',
    token,
    originalPath: candidate.path,
    intendedPath: q.path,
    actualPath: null,
    startedAt: new Date().toISOString(),
  };
  try {
    await writeExclusiveMarker(markerPath, transit);
  } catch (error) {
    await removeEmptyQuarantineRoot(q.root);
    return { ok: false, retained: false, why: `could not write quarantine transition marker: ${error?.message ?? error}` };
  }

  // Lock BEFORE moving. Git requires two --force flags to move a locked worktree, and that move
  // preserves the private admin lock file. An ordinary Holt risk lock stays continuously in
  // place; an unlocked candidate receives a tokened quarantine lock. There is no unlock/relock
  // interval in which a concurrent remover can reach the source.
  const initialLock = await lockState(candidate.path, cwd);
  let acquiredLock = false;
  if (initialLock.locked && !isHoltLock(initialLock.reason)) {
    await fs.unlink(markerPath).catch(() => {});
    await removeEmptyQuarantineRoot(q.root);
    return { ok: false, retained: false, why: `worktree acquired a foreign lock: ${initialLock.reason}` };
  }
  if (!initialLock.locked) {
    const protectedMove = await git([
      'worktree', 'lock', '--reason', `${HOLT_CLEAN_QUARANTINE_LOCK_PREFIX} transit ${token}`,
      candidate.path,
    ], { cwd, allowMutation: true }).catch((error) => ({ code: 1, stderr: String(error?.message ?? error) }));
    const confirmed = await lockState(candidate.path, cwd);
    if (protectedMove.code !== 0 || !confirmed.locked || !isHoltCleanQuarantineLock(confirmed.reason)) {
      await fs.unlink(markerPath).catch(() => {});
      await removeEmptyQuarantineRoot(q.root);
      return {
        ok: false, retained: false,
        why: `could not lock worktree before quarantine: ${protectedMove.stderr?.trim() || 'lock verification failed'}`,
      };
    }
    acquiredLock = true;
  }

  const moved = await git(['worktree', 'move', '-f', '-f', candidate.path, q.path],
    { cwd, allowMutation: true }).catch((error) => ({ code: 1, stderr: String(error?.message ?? error) }));
  const [sourceKind, quarantineKind] = await Promise.all([pathKind(candidate.path), pathKind(q.path)]);

  // Git renames first and updates worktree metadata second. A nonzero exit can therefore mean the
  // complete directory is already at quarantine. Inspect state; never interpret stderr as an
  // atomic rollback guarantee.
  const physicallyMoved = quarantineKind === 'directory' && sourceKind === 'missing';
  if (moved.code !== 0 && !physicallyMoved) {
    let restoredLock = true;
    if (acquiredLock && sourceKind !== 'missing') {
      const unlocked = await git(['worktree', 'unlock', candidate.path], { cwd, allowMutation: true })
        .catch(() => ({ code: 1 }));
      restoredLock = unlocked.code === 0;
    }
    if (restoredLock && quarantineKind === 'missing') {
      await fs.unlink(markerPath).catch(() => {});
    }
    if (quarantineKind === 'missing') await removeEmptyQuarantineRoot(q.root);
    return {
      ok: false,
      retained: quarantineKind !== 'missing' || !restoredLock,
      quarantinePath: quarantineKind !== 'missing' ? q.path : null,
      why: (moved.stderr?.trim() || 'git worktree move failed')
        + (restoredLock ? '' : '; the pre-move quarantine lock could not be rolled back'),
    };
  }

  if (!(await registeredWorktree(q.path, cwd))) {
    const repaired = await git(['worktree', 'repair', q.path], { cwd, allowMutation: true })
      .catch((error) => ({ code: 1, stderr: String(error?.message ?? error) }));
    if (repaired.code !== 0 || !(await registeredWorktree(q.path, cwd))) {
      return {
        ok: false,
        retained: quarantineKind !== 'missing',
        quarantinePath: quarantineKind !== 'missing' ? q.path : null,
        why: `worktree moved but Git registration could not be verified: ${repaired.stderr?.trim() || 'repair failed'}`,
      };
    }
  }


  let movedBinding;
  try { movedBinding = await worktreeBinding(q.path); } catch (error) {
    return {
      ok: false,
      retained: true,
      quarantinePath: q.path,
      why: `worktree retained in quarantine, but moved identity could not be verified: ${error?.message ?? error}`,
    };
  }
  if (!sameWorktreeBinding(movedBinding, candidate.binding)) {
    return {
      ok: false,
      retained: true,
      quarantinePath: q.path,
      why: 'worktree retained in quarantine, but its private admin or filesystem identity changed',
    };
  }

  const lock = await lockState(q.path, cwd);
  if (!lock.locked || !isHoltLock(lock.reason)) {
    return {
      ok: false,
      retained: true,
      quarantinePath: q.path,
      why: 'worktree retained in quarantine, but the pre-move Git lock did not survive verification',
    };
  }

  const actualHead = await git(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: q.path })
    .catch(() => null);
  const actualBranch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: q.path })
    .catch(() => null);
  if (!actualHead || actualHead.code !== 0 || !actualHead.stdout.trim()) {
    return {
      ok: false,
      retained: true,
      quarantinePath: q.path,
      why: 'worktree retained and locked in quarantine, but its moved HEAD could not be verified',
    };
  }
  const head = actualHead.stdout.trim();
  const branch = actualBranch?.code === 0 ? actualBranch.stdout.trim() : null;

  try {
    await completeMarker(markerPath, token, {
      ...transit,
      state: 'quarantined',
      actualPath: q.path,
      completedAt: new Date().toISOString(),
      lockReason: lock.reason,
      lockWasAcquired: acquiredLock,
      preExistingLockReason: acquiredLock ? null : initialLock.reason,
      head,
      branch,
    });
  } catch (error) {
    return {
      ok: false,
      retained: true,
      quarantinePath: q.path,
      why: `worktree retained and locked in quarantine, but completion marker failed: ${error?.message ?? error}`,
    };
  }

  const moveArgv = ['git', 'worktree', 'move', '-f', '-f', q.path, candidate.path];
  const unlockArgv = ['git', 'worktree', 'unlock', candidate.path];
  // Restore the authority state that existed before Holt moved the worktree. If this quarantine
  // acquired its own transit lock, releasing that lock after the move is correct. If an ordinary
  // Holt protection lock already existed, however, `worktree move -f -f` carries that exact lock
  // through both moves and the restore recipe must NOT erase it. Returning an unconditional
  // unlock silently weakened a protected worktree after an otherwise successful recovery.
  const restoreArgv = acquiredLock ? [moveArgv, unlockArgv] : [moveArgv];
  return {
    ok: true,
    quarantinePath: q.path,
    head,
    branch,
    originalPathOccupied: (await pathKind(candidate.path)) !== 'missing',
    restoreArgv,
    restore: restoreArgv.map((argv) => argv.map(shellQuote).join(' ')).join(' && '),
    restorePreservesExistingLock: !acquiredLock,
    preExistingLockReason: acquiredLock ? null : initialLock.reason,
  };
}

/**
 * Move provably-disposable worktrees into a locked, recoverable local quarantine.
 *
 * There is no portable primitive that freezes every process with an open cwd/file descriptor
 * between a final scan and recursive deletion. Therefore `clean --apply` does not physically
 * delete. It atomically moves the whole worktree on the same filesystem and keeps it registered,
 * locked, and branch-reachable. That closes the entire late-writer class rather than making the
 * scan/delete interval merely smaller.
 *
 * DRY RUN BY DEFAULT.
 *
 * @param {object} opts
 * @param {boolean} opts.apply actually quarantine (default: dry run)
 * @param {Function|null} opts.onBeforeRemove backwards-compatible seam before re-verification
 * @param {Function|null} opts.onAfterVerify deterministic seam after the final verdict and before
 *   the atomic move; used to prove late files/commits move into quarantine instead of being lost
 */
export async function clean(cwd, {
  apply = false, onBeforeRemove = null, onAfterVerify = null, ...opts
} = {}) {
  const { report, quarantined: existingQuarantines } = await assessForClean(cwd, opts);

  const disposable = report.safe.filter((s) => s.safe);
  const held = report.safe.filter((s) => !s.safe && s.confidence !== 'unknown');
  const unknown = report.safe.filter((s) => s.confidence === 'unknown');

  const plan = [];
  const bindingFailures = [];
  for (const s of disposable) {
    const node = report.graph.nodes.find((n) => n.id === s.id);
    if (!node?.path) continue;
    let binding;
    try { binding = await worktreeBinding(node.path); } catch (error) {
      bindingFailures.push({
        id: s.id,
        why: `disposable verdict was measured, but worktree identity could not be bound: ${error?.message ?? error}`,
      });
      continue;
    }
    plan.push({
      id: s.id,
      path: node.path,
      branch: node.branch ?? null,
      head: node.head ?? null,
      why: s.reasons[0],
      binding,
    });
  }

  if (!apply) {
    return {
      dryRun: true,
      wouldQuarantine: plan.map(({ binding: _binding, ...candidate }) => candidate),
      keeping: held.map((h) => ({ id: h.id, why: h.reasons.join('; ') })),
      unknown: unknown.map((u) => ({ id: u.id, why: u.reasons[0] })).concat(bindingFailures),
      existingQuarantines: existingQuarantines.map((w) => ({ id: w.id, path: w.path })),
      note: `${plan.length} active worktree(s) hold nothing base lacks. Re-run with --apply to `
        + 'move them into locked, recoverable local quarantine. No files or branches are physically deleted.',
    };
  }

  const journalFailures = [];
  const done = [];
  for (const p of plan) {
    if (onBeforeRemove) await /** @type {(p: any) => any} */ (onBeforeRemove)(p);

    // The plan can already be seconds old. Recompute against ACTIVE worktrees only; previously
    // quarantined recovery copies must not authorise draining the last live redundant sibling.
    const fresh = await assessForClean(cwd, opts);
    const freshNode = await reportNodeAt(fresh.report, p.path);
    const still = freshNode
      ? fresh.report.safe.find((s) => s.id === freshNode.id)
      : null;
    if (!still?.safe) {
      done.push({ ...p, action: 'skipped', why: `no longer disposable: ${still?.reasons?.[0] ?? 'unknown'}` });
      continue;
    }

    let freshBinding;
    try { freshBinding = await worktreeBinding(p.path); } catch (error) {
      done.push({ ...p, action: 'skipped', why: `worktree identity could not be revalidated: ${error?.message ?? error}` });
      continue;
    }
    if (!sameWorktreeBinding(freshBinding, p.binding)) {
      done.push({ ...p, action: 'skipped', why: 'worktree identity changed since the cleanup plan was measured' });
      continue;
    }
    p.binding = freshBinding;

    if (onAfterVerify) await /** @type {(p: any, verdict: any) => any} */ (onAfterVerify)(p, still);

    // A foreign lock is independent authority and always wins. Holt's ordinary risk lock stays
    // continuously in place: quarantine moves locked trees with Git's required double force.
    const lock = await lockState(p.path, cwd);
    if (lock.locked) {
      if (!isHoltLock(lock.reason) || isHoltCleanQuarantineLock(lock.reason)) {
        done.push({ ...p, action: 'skipped', why: `locked by something other than an active Holt risk guard: ${lock.reason}` });
        continue;
      }
    }

    const moved = await quarantineWorktree(cwd, p);
    if (!moved.ok) {
      done.push({
        ...p,
        action: 'failed',
        why: moved.why,
        quarantinePath: moved.quarantinePath ?? null,
        retained: moved.retained,
        rolledBack: moved.rolledBack ?? false,
      });
      // A retained-but-unverified partial state is safe but not a basis for acting on siblings.
      if (moved.retained) break;
      continue;
    }

    const action = {
      ...p,
      action: 'quarantined',
      quarantinePath: moved.quarantinePath,
      head: moved.head,
      branch: moved.branch,
      originalPathOccupied: moved.originalPathOccupied,
      restoreArgv: moved.restoreArgv,
      restore: moved.restore,
      restorePreservesExistingLock: moved.restorePreservesExistingLock,
      preExistingLockReason: moved.preExistingLockReason,
    };
    done.push(action);
    await journal(cwd, {
      action: 'clean-quarantine', id: p.id,
      path: p.path, quarantinePath: moved.quarantinePath,
      branch: moved.branch, head: moved.head,
      evidence: still.reasons?.length ? still.reasons : ['re-verified disposable immediately before quarantine'],
      restoreArgv: moved.restoreArgv,
    }, journalFailures);
  }

  const quarantines = done.filter((d) => d.action === 'quarantined');
  const publicDone = done.map(({ binding: _binding, ...action }) => action);
  const failures = publicDone.filter((d) => d.action === 'failed');
  return withJournalWarning({
    dryRun: false,
    quarantined: quarantines.length,
    quarantines: quarantines.map((d) => ({
      id: d.id,
      originalPath: d.path,
      quarantinePath: d.quarantinePath,
      restoreArgv: d.restoreArgv,
      restore: d.restore,
      originalPathOccupied: d.originalPathOccupied,
      restorePreservesExistingLock: d.restorePreservesExistingLock,
      preExistingLockReason: d.preExistingLockReason,
    })),
    // Explicit zeroes keep old automation from interpreting quarantine as physical deletion.
    removed: 0,
    branchesRemoved: 0,
    skipped: publicDone.filter((d) => d.action === 'skipped'),
    failures,
    // Backward-compatible alias for pre-launch callers; `failures` + `failedCount` is canonical.
    failed: failures,
    failedCount: failures.length,
    actions: publicDone,
    existingQuarantines: existingQuarantines.map((w) => ({ id: w.id, path: w.path })),
    unknown: unknown.map((u) => ({ id: u.id, why: u.reasons[0] })).concat(bindingFailures),
    note: quarantines.length
      ? `${quarantines.length} worktree(s) moved into locked local quarantine; no files or branches were deleted.`
      : 'No worktrees were quarantined; no files or branches were deleted.',
  }, journalFailures);
}

/* ======================================================= QUARANTINE RECOVERY ==== */

function cleanRecoveryRows(workstreams, state) {
  const candidates = workstreams
    .filter((w) => w.quarantineState === state)
    .map((w) => {
      const originalPath = w.quarantineOriginalPath ?? null;
      const identityPath = originalPath ?? w.path;
      return {
        id: path.basename(identityPath),
        path: identityPath,
        originalPath,
        quarantinePath: w.path,
        state,
        head: w.head ?? null,
        branch: w.branch ?? null,
        locked: w.locked === true,
        lockReason: w.lockReason ?? null,
        lockWasAcquired: w.quarantineLockWasAcquired
          ?? isHoltCleanQuarantineLock(w.lockReason),
        preExistingLockReason: w.quarantinePreExistingLockReason ?? null,
        _markerPath: w.quarantineMarkerPath ?? null,
        _token: w.quarantineToken ?? null,
        _recordedLockReason: w.quarantineRecordedLockReason ?? null,
        _recordedHead: w.quarantineRecordedHead ?? null,
        _recordedBranch: w.quarantineRecordedBranch ?? null,
      };
    });
  return disambiguate(candidates);
}

const publicRecoveryRow = ({
  path: _identityPath,
  _markerPath,
  _token,
  _recordedLockReason,
  _recordedHead,
  _recordedBranch,
  ...row
}) => row;

/** List every terminal or interrupted clean quarantine without rescanning it as deletion authority. */
export async function quarantines(cwd, opts = {}) {
  const disc = await discover(cwd, opts);
  if (!disc.root) throw repoAbsenceError(disc, cwd);
  const completed = cleanRecoveryRows(disc.workstreams, 'quarantined');
  const transitions = cleanRecoveryRows(disc.workstreams, 'transit');
  return {
    count: completed.length,
    quarantines: completed.map(publicRecoveryRow),
    transitions: transitions.map(publicRecoveryRow),
    note: completed.length
      ? `${completed.length} recoverable worktree quarantine(s). Restore one with: holt restore <id>`
      : (transitions.length
        ? 'No completed quarantines; interrupted transitions need inspection before recovery.'
        : 'No clean quarantines found.'),
  };
}

async function readCleanRecoveryMarker(markerPath) {
  if (!markerPath || !path.isAbsolute(markerPath)) throw new Error('quarantine marker path is unavailable');
  const st = await fs.lstat(markerPath);
  if (!st.isFile() || st.isSymbolicLink() || st.size > 64 * 1024) {
    throw new Error('quarantine marker is not a bounded physical file');
  }
  const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
  if (marker?.version !== 1 || marker?.kind !== 'holt-clean-quarantine'
      || marker?.state !== 'quarantined') {
    throw new Error('quarantine marker no longer records a completed quarantine');
  }
  if (typeof marker.token !== 'string' || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(marker.token)) {
    throw new Error('quarantine marker token is invalid');
  }
  return marker;
}

/**
 * Restore one completed clean quarantine to the exact path recorded before its atomic move.
 *
 * This deliberately has no `--force`: an occupied destination, changed marker, changed lock,
 * changed HEAD, cross-filesystem target, or ambiguous id refuses. Recovery must never turn into
 * an overwrite primitive. The original lock authority is restored too: Holt releases only a
 * transit lock it acquired itself and preserves a protection lock that predated quarantine.
 */
export async function restoreQuarantine(cwd, target, opts = {}) {
  if (!target || typeof target !== 'string') {
    return { ok: false, failedCount: 1, error: 'restore needs a quarantine id' };
  }
  const disc = await discover(cwd, opts);
  if (!disc.root) throw repoAbsenceError(disc, cwd);
  const rows = cleanRecoveryRows(disc.workstreams, 'quarantined');
  const idMatch = new Map(rows.map((row) => [row.id, row])).get(target) ?? null;
  const resolvedTarget = path.isAbsolute(target) ? await canonicalPath(target) : null;
  const pathMatches = rows.filter((row) => resolvedTarget
    && (samePathSync(row.quarantinePath, resolvedTarget)
      || (row.originalPath && samePathSync(row.originalPath, resolvedTarget))));
  const matches = idMatch
    ? [idMatch, ...pathMatches.filter((row) => row !== idMatch)]
    : pathMatches;
  if (matches.length !== 1) {
    return {
      ok: false,
      failedCount: 1,
      error: matches.length
        ? `quarantine target '${target}' is ambiguous`
        : `no completed clean quarantine matches '${target}'`,
      available: rows.map(publicRecoveryRow),
      note: 'nothing was moved or unlocked',
    };
  }

  const row = matches[0];
  let marker;
  try {
    marker = await readCleanRecoveryMarker(row._markerPath);
  } catch (error) {
    return { ok: false, failedCount: 1, id: row.id, error: error?.message ?? String(error), note: 'nothing was moved or unlocked' };
  }
  if (!path.isAbsolute(marker.originalPath ?? '') || !path.isAbsolute(marker.actualPath ?? '')) {
    return { ok: false, failedCount: 1, id: row.id, error: 'quarantine marker paths are not absolute', note: 'nothing was moved or unlocked' };
  }
  const [actualPath, originalPath] = await Promise.all([
    canonicalPath(marker.actualPath),
    canonicalPath(marker.originalPath),
  ]);
  if (!samePathSync(actualPath, row.quarantinePath)
      || !samePathSync(originalPath, row.originalPath)
      || marker.token !== row._token) {
    return { ok: false, failedCount: 1, id: row.id, error: 'quarantine marker changed after discovery', note: 'nothing was moved or unlocked' };
  }
  if (row._recordedHead && marker.head !== row._recordedHead) {
    return { ok: false, failedCount: 1, id: row.id, error: 'quarantine HEAD record changed after discovery', note: 'nothing was moved or unlocked' };
  }

  let beforeBinding;
  try { beforeBinding = await worktreeBinding(actualPath); } catch (error) {
    return { ok: false, failedCount: 1, id: row.id, error: `quarantine identity could not be verified: ${error?.message ?? error}`, note: 'nothing was moved or unlocked' };
  }
  const lock = await lockState(actualPath, cwd);
  if (!lock.locked || !isHoltLock(lock.reason)) {
    return { ok: false, failedCount: 1, id: row.id, error: 'quarantine is no longer protected by a Holt lock', note: 'nothing was moved or unlocked' };
  }
  if (marker.lockReason && marker.lockReason !== lock.reason) {
    return { ok: false, failedCount: 1, id: row.id, error: 'quarantine lock changed after it was recorded', note: 'nothing was moved or unlocked' };
  }
  const lockWasAcquired = typeof marker.lockWasAcquired === 'boolean'
    ? marker.lockWasAcquired
    : isHoltCleanQuarantineLock(lock.reason);
  if (lockWasAcquired !== isHoltCleanQuarantineLock(lock.reason)) {
    return { ok: false, failedCount: 1, id: row.id, error: 'quarantine lock provenance is inconsistent', note: 'nothing was moved or unlocked' };
  }
  if (marker.head && marker.head !== row.head) {
    return { ok: false, failedCount: 1, id: row.id, error: 'quarantined worktree HEAD changed after completion', note: 'nothing was moved or unlocked' };
  }

  const destinationKind = await pathKind(originalPath);
  if (destinationKind !== 'missing') {
    return {
      ok: false, failedCount: 1, id: row.id,
      error: `original path is occupied by ${destinationKind}: ${originalPath}`,
      quarantinePath: actualPath,
      note: 'nothing was moved or unlocked; Holt never overwrites a restore destination',
    };
  }
  try {
    const [sourceParent, destinationParent] = await Promise.all([
      fs.stat(path.dirname(actualPath)), fs.stat(path.dirname(originalPath)),
    ]);
    if (!sourceParent.isDirectory() || !destinationParent.isDirectory()
        || sourceParent.dev !== destinationParent.dev) {
      return { ok: false, failedCount: 1, id: row.id, error: 'restore destination is not an existing directory on the quarantine filesystem', note: 'nothing was moved or unlocked' };
    }
  } catch (error) {
    return { ok: false, failedCount: 1, id: row.id, error: `restore destination could not be verified: ${error?.message ?? error}`, note: 'nothing was moved or unlocked' };
  }

  const moveArgv = ['git', 'worktree', 'move', '-f', '-f', actualPath, originalPath];
  const moved = await git(moveArgv.slice(1), { cwd, allowMutation: true })
    .catch((error) => ({ code: 1, stderr: String(error?.message ?? error) }));
  const [sourceKind, restoredKind] = await Promise.all([pathKind(actualPath), pathKind(originalPath)]);
  const physicallyRestored = sourceKind === 'missing' && restoredKind === 'directory';
  if (moved.code !== 0 && !physicallyRestored) {
    return {
      ok: false, failedCount: 1, id: row.id,
      error: moved.stderr?.trim() || 'git worktree move failed',
      quarantinePath: actualPath,
      note: 'the quarantine remains locked; no fallback copy, overwrite, or deletion was attempted',
    };
  }

  if (!(await registeredWorktree(originalPath, cwd))) {
    const repaired = await git(['worktree', 'repair', originalPath], { cwd, allowMutation: true })
      .catch((error) => ({ code: 1, stderr: String(error?.message ?? error) }));
    if (repaired.code !== 0 || !(await registeredWorktree(originalPath, cwd))) {
      return {
        ok: false, failedCount: 1, id: row.id, restored: true, retained: true,
        error: `directory restored, but Git registration could not be verified: ${repaired.stderr?.trim() || 'repair failed'}`,
        originalPath,
        note: 'the restored directory and its lock were retained; no deletion was attempted',
      };
    }
  }
  let afterBinding;
  try { afterBinding = await worktreeBinding(originalPath); } catch (error) {
    return { ok: false, failedCount: 1, id: row.id, restored: true, retained: true, error: `directory restored, but identity could not be verified: ${error?.message ?? error}`, originalPath };
  }
  if (!sameWorktreeBinding(beforeBinding, afterBinding)) {
    return { ok: false, failedCount: 1, id: row.id, restored: true, retained: true, error: 'directory restored, but its private admin or filesystem identity changed', originalPath };
  }
  const restoredHead = await git(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: originalPath })
    .catch(() => null);
  if (!restoredHead || restoredHead.code !== 0
      || (marker.head && restoredHead.stdout.trim() !== marker.head)) {
    return { ok: false, failedCount: 1, id: row.id, restored: true, retained: true, error: 'directory restored, but HEAD no longer matches the quarantine record', originalPath };
  }

  /** @type {string|null} */
  let markerWarning = null;
  try {
    await completeMarker(row._markerPath, marker.token, {
      ...marker,
      state: 'restored',
      restoredPath: originalPath,
      restoredAt: new Date().toISOString(),
      restoredHead: restoredHead.stdout.trim(),
      preservedLock: !lockWasAcquired,
    });
  } catch (error) {
    markerWarning = `restore completed, but its durable marker could not be updated: ${error?.message ?? error}`;
  }

  if (lockWasAcquired) {
    const unlocked = await git(['worktree', 'unlock', originalPath], { cwd, allowMutation: true })
      .catch((error) => ({ code: 1, stderr: String(error?.message ?? error) }));
    if (unlocked.code !== 0) {
      return {
        ok: false, failedCount: 1, id: row.id, restored: true, retained: true,
        error: `worktree restored but Holt's transit lock could not be released: ${unlocked.stderr?.trim() || 'unlock verification failed'}`,
        originalPath,
        unlockArgv: ['git', 'worktree', 'unlock', originalPath],
        markerWarning,
        note: 'the worktree is restored and still safely locked; no content was deleted',
      };
    }
  }

  await removeEmptyQuarantineRoot(path.dirname(actualPath));
  const journalFailures = [];
  await journal(cwd, {
    action: 'clean-restore', id: row.id,
    path: originalPath, quarantinePath: actualPath,
    branch: marker.branch ?? null, head: restoredHead.stdout.trim(),
    preservedLock: !lockWasAcquired,
  }, journalFailures);
  return withJournalWarning({
    ok: true,
    restored: true,
    id: row.id,
    originalPath,
    quarantinePath: actualPath,
    head: restoredHead.stdout.trim(),
    branch: marker.branch ?? null,
    preservedLock: !lockWasAcquired,
    markerWarning,
    actions: [{
      id: row.id, action: 'restored', path: originalPath,
      reason: !lockWasAcquired ? 'restored with its pre-existing Holt lock intact' : 'restored and Holt transit lock released',
    }],
    note: markerWarning
      ? `The worktree is restored. WARNING: ${markerWarning}`
      : 'The worktree is restored; no files or branches were deleted.',
  }, journalFailures);
}

/* ========================================================== QUARANTINE PURGE ==== */

/**
 * Give the exact quarantined HEAD a durable, never-overwritten ref before removing its checkout.
 *
 * A branch normally already keeps the commit reachable, but a detached worktree does not. The
 * purge path therefore anchors every HEAD, not just detached ones: one recovery contract, no
 * branch-name inference, and an immutable commit oid in the result. The ref name uses a bounded
 * digest of the workstream id plus the commit prefix so an attacker-controlled path cannot exceed
 * a filesystem component limit or create a refs directory/file conflict through slashes.
 */
async function anchorPurgeHead(cwd, id, head) {
  const idHash = createHash('sha256').update(String(id)).digest('hex').slice(0, 16);
  const baseRef = `refs/holt/purge/${idHash}-${head.slice(0, 16)}`;
  const MAX_CONTENTION_RETRIES = 24;

  for (let suffix = 1; suffix < 1000; suffix++) {
    const ref = suffix === 1 ? baseRef : `${baseRef}-${suffix}`;
    for (let attempt = 0; attempt <= MAX_CONTENTION_RETRIES; attempt++) {
      const wrote = await git(['update-ref', '--create-reflog', ref, head, ''], {
        cwd, allowMutation: true,
      }).catch((error) => ({ code: 1, stderr: String(error?.message ?? error) }));
      if (wrote.code === 0) return { ok: true, ref, commit: head, idempotent: false };

      const current = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd })
        .catch(() => ({ code: 1, stdout: '' }));
      if (current.code === 0) {
        if (current.stdout.trim() === head) {
          return { ok: true, ref, commit: head, idempotent: true };
        }
        break; // occupied by a different commit; allocate the next never-overwriting name
      }
      if (attempt === MAX_CONTENTION_RETRIES) {
        return {
          ok: false,
          error: wrote.stderr?.trim() || `could not create exact purge recovery ref ${ref}`,
        };
      }
      await new Promise((resolve) => { setTimeout(resolve, 2 + Math.random() * 25); });
    }
  }
  return { ok: false, error: 'purge recovery ref namespace exhausted' };
}

/**
 * Permanently remove one *clean* completed quarantine and reclaim its checkout storage.
 *
 * This is intentionally not part of `clean --apply`: quarantine is the reversible default and
 * purge is a separately named, dry-run-first destructive decision. It refuses modified,
 * untracked, ignored, unreadable, ambiguously identified, unlocked, tampered, or moved recovery
 * copies. On apply it first anchors the exact HEAD to refs/holt/purge/*, then releases only the
 * verified Holt lock and invokes `git worktree remove` WITHOUT --force. Git therefore performs a
 * final independent dirtiness check at the destructive boundary. If removal refuses, Holt puts
 * the exact recorded lock back and reports both outcomes.
 *
 * @param {string} cwd
 * @param {string} target quarantine id or exact original/quarantine path
 * @param {object} [opts]
 * @param {boolean} [opts.apply] physically remove (default: preview)
 * @param {Function|null} [opts.onBeforeRemove] deterministic race-test seam after preview evidence
 */
export async function purgeQuarantine(cwd, target, {
  apply = false, onBeforeRemove = null, ...opts
} = {}) {
  if (!target || typeof target !== 'string') {
    return { ok: false, dryRun: !apply, failedCount: 1, error: 'purge needs a quarantine id' };
  }

  const disc = await discover(cwd, opts);
  if (!disc.root) throw repoAbsenceError(disc, cwd);
  const rows = cleanRecoveryRows(disc.workstreams, 'quarantined');
  const idMatch = new Map(rows.map((row) => [row.id, row])).get(target) ?? null;
  const resolvedTarget = path.isAbsolute(target) ? await canonicalPath(target) : null;
  const pathMatches = rows.filter((row) => resolvedTarget
    && (samePathSync(row.quarantinePath, resolvedTarget)
      || (row.originalPath && samePathSync(row.originalPath, resolvedTarget))));
  const matches = idMatch
    ? [idMatch, ...pathMatches.filter((row) => row !== idMatch)]
    : pathMatches;
  if (matches.length !== 1) {
    return {
      ok: false,
      dryRun: !apply,
      failedCount: 1,
      error: matches.length
        ? `quarantine target '${target}' is ambiguous`
        : `no completed clean quarantine matches '${target}'`,
      available: rows.map(publicRecoveryRow),
      note: 'nothing was unlocked or removed',
    };
  }

  const row = matches[0];
  let marker;
  try {
    marker = await readCleanRecoveryMarker(row._markerPath);
  } catch (error) {
    return {
      ok: false, dryRun: !apply, failedCount: 1, id: row.id,
      error: error?.message ?? String(error), note: 'nothing was unlocked or removed',
    };
  }
  if (!path.isAbsolute(marker.originalPath ?? '') || !path.isAbsolute(marker.actualPath ?? '')) {
    return { ok: false, dryRun: !apply, failedCount: 1, id: row.id, error: 'quarantine marker paths are not absolute', note: 'nothing was unlocked or removed' };
  }
  const [actualPath, originalPath] = await Promise.all([
    canonicalPath(marker.actualPath), canonicalPath(marker.originalPath),
  ]);
  if (!samePathSync(actualPath, row.quarantinePath)
      || !samePathSync(originalPath, row.originalPath)
      || marker.token !== row._token) {
    return { ok: false, dryRun: !apply, failedCount: 1, id: row.id, error: 'quarantine marker changed after discovery', note: 'nothing was unlocked or removed' };
  }

  let binding;
  try { binding = await worktreeBinding(actualPath); } catch (error) {
    return { ok: false, dryRun: !apply, failedCount: 1, id: row.id, error: `quarantine identity could not be verified: ${error?.message ?? error}`, note: 'nothing was unlocked or removed' };
  }
  const lock = await lockState(actualPath, cwd);
  if (!lock.locked || !isHoltLock(lock.reason)) {
    return { ok: false, dryRun: !apply, failedCount: 1, id: row.id, error: 'quarantine is no longer protected by a Holt lock', note: 'nothing was unlocked or removed' };
  }
  if (!marker.lockReason || marker.lockReason !== lock.reason) {
    return { ok: false, dryRun: !apply, failedCount: 1, id: row.id, error: 'quarantine lock changed after it was recorded', note: 'nothing was unlocked or removed' };
  }

  const headResult = await git(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: actualPath })
    .catch(() => null);
  const head = headResult?.code === 0 ? headResult.stdout.trim() : '';
  if (!head || !marker.head || head !== marker.head || (row._recordedHead && head !== row._recordedHead)) {
    return { ok: false, dryRun: !apply, failedCount: 1, id: row.id, error: 'quarantined worktree HEAD changed after completion', note: 'nothing was unlocked or removed' };
  }

  // Include ignored paths explicitly. `git worktree remove` is the final independent clean check,
  // but its treatment of ignored files has varied; Holt never delegates those sole-copy bytes to
  // an implementation detail or version-dependent default.
  const status = await git([
    'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching',
  ], { cwd: actualPath }).catch((error) => ({ code: 1, stdout: '', stderr: String(error?.message ?? error) }));
  if (status.code !== 0) {
    return {
      ok: false, dryRun: !apply, failedCount: 1, id: row.id,
      error: `quarantine cleanliness could not be verified: ${status.stderr?.trim() || 'git status failed'}`,
      note: 'nothing was unlocked or removed',
    };
  }
  if (status.stdout.length > 0) {
    const entryCount = status.stdout.split('\0').filter(Boolean).length;
    return {
      ok: false, dryRun: !apply, failedCount: 1, blocked: true, id: row.id,
      originalPath, quarantinePath: actualPath, head, dirtyEntries: entryCount,
      error: `quarantine contains ${entryCount} modified, untracked, or ignored entr${entryCount === 1 ? 'y' : 'ies'}`,
      next: `restore with 'holt restore ${row.id}', or make a verified capture and clean the worktree before purging`,
      note: 'nothing was unlocked or removed',
    };
  }

  const plannedRef = `refs/holt/purge/${createHash('sha256').update(String(row.id)).digest('hex').slice(0, 16)}-${head.slice(0, 16)}`;
  if (!apply) {
    return {
      ok: true,
      dryRun: true,
      id: row.id,
      originalPath,
      quarantinePath: actualPath,
      head,
      branch: marker.branch ?? null,
      wouldAnchor: plannedRef,
      wouldRemove: [{
        id: row.id,
        path: actualPath,
        action: 'remove',
        why: 'completed quarantine is clean; exact HEAD will be anchored first and branch retained',
      }],
      removed: 0,
      note: `This completed quarantine is clean. Re-run 'holt purge ${row.id} --apply' to anchor its exact HEAD and permanently remove the checkout; its branch is not deleted.`,
    };
  }

  // Rebind immediately before the irreversible half; a path swapped since the checks above is
  // not the object the user authorised.
  let finalBinding;
  try { finalBinding = await worktreeBinding(actualPath); } catch (error) {
    return { ok: false, dryRun: false, failedCount: 1, id: row.id, error: `quarantine identity could not be revalidated: ${error?.message ?? error}`, note: 'nothing was unlocked or removed' };
  }
  if (!sameWorktreeBinding(binding, finalBinding)) {
    return { ok: false, dryRun: false, failedCount: 1, id: row.id, error: 'quarantine identity changed after verification', note: 'nothing was unlocked or removed' };
  }

  const anchored = await anchorPurgeHead(actualPath, row.id, head);
  if (!anchored.ok) {
    return {
      ok: false, dryRun: false, failedCount: 1, id: row.id,
      error: `exact purge recovery ref could not be written: ${anchored.error}`,
      note: 'the quarantine remains locked; nothing was removed',
    };
  }

  if (onBeforeRemove) await /** @type {(row: any) => any} */ (onBeforeRemove)({
    id: row.id, originalPath, quarantinePath: actualPath, head, recoveryRef: anchored.ref,
  });

  const unlocked = await git(['worktree', 'unlock', actualPath], { cwd, allowMutation: true })
    .catch((error) => ({ code: 1, stderr: String(error?.message ?? error) }));
  if (unlocked.code !== 0) {
    return {
      ok: false, dryRun: false, failedCount: 1, id: row.id,
      error: `quarantine lock could not be released: ${unlocked.stderr?.trim() || 'git worktree unlock failed'}`,
      recoveryRef: anchored.ref, commit: head,
      note: 'the exact HEAD is anchored and the quarantine remains in place',
    };
  }

  const removed = await git(['worktree', 'remove', actualPath], { cwd, allowMutation: true })
    .catch((error) => ({ code: 1, stderr: String(error?.message ?? error) }));
  const [pathAfter, registeredAfter] = await Promise.all([
    pathKind(actualPath), registeredWorktree(actualPath, cwd),
  ]);
  const fullyRemoved = removed.code === 0 && pathAfter === 'missing' && !registeredAfter;
  if (!fullyRemoved) {
    let relocked = false;
    let relockError = '';
    if (pathAfter === 'directory' && registeredAfter) {
      const relock = await git(['worktree', 'lock', '--reason', marker.lockReason, actualPath], {
        cwd, allowMutation: true,
      }).catch((error) => ({ code: 1, stderr: String(error?.message ?? error) }));
      const lockAfter = await lockState(actualPath, cwd);
      relocked = relock.code === 0 && lockAfter.locked && lockAfter.reason === marker.lockReason;
      relockError = relock.stderr?.trim() || (relocked ? '' : 'lock verification failed');
    }
    return {
      ok: false, dryRun: false, failedCount: 1, id: row.id,
      error: removed.stderr?.trim() || 'git worktree remove did not complete cleanly',
      recoveryRef: anchored.ref, commit: head,
      quarantinePath: pathAfter === 'missing' ? null : actualPath,
      registered: registeredAfter, relocked, relockError: relockError || null,
      note: relocked
        ? 'Git refused the non-forced removal; the exact HEAD remains anchored and the quarantine lock was restored.'
        : 'Removal did not complete; the exact HEAD remains anchored. Inspect the reported path and registration before retrying.',
    };
  }

  await removeEmptyQuarantineRoot(path.dirname(actualPath));
  const journalFailures = [];
  await journal(cwd, {
    action: 'clean-purge', id: row.id,
    path: originalPath, quarantinePath: actualPath,
    branch: marker.branch ?? null, head,
    ref: anchored.ref, commit: head,
    evidence: ['completed quarantine marker verified', 'identity and lock unchanged', 'worktree clean including ignored paths', 'git non-forced removal succeeded'],
  }, journalFailures);
  return withJournalWarning({
    ok: true,
    dryRun: false,
    purged: true,
    id: row.id,
    originalPath,
    quarantinePath: actualPath,
    head,
    branch: marker.branch ?? null,
    recoveryRef: anchored.ref,
    commit: head,
    removed: 1,
    branchesRemoved: 0,
    restoreArgv: ['git', 'worktree', 'add', originalPath, head],
    restore: ['git', 'worktree', 'add', originalPath, head].map(shellQuote).join(' '),
    actions: [{ id: row.id, path: actualPath, action: 'purged', reason: 'clean quarantine removed without force after exact HEAD anchoring' }],
    note: `The clean quarantined checkout was removed and its exact HEAD remains reachable at ${anchored.ref}; no branch was deleted.`,
  }, journalFailures);
}
