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
import { analyze, discriminativeSymbols } from '../../src/analyze.mjs';
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

/**
 * The single assertion that matters: this worktree must not be authorised for deletion.
 *
 * "Not authorised" is the property, and it has two shapes. Usually holt says `safe:false`. For a
 * worktree whose content a LIVING SIBLING also holds, it says `safe:true` plus `redundantWith` —
 * because that worktree genuinely is individually disposable, and pretending otherwise cost 60% of
 * this question's recall when it was measured against an independent oracle.
 *
 * What must never happen either way is a delete going through unchecked, so the guarantee is
 * asserted where it is actually enforced: `gate`, the machine contract a script chains on, exits
 * NON-ZERO for both shapes, because the `rm -rf` after `gate && …` does not look again. The
 * commands that DO re-verify before each removal (`clean --apply`) are free to use the extra
 * recall, and a separate test proves a redundant set drains to exactly one survivor, never zero.
 */
function mustNotBeSafe(report, id, attack) {
  const v = verdict(report, id);
  assert.ok(v, `ATTACK "${attack}": workstream '${id}' vanished from the report entirely`);
  const authorised = v.safe && !(v.redundantWith?.length);
  assert.equal(authorised, false,
    `ATTACK SUCCEEDED — "${attack}": holt authorised deleting '${id}'. Reasons given: ${v.reasons.join('; ')}`);
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

test('ATTACK: high-fanout symbols are actually removed from pair evidence', () => {
  const live = Array.from({ length: 8 }, (_, i) => ({ id: `wt-${i}`, addedKeys: ['value:boilerplate', `value:unique-${i}`] }));
  const filtered = discriminativeSymbols(live);
  assert.ok(filtered.dropped.some((item) => item.symbol === 'value:boilerplate'));
  assert.ok(!filtered.keep.has('value:boilerplate'));
  assert.ok(filtered.keep.has('value:unique-0'));
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

  // A name match is not content evidence: `handler` here is one coincidence, not one piece of
  // shared work, and the two declarations do different things. Symbol-identity now confirms
  // the declared BODIES actually agree before counting a name as shared, so this must not be
  // reported as duplicate work at all — not even hedged behind a low similarity score. A tool
  // that reports the coincidence "weakly" instead of not at all is still telling the user two
  // workstreams built the same thing when they did not; hedging the wrong answer is not the
  // same as fixing it.
  assert.equal(dup, undefined,
    `ATTACK SUCCEEDED: unrelated work reported as duplicate: ${JSON.stringify(dup)}`);

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
  //
  // `git worktree prune` USED TO BE ON THIS LIST AND DOES NOT BELONG ON IT while the worktree is
  // on disk: prune removes administrative records for directories that are ALREADY GONE, so with
  // `valuable` present it cannot touch it — git-worktree(1), and measured below rather than
  // asserted. Listing it here made the suite demand a refusal for a command that does nothing,
  // which is how the over-refusal survived: a green test was ratifying it. Its real behaviour is
  // pinned in the two assertions after this list, both halves.
  const disguises = [
    `git worktree remove ${wt}`,
    `git worktree remove --force ${wt}`,
    `git -C ${fx.root} worktree remove ${wt}`,
    `cd /tmp && git -C ${fx.root} worktree remove ${wt}`,
    `git worktree remove '${wt}'`,
    `git worktree remove "${wt}"`,
  ];

  const holes = [];
  for (const cmd of disguises) {
    const v = await assessCommand(cmd, fx.root);
    if (v.decision !== 'deny') holes.push(`${cmd}  ->  ${v.decision}`);
  }

  assert.deepEqual(holes, [],
    `ATTACK SUCCEEDED — these destructive commands were not blocked:\n${holes.join('\n')}`);

  // PREMISE, from real git: with the worktree present, prune reaches nothing.
  const listed = await fx.git(['worktree', 'list', '--porcelain']);
  assert.equal(/^prunable/m.test(listed), false, 'PREMISE FAILED: something is already prunable');
  await fx.git(['worktree', 'prune', '-v']);
  assert.ok(await fs.stat(path.join(wt, 'src', 'valuable.js')).then(() => true, () => false),
    'PREMISE FAILED: `git worktree prune` removed a worktree that was on disk');
  assert.equal((await assessCommand('git worktree prune', fx.root)).decision, 'allow',
    'refusing a command that provably reaches nothing is the over-refusal this suite must not re-learn');

  // …and once the directory IS gone, the record becomes prunable and the refusal comes back.
  await fs.rm(wt, { recursive: true, force: true });
  const after = await fx.git(['worktree', 'list', '--porcelain']);
  assert.ok(/^prunable/m.test(after), 'PREMISE FAILED: the record did not become prunable');
  assert.equal((await assessCommand('git worktree prune', fx.root)).decision, 'deny',
    'a prunable record holds an index and a reflog holt cannot prove are safe');
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
  // The manifest IS the evidence: generated-named dirs earn disposal from the command that
  // recreates them (GENERATOR_MANIFESTS). A JS repo without package.json is not a JS repo.
  await fx.write('package.json', '{\"name\":\"fixture\",\"private\":true}\n');
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
  if ((await resolveBackend()).kind !== 'ctags') return t.skip('ctags unavailable — ctagsBatch timeout-failure reporting is a ctags-specific mechanism');

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

test('ATTACK: a file too large to tag reads as "no symbols" instead of "not measured"', async (t) => {
  // SAME CLASS AS THE TIMEOUT ABOVE, different trigger. `tagWorthy()` (symbols.mjs) refuses to
  // hand a file over MAX_TAG_FILE_BYTES (2 MiB) to ctags — a deliberate policy skip, not a
  // demonstrated absence of symbols (see the doc comment on MAX_TAG_FILE_BYTES: "beyond this the
  // tags cost more than they inform"). MEASURED: before this was named, such a file came back
  // from ctagsBatch as `[]` with an EMPTY `.failed` — byte-identical to a file that genuinely has
  // no symbols, and to a file that failed for any other reason. A real, unique, committed symbol
  // sitting in a merely-large file (a big generated-but-hand-edited SQL file, a vendored bundle
  // someone patched, a large data module) would vanish from every downstream count silently.
  const { ctagsBatch, resolveBackend } = await import('../../src/symbols.mjs');
  if ((await resolveBackend()).kind !== 'ctags') return t.skip('ctags unavailable — the oversized-file size-cap policy is a ctags-specific mechanism');

  const dir = await fs.mkdtemp(path.join(process.env.HOLT_TMPDIR || os.tmpdir(), 'holt-oversized-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const TWO_MIB = 2 * 1024 * 1024;
  const padding = `// ${'x'.repeat(TWO_MIB)}\n`; // pure comment padding, well past the cap
  await fs.writeFile(path.join(dir, 'big.js'), `${padding}export function REAL_SYMBOL_HERE() {}\n`);

  const found = await ctagsBatch(dir, ['big.js'], { timeout: 60_000 });
  assert.deepEqual(found.get('big.js'), [],
    'PRECONDITION: the file must actually exceed the size cap and be skipped, not parsed');
  assert.deepEqual(found.failed, ['big.js'],
    'a file skipped for being too large to tag must be named in .failed — returning [] with an ' +
    'empty .failed makes it indistinguishable from a file that genuinely has no symbols');
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

test('ATTACK: `holt risk`\'s uniqueSymbolCount must not claim to be a measurement when it isn\'t one', async (t) => {
  // safeToDelete() already refuses to call an unreadable workstream disposable (test above) — but
  // `uniqueWork()` is a SEPARATE function feeding a SEPARATE report (`holt risk`, and the `--json`
  // `unique` array any script can key on), and until this was wired it had no idea `symbolsUnmeasured`
  // existed. A workstream whose only committed file tripped the ctags backend (NUL byte, oversized
  // file, timeout — see the ctagsBatch tests above) would show `uniqueSymbolCount: 0` there with
  // NOTHING distinguishing "measured, holds nothing" from "could not look" — the exact silent-zero
  // shape this file exists to catch, one function over from where it was already fixed.
  const fx = await newRepo('unmeasured-report');
  t.after(() => fx.cleanup());
  await fx.write('base.txt', 'base\n');
  await fx.commit('base');
  const wt = await fx.worktree('reportgap');
  await fx.write('work.js', 'export function ONLY_COPY_HERE() {}\n', wt);
  await fx.commit('add work.js', wt);

  const { analyze } = await import('../../src/analyze.mjs');
  const { scan } = await import('../../src/scan.mjs');
  const { discover } = await import('../../src/discover.mjs');
  const scanned = await scan(await discover(fx.root, {}), {});
  for (const w of scanned.workstreams) {
    if (w.id.endsWith('reportgap')) { w.symbolsUnmeasured = ['work.js']; w.added = []; w.addedKeys = []; }
  }
  const degraded = await analyze(scanned, {});
  const u = degraded.unique.find((x) => x.id.endsWith('reportgap'));
  assert.ok(u, 'sanity: the fixture produced a unique-work row at all');
  assert.equal(u.symbolsUnmeasuredCount, 1,
    `uniqueWork() must surface the unmeasured count, not just safeToDelete(): ${JSON.stringify(u)}`);
  assert.deepEqual(u.symbolsUnmeasuredFiles, ['work.js'],
    'and it must name the file, the same way safeToDelete already does');
});

test('ATTACK: an oversized file with a PROVEN byte twin must not veto redundancy', async (t) => {
  // THE COLLISION OF TWO CORRECT FIXES. Marking oversized files as unmeasured (the test above) is
  // right: a policy skip must never read as "no symbols". Refusing disposal on unmeasured files
  // (two tests above) is also right: holt could not look. But compose them over a file whose
  // exact bytes PROVABLY live in another worktree — content identity already answered the
  // question symbols were going to ask, with a strictly stronger instrument — and the two
  // correct refusals stack into one wrong one: `gate` printing "HOLDS UNIQUE WORK" about a
  // worktree whose own report simultaneously says redundantWith:[sibling]. A tool contradicting
  // itself in public, in the over-refusing direction.
  //
  // The rule this pins: a symbol-measurement failure only blocks the verdict for files content
  // identity has NOT already covered. Byte identity subsumes anything symbols could establish.
  const fx = await newRepo('oversized-twin');
  t.after(() => fx.cleanup());
  await fx.write('base.txt', 'base\n');
  await fx.commit('base');

  // Well past MAX_TAG_FILE_BYTES (2 MiB), with a real symbol so the skip is not vacuous, and
  // committed at DIFFERENT paths so whole-tree identity cannot be what passes this test.
  const TWO_MIB = 2 * 1024 * 1024;
  const bigBody = `// ${'x'.repeat(TWO_MIB)}\nexport function BURIED_IN_LARGE_FILE() {}\n`;

  const a = await fx.worktree('big-a');
  await fx.write('feat/alpha/huge.js', bigBody, a);
  await fx.commit('huge at alpha path', a);

  const b = await fx.worktree('big-b');
  await fx.write('feat/beta/huge.js', bigBody, b);
  await fx.commit('huge at beta path', b);

  const report = await inspect(fx.root);
  const va = verdict(report, 'big-a');
  const vb = verdict(report, 'big-b');
  assert.ok(va && vb, 'sanity: both worktrees produced verdicts');

  for (const [v, sibling] of [[va, 'big-b'], [vb, 'big-a']]) {
    assert.equal(v.safe, true,
      `byte-identical content in a living sibling must make this disposable, got: ${JSON.stringify(v)}`);
    assert.ok((v.redundantWith ?? []).some((id) => id.endsWith(sibling)),
      `the verdict must NAME the sibling holding the twin: ${JSON.stringify(v.redundantWith)}`);
    assert.equal(v.confidence, 'measured',
      `content identity IS a measurement — 'unverifiable' here is the over-refusal this test exists to catch: ${JSON.stringify(v)}`);
    assert.doesNotMatch(JSON.stringify(v.reasons), /could not read symbols/,
      'a proven byte twin must not be reported as a symbol-measurement gap');
  }

  // AND THE REFUSAL MUST SURVIVE where content identity does NOT cover the file: the same
  // oversized file alone in one worktree, twin nowhere, must still refuse — otherwise this fix
  // just deleted the protection instead of scoping it.
  const lone = await fx.worktree('big-lone');
  await fx.write('feat/gamma/huge.js', `// ${'y'.repeat(TWO_MIB)}\nexport function DIFFERENT_LARGE() {}\n`, lone);
  await fx.commit('unique huge file', lone);
  const report2 = await inspect(fx.root);
  const vl = verdict(report2, 'big-lone');
  assert.equal(vl.safe, false,
    `an oversized file with NO twin must still refuse disposal: ${JSON.stringify(vl)}`);
});

/* ------------------------------------------------------------------------------------------
 * ONE INSTRUMENT'S BLIND SPOT MUST NOT VETO ANOTHER INSTRUMENT'S PROOF.
 *
 * Two instruments answer "does a living sibling already hold this committed work?":
 *
 *   per-file content identity  — path-blind, reindent-blind, but it needs to READ each file's
 *                                bytes, and it declines files over a 16 MiB cap, files that are
 *                                not on disk at all (a committed DELETE, a rename's source path)
 *                                and files whose read fails for any reason.
 *   whole merged-tree identity — git's own oid. Narrower question (identical tree, same paths),
 *                                answered with total reliability: no cap, no reads, no failure
 *                                modes, and the tree it compares is a COMMITTED one by
 *                                construction, so a match is durable by definition.
 *
 * They compose — EITHER one proves redundancy. The two tests below are the two shapes where the
 * first instrument cannot answer while the second answers perfectly, and the controls beside
 * them are the shapes where NEITHER may answer.
 * --------------------------------------------------------------------------------------- */

test('ATTACK: a file over the fingerprint cap must not veto git\'s own proof of redundancy', async (t) => {
  // THE REFUTER'S FIXTURE. Two worktrees committing a byte-identical file past content-identity's
  // 16 MiB cap, at the SAME path — so `merge-tree` hands back ONE tree oid for both, which is git
  // proving they are the same work with no heuristic involved. Per-file identity declines to
  // fingerprint the file at all (`contentKeys['feat/huge.js'] === null`), so coverage can never
  // reach `allMatched`, and a single such file silently poisons the redundancy verdict for the
  // WHOLE workstream.
  const fx = await newRepo('oversized-tree-twin');
  t.after(() => fx.cleanup());

  // Past MAX_FINGERPRINT_BYTES (16 MiB), so contentFingerprint() returns null by policy.
  const SEVENTEEN_MIB = 17 * 1024 * 1024;
  const huge = `// ${'x'.repeat(SEVENTEEN_MIB)}\nexport function BURIED_HUGE() {}\n`;

  const a = await fx.worktree('huge-a');
  await fx.write('feat/huge.js', huge, a);
  await fx.commit('the huge file', a);

  const b = await fx.worktree('huge-b');
  await fx.write('feat/huge.js', huge, b);
  await fx.commit('the identical huge file', b);

  // CONTROL, in the same repository: a genuinely DIFFERENT oversized file at the same path.
  // Its bytes are equally unfingerprintable, so nothing about the size cap may rescue it — only
  // the tree oid, which differs. If this one ever turns disposable the fix is a hole.
  const c = await fx.worktree('huge-c');
  await fx.write('feat/huge.js', `// ${'y'.repeat(SEVENTEEN_MIB)}\nexport function OTHER_HUGE() {}\n`, c);
  await fx.commit('a different huge file', c);

  const report = await inspect(fx.root);
  const [va, vb, vc] = ['huge-a', 'huge-b', 'huge-c'].map((id) => verdict(report, id));
  assert.ok(va && vb && vc, 'sanity: all three worktrees produced verdicts');

  for (const [v, sibling] of [[va, 'huge-b'], [vb, 'huge-a']]) {
    assert.equal(v.safe, true,
      `git's own merged-tree oid proves a living sibling holds this exact committed work — a `
      + `fingerprint the size cap declined to compute is not evidence against it: ${JSON.stringify(v)}`);
    assert.ok((v.redundantWith ?? []).some((id) => id.endsWith(sibling)),
      `the verdict must NAME the sibling holding the twin: ${JSON.stringify(v.redundantWith)}`);
    assert.equal(v.confidence, 'measured',
      `a git tree oid IS a measurement: ${JSON.stringify(v)}`);
    assert.doesNotMatch(JSON.stringify(v.reasons), /base lacks/,
      `"base lacks this" is true and irrelevant once a living sibling is proven to hold it: ${JSON.stringify(v.reasons)}`);
    assert.doesNotMatch(JSON.stringify(v.reasons), /could not read symbols/,
      'whole-tree identity subsumes anything symbols could have established about these paths');
  }

  assert.equal(vc.safe, false,
    `a DIFFERENT oversized file, equally unfingerprintable, must stay refused: ${JSON.stringify(vc)}`);
  assert.equal(vc.redundantWith, undefined,
    `and must name no holder at all: ${JSON.stringify(vc.redundantWith)}`);
});

test('ATTACK: a committed DELETION has no bytes to fingerprint and must not veto redundancy', async (t) => {
  // THE SAME CLASS AT ZERO COST, and far more common than a 16 MiB file: a path that a worktree
  // committed a DELETE for is not on disk, so `fs.readFile` fails and `contentKeys[path]` is null
  // exactly as it is for an oversized file. Two agents told to remove the same dead module produce
  // ONE merged tree oid between them — git proving the work is identical — while per-file coverage
  // has nothing to read and abstains forever. Same instrument gap, same wrong verdict.
  //
  // A rename's SOURCE path (recorded by `--name-status -M`) is the third member of this family.
  const fx = await newRepo('deletion-tree-twin');
  t.after(() => fx.cleanup());

  const a = await fx.worktree('del-a');
  await fx.git(['rm', '-q', 'src/base.js'], a);
  await fx.commit('remove the dead module', a);

  const b = await fx.worktree('del-b');
  await fx.git(['rm', '-q', 'src/base.js'], b);
  await fx.commit('remove the same dead module', b);

  // CONTROL: deletes a DIFFERENT file. Equally unfingerprintable, genuinely different work.
  const c = await fx.worktree('del-c');
  await fx.git(['rm', '-q', 'config/registry.mjs'], c);
  await fx.commit('remove a different file', c);

  const report = await inspect(fx.root);
  const [va, vb, vc] = ['del-a', 'del-b', 'del-c'].map((id) => verdict(report, id));
  assert.ok(va && vb && vc, 'sanity: all three worktrees produced verdicts');

  for (const [v, sibling] of [[va, 'del-b'], [vb, 'del-a']]) {
    assert.equal(v.safe, true,
      `two worktrees deleting the same file share one merged tree oid — that is proof, not a `
      + `heuristic, and an absent file's absent fingerprint cannot outrank it: ${JSON.stringify(v)}`);
    assert.ok((v.redundantWith ?? []).some((id) => id.endsWith(sibling)),
      `the verdict must NAME the sibling: ${JSON.stringify(v.redundantWith)}`);
  }
  assert.equal(vc.safe, false,
    `deleting a DIFFERENT file is different work and must stay refused: ${JSON.stringify(vc)}`);

  // PRECISION, through the destructive command itself: the true pair drains to exactly one
  // survivor and the genuinely different worktree is untouched.
  const { clean } = await import('../../src/actions.mjs');
  const cleaned = await clean(fx.root, { apply: true });
  const left = [];
  for (const id of ['del-a', 'del-b', 'del-c']) {
    try { await fs.stat(fx.wt(id)); left.push(id); } catch { /* removed */ }
  }
  assert.ok(left.includes('del-c'), `the differently-scoped worktree must survive: removed=${cleaned.removed}`);
  assert.equal(left.filter((id) => id !== 'del-c').length, 1,
    `the identical pair must drain to exactly one survivor, never zero: left=${JSON.stringify(left)}`);
});

test('ATTACK: an unreadable fingerprint must not be counted as evidence the work is held elsewhere',
  async () => {
    // THE SAME NULL, THE OPPOSITE POLARITY — and this is the dangerous one.
    //
    // In safeToDelete a missing fingerprint made holt REFUSE (annoying). In uniqueWork it did the
    // reverse: `fileIsContentUnique` returned false for a file it could not read, which reads as
    // "some sibling holds this content", which DELETES the symbol from uniqueSymbols, which
    // removes the `symbol(s) found nowhere else` reason from the deletion gate. A failed read
    // making holt more willing to delete is the catastrophic direction, and it fires on nothing
    // more exotic than two agents independently naming a function `Handler`.
    //
    // Driven through the exported analyzer rather than a repository, because the reachable
    // real-world nulls (oversized, deleted, rename source) are all files ctags never tags, so a
    // fixture cannot put a SYMBOL behind an unreadable fingerprint — only a read race can, and a
    // race is not a test. The scan shape below is exactly what scanFiles() emits.
    const { uniqueWork } = await import('../../src/analyze.mjs');
    const { symbolKey } = await import('../../src/symbols.mjs');
    const ws = (id, file, key, tree, sym) => {
      // Derived through symbolKey exactly as scan.mjs does, so the fixture cannot drift from the
      // real key space (a hand-written `function:Handler` never matches — kinds are bucketed).
      const added = [{ file, kind: 'function', name: sym }];
      return {
        id, path: `/tmp/${id}`, ok: true, family: id,
        committed: { files: [file], count: 1, how: 'merge-tree', mergedTree: tree, lineEndingOnlyVsBase: false },
        uncommitted: { files: [], untracked: [], count: 0, how: 'status' },
        ignored: { files: [], count: 0, how: 'ignored' },
        touched: [file],
        contentKeys: { [file]: key },
        added,
        addedKeys: [...new Set(added.map(symbolKey))],
        symbolsUnmeasured: [],
      };
    };

    // w1's file could not be fingerprinted (null). w2 declares a same-NAMED symbol in a totally
    // different file, whose content is readable and shares nothing. Different merged trees, so
    // no instrument anywhere proves w1's work exists elsewhere.
    const nameCollision = {
      workstreams: [
        ws('w1', 'a/thing.js', null, 'tree-one', 'Handler'),
        ws('w2', 'b/other.js', 'n:beef', 'tree-two', 'Handler'),
      ],
    };
    const u1 = uniqueWork(nameCollision).find((u) => u.id === 'w1');
    assert.equal(u1.uniqueSymbolCount, 1,
      `a name collision is not a content match, and an unreadable file is not a proof of one — `
      + `w1's Handler exists nowhere else: ${JSON.stringify(u1)}`);
    assert.equal(u1.verdict, 'unique-work-committed', JSON.stringify(u1));

    // CONTROL, and it is the whole reason this cannot just answer "unique" whenever the read
    // fails: when the sibling's MERGED TREE is identical, git has already proven it holds this
    // exact committed path. The symbol is then genuinely shared and must not be counted.
    const treeTwins = {
      workstreams: [
        ws('t1', 'a/thing.js', null, 'same-tree', 'Handler'),
        ws('t2', 'a/thing.js', null, 'same-tree', 'Handler'),
      ],
    };
    const t1 = uniqueWork(treeTwins).find((u) => u.id === 't1');
    assert.equal(t1.uniqueSymbolCount, 0,
      `an identical merged tree proves the sibling holds this path — claiming unique work here `
      + `would re-break the redundancy verdict: ${JSON.stringify(t1)}`);

    // CONTROL: a READABLE fingerprint with a durable twin still means "held elsewhere". The fix
    // must not have turned content identity off.
    const realDuplicate = {
      workstreams: [
        ws('d1', 'a/thing.js', 'n:same', 'tree-one', 'Handler'),
        ws('d2', 'b/thing.js', 'n:same', 'tree-two', 'Handler'),
      ],
    };
    const d1 = uniqueWork(realDuplicate).find((u) => u.id === 'd1');
    assert.equal(d1.uniqueSymbolCount, 0,
      `a proven content twin still makes the symbol shared: ${JSON.stringify(d1)}`);
  });

test('ATTACK: a generated-NAMED dir is only disposable when the repo carries the command that recreates it', async (t) => {
  // REPRODUCED DATA LOSS, pre-existing at every commit tonight: gate said "✓ disposable", clean
  // --apply removed the worktree, `git fsck` found nothing, and the content had never been a git
  // object — unrecoverable. The whole verdict rested on the directory being NAMED `build/`.
  //
  // GENERATED_DIRS' own comment block states the rule this file had already learned twice, for
  // `vendor/` and for `logs/`: "The rule is not 'does this look like noise', it is 'can a command
  // in this repository recreate it'" — and then nothing ever checked for the command. A repo with
  // no package.json, no Makefile, no build system of any kind cannot recreate build/only.js; its
  // name is the only evidence, and names are exactly what this product exists to distrust.
  //
  // The fix: a generated-named dir earns disposal from the MANIFEST that recreates it, per
  // worktree — node_modules from package.json, target from Cargo.toml, build from any build
  // manifest. No manifest, no disposal: the content downgrades to "cannot verify", the same
  // verdict a `secrets/` dir already gets. WITH the manifest, everything stays reclaimable —
  // the monster fixture pins that a worktree full of real build junk still cleans.
  const fx = await newRepo('generated-needs-evidence');
  t.after(() => fx.cleanup());
  await fx.write('.gitignore', 'build/\n');
  await fx.commit('base with build/ ignored');

  // Layer 1: GITIGNORED. No build system anywhere; hand-placed content under build/.
  const wt = await fx.worktree('wt-bi');
  await fx.write('build/only.js', 'export function BuildDirOnlyWork(n){return n*5;}\n', wt);
  let report = await inspect(fx.root);
  let v = verdict(report, 'wt-bi');
  assert.equal(v.safe, false,
    `no manifest can recreate build/ here — its name is not evidence: ${JSON.stringify(v)}`);
  assert.match(JSON.stringify(v.reasons), /cannot verify|gitignored/i,
    `the refusal must say holt cannot verify the ignored content: ${JSON.stringify(v)}`);

  // Layer 2: UNTRACKED, no gitignore at all — the same hole with less ceremony.
  const wt2 = await fx.worktree('wt-untracked');
  await fx.write('dist/handmade.js', 'export function HandTweakedOutput(){return 7;}\n', wt2);
  report = await inspect(fx.root);
  v = verdict(report, 'wt-untracked');
  assert.equal(v.safe, false,
    `untracked dist/ content with no build system is at-risk work, not noise: ${JSON.stringify(v)}`);

  // CONTROL — the never-worse half: the SAME content with the manifest present stays disposable,
  // because `npm run build`/`npm ci` genuinely recreates it. Refusing here would freeze the tool.
  const fx2 = await newRepo('generated-with-evidence');
  t.after(() => fx2.cleanup());
  await fx2.write('.gitignore', 'build/\nnode_modules/\n');
  await fx2.write('package.json', JSON.stringify({ name: 'x', scripts: { build: 'node make.js' } }));
  await fx2.commit('base with a real build system');
  const wt3 = await fx2.worktree('wt-build-ok');
  await fx2.write('build/bundle.js', 'var generated=1;\n', wt3);
  await fx2.write('node_modules/dep/index.js', 'module.exports=1;\n', wt3);
  const report2 = await inspect(fx2.root);
  const v3 = verdict(report2, 'wt-build-ok');
  assert.equal(v3.safe, true,
    `build output WITH its manifest is reproducible and must stay reclaimable: ${JSON.stringify(v3)}`);
});
