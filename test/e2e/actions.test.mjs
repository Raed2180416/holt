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
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { newRepo } from '../fixtures.mjs';
import {
  protect, unprotect, rescue, rescues, clean, discard, auto, quarantines, restoreQuarantine,
  purgeQuarantine, verifyHeadLeaf,
} from '../../src/actions.mjs';
import { discover } from '../../src/discover.mjs';
import { scan } from '../../src/scan.mjs';
import { analyze, safeToDelete } from '../../src/analyze.mjs';
import { classify } from '../../src/git.mjs';
import { samePathAsync } from '../../src/paths.mjs';
import { assessCommand } from '../../src/agent.mjs';

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

const findWorktreeByPath = async (workstreams, target) => {
  for (const workstream of workstreams) {
    if (await samePathAsync(workstream.path, target)) return workstream;
  }
  return undefined;
};

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const gitPorcelainPath = (value) => process.platform === 'win32'
  ? String(value).replaceAll('\\', '/')
  : String(value);

test('RESTORE IDENTITY: verification binds executable mode to the same descriptor as bytes', async (t) => {
  if (process.platform === 'win32') return t.skip('Git executable mode is not represented by Windows chmod');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-head-leaf-mode-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'tool.sh');
  const replacement = path.join(root, 'replacement');
  const content = Buffer.from('#!/bin/sh\nexit 0\n');
  await fs.writeFile(file, content, { mode: 0o755 });

  await assert.rejects(
    () => verifyHeadLeaf(file, 'tool.sh', { mode: '100755', content }, {
      onAfterInitialObservation: async () => {
        await fs.writeFile(replacement, content, { mode: 0o644 });
        await fs.chmod(replacement, 0o644);
        await fs.rename(replacement, file);
      },
    }),
    /executable mode differs|changed during verification/,
    'same bytes on a replacement inode must not inherit executable identity from the old inode',
  );
});

test('RESTORE IDENTITY: same bytes and mode on a replacement inode still fail closed', async (t) => {
  if (process.platform === 'win32') return t.skip('Git executable mode is not represented by Windows chmod');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-head-leaf-inode-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'tool.sh');
  const replacement = path.join(root, 'replacement');
  const content = Buffer.from('#!/bin/sh\nexit 0\n');
  await fs.writeFile(file, content, { mode: 0o755 });
  await fs.chmod(file, 0o755);

  await assert.rejects(
    () => verifyHeadLeaf(file, 'tool.sh', { mode: '100755', content }, {
      onAfterInitialObservation: async () => {
        await fs.writeFile(replacement, content, { mode: 0o755 });
        await fs.chmod(replacement, 0o755);
        await fs.rename(replacement, file);
      },
    }),
    /changed during verification/,
    'matching bytes and mode on another inode must not satisfy the original path observation',
  );
});

test('RESTORE IDENTITY: in-place chmod cannot inherit executable mode from the earlier path observation', async (t) => {
  if (process.platform === 'win32') return t.skip('Git executable mode is not represented by Windows chmod');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-head-leaf-chmod-race-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'tool.sh');
  const content = Buffer.from('#!/bin/sh\nexit 0\n');
  await fs.writeFile(file, content, { mode: 0o755 });
  await fs.chmod(file, 0o755);

  await assert.rejects(
    () => verifyHeadLeaf(file, 'tool.sh', { mode: '100755', content }, {
      onAfterInitialObservation: async () => {
        await fs.chmod(file, 0o644);
      },
    }),
    /executable mode differs/,
    'mode must come from the descriptor-bound observation even when the inode and bytes are stable',
  );
});

/* ============================================== the mutation boundary ==== */

