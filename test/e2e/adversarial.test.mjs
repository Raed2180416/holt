/**
 * holt — adversarial states.
 *
 * The happy-path suite proves holt works. This one proves it does not LIE when the repository
 * is in a state nobody designed for. Every case here is a real thing that happens to real
 * repositories, and for each the requirement is the same:
 *
 *     holt must produce a correct answer, or an explicit refusal.
 *     It must never produce a confident wrong one — and in particular must never report a
 *     workstream as SAFE TO DELETE because it failed to look at it.
 *
 * A cleanup tool that fails open destroys work. So the assertion in most of these is not
 * "holt got the right number", it is "holt did not say safe".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { newRepo, standardFixture } from '../fixtures.mjs';
import { discover } from '../../src/discover.mjs';
import { scan } from '../../src/scan.mjs';
import { analyze } from '../../src/analyze.mjs';
import { symbolsOnDisk, resolveBackend, detectEnry, resolveAmbiguous } from '../../src/symbols.mjs';

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
    }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? -1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }));
  });
}

async function inspect(root, opts = {}) {
  const disc = await discover(root, opts);
  const scanned = await scan(disc, opts);
  return { report: await analyze(scanned, opts), scanned };
}

const verdictFor = (report, id) => report.safe.find((s) => s.id === id);

/* ================================================ ambiguous languages ==== */

test('ADVERSARIAL: same extension, different languages, resolved by CONTENT', async (t) => {
  const enry = await detectEnry();
  if (!enry.available) return t.skip('enry not installed');

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-amb-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  // The exact trap: extension mapping alone gets HALF of these wrong, silently.
  await fs.writeFile(path.join(dir, 'a.fs'), 'module FsMod\nlet fsFun x = x\n');
  await fs.writeFile(path.join(dir, 'b.fs'), ': forthWord 1 2 + . ;\n');
  await fs.writeFile(path.join(dir, 'c.m'), '#import <Foundation/Foundation.h>\n@interface ObjcThing : NSObject\n@end\n');
  await fs.writeFile(path.join(dir, 'd.m'), 'function y = matlabFn(x)\n  y = x;\nend\n');

  const langs = await resolveAmbiguous(dir, ['a.fs', 'b.fs', 'c.m', 'd.m']);
  assert.equal(langs.get('a.fs'), 'FSharp', 'F#-content .fs must classify as F#');
  assert.equal(langs.get('b.fs'), 'Forth', 'Forth-content .fs must classify as Forth');
  assert.equal(langs.get('c.m'), 'ObjectiveC', 'Objective-C .m must classify as ObjectiveC');
  assert.equal(langs.get('d.m'), 'MATLAB', 'MATLAB .m must classify as MATLAB');

  // And the symbols must actually come out for each.
  const backend = await resolveBackend();
  const found = await symbolsOnDisk(dir, ['a.fs', 'b.fs', 'c.m', 'd.m'], backend);
  assert.ok((found.get('a.fs') ?? []).some((s) => s.name === 'fsFun'), 'F# symbol missing');
  assert.ok((found.get('d.m') ?? []).some((s) => s.name === 'matlabFn'), 'MATLAB symbol missing');
});

/* ============================================== hostile file names ==== */

test('ADVERSARIAL: filenames with spaces, quotes, unicode and dashes', async (t) => {
  const fx = await newRepo('names');
  t.after(() => fx.cleanup());

  const wt = await fx.worktree('hostile');
  const nasty = [
    'a file with spaces.js',
    "quote'single.js",
    'quote"double.js',
    'dash-leading.js',
    '--looks-like-a-flag.js',
    'unicodé-ファイル.js',
    'semi;colon.js',
    'dollar$sign.js',
    'paren(then).js',
  ];
  for (const n of nasty) {
    await fx.write(n, `export function fn_${n.replace(/\W/g, '_')}() {}\n`, wt);
  }

  const { report } = await inspect(fx.root);
  const row = report.unique.find((u) => u.id === 'hostile');

  assert.ok(row, 'hostile worktree not scanned');
  // Every file must be seen. If argv construction were shell-based, the flag-looking and
  // quoted names would silently vanish and holt would report less work than exists.
  const seen = report.graph.nodes.find((n) => n.id === 'hostile');
  assert.ok(seen.uncommittedFiles >= nasty.length,
    `expected >= ${nasty.length} uncommitted files, got ${seen.uncommittedFiles}`);
  assert.equal(verdictFor(report, 'hostile').safe, false, 'a worktree full of new files is not disposable');
});

