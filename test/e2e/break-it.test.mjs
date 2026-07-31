/**
 * grove — BREAK IT.
 *
 * The other suites ask "does grove find what we planted?". This one asks the opposite and much
 * more important question: **can grove be made to give a DANGEROUS wrong answer?**
 *
 * There is exactly one catastrophic failure mode for this tool. Not a missed duplicate, not a
 * noisy collision — those cost attention. The catastrophic one is:
 *
 *      grove says SAFE TO DELETE, and it is not.
 *
 * Every scenario below is built to force that outcome, from a real thing agents do. A scenario
 * that grove handles correctly is not a passing test — it is a failed attack, and it is recorded
 * as such so nobody mistakes this file for a victory lap.
 *
 * Written adversarially on purpose: these are not "does the feature work" tests, they are
 * attempts to construct the wrong answer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { newRepo } from '../fixtures.mjs';
import { discover } from '../../src/discover.mjs';
import { scan } from '../../src/scan.mjs';
import { analyze } from '../../src/analyze.mjs';
import { assessCommand } from '../../src/agent.mjs';

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

async function inspect(root, opts = {}) {
  const disc = await discover(root, opts);
  return analyze(await scan(disc, opts), opts);
}

const verdict = (report, id) => report.safe.find((s) => s.id === id);

/** The single assertion that matters. */
function mustNotBeSafe(report, id, attack) {
  const v = verdict(report, id);
  assert.ok(v, `ATTACK "${attack}": workstream '${id}' vanished from the report entirely`);
  assert.equal(v.safe, false,
    `ATTACK SUCCEEDED — "${attack}": grove called '${id}' disposable. Reasons given: ${v.reasons.join('; ')}`);
}

/* =========================================================== deletions ==== */

test('ATTACK: a workstream that only DELETES code (grove tracks ADDED symbols)', async (t) => {
  const fx = await newRepo('del');
  t.after(() => fx.cleanup());

  // grove's symbol layer computes head-minus-base — deletions produce NO added symbols at all.
  // If safety rested on symbols alone, a worktree that removes a critical function would look
  // empty and be recommended for deletion, destroying the removal.
  const wt = await fx.worktree('deleter');
  await fs.rm(path.join(wt, 'src/base.js'));
  await fx.commit('remove baseline entirely', wt);

  const report = await inspect(fx.root);
  mustNotBeSafe(report, 'deleter', 'committed deletion produces zero added symbols');
});

test('ATTACK: an UNCOMMITTED deletion', async (t) => {
  const fx = await newRepo('deluncommitted');
  t.after(() => fx.cleanup());

  const wt = await fx.worktree('uncommitted-deleter');
  await fs.rm(path.join(wt, 'src/base.js'));

  const report = await inspect(fx.root);
  mustNotBeSafe(report, 'uncommitted-deleter', 'uncommitted deletion, no added symbols anywhere');
});

test('ATTACK: a pure whitespace/comment edit with no symbols at all', async (t) => {
  const fx = await newRepo('ws');
  t.after(() => fx.cleanup());

  const wt = await fx.worktree('whitespace');
  await fx.write('src/base.js',
    '// carefully reasoned explanation an agent spent an hour on\nexport function baseline() { return 1; }\n', wt);

  const report = await inspect(fx.root);
  mustNotBeSafe(report, 'whitespace', 'edit that introduces no new symbols');
});

/* ============================================================= renames ==== */

test('ATTACK: a symbol RENAME (looks like add+delete to a symbol differ)', async (t) => {
  const fx = await newRepo('rename');
  t.after(() => fx.cleanup());

  const wt = await fx.worktree('renamer');
  await fx.write('src/base.js', 'export function renamedBaseline() { return 1; }\n', wt);
  await fx.commit('rename baseline -> renamedBaseline', wt);

  const report = await inspect(fx.root);
  mustNotBeSafe(report, 'renamer', 'rename presents as an unrelated add plus a silent delete');

  // And the rename must be visible as work, not silently absorbed.
  const u = report.unique.find((x) => x.id === 'renamer');
  assert.ok(u.uniqueSymbols.some((s) => s.endsWith(':renamedBaseline')),
    `the new name should surface as unique work: ${u.uniqueSymbols.join(', ')}`);
});

test('ATTACK: a file MOVE with identical content', async (t) => {
  const fx = await newRepo('move');
  t.after(() => fx.cleanup());

  const wt = await fx.worktree('mover');
  await sh('git', ['mv', 'src/base.js', 'src/relocated.js'], wt);
  await fx.commit('move base.js', wt);

  const report = await inspect(fx.root);
  mustNotBeSafe(report, 'mover', 'file move: same content, new path, no net new symbols');
});

/* ================================================= concurrent mutation ==== */

test('ATTACK: the worktree changes DURING the scan', async (t) => {
  const fx = await newRepo('race');
  t.after(() => fx.cleanup());

  const wt = await fx.worktree('racer');
  await fx.write('src/first.js', 'export function FIRST_SYMBOL() {}\n', wt);

  // Start a scan and mutate the worktree while it runs. grove must not crash, and must not
  // report the workstream as safe on the strength of a half-read state.
  const scanning = inspect(fx.root);
  await fx.write('src/second.js', 'export function SECOND_SYMBOL() {}\n', wt);
  await fs.writeFile(path.join(wt, 'src/third.js'), 'export function THIRD_SYMBOL() {}\n');
  const report = await scanning;

  mustNotBeSafe(report, 'racer', 'worktree mutated mid-scan');
});