test('BOUNDARY: mutating commands are UNREACHABLE without an explicit opt-in', () => {
  // The read-only guarantee is a core reason to trust holt. Adding write features must not
  // widen the default door — only open a clearly-marked second one.
  const mutating = [
    ['worktree', 'lock', 'p'], ['worktree', 'unlock', 'p'], ['worktree', 'remove', 'p'],
    ['branch', '-d', 'b'], ['commit-tree', 't'], ['hash-object', '-w', '--no-filters', 'file'],
    ['update-ref', 'r', 'c'], ['write-tree'],
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
  // The manifest IS the evidence: generated-named dirs earn disposal from the command that
  // recreates them (GENERATOR_MANIFESTS). A JS repo without package.json is not a JS repo.
  await fx.write('package.json', '{\"name\":\"fixture\",\"private\":true}\n');
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

  const HOLDS_WORK = ['ig-file', 'ig-dir', 'uncommitted', 'committed', 'mixed', 'generated-only'];
  const HOLDS_NOTHING = ['genuinely-empty', 'locked-empty'];

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
  assert.ok(c.wouldQuarantine.length >= 2);

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
  assert.equal(c.quarantined, 1, `only the spent worktree should be quarantined: ${JSON.stringify(c.actions)}`);
  assert.equal(c.removed, 0, 'clean never physically deletes a worktree');
  assert.ok(await fs.stat(c.quarantines[0].quarantinePath), 'the complete worktree must remain on disk in quarantine');

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
  assert.equal(dry.wouldQuarantine.length, names.length, 'all look disposable at plan time');

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

test('CLEAN POST-VERIFY RACE: ignored bytes arriving after the final verdict move intact into quarantine',
  async (t) => {
    const fx = await newRepo('clean-post-verify-ignored');
    t.after(() => fx.cleanup());
    const wt = await fx.worktree('late-ignored');

    const c = await clean(fx.root, {
      apply: true,
      onAfterVerify: async (candidate) => {
        if (candidate.id !== 'late-ignored') return;
        await fx.write('.gitignore', 'late.secret\n', wt);
        await fx.write('late.secret', 'ONLY COPY ARRIVED AFTER THE VERDICT\n', wt);
      },
    });

    assert.equal(c.quarantined, 1, JSON.stringify(c));
    assert.equal(c.removed, 0, 'the race boundary is a move, never recursive deletion');
    const q = c.quarantines[0].quarantinePath;
    assert.equal(await fs.readFile(path.join(q, 'late.secret'), 'utf8'),
      'ONLY COPY ARRIVED AFTER THE VERDICT\n');
    assert.equal(await fs.readFile(path.join(q, '.gitignore'), 'utf8'), 'late.secret\n');
    await assert.rejects(() => fs.stat(wt), 'the old active path is vacated, not recursively erased');

    const discovered = await discover(fx.root);
    const quarantined = await findWorktreeByPath(discovered.workstreams, q);
    assert.equal(quarantined?.quarantined, true,
      `the stable private-admin marker must identify the moved recovery copy: ${JSON.stringify(quarantined)}`);

    // Terminal means terminal: status may still report the recovery copy, but clean/auto/protect
    // never recycle it as deletion authority or release its lock.
    const again = await clean(fx.root, {});
    assert.equal(again.wouldQuarantine.length, 0, JSON.stringify(again));
    const automated = await auto(fx.root);
    assert.equal(automated.needsYou.disposable, 0, JSON.stringify(automated));
    const protectedAgain = await protect(fx.root);
    assert.equal(protectedAgain.released, 0, JSON.stringify(protectedAgain));
    const listed = await fx.git(['worktree', 'list', '--porcelain']);
    assert.match(listed, new RegExp(`worktree ${escapeRegex(gitPorcelainPath(q))}[\\s\\S]*locked`),
      'the quarantine must remain registered and locked');
  });

test('CLEAN POST-VERIFY RACE: a detached commit created after the verdict remains reachable',
  async (t) => {
    const fx = await newRepo('clean-post-verify-detached');
    t.after(() => fx.cleanup());
    const wt = await fx.worktree('late-detached');
    assert.equal((await sh('git', ['checkout', '--detach'], wt)).code, 0);

    let lateHead = null;
    const c = await clean(fx.root, {
      apply: true,
      onAfterVerify: async (candidate) => {
        if (candidate.id !== 'late-detached') return;
        await fx.write('late-detached.txt', 'COMMIT CREATED AFTER FINAL SCAN\n', wt);
        lateHead = await fx.commit('late detached commit', wt);
      },
    });

    assert.equal(c.quarantined, 1, JSON.stringify(c));
    assert.ok(lateHead, 'the deterministic race seam must have created the commit');
    const q = c.quarantines[0].quarantinePath;
    assert.equal((await fx.git(['rev-parse', 'HEAD'], q)).trim(), lateHead,
      'the registered quarantine HEAD is the commit that arrived after verification');
    assert.equal(await fx.git(['show', `${lateHead}:late-detached.txt`], q),
      'COMMIT CREATED AFTER FINAL SCAN\n');
    const action = c.actions.find((a) => a.id === 'late-detached');
    assert.equal(action.head, lateHead, 'the result reports the moved HEAD, not the stale plan HEAD');
    assert.equal(action.branch, null, 'detached state is preserved and reported honestly');
  });

test('CLEAN LOCK CONTINUITY: an existing Holt risk lock survives the move without an unlock gap',
  async (t) => {
    const fx = await newRepo('clean-lock-continuity');
    t.after(() => fx.cleanup());
    const wt = await fx.worktree('locked-safe');
    const reason = 'holt: ordinary risk lock that must remain continuously present';
    assert.equal((await sh('git', ['worktree', 'lock', '--reason', reason, wt], fx.root)).code, 0);

    const c = await clean(fx.root, { apply: true });
    assert.equal(c.quarantined, 1, JSON.stringify(c));
    const q = c.quarantines[0].quarantinePath;
    const listed = await fx.git(['worktree', 'list', '--porcelain']);
    assert.match(listed, new RegExp(`worktree ${escapeRegex(gitPorcelainPath(q))}[\\s\\S]*locked ${escapeRegex(reason)}`),
      'Git must carry the existing lock file/reason through worktree move -f -f unchanged');
  });

test('CLEAN RESTORE: exact restore argv preserves a Holt lock that predated quarantine',
  async (t) => {
    const fx = await newRepo('clean-restore-existing-lock');
    t.after(() => fx.cleanup());
    const wt = await fx.worktree('protected-safe');
    const reason = 'holt: release engineering hold';
    assert.equal((await sh('git', ['worktree', 'lock', '--reason', reason, wt], fx.root)).code, 0);

    const c = await clean(fx.root, { apply: true });
    assert.equal(c.quarantined, 1, JSON.stringify(c));
    const recovery = c.quarantines[0];
    assert.equal(recovery.restorePreservesExistingLock, true, JSON.stringify(recovery));
    assert.equal(recovery.preExistingLockReason, reason);
    assert.equal(recovery.restoreArgv.length, 1,
      'restore must move the worktree back but must not append an unlock that erases prior authority');

    for (const [command, ...args] of recovery.restoreArgv) {
      const restored = await sh(command, args, fx.root);
      assert.equal(restored.code, 0, `exact restore argv failed: ${JSON.stringify(restored)}`);
    }

    assert.ok(await fs.stat(wt), 'the worktree must be restored to its original path');
    await assert.rejects(() => fs.stat(recovery.quarantinePath),
      'the quarantine payload path must be vacated by restore');
    assert.equal(await lockReasonOf(fx.root, wt), reason,
      'recovery must preserve the exact protection reason that existed before quarantine');
    const restored = await discover(fx.root);
    // Git reports the canonical `/private/var/...` spelling on macOS while mkdtemp returns
    // `/var/...`; the worktree id is the repository-stable identity for this single fixture.
    const active = restored.workstreams.find((w) => w.id === path.basename(wt));
    assert.equal(active?.quarantined, false,
      `the restored path must be active, not a terminal quarantine: ${JSON.stringify(active)}`);
  });

test('CLEAN RESTORE: exact restore argv releases only the transit lock Holt acquired',
  async (t) => {
    const fx = await newRepo('clean-restore-transit-lock');
    t.after(() => fx.cleanup());
    const wt = await fx.worktree('ordinary-safe');
    assert.equal(await lockReasonOf(fx.root, wt), null, 'fixture must begin unlocked');

    const c = await clean(fx.root, { apply: true });
    assert.equal(c.quarantined, 1, JSON.stringify(c));
    const recovery = c.quarantines[0];
    assert.equal(recovery.restorePreservesExistingLock, false, JSON.stringify(recovery));
    assert.equal(recovery.preExistingLockReason, null);
    assert.equal(recovery.restoreArgv.length, 2,
      'a quarantine-created transit lock needs one explicit unlock after the restore move');

    for (const [command, ...args] of recovery.restoreArgv) {
      const restored = await sh(command, args, fx.root);
      assert.equal(restored.code, 0, `exact restore argv failed: ${JSON.stringify(restored)}`);
    }

    assert.ok(await fs.stat(wt), 'the worktree must be restored to its original path');
    await assert.rejects(() => fs.stat(recovery.quarantinePath));
    assert.equal(await lockReasonOf(fx.root, wt), null,
      'restore must release the transit lock when and only when Holt acquired it');
  });

test('CLEAN RECOVERY: first-class inventory keeps the original identity and restore is verified',
  async (t) => {
    const fx = await newRepo('clean-first-class-restore');
    t.after(() => fx.cleanup());
    const wt = await fx.worktree('spent-friendly-name');
    const originalHead = (await fx.git(['rev-parse', 'HEAD'], wt)).trim();

    const cleaned = await clean(fx.root, { apply: true });
    assert.equal(cleaned.quarantined, 1, JSON.stringify(cleaned));
    const inventory = await quarantines(fx.root);
    assert.equal(inventory.count, 1, JSON.stringify(inventory));
    assert.equal(inventory.quarantines[0].id, 'spent-friendly-name',
      'recovery identity must come from the original worktree, not a random quarantine basename');
    // Git reports the canonical `/private/var/...` spelling on macOS, while the fixture path
    // may retain the user-facing `/var/...` alias.  They name the same directory; compare path
    // identity rather than platform-specific display strings.
    assert.ok(await samePathAsync(inventory.quarantines[0].originalPath, wt));
    assert.equal(inventory.quarantines[0].head, originalHead);

    const restored = await restoreQuarantine(fx.root, 'spent-friendly-name');
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(restored.restored, true);
    assert.ok(await samePathAsync(restored.originalPath, wt));
    assert.equal(restored.head, originalHead);
    assert.ok(await fs.stat(wt));
    await assert.rejects(() => fs.stat(cleaned.quarantines[0].quarantinePath));
    assert.equal(await lockReasonOf(fx.root, wt), null,
      'the first-class route releases the transit lock it created');

    const after = await quarantines(fx.root);
    assert.equal(after.count, 0, JSON.stringify(after));
    assert.equal(after.transitions.length, 0, JSON.stringify(after));
    const common = (await fx.git(['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
    const journalText = await fs.readFile(path.join(common, 'holt', 'journal.jsonl'), 'utf8');
    assert.match(journalText, /"action":"clean-restore"/,
      'a recovery mutation must be independently visible in the audit trail');
  });

test('CLEAN RECOVERY: an occupied original path is refused without touching either copy',
  async (t) => {
    const fx = await newRepo('clean-restore-occupied');
    t.after(() => fx.cleanup());
    const wt = await fx.worktree('occupied');
    const cleaned = await clean(fx.root, { apply: true });
    assert.equal(cleaned.quarantined, 1, JSON.stringify(cleaned));
    await fs.mkdir(wt);
    await fs.writeFile(path.join(wt, 'new-owner.txt'), 'must survive\n');

    const restored = await restoreQuarantine(fx.root, 'occupied');
    assert.equal(restored.ok, false, JSON.stringify(restored));
    assert.match(restored.error, /occupied/);
    assert.equal(await fs.readFile(path.join(wt, 'new-owner.txt'), 'utf8'), 'must survive\n');
    assert.ok(await fs.stat(cleaned.quarantines[0].quarantinePath),
      'the recoverable source must remain in quarantine after refusal');
  });

test('CLEAN RECOVERY: first-class restore preserves protection that predated quarantine',
  async (t) => {
    const fx = await newRepo('clean-first-class-existing-lock');
    t.after(() => fx.cleanup());
    const wt = await fx.worktree('held-release');
    const reason = 'holt: protected for release review';
    assert.equal((await sh('git', ['worktree', 'lock', '--reason', reason, wt], fx.root)).code, 0);

    const cleaned = await clean(fx.root, { apply: true });
    assert.equal(cleaned.quarantined, 1, JSON.stringify(cleaned));
    const restored = await restoreQuarantine(fx.root, 'held-release');
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(restored.preservedLock, true);
    assert.equal(await lockReasonOf(fx.root, wt), reason,
      'the first-class action must restore path and exact prior authority together');
  });

test('CLEAN RECOVERY: changed lock authority is refused rather than unlocked or overwritten',
  async (t) => {
    const fx = await newRepo('clean-restore-lock-tamper');
    t.after(() => fx.cleanup());
    await fx.worktree('tampered');
    const cleaned = await clean(fx.root, { apply: true });
    assert.equal(cleaned.quarantined, 1, JSON.stringify(cleaned));
    const q = cleaned.quarantines[0].quarantinePath;
    assert.equal((await sh('git', ['worktree', 'unlock', q], fx.root)).code, 0);
    assert.equal((await sh('git', ['worktree', 'lock', '--reason', 'foreign recovery hold', q], fx.root)).code, 0);

    const restored = await restoreQuarantine(fx.root, 'tampered');
    assert.equal(restored.ok, false, JSON.stringify(restored));
    assert.match(restored.error, /no longer protected by a Holt lock|lock changed/);
    assert.ok(await fs.stat(q));
    assert.match(await lockReasonOf(fx.root, q) ?? '', /foreign recovery hold/,
      'Holt must not weaken replacement authority it did not place');
  });

test('CLEAN PURGE: preview is inert; apply anchors exact HEAD and reclaims a clean quarantine',
  async (t) => {
    const fx = await newRepo('clean-purge');
    t.after(() => fx.cleanup());
    const wt = await fx.worktree('spent-to-purge');
    const head = (await fx.git(['rev-parse', 'HEAD'], wt)).trim();

    const cleaned = await clean(fx.root, { apply: true });
    assert.equal(cleaned.quarantined, 1, JSON.stringify(cleaned));
    const q = cleaned.quarantines[0].quarantinePath;

    const preview = await purgeQuarantine(fx.root, 'spent-to-purge');
    assert.equal(preview.ok, true, JSON.stringify(preview));
    assert.equal(preview.dryRun, true);
    assert.equal(preview.removed, 0);
    assert.equal(preview.head, head);
    assert.ok(await fs.stat(q), 'preview must leave the checkout in quarantine');
    assert.match(await lockReasonOf(fx.root, q) ?? '', /holt:/,
      'preview must leave the quarantine lock intact');

    const applied = await purgeQuarantine(fx.root, 'spent-to-purge', { apply: true });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.purged, true);
    assert.equal(applied.removed, 1);
    assert.equal(applied.branchesRemoved, 0);
    assert.equal(applied.commit, head);
    assert.match(applied.recoveryRef, /^refs\/holt\/purge\//);
    await assert.rejects(() => fs.stat(q), 'purge must physically reclaim the checkout directory');
    const listed = await fx.git(['worktree', 'list', '--porcelain']);
    assert.doesNotMatch(listed, new RegExp(escapeRegex(gitPorcelainPath(q))),
      'the removed checkout must not remain registered');
    assert.equal((await fx.git(['rev-parse', `${applied.recoveryRef}^{commit}`])).trim(), head,
      'the exact pre-purge HEAD must remain reachable from the returned recovery ref');
    assert.ok(applied.branch, 'the fixture is branch-backed and purge must report that branch');
    assert.equal((await fx.git(['rev-parse', `refs/heads/${applied.branch}^{commit}`])).trim(), head,
      'purge reclaims a checkout; it never deletes its branch');
    const { readJournal } = await import('../../src/journal.mjs');
    const event = (await readJournal(fx.root)).find((entry) => entry.action === 'clean-purge');
    assert.ok(event, 'physical reclamation must be present in the hash-chained audit trail');
    assert.equal(event.ref, applied.recoveryRef);
    assert.equal(event.commit, head);
  });

test('CLEAN PURGE: modified, untracked, and ignored bytes refuse physical removal', async (t) => {
  const fx = await newRepo('clean-purge-dirty');
  t.after(() => fx.cleanup());
  await fx.worktree('dirty-after-quarantine');
  const cleaned = await clean(fx.root, { apply: true });
  assert.equal(cleaned.quarantined, 1, JSON.stringify(cleaned));
  const q = cleaned.quarantines[0].quarantinePath;
  await fs.writeFile(path.join(q, '.gitignore'), 'sole-copy.secret\n');
  await fs.writeFile(path.join(q, 'sole-copy.secret'), 'MUST SURVIVE\n');

  const purged = await purgeQuarantine(fx.root, 'dirty-after-quarantine', { apply: true });
  assert.equal(purged.ok, false, JSON.stringify(purged));
  assert.equal(purged.blocked, true);
  assert.match(purged.error, /modified, untracked, or ignored/);
  assert.equal(await fs.readFile(path.join(q, 'sole-copy.secret'), 'utf8'), 'MUST SURVIVE\n');
  assert.match(await lockReasonOf(fx.root, q) ?? '', /holt:/,
    'a refused purge must not weaken the quarantine lock');
});

test('CLEAN PURGE: an ignored sole copy with no untracked companion refuses physical removal', async (t) => {
  const fx = await newRepo('clean-purge-ignored-sole-copy');
  t.after(() => fx.cleanup());
  await fx.worktree('ignored-sole-copy');
  const cleaned = await clean(fx.root, { apply: true });
  assert.equal(cleaned.quarantined, 1, JSON.stringify(cleaned));
  const q = cleaned.quarantines[0].quarantinePath;

  // Do not use a worktree .gitignore: that file would itself be untracked, masking the exact
  // failure under attack.  info/exclude is pre-existing repository metadata, so this checkout
  // contains only the ignored, sole-copy byte Holt must still see before it can purge.
  const commonDir = (await fx.git(['rev-parse', '--git-common-dir'], q)).trim();
  await fs.appendFile(path.resolve(q, commonDir, 'info', 'exclude'), 'sole-copy.secret\n');
  await fs.writeFile(path.join(q, 'sole-copy.secret'), 'MUST SURVIVE\n');

  const purged = await purgeQuarantine(fx.root, 'ignored-sole-copy', { apply: true });
  assert.equal(purged.ok, false, JSON.stringify(purged));
  assert.equal(purged.blocked, true, JSON.stringify(purged));
  assert.match(purged.error, /modified, untracked, or ignored/);
  assert.equal(await fs.readFile(path.join(q, 'sole-copy.secret'), 'utf8'), 'MUST SURVIVE\n');
  assert.match(await lockReasonOf(fx.root, q) ?? '', /holt:/,
    'a refused purge must retain the quarantine lock around the exact ignored byte');
});

test('CLEAN PURGE RACE: Git independently refuses late work and Holt restores the lock',
  async (t) => {
    const fx = await newRepo('clean-purge-race');
    t.after(() => fx.cleanup());
    await fx.worktree('late-purge-write');
    const cleaned = await clean(fx.root, { apply: true });
    assert.equal(cleaned.quarantined, 1, JSON.stringify(cleaned));
    const q = cleaned.quarantines[0].quarantinePath;

    const purged = await purgeQuarantine(fx.root, 'late-purge-write', {
      apply: true,
      onBeforeRemove: async ({ quarantinePath }) => {
        await fs.writeFile(path.join(quarantinePath, 'arrived-after-check.txt'), 'STILL HERE\n');
      },
    });
    assert.equal(purged.ok, false, JSON.stringify(purged));
    assert.equal(purged.relocked, true, JSON.stringify(purged));
    assert.match(purged.recoveryRef, /^refs\/holt\/purge\//,
      'the committed state is anchored even though the final removal refused');
    assert.equal(await fs.readFile(path.join(q, 'arrived-after-check.txt'), 'utf8'), 'STILL HERE\n');
    assert.match(await lockReasonOf(fx.root, q) ?? '', /holt:/,
      'the exact quarantine authority must be restored after Git refuses the dirty checkout');
  });

test('CLEAN PURGE: replacement lock authority is never removed or overwritten', async (t) => {
  const fx = await newRepo('clean-purge-lock-tamper');
  t.after(() => fx.cleanup());
  await fx.worktree('purge-lock-tamper');
  const cleaned = await clean(fx.root, { apply: true });
  assert.equal(cleaned.quarantined, 1, JSON.stringify(cleaned));
  const q = cleaned.quarantines[0].quarantinePath;
  assert.equal((await sh('git', ['worktree', 'unlock', q], fx.root)).code, 0);
  assert.equal((await sh('git', ['worktree', 'lock', '--reason', 'foreign retention hold', q], fx.root)).code, 0);

  const purged = await purgeQuarantine(fx.root, 'purge-lock-tamper', { apply: true });
  assert.equal(purged.ok, false, JSON.stringify(purged));
  assert.match(purged.error, /no longer protected by a Holt lock|lock changed/);
  assert.ok(await fs.stat(q));
  assert.equal(await lockReasonOf(fx.root, q), 'foreign retention hold');
});

test('CLEAN OPEN-HANDLE RACE: late descriptor writes follow quarantine or fail protected',
  async (t) => {
    const fx = await newRepo('clean-open-handle');
    t.after(() => fx.cleanup());
    const wt = await fx.worktree('open-handle');
    let handle = null;

    const c = await clean(fx.root, {
      apply: true,
      onAfterVerify: async () => {
        handle = await fs.open(path.join(wt, 'late-open.txt'), 'wx');
        await handle.writeFile('before move\n');
        await handle.sync();
      },
    });
    t.after(() => handle?.close().catch(() => {}));

    if (c.quarantined === 1) {
      await handle.writeFile('after move\n');
      await handle.sync();
      await handle.close();
      handle = null;
      assert.equal(await fs.readFile(path.join(c.quarantines[0].quarantinePath, 'late-open.txt'), 'utf8'),
        'before move\nafter move\n', 'an open descriptor follows the renamed inode into quarantine');
    } else {
      // Windows commonly refuses directory renames while a child file is open. That is a safe
      // platform outcome only if the source and its lock remain intact and no fallback deletes it.
      assert.equal(c.failedCount, 1, JSON.stringify(c));
      assert.equal(c.removed, 0);
      assert.equal(await fs.readFile(path.join(wt, 'late-open.txt'), 'utf8'), 'before move\n');
      const listed = await fx.git(['worktree', 'list', '--porcelain']);
      assert.match(listed, /locked holt: clean quarantine transit/,
        'a sharing-violation path must remain protected, never fall back to deletion');
    }
  });

test('CLEAN IDENTITY RACE: replacing the registered worktree at the same path is refused',
  async (t) => {
    const fx = await newRepo('clean-identity-race');
    t.after(() => fx.cleanup());
    const wt = await fx.worktree('same-name');
    const movedAside = path.join(path.dirname(wt), 'original-moved-aside');

    const c = await clean(fx.root, {
      apply: true,
      onAfterVerify: async () => {
        assert.equal((await sh('git', ['worktree', 'move', wt, movedAside], fx.root)).code, 0);
        assert.equal((await sh('git', ['worktree', 'add', '-b', 'replacement-same-name', wt, 'main'], fx.root)).code, 0);
      },
    });

    assert.equal(c.quarantined, 0, JSON.stringify(c));
    assert.equal(c.failedCount, 1, JSON.stringify(c));
    assert.match(c.failures[0].why, /identity changed/);
    assert.ok(await fs.stat(wt), 'the replacement at the original path must survive untouched');
    assert.ok(await fs.stat(movedAside), 'the original worktree must also remain registered and intact');
  });

test('CLEAN IDENTITY RACE: a filesystem replacement reusing the same Git admin pointer is refused',
  async (t) => {
    const fx = await newRepo('clean-filesystem-identity-race');
    t.after(() => fx.cleanup());
    const wt = await fx.worktree('same-admin');
    const movedAside = path.join(path.dirname(wt), 'same-admin-original');
    const gitPointer = await fs.readFile(path.join(wt, '.git'), 'utf8');

    const c = await clean(fx.root, {
      apply: true,
      onAfterVerify: async () => {
        // Preserve the Git admin identity and original pathname while replacing the physical
        // directory inode. A basename/path-only binding accepts this substitution; dev+ino must
        // participate in the destructive authorization.
        await fs.rename(wt, movedAside);
        await fs.mkdir(wt);
        await fs.writeFile(path.join(wt, '.git'), gitPointer);
        await fs.writeFile(path.join(wt, 'replacement-only.txt'), 'must survive\n');
      },
    });

    assert.equal(c.quarantined, 0, JSON.stringify(c));
    assert.equal(c.failedCount, 1, JSON.stringify(c));
    assert.match(c.failures[0].why, /identity changed/);
    assert.equal(await fs.readFile(path.join(wt, 'replacement-only.txt'), 'utf8'), 'must survive\n',
      'the substituted directory must not inherit the original checkout\'s disposable verdict');
    assert.ok(await fs.stat(movedAside), 'the original physical checkout must remain intact too');
  });

test('CLEAN SUBMODULE: Git move refusal remains protected and never falls back to removal',
  async (t) => {
    const fx = await newRepo('clean-submodule');
    t.after(() => fx.cleanup());
    const sub = path.join(path.dirname(fx.root), 'submodule-origin');
    await fs.mkdir(sub, { recursive: true });
    assert.equal((await sh('git', ['init', '--initial-branch=main', '-q'], sub)).code, 0);
    assert.equal((await sh('git', ['config', 'user.name', 'holt test'], sub)).code, 0);
    assert.equal((await sh('git', ['config', 'user.email', 't@holt.invalid'], sub)).code, 0);
    await fs.writeFile(path.join(sub, 'payload.txt'), 'submodule payload\n');
    assert.equal((await sh('git', ['add', 'payload.txt'], sub)).code, 0);
    assert.equal((await sh('git', ['commit', '-m', 'submodule base'], sub)).code, 0);
    assert.equal((await sh('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', sub, 'deps/sub'], fx.root)).code, 0);
    await fx.commit('add populated submodule');
    const wt = await fx.worktree('with-submodule');
    assert.equal((await sh('git', ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init'], wt)).code, 0);

    const c = await clean(fx.root, { apply: true });
    assert.equal(c.quarantined, 0, JSON.stringify(c));
    assert.equal(c.failedCount, 1, JSON.stringify(c));
    assert.equal(c.removed, 0, 'submodule refusal must never fall back to recursive removal');
    assert.ok(await fs.stat(path.join(wt, 'deps/sub/payload.txt')),
      'the populated submodule and source worktree remain intact');
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
  // Quarantine keeps the branch registered. Checking stdout is insufficient here because
  // `show-ref --quiet` emits no text for BOTH success and failure; the exit code is the proof.
  assert.equal(acted.action, 'quarantined', JSON.stringify(acted));
  const retained = await sh('git', ['show-ref', '--verify', '--quiet', `refs/heads/${acted.branch}`], fx.root);
  assert.equal(retained.code, 0, `the branch must remain registered: ${retained.stderr}`);
  assert.equal(c.branchesRemoved, 0, 'clean quarantine never deletes branches');
});

test('CLEAN: unknown workstreams are reported and never removed', async (t) => {
  const fx = await newRepo('clean-unknown');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('ghost');
  await fs.rm(wt, { recursive: true, force: true });

  const c = await clean(fx.root, {});
  assert.ok(!c.wouldQuarantine.some((w) => w.id === 'ghost'),
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

/* ------------------------------------------------- locks must converge, not ratchet ---- */

/** Read the lock reason git itself holds for a worktree path, or null. */
async function lockReasonOf(root, wtPath) {
  const out = await new Promise((resolve) => {
    execFile('git', ['worktree', 'list', '--porcelain'], { cwd: root }, (e, so) => resolve(so ?? ''));
  });
  // COMPARED THROUGH paths.mjs, NEVER RAW — this helper shipped with `cur === wtPath` and went
  // red on macOS and Windows while passing on Linux, which is the exact class src/paths.mjs
  // exists to close. The fixture holds the path mkdtemp returned (/var/folders/… on macOS, an
  // 8.3 name on Windows) while git prints the resolved one (/private/var/folders/…), so the
  // comparison found no worktree, returned null, and the assertion read as "holt did not lock
  // it" when holt had locked it correctly. A test helper is as capable of this bug as product
  // code, and its failure is more confusing because it accuses the product.
  let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) cur = line.slice(9);
    else if (line.startsWith('locked') && cur && await samePathAsync(cur, wtPath)) {
      return line.slice(6).trim();
    }
  }
  return null;
}

test('PROTECT: holt releases its OWN lock once the work has landed — the tool must converge, not ratchet', async (t) => {
  // A LOCK OUTLIVING ITS JUSTIFICATION FREEZES THE REPOSITORY.
  //
  // `protect` only ever added locks, and safeToDelete() counted holt's own lock as a REASON the
  // worktree is not disposable — so the lock became self-justifying. Once holt locked a worktree
  // it stayed "not safe" forever, citing the lock holt itself placed; `clean --apply` skipped it,
  // and `git worktree remove` would have refused it anyway. The only escape was `unprotect`,
  // which disarms EVERY tree including the ones that genuinely need it — precisely the "a gate
  // that only refuses gets switched off" failure the README names.
  //
  // Measured on holt's own repository following holt's own quick-start: 20 worktrees locked,
  // 18 of them holding nothing unique, none reclaimable.
  //
  // A foreign lock is different and is covered by the test below: somebody else deliberately
  // protected that tree, and holt must not overrule them.
  const fx = await newRepo('lock-reconcile');
  t.after(() => fx.cleanup());

  const wt = await fx.worktree('landing');
  await fx.write('src/pending.js', 'export function PENDING_WORK() { return 1; }\n', wt);

  // PRESENCE FIRST: it really does hold the only copy, and protect really does lock it.
  const first = await protect(fx.root);
  assert.ok(first.protected >= 1, `protect must lock work that exists nowhere else: ${JSON.stringify(first)}`);
  const lockedReason = await lockReasonOf(fx.root, wt);
  assert.match(lockedReason ?? '', /^holt:/, `git must hold holt's lock: ${JSON.stringify(lockedReason)}`);

  // THE WORK LANDS — committed on its branch and merged into base. Nothing unique remains.
  await fx.commit('land the pending work', wt);
  await fx.git(['merge', '--no-ff', '-m', 'land it', 'wt/landing']);

  // The verdict must now rest on CONTENT, not on holt's own past verdict.
  const report = await inspect(fx.root);
  const verdict = report.safe.find((s) => s.id === 'landing');
  assert.ok(verdict, 'the worktree must still be assessed');
  assert.equal(verdict.safe, true,
    `nothing unique is left, so the only thing still calling it unsafe is holt's own lock: ${JSON.stringify(verdict.reasons)}`);

  // protect is the reconciler: run it again and the lock set equals the risk set.
  const second = await protect(fx.root);
  assert.ok((second.released ?? 0) >= 1,
    `protect must RELEASE a lock whose justification is gone: ${JSON.stringify(second)}`);
  assert.equal(await lockReasonOf(fx.root, wt), null,
    'the stale lock must actually be gone from git, not merely reported as released');

  // …and the worktree is reclaimable again, which is the whole point.
  const cleaned = await clean(fx.root, { apply: true });
  assert.equal(cleaned.quarantined, 1, `the landed worktree must be reclaimable: ${JSON.stringify(cleaned)}`);
});

test('PROTECT: a lock placed by SOMEONE ELSE is never released and still blocks (never-worse)', async (t) => {
  // The other half. Reconciliation must not become a licence to disarm protections holt did not
  // place — a human or another tool locked that tree deliberately, and holt has no basis to
  // overrule them. This is the assertion that keeps the fix above from being a fail-open.
  const fx = await newRepo('foreign-lock');
  t.after(() => fx.cleanup());

  const wt = await fx.worktree('theirs');
  // Deliberately EMPTY: by content alone this worktree is provably disposable, so the ONLY thing
  // that can keep it safe from deletion is the foreign lock. If the lock stopped counting, this
  // test goes red.
  await fx.git(['worktree', 'lock', '--reason', 'release engineering: do not touch until 2.0', wt]);

  const report = await inspect(fx.root);
  const verdict = report.safe.find((s) => s.id === 'theirs');
  assert.equal(verdict.safe, false,
    `a foreign lock is a deliberate protection and must still block: ${JSON.stringify(verdict)}`);

  const p = await protect(fx.root);
  assert.equal((p.released ?? 0), 0, `protect must not release a lock it did not place: ${JSON.stringify(p)}`);
  assert.match(await lockReasonOf(fx.root, wt) ?? '', /release engineering/,
    'the foreign lock must survive untouched');

  const cleaned = await clean(fx.root, { apply: true });
  assert.equal(cleaned.quarantined, 0, `clean must not move a worktree someone else locked: ${JSON.stringify(cleaned)}`);
});

test('PROTECT: a C-quoted lock reason is still holt’s own lock in the VERDICT, not only in unprotect', async (t) => {
  // ONE EVIDENCE STREAM, TWO PARSERS, AND THEY DRIFTED.
  //
  // git C-quotes a porcelain lock reason the moment it contains a character git treats as special
  // — and holt's own reasons embed SYMBOL NAMES, which are routinely non-ASCII. actions.mjs
  // learned this the hard way and decodes it in lockState(); discover.mjs, which feeds the safety
  // verdict, kept the raw quoted string. So isHoltLock() saw `"holt: …` (leading quote), called
  // holt's own lock foreign, and the reconciliation added in this release could never fire for
  // exactly the reasons holt writes most often. Fail-closed, but silently and permanently.
  const fx = await newRepo('quoted-lock');
  t.after(() => fx.cleanup());

  const wt = await fx.worktree('accented');
  // Deliberately EMPTY: by content this worktree is provably disposable, so the lock is the only
  // thing that can hold it. A non-ASCII symbol name is what forces git to quote.
  const reason = "holt: holds work found nowhere else (e.g. callable:crée_token). "
    + "Run 'holt rescue accented' to preserve it, or 'holt risk' to inspect.";
  await fx.git(['worktree', 'lock', '--reason', reason, wt]);

  // FIXTURE VALIDITY: git must really be quoting, or this test proves nothing.
  const porcelain = await fx.git(['worktree', 'list', '--porcelain']);
  assert.match(porcelain, /locked "holt:/,
    `the fixture is void unless git C-quotes the reason: ${JSON.stringify(porcelain)}`);

  const report = await inspect(fx.root);
  const verdict = report.safe.find((s) => s.id === 'accented');
  assert.equal(verdict.safe, true,
    `holt's own lock must be recognised through the quoting: ${JSON.stringify(verdict.reasons)}`);

  const p = await protect(fx.root);
  assert.ok((p.released ?? 0) >= 1, `it must be reconcilable like any other holt lock: ${JSON.stringify(p)}`);
  assert.equal(await lockReasonOf(fx.root, wt), null, 'and the lock must actually be gone');
});

/* ------------------------------------------------------------- the escape hatch ---- */

test('DISCARD: content is captured and VERIFIED before anything is removed, and stays recoverable', async (t) => {
  // THE GUARD NAMED A COMMAND THAT DID NOT EXIST. Its refusal ended "If it is genuinely
  // disposable, discard it explicitly rather than through this command" — and there was no such
  // command, no flag, and no environment variable anywhere in the source. That leaves a user one
  // way out, which is to uninstall the hook, and it is the failure this project already named:
  // a gate that only refuses gets switched off. The A/B measured the same thing — the
  // warnings-only arm froze at 0% cleanup, the arm with a PERMITTED ACTION cleaned 73%.
  const fx = await newRepo('discard');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('scratch');
  await fx.write('notes.md', 'the only copy of this\n', wt);
  await fx.write('keep.md', 'this one stays\n', wt);

  const before = await inspect(fx.root);
  assert.equal(before.safe.find((s) => s.id === 'scratch')?.safe, false,
    'the fixture is void unless holt would refuse to lose this in the first place');

  const r = await discard(fx.root, [path.join(wt, 'notes.md')]);
  assert.equal(r.ok, true, `discard must succeed: ${JSON.stringify(r)}`);
  assert.equal(r.verified, true, 'it must claim verification, not merely success');

  // Gone from disk…
  await assert.rejects(() => fs.stat(path.join(wt, 'notes.md')), 'the path must actually be removed');
  // …and the file it was NOT asked to touch is untouched.
  assert.equal(await fs.readFile(path.join(wt, 'keep.md'), 'utf8'), 'this one stays\n');

  // …and RECOVERABLE, which is the entire difference between this and `rm`.
  const show = await sh('git', ['show', `${r.commit}:notes.md`], fx.root);
  assert.equal(show.stdout, 'the only copy of this\n',
    `the discarded content must be readable back out of the ref: ${JSON.stringify(show)}`);

  // …and recorded, so "who deleted this and where did it go" is answerable months later.
  // The journal lives beside the object database (git common dir), not in the working tree.
  const common = await sh('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], fx.root);
  const journal = await fs.readFile(
    path.join(common.stdout.trim(), 'holt', 'journal.jsonl'), 'utf8').catch(() => '');
  assert.match(journal, /"action":"discard"/, `the discard must be journalled: ${journal.slice(-400)}`);
});

test('DISCARD: nested empty directories do not dead-end recoverable cleanup', async (t) => {
  const fx = await newRepo('discard-empty-directories');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('generated-tree');
  const generated = path.join(wt, 'node_modules', 'pkg');
  await fs.mkdir(path.join(generated, 'empty', 'nested'), { recursive: true });
  await fs.writeFile(path.join(generated, 'valuable.patch'), 'hand-patched dependency bytes\n');

  const r = await discard(fx.root, [path.join(wt, 'node_modules')]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.emptyDirectoriesOmitted?.includes('node_modules/pkg/empty/nested'),
    `the non-representable shape must be explicit: ${JSON.stringify(r)}`);
  assert.match(r.note, /cannot be represented or recreated by a Git ref/);
  await assert.rejects(() => fs.lstat(path.join(wt, 'node_modules')), { code: 'ENOENT' });
  assert.equal(
    (await fx.git(['show', `${r.commit}:node_modules/pkg/valuable.patch`])).trim(),
    'hand-patched dependency bytes',
    'real bytes beside an empty directory must remain recoverable from the capture ref',
  );
});

test('DISCARD: a many-leaf generated tree is captured without exhausting object writers', async (t) => {
  const fx = await newRepo('discard-many-leaves');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('large-generated-tree');
  const root = path.join(wt, 'node_modules', 'fixture');
  const expected = new Map();
  for (let i = 0; i < 384; i += 1) {
    const rel = `bucket-${i % 17}/leaf-${String(i).padStart(4, '0')}.txt`;
    const body = `sole-copy generated leaf ${i}\n`;
    expected.set(`node_modules/fixture/${rel}`, body);
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), body);
  }

  const r = await discard(fx.root, [path.join(wt, 'node_modules')]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.verified, true, JSON.stringify(r));
  await assert.rejects(() => fs.lstat(path.join(wt, 'node_modules')), { code: 'ENOENT' });

  const listed = (await fx.git(['ls-tree', '-r', '--name-only', r.commit]))
    .split('\n').filter((name) => name.startsWith('node_modules/fixture/'));
  assert.equal(listed.length, expected.size,
    `every leaf must be represented in the recovery commit: ${JSON.stringify(r)}`);
  for (const [name, body] of [expected.entries().next().value, [...expected.entries()].at(-1)]) {
    assert.equal(await fx.git(['show', `${r.commit}:${name}`]), body,
      `${name} must retain its exact bytes`);
  }
});

test('DISCARD RACE: accepting an empty directory never loses bytes added through an open handle', async (t) => {
  if (process.platform !== 'linux') return t.skip('/proc directory-handle proof is Linux-specific');
  const fx = await newRepo('discard-empty-directory-race');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('empty-writer');
  const empty = path.join(wt, 'generated-empty');
  await fs.mkdir(empty);
  const handle = await fs.open(empty, 'r');
  let closed = false;
  t.after(async () => { if (!closed) await handle.close().catch(() => {}); });

  const r = await discard(fx.root, [empty], {
    onAfterCapture: async () => {
      await fs.writeFile(`/proc/self/fd/${handle.fd}/late.txt`, 'late sole-copy bytes\n');
      await handle.close();
      closed = true;
    },
  });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.error, /changed in quarantine before cleanup/);
  assert.ok(typeof r.quarantine === 'string');
  assert.equal(await fs.readFile(path.join(r.quarantine, 'late.txt'), 'utf8'), 'late sole-copy bytes\n',
    'the late writer must remain physically recoverable');
  await assert.rejects(() => fx.git(['show', `${r.commit}:generated-empty/late.txt`]),
    'the earlier capture must not be misrepresented as containing the late bytes');
});

test('DISCARD: binary content is captured byte-for-byte before removal', async (t) => {
  const fx = await newRepo('discard-binary');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('binary');
  const bytes = Buffer.from([0, 1, 2, 13, 10, 255, 128, 42, 0, 99]);
  const file = path.join(wt, 'blob.bin');
  await fs.writeFile(file, bytes);

  const r = await discard(fx.root, [file]);
  assert.equal(r.ok, true, `binary discard must succeed: ${JSON.stringify(r)}`);
  assert.equal(r.verified, true);
  await assert.rejects(() => fs.lstat(file));

  const captured = await new Promise((resolve, reject) => {
    execFile('git', ['show', `${r.commit}:blob.bin`], { cwd: fx.root, encoding: 'buffer' }, (error, stdout) => {
      if (error) reject(error); else resolve(stdout);
    });
  });
  assert.ok(Buffer.from(captured).equals(bytes), 'the rescue ref must preserve every binary byte');
});

test('DISCARD: clean filters and EOL attributes cannot rewrite sole-copy capture bytes', async (t) => {
  const fx = await newRepo('discard-filter-free');
  t.after(() => fx.cleanup());
  await fx.write('.gitattributes', 'secret.txt filter=redact\r\ncrlf.txt text eol=lf\r\n');
  await fx.git(['config', 'filter.redact.clean', 'sed s/.*/REDACTED/']);
  await fx.git(['config', 'filter.redact.smudge', 'cat']);
  await fx.commit('configure deliberately lossy clean filter');
  const wt = await fx.worktree('filtered');
  const secret = Buffer.from('TOP SECRET SOLE COPY\n');
  const crlf = Buffer.from('first\r\nsecond\r\n');
  await fs.writeFile(path.join(wt, 'secret.txt'), secret);
  await fs.writeFile(path.join(wt, 'crlf.txt'), crlf);

  const r = await discard(fx.root, [path.join(wt, 'secret.txt'), path.join(wt, 'crlf.txt')]);
  assert.equal(r.ok, true, JSON.stringify(r));
  for (const [rel, expected] of [['secret.txt', secret], ['crlf.txt', crlf]]) {
    const captured = await new Promise((resolve, reject) => {
      execFile('git', ['show', `${r.commit}:${rel}`],
        { cwd: fx.root, encoding: 'buffer' }, (error, stdout) => {
          if (error) reject(error); else resolve(Buffer.from(stdout));
        });
    });
    assert.ok(captured.equals(expected), `${rel} must retain exact pre-filter bytes`);
  }
  assert.notEqual((await fx.git(['show', `${r.commit}:secret.txt`])).trim(), 'REDACTED',
    'the capture must never be the clean-filter output');
});

test('DISCARD: a capture that cannot be verified deletes NOTHING', async (t) => {
  // The safety property, and the only one that really matters. If verification is skipped or
  // wrong, `discard` becomes `rm` with extra steps and a false promise of recoverability — worse
  // than no command at all, because the promise is what makes someone willing to run it.
  //
  // A nested git repository is the documented real cause: `git add` exits non-zero with
  // "does not have a commit checked out" and indexes nothing beneath it, so the tree is missing
  // the very path the caller asked to capture.
  const fx = await newRepo('discard-unverifiable');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('nested');
  const inner = path.join(wt, 'vendored');
  await fs.mkdir(inner, { recursive: true });
  await sh('git', ['init', '-q'], inner);
  await fs.writeFile(path.join(inner, 'precious.txt'), 'irreplaceable\n');

  const r = await discard(fx.root, [inner]);
  assert.equal(r.ok, false, `an unverifiable capture must refuse: ${JSON.stringify(r)}`);
  assert.match(r.error ?? '', /INCOMPLETE|embedded Git boundary/,
    `the reason must say what went wrong: ${JSON.stringify(r)}`);

  // THE ASSERTION THAT MATTERS: nothing was destroyed.
  assert.equal(await fs.readFile(path.join(inner, 'precious.txt'), 'utf8'), 'irreplaceable\n',
    'a refused discard must leave the content exactly where it was');
});

test('DISCARD: a path outside this repository is refused rather than deleted', async (t) => {
  const fx = await newRepo('discard-outside');
  t.after(() => fx.cleanup());
  await fx.worktree('any');
  const outside = path.join(path.dirname(fx.root), 'not-in-the-repo.txt');
  await fs.writeFile(outside, 'someone else\n');

  const r = await discard(fx.root, [outside]);
  assert.equal(r.ok, false, `discard must not reach outside the repository: ${JSON.stringify(r)}`);
  assert.equal(await fs.readFile(outside, 'utf8'), 'someone else\n', 'and must not have touched it');
});


test('DISCARD: a TRACKED file is reverted to HEAD, not deleted - and the edit stays recoverable', async (t) => {
  // THE SAME HOLE, ONE LEVEL DOWN. Restoring a file from HEAD is the standard way to throw away
  // local edits, and holt's guard refuses that pathspec form for the correct reason: it destroys
  // uncommitted work. Refusing it with no permitted alternative is exactly the failure `discard`
  // was added to close - and DELETING a tracked file would be a bizarre answer to "throw away my
  // edits". Hit twice in real use while building this feature.
  //
  // The restore is done with plumbing (cat-file) plus a file write, never through the refused
  // porcelain: holt does not grant itself an exception to its own destructive-command rule.
  const fx = await newRepo('discard-tracked');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('edited');
  await fx.write('src/base.js',
    'export function baseline() { return 1; }\nexport function EXPERIMENT() { return 2; }\n', wt);

  const r = await discard(fx.root, [path.join(wt, 'src/base.js')]);
  assert.equal(r.ok, true, `discard must succeed: ${JSON.stringify(r)}`);
  assert.deepEqual(r.reverted, [path.join(wt, 'src/base.js')], 'a tracked path is reverted, not removed');
  assert.deepEqual(r.discarded, [], 'and nothing was deleted');

  // The file still exists, at its committed content.
  const now = await fs.readFile(path.join(wt, 'src/base.js'), 'utf8');
  assert.equal(now, 'export function baseline() { return 1; }\n',
    `the file must be restored to HEAD, not emptied or removed: ${JSON.stringify(now)}`);

  // ...and the discarded EDIT is still recoverable, which is the whole difference from git.
  const back = await sh('git', ['show', `${r.commit}:src/base.js`], fx.root);
  assert.match(back.stdout, /EXPERIMENT/,
    `the thrown-away edit must be readable back out of the ref: ${JSON.stringify(back)}`);
});

test('DISCARD: a modified TRACKED binary is restored byte-for-byte, not UTF-8 decoded', async (t) => {
  // `git cat-file blob` was read through git()'s text stdout and then written as UTF-8. Every
  // invalid byte became EF BF BD while discard still returned ok:true. NULs alone do not catch
  // that corruption; the fixture deliberately mixes NUL with several invalid UTF-8 bytes.
  const fx = await newRepo('discard-tracked-binary-restore');
  t.after(() => fx.cleanup());
  const baseline = Buffer.from([0x00, 0xff, 0x80, 0x41, 0x00, 0xfe, 0x0a]);
  const edited = Buffer.from([0xde, 0xad, 0x00, 0xbe, 0xef, 0xbf, 0xbd, 0x81]);
  const baseFile = path.join(fx.root, 'tracked.bin');
  await fs.writeFile(baseFile, baseline);
  await fx.commit('track binary baseline');

  const wt = await fx.worktree('binary-edited');
  const file = path.join(wt, 'tracked.bin');
  await fs.writeFile(file, edited);
  const r = await discard(fx.root, [file]);
  assert.equal(r.ok, true, `binary tracked discard must succeed: ${JSON.stringify(r)}`);
  assert.deepEqual(r.reverted, [file]);
  assert.ok((await fs.readFile(file)).equals(baseline),
    'the materialised file must equal the HEAD blob at every byte');

  const captured = await new Promise((resolve, reject) => {
    execFile('git', ['show', `${r.commit}:tracked.bin`],
      { cwd: fx.root, encoding: 'buffer' }, (error, stdout) => {
        if (error) reject(error); else resolve(Buffer.from(stdout));
      });
  });
  assert.ok(captured.equals(edited), 'the exact binary edit must remain recoverable from the discard ref');
});

test('DISCARD: restoring a tracked executable proves content, type, and executable mode', async (t) => {
  if (process.platform === 'win32') return t.skip('Windows worktrees do not expose Git executable mode');
  const fx = await newRepo('discard-tracked-executable');
  t.after(() => fx.cleanup());
  const baseFile = path.join(fx.root, 'bin', 'tool.sh');
  await fs.mkdir(path.dirname(baseFile), { recursive: true });
  await fs.writeFile(baseFile, Buffer.from('#!/bin/sh\nprintf baseline\\n\n'));
  await fs.chmod(baseFile, 0o755);
  await fx.commit('track executable baseline');
  assert.match(await fx.git(['ls-tree', 'HEAD', '--', 'bin/tool.sh']), /^100755 blob /,
    'fixture must commit an executable, or it proves nothing');

  const wt = await fx.worktree('executable-edited');
  const file = path.join(wt, 'bin', 'tool.sh');
  const edited = Buffer.from('#!/bin/sh\nprintf edited\\n\n');
  await fs.writeFile(file, edited);
  await fs.chmod(file, 0o644);
  const r = await discard(fx.root, [file]);
  assert.equal(r.ok, true, `executable discard must succeed: ${JSON.stringify(r)}`);

  const st = await fs.lstat(file);
  assert.equal(st.isFile(), true, 'HEAD entry must be restored as a regular file');
  assert.equal(st.isSymbolicLink(), false, 'HEAD regular file must not become a symlink');
  assert.notEqual(st.mode & 0o111, 0, 'HEAD executable bit must be restored');
  assert.ok((await fs.readFile(file)).equals(Buffer.from('#!/bin/sh\nprintf baseline\\n\n')),
    'HEAD executable content must be restored exactly');
  assert.match(await fx.git(['ls-tree', r.commit, '--', 'bin/tool.sh']), /^100644 blob /,
    'the discard ref must retain the thrown-away non-executable mode as well as its bytes');
});

test('DISCARD: a modified tracked symlink is restored as the exact HEAD symlink', async (t) => {
  if (process.platform === 'win32') return t.skip('tracked symlink creation is privilege/config dependent on Windows');
  const fx = await newRepo('discard-tracked-symlink-restore');
  t.after(() => fx.cleanup());
  await fs.writeFile(path.join(fx.root, 'target-a.txt'), 'A stays\n');
  await fs.writeFile(path.join(fx.root, 'target-b.txt'), 'B stays\n');
  await fs.symlink(Buffer.from('target-a.txt'), Buffer.from(path.join(fx.root, 'tracked-link')));
  await fx.commit('track symlink baseline');
  assert.match(await fx.git(['ls-tree', 'HEAD', '--', 'tracked-link']), /^120000 blob /,
    'fixture must commit a symlink, or it proves nothing');

  const wt = await fx.worktree('symlink-edited');
  const link = path.join(wt, 'tracked-link');
  await fs.rm(link);
  await fs.symlink(Buffer.from('target-b.txt'), Buffer.from(link));
  const r = await discard(fx.root, [link]);
  assert.equal(r.ok, true, `tracked symlink discard must succeed: ${JSON.stringify(r)}`);
  assert.deepEqual(r.reverted, [link]);
  assert.equal((await fs.lstat(link)).isSymbolicLink(), true, 'the restored entry must still be a symlink');
  assert.equal(await fs.readlink(link), 'target-a.txt', 'the link target bytes must match HEAD');
  assert.equal(await fs.readFile(path.join(wt, 'target-b.txt'), 'utf8'), 'B stays\n',
    'restoring the link must never write through it to either target');
  assert.equal((await fx.git(['show', `${r.commit}:tracked-link`])).trim(), 'target-b.txt',
    'the changed link target must remain recoverable from the discard ref');
});

test('DISCARD: a tracked deletion is captured as a HEAD-parented tombstone and restored', async (t) => {
  const fx = await newRepo('discard-tracked-deletion');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('deleted');
  const file = path.join(wt, 'src/base.js');
  const baseline = await fs.readFile(file);
  await fs.rm(file);

  const r = await discard(fx.root, [file]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.reverted, [file]);
  assert.ok((await fs.readFile(file)).equals(baseline), 'discard must restore the deleted HEAD entry');
  assert.match(await fx.git(['diff', '--name-status', `${r.commit}^`, r.commit, '--', 'src/base.js']),
    /^D\s+src\/base\.js$/m, 'the capture must encode absence relative to its exact HEAD parent');
  const parent = await fx.git(['rev-parse', `${r.commit}^`]);
  assert.equal(parent.trim(), (await fx.git(['rev-parse', 'HEAD'], wt)).trim());
});

test('DISCARD: a tracked directory captures every selected leaf and restores the recursive HEAD tree', async (t) => {
  const fx = await newRepo('discard-tracked-directory');
  t.after(() => fx.cleanup());
  await fx.write('pkg/a.txt', 'A baseline\n');
  await fx.write('pkg/b.txt', 'B baseline\n');
  await fx.commit('tracked directory baseline');
  const wt = await fx.worktree('directory-edits');
  await fs.writeFile(path.join(wt, 'pkg/a.txt'), 'A edited\n');
  await fs.rm(path.join(wt, 'pkg/b.txt'));
  await fs.writeFile(path.join(wt, 'pkg/new.txt'), 'new only\n');

  const r = await discard(fx.root, [path.join(wt, 'pkg')]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(await fs.readFile(path.join(wt, 'pkg/a.txt'), 'utf8'), 'A baseline\n');
  assert.equal(await fs.readFile(path.join(wt, 'pkg/b.txt'), 'utf8'), 'B baseline\n');
  await assert.rejects(() => fs.lstat(path.join(wt, 'pkg/new.txt')));
  assert.equal((await fx.git(['show', `${r.commit}:pkg/a.txt`])).trim(), 'A edited');
  assert.equal((await fx.git(['show', `${r.commit}:pkg/new.txt`])).trim(), 'new only');
  await assert.rejects(
    () => sh('git', ['show', `${r.commit}:pkg/b.txt`], fx.root).then((v) => {
      if (v.code !== 0) throw new Error(v.stderr);
      return v;
    }),
    'the captured tree must preserve the selected deletion too',
  );
});

test('DISCARD RACE: a same-name replacement created after capture is never erased', async (t) => {
  const fx = await newRepo('discard-replacement-race');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('replacement');
  const file = path.join(wt, 'scratch.txt');
  await fs.writeFile(file, 'captured generation A\n');

  const r = await discard(fx.root, [file], {
    onAfterCapture: async () => fs.writeFile(file, 'concurrent generation B\n', { flag: 'wx' }),
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(await fs.readFile(file, 'utf8'), 'concurrent generation B\n',
    'the path created after quarantine belongs to the concurrent writer');
  assert.equal((await fx.git(['show', `${r.commit}:scratch.txt`])).trim(), 'captured generation A');
});

test('DISCARD RACE: an open descriptor retains physical quarantine instead of risking late bytes', async (t) => {
  if (process.platform !== 'linux') return t.skip('/proc descriptor proof is Linux-specific');
  const fx = await newRepo('discard-open-fd');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('open-writer');
  const file = path.join(wt, 'live.txt');
  await fs.writeFile(file, 'generation A\n');
  const handle = await fs.open(file, 'r+');
  t.after(() => handle.close().catch(() => {}));

  const r = await discard(fx.root, [file]);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.error, /held by an active process/);
  assert.ok(r.activeHandles.some((entry) => entry.pid === process.pid && /^fd:/.test(entry.kind)),
    JSON.stringify(r.activeHandles));
  assert.ok(Array.isArray(r.quarantine) && r.quarantine.length === 1);
  assert.equal(await fs.readFile(r.quarantine[0], 'utf8'), 'generation A\n',
    'the physical copy remains reachable while the descriptor can still write it');
  assert.equal((await fx.git(['show', `${r.commit}:live.txt`])).trim(), 'generation A');
});

test('DISCARD RECOVERY: printed shell command and structured argv are literal for hostile filenames', async (t) => {
  if (process.platform === 'win32') return t.skip('the printed command in this regression targets a POSIX shell');
  const fx = await newRepo('discard-restore-escaping');
  t.after(() => fx.cleanup());
  await fx.write('other.txt', 'committed other\n');
  await fx.commit('recovery escaping base');
  const wt = await fx.worktree('hostile-names');
  await fs.writeFile(path.join(wt, 'other.txt'), 'valuable unrelated edit\n');
  const names = [
    '*.txt',
    'space name.txt',
    "quote'file.txt",
    '$(touch PWNED).txt',
    '-leading.txt',
    'line\nbreak.txt',
  ];
  for (let i = 0; i < names.length; i++) await fs.writeFile(path.join(wt, names[i]), `payload ${i}\n`);

  const r = await discard(fx.root, names.map((name) => path.join(wt, name)));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.restoreArgv.slice(-names.length), names.map((name) => `:(literal)${name}`),
    'structured recovery must use literal Git pathspecs');
  const restored = await sh('/bin/sh', ['-c', r.restore], wt);
  assert.equal(restored.code, 0, `${r.restore}\n${restored.stderr}`);
  for (let i = 0; i < names.length; i++) {
    assert.equal(await fs.readFile(path.join(wt, names[i]), 'utf8'), `payload ${i}\n`, names[i]);
  }
  assert.equal(await fs.readFile(path.join(wt, 'other.txt'), 'utf8'), 'valuable unrelated edit\n',
    'the glob-shaped literal must not restore an unrelated tracked file');
  await assert.rejects(() => fs.lstat(path.join(wt, 'PWNED')),
    'command substitution syntax in a filename must remain inert');
});

test('DISCARD RACE: tracked restoration refuses rather than overwrite a post-capture replacement', async (t) => {
  const fx = await newRepo('discard-tracked-replacement-race');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('tracked-replacement');
  const file = path.join(wt, 'src/base.js');
  await fs.writeFile(file, 'captured edited generation\n');

  const r = await discard(fx.root, [file], {
    onAfterCapture: async () => fs.writeFile(file, 'concurrent replacement\n', { flag: 'wx' }),
  });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.error, /without overwriting concurrent work/);
  assert.equal(await fs.readFile(file, 'utf8'), 'concurrent replacement\n');
  assert.equal((await fx.git(['show', `${r.commit}:src/base.js`])).trim(), 'captured edited generation');
});

test('DISCARD RACE: replacing a parent with a symlink never redirects restoration', async (t) => {
  if (process.platform === 'win32') return t.skip('symlink creation is privilege-dependent on Windows');
  const fx = await newRepo('discard-parent-swap');
  t.after(() => fx.cleanup());
  await fx.write('pkg/valuable.txt', 'baseline\n');
  await fx.commit('parent swap baseline');
  const wt = await fx.worktree('parent-swap');
  const parent = path.join(wt, 'pkg');
  const movedParent = path.join(wt, 'pkg-before-swap');
  const external = path.join(wt, 'external-target');
  const file = path.join(parent, 'valuable.txt');
  await fs.writeFile(file, 'captured edit\n');
  await fs.mkdir(external);

  const r = await discard(fx.root, [file], {
    onAfterCapture: async () => {
      await fs.rename(parent, movedParent);
      await fs.symlink('external-target', parent);
    },
  });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.error, /parent directory identity changed/);
  await assert.rejects(() => fs.lstat(path.join(external, 'valuable.txt')),
    'Holt must not write HEAD through the replacement symlink');
  assert.equal((await fx.git(['show', `${r.commit}:pkg/valuable.txt`])).trim(), 'captured edit');
});

test('DISCARD RACE: a parent swapped before quarantine cannot redirect the rename outside the worktree', async (t) => {
  if (process.platform === 'win32') return t.skip('symlink creation is privilege-dependent on Windows');
  const fx = await newRepo('discard-pre-quarantine-parent-swap');
  t.after(() => fx.cleanup());
  await fx.write('pkg/victim.txt', 'repo baseline\n');
  await fx.commit('pre-quarantine swap baseline');
  const wt = await fx.worktree('pre-swap');
  const parent = path.join(wt, 'pkg');
  const realParent = path.join(wt, 'pkg-real');
  const external = path.join(wt, 'external');
  const file = path.join(parent, 'victim.txt');
  await fs.writeFile(file, 'repo edit stays\n');
  await fs.mkdir(external);
  await fs.writeFile(path.join(external, 'victim.txt'), 'external victim stays\n');

  const r = await discard(fx.root, [file], {
    onBeforeQuarantine: async () => {
      await fs.rename(parent, realParent);
      await fs.symlink('external', parent);
    },
  });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.error, /changed immediately before quarantine|changed before quarantine/);
  assert.equal(await fs.readFile(path.join(external, 'victim.txt'), 'utf8'), 'external victim stays\n',
    'no quarantine operation may be redirected through the replacement symlink');
  assert.equal(await fs.readFile(path.join(realParent, 'victim.txt'), 'utf8'), 'repo edit stays\n',
    'the original worktree edit stays in the renamed real parent');
  assert.equal(r.ref, null, 'the parent mismatch must be caught before capture/ref allocation');
});

test('DISCARD: every embedded repository and Git metadata selection fails before mutation', async (t) => {
  const fx = await newRepo('discard-clean-nested');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('nested-clean');
  const nested = path.join(wt, 'vendor/repo');
  await fs.mkdir(nested, { recursive: true });
  await sh('git', ['init', '-q'], nested);
  await fs.writeFile(path.join(nested, 'only.txt'), 'nested committed bytes\n');
  await sh('git', ['add', 'only.txt'], nested);
  const committed = await sh('git', ['commit', '-m', 'nested only commit', '--no-verify'], nested);
  assert.equal(committed.code, 0, committed.stderr);

  const nestedResult = await discard(fx.root, [nested]);
  assert.equal(nestedResult.ok, false, JSON.stringify(nestedResult));
  assert.match(nestedResult.error, /embedded Git boundary/);
  assert.equal(await fs.readFile(path.join(nested, 'only.txt'), 'utf8'), 'nested committed bytes\n');

  const metadataResult = await discard(fx.root, [path.join(wt, '.git')]);
  assert.equal(metadataResult.ok, false, JSON.stringify(metadataResult));
  assert.match(metadataResult.error, /Git repository metadata/);
  assert.equal((await fx.git(['rev-parse', '--is-inside-work-tree'], wt)).trim(), 'true',
    'the outer worktree must remain usable after refusing its .git file');
});

test('DISCARD: duplicate and ancestor-overlapping selections fail before quarantine', async (t) => {
  const fx = await newRepo('discard-overlap');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('overlap');
  await fs.mkdir(path.join(wt, 'dir'));
  await fs.writeFile(path.join(wt, 'dir/file.txt'), 'only copy\n');

  for (const selection of [
    [path.join(wt, 'dir'), path.join(wt, 'dir/file.txt')],
    [path.join(wt, 'dir/file.txt'), path.join(wt, 'dir/../dir/file.txt')],
  ]) {
    const r = await discard(fx.root, selection);
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.match(r.error, /overlap or name the same entry/);
    assert.equal(await fs.readFile(path.join(wt, 'dir/file.txt'), 'utf8'), 'only copy\n');
  }
});


/* ================================ the three catastrophic false negatives ==== */

test('CATASTROPHIC: a hand-authored file under vendor/ is not invisible', async (t) => {
  // FOUND BY AN ADVERSARIAL SWEEP AND REPRODUCED END TO END. `vendor` was on the GENERATED_DIRS
  // list, which makes a path invisible to gate, rescue, risk, clean AND the pre-tool-use guard —
  // a worktree whose only content sits there reads as byte-identical to an empty one.
  //
  // Observed before the fix: gate said "disposable", rescue said "nothingToRescue", the guard
  // ALLOWED `git worktree remove --force`, and after the removal the content existed in no git
  // object anywhere. Permanently gone, with holt having said three separate times that there was
  // nothing there.
  //
  // The rule the list now states: a directory belongs there only if its contents are REPRODUCIBLE
  // BY A COMMAND. `npm ci` rebuilds node_modules. Nothing reliably rebuilds a hand-patched
  // vendor/, and holt cannot tell a vendored-and-patched tree from a generated one.
  const fx = await newRepo('vendor-visible');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('vendored');
  await fx.write('vendor/patched.js', 'export function HAND_PATCHED_ONLY_COPY() { return 1; }\n', wt);

  const report = await inspect(fx.root);
  const verdict = report.safe.find((s) => s.id === 'vendored');
  assert.equal(verdict.safe, false,
    `a worktree whose only content is a hand-edited vendor/ file is NOT disposable: ${JSON.stringify(verdict)}`);

  const v = await assessCommand(`git worktree remove --force ${wt}`, fx.root);
  assert.equal(v.decision, 'deny',
    `the guard must refuse to lose it: ${JSON.stringify(v)}`);

  // A manifest makes these paths likely generated, but it does not prove these exact bytes can be
  // recreated; destructive authority keeps them visible and asks on direct cleanup.
  const fx2 = await newRepo('generated-still-invisible');
  t.after(() => fx2.cleanup());
  // The manifest IS the evidence — committed at base so every worktree checkout carries it.
  await fx2.write('package.json', '{"name":"fixture","private":true}\n');
  await fx2.commit('add the build manifest');
  const wt2 = await fx2.worktree('built');
  await fx2.write('node_modules/react/index.js', 'module.exports = 1;\n', wt2);
  await fx2.write('dist/bundle.js', 'console.log(1);\n', wt2);
  const r2 = await inspect(fx2.root);
  assert.equal(r2.safe.find((s) => s.id === 'built')?.safe, false,
    'generated-looking bytes must not silently license worktree deletion');
  const generatedDelete = await assessCommand('rm -rf node_modules dist', wt2);
  assert.equal(generatedDelete.decision, 'ask', JSON.stringify(generatedDelete));
});

test('CATASTROPHIC: stash drop/clear are destructive; pop remains recovery', async (t) => {
  // The refusal message this guard prints literally reads "No commit, index entry or stash holds
  // this content" — and nothing anywhere checked a stash. `git stash drop` was classified as
  // NOTHING AT ALL (kind:null) and allowed; dropping made the stash commit unreachable at once.
  //
  // Removing the WORKTREE does not lose a stash: refs/stash is repository-wide and shared across
  // worktrees. So the loss path is exactly these verbs, and they were the one part of it that was
  // unguarded — while `reset --hard`, which is no more final, has been covered from the start.
  //
  const { classifyCommand } = await import('../../src/agent.mjs');

  for (const cmd of ['git stash drop', 'git stash clear', 'git stash drop stash@{2}']) {
    const v = classifyCommand(cmd);
    assert.ok(v, `${cmd} destroys work and must be classified: got ${JSON.stringify(v)}`);
    assert.match(v.kind, /stash/, `and named for what it is: ${JSON.stringify(v)}`);
  }
  assert.equal(classifyCommand('git stash pop'), null,
    'pop applies before dropping and keeps the stash on conflict, so it has no destructive match');
  assert.equal(classifyCommand('git stash drop').verdict, null,
    'drop stays a flat deny — dropping IS the final, unrecoverable act');

  // ANTI-VACUITY. Reading a stash is not destroying one; if these tripped, every developer
  // inspecting their own stash would be interrupted, which is how a guard gets switched off.
  // A pathspec-scoped push is included here too: the invoker named exactly which files to sweep,
  // which bounds the blast radius on purpose (see 'git stash: bare sweeps ask, scoped ones don't'
  // in test/e2e/integration.test.mjs) — it is not classified as destructive at all.
  for (const cmd of [
    'git stash list', 'git stash show', 'git stash show -p', 'git stash apply',
    'git stash push -- src/agent.mjs',
  ]) {
    assert.equal(classifyCommand(cmd), null, `${cmd} is not destructive`);
  }

  // …while the UNSCOPED form of the exact same command — no pathspec at all — now IS classified,
  // which is the guard-asymmetry fix itself: `git stash push -u -m wip` used to sail through
  // `classifyCommand` unconditionally (kind:null, allowed no matter what it was about to sweep).
  // It must still allow a CLEAN worktree (asserted end-to-end in integration.test.mjs); the
  // assertion here is only that holt now looks at all.
  const swept = classifyCommand('git stash push -u -m wip');
  assert.ok(swept, 'a pathspec-less stash push must be classified so its blast radius gets checked');
  assert.match(swept.kind, /stash/);
  assert.equal(swept.verdict, 'ask', 'and capped at ask — stashing is ordinary, everyday work');
});

test('CATASTROPHIC: rescue REFUSES a dirty submodule instead of reporting it verified', async (t) => {
  // `git add --all --force` cannot record a submodule's uncommitted work — the only thing it can
  // write is the gitlink, and the gitlink moves only when something is COMMITTED inside. So for a
  // dirty submodule the rescue commit contained the same `160000 commit <sha>` it started with:
  // the path WAS in the tree, the containment check passed, and rescue reported
  // {ok:true, verified:true, capturedFiles:1} having captured nothing at all.
  //
  // That is worse than no rescue, because its output invites the deletion that follows.
  const fx = await newRepo('rescue-submodule');
  t.after(() => fx.cleanup());

  const sub = path.join(path.dirname(fx.root), 'subrepo');
  await fs.mkdir(sub, { recursive: true });
  await sh('git', ['init', '-q', '.'], sub);
  await sh('git', ['config', 'user.email', 't@t'], sub);
  await sh('git', ['config', 'user.name', 't'], sub);
  await fs.writeFile(path.join(sub, 'f.txt'), 'v1\n');
  await sh('git', ['add', '-A'], sub);
  await sh('git', ['commit', '-qm', 'init'], sub);

  const added = await sh('git',
    ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'packages/core'], fx.root);
  if (added.code !== 0) return t.skip(`submodule add unavailable: ${added.stderr.slice(0, 120)}`);
  await fx.commit('add submodule');

  const wt = await fx.worktree('withsub');
  await sh('git', ['-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init'], wt);
  // Uncommitted work INSIDE the submodule — the thing git cannot record from the superproject.
  await fs.writeFile(path.join(wt, 'packages', 'core', 'only-copy.txt'), 'SUBMODULE_ONLY_COPY\n');

  const r = await rescue(fx.root, 'withsub', {});
  assert.equal(r.ok, false,
    `a rescue that cannot capture the submodule's work must refuse, not report success: ${JSON.stringify(r)}`);
  assert.match(String(r.error ?? ''), /INCOMPLETE/,
    `and say what it could not capture: ${JSON.stringify(r)}`);
  assert.match(String(r.note ?? ''), /submodule/i,
    `and name the cause so the user can act: ${JSON.stringify(r)}`);
});


test('CATASTROPHIC: discard never follows a symlink into another file', async (t) => {
  // FOUND BY AN ADVERSARIAL SWEEP, in code written the same day. `discard` canonicalised the path
  // it was given, which resolves a symlink all the way to its TARGET, and the tracked-file branch
  // then wrote the target's committed bytes back to it. Reproduced end to end: `holt discard
  // link.txt` restored real.txt to its committed content, destroying real.txt's uncommitted work,
  // and left link.txt — the entry actually named — sitting there untouched.
  //
  // Two different questions were being answered with one helper: "is this path inside that
  // worktree" wants symlinks resolved; "which entry did the user name" must not resolve the final
  // component. relativeLinkAwareAsync canonicalises the directory and appends the basename
  // verbatim, so the /var-vs-/private/var class stays fixed without following the link.
  const fx = await newRepo('discard-symlink');
  t.after(() => fx.cleanup());
  await fx.write('real.txt', 'committed content\n');
  await fx.commit('base');

  const wt = await fx.worktree('linked');
  await fs.writeFile(path.join(wt, 'real.txt'), 'UNCOMMITTED_ONLY_COPY\n');
  try {
    await fs.symlink('real.txt', path.join(wt, 'link.txt'));
  } catch {
    return t.skip('this platform will not create a symlink here');
  }

  const r = await discard(fx.root, [path.join(wt, 'link.txt')]);
  assert.equal(r.ok, true, `discarding the link must succeed: ${JSON.stringify(r)}`);

  // THE ASSERTION THAT MATTERS: a different file's uncommitted work still exists.
  assert.equal(await fs.readFile(path.join(wt, 'real.txt'), 'utf8'), 'UNCOMMITTED_ONLY_COPY\n',
    'discarding a symlink must not touch what it points at');

  // ...and the entry the user actually named is the one that went.
  await assert.rejects(() => fs.lstat(path.join(wt, 'link.txt')),
    'the symlink itself should have been removed');

  // NEVER-WORSE: an ordinary tracked file must still REVERT rather than be deleted.
  await fs.writeFile(path.join(wt, 'real.txt'), 'edited again\n');
  const r2 = await discard(fx.root, [path.join(wt, 'real.txt')]);
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.deepEqual(r2.discarded, [], 'a tracked file is reverted, not deleted');
  assert.equal(await fs.readFile(path.join(wt, 'real.txt'), 'utf8'), 'committed content\n');
});


test('CATASTROPHIC: clean never fingerprints a symlink by what it points at', async (t) => {
  // THE SAME CLASS AS THE TEST ABOVE, one layer down, and it reached a DELETION.
  //
  // scan.mjs fingerprinted every touched file with a bare `fs.readFile`, which silently follows
  // symlinks and hashes the RESOLVED TARGET's bytes. A committed symlink's git blob is the target
  // path STRING — `git cat-file -p HEAD:link.js` prints the path and nothing else — so two
  // worktrees each committing an UNRELATED symlink, pointing at two DIFFERENT external files that
  // happened to hold identical bytes at scan time, fingerprinted identically. safeToDelete's
  // siblingCoverage saw a content match, reported each `safe: true, redundantWith: [the other]`,
  // and `clean --apply` would have removed the only copy of real work. Reproduced end to end
  // (discover -> scan -> analyze -> clean) before the fix.
  //
  // The fix is in one shared reader (content-identity.mjs `pathContentKey`): lstat first, key a
  // symlink by its target string. This test proves the fix at the level that actually deletes.
  const fx = await newRepo('clean-symlink-fingerprint');
  t.after(() => fx.cleanup());

  // Two targets OUTSIDE the repository whose bytes are identical right now.
  const ext = path.join(path.dirname(fx.root), 'ext');
  await fs.mkdir(ext, { recursive: true });
  const same = 'export function shared() { return 42; }\n';
  await fs.writeFile(path.join(ext, 'alpha-target.js'), same);
  await fs.writeFile(path.join(ext, 'beta-target.js'), same);

  const a = await fx.worktree('alpha');
  const b = await fx.worktree('beta');
  try {
    await fs.symlink(path.join(ext, 'alpha-target.js'), path.join(a, 'link.js'));
    await fs.symlink(path.join(ext, 'beta-target.js'), path.join(b, 'link.js'));
  } catch {
    return t.skip('this platform will not create a symlink here');
  }
  await fx.commit('alpha commits a link to its own target', a);
  await fx.commit('beta commits a link to a different target', b);

  // GROUND TRUTH, from git itself: the two worktrees' tracked content is provably DIFFERENT.
  const alphaTracked = await fx.git(['show', 'HEAD:link.js'], a);
  const betaTracked = await fx.git(['show', 'HEAD:link.js'], b);
  assert.notEqual(alphaTracked, betaTracked,
    'fixture is wrong if the two links track the same string');

  // POSITIVE CONTROL, in the same repository so a detector that simply went blind fails it: two
  // worktrees committing the SAME target string DO hold the same work. Deliberately dangling —
  // the pre-fix reader threw on these and returned null, so a genuinely redundant pair could
  // never be reclaimed either. Refusing more is not a fix.
  const c = await fx.worktree('gamma');
  const d = await fx.worktree('delta');
  await fs.symlink('../shared/thing.js', path.join(c, 'same.js'));
  await fs.symlink('../shared/thing.js', path.join(d, 'same.js'));
  await fx.commit('gamma commits a link', c);
  await fx.commit('delta commits the identical link', d);

  const disc = await discover(fx.root);
  const sc = await scan(disc, { symbols: false });
  const byId = (id) => sc.workstreams.find((w) => w.id === id);

  // THE FINGERPRINTS THEMSELVES, before any verdict reads them.
  assert.notEqual(byId('alpha').contentKeys['link.js'], byId('beta').contentKeys['link.js'],
    'links to different targets must not share a content key');
  assert.ok(byId('alpha').contentKeys['link.js'],
    'and they must still HAVE keys — two nulls agreeing is not a fix');
  assert.equal(byId('gamma').contentKeys['same.js'], byId('delta').contentKeys['same.js'],
    'identical committed links hold identical tracked content and must match');
  assert.ok(byId('gamma').contentKeys['same.js'], 'a dangling link still has tracked content');

  // THE VERDICT.
  const verdicts = safeToDelete(sc);
  const v = (id) => verdicts.find((x) => x.id === id);
  for (const id of ['alpha', 'beta']) {
    assert.equal(v(id).safe, false,
      `${id} holds the only copy of its link and must not be disposable: ${JSON.stringify(v(id))}`);
    assert.deepEqual(v(id).redundantWith, undefined,
      `${id} must not be reported as redundant with anyone`);
  }
  assert.equal(v('gamma').safe, true, `the genuine pair must still be reclaimable: ${JSON.stringify(v('gamma'))}`);
  assert.deepEqual(v('gamma').redundantWith, ['delta']);

  // AND THE COMMAND THAT DELETES. `clean --apply` must leave the false pair standing, and drain
  // the genuine pair to exactly one survivor (it re-verifies before each removal, so the last
  // member finds no sibling and is refused).
  const applied = await clean(fx.root, { apply: true, symbols: false });
  const acted = new Map(applied.actions.map((x) => [x.id, x.action]));
  assert.equal(acted.get('alpha'), undefined, `alpha must never enter the plan: ${JSON.stringify(applied)}`);
  assert.equal(acted.get('beta'), undefined, `beta must never enter the plan: ${JSON.stringify(applied)}`);
  assert.ok(await fs.stat(a).then(() => true, () => false), 'alpha worktree must still exist');
  assert.ok(await fs.stat(b).then(() => true, () => false), 'beta worktree must still exist');
  assert.equal(applied.quarantined, 1, `exactly one of the genuine pair is quarantined: ${JSON.stringify(applied)}`);

  // The work is still there, byte for byte, and git agrees the repository is intact.
  assert.equal(await fx.git(['show', 'HEAD:link.js'], a), alphaTracked);
  assert.equal(await fx.git(['show', 'HEAD:link.js'], b), betaTracked);
  const fsck = await fx.git(['fsck', '--strict', '--no-progress'], fx.root);
  assert.doesNotMatch(fsck, /missing|corrupt/i, `git fsck must be clean: ${fsck}`);
});


test('SYMLINK AUTHORITY: identical links at DIFFERENT paths are not deletion-redundant', async (t) => {
  // THE OTHER HALF OF THE DEFECT ABOVE — the half a false-positive-only fix leaves broken, and
  // the half no test in this repository could see.
  //
  // MEASURED, not assumed: with the pre-fix `fs.readFile` reader restored in
  // content-identity.mjs, the test above still passed its positive control — gamma and delta came
  // back `safe: true, redundantWith: [...]` even though their symlink content keys were both
  // `null`. They commit the identical link at the identical PATH, so they are mergedTree twins and
  // tree identity carries that verdict by itself. The control therefore proves nothing about the
  // symlink content key, and an implementation that keyed EVERY symlink `null` would pass the
  // whole file while quietly refusing to reclaim any linked worktree ever again.
  //
  // So: the same target string at DIFFERENT paths. Different paths mean different tree oids,
  // mergedTree twinning cannot answer, and the only instrument left is the symlink's own content
  // key. Deliberately dangling, because a dangling link is exactly where the pre-fix reader threw
  // and returned null. Refusing more is not a fix: two worktrees whose entire committed delta is
  // provably the same tracked content ARE mutually redundant, and holt has to say so.
  const fx = await newRepo('clean-symlink-recall');
  t.after(() => fx.cleanup());

  const e = await fx.worktree('epsilon');
  const z = await fx.worktree('zeta');
  try {
    await fs.mkdir(path.join(e, 'x'), { recursive: true });
    await fs.mkdir(path.join(z, 'y'), { recursive: true });
    await fs.symlink('../vendor/dep.js', path.join(e, 'x', 'same.js'));
    await fs.symlink('../vendor/dep.js', path.join(z, 'y', 'same.js'));
  } catch {
    return t.skip('this platform will not create a symlink here');
  }
  await fx.commit('epsilon commits the link under x/', e);
  await fx.commit('zeta commits the same link under y/', z);

  // GROUND TRUTH from git: the tracked content is the same string at both paths.
  assert.equal(await fx.git(['show', 'HEAD:x/same.js'], e), await fx.git(['show', 'HEAD:y/same.js'], z),
    'fixture is wrong if the two links do not track the same string');

  const disc = await discover(fx.root);
  const sc = await scan(disc, { symbols: false });
  const byId = (id) => sc.workstreams.find((w) => w.id === id);

  // THE FIXTURE INVARIANT THAT MAKES THIS TEST MEAN ANYTHING: the OTHER instrument is blind here,
  // so whatever verdict follows came from the symlink content key and nothing else.
  assert.notEqual(byId('epsilon').committed.mergedTree, byId('zeta').committed.mergedTree,
    'same content at different paths must NOT be mergedTree twins, or this test proves nothing');

  assert.ok(byId('epsilon').contentKeys['x/same.js'],
    'a dangling committed link still has tracked content: its target string');
  assert.equal(byId('epsilon').contentKeys['x/same.js'], byId('zeta').contentKeys['y/same.js'],
    'identical target strings are identical tracked content, at whatever path they sit');

  // Content similarity is useful review evidence, but paths are part of Git work and therefore
  // part of destructive authority.
  const verdicts = safeToDelete(sc);
  const v = (id) => verdicts.find((x) => x.id === id);
  for (const id of ['epsilon', 'zeta']) {
    assert.equal(v(id).safe, false,
      `${id} is the only holder at its path and must survive: ${JSON.stringify(v(id))}`);
    assert.equal(v(id).redundantWith, undefined);
  }

  // AND THE COMMAND THAT DELETES: neither enters the clean plan.
  const applied = await clean(fx.root, { apply: true, symbols: false });
  assert.equal(applied.quarantined, 0, `different paths must not be collapsed: ${JSON.stringify(applied)}`);
  const survivors = await Promise.all([e, z].map((p) => fs.stat(p).then(() => p, () => null)));
  const alive = survivors.filter(Boolean);
  assert.equal(alive.length, 2, `both worktrees survive: ${JSON.stringify(survivors)}`);
  const fsck2 = await fx.git(['fsck', '--strict', '--no-progress'], fx.root);
  assert.doesNotMatch(fsck2, /missing|corrupt/i, `git fsck must be clean: ${fsck2}`);
});


test('SYMLINK LAYERS: untracked and dirty links are keyed by target too, and neither licences a delete', async (t) => {
  // PROVE PRESENCE BEFORE TRUSTING SILENCE. scan.mjs claims the single `pathContentKey` loop over
  // `result.touched` is "the whole content-identity surface — there is no second, unfixed path for
  // one of the layers". Committed is pinned two tests up. This pins the other two layers, so the
  // claim is measured rather than asserted in a comment: if a future refactor fingerprints
  // untracked or dirty paths through some other reader, this goes red rather than going quiet.
  //
  // It also pins the SECOND rule these layers depend on. A content match with a NON-DURABLE holder
  // is an observation, never a licence: the sibling's copy is one `git checkout` from gone, and
  // holt never sees that moment. So even a genuine untracked twin must leave `safe` false.
  const fx = await newRepo('symlink-layers');
  t.after(() => fx.cleanup());

  const ext = path.join(path.dirname(fx.root), 'ext');
  await fs.mkdir(ext, { recursive: true });
  const same = 'export function shared() { return 42; }\n';
  await fs.writeFile(path.join(ext, 'alpha-target.js'), same);
  await fs.writeFile(path.join(ext, 'beta-target.js'), same);

  const a = await fx.worktree('alpha');
  const b = await fx.worktree('beta');

  // THE DIRTY LAYER first, because `fx.commit` stages EVERYTHING in the worktree: committed
  // pointing at one target, retargeted on disk to the other. What is fingerprinted must be what
  // is ON DISK NOW (the new target string) — that is the whole reason a dirty path cannot vouch
  // for a sibling's deletion.
  try {
    await fs.symlink(path.join(ext, 'alpha-target.js'), path.join(a, 'tracked.js'));
  } catch {
    return t.skip('this platform will not create a symlink here');
  }
  await fx.commit('alpha commits a link', a);
  await fs.unlink(path.join(a, 'tracked.js'));
  await fs.symlink(path.join(ext, 'beta-target.js'), path.join(a, 'tracked.js'));

  // THE UNTRACKED LAYER, created after the commit so it stays untracked.
  await fs.symlink(path.join(ext, 'alpha-target.js'), path.join(a, 'note.js'));
  await fs.symlink(path.join(ext, 'beta-target.js'), path.join(b, 'note.js'));

  // A GENUINE untracked twin: same target string in two worktrees.
  const c = await fx.worktree('gamma');
  const d = await fx.worktree('delta');
  await fs.symlink('../shared/thing.js', path.join(c, 'twin.js'));
  await fs.symlink('../shared/thing.js', path.join(d, 'twin.js'));

  const sc = await scan(await discover(fx.root), { symbols: false });
  const byId = (id) => sc.workstreams.find((w) => w.id === id);
  const A = byId('alpha');

  // EVERY LAYER REACHED THE READER, and every one of them got a SYMLINK key ('l:'), not the
  // bytes at the other end of the link.
  assert.ok(A.uncommitted.untracked.includes('note.js'), `untracked layer: ${JSON.stringify(A.uncommitted)}`);
  assert.ok(A.uncommitted.files.includes('tracked.js'), `dirty layer: ${JSON.stringify(A.uncommitted)}`);
  for (const f of ['note.js', 'tracked.js']) {
    assert.match(A.contentKeys[f] ?? '', /^l:/,
      `${f} must be keyed as a symlink, not by its target's bytes: ${A.contentKeys[f]}`);
  }
  assert.equal(A.contentKeys['tracked.js'], byId('beta').contentKeys['note.js'],
    'a retargeted link fingerprints as the target it points at NOW, which is beta\'s target');

  // THE FALSE PAIR, one layer down from the committed one: two untracked links to two different
  // targets that hold identical bytes right now.
  assert.notEqual(A.contentKeys['note.js'], byId('beta').contentKeys['note.js'],
    'untracked links to different targets must not share a content key');

  // THE GENUINE untracked twin DOES match — going blind is not the fix here either...
  assert.ok(byId('gamma').contentKeys['twin.js'], 'an untracked link still has content');
  assert.equal(byId('gamma').contentKeys['twin.js'], byId('delta').contentKeys['twin.js'],
    'identical untracked links hold identical content and must match');

  // ...and STILL does not licence a deletion, because neither copy is committed.
  const verdicts = safeToDelete(sc);
  for (const id of ['alpha', 'beta', 'gamma', 'delta']) {
    const v = verdicts.find((x) => x.id === id);
    assert.equal(v.safe, false,
      `${id}'s only holder is uncommitted and must not make it disposable: ${JSON.stringify(v)}`);
  }
});


test('AUTO: does every lossless thing by itself, and refuses to delete anything', async (t) => {
  // THE AUTOPILOT LINE, asserted rather than described.
  //
  // Lossless actions are automated because being wrong is recoverable: a lock placed on a worktree
  // that did not need one costs nothing and the next run releases it. Destructive actions are NOT,
  // however confident the verdict — holt was wrong about 8 of 10 worktrees on its own repository
  // the day this was written, and an automatic sweep is exactly as safe as the verdict behind it.
  //
  // The handover is not a warning. This project's own A/B measured warning-only agents freezing at
  // 0% cleanup while agents given a PERMITTED ACTION reached 73%: what works is handing over a
  // concrete safe move WITH the evidence, which is what `needsYou.command` is.
  const fx = await newRepo('autopilot');
  t.after(() => fx.cleanup());

  const risky = await fx.worktree('holds-work');
  await fx.write('only.js', 'export function ONLY_COPY() { return 1; }\n', risky);
  await fx.worktree('empty-one');
  await fx.worktree('empty-two');

  const r = await auto(fx.root, {});

  // It ACTED on the lossless half.
  assert.ok(r.did.protected >= 1, `at-risk work must be locked automatically: ${JSON.stringify(r.did)}`);
  assert.equal(r.atRisk.count, 1, `and reported: ${JSON.stringify(r.atRisk)}`);
  assert.ok(r.atRisk.ids.includes('holds-work'));

  // It DID NOT delete, and it handed the decision over with the command.
  assert.ok(r.needsYou.disposable >= 2, `the empty worktrees must be surfaced: ${JSON.stringify(r.needsYou)}`);
  assert.equal(r.needsYou.command, 'holt clean --apply', 'the handover names an exact, safe move');
  assert.match(r.needsYou.why, /will not remove them by itself/i, 'and says why it stopped');

  // THE ASSERTION THAT MATTERS: nothing was removed from disk.
  for (const id of ['empty-one', 'empty-two', 'holds-work']) {
    await fs.stat(fx.wt(id));   // throws if auto deleted it
  }

  // ...and the work it locked is still there, byte for byte.
  assert.equal(await fs.readFile(path.join(risky, 'only.js'), 'utf8'),
    'export function ONLY_COPY() { return 1; }\n');

  // IDEMPOTENT: running it again locks nothing new and still deletes nothing.
  const again = await auto(fx.root, {});
  assert.equal(again.did.protected, 0, 'a second run has nothing left to lock');
  assert.equal(again.atRisk.count, 1, 'and the verdict is unchanged');
  await fs.stat(fx.wt('empty-one'));
});


test('RECALL: mutually redundant worktrees are disposable, and the LAST one never is', async (t) => {
  // "BASE LACKS THIS" IS NOT "DELETING THIS LOSES IT", and the difference was the entire recall
  // gap. Scored against an independent oracle across 50 languages and 900 worktrees, disposable
  // precision was 1.00 and recall 0.40 — of 250 genuinely disposable worktrees holt reclaimed 100
  // and abstained on 150, every one of them carrying the single reason "N file(s) base lacks".
  //
  // Those 150 were mutually redundant: identical content in more than one worktree. Base does lack
  // it, so the check fired — but a living sibling holds the same work, so removing any one loses
  // nothing. Perfect precision at 0.40 recall is not a safe tool; it is a tool that answers "I
  // cannot be sure" to most of its own question, which is also what refusing everything achieves.
  //
  // THE SAFETY PROPERTY IS THE POINT OF THIS TEST, not the recall. The verdict is relative to the
  // siblings that exist right now, and `clean --apply` re-verifies immediately before each
  // removal — so the set must drain to exactly ONE survivor, never zero, with nobody sequencing it.
  const fx = await newRepo('redundant');
  t.after(() => fx.cleanup());

  // Three worktrees carrying byte-identical committed work that base does not have.
  const ids = ['twin-a', 'twin-b', 'twin-c'];
  for (const id of ids) {
    const wt = await fx.worktree(id);
    await fx.write('shared-feature.js', 'export function SHARED_WORK() { return 7; }\n', wt);
    await fx.commit('the same work, three times', wt);
  }

  const before = await inspect(fx.root);
  const verdicts = ids.map((id) => before.safe.find((s) => s.id === id));

  // RECALL: each is individually disposable, and says WHY.
  for (const v of verdicts) {
    assert.equal(v.safe, true,
      `a worktree whose content a living sibling also holds is disposable: ${JSON.stringify(v)}`);
    assert.ok(Array.isArray(v.redundantWith) && v.redundantWith.length >= 1,
      `and the report must name the siblings it is relying on: ${JSON.stringify(v)}`);
  }

  // PRECISION: run the real destructive command and count what survives.
  const cleaned = await clean(fx.root, { apply: true });
  const left = [];
  for (const id of ids) {
    try { await fs.stat(fx.wt(id)); left.push(id); } catch { /* removed */ }
  }

  assert.equal(left.length, 1,
    `the active set must drain to exactly one survivor, never zero: quarantined=${cleaned.quarantined}, left=${JSON.stringify(left)}`);
  assert.equal(cleaned.quarantined, 2, 'the two other members remain recoverable in quarantine');

  // …and the work itself is still on disk, which is the only thing that actually matters.
  const survivor = await fs.readFile(path.join(fx.wt(left[0]), 'shared-feature.js'), 'utf8');
  assert.match(survivor, /SHARED_WORK/, 'the shared work must survive in the last worktree');

  // The survivor is now the ONLY copy, so it must no longer read as disposable.
  const after = await inspect(fx.root);
  assert.equal(after.safe.find((s) => s.id === left[0])?.safe, false,
    'once its siblings are gone the last member holds the only copy and must be refused');

  // NEVER-WORSE: a worktree holding genuinely unique committed work is still refused, or this
  // change would have traded the catastrophic class for recall.
  const solo = await fx.worktree('solo');
  await fx.write('only-here.js', 'export function ONLY_COPY() { return 1; }\n', solo);
  await fx.commit('unique work', solo);
  const soloVerdict = (await inspect(fx.root)).safe.find((s) => s.id === 'solo');
  assert.equal(soloVerdict.safe, false,
    `work no sibling holds must still be refused: ${JSON.stringify(soloVerdict)}`);
});

test('SAFETY: a sibling holding the identical bytes UNCOMMITTED is not a durable backup', async (t) => {
  // THE LOSS WINDOW THIS CLOSES, stated as the sequence that destroys the work:
  //
  //   1. `keeper` COMMITS work.js. Its copy is in the object store: recoverable forever.
  //   2. `sloppy` holds the identical bytes, never committed — a working-tree file, nothing more.
  //   3. holt matched the two on content identity and called `keeper` safe:true,
  //      redundantWith ['sloppy'] — because both copies existed ON DISK at scan time.
  //   4. `clean --apply` re-verifies (both still on disk, both still matching) and removes
  //      `keeper`. The committed, recoverable copy is the one that goes.
  //   5. Anything at all happens in `sloppy` — `git checkout`, an editor revert, the next agent
  //      writing that path — and the last copy is gone. None of those is a holt command; holt's
  //      gate never runs, git never warns, and the content existed nowhere else.
  //
  // The re-verification in step 4 cannot close this: it proves the bytes are on disk at the
  // instant of removal, which was never in doubt. The question is whether the SURVIVOR is
  // recoverable, and an uncommitted file is not. So a redundancy claim now requires the sibling's
  // matching copy to be COMMITTED. Uncommitted matches are still reported — they are true, and
  // naming them tells a human the one action that would make the worktree disposable — but they
  // cannot produce safe:true.
  //
  // Every content body below is DISTINCT on purpose: content identity is scan-wide, so one shared
  // body would let an unrelated case's committed copy vouch for another's and each assertion
  // would stop testing what it says it tests.
  const fx = await newRepo('durable-redundancy');
  t.after(() => fx.cleanup());

  const UNTRACKED_BODY = 'export function UNTRACKED_TWIN_WORK() { return 1; }\n';
  const PAIR_BODY = 'export function COMMITTED_PAIR_WORK() { return 2; }\n';
  const STAGED_BODY = 'export function STAGED_TWIN_WORK() { return 3; }\n';
  const DIRTIED_BODY = 'export function DIRTIED_OVER_WORK() { return 4; }\n';

  // (a) THE WINDOW — committed here, UNTRACKED in the sibling.
  const keeper = await fx.worktree('keeper');
  await fx.write('feat/shared-untracked/work.js', UNTRACKED_BODY, keeper);
  await fx.commit('keeper: committed, recoverable', keeper);
  const sloppy = await fx.worktree('sloppy');
  await fx.write('feat/shared-untracked/work.js', UNTRACKED_BODY, sloppy); // never added, never committed

  // (a2) STAGED IS NOT COMMITTED. `git add` writes a blob but no ref reaches it; a reset, a
  // checkout or a gc takes it, and nothing in git's UI calls that a loss.
  const staged = await fx.worktree('staged-holder');
  await fx.write('feat/shared-staged/work.js', STAGED_BODY, staged);
  await fx.git(['add', 'feat/shared-staged/work.js'], staged);
  const committedStaged = await fx.worktree('committed-vs-staged');
  await fx.write('feat/shared-staged/work.js', STAGED_BODY, committedStaged);
  await fx.commit('committed-vs-staged: the only committed copy of this body', committedStaged);

  // (a3) COMMITTED THEN MODIFIED ON TOP. The path IS in the sibling's committed delta, but the
  // bytes fingerprinted from disk are the MODIFIED ones — the commit does not hold them and
  // cannot vouch for them. Without this distinction "is the path committed" would pass for
  // "are these bytes committed".
  const dirtied = await fx.worktree('dirty-holder');
  await fx.write('feat/shared-dirty/work.js', 'export function SOMETHING_ELSE() { return 0; }\n', dirtied);
  await fx.commit('dirty-holder: commits one thing…', dirtied);
  await fx.write('feat/shared-dirty/work.js', DIRTIED_BODY, dirtied); // …then overwrites it, uncommitted
  const committedDirty = await fx.worktree('committed-vs-dirty');
  await fx.write('feat/shared-dirty/work.js', DIRTIED_BODY, committedDirty);
  await fx.commit('committed-vs-dirty: the only committed copy of this body', committedDirty);

  // (b) THE CONTROL, and the recall this must not cost: two COMMITTED copies of one body.
  for (const id of ['pair-x', 'pair-y']) {
    const wt = await fx.worktree(id);
    await fx.write('feat/shared-pair/pair.js', PAIR_BODY, wt);
    await fx.commit(`${id}: the same work, committed`, wt);
  }

  const report = await inspect(fx.root);
  const v = (id) => report.safe.find((s) => s.id === id);
  const u = (id) => report.unique.find((s) => s.id === id);

  // NON-VACUITY FIRST, and deliberately blind to WHICH field the holder lands in: the match
  // itself must be FOUND, or every assertion below passes for the wrong reason (holt simply not
  // seeing the twin would satisfy "not disposable" while proving nothing about durability).
  const seesTwin = (x) => [...(x.redundantWith ?? []), ...(x.redundantWithUncommitted ?? [])];
  assert.deepEqual(seesTwin(v('keeper')), ['sloppy'],
    `holt must SEE the sibling's identical bytes: ${JSON.stringify(v('keeper'))}`);
  assert.deepEqual(seesTwin(v('committed-vs-staged')), ['staged-holder'],
    JSON.stringify(v('committed-vs-staged')));
  assert.deepEqual(seesTwin(v('committed-vs-dirty')), ['dirty-holder'],
    JSON.stringify(v('committed-vs-dirty')));

  // (a) THE REFUSAL.
  assert.equal(v('keeper').safe, false,
    `a committed copy must not be deleted because a sibling holds it UNCOMMITTED: ${JSON.stringify(v('keeper'))}`);
  assert.equal(v('keeper').redundantWith, undefined,
    `redundantWith is what every consumer reads as "safe, someone else has it" — an uncommitted `
    + `holder must never appear there: ${JSON.stringify(v('keeper'))}`);
  assert.ok(v('keeper').reasons.some((r) => /UNCOMMITTED there/.test(r)),
    `the refusal must say WHY it declines a match it can plainly see: ${JSON.stringify(v('keeper').reasons)}`);

  // …and `unique` must AGREE. Two commands giving opposite answers about the same bytes is the
  // failure this codebase keeps paying for: `risk` saying "nothing found nowhere else" beside a
  // gate that refuses to delete it.
  assert.ok(u('keeper').uniqueSymbolCount > 0,
    `unique must not report the work as held elsewhere while safeToDelete refuses to delete it: `
    + `${JSON.stringify(u('keeper'))}`);

  // (a2) and (a3).
  assert.equal(v('committed-vs-staged').safe, false,
    `staged-but-uncommitted is not a durable copy: ${JSON.stringify(v('committed-vs-staged'))}`);
  assert.deepEqual(v('committed-vs-staged').redundantWithUncommitted, ['staged-holder'],
    JSON.stringify(v('committed-vs-staged')));
  assert.equal(v('committed-vs-dirty').safe, false,
    `a committed PATH whose on-disk bytes are modified does not vouch for those bytes: `
    + `${JSON.stringify(v('committed-vs-dirty'))}`);
  assert.deepEqual(v('committed-vs-dirty').redundantWithUncommitted, ['dirty-holder'],
    JSON.stringify(v('committed-vs-dirty')));

  // (b) RECALL PRESERVED — committed on both sides is still redundant, still disposable.
  assert.equal(v('pair-x').safe, true, JSON.stringify(v('pair-x')));
  assert.equal(v('pair-y').safe, true, JSON.stringify(v('pair-y')));
  assert.deepEqual(v('pair-x').redundantWith, ['pair-y'], JSON.stringify(v('pair-x')));
  assert.deepEqual(v('pair-y').redundantWith, ['pair-x'], JSON.stringify(v('pair-y')));
  assert.equal(v('pair-x').redundantWithUncommitted, undefined, JSON.stringify(v('pair-x')));

  // THE REAL DESTRUCTIVE COMMAND, because a verdict that never reaches `clean` proves nothing.
  const cleaned = await clean(fx.root, { apply: true });
  const alive = async (id) => { try { await fs.stat(fx.wt(id)); return true; } catch { return false; } };

  for (const id of ['keeper', 'committed-vs-staged', 'committed-vs-dirty']) {
    assert.equal(await alive(id), true,
      `${id} holds the only DURABLE copy of its work and must survive: quarantined=${JSON.stringify(cleaned.quarantined)}`);
  }
  // …and the work itself is on disk, which is the only thing that actually matters.
  assert.match(await fs.readFile(path.join(fx.wt('keeper'), 'feat/shared-untracked/work.js'), 'utf8'),
    /UNTRACKED_TWIN_WORK/);

  const pairLeft = [];
  for (const id of ['pair-x', 'pair-y']) if (await alive(id)) pairLeft.push(id);
  assert.equal(pairLeft.length, 1,
    `the genuinely durable pair must still drain to exactly one survivor — this fix must not buy `
    + `safety by refusing everything: left=${JSON.stringify(pairLeft)}`);
});

test('AUTHORITY: reindented work at a different path is similar but not disposable',
  async (t) => {
    // MEASURED against an independent 50-language, 900-worktree oracle: `mergedTree` whole-tree
    // identity (the ONLY redundancy check before this test was written) requires two worktrees'
    // entire committed state to hash to one git tree oid — which can only happen at the SAME
    // paths. It is blind to the shape the oracle's own duplicate-triangle fixture plants in every
    // one of its 50 repositories: one new file, at a DIFFERENT path, reindented from spaces to
    // tabs. Same work by the oracle's own definition (delete either worktree and it survives in
    // the sibling) — invisible to path-and-byte identity. This is that exact shape, reproduced.
    const fx = await newRepo('redundant-reindent');
    t.after(() => fx.cleanup());

    const alpha = await fx.worktree('dup-alpha');
    await fx.write('feat/alpha/thing.py',
      'class PyThing:\n    def method(self):\n        return 1\n\ndef free_fn(): pass\n', alpha);
    await fx.commit('alpha: implement the thing', alpha);

    const beta = await fx.worktree('dup-beta');
    await fx.write('feat/beta/thing.py',
      // Same code, different path, tabs instead of 4 spaces — every indented byte differs.
      'class PyThing:\n\tdef method(self):\n\t\treturn 1\n\ndef free_fn(): pass\n', beta);
    await fx.commit('beta: implement the identical thing, reindented', beta);

    const before = await inspect(fx.root);
    const va = before.safe.find((s) => s.id === 'dup-alpha');
    const vb = before.safe.find((s) => s.id === 'dup-beta');

    assert.equal(va.safe, false, `dup-alpha has distinct Git bytes/path: ${JSON.stringify(va)}`);
    assert.equal(vb.safe, false, `dup-beta has distinct Git bytes/path: ${JSON.stringify(vb)}`);
    assert.equal(va.redundantWith, undefined, JSON.stringify(va));
    assert.equal(vb.redundantWith, undefined, JSON.stringify(vb));

    // NEVER-WORSE: a sibling that merely LOOKS like part of the same fan-out (same directory
    // shape) but holds genuinely different code must not be swept up by the match.
    const gamma = await fx.worktree('dup-gamma');
    await fx.write('feat/gamma/thing.py',
      'class PyThing:\n    def method(self):\n        return 999\n\ndef different_fn(): pass\n', gamma);
    await fx.commit('gamma: a DIFFERENT implementation', gamma);
    const withGamma = await inspect(fx.root);
    const vg = withGamma.safe.find((s) => s.id === 'dup-gamma');
    assert.equal(vg.safe, false, `genuinely different code must never be called redundant: ${JSON.stringify(vg)}`);

    // The destructive command preserves every non-exact worktree.
    const cleaned = await clean(fx.root, { apply: true });
    const left = [];
    for (const id of ['dup-alpha', 'dup-beta', 'dup-gamma']) {
      try { await fs.stat(fx.wt(id)); left.push(id); } catch { /* removed */ }
    }
    assert.ok(left.includes('dup-gamma'), `the unique worktree must survive: quarantined=${cleaned.quarantined}`);
    assert.equal(left.length, 3, `similarity must not authorise deletion: left=${JSON.stringify(left)}`);
  });

test('PRECISION: one matched file and one genuinely unique file must still be refused, not partially cleared',
  async (t) => {
    // The danger this guards: content-identity matching must be PER FILE, not "some file of mine
    // matches somewhere, so I am redundant". A worktree holding one file a sibling also has, AND
    // one file nobody else has, still holds real unique work and must not be swept.
    const fx = await newRepo('redundant-partial');
    t.after(() => fx.cleanup());

    const a = await fx.worktree('partial-a');
    await fx.write('shared/dup.py', 'def shared_thing():\n    return 1\n', a);
    await fx.write('only/unique.py', 'def ONLY_HERE():\n    return "nobody else has this"\n', a);
    await fx.commit('partial-a: one shared file, one unique file', a);

    const b = await fx.worktree('partial-b');
    // Same content as shared/dup.py, different path and indentation — a real match — but NOTHING
    // matching only/unique.py.
    await fx.write('renamed/dup.py', 'def shared_thing():\n\treturn 1\n', b);
    await fx.commit('partial-b: only the shared file, reindented', b);

    const report = await inspect(fx.root);
    const va = report.safe.find((s) => s.id === 'partial-a');
    assert.equal(va.safe, false,
      `partial-a holds real unique work (only/unique.py) and must stay refused: ${JSON.stringify(va)}`);
    assert.ok(va.reasons.some((r) => /file\(s\) base lacks/.test(r)), JSON.stringify(va));
  });

/* ============================================== LINE-ENDING-ONLY vs BASE ==== */

test('AUTHORITY: line-ending-only similarity to base is advisory, never disposable',
  async (t) => {
    // MEASURED against the 50-language independent-oracle benchmark's `wt-crlf` fixture class:
    // the SAME FILE re-saved with CRLF line endings instead of LF. `merge-tree` correctly reports
    // "base lacks this exact tree" — a CRLF byte and an LF byte are different bytes to git — but
    // base holds the identical TEXT, so nothing here is unique work.
    //
    // Deliberately built WITHOUT a living sibling (no other worktree holds a copy of this file):
    // the sibling-content-identity mechanism (siblingCoverage, above) cannot reach this case by
    // construction — it only ever compares live workstreams to each other, never to base. This is
    // the shape that mechanism cannot see, and the ONLY thing that can prove it is a direct
    // comparison against base itself.
    const fx = await newRepo('crlf-vs-base');
    t.after(() => fx.cleanup());
    await fx.write('src/eol.py', 'def thing():\n    return 1\n\ndef other():\n    return 2\n');
    await fx.commit('base: add eol.py with LF endings');

    const wt = await fx.worktree('crlf-only');
    // Every line's terminator becomes \r\n; not one character of actual content changes.
    await fx.write('src/eol.py', 'def thing():\r\n    return 1\r\n\r\ndef other():\r\n    return 2\r\n', wt);
    await fx.commit('re-save eol.py with CRLF endings, nothing else', wt);

    const before = await inspect(fx.root);
    const v = before.safe.find((s) => s.id === 'crlf-only');
    assert.equal(v.safe, false, `different line-ending bytes must survive: ${JSON.stringify(v)}`);
    assert.equal(v.redundantWith, undefined, JSON.stringify(v));
    assert.ok(v.reasons.some((r) => /file\(s\) base lacks/.test(r)), JSON.stringify(v));

    // The real destructive command preserves it.
    const cleaned = await clean(fx.root, { apply: true });
    assert.ok(await fs.stat(fx.wt('crlf-only')),
      `clean --apply must preserve line-ending bytes: ${JSON.stringify(cleaned)}`);

    // NEVER-WORSE #1: a BINARY file containing the byte pair 0x0D 0x0A is not a line ending, and a
    // genuine change to one must still be refused — binary content is never normalised.
    const binBase = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 32 }, (_, i) => i)]);
    await fx.write('assets/img.bin', binBase);
    await fx.commit('base: add a binary asset containing 0x0D 0x0A bytes');
    const binWt = await fx.worktree('binary-change');
    const binChanged = Buffer.from(binBase);
    binChanged[10] = 0xff; // a genuine byte-level change, unrelated to the 0x0D 0x0A pair
    await fx.write('assets/img.bin', binChanged, binWt);
    await fx.commit('change a pixel', binWt);
    const vBin = (await inspect(fx.root)).safe.find((s) => s.id === 'binary-change');
    assert.equal(vBin.safe, false,
      `a genuine binary change must never be waved through as line-ending noise: ${JSON.stringify(vBin)}`);
    assert.equal(vBin.redundantWith, undefined, JSON.stringify(vBin));

    // NEVER-WORSE #2: a MODE-ONLY change (chmod +x, byte-identical content) is "another kind of
    // change" and must still be refused — identical bytes is not the same claim as identical file.
    await fx.write('src/tool.sh', '#!/bin/sh\necho hi\n');
    await fx.commit('base: add tool.sh, not executable');
    const modeWt = await fx.worktree('mode-only');
    // `git update-index --chmod=+x`, not fs.chmod: NTFS has no executable bit, so Node's chmod is
    // a no-op there, `git add` staged nothing, and the commit below exited 1 with "nothing to
    // commit" — the fixture failing to CREATE the case, reported as the detector failing to
    // refuse it. git's index carries the mode independently of the filesystem, so this plants a
    // real mode-only change on all three platforms.
    await fx.git(['update-index', '--chmod=+x', 'src/tool.sh'], fx.wt('mode-only'));
    await fx.git(['commit', '-m', 'chmod +x, no content change'], fx.wt('mode-only'));
    // ANTI-VACUITY: the commit must really be mode-only, or "must not be classified as
    // line-ending noise" below is asserted against a case that was never planted.
    const modeDiff = await fx.git(['show', '--raw', '--format=', 'HEAD'], fx.wt('mode-only'));
    assert.match(modeDiff, /:100644 100755 /,
      `the planted change must be a real 644->755 mode change, got: ${modeDiff}`);
    const vMode = (await inspect(fx.root)).safe.find((s) => s.id === 'mode-only');
    assert.equal(vMode.safe, false,
      `a mode-only change must not be classified as line-ending noise: ${JSON.stringify(vMode)}`);

    // NEVER-WORSE #3: ALL FILES, NOT SOME. One file line-ending-only plus one file genuinely
    // edited must still be refused in full — a partial match must never authorise a delete.
    await fx.write('src/eol2.py', 'def alpha():\n    return 1\n');
    await fx.write('src/plain.py', 'def beta():\n    return 2\n');
    await fx.commit('base: two more files');
    const mixedWt = await fx.worktree('mixed-partial');
    await fx.write('src/eol2.py', 'def alpha():\r\n    return 1\r\n', mixedWt); // line-ending-only
    await fx.write('src/plain.py', 'def beta():\n    return 999\n', mixedWt); // a REAL edit
    await fx.commit('one line-ending-only file, one real edit', mixedWt);
    const vMixed = (await inspect(fx.root)).safe.find((s) => s.id === 'mixed-partial');
    assert.equal(vMixed.safe, false,
      `one genuinely-changed file must block the WHOLE workstream, not just itself: ${JSON.stringify(vMixed)}`);
    assert.ok(vMixed.reasons.some((r) => /file\(s\) base lacks/.test(r)), JSON.stringify(vMixed));

    // NEVER-WORSE #4: an ADDED file base never had at all — even with CRLF endings and no sibling
    // — is not "line-ending noise vs base": there is no base counterpart to normalise against.
    const addedWt = await fx.worktree('added-crlf');
    await fx.write('src/brand-new.py', 'def new_thing():\r\n    return 1\r\n', addedWt);
    await fx.commit('a brand new CRLF file base never had', addedWt);
    const vAdded = (await inspect(fx.root)).safe.find((s) => s.id === 'added-crlf');
    assert.equal(vAdded.safe, false,
      `a file base never had at all must still count as unique work: ${JSON.stringify(vAdded)}`);
    assert.equal(vAdded.redundantWith, undefined, JSON.stringify(vAdded));
  });