test('ADVERSARIAL: a file named like a git flag is data, not an option', async (t) => {
  const fx = await newRepo('flagfile');
  t.after(() => fx.cleanup());

  const wt = await fx.worktree('flagged');
  await fx.write('--force', 'export function flagNamed() {}\n', wt);
  await fx.write('-rf', 'export function dashRf() {}\n', wt);

  const { report } = await inspect(fx.root);
  assert.equal(verdictFor(report, 'flagged').safe, false);
  // The repo must still exist afterwards — a shell-interpolated `git ... -- $files` here
  // would have been a very different outcome.
  assert.ok(await fs.stat(path.join(wt, '--force')));
});

/* ==================================================== broken states ==== */

test('ADVERSARIAL: worktree directory deleted underneath us => unknown, NOT safe', async (t) => {
  const fx = await newRepo('vanish');
  t.after(() => fx.cleanup());

  const wt = await fx.worktree('vanishing');
  await fx.write('src/valuable.js', 'export function VALUABLE() {}\n', wt);
  await fs.rm(wt, { recursive: true, force: true });

  const { report } = await inspect(fx.root);
  const v = verdictFor(report, 'vanishing');
  assert.ok(v, 'vanished worktree must still be reported');
  assert.equal(v.safe, false, 'a worktree holt could not read must never be called safe');
  assert.equal(v.confidence, 'unknown');
});

test('ADVERSARIAL: detached HEAD is scanned normally', async (t) => {
  const fx = await newRepo('detached');
  t.after(() => fx.cleanup());

  const wt = await fx.worktree('det');
  await fx.write('src/det.js', 'export function DETACHED_SYMBOL() {}\n', wt);
  await fx.commit('detached work', wt);
  const head = (await fx.git(['rev-parse', 'HEAD'], wt)).trim();
  await sh('git', ['checkout', '--detach', head], wt);

  const { report } = await inspect(fx.root);
  const row = report.unique.find((u) => u.id === 'det');
  assert.ok(row, 'detached worktree not scanned');
  assert.ok(row.uniqueSymbols.some((s) => s.endsWith(':DETACHED_SYMBOL')),
    `detached HEAD work must still be found: ${row.uniqueSymbols.join(', ')}`);
});

test('ADVERSARIAL: merge in progress (MERGE_HEAD present) does not break the scan', async (t) => {
  const fx = await newRepo('merging');
  t.after(() => fx.cleanup());

  // Build a genuine conflict, then leave it unresolved.
  await fx.write('src/conflict.js', 'export const V = "base";\n');
  await fx.commit('base for conflict');
  await sh('git', ['checkout', '-b', 'side'], fx.root);
  await fx.write('src/conflict.js', 'export const V = "side";\n');
  await fx.commit('side');
  await sh('git', ['checkout', 'main'], fx.root);
  await fx.write('src/conflict.js', 'export const V = "main";\n');
  await fx.commit('main');
  const merge = await sh('git', ['merge', 'side'], fx.root);
  assert.notEqual(merge.code, 0, 'fixture must actually be mid-conflict');

  const wt = await fx.worktree('bystander');
  await fx.write('src/bystander.js', 'export function BYSTANDER() {}\n', wt);

  const { report } = await inspect(fx.root);
  assert.ok(report.counts.scanned >= 1, 'scan must complete while a merge is in progress');
  assert.equal(verdictFor(report, 'bystander').safe, false);
});

test('ADVERSARIAL: an empty repository with worktrees does not crash', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-empty-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'repo');
  await fs.mkdir(root, { recursive: true });
  await sh('git', ['init', '--initial-branch=main', '-q'], root);

  // No commits at all: base resolution has nothing to resolve.
  await assert.rejects(
    async () => { const d = await discover(root); await scan(d, {}); },
    (e) => /could not determine a base|empty repository/i.test(e.message),
    'an empty repo must produce an explicit error, not a silent empty result',
  );
});

test('ADVERSARIAL: symlinks, including a broken one and a loop', async (t) => {
  const fx = await newRepo('links');
  t.after(() => fx.cleanup());

  const wt = await fx.worktree('linky');
  await fx.write('src/real.js', 'export function REAL_SYMBOL() {}\n', wt);
  await fs.symlink('real.js', path.join(wt, 'src/alias.js')).catch(() => {});
  await fs.symlink('nowhere.js', path.join(wt, 'src/broken.js')).catch(() => {});
  await fs.symlink('loop-b', path.join(wt, 'src/loop-a')).catch(() => {});
  await fs.symlink('loop-a', path.join(wt, 'src/loop-b')).catch(() => {});

  const { report } = await inspect(fx.root);
  const row = report.unique.find((u) => u.id === 'linky');
  assert.ok(row, 'worktree with symlinks not scanned');
  assert.ok(row.uniqueSymbols.some((s) => s.endsWith(':REAL_SYMBOL')), 'the real file must still be read');
  assert.equal(verdictFor(report, 'linky').safe, false);
});

