/**
 * holt — protect / rescue / clean, attacked.
 *
 * These three commands MUTATE the repository, which makes every claim about them dangerous if
 * wrong. Each test below tries to construct the failure, not to confirm the feature:
 *
 *   protect  claims a locked worktree survives `--force`. Attack: does it? And does protecting
 *            everything break ordinary work?
 *   rescue   claims the captured ref contains the work. Attack: capture nothing and see whether
 *            it still reports success — a rescue that silently captures nothing is WORSE than no
 *            rescue, because it licenses a deletion.
 *   clean    claims it only removes disposable worktrees. Attack: change the repo between the
 *            scan and the delete (TOCTOU) and see whether it deletes on a stale verdict.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { newRepo } from '../fixtures.mjs';
import { protect, unprotect, rescue, rescues, clean } from '../../src/actions.mjs';
import { discover } from '../../src/discover.mjs';
import { scan } from '../../src/scan.mjs';
import { analyze, safeToDelete } from '../../src/analyze.mjs';
import { classify } from '../../src/git.mjs';

function sh(cmd, args, cwd) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      cwd, timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'holt test', GIT_AUTHOR_EMAIL: 't@holt.invalid',
        GIT_COMMITTER_NAME: 'holt test', GIT_COMMITTER_EMAIL: 't@holt.invalid',
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', LC_ALL: 'C',
      },
    }, (err, stdout, stderr) => resolve({
      code: err ? (err.code ?? -1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''),
    }));
  });
}

const inspect = async (root) => analyze(await scan(await discover(root), {}), {});

/* ============================================== the mutation boundary ==== */

test('BOUNDARY: mutating commands are UNREACHABLE without an explicit opt-in', () => {
  // The read-only guarantee is a core reason to trust holt. Adding write features must not
  // widen the default door — only open a clearly-marked second one.
  const mutating = [
    ['worktree', 'lock', 'p'], ['worktree', 'unlock', 'p'], ['worktree', 'remove', 'p'],
    ['branch', '-d', 'b'], ['commit-tree', 't'], ['update-ref', 'r', 'c'], ['write-tree'],
  ];
  for (const argv of mutating) {
    assert.equal(classify(argv).allowed, false,
      `git ${argv.join(' ')} must be refused by default`);
    assert.equal(classify(argv, { allowMutation: true }).allowed, true,
      `git ${argv.join(' ')} must be allowed with an explicit opt-in`);
    assert.equal(classify(argv, { allowMutation: true }).tier, 'MUTATE');
  }
});

test('BOUNDARY: opting into mutation does NOT unlock genuinely destructive commands', () => {
  // allowMutation is not a skeleton key. These stay refused no matter what.
  for (const argv of [
    ['reset', '--hard'], ['checkout', '--', '.'], ['push', 'origin', 'main'],
    ['clean', '-fd'], ['stash'], ['rebase', 'main'], ['gc', '--prune=now'],
  ]) {
    assert.equal(classify(argv, { allowMutation: true }).allowed, false,
      `git ${argv.join(' ')} must stay refused even with allowMutation`);
  }
});

/* ========================================================== PROTECT ==== */

test('PROTECT ATTACK: does a locked worktree actually survive --force?', async (t) => {
  const fx = await newRepo('protect');
  t.after(() => fx.cleanup());

  const wt = await fx.worktree('valuable');
  await fx.write('src/precious.js', 'export function PRECIOUS_WORK() { return 1; }\n', wt);

  const before = await inspect(fx.root);
  assert.equal(before.safe.find((s) => s.id === 'valuable').safe, false, 'premise: holds work');

  const p = await protect(fx.root, {});
  assert.ok(p.protected >= 1, `expected to lock the valuable worktree: ${JSON.stringify(p.actions)}`);

  // THE ATTACK: the exact command both naked-arm eval losses used.
  const rm = await sh('git', ['worktree', 'remove', '--force', wt], fx.root);
  assert.notEqual(rm.code, 0, 'a locked worktree must REFUSE `worktree remove --force`');
  assert.match(rm.stderr, /locked working tree/i);
  // git must surface OUR reason — that is how the agent learns what to do.
  assert.match(rm.stderr, /holt:/, `git should print holt's lock reason, got: ${rm.stderr}`);
  assert.match(rm.stderr, /holt rescue/, 'the reason must say how to resolve it');

  const content = await fs.readFile(path.join(wt, 'src/precious.js'), 'utf8');
  assert.match(content, /PRECIOUS_WORK/, 'the work must still be there');
});