/* ================================================== CONCURRENT CAPTURES ==== */

// holt is invoked from agent hooks, and running MULTIPLE holt processes at once in the SAME
// worktree is the normal case, not an edge case: several agents (or several rapid-fire hook
// invocations from one agent) can each trigger a capture before the previous one finishes.
//
// rescue() and discard() build their tree in a scratch git index (GIT_INDEX_FILE), so that the
// worktree's own index is never touched. That scratch index used to live at a FIXED path scoped
// only by the worktree directory (`.git-holt-rescue-index`, `.git-holt-discard-index`) — the
// same file for every concurrent call on that worktree. Two processes racing read-tree/add/
// write-tree against ONE index file can each observe the OTHER's staged content: a write-tree
// can capture a mix of both calls' files, or capture neither because a concurrent read-tree
// reset the index between this call's add and its own write-tree. A wrong tree in a capture path
// means captured work that is not the work — the exact failure these commands exist to prevent.

test('DISCARD: concurrent discards of DIFFERENT files in the SAME worktree never cross-contaminate', async (t) => {
  const fx = await newRepo('discard-concurrent');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('shared');

  const N = 16;
  const names = [];
  for (let i = 0; i < N; i++) {
    const name = `mine-${i}.txt`;
    await fx.write(name, `content of file ${i}\n`, wt);
    names.push(name);
  }

  // Fire all N concurrently — this is the reproduction. Before the fix, this reliably produced
  // refs holding several OTHER calls' files apiece, plus spurious "capture is INCOMPLETE"
  // failures for calls whose own staged file got wiped by a concurrent read-tree.
  const results = await Promise.all(names.map((name) => discard(fx.root, [path.join(wt, name)])));

  for (let i = 0; i < N; i++) {
    const name = names[i];
    const r = results[i];
    assert.equal(r.ok, true, `discard(${name}) must succeed under concurrency: ${JSON.stringify(r)}`);

    // The capture is a HEAD-parented tree so deletion tombstones and directory type changes are
    // representable. Its DELTA must contain exactly this call's path — nothing borrowed from a
    // sibling call, nothing missing.
    const ls = await sh('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', `${r.ref}^`, r.ref], fx.root);
    const captured = ls.stdout.split('\n').filter(Boolean).sort();
    assert.deepEqual(captured, [name],
      `discard(${name})'s ref must contain exactly its own file, got ${JSON.stringify(captured)} `
      + `(a shared scratch-index path would leak other calls' files in here)`);
  }

  // And the filesystem agrees: every named file is gone, nothing else was touched.
  for (const name of names) {
    await assert.rejects(() => fs.stat(path.join(wt, name)), `${name} must have been removed`);
  }
});

