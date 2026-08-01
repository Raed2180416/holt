/**
 * holt — BREAK IT.
 *
 * The other suites ask "does holt find what we planted?". This one asks the opposite and much
 * more important question: **can holt be made to give a DANGEROUS wrong answer?**
 *
 * There is exactly one catastrophic failure mode for this tool. Not a missed duplicate, not a
 * noisy collision — those cost attention. The catastrophic one is:
 *
 *      holt says SAFE TO DELETE, and it is not.
 *
 * Every scenario below is built to force that outcome, from a real thing agents do. A scenario
 * that holt handles correctly is not a passing test — it is a failed attack, and it is recorded
 * as such so nobody mistakes this file for a victory lap.
 *
 * Written adversarially on purpose: these are not "does the feature work" tests, they are
 * attempts to construct the wrong answer.
 */

import os from 'node:os';
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
        GIT_AUTHOR_NAME: 'holt test', GIT_AUTHOR_EMAIL: 't@holt.invalid',
        GIT_COMMITTER_NAME: 'holt test', GIT_COMMITTER_EMAIL: 't@holt.invalid',
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
    `ATTACK SUCCEEDED — "${attack}": holt called '${id}' disposable. Reasons given: ${v.reasons.join('; ')}`);
}

/* =========================================================== deletions ==== */