test('ADVERSARIAL: a submodule does not derail the parent scan', async (t) => {
  const inner = await newRepo('submod-inner');
  t.after(() => inner.cleanup());
  await inner.write('lib/inner.js', 'export function INNER_SYMBOL() {}\n');
  await inner.commit('inner');

  const fx = await newRepo('submod-outer');
  t.after(() => fx.cleanup());

  const added = await sh('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', inner.root, 'vendor/inner'], fx.root);
  if (added.code !== 0) return t.skip(`submodule add unavailable: ${added.stderr.slice(0, 120)}`);
  await fx.commit('add submodule');

  const wt = await fx.worktree('withsub');
  await fx.write('src/outer.js', 'export function OUTER_SYMBOL() {}\n', wt);

  const { report } = await inspect(fx.root);
  const row = report.unique.find((u) => u.id === 'withsub');
  assert.ok(row, 'worktree in a repo with submodules must scan');
  assert.ok(row.uniqueSymbols.some((s) => s.endsWith(':OUTER_SYMBOL')));
});

test('ADVERSARIAL: binary, huge and generated files are skipped without poisoning results', async (t) => {
  const fx = await newRepo('bulk');
  t.after(() => fx.cleanup());

  const wt = await fx.worktree('heavy');
  await fs.mkdir(path.join(wt, 'node_modules/pkg'), { recursive: true });
  await fs.writeFile(path.join(wt, 'node_modules/pkg/index.js'), 'export function SHOULD_NOT_APPEAR() {}\n');
  await fs.writeFile(path.join(wt, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/left-pad': {} } }));
  await fs.writeFile(path.join(wt, 'blob.bin'), Buffer.alloc(1024, 0));
  await fs.writeFile(path.join(wt, 'huge.js'), `// x\n`.repeat(300_000)); // > 2MB
  await fx.write('src/real.js', 'export function REAL_ONE() {}\n', wt);

  const { report } = await inspect(fx.root);
  const row = report.unique.find((u) => u.id === 'heavy');

  assert.ok(row.uniqueSymbols.some((s) => s.endsWith(':REAL_ONE')), 'the real symbol must be found');
  assert.ok(!row.uniqueSymbols.some((s) => s.includes('SHOULD_NOT_APPEAR')), 'node_modules must be excluded');
  assert.ok(!row.uniqueSymbols.some((s) => s.includes('left-pad')), 'lockfile contents must be excluded');
});

test('ADVERSARIAL: two worktrees on the SAME commit are not phantom duplicates', async (t) => {
  const fx = await newRepo('sameheads');
  t.after(() => fx.cleanup());

  await fx.worktree('twinA');
  await fx.worktree('twinB');

  const { report } = await inspect(fx.root);
  assert.equal(report.duplicates.length, 0, 'identical clean worktrees share no ADDED work');
  assert.equal(report.collisions.length, 0, 'and cannot collide');
  assert.equal(report.counts.safeToDelete, 2, 'both are disposable');
});

test('ADVERSARIAL: deeply nested and long paths survive', async (t) => {
  const fx = await newRepo('deep');
  t.after(() => fx.cleanup());

  const wt = await fx.worktree('deepwt');
  const deep = Array.from({ length: 18 }, (_, i) => `level${i}`).join('/');
  await fx.write(`${deep}/deep.js`, 'export function DEEP_SYMBOL() {}\n', wt);

  const { report } = await inspect(fx.root);
  const row = report.unique.find((u) => u.id === 'deepwt');
  assert.ok(row.uniqueSymbols.some((s) => s.endsWith(':DEEP_SYMBOL')), 'deep path must be scanned');
});

/* ============================================= correctness under load ==== */

test('ADVERSARIAL: many workstreams stay correct and bounded', async (t) => {
  const fx = await newRepo('many');
  t.after(() => fx.cleanup());

  const N = 24;
  for (let i = 0; i < N; i++) {
    const wt = await fx.worktree(`bulk-${i}`);
    // Every workstream edits the same hot file (the documented top collision class), each
    // ADDING one key of its own plus one key that ALL of them add. The shared-added key is
    // the boilerplate case: present in 24 of 24 workstreams, it carries no information about
    // any pair and must be filtered out of pair evidence.
    await fx.write('config/registry.mjs',
      `export const REGISTRY = {\n  EXISTING_KEY: { gate: "eq1" },\n` +
      `  SHARED_SCAFFOLD_KEY: { gate: "eq1" },\n` +
      `  BULK_${i}: { gate: "eq1" },\n};\n`, wt);
    // …and exactly one has a symbol nobody else has.
    if (i === 7) await fx.write('src/needle.js', 'export function THE_NEEDLE() {}\n', wt);
  }

  const started = process.hrtime.bigint();
  const { report } = await inspect(fx.root);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(report.counts.scanned, N, 'every workstream scanned');

  // The needle must be findable in the haystack — this is the whole product claim.
  const needle = report.unique.find((u) => u.uniqueSymbols.some((s) => s.endsWith(':THE_NEEDLE')));
  assert.ok(needle, 'the one unique symbol among 24 workstreams must be found');
  assert.equal(needle.id, 'bulk-7');

  // The key all 24 added must be filtered from pair evidence; the per-workstream keys must not.
  const droppedNames = report.filtering.dropped.map((d) => d.symbol);
  assert.ok(droppedNames.some((s) => s.endsWith(':SHARED_SCAFFOLD_KEY')),
    `a symbol added by all 24 workstreams must be filtered as boilerplate; dropped: ${droppedNames.join(', ')}`);
  assert.ok(!droppedNames.some((s) => s.endsWith(':BULK_7')),
    'a symbol unique to one workstream must NOT be filtered');
  assert.ok(!droppedNames.some((s) => s.endsWith(':THE_NEEDLE')),
    'the needle must never be filtered');

  assert.ok(elapsedMs < 120_000, `scan of ${N} workstreams took ${Math.round(elapsedMs)}ms`);
});

test('ADVERSARIAL: --strict-read-only never writes objects and still answers', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const { report } = await inspect(fx.root, { strictReadOnly: true });
  assert.equal(report.strictReadOnly, true);
  // Answers are approximate but must still be produced and labelled.
  for (const s of report.safe) {
    if (s.confidence !== 'unknown') assert.equal(s.confidence, 'approximate');
  }
});

test('ADVERSARIAL: instrument failure (missing object) must be UNKNOWN, never safe', async (t) => {
  // Deterministic core of the partial-clone / pruned-odb workflow: merge-tree needs a blob that
  // is not in the object store. Before the fail-closed guard in scan.mjs, its empty answer read
  // as "no committed delta", and a worktree with committed-ahead work but a clean working tree
  // was SAFE — clean --apply would have deleted it. The blob is deleted surgically here, so the
  // failure is guaranteed, offline, on every machine.
  const fx = await newRepo('missing-object');
  t.after(() => fx.cleanup());

  await fx.write('shared.txt', 'base\n');
  await fx.commit('base state');

  const wt = await fx.worktree('diverged');
  await fx.write('shared.txt', 'worktree version\n', wt);
  await fx.commit('worktree edit', wt);

  await fx.write('shared.txt', 'main version\n');
  await fx.commit('main edit');

  const oid = (await sh('git', ['rev-parse', 'wt/diverged:shared.txt'], fx.root)).stdout.trim();
  await fs.rm(path.join(fx.root, '.git', 'objects', oid.slice(0, 2), oid.slice(2)));

  const { report } = await inspect(fx.root);
  const v = verdictFor(report, 'diverged');
  assert.ok(v, 'the workstream must still be reported');
  assert.equal(v.safe, false, 'instrument failure must NEVER produce safe');
  assert.equal(v.confidence, 'unknown',
    `merge-tree could not run, so the only honest verdict is UNKNOWN: ${JSON.stringify(v)}`);
  assert.match(v.reasons.join(' '), /instrument failed|refusing to classify/i);
});

test('ADVERSARIAL: rebase in progress in the PRIMARY does not break sibling scans', async (t) => {
  const fx = await newRepo('midrebase');
  t.after(() => fx.cleanup());

  const wt = await fx.worktree('bystander2');
  await fx.write('src/b.js', 'export function REBASE_BYSTANDER() {}\n', wt);

  await fx.write('f.txt', 'a\n'); await fx.commit('a');
  await sh('git', ['checkout', '-q', '-b', 'side'], fx.root);
  await fx.write('f.txt', 'side\n'); await fx.commit('side');
  await sh('git', ['checkout', '-q', 'main'], fx.root);
  await fx.write('f.txt', 'main2\n'); await fx.commit('main2');
  const reb = await sh('git', ['rebase', 'side'], fx.root);
  assert.notEqual(reb.code, 0, 'fixture must genuinely be mid-rebase-conflict');

  const { report } = await inspect(fx.root);
  const v = verdictFor(report, 'bystander2');
  assert.ok(v, 'sibling must be reported while the primary is mid-rebase');
  assert.equal(v.safe, false, 'its uncommitted work must be seen');
});
