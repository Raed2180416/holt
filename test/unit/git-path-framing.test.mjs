/**
 * holt — THE CLASS: user-controlled paths carried on LINE-FRAMED git protocols.
 *
 * A git path may hold any byte except `/` and NUL. Every git plumbing command that emits paths
 * has two modes, and the difference is not cosmetic:
 *
 *   WITHOUT `-z`  git protects the line framing by C-QUOTING the whole path — `"src/caf\303\251.js"` —
 *                 whenever it holds a non-ASCII byte or a control character. Split on `\n`, the
 *                 caller receives a string that is NOT the path: quotes included, bytes escaped.
 *                 Some commands (`worktree list --porcelain`) do not quote paths at all, and the
 *                 raw newline splits ONE record into two lines instead.
 *   WITH `-z`     records are NUL-terminated, paths are emitted verbatim, and neither failure exists.
 *
 * REPRODUCED, both halves, against production before this file existed:
 *
 *   1. `git ls-files` (no `-z`) at bin/holt.mjs and src/mcp/server.mjs fed `partitionPlan()`.
 *      `dirOf()` slices to the first `/`, so `"src/caf\303\251.js"` has top-level directory `"src` —
 *      a PHANTOM directory distinct from `src`, with its own weight, assigned independently:
 *
 *        AGENT 1  weight=4  dirs=["\"src","<root>","lib"]
 *        AGENT 2  weight=3  dirs=["config","src"]
 *
 *      Two agents sent into the same real directory — precisely the collision `holt partition`
 *      exists to prevent — triggered by one accented filename, which is an ordinary thing to have.
 *
 *   2. `git worktree list --porcelain` (no `-z`) does not quote paths, so a worktree DIRECTORY
 *      holding a raw newline spans two physical lines. `parseWorktreePorcelain()` kept only the
 *      first, and `discoverGitWorktrees()` reported the workstream at a TRUNCATED path that does
 *      not exist:
 *
 *        created:    ".../wt/weird\nwt"
 *        discovered: ".../wt/weird"
 *
 *      That is worse than omission: holt claims the workstream is present, at a location nothing
 *      is at, so every scan, rescue and at-risk check aims at the wrong directory while the real
 *      one — which may hold uncommitted work existing nowhere else — is never looked at.
 *
 * This is the same defect class as the batched object reader (test/unit/cat-file-batch-newline-paths.test.mjs):
 * a path with a legal-but-unusual byte silently re-frames a git protocol. Fixed at ONE point per
 * protocol — `listTrackedFiles()` in src/git.mjs, and the parser itself for the porcelain — so no
 * call site can reintroduce it by forgetting a flag.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { listTrackedFiles } from '../../src/git.mjs';
import { parseWorktreePorcelain, discoverGitWorktrees } from '../../src/discover.mjs';
import { partitionPlan } from '../../src/partition.mjs';
import { samePathAsync } from '../../src/paths.mjs';
import { newRepo } from '../fixtures.mjs';

const NEWLINE_NAME = 'weird\nfile.js';

/** A raw newline is legal on POSIX and UNREPRESENTABLE on Windows — assert that, never skip it. */
async function newlineNamesAreRepresentable(dir) {
  const probe = path.join(dir, NEWLINE_NAME);
  try {
    await fs.writeFile(probe, 'probe\n');
    await fs.rm(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

const run = (args, cwd) => new Promise((res, rej) => execFile(
  'git', args, { cwd }, (e, out, err) => (e ? rej(new Error(String(err || e.message))) : res(String(out))),
));

test('listTrackedFiles: a non-ASCII filename comes back as the REAL path, not C-quoted octal', async (t) => {
  const fx = await newRepo('framing1');
  t.after(() => fx.cleanup());

  await fx.write('src/plain.js', 'export const a = 1;\n');
  await fx.write('src/café.js', 'export const b = 2;\n');
  await fx.write('src/日本語.js', 'export const c = 3;\n');
  await fx.write('lib/ok.js', 'export const d = 4;\n');
  await fx.commit('non-ASCII names under src/');

  const files = await listTrackedFiles(fx.root);

  // PROVE PRESENCE: the exact strings written to disk must be in the listing. "the listing was
  // non-empty" is not evidence — the defective form returned a full listing too, of wrong names.
  for (const rel of ['src/plain.js', 'src/café.js', 'src/日本語.js', 'lib/ok.js']) {
    assert.ok(files.includes(rel), `${JSON.stringify(rel)} missing; got ${JSON.stringify(files)}`);
  }
  // And nothing quoted or escaped leaked through under any name.
  const mangled = files.filter((f) => f.startsWith('"') || f.includes('\\3') || f.includes('\\n'));
  assert.deepEqual(mangled, [], 'no path may arrive C-quoted or octal-escaped');
});

test('listTrackedFiles: `core.quotePath` cannot change the answer — the framing does not depend on config', async (t) => {
  const fx = await newRepo('framing2');
  t.after(() => fx.cleanup());
  await fx.write('src/café.js', 'export const b = 2;\n');
  await fx.commit('accented name');

  // A repo may set quotePath either way. `-z` suppresses quoting outright, so both must agree;
  // the line-framed form did NOT (default-true quoted, false emitted raw bytes).
  const before = await listTrackedFiles(fx.root);
  await run(['config', 'core.quotePath', 'false'], fx.root);
  const withFalse = await listTrackedFiles(fx.root);
  await run(['config', 'core.quotePath', 'true'], fx.root);
  const withTrue = await listTrackedFiles(fx.root);

  assert.ok(before.includes('src/café.js'));
  assert.deepEqual(withFalse, before);
  assert.deepEqual(withTrue, before);
});

test('listTrackedFiles: a newline-named file arrives whole, as ONE entry', async (t) => {
  const fx = await newRepo('framing3');
  t.after(() => fx.cleanup());
  if (!await newlineNamesAreRepresentable(fx.root)) {
    assert.equal(process.platform, 'win32', 'a newline-named file must be creatable off Windows');
    return;
  }

  await fx.write('a.js', 'export const a = 1;\n');
  await fx.write(NEWLINE_NAME, 'export const w = 2;\n');
  await fx.write('z.js', 'export const z = 3;\n');
  await fx.commit('one newline-named file');

  const files = await listTrackedFiles(fx.root);
  assert.ok(files.includes(NEWLINE_NAME), `newline-named path missing; got ${JSON.stringify(files)}`);
  assert.equal(
    files.filter((f) => f === 'weird' || f === 'file.js').length, 0,
    'the newline-named path must not arrive as two separate entries',
  );
});

test('partition: one accented filename must not fork its directory into a phantom second lane', async (t) => {
  const fx = await newRepo('framing4');
  t.after(() => fx.cleanup());

  await fx.write('src/plain.js', 'export const a = 1;\n');
  await fx.write('src/café.js', 'export const b = 2;\n');
  await fx.write('lib/ok.js', 'export const c = 3;\n');
  await fx.commit('one non-ASCII name under src/');

  const plan = partitionPlan({ collisions: [] }, await listTrackedFiles(fx.root), { agents: 2 });
  const allDirs = plan.buckets.flatMap((b) => b.dirs);

  assert.deepEqual(
    [...allDirs].sort(), ['<root>', 'config', 'lib', 'src'],
    'every real top-level directory appears exactly once — and no quote-prefixed phantom appears',
  );
  const lanesNamingSrc = plan.buckets.filter((b) => b.dirs.some((d) => d.includes('src')));
  assert.equal(
    lanesNamingSrc.length, 1,
    `src must belong to exactly ONE agent; got ${JSON.stringify(plan.buckets.map((b) => b.dirs))}`,
  );
});

test('parseWorktreePorcelain: a raw newline in a worktree path does not truncate it', () => {
  // Verbatim shape of `git worktree list --porcelain` (git 2.55) for a worktree directory whose
  // name holds a newline. Paths are NOT quoted by this command, so the record spans two lines.
  const stdout = [
    'worktree /repo',
    'HEAD 1111111111111111111111111111111111111111',
    'branch refs/heads/main',
    '',
    'worktree /wt/weird',
    'wt',
    'HEAD 2222222222222222222222222222222222222222',
    'branch refs/heads/feat-weird',
    '',
    'worktree /wt/plain',
    'HEAD 3333333333333333333333333333333333333333',
    'branch refs/heads/feat-plain',
    '',
  ].join('\n');

  const recs = parseWorktreePorcelain(stdout);
  assert.equal(recs.length, 3, `three records, got ${recs.length}: ${JSON.stringify(recs.map((r) => r.path))}`);
  assert.deepEqual(recs.map((r) => r.path), ['/repo', '/wt/weird\nwt', '/wt/plain']);
  assert.deepEqual(recs.map((r) => r.branch), ['refs/heads/main', 'refs/heads/feat-weird', 'refs/heads/feat-plain']);
});

test('parseWorktreePorcelain: ordinary listings, bare repos and lock reasons parse exactly as before', () => {
  const stdout = [
    'worktree /bare',
    'bare',
    '',
    'worktree /repo',
    'HEAD 4444444444444444444444444444444444444444',
    'detached',
    'locked "holt: holding\\nwork"',
    'prunable gitdir file points to non-existent location',
    '',
  ].join('\n');

  const recs = parseWorktreePorcelain(stdout);
  assert.equal(recs.length, 2);
  assert.equal(recs[0].path, '/bare');
  assert.equal(recs[0].bare, true);
  assert.equal(recs[1].path, '/repo');
  assert.equal(recs[1].detached, true);
  assert.equal(recs[1].locked, true);
  assert.equal(recs[1].lockReason, 'holt: holding\nwork');
  assert.equal(recs[1].prunable, true);
  assert.equal(recs[1].prunableReason, 'gitdir file points to non-existent location');
});

test('discoverGitWorktrees: a newline-named worktree DIRECTORY is reported at its real path', async (t) => {
  const fx = await newRepo('framing5');
  t.after(() => fx.cleanup());
  if (!await newlineNamesAreRepresentable(fx.root)) {
    assert.equal(process.platform, 'win32', 'a newline-named directory must be creatable off Windows');
    return;
  }

  // The BRANCH name cannot hold a newline (git ref format forbids control characters) — only the
  // directory can, which is exactly the real-world shape: an ordinary branch, an odd directory.
  const weirdPath = path.join(fx.root, '..', 'wt', 'weird\nwt');
  await run(['worktree', 'add', '-b', 'feat-weird', weirdPath], fx.root);
  await run(['worktree', 'add', '-b', 'feat-plain', path.join(fx.root, '..', 'wt', 'plainwt')], fx.root);

  const disc = await discoverGitWorktrees(fx.root);
  const found = disc.workstreams.find((w) => w.branch === 'feat-weird');

  assert.ok(found, `the newline-named worktree must be discovered; got ${JSON.stringify(disc.workstreams.map((w) => w.path))}`);
  // samePathAsync, not `path.resolve(a) === path.resolve(b)` — which is the exact hand-rolled
  // comparison src/paths.mjs exists to replace, and which fails on macOS because os.tmpdir()
  // hands out /var/folders/… while git reports the realpath /private/var/folders/…. The test was
  // asserting a symlink, not a truncation, and went red on every macOS run for it.
  assert.ok(
    await samePathAsync(found.path, weirdPath),
    'the reported path must be the real directory, not a prefix of it truncated at the newline: '
    + `got ${JSON.stringify(found.path)}, want ${JSON.stringify(weirdPath)}`,
  );
  // ANTI-VACUITY for the comparison itself: samePathAsync must still be able to say NO, or the
  // assertion above would pass against any path at all.
  assert.equal(
    await samePathAsync(found.path, path.join(fx.root, '..', 'wt', 'plainwt')), false,
    'samePathAsync must distinguish two real, different worktrees',
  );
  // GRADE FROM THE FILESYSTEM: the path holt reports must actually be there. A truncated path
  // names a directory that does not exist, and every later operation aims at nothing.
  await assert.doesNotReject(fs.stat(found.path), 'the reported worktree path must exist on disk');
});