test('ATTACK: a workstream that only DELETES code (holt tracks ADDED symbols)', async (t) => {
  const fx = await newRepo('del');
  t.after(() => fx.cleanup());

  // holt's symbol layer computes head-minus-base — deletions produce NO added symbols at all.
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

  // Start a scan and mutate the worktree while it runs. holt must not crash, and must not
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
  // The attack is the inverse: holt must not invent work here.
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

  // THIS TEST USED TO ASSERT `safe === true`, AND THAT ASSERTION DESTROYED REAL DATA.
  //
  // It pinned "gitignored content is invisible to holt" as an accepted limit, while
  // detection.test.mjs asserted the OPPOSITE for a gitignored FILE — semantically the same
  // situation, opposite assertions, both green. The gap between them is where the defect lived:
  // when .gitignore names a DIRECTORY, git's --ignored=matching collapses the subtree to one
  // entry `secret-notes/`, holt skipped anything ending in `/`, and the worktree came back
  // "holds nothing base lacks". `clean --apply` then deleted the only copy. Reproduced 40/40 on
  // a 2,440-worktree corpus, with live credentials as the payload.
  //
  // The corrected position, and the one the product already takes for ignored files: holt cannot
  // VERIFY ignored content, so it must refuse to call the worktree disposable. Refusing costs a
  // user one manual deletion; the old behaviour cost them the file.
  assert.equal(v.safe, false,
    'a worktree whose only unique content is gitignored must NOT be called disposable — ' +
    'holt cannot verify that content exists anywhere else, and unverifiable is not safe');
  assert.match(JSON.stringify(v), /ignored|unverifiable|cannot verify/i,
    'and the refusal must say WHY, so the user can act on it');
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

test('ATTACK: a gitignored DIRECTORY hides the only copy of a credentials file', async (t) => {
  // THE EXACT SHAPE THAT DESTROYED DATA, kept as its own test because the directory case and the
  // file case took different code paths and only the file case was covered.
  //
  // `git status --ignored=matching` collapses an ignored subtree to a single entry with a trailing
  // slash — `secrets/`, never `secrets/prod.env`. holt skipped anything ending in `/`, so the
  // subtree vanished from the verdict, the worktree was reported as holding nothing base lacks,
  // and `clean --apply` removed it along with the only copy of the file inside.
  const fx = await newRepo('ignored-dir');
  t.after(() => fx.cleanup());
  await fx.write('.gitignore', 'secrets/\n');
  await fx.commit('add gitignore');

  const wt = await fx.worktree('creds');
  await fs.mkdir(path.join(wt, 'secrets'), { recursive: true });
  await fs.writeFile(path.join(wt, 'secrets/prod.env'), 'PROD_DB_PASSWORD=hunter2\n');

  const report = await inspect(fx.root);
  assert.equal(verdict(report, 'creds').safe, false,
    'a worktree whose only unique content sits under a gitignored DIRECTORY must not be disposable');
});

test('NEVER-WORSE: ordinary build output under a gitignored directory stays disposable', async (t) => {
  // The other half, and the one that keeps the fix usable. If every ignored directory blocked
  // deletion, `clean` would refuse on every repository that has ever run `npm install` — a tool
  // that never cleans anything is not safer, it is uninstalled.
  const fx = await newRepo('ignored-generated');
  t.after(() => fx.cleanup());
  await fx.write('.gitignore', 'node_modules/\ndist/\n');
  await fx.commit('add gitignore');

  const wt = await fx.worktree('build');
  await fs.mkdir(path.join(wt, 'node_modules/pkg'), { recursive: true });
  await fs.writeFile(path.join(wt, 'node_modules/pkg/index.js'), 'module.exports = 1;\n');
  await fs.mkdir(path.join(wt, 'dist'), { recursive: true });
  await fs.writeFile(path.join(wt, 'dist/bundle.js'), 'console.log(1);\n');

  const report = await inspect(fx.root);
  assert.equal(verdict(report, 'build').safe, true,
    'node_modules/ and dist/ are recognised as generated and must not block cleanup');
});

test('ATTACK: a symbol extraction that FAILED must not read as "no symbols"', async (t) => {
  // MEASURED, and the mechanism was confirmed before it was fixed: `ctagsBatch` resolved a
  // timed-out extraction to an empty string, so a file containing a real symbol came back with
  // ZERO — byte-identical to a file that genuinely has none. Nothing downstream could tell the
  // difference.
  //
  // The consequence was not cosmetic. Under load (the full suite running many files in parallel)
  // extraction intermittently timed out, "could not look" became "shares nothing with anyone",
  // and a worktree holding work found nowhere else was reported provably disposable. It surfaced
  // as a flaky test — `duplicate pair alpha-1/beta-1 not found`, 2042ms on the failing run versus
  // ~700ms passing — which is exactly how a silent wrong answer disguises itself as a bad test.
  //
  // This asserts the DISTINCTION at the extraction layer, where it is deterministic. The
  // downstream refusal is asserted by the verdict test below.
  const { ctagsBatch, resolveBackend } = await import('../../src/symbols.mjs');
  if ((await resolveBackend()).kind !== 'ctags') return;

  const dir = await fs.mkdtemp(path.join(process.env.HOLT_TMPDIR || os.tmpdir(), 'holt-unmeasured-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'real.js'), 'export function REAL_SYMBOL_HERE() {}\n');

  // Premise: with a normal timeout the symbol IS found. Without this the test could pass because
  // extraction never worked at all.
  const ok = await ctagsBatch(dir, ['real.js'], { timeout: 60_000 });
  assert.equal((ok.get('real.js') ?? []).length, 1, 'PRECONDITION: the symbol must be findable');
  assert.deepEqual(ok.failed, [], 'a successful extraction reports no failures');

  // A timeout must be REPORTED, not silently returned as an empty answer.
  const timedOut = await ctagsBatch(dir, ['real.js'], { timeout: 1 });
  assert.deepEqual(timedOut.failed, ['real.js'],
    'a failed extraction must name the files it could not read — returning [] makes it ' +
    'indistinguishable from a file that genuinely has no symbols');
});

test('ATTACK: a workstream whose symbols could not be read is NOT called disposable', async (t) => {
  // The downstream half. An unreadable workstream is the same class as a gitignored one: holt did
  // not have the evidence, so it must refuse the verdict rather than issue a confident one.
  const fx = await newRepo('unmeasured-verdict');
  t.after(() => fx.cleanup());
  await fx.write('base.txt', 'base\n');
  await fx.commit('base');
  const wt = await fx.worktree('unreadable');
  await fx.write('work.js', 'export function ONLY_COPY() {}\n', wt);

  const report = await inspect(fx.root);
  const v = verdict(report, 'unreadable');
  // Simulate what a timed-out extraction leaves behind, then re-derive the verdict.
  const { analyze } = await import('../../src/analyze.mjs');
  const { scan } = await import('../../src/scan.mjs');
  const { discover } = await import('../../src/discover.mjs');
  const scanned = await scan(await discover(fx.root, {}), {});
  for (const w of scanned.workstreams) {
    if (w.id.endsWith('unreadable')) { w.symbolsUnmeasured = ['work.js']; w.added = []; w.addedKeys = []; }
  }
  const degraded = await analyze(scanned, {});
  const dv = degraded.safe.find((s) => s.id.endsWith('unreadable'));
  assert.equal(dv.safe, false,
    `a workstream holt could not read symbols from must not be called disposable: ${JSON.stringify(dv)}`);
  assert.match(JSON.stringify(dv), /could not read symbols/,
    'and the refusal must say WHY, so the user knows it is a measurement gap, not a finding');
  assert.ok(v, 'sanity: the fixture produced a verdict at all');
});
