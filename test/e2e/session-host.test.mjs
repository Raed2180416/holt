/** A host owns operation promises and buffer events; no model-issued lease commands. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { newRepo } from '../fixtures.mjs';
import { WorkspaceSession } from '../../src/session-host.mjs';
import { inspectWorktreeOwnership, ownershipTarget } from '../../src/ownership.mjs';
import { readBufferSnapshot, recoverBufferSnapshot } from '../../src/session-buffers.mjs';
import { clean } from '../../src/actions.mjs';

test('HOST: finish drains granted operations, rejects new work, and overlapping finish calls share one outcome', async (t) => {
  const fx = await newRepo('host-drain');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('task');
  const host = await WorkspaceSession.open(wt, { kind: 'agent', label: 'fixture host' });
  t.after(() => host.disconnect());
  let release;
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  const running = host.withOperation({ kind: 'write', paths: ['output.txt'] }, async () => {
    started();
    return new Promise((resolve) => { release = resolve; });
  });
  await entered;
  const finishing = host.finish();
  assert.equal(finishing, host.finish());
  let extraRan = false;
  await assert.rejects(host.withOperation({ kind: 'write' }, async () => { extraRan = true; }), { code: 'session-draining' });
  assert.equal(extraRan, false);
  assert.equal((await inspectWorktreeOwnership(wt)).sessions[0].pending.length, 1);
  release('complete');
  assert.equal(await running, 'complete');
  assert.equal((await finishing).ok, true);
  assert.equal(host.closed, true);
  assert.equal((await inspectWorktreeOwnership(wt)).state, 'unclaimed');
});

test('HOST: failed operations settle without an abandoned lease or hiding the original failure', async (t) => {
  const fx = await newRepo('host-failed-operation');
  t.after(() => fx.cleanup());
  const host = await WorkspaceSession.open(fx.root);
  t.after(() => host.disconnect());
  const failure = new Error('the real command failed');
  await assert.rejects(host.withOperation({ kind: 'shell' }, async () => { throw failure; }), (error) => error === failure);
  assert.equal((await host.finish()).ok, true);
  assert.equal((await inspectWorktreeOwnership(fx.root)).state, 'unclaimed');
});

test('BUFFER RECOVERY: unsaved text survives buffer close and workspace quarantine without modifying the working file', async (t) => {
  const fx = await newRepo('buffer-recovery');
  t.after(() => fx.cleanup());
  await fx.write('draft.txt', 'saved on disk\n');
  await fx.commit('saved draft');
  const wt = await fx.worktree('task');
  const host = await WorkspaceSession.open(wt, { kind: 'editor', label: 'editor' });
  t.after(() => host.disconnect());
  const text = 'unsaved text\r\nwith Unicode 🦉 and a lone code unit \ud800';
  assert.equal((await host.updateBufferFromText({ path: 'draft.txt', text, version: 7 })).ok, true);
  assert.equal(await fs.readFile(path.join(wt, 'draft.txt'), 'utf8'), 'saved on disk\n');
  const active = await inspectWorktreeOwnership(wt);
  assert.equal(active.sessions[0].buffers[0].recoverable, true);
  assert.equal((await host.finish()).code, 'work-pending');
  assert.equal((await host.closeBuffer('draft.txt', 7)).ok, true);
  assert.equal((await host.finish()).ok, true);
  const target = await ownershipTarget(wt);
  const receipts = await fs.readdir(path.join(target.root, 'buffer-recoveries'));
  assert.equal(receipts.length, 1);
  const receipt = JSON.parse(await fs.readFile(path.join(target.root, 'buffer-recoveries', receipts[0]), 'utf8'));
  const recovered = await readBufferSnapshot(target.root, receipt.buffer.recoveryRef);
  assert.equal(recovered.snapshot.text, text);
  assert.equal((await clean(fx.root, { apply: true })).quarantined, 1);
  assert.equal((await readBufferSnapshot(target.root, receipt.buffer.recoveryRef)).snapshot.text, text);
  const destination = path.join(fx.root, 'recovered-draft.json');
  assert.equal((await recoverBufferSnapshot(target.root, receipt.buffer.recoveryRef, destination)).ok, true);
  assert.equal(JSON.parse(await fs.readFile(destination, 'utf8')).text, text);
  assert.equal((await recoverBufferSnapshot(target.root, receipt.buffer.recoveryRef, destination)).code, 'destination-exists');
});

test('BUFFER RECOVERY: save events may keep the same document version; out-of-order content cannot replace a newer snapshot', async (t) => {
  const fx = await newRepo('buffer-order');
  t.after(() => fx.cleanup());
  const host = await WorkspaceSession.open(fx.root, { kind: 'editor' });
  t.after(() => host.disconnect());
  const first = host.updateBufferFromText({ path: 'draft.txt', text: 'first', version: 1 });
  const second = host.updateBufferFromText({ path: 'draft.txt', text: 'second', version: 2 });
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
  assert.equal((await host.updateBufferFromText({ path: 'draft.txt', text: 'first', version: 1 })).code, 'buffer-version-mismatch');
  assert.equal((await host.updateBufferFromText({ path: 'draft.txt', text: 'second', version: 2, dirty: false })).ok, true);
  assert.equal((await host.closeBuffer('draft.txt', 2)).ok, true);
  assert.equal((await host.finish()).ok, true);
});