test('ATTACK: a stale cache must not authorise a deletion', async (t) => {
  const fx = await newRepo('cache');
  t.after(() => fx.cleanup());

  const wt = await fx.worktree('cached');

  // 1. Scan while empty -> genuinely disposable, and the agent gate agrees.
  const before = await assessCommand(`git worktree remove ${wt}`, fx.root);
  assert.equal(before.decision, 'allow', 'an empty worktree should be removable');

  // 2. An agent now writes something valuable. If the cache were time-based rather than
  //    content-fingerprinted, the next answer would come from the stale scan and authorise
  //    destroying this file.
  await fx.write('src/suddenly-valuable.js', 'export function SUDDENLY_VALUABLE() {}\n', wt);

  const after = await assessCommand(`git worktree remove ${wt}`, fx.root);
  assert.equal(after.decision, 'deny',
    'ATTACK SUCCEEDED: a cached verdict authorised deleting work written after the scan');
  assert.match(after.reason, /SUDDENLY_VALUABLE/);
});

/* =================================================== misleading shapes ==== */

test('ATTACK: a worktree BEHIND base (ancestor, not descendant)', async (t) => {
  const fx = await newRepo('behind');
  t.after(() => fx.cleanup());

  const oldHead = (await fx.git(['rev-parse', 'HEAD'])).trim();
  await fx.write('src/newer.js', 'export function newerThing() {}\n');
  await fx.commit('base moves forward');

  const wtPath = path.join(fx.root, '..', 'wt', 'behind');
  await fs.mkdir(path.dirname(wtPath), { recursive: true });
  await sh('git', ['worktree', 'add', '--detach', wtPath, oldHead], fx.root);
  fx.worktrees.set('behind', wtPath);

  const report = await inspect(fx.root);
  // A worktree strictly behind base holds nothing base lacks — it genuinely IS disposable.
  // The attack is the inverse: grove must not invent work here.
  const v = verdict(report, 'behind');
  assert.equal(v.safe, true,
    `a worktree strictly behind base holds nothing; got: ${v.reasons.join('; ')}`);
  assert.equal(v.confidence, 'measured');
});

test('ATTACK: an agent REVERTS what base has, which is real work', async (t) => {
  const fx = await newRepo('revert');
  t.after(() => fx.cleanup());

  await fx.write('src/feature.js', 'export function shippedFeature() { return "v2"; }\n');
  await fx.commit('base ships v2');

  const wt = await fx.worktree('reverter');
  await fx.write('src/feature.js', 'export function shippedFeature() { return "v1"; }\n', wt);
  await fx.commit('revert to v1 after a regression', wt);

  const report = await inspect(fx.root);
  mustNotBeSafe(report, 'reverter', 'a revert adds no new symbol names, only changes a body');
});

test('ATTACK: coincidental common names must not fabricate duplicates', async (t) => {
  const fx = await newRepo('coincidence');
  t.after(() => fx.cleanup());

  // Two agents solving unrelated problems both write a helper called `handler`. Reporting them
  // as duplicate WORK would be a false positive that erodes trust in every real finding.
  const a = await fx.worktree('team-a-1');
  await fx.write('src/billing.js',
    'export function handler(req) { return chargeCard(req); }\nexport function chargeCard(r) { return r; }\n', a);
  await fx.commit('billing', a);

  const b = await fx.worktree('team-b-1');
  await fx.write('src/notifications.js',
    'export function handler(evt) { return sendEmail(evt); }\nexport function sendEmail(e) { return e; }\n', b);
  await fx.commit('notifications', b);

  const report = await inspect(fx.root);
  const dup = report.duplicates.find((d) =>
    (d.a === 'team-a-1' && d.b === 'team-b-1') || (d.a === 'team-b-1' && d.b === 'team-a-1'));

  if (dup) {
    // If reported at all, it must be weak — one shared generic name out of several symbols.
    assert.ok(dup.similarity < 0.5,
      `ATTACK SUCCEEDED: unrelated work reported as ${(dup.similarity * 100).toFixed(0)}% similar ` +
      `on shared symbols ${dup.sharedSymbols.join(', ')}`);
  }
  // Both hold real, distinct work regardless.
  mustNotBeSafe(report, 'team-a-1', 'coincidental name overlap');
  mustNotBeSafe(report, 'team-b-1', 'coincidental name overlap');
});