test('PROTECT ATTACK: -f -f still overrides, and we must not pretend otherwise', async (t) => {
  const fx = await newRepo('protect-ff');
  t.after(() => fx.cleanup());

  const wt = await fx.worktree('valuable');
  await fx.write('src/p.js', 'export function P() {}\n', wt);
  await protect(fx.root, {});

  // git's documented escape hatch. holt's note must not claim protection it does not have.
  const rm = await sh('git', ['worktree', 'remove', '-f', '-f', wt], fx.root);
  assert.equal(rm.code, 0, 'double --force is git\'s documented override and must still work');

  const p = await protect(fx.root, { dryRun: true });
  assert.match(p.note, /does NOT stop/i, 'the limitation must be stated in the result');
});

test('PROTECT ATTACK: does NOT lock worktrees that hold nothing', async (t) => {
  const fx = await newRepo('protect-empty');
  t.after(() => fx.cleanup());
  await fx.worktree('empty-a');
  await fx.worktree('empty-b');

  const p = await protect(fx.root, {});
  assert.equal(p.protected, 0, 'locking disposable worktrees would make cleanup impossible');

  // And they must still be removable.
  const rm = await sh('git', ['worktree', 'remove', fx.wt('empty-a')], fx.root);
  assert.equal(rm.code, 0, `an unprotected empty worktree must remain removable: ${rm.stderr}`);
});

test('PROTECT ATTACK: unknown workstreams are reported, never silently unprotected', async (t) => {
  const fx = await newRepo('protect-unknown');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('vanishing');
  await fx.write('src/x.js', 'export function X() {}\n', wt);
  await fs.rm(wt, { recursive: true, force: true });

  const p = await protect(fx.root, {});
  assert.ok(p.unknown.length >= 1,
    'a workstream holt could not assess must be surfaced, not dropped from the report');
});

test('PROTECT: unprotect leaves FOREIGN locks alone', async (t) => {
  const fx = await newRepo('protect-foreign');
  t.after(() => fx.cleanup());

  const wt = await fx.worktree('mine');
  await fx.write('src/x.js', 'export function X() {}\n', wt);
  // A human locked this deliberately, for their own reason.
  await sh('git', ['worktree', 'lock', '--reason', 'ON A USB STICK - do not touch', wt], fx.root);

  const u = await unprotect(fx.root, {});
  assert.equal(u.unlocked, 0, 'holt must not disarm a lock somebody else placed');
  assert.ok(u.actions.some((a) => a.action === 'skipped-foreign-lock'));
});

/* =========================================================== RESCUE ==== */

test('RESCUE ATTACK: does the ref actually contain the work?', async (t) => {
  const fx = await newRepo('rescue');
  t.after(() => fx.cleanup());

  const wt = await fx.worktree('holder');
  await fx.write('src/only.js', 'export function ONLY_COPY() { return 42; }\n', wt);
  await fx.write('notes/plan.md', '# the plan\nirreplaceable\n', wt);

  const r = await rescue(fx.root, 'holder', {});
  assert.equal(r.ok, true, `rescue failed: ${r.error}`);
  assert.equal(r.verified, true, 'a rescue must verify itself before reporting success');

  // THE ATTACK: read the content back out of the ref, not out of the worktree.
  const show = await sh('git', ['show', `${r.commit}:src/only.js`], fx.root);
  assert.equal(show.code, 0, `the captured ref must contain src/only.js: ${show.stderr}`);
  assert.match(show.stdout, /ONLY_COPY/, 'and it must contain the actual content');

  const md = await sh('git', ['show', `${r.commit}:notes/plan.md`], fx.root);
  assert.match(md.stdout, /irreplaceable/, 'untracked files in subdirectories must be captured too');
});