test('RESCUE: concurrent rescues of the SAME worktree never report a spurious incomplete capture',
  async (t) => {
    // Unlike discard, rescue captures the worktree's WHOLE state, so every concurrent call here
    // is asking for the same content. The bug this guards is not cross-contamination between
    // callers (there is only one true answer) but a concurrent `read-tree` wiping THIS call's
    // staged `add` out from under it before its own `write-tree` runs — which surfaces as a false
    // "rescue is INCOMPLETE" refusal for a worktree that was never actually incomplete.
    const fx = await newRepo('rescue-concurrent');
    t.after(() => fx.cleanup());
    const wt = await fx.worktree('busy');
    await fx.write('unique.js', 'export function RESCUE_RACE_SYMBOL() { return 1; }\n', wt);

    const N = 12;
    const results = await Promise.all(Array.from({ length: N }, () => rescue(fx.root, 'busy', {})));

    for (const r of results) {
      assert.equal(r.ok, true, `every concurrent rescue must succeed: ${JSON.stringify(r)}`);
      assert.equal(r.verified, true, `every concurrent rescue must verify: ${JSON.stringify(r)}`);
      const ls = await sh('git', ['ls-tree', '-r', '--name-only', r.commit], fx.root);
      const captured = ls.stdout.split('\n').filter(Boolean);
      assert.ok(captured.includes('unique.js'),
        `every ref must contain the worktree's actual content, got ${JSON.stringify(captured)}`);
    }
  });