test('ATTACK: work hidden ONLY inside a .gitignore-d path', async (t) => {
  const fx = await newRepo('ignored');
  t.after(() => fx.cleanup());

  await fx.write('.gitignore', 'secret-notes/\n');
  await fx.commit('add gitignore');

  const wt = await fx.worktree('hidden');
  await fs.mkdir(path.join(wt, 'secret-notes'), { recursive: true });
  await fs.writeFile(path.join(wt, 'secret-notes/plan.js'), 'export function HIDDEN_PLAN() {}\n');

  const report = await inspect(fx.root);
  const v = verdict(report, 'hidden');

  // Honest position: git ignores it, so grove does too, and the worktree IS disposable by
  // grove's definition. This test PINS that behaviour so it is a documented limitation rather
  // than a surprise — an agent storing work in an ignored path is outside what git can protect.
  assert.equal(v.safe, true,
    'gitignored content is invisible to git and therefore to grove — pinned as a known limit');
});

test('ATTACK: a huge fan-out where the needle is a single deleted line', async (t) => {
  const fx = await newRepo('needle');
  t.after(() => fx.cleanup());

  for (let i = 0; i < 12; i++) {
    const wt = await fx.worktree(`noise-${i}`);
    await fx.write('config/registry.mjs',
      `export const REGISTRY = {\n  EXISTING_KEY: { gate: "eq1" },\n  NOISE_${i}: { gate: "eq1" },\n};\n`, wt);
    await fx.commit(`noise ${i}`, wt);
  }
  const quiet = await fx.worktree('the-quiet-one');
  await fx.write('src/base.js', 'export function baseline() { return 1; }\n// removed the broken branch\n', quiet);

  const report = await inspect(fx.root);
  mustNotBeSafe(report, 'the-quiet-one', 'a one-line change buried under 12 noisy workstreams');
});

test('ATTACK: the SAME work in TWO worktrees and nowhere else', async (t) => {
  const fx = await newRepo('twins');
  t.after(() => fx.cleanup());

  // The subtle one. `uniqueWork` counts a symbol as unique only when exactly ONE workstream has
  // it — so a symbol present in two worktrees is unique to neither. If safety rested on symbol
  // uniqueness alone, BOTH would be marked disposable, and deleting both would destroy work that
  // no amount of per-worktree reasoning would have flagged.
  const body = 'export function ONLY_IN_THE_TWINS() { return 42; }\n';

  const a = await fx.worktree('twin-uncommitted-a');
  const b = await fx.worktree('twin-uncommitted-b');
  await fx.write('src/twin.js', body, a);
  await fx.write('src/twin.js', body, b);

  const c = await fx.worktree('twin-committed-a');
  const d = await fx.worktree('twin-committed-b');
  await fx.write('src/twin2.js', body.replace('ONLY_IN_THE_TWINS', 'ONLY_IN_COMMITTED_TWINS'), c);
  await fx.commit('committed twin a', c);
  await fx.write('src/twin2.js', body.replace('ONLY_IN_THE_TWINS', 'ONLY_IN_COMMITTED_TWINS'), d);
  await fx.commit('committed twin b', d);

  const report = await inspect(fx.root);
  for (const id of ['twin-uncommitted-a', 'twin-uncommitted-b', 'twin-committed-a', 'twin-committed-b']) {
    mustNotBeSafe(report, id, 'work duplicated across exactly two worktrees, absent from base');
  }
});

/* =================================================== the gate under attack ==== */

test('ATTACK: destructive commands disguised to slip past the classifier', async (t) => {
  const fx = await newRepo('disguise');
  t.after(() => fx.cleanup());

  const wt = await fx.worktree('valuable');
  await fx.write('src/valuable.js', 'export function VALUABLE_WORK() {}\n', wt);

  // Each of these destroys the worktree. Any that the gate lets through is a hole.
  const disguises = [
    `git worktree remove ${wt}`,
    `git worktree remove --force ${wt}`,
    `git -C ${fx.root} worktree remove ${wt}`,
    `cd /tmp && git -C ${fx.root} worktree remove ${wt}`,
    `git worktree remove '${wt}'`,
    `git worktree remove "${wt}"`,
    'git worktree prune',
  ];

  const holes = [];
  for (const cmd of disguises) {
    const v = await assessCommand(cmd, fx.root);
    if (v.decision !== 'deny') holes.push(`${cmd}  ->  ${v.decision}`);
  }

  assert.deepEqual(holes, [],
    `ATTACK SUCCEEDED — these destructive commands were not blocked:\n${holes.join('\n')}`);
});

test('ATTACK: the gate must not block a command that merely MENTIONS a worktree', async (t) => {
  const fx = await newRepo('mention');
  t.after(() => fx.cleanup());
  await fx.worktree('some-wt');

  // The inverse failure: a gate so broad it blocks ordinary work gets turned off, and then
  // protects nothing. False positives are how safety tooling dies.
  const benign = [
    'git worktree list',
    'echo "see the worktree docs"',
    'cat notes-about-worktree-cleanup.md',
    'grep -r worktree src/',
    'git worktree add ../new-one feature',
  ];
  const overblocked = [];
  for (const cmd of benign) {
    const v = await assessCommand(cmd, fx.root);
    if (v.decision === 'deny') overblocked.push(`${cmd} -> ${v.reason?.slice(0, 80)}`);
  }
  assert.deepEqual(overblocked, [],
    `the gate blocked harmless commands; it will be disabled and protect nothing:\n${overblocked.join('\n')}`);
});