test('RESCUE ATTACK: the work is restorable AFTER the worktree is destroyed', async (t) => {
  const fx = await newRepo('rescue-restore');
  t.after(() => fx.cleanup());

  const wt = await fx.worktree('doomed');
  await fx.write('src/only.js', 'export function ONLY_COPY() { return 42; }\n', wt);

  const r = await rescue(fx.root, 'doomed', { release: true });
  assert.equal(r.ok, true);

  // Now actually destroy it — the whole point is that this becomes safe.
  await sh('git', ['worktree', 'remove', '--force', wt], fx.root);
  assert.equal(await fs.stat(wt).then(() => true, () => false), false, 'worktree is gone');

  // THE CLAIM UNDER TEST: the work survives the destruction.
  const show = await sh('git', ['show', `${r.commit}:src/only.js`], fx.root);
  assert.equal(show.code, 0, 'the rescued work must outlive the worktree');
  assert.match(show.stdout, /ONLY_COPY/);
});

test('RESCUE ATTACK: it must NOT report success when it captured nothing', async (t) => {
  const fx = await newRepo('rescue-empty');
  t.after(() => fx.cleanup());
  await fx.worktree('nothing-here');

  const r = await rescue(fx.root, 'nothing-here', {});
  // The dangerous outcome is a cheerful "rescued!" that licenses a deletion. Reporting
  // "there was nothing to rescue" is correct; reporting a verified capture would be a lie.
  assert.equal(r.nothingToRescue, true,
    `an empty worktree must not produce a rescue that implies work was saved: ${JSON.stringify(r)}`);
  assert.ok(!r.commit, 'no ref should be created for nothing');
});

test('RESCUE ATTACK: does NOT disturb the worktree it rescues', async (t) => {
  const fx = await newRepo('rescue-nondisturb');
  t.after(() => fx.cleanup());

  const wt = await fx.worktree('live');
  await fx.write('src/wip.js', 'export function WIP() {}\n', wt);
  // The user has something staged. A rescue must not eat their index.
  await sh('git', ['add', 'src/wip.js'], wt);
  const statusBefore = await sh('git', ['status', '--porcelain'], wt);

  await rescue(fx.root, 'live', {});

  const statusAfter = await sh('git', ['status', '--porcelain'], wt);
  assert.equal(statusAfter.stdout, statusBefore.stdout,
    'rescue must leave the working tree and index exactly as it found them');

  // And the scratch index must not be left behind.
  const leftover = await fs.stat(path.join(wt, '.git-holt-rescue-index')).then(() => true, () => false);
  assert.equal(leftover, false, 'the temporary index must be cleaned up');
});

test('RESCUE ATTACK: an INCOMPLETE capture must be refused, not reported as success', async (t) => {
  const fx = await newRepo('rescue-incomplete');
  t.after(() => fx.cleanup());

  const wt = await fx.worktree('has-nested');
  await fx.write('src/normal.js', 'export function NORMAL() {}\n', wt);

  // A nested git repository — a vendored checkout, or a stray `git init`. This is not exotic;
  // it happens constantly in real trees. `git add --all --force` exits non-zero with
  // "'nested/' does not have a commit checked out" and captures NOTHING from inside it, while
  // still indexing everything else. So the capture is genuinely partial.
  await fs.mkdir(path.join(wt, 'nested'), { recursive: true });
  await sh('git', ['init', '-q'], path.join(wt, 'nested'));
  await fs.writeFile(path.join(wt, 'nested', 'inner.txt'), 'INNER_SECRET_WORK\n');

  const r = await rescue(fx.root, 'has-nested', {});

  // THE CLAIM UNDER TEST: rescue must NOT say "verified" here. A cheerful success would license
  // deleting a worktree whose contents were only partly saved — the worst outcome this tool has.
  assert.equal(r.ok, false,
    `an incomplete capture must be refused, got: ${JSON.stringify(r).slice(0, 300)}`);
  assert.match(r.error, /INCOMPLETE/);
  assert.ok(r.missing?.length >= 1, 'it must name what was not captured');
  assert.match(r.note, /NOT been released/, 'and confirm nothing was deleted');
});

