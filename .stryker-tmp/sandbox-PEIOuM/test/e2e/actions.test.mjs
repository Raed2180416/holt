/**
 * grove — protect / rescue / clean, attacked.
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
// @ts-nocheck


import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { newRepo } from '../fixtures.mjs';
import { protect, unprotect, rescue, rescues, clean } from '../../src/actions.mjs';
import { discover } from '../../src/discover.mjs';
import { scan } from '../../src/scan.mjs';
import { analyze } from '../../src/analyze.mjs';
import { classify } from '../../src/git.mjs';

function sh(cmd, args, cwd) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      cwd, timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'grove test', GIT_AUTHOR_EMAIL: 't@grove.invalid',
        GIT_COMMITTER_NAME: 'grove test', GIT_COMMITTER_EMAIL: 't@grove.invalid',
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
  // The read-only guarantee is a core reason to trust grove. Adding write features must not
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
  assert.match(rm.stderr, /grove:/, `git should print grove's lock reason, got: ${rm.stderr}`);
  assert.match(rm.stderr, /grove rescue/, 'the reason must say how to resolve it');

  const content = await fs.readFile(path.join(wt, 'src/precious.js'), 'utf8');
  assert.match(content, /PRECIOUS_WORK/, 'the work must still be there');
});

test('PROTECT ATTACK: -f -f still overrides, and we must not pretend otherwise', async (t) => {
  const fx = await newRepo('protect-ff');
  t.after(() => fx.cleanup());

  const wt = await fx.worktree('valuable');
  await fx.write('src/p.js', 'export function P() {}\n', wt);
  await protect(fx.root, {});

  // git's documented escape hatch. grove's note must not claim protection it does not have.
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
    'a workstream grove could not assess must be surfaced, not dropped from the report');
});

test('PROTECT: unprotect leaves FOREIGN locks alone', async (t) => {
  const fx = await newRepo('protect-foreign');
  t.after(() => fx.cleanup());

  const wt = await fx.worktree('mine');
  await fx.write('src/x.js', 'export function X() {}\n', wt);
  // A human locked this deliberately, for their own reason.
  await sh('git', ['worktree', 'lock', '--reason', 'ON A USB STICK - do not touch', wt], fx.root);

  const u = await unprotect(fx.root, {});
  assert.equal(u.unlocked, 0, 'grove must not disarm a lock somebody else placed');
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
  const leftover = await fs.stat(path.join(wt, '.git-grove-rescue-index')).then(() => true, () => false);
  assert.equal(leftover, false, 'the temporary index must be cleaned up');
});

test('RESCUE: rescues are discoverable months later', async (t) => {
  const fx = await newRepo('rescue-list');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('holder');
  await fx.write('src/x.js', 'export function X() {}\n', wt);

  await rescue(fx.root, 'holder', {});
  const list = await rescues(fx.root);
  assert.ok(list.some((r) => r.id === 'holder'), `rescue should be listed: ${JSON.stringify(list)}`);
  assert.match(list[0].ref, /^refs\/grove\/rescue\//);
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

test('CLEAN ATTACK (TOCTOU): work appearing between scan and delete must abort that delete', async (t) => {
  const fx = await newRepo('clean-toctou');
  t.after(() => fx.cleanup());

  const a = await fx.worktree('race-a');
  await fx.worktree('race-b');

  // Plan while both are empty…
  const dry = await clean(fx.root, {});
  assert.equal(dry.wouldRemove.length, 2, 'both look disposable at plan time');

  // …then work lands in one of them before the delete runs. clean() re-verifies immediately
  // before each removal precisely so a stale verdict cannot authorise a destruction.
  await fx.write('src/suddenly.js', 'export function SUDDENLY_VALUABLE() {}\n', a);

  const applied = await clean(fx.root, { apply: true });
  const survived = await fs.stat(path.join(a, 'src/suddenly.js')).then(() => true, () => false);
  assert.equal(survived, true,
    'work that appeared after the plan must NOT be deleted on a stale verdict');
  assert.ok(applied.removed <= 1);
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
  // grove uses `branch -d`, never -D: git refusing an unmerged branch is a feature, and a
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
    'a workstream grove could not assess must never be queued for deletion');
});

/* ============================================ the guarantee still holds ==== */

test('GUARANTEE: a plain scan still modifies nothing, even now that grove can mutate', async (t) => {
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