/* ============================================ JOURNAL FAILURE SURFACING ==== */

/**
 * appendEvent() has always refused to throw and always written a loud stderr line on failure —
 * but protect/rescue/discard/clean all did `await appendEvent(...)` and threw the {ok, error} it
 * returned straight in the bin. That is invisible to exactly the callers who most need it: an
 * MCP client and a `--json` script never see this process's stderr, only the RESULT OBJECT. So a
 * disk-full or read-only journal directory produced a response indistinguishable from "captured
 * AND recorded" for every caller that matters — the mutation happened, the audit line describing
 * it did not, and nothing in the response said so.
 *
 * Each test below breaks the journal path the same way test/e2e/branches.test.mjs's journal test
 * does — occupying `.git/holt` with a FILE where the journal's directory must go, which makes
 * every appendEvent() in that repo fail with EEXIST deterministically, on any platform, without
 * relying on chmod (which does not deny root, and this suite must not assume it never runs as
 * root). Every test asserts BOTH halves: the caller is told (journalWarning/journalFailures on
 * the result), AND the underlying mutation still fully happened — a journal failure must never
 * become a reason to pretend the action didn't work, and must never block it either.
 */
function breakJournal(root) {
  return fs.writeFile(path.join(root, '.git', 'holt'), 'not a directory', 'utf8');
}