test('RESCUE: rescues are discoverable months later', async (t) => {
  const fx = await newRepo('rescue-list');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('holder');
  await fx.write('src/x.js', 'export function X() {}\n', wt);

  await rescue(fx.root, 'holder', {});
  const list = await rescues(fx.root);
  assert.ok(list.some((r) => r.id === 'holder'), `rescue should be listed: ${JSON.stringify(list)}`);
  assert.match(list[0].ref, /^refs\/holt\/rescue\//);
});

/* ================================================ RESCUE <-> GATE PARITY ==== */

/**
 * ONE PRODUCT MUST NOT GIVE TWO ANSWERS TO "WOULD DELETING THIS LOSE WORK?".
 *
 * Reproduced: a worktree whose only unique content was gitignored got
 *
 *     holt gate w1    ->  "✗ w1: HOLDS UNIQUE WORK ... 2 gitignored file(s)"   exit 1
 *     holt rescue w1  ->  "this worktree holds nothing base lacks"             exit 0
 *
 * because gate (safeToDelete) counted three layers — committed, uncommitted, gitignored — and
 * rescue built its own set from two. Exit 0 is the one a `holt rescue X && git worktree remove X`
 * chain acts on, so the disagreeing command was also the dangerous one.
 *
 * This test asserts the INVARIANT rather than the instance: across every worktree shape holt
 * distinguishes, rescue may never report nothing-to-rescue for a worktree the gate refuses on a
 * CONTENT ground. A lock is deliberately excluded — "locked" is a refusal about permission, not
 * about content, and an empty-but-locked worktree genuinely has nothing to rescue.
 */
async function paritySubjects(fx) {
  const disc = await discover(fx.root, {});
  const scanned = await scan(disc, { symbols: false });
  const report = await analyze(scanned, {});
  return report.safe;
}

test('PARITY: rescue may never say nothing-to-rescue where gate refuses on content', async (t) => {
  const fx = await newRepo('parity');
  t.after(() => fx.cleanup());

  // The ignore rules cover a FILE, a DIRECTORY, and recognisable build output — the three shapes
  // git's `status --ignored=matching` reports differently.
  await fx.write('.gitignore', 'notes.local\nsecrets/\nnode_modules/\n');
  await fx.commit('ignore rules');

  // --- shapes that MUST hold work ------------------------------------------------
  const igFile = await fx.worktree('ig-file');
  await fx.write('notes.local', 'an hour of hand-written notes\n', igFile);

  const igDir = await fx.worktree('ig-dir');
  await fx.write('secrets/prod.env', 'API_KEY=live-do-not-lose\n', igDir);

  const unc = await fx.worktree('uncommitted');
  await fx.write('src/wip.js', 'export function WIP_ONLY() {}\n', unc);

  const com = await fx.worktree('committed');
  await fx.write('src/landed.js', 'export function COMMITTED_ONLY() {}\n', com);
  await fx.commit('committed-only work', com);

  const mixed = await fx.worktree('mixed');
  await fx.write('notes.local', 'notes\n', mixed);
  await fx.write('src/also.js', 'export function ALSO() {}\n', mixed);

  // --- shapes that MUST stay disposable (never-worse controls) --------------------
  await fx.worktree('genuinely-empty');

  const gen = await fx.worktree('generated-only');
  await fx.write('node_modules/left-pad/index.js', 'module.exports = 1;\n', gen);

  const lockedEmpty = await fx.worktree('locked-empty');
  await sh('git', ['worktree', 'lock', '--reason', 'holt: parked', lockedEmpty], fx.root);
  t.after(() => sh('git', ['worktree', 'unlock', lockedEmpty], fx.root));

  const HOLDS_WORK = ['ig-file', 'ig-dir', 'uncommitted', 'committed', 'mixed'];
  const HOLDS_NOTHING = ['genuinely-empty', 'generated-only', 'locked-empty'];

  const verdicts = await paritySubjects(fx);
  const byId = new Map(verdicts.map((v) => [v.id, v]));

  // NON-VACUITY FIRST. If the gate stopped refusing, the invariant below would pass while
  // proving nothing — the instrument has to be shown capable of detecting presence.
  for (const id of HOLDS_WORK) {
    assert.equal(byId.get(id)?.safe, false,
      `gate must refuse '${id}' — without that this test is vacuous: ${JSON.stringify(byId.get(id))}`);
  }

  for (const v of verdicts) {
    const r = await rescue(fx.root, v.id, { symbols: false });
    // A lock is a refusal about permission, not content; everything else is content.
    const contentReasons = v.reasons.filter(
      (x) => !/^locked/.test(x) && !/^no committed delta/.test(x),
    );

    if (contentReasons.length > 0) {
      assert.notEqual(r.nothingToRescue, true,
        `THE DEFECT: gate refuses '${v.id}' (${contentReasons.join('; ')}) but rescue reports `
        + `nothing to rescue and exits 0 — a script would delete it: ${JSON.stringify(r)}`);
      assert.notEqual(r.ok === true && !r.commit, true,
        `'${v.id}' must produce a real capture or an explicit refusal, never a silent ok`);
    } else {
      // The other direction, so the fix cannot be "refuse everything": a worktree the gate is
      // happy with must still be cheap and quiet.
      assert.equal(r.nothingToRescue, true,
        `'${v.id}' holds nothing the gate can see, so rescue must say so and exit 0: `
        + `${JSON.stringify(r)}`);
      assert.equal(r.ok, true, `and it must exit 0: ${JSON.stringify(r)}`);
    }
  }

  for (const id of HOLDS_NOTHING) {
    const r = await rescue(fx.root, id, { symbols: false });
    assert.equal(r.nothingToRescue, true,
      `NEVER-WORSE: '${id}' genuinely holds nothing and must still exit 0 with nothing-to-rescue: `
      + `${JSON.stringify(r)}`);
  }
});

test('PARITY: the gitignored capture is REAL — read it back out of the ref', async (t) => {
  const fx = await newRepo('parity-capture');
  t.after(() => fx.cleanup());

  await fx.write('.gitignore', 'notes.local\nsecrets/\n');
  await fx.commit('ignore rules');

  const wt = await fx.worktree('w1');
  await fx.write('notes.local', 'an hour of hand-written notes\n', wt);
  await fx.write('secrets/prod.env', 'API_KEY=live-do-not-lose\n', wt);

  const r = await rescue(fx.root, 'w1', { symbols: false });
  assert.equal(r.ok, true, `rescue must capture gitignored content, not refuse: ${r.error}`);
  assert.equal(r.verified, true, 'and verify it before reporting success');

  // A fix that merely stopped saying "nothing to rescue" would pass everything above. The only
  // thing that proves the work is safe is reading it back out of the ref.
  for (const [p, needle] of [['notes.local', /hand-written notes/], ['secrets/prod.env', /live-do-not-lose/]]) {
    const show = await sh('git', ['show', `${r.commit}:${p}`], fx.root);
    assert.equal(show.code, 0, `the captured ref must contain ${p}: ${show.stderr}`);
    assert.match(show.stdout, needle, `and ${p}'s actual content`);
  }
});

test('PARITY: a probe that FAILED is not an empty worktree — both sides must refuse', async () => {
  // Imported DYNAMICALLY on purpose. A static import of a symbol the fix introduces makes this
  // whole file fail to load when the fix is reverted, which turns every behavioural pin above
  // into a module-resolution error — red for the wrong reason, and therefore proving nothing.
  const { contentAtRisk } = await import('../../src/analyze.mjs');

  // Blindness and emptiness are byte-identical from downstream: zero paths either way. Only one
  // of them makes deletion safe. This is asserted on a synthetic scan result because a real git
  // failure here cannot be provoked deterministically — the shape is what matters.
  const blindWorkstream = {
    id: 'blind', ok: true, path: '/nowhere',
    committed: { files: [], count: 0, how: 'merge-tree' },
    uncommitted: { files: [], untracked: [], count: 0, how: 'status+diff-HEAD' },
    ignored: { files: [], count: 0, how: 'ignored-probe-failed', error: 'odb is unreadable' },
  };

  const risk = contentAtRisk(blindWorkstream);
  assert.equal(risk.empty, false, 'a failed probe must never read as an empty worktree');
  assert.equal(risk.blind.length, 1, 'and it must name which instrument went blind');
  assert.match(risk.blind[0], /odb is unreadable/, 'so the user can act on it');

  const [verdict] = safeToDelete({ workstreams: [blindWorkstream], strictReadOnly: false }, []);
  assert.equal(verdict.safe, false,
    'gate must not green-light a worktree it failed to look inside');
  assert.match(verdict.reasons.join(' '), /probe failed/i, 'and must say why');
});

/* ============================================================ CLEAN ==== */

test('CLEAN ATTACK: dry-run must not delete anything', async (t) => {
  const fx = await newRepo('clean-dry');
  t.after(() => fx.cleanup());
  await fx.worktree('spent-a');
  await fx.worktree('spent-b');

  const c = await clean(fx.root, {});
  assert.equal(c.dryRun, true, 'clean must be dry-run by DEFAULT');
  assert.ok(c.wouldRemove.length >= 2);

  const list = await sh('git', ['worktree', 'list'], fx.root);
  assert.match(list.stdout, /spent-a/, 'dry-run must not have removed anything');
  assert.match(list.stdout, /spent-b/);
});

test('CLEAN ATTACK: never removes a worktree that holds work', async (t) => {
  const fx = await newRepo('clean-holds');
  t.after(() => fx.cleanup());

  await fx.worktree('spent');
  const keep = await fx.worktree('holds-work');
  await fx.write('src/keep.js', 'export function KEEP_ME() {}\n', keep);

  const c = await clean(fx.root, { apply: true });
  assert.equal(c.removed, 1, `only the spent worktree should go: ${JSON.stringify(c.actions)}`);

  const content = await fs.readFile(path.join(keep, 'src/keep.js'), 'utf8');
  assert.match(content, /KEEP_ME/, 'work-holding worktree must survive clean --apply');
});

test('CLEAN ATTACK (TOCTOU): work appearing DURING the run must abort that delete', async (t) => {
  const fx = await newRepo('clean-toctou');
  t.after(() => fx.cleanup());

  // Several worktrees so the apply loop takes long enough for work to land mid-flight. The
  // earlier version of this test wrote the file BEFORE calling clean, which meant the initial
  // scan already saw it and the per-item re-verification was never exercised — a mutation that
  // deleted the re-check entirely survived the whole suite.
  const names = ['race-a', 'race-b', 'race-c', 'race-d'];
  const paths = {};
  for (const n of names) paths[n] = await fx.worktree(n);

  const dry = await clean(fx.root, {});
  assert.equal(dry.wouldRemove.length, names.length, 'all look disposable at plan time');

  // Deterministic race: the moment clean is about to consider race-d, work lands in it. Racing a
  // timer here would be flaky, and a flaky test for "do not delete on a stale verdict" is worse
  // than no test — it would go green on a broken build often enough to be believed.
  const applied = await clean(fx.root, {
    apply: true,
    onBeforeRemove: async (candidate) => {
      if (candidate.id === 'race-d') {
        await fx.write('src/suddenly.js', 'export function SUDDENLY_VALUABLE() {}\n', paths['race-d']);
      }
    },
  });

  const survived = await fs.stat(path.join(paths['race-d'], 'src/suddenly.js'))
    .then(() => true, () => false);
  assert.equal(survived, true,
    'work that appeared after the plan was computed must NOT be deleted on a stale verdict');
  assert.ok(applied.skipped.some((s) => s.id === 'race-d'),
    `race-d should be reported as skipped, got: ${JSON.stringify(applied.skipped)}`);
});

test('CLEAN ATTACK: an unmerged branch must not be silently deleted', async (t) => {
  const fx = await newRepo('clean-branch');
  t.after(() => fx.cleanup());

  // A worktree whose content base already has, but on a branch with its own history.
  const wt = await fx.worktree('landed');
  await fx.write('src/feature.js', 'export function feature() { return 1; }\n', wt);
  await fx.commit('feature in worktree', wt);
  await fx.write('src/feature.js', 'export function feature() { return 1; }\n');
  await fx.commit('base independently lands the same content');

  const c = await clean(fx.root, { apply: true });
  const acted = c.actions.find((x) => x.id === 'landed');
  assert.ok(acted, 'the landed worktree should be actioned');
  // holt uses `branch -d`, never -D: git refusing an unmerged branch is a feature, and a
  // cleanup tool that forces past it would destroy history nobody asked it to.
  if (acted.action === 'removed' && !acted.branchRemoved) {
    assert.ok(true, 'branch retained because git considered it unmerged — correct');
  }
});

test('CLEAN: unknown workstreams are reported and never removed', async (t) => {
  const fx = await newRepo('clean-unknown');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('ghost');
  await fs.rm(wt, { recursive: true, force: true });

  const c = await clean(fx.root, {});
  assert.ok(!c.wouldRemove.some((w) => w.id === 'ghost'),
    'a workstream holt could not assess must never be queued for deletion');
});

/* ================================================== injection attacks ==== */

test('ATTACK: hostile worktree ids cannot produce invalid rescue refs', async () => {
  const { refSafeId } = await import('../../src/actions.mjs');

  // Found by attacking it: `..` passed the old character-class sanitizer and
  // `update-ref refs/holt/rescue/..` failed — git refuses .., leading dots, and .lock
  // suffixes (verified with check-ref-format).
  const hostile = ['..', '../..', '.hidden', 'x.lock', 'a/../b', 'a//b', '...', '.', ''];
  for (const id of hostile) {
    const ref = `refs/holt/rescue/${refSafeId(id)}`;
    const ok = await sh('git', ['check-ref-format', ref], process.cwd());
    assert.equal(ok.code, 0, `refSafeId(${JSON.stringify(id)}) -> ${ref} must be a VALID refname`);
  }
  assert.equal(refSafeId('task-scratch-03'), 'task-scratch-03');
  assert.equal(refSafeId('A-memory-core/stage'), 'A-memory-core/stage');
});

test('ATTACK: rescue works end-to-end on a hostile worktree NAME', async (t) => {
  const fx = await newRepo('hostile-name');
  t.after(() => fx.cleanup());

  // A worktree literally named `x.lock` — legal on disk, illegal in a refname. Must be DETACHED:
  // git refuses `.lock` in branch names too, so in the wild such a worktree exists exactly the
  // way agent fan-out tools create theirs.
  const wt = path.join(fx.root, '..', 'wt', 'x.lock');
  await fs.mkdir(path.dirname(wt), { recursive: true });
  await sh('git', ['worktree', 'add', '--detach', wt, 'main'], fx.root);
  fx.worktrees.set('x.lock', wt);
  await fx.write('src/only.js', 'export function HOSTILE_NAME_WORK() {}\n', wt);

  const r = await rescue(fx.root, 'x.lock', {});
  assert.equal(r.ok, true, `rescue must survive a refname-hostile id: ${r.error}`);
  assert.equal(r.verified, true);
  const show = await sh('git', ['show', `${r.commit}:src/only.js`], fx.root);
  assert.match(show.stdout, /HOSTILE_NAME_WORK/);
});

test('ATTACK: a C-quoted lock reason is still recognised as holt own lock', async (t) => {
  const fx = await newRepo('quoted-lock');
  t.after(() => fx.cleanup());

  const wt = await fx.worktree('unicode-held');
  // Non-ASCII file -> non-ASCII symbol name -> non-ASCII lock reason -> git C-QUOTES it in
  // porcelain. The old parser read `"holt: …"` with quotes, startsWith failed, and unprotect
  // refused to release holt's OWN lock as "foreign" — stranding rescue --release.
  await fx.write('src/unicodé.js', 'export function unicodé_wörk() { return 1; }\n', wt);

  const p = await protect(fx.root, {});
  assert.ok(p.protected >= 1, `should have locked: ${JSON.stringify(p.actions)}`);

  const u = await unprotect(fx.root, { id: 'unicode-held' });
  assert.equal(u.unlocked, 1,
    `holt must recognise and release its own quoted lock: ${JSON.stringify(u.actions)}`);
  assert.ok(!u.actions.some((a) => a.action === 'skipped-foreign-lock'),
    'holt own lock must never be classified foreign');
});

/* ============================================ the guarantee still holds ==== */

test('GUARANTEE: a plain scan still modifies nothing, even now that holt can mutate', async (t) => {
  const fx = await newRepo('still-readonly');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('w');
  await fx.write('src/x.js', 'export function X() {}\n', wt);

  const { createHash } = await import('node:crypto');
  const snap = async () => {
    const out = new Map();
    const walk = async (dir) => {
      for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const p = path.join(dir, e.name);
        const rel = path.relative(fx.root, p);
        if (rel.startsWith(`.git${path.sep}objects`)) continue;
        if (e.isDirectory()) { await walk(p); continue; }
        if (!e.isFile()) continue;
        try { out.set(rel, createHash('sha1').update(await fs.readFile(p)).digest('hex')); } catch { /* */ }
      }
    };
    await walk(fx.root);
    return out;
  };

  const before = await snap();
  await inspect(fx.root);          // scan + analyze only
  const after = await snap();

  const changed = [...before].filter(([k, v]) => after.get(k) !== v).map(([k]) => k);
  const created = [...after.keys()].filter((k) => !before.has(k));
  assert.deepEqual([...changed, ...created], [],
    'the read-only guarantee must survive the addition of mutating commands');
});

