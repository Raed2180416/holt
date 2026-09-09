/** Saved versions are immutable review inputs, independently of a still-running producer. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { newRepo } from '../fixtures.mjs';
import { createCheckpoint, listCheckpoints, verifyCheckpoint, prepareCheckpoint } from '../../src/checkpoints.mjs';
import { validateCheckpoint, verifyCheckpointValidation } from '../../src/checkpoint-validation.mjs';
import { landCheckpoint, recoverCheckpointLanding } from '../../src/checkpoint-landing.mjs';
import { WorkspaceSession } from '../../src/session-host.mjs';
import { inspectWorktreeOwnership } from '../../src/ownership.mjs';
import { inspect } from '../../src/index.mjs';
import { __test } from '../../src/mcp/server.mjs';
import { buildModel, renderFrame } from '../../src/tui.mjs';
import { renderHtml } from '../../src/graph-html.mjs';

test('CHECKPOINT: version one can be prepared against a newer base while its producer continues version two', async (t) => {
  const fx = await newRepo('checkpoint-live');
  t.after(() => fx.cleanup());
  await fx.write('feature.txt', 'original\n');
  await fx.commit('base');
  const wt = await fx.worktree('producer');
  const host = await WorkspaceSession.open(wt, { label: 'live producer' });
  t.after(() => host.disconnect());
  await fx.write('feature.txt', 'version one\n', wt);
  const versionOne = await fx.commit('version one', wt);
  const saved = await host.checkpoint();
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.checkpoint.commit, versionOne);
  assert.equal((await createCheckpoint(wt)).reused, true);

  await fx.write('feature.txt', 'version two\n', wt);
  const versionTwo = await fx.commit('version two', wt);
  await fx.write('next.txt', 'still being drafted\n', wt);
  await fx.write('base-progress.txt', 'independent integration change\n');
  const newBase = await fx.commit('integration advanced');
  const before = await fx.git(['status', '--porcelain=v2', '-z'], wt);
  const prepared = await prepareCheckpoint(fx.root, saved.checkpoint.id);
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  assert.equal(prepared.base.expected, newBase);
  assert.equal(prepared.baseChanged, false);
  assert.equal(prepared.validation, 'not-run');
  assert.equal(await fx.git(['show', `${prepared.candidate}:feature.txt`]), 'version one\n');
  assert.equal(await fx.git(['show', `${prepared.candidate}:base-progress.txt`]), 'independent integration change\n');
  assert.equal((await fx.git(['rev-parse', 'HEAD'], wt)).trim(), versionTwo);
  assert.equal(await fx.git(['status', '--porcelain=v2', '-z'], wt), before);
  assert.equal((await inspectWorktreeOwnership(wt)).sessions[0].id, host.id);
  assert.equal((await host.finish()).ok, true);
});

test('CHECKPOINT: changed pins are reported and cannot silently become a different review candidate', async (t) => {
  const fx = await newRepo('checkpoint-tamper');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('producer');
  const saved = await createCheckpoint(wt);
  await fx.write('new.txt', 'different\n', wt);
  const different = await fx.commit('different version', wt);
  await fx.git(['update-ref', saved.checkpoint.ref, different]);
  assert.equal((await verifyCheckpoint(wt, saved.checkpoint.id)).code, 'checkpoint-pin-changed');
  assert.equal((await prepareCheckpoint(wt, saved.checkpoint.id)).code, 'checkpoint-pin-changed');
  const inventory = await listCheckpoints(wt);
  assert.equal(inventory.items.length, 0);
  assert.equal(inventory.issues[0].code, 'checkpoint-pin-changed');
  const report = await inspect(fx.root);
  assert.equal(report.counts.scanned, 1, 'optional checkpoint corruption must not disable content inspection');
  assert.equal(report.checkpoints.issues.length, 1);
});

test('CHECKPOINT SURFACES: MCP and visual views expose saved versions without inventing a deletable worktree', async (t) => {
  const fx = await newRepo('checkpoint-surfaces');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('producer');
  const host = await WorkspaceSession.open(wt, { label: 'producer session' });
  t.after(() => host.disconnect());
  await fx.write('feature.txt', 'ready for review\n', wt);
  await fx.commit('ready version', wt);
  __test.clearCache();
  const captured = await __test.handle('holt_checkpoint', { repo: fx.root, operation: 'capture', workstream: 'producer' });
  assert.equal(captured.ok, true, JSON.stringify(captured));
  const inventory = await __test.handle('holt_checkpoint', { repo: fx.root, operation: 'list' });
  assert.equal(inventory.items[0].commit, captured.checkpoint.commit);
  assert.equal(inventory.items[0].verified, true);
  const report = await inspect(fx.root);
  assert.equal(report.counts.workstreams, 1);
  assert.equal(report.counts.checkpointVersions, 1);
  assert.equal(report.safe.length, 1);
  assert.equal(report.safe[0].safe, false, 'a saved version does not end the producer session');
  assert.equal(report.graph.nodes[0].checkpoints[0].id, captured.checkpoint.id);
  assert.match(renderHtml(report), /available for review while the producer continues/);
  const model = await buildModel(fx.root);
  const frame = renderFrame(model, { selected: 0, filter: 'all', message: '' }, { columns: 160, rows: 44 });
  assert.match(frame, /committed version available for review/);
  assert.match(frame, /holt checkpoint prepare/);
  assert.equal((await host.finish()).ok, true);
});

test('CHECKPOINT: a real textual conflict names the candidate and leaves the producer untouched', async (t) => {
  const fx = await newRepo('checkpoint-conflict');
  t.after(() => fx.cleanup());
  await fx.write('shared.txt', 'base\n');
  await fx.commit('base');
  const wt = await fx.worktree('producer');
  await fx.write('shared.txt', 'producer\n', wt);
  await fx.commit('producer', wt);
  const captured = await createCheckpoint(wt);
  await fx.write('shared.txt', 'integration\n');
  await fx.commit('integration');
  const prepared = await prepareCheckpoint(fx.root, captured.checkpoint.id);
  assert.equal(prepared.code, 'checkpoint-conflicts-with-base');
  assert.equal(await fs.readFile(path.join(wt, 'shared.txt'), 'utf8'), 'producer\n');
});

test('CHECKPOINT VALIDATION: the exact saved version is tested while its live producer and base can continue changing', { skip: process.platform !== 'linux' }, async (t) => {
  const fx = await newRepo('checkpoint-validation');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('producer');
  await fx.write('feature.txt', 'version one\n', wt);
  await fx.commit('version one', wt);
  const saved = await createCheckpoint(wt);
  const host = await WorkspaceSession.open(wt);
  t.after(() => host.disconnect());
  await fx.write('feature.txt', 'unfinished version two\n', wt);
  const validated = await validateCheckpoint(fx.root, saved.checkpoint.id, { argv: [process.execPath, '-e',
    "require('node:assert/strict').equal(require('node:fs').readFileSync('feature.txt','utf8'),'version one\\n')"] });
  assert.equal(validated.ok, true, JSON.stringify(validated));
  assert.equal(validated.validation.sameInput, true);
  assert.equal((await verifyCheckpointValidation(fx.root, validated.validation.id)).ok, true);
  assert.equal(await fs.readFile(path.join(wt, 'feature.txt'), 'utf8'), 'unfinished version two\n');
  assert.equal((await inspectWorktreeOwnership(wt)).sessions[0].id, host.id);
  await fx.write('new-base.txt', 'base advanced after testing\n');
  await fx.commit('advance integration');
  assert.equal((await verifyCheckpointValidation(fx.root, validated.validation.id)).code, 'validation-base-changed');
  await host.finish();
});

test('CHECKPOINT VALIDATION: failing tests, failing detached work and concealed input changes never earn a passing certificate', { skip: process.platform !== 'linux' }, async (t) => {
  const fx = await newRepo('checkpoint-validation-negative');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('producer');
  await fx.write('feature.txt', 'must be tested as written\n', wt);
  await fx.commit('version', wt);
  const saved = await createCheckpoint(wt);
  const cases = [
    ['process.exit(7)', 'test-command-failed'],
    ["require('node:child_process').spawn(process.execPath,['-e','process.exit(9)'],{detached:true,stdio:'ignore'}).unref()", 'descendant-command-failed'],
    ["require('node:child_process').execFileSync('git',['update-index','--assume-unchanged','feature.txt']);require('node:fs').writeFileSync('feature.txt','changed test input')", 'tested-input-changed'],
  ];
  for (const [program, reason] of cases) {
    const result = await validateCheckpoint(fx.root, saved.checkpoint.id, { argv: [process.execPath, '-e', program] });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.validation.reason, reason);
    assert.equal((await verifyCheckpointValidation(fx.root, result.validation.id)).code, 'validation-not-passed');
  }
});

test('CHECKPOINT LANDING: tested version lands while producer continues and unrelated staged and unstaged work survives', { skip: process.platform !== 'linux' }, async (t) => {
  const fx = await newRepo('checkpoint-land');
  t.after(() => fx.cleanup());
  await fx.write('unrelated.txt', 'base\n');
  await fx.commit('base');
  const wt = await fx.worktree('producer');
  await fx.write('feature.txt', 'version one\n', wt);
  await fx.commit('version one', wt);
  const saved = await createCheckpoint(wt);
  const validated = await validateCheckpoint(fx.root, saved.checkpoint.id, { argv: [process.execPath, '-e', 'process.exit(0)'] });
  assert.equal(validated.ok, true, JSON.stringify(validated));
  const host = await WorkspaceSession.open(wt);
  t.after(() => host.disconnect());
  await fx.write('feature.txt', 'unfinished version two\n', wt);
  await fx.write('unrelated.txt', 'staged\n');
  await fx.git(['add', 'unrelated.txt']);
  await fx.write('unrelated.txt', 'unstaged\n');
  const landed = await landCheckpoint(fx.root, validated.validation.id);
  assert.equal(landed.ok, true, JSON.stringify(landed));
  assert.equal((await fx.git(['rev-parse', 'HEAD'])).trim(), validated.validation.candidate);
  assert.equal(await fs.readFile(path.join(fx.root, 'feature.txt'), 'utf8'), 'version one\n');
  assert.equal(await fx.git(['show', ':unrelated.txt']), 'staged\n');
  assert.equal(await fs.readFile(path.join(fx.root, 'unrelated.txt'), 'utf8'), 'unstaged\n');
  assert.equal(await fs.readFile(path.join(wt, 'feature.txt'), 'utf8'), 'unfinished version two\n');
  assert.equal((await inspectWorktreeOwnership(fx.root)).state, 'unclaimed');
  assert.equal((await recoverCheckpointLanding(fx.root, landed.landingId)).alreadyLanded, true);
  await host.finish();
});

test('CHECKPOINT LANDING: an active editor or overlapping local content refuses integration without changing either', { skip: process.platform !== 'linux' }, async (t) => {
  const fx = await newRepo('checkpoint-land-refusal');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('producer');
  await fx.write('feature.txt', 'candidate\n', wt);
  await fx.commit('candidate', wt);
  const saved = await createCheckpoint(wt);
  const validated = await validateCheckpoint(fx.root, saved.checkpoint.id, { argv: [process.execPath, '-e', 'process.exit(0)'] });
  assert.equal(validated.ok, true);
  const head = await fx.git(['rev-parse', 'HEAD']);
  const editor = await WorkspaceSession.open(fx.root, { kind: 'editor' });
  t.after(() => editor.disconnect());
  assert.equal((await landCheckpoint(fx.root, validated.validation.id)).code, 'workspace-in-use');
  await editor.finish();
  await fx.write('feature.txt', 'untracked user draft\n');
  assert.equal((await landCheckpoint(fx.root, validated.validation.id)).code, 'landing-overlaps-local-work');
  assert.equal(await fx.git(['rev-parse', 'HEAD']), head);
  assert.equal(await fs.readFile(path.join(fx.root, 'feature.txt'), 'utf8'), 'untracked user draft\n');
  assert.equal((await inspectWorktreeOwnership(fx.root)).state, 'unclaimed');
});