test('JOURNAL FAILURE: protect() tells the caller AND still locks the worktree', async (t) => {
  const fx = await newRepo('journal-protect');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('valuable');
  await fx.write('only.js', 'export function ONLY_COPY() { return 1; }\n', wt);

  await breakJournal(fx.root);

  const p = await protect(fx.root, {});

  // THE MUTATION MUST STILL HAVE HAPPENED — a journal failure must never become a reason to
  // hold back the protection this command exists to provide.
  assert.equal(p.protected, 1, `the lock must still be placed: ${JSON.stringify(p)}`);
  const list = await sh('git', ['worktree', 'list', '--porcelain'], fx.root);
  assert.match(list.stdout, /locked/, 'git itself must show the worktree as locked');

  // THE CALLER MUST BE TOLD — in the result object itself, not only on stderr, because an MCP
  // client or a `--json` consumer never reads this process's stderr.
  assert.ok(p.journalWarning, `a journal failure must be reported in the result: ${JSON.stringify(p)}`);
  assert.ok(Array.isArray(p.journalFailures) && p.journalFailures.length >= 1,
    `the failure(s) must be itemised: ${JSON.stringify(p)}`);
  assert.equal(p.journalFailures[0].action, 'protect');
  assert.equal(p.journalFailures[0].id, 'valuable', 'the failure must name WHICH workstream, so it can be recovered manually');

  // And the journal genuinely has no record of it — this is not a false alarm.
  await fs.rm(path.join(fx.root, '.git', 'holt'));
  const { readJournal } = await import('../../src/journal.mjs');
  const events = await readJournal(fx.root);
  assert.ok(!events.some((e) => e.action === 'protect'), 'the protect event must genuinely be absent from the journal');
});