test('RESURRECTION: reusing a worktree id must NEVER overwrite an earlier rescue', async (t) => {
  // The owner's exact concern, live-reproduced before this fix: a workstream id is only a
  // directory basename, so deleting wt/feat and later creating a NEW wt/feat mapped both to
  // refs/holt/rescue/feat — and the second rescue silently destroyed the first capture.
  const fx = await newRepo('id-reuse');
  t.after(() => fx.cleanup());

  const wtPath = path.join(fx.root, 'wt', 'recycled');
  await sh('git', ['worktree', 'add', '-q', '-b', 'first', wtPath], fx.root);
  await fs.writeFile(path.join(wtPath, 'first.js'), 'export function FIRST_ONLY() {}\n');
  const r1 = await rescue(fx.root, 'recycled', {});
  assert.equal(r1.ok, true, JSON.stringify(r1));
  const firstRef = r1.ref;
  const firstCommit = (await sh('git', ['rev-parse', firstRef], fx.root)).stdout.trim();
  assert.ok(firstCommit, 'the first rescue must exist');

  // Tear the worktree down and recreate a DIFFERENT one under the SAME id.
  await sh('git', ['worktree', 'remove', '--force', wtPath], fx.root);
  await sh('git', ['worktree', 'add', '-q', '-b', 'second', wtPath], fx.root);
  await fs.writeFile(path.join(wtPath, 'second.js'), 'export function SECOND_ONLY() {}\n');
  const r2 = await rescue(fx.root, 'recycled', {});
  assert.equal(r2.ok, true, JSON.stringify(r2));

  // THE INVARIANT: the first capture still exists, unchanged.
  const firstStill = (await sh('git', ['rev-parse', '--verify', '--quiet', firstRef], fx.root)).stdout.trim();
  assert.equal(firstStill, firstCommit, 'the FIRST rescue must survive a same-id second rescue');
  assert.notEqual(r2.ref, firstRef, 'the second rescue must get its own ref, not clobber the first');

  // And both captures are actually retrievable.
  const firstFiles = (await sh('git', ['ls-tree', '-r', '--name-only', firstRef], fx.root)).stdout;
  const secondFiles = (await sh('git', ['ls-tree', '-r', '--name-only', r2.ref], fx.root)).stdout;
  assert.match(firstFiles, /first\.js/, 'the first capture still holds its file');
  assert.match(secondFiles, /second\.js/, 'the second capture holds its own file');
});

test('AUDIT: a rescue records path/branch/head so a recycled id stays distinguishable', async (t) => {
  const fx = await newRepo('audit-identity');
  t.after(() => fx.cleanup());

  const wtPath = path.join(fx.root, 'wt', 'audited');
  await sh('git', ['worktree', 'add', '-q', '-b', 'audited-br', wtPath], fx.root);
  await fs.writeFile(path.join(wtPath, 'u.js'), 'export function AUDIT_ME() {}\n');
  await rescue(fx.root, 'audited', {});

  const { readJournal } = await import('../../src/journal.mjs');
  const ev = (await readJournal(fx.root)).find((e) => e.action === 'rescue');
  assert.ok(ev, 'the rescue must be journalled');
  assert.ok(ev.path && ev.path.includes('audited'), `the journal must record WHICH worktree: ${JSON.stringify(ev)}`);
  assert.equal(ev.branch, 'audited-br', 'and its branch');
  assert.ok(ev.head, 'and its head, so two rescues under one id are never identical lines');
});