test('JOURNAL FAILURE: rescue() tells the caller AND the capture is still real and verified', async (t) => {
  const fx = await newRepo('journal-rescue');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('holder');
  await fx.write('src/only.js', 'export function ONLY_COPY_RESCUE() { return 1; }\n', wt);

  await breakJournal(fx.root);

  const r = await rescue(fx.root, 'holder', {});

  // THE CAPTURE MUST STILL BE REAL — read it back out of the ref, not the worktree, exactly as
  // the non-failure rescue tests do.
  assert.equal(r.ok, true, `the rescue must still succeed: ${JSON.stringify(r)}`);
  assert.equal(r.verified, true);
  const show = await sh('git', ['show', `${r.commit}:src/only.js`], fx.root);
  assert.equal(show.code, 0, 'the ref must actually contain the captured file');
  assert.match(show.stdout, /ONLY_COPY_RESCUE/);

  // THE CALLER MUST BE TOLD, with enough to recover manually: the ref that WAS created.
  assert.ok(r.journalWarning, `a journal failure must be reported: ${JSON.stringify(r)}`);
  assert.ok(r.journalFailures?.length >= 1);
  assert.equal(r.journalFailures[0].action, 'rescue');
  assert.equal(r.journalFailures[0].ref, r.ref, 'the failure must name the ref, so the untracked rescue can still be found');
});

test('JOURNAL FAILURE: discard() tells the caller AND the content is still captured and removed', async (t) => {
  const fx = await newRepo('journal-discard');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('scratch');
  await fx.write('notes.md', 'the only copy of this\n', wt);

  await breakJournal(fx.root);

  const r = await discard(fx.root, [path.join(wt, 'notes.md')]);

  assert.equal(r.ok, true, `discard must still succeed: ${JSON.stringify(r)}`);
  assert.equal(r.verified, true);
  await assert.rejects(() => fs.stat(path.join(wt, 'notes.md')), 'the path must actually be removed');
  const show = await sh('git', ['show', `${r.commit}:notes.md`], fx.root);
  assert.equal(show.stdout, 'the only copy of this\n', 'the discarded content must be recoverable from the ref');

  assert.ok(r.journalWarning, `a journal failure must be reported: ${JSON.stringify(r)}`);
  assert.ok(r.journalFailures?.length >= 1);
  assert.equal(r.journalFailures[0].action, 'discard');
  assert.equal(r.journalFailures[0].ref, r.ref);
});

test('JOURNAL FAILURE: clean --apply tells the caller AND still quarantines the disposable worktree', async (t) => {
  const fx = await newRepo('journal-clean');
  t.after(() => fx.cleanup());
  await fx.worktree('spent');

  await breakJournal(fx.root);

  const c = await clean(fx.root, { apply: true });

  assert.equal(c.quarantined, 1, `the disposable worktree must still be quarantined: ${JSON.stringify(c)}`);
  await assert.rejects(() => fs.stat(fx.wt('spent')), 'the original active path must be vacated');
  assert.ok(await fs.stat(c.quarantines[0].quarantinePath), 'journal failure must not erase the retained worktree');

  assert.ok(c.journalWarning, `a journal failure must be reported: ${JSON.stringify(c)}`);
  assert.ok(c.journalFailures?.length >= 1);
  assert.equal(c.journalFailures[0].action, 'clean-quarantine');
  assert.equal(c.journalFailures[0].id, 'spent');
});

test('JOURNAL FAILURE: never a reason to refuse — protect/rescue/discard/clean all still ACT', async (t) => {
  // NEVER-WORSE, stated as its own test: a broken journal must not make holt MORE conservative.
  // "Refuses more" is not automatically an improvement — a tool that stops protecting or
  // capturing work because its OWN audit trail is unwritable would trade a metrics gap for the
  // exact data loss it exists to prevent, which is a strictly worse failure mode.
  const fx = await newRepo('journal-never-worse');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('important');
  await fx.write('vital.js', 'export function VITAL() { return 1; }\n', wt);

  await breakJournal(fx.root);

  const p = await protect(fx.root, {});
  assert.equal(p.failed, 0, 'a journal failure must not be reported as a protect failure');
  assert.equal(p.protected, 1);

  const r = await rescue(fx.root, 'important', {});
  assert.equal(r.ok, true, 'a journal failure must not turn a good rescue into a refusal');
});

/* -------------------------------- protection must be claimed only when it happened ---- */

/**
 * `holt auto` TOLD EVERY SOLO USER THEIR AT-RISK WORK WAS LOCKED, WHILE REPORTING protected: 0.
 *
 * The note was emitted whenever `atRisk` was non-empty — "locked — git itself now refuses to
 * remove these" — two fields below `protected: 0` in the same JSON object. Both cannot be true,
 * and `git worktree list --porcelain` showed no `locked` attribute at all.
 *
 * In a single-worktree repository this is permanent rather than a race: `git worktree lock`
 * refuses the main working tree outright ("fatal: The main working tree cannot be locked or
 * unlocked"). holt asked, git declined, holt recorded the failure in its own payload — and then
 * announced the protection anyway. A false all-clear about protection is worse than no
 * protection, because it is the one that gets acted on.
 *
 * And `holt protect` exited 0 with `failed: 1`, so `holt protect && <proceed>` proceeded.
 */
test('PROTECT: a lock git refused is never reported as a lock', async (t) => {
  const fx = await newRepo('protect-truthful');
  t.after(() => fx.cleanup());
  await fx.write('only.js', 'export function PROTECT_TRUTH_SOLE() {}\n');

  const a = await auto(fx.root, {});
  assert.equal(a.did.protected, 0, 'PRECONDITION: git cannot lock a main working tree');
  assert.equal(a.atRisk.count, 1, 'PRECONDITION: the work really is at risk');
  assert.equal(a.atRisk.locked, 0, 'and nothing was locked');
  assert.doesNotMatch(a.atRisk.note, /^locked —/,
    `the note must not open by claiming a lock that did not happen: ${a.atRisk.note}`);
  assert.match(a.atRisk.note, /could NOT be locked/i, a.atRisk.note);
  assert.match(a.atRisk.note, /rescue|Commit/i,
    `and it must say what DOES make the work durable: ${a.atRisk.note}`);

  // The exit code is the contract scripts chain on.
  const p = await protect(fx.root, {});
  assert.equal(p.protected, 0);
  assert.equal(p.failed, 1, `the failure must be recorded: ${JSON.stringify(p.actions)}`);
});

test('PROTECT: NEVER-WORSE — a linked worktree holding work is still locked, and says so', async (t) => {
  // Without this, the fix above is satisfied by a `protect` that never claims anything.
  const fx = await newRepo('protect-neverworse');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('holder');
  await fx.write('w.js', 'export function LINKED_SOLE() {}\n', wt);

  const p = await protect(fx.root, {});
  assert.equal(p.failed, 0, `a linked worktree must lock cleanly: ${JSON.stringify(p.actions)}`);
  assert.equal(p.protected, 1, `and be counted: ${JSON.stringify(p.actions)}`);

  const a = await auto(fx.root, {});
  assert.ok(a.atRisk.locked >= 1 || a.did.protected >= 1,
    `auto must be able to report a real lock: ${JSON.stringify(a.atRisk)}`);
});

/**
 * THE ESCAPE HATCH MUST BE WALKABLE, because it is what keeps the guard installed.
 *
 * WHEN THIS BITES, in real work: the moment a developer decides to throw something away on purpose.
 * They try `git worktree remove --force ../failed-experiment`, the guard refuses with
 * "If the work is genuinely disposable, commit or discard it explicitly first", and the obvious
 * next thing to type is `holt discard ../failed-experiment`.
 *
 * MEASURED before this fix: a worktree ROOT resolves to the EMPTY relative path, which reached git
 * as `add --force -- ''` and returned "fatal: empty string is not a valid pathspec". holt reported
 * `capture is INCOMPLETE — 1 path(s) not captured: ` with an empty name — telling the reader
 * neither what they did wrong nor what to do instead. Fail-closed was correct throughout (nothing
 * deleted, exit 1), so this was never a safety defect; it was a dead end at the exact moment the
 * product most needs to get out of the way. Every failed escape is a step toward switching the
 * guard off, and an uninstalled guard protects nothing.
 *
 * NOT fixed by making discard swallow a whole worktree: `discard` captures PATHS and removes them,
 * leaving the worktree registered, while `rescue` captures a WORKTREE so it can then be removed.
 * Conflating them would make the more dangerous operation reachable by accident.
 */
test('DISCARD: naming a worktree instead of a path says so, and names the command that works', async (t) => {
  const fx = await newRepo('discard-worktree-root');
  t.after(() => fx.cleanup());

  const wt = await fx.worktree('failed-experiment');
  await fx.write('experiment.js', 'export function abandoned() { return 1; }\n', wt);

  const r = await discard(fx.root, [wt]);

  assert.equal(r.ok, false, 'naming a worktree root is not a discard');
  assert.match(r.error, /worktree, not a path inside one/,
    `the error must say what was wrong, got: ${r.error}`);
  assert.match(r.hint ?? '', /holt rescue/,
    'it must name the command that actually does this');
  assert.match(r.note ?? '', /NOTHING WAS CAPTURED OR REMOVED/,
    'it must confirm nothing was touched');

  // AND NOTHING WAS TOUCHED — the refusal is not allowed to be destructive on its way out.
  const still = await fs.readFile(path.join(wt, 'experiment.js'), 'utf8');
  assert.match(still, /abandoned/, 'the file must be exactly where it was');
});

test('DISCARD: NEVER-WORSE — naming an actual file still captures, verifies and removes', async (t) => {
  const fx = await newRepo('discard-file-still-works');
  t.after(() => fx.cleanup());

  // The whole point of the fix above is that it narrows ONE input shape. If it narrowed the
  // ordinary case too, it would have traded a bad error message for a broken escape hatch.
  const wt = await fx.worktree('has-junk');
  await fx.write('scratch.js', 'export function junk() { return 1; }\n', wt);

  const r = await discard(wt, ['scratch.js']);

  assert.equal(r.ok, true, `discarding a real file must still work: ${r.error ?? ''}`);
  assert.equal(r.verified, true, 'the capture must be verified before anything is removed');
  assert.deepEqual(r.discarded, ['scratch.js']);
  assert.deepEqual(r.restoreArgv?.slice(0, 2), ['git', 'restore'],
    'the structured recovery command must use plain Git');
  assert.match(r.restoreArgv?.find((arg) => arg.startsWith('--source=')) ?? '', /^--source=[0-9a-f]+$/,
    'the structured recovery command must name the immutable capture commit');
  assert.equal(r.restoreArgv?.at(-1), ':(literal)scratch.js',
    'the recovery command must preserve the selected path as a literal Git pathspec');

  await assert.rejects(() => fs.readFile(path.join(wt, 'scratch.js'), 'utf8'),
    'the file must actually be gone');
});

test('RESURRECTION: a second discard must NEVER overwrite an earlier capture ref', async (t) => {
  // The same class the rescue RESURRECTION test above pins, reached through a different door.
  // `discard` allocated its ref with a bare `update-ref` — no must-not-exist old-value — so two
  // discards landing on one name replaced the first capture's ONLY pointer. discard DELETES
  // untracked files, so nothing else holds that content and the orphaned commit lives only until
  // gc. The `-${stamp}` suffix made the collision unlikely, never impossible, and "unlikely" is
  // the argument captureRef's own comment refuses.
  //
  // The stamp is injected because a wall-clock ref name cannot be made to collide on purpose —
  // which is exactly why this path had no test and no mutation covering it.
  const fx = await newRepo('discard-id-reuse');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('recycled');
  const STAMP = 'FIXED-STAMP-FOR-COLLISION';

  await fx.write('first.txt', 'the only copy of the FIRST thing\n', wt);
  const r1 = await discard(fx.root, [path.join(wt, 'first.txt')], { stamp: STAMP });
  assert.equal(r1.ok, true, `first discard must succeed: ${JSON.stringify(r1)}`);
  const firstCommit = (await sh('git', ['rev-parse', r1.ref], fx.root)).stdout.trim();
  assert.ok(firstCommit, 'the first capture must have a resolvable ref');

  // A SECOND discard, same worktree id, same stamp => the same baseRef is requested.
  await fx.write('second.txt', 'the only copy of the SECOND thing\n', wt);
  const r2 = await discard(fx.root, [path.join(wt, 'second.txt')], { stamp: STAMP });
  assert.equal(r2.ok, true, `second discard must succeed: ${JSON.stringify(r2)}`);

  // THE INVARIANT: the first capture is still there, unchanged, and still holds its content.
  assert.notEqual(r2.ref, r1.ref, 'the second discard must get its own ref, not clobber the first');
  const firstStill = (await sh('git', ['rev-parse', '--verify', '--quiet', r1.ref], fx.root)).stdout.trim();
  assert.equal(firstStill, firstCommit, 'the FIRST capture must survive a same-name second discard');

  const firstShow = await sh('git', ['show', `${r1.ref}:first.txt`], fx.root);
  assert.equal(firstShow.stdout, 'the only copy of the FIRST thing\n',
    'the first capture must still be RECOVERABLE — a surviving ref that lost its content is no better');
  const secondShow = await sh('git', ['show', `${r2.ref}:second.txt`], fx.root);
  assert.equal(secondShow.stdout, 'the only copy of the SECOND thing\n',
    'and the second capture holds its own content');
});
