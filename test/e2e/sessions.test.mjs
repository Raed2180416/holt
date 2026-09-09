/** Real repository journeys for automatic ownership: useful success and interrupted work. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { newRepo } from '../fixtures.mjs';
import { discover } from '../../src/discover.mjs';
import { scan } from '../../src/scan.mjs';
import { analyze } from '../../src/analyze.mjs';
import { clean, restoreQuarantine, purgeQuarantine } from '../../src/actions.mjs';
import {
  openWorktreeSession, updateWorktreeSession, inspectWorktreeOwnership,
  operateWorktreeOwnership, withUnclaimedWorktreeOwnership, ownershipTarget,
  handoffWorktreeSession,
} from '../../src/ownership.mjs';

const inspect = async (root) => analyze(await scan(await discover(root), {}), {});
const at = Date.parse('2026-09-08T15:00:00Z');

async function attach(t, name = 'automatic') {
  const fx = await newRepo(`session-${name}`);
  t.after(() => fx.cleanup());
  const wt = await fx.worktree(name);
  const opened = await openWorktreeSession(wt, { label: name });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.ok(opened.credential);
  let sequence = 0;
  const send = (event) => updateWorktreeSession(wt, opened.credential, { sequence: ++sequence, ...event });
  return { fx, wt, opened, send };
}

test('SESSIONS: normal tool work drains and releases a clean workspace without a manual ownership call', async (t) => {
  const { fx, wt, send } = await attach(t);
  let report = await inspect(fx.root);
  assert.equal(report.safe.find((row) => row.id === 'automatic').safe, false);
  assert.equal((await send({ type: 'operation-start', operationId: 'build', kind: 'shell', paths: [] })).ok, true);
  assert.equal((await send({ type: 'operation-finish', operationId: 'build' })).ok, true);
  assert.equal((await send({ type: 'drain' })).ok, true);
  const ended = await send({ type: 'finish' });
  assert.equal(ended.ok, true, JSON.stringify(ended));
  assert.equal(ended.ownership.state, 'unclaimed');
  report = await inspect(fx.root);
  assert.equal(report.safe.find((row) => row.id === 'automatic').safe, true);
  const moved = await clean(fx.root, { apply: true });
  assert.ok(moved.actions.some((row) => row.id === 'automatic' && row.action === 'quarantined'), JSON.stringify(moved));
  await assert.rejects(fs.stat(wt), { code: 'ENOENT' });
});

test('SESSIONS: agent completion cannot retire an editor or a background job', async (t) => {
  const { fx, wt, opened, send } = await attach(t, 'shared');
  const editor = await openWorktreeSession(wt, { kind: 'editor', label: 'editor' });
  const job = await openWorktreeSession(wt, { kind: 'job', label: 'test runner' });
  assert.equal(editor.ok && job.ok, true);
  assert.equal((await send({ type: 'drain' })).ok, true);
  assert.equal((await send({ type: 'finish' })).ok, true);
  const state = await inspectWorktreeOwnership(wt);
  assert.equal(state.sessions.length, 2);
  assert.ok(!state.sessions.some((session) => session.id === opened.credential.id));
  assert.equal((await inspect(fx.root)).safe.find((row) => row.id === 'shared').safe, false);
  const stolen = await updateWorktreeSession(wt, { ...opened.credential, id: editor.credential.id }, { sequence: 1, type: 'drain' });
  assert.equal(stolen.ok, false);
  assert.equal(stolen.code, 'session-credential-mismatch');
});

test('SESSIONS: explicit owner release preserves attached sessions, and final session release restores a manual lease', async (t) => {
  const { wt, send } = await attach(t, 'manual-coexistence');
  assert.equal((await operateWorktreeOwnership(wt, { operation: 'claim', owner: 'operator' })).ok, true);
  let released = await operateWorktreeOwnership(wt, { operation: 'release', owner: 'operator' });
  assert.equal(released.ok, true);
  assert.equal(released.ownership.manual, false);
  assert.equal(released.ownership.sessions.length, 1);
  assert.equal(released.nativeGitLockReleased, false);
  assert.equal((await operateWorktreeOwnership(wt, { operation: 'claim', owner: 'operator' })).ok, true);
  assert.equal((await send({ type: 'drain' })).ok, true);
  assert.equal((await send({ type: 'finish' })).ok, true);
  const manual = await inspectWorktreeOwnership(wt);
  assert.equal(manual.owner, 'operator');
  assert.equal(manual.sessions, undefined);
  released = await operateWorktreeOwnership(wt, { operation: 'release', owner: 'operator' });
  assert.equal(released.ownership.state, 'unclaimed');
});

test('SESSIONS: an interrupted operation survives expiry, blocks finish, and resumes with its original credential', async (t) => {
  const fx = await newRepo('session-expired-operation');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('interrupted');
  const opened = await openWorktreeSession(wt, { now: at, ttlSeconds: 60 });
  assert.equal((await updateWorktreeSession(wt, opened.credential,
    { type: 'operation-start', sequence: 1, operationId: 'write', kind: 'write', paths: ['src/main.mjs'] }, { now: at, ttlSeconds: 60 })).ok, true);
  const expired = await inspectWorktreeOwnership(wt, { now: at + 61000 });
  assert.equal(expired.state, 'expired');
  assert.equal(expired.sessions[0].state, 'contact-lost');
  assert.equal(expired.sessions[0].pending[0].id, 'write');
  assert.equal((await updateWorktreeSession(wt, opened.credential, { type: 'drain', sequence: 2 }, { now: at + 62000 })).ok, true);
  const blocked = await updateWorktreeSession(wt, opened.credential, { type: 'finish', sequence: 3 }, { now: at + 63000 });
  assert.equal(blocked.code, 'work-pending');
  assert.equal((await updateWorktreeSession(wt, opened.credential, { type: 'operation-finish', sequence: 3, operationId: 'write' }, { now: at + 64000 })).ok, true);
  assert.equal((await updateWorktreeSession(wt, opened.credential, { type: 'finish', sequence: 4 }, { now: at + 65000 })).ok, true);
});

test('SESSIONS: ordered events are retryable and gaps cannot acknowledge work that was never recorded', async (t) => {
  const { wt, opened } = await attach(t, 'ordering');
  const event = { sequence: 1, type: 'operation-start', operationId: 'edit', kind: 'write', paths: ['a.txt'] };
  assert.equal((await updateWorktreeSession(wt, opened.credential, event)).ok, true);
  assert.equal((await updateWorktreeSession(wt, opened.credential, event)).repeated, true);
  assert.equal((await updateWorktreeSession(wt, opened.credential, { sequence: 3, type: 'finish' })).code, 'sequence-mismatch');
  assert.equal((await updateWorktreeSession(wt, opened.credential, { ...event, paths: ['b.txt'] })).code, 'sequence-mismatch');
  assert.equal((await inspectWorktreeOwnership(wt)).sessions[0].pending.length, 1);
});

test('SESSIONS: dirty buffer versions prevent premature close and finish; a saved closed buffer permits completion', async (t) => {
  const { wt, opened } = await attach(t, 'buffer');
  const send = (sequence, event) => updateWorktreeSession(wt, opened.credential, { sequence, ...event });
  const buffer = { path: 'draft.txt', version: 1, digest: 'a'.repeat(64), dirty: true, recoveryRef: null };
  assert.equal((await send(1, { type: 'buffer', buffer })).ok, true);
  assert.equal((await send(2, { type: 'buffer-close', path: 'draft.txt', version: 1 })).code, 'unsaved-buffer');
  assert.equal((await send(2, { type: 'buffer', buffer: { ...buffer, digest: 'b'.repeat(64), dirty: false } })).code, 'buffer-version-mismatch');
  assert.equal((await send(2, { type: 'buffer', buffer: { ...buffer, dirty: false } })).ok, true);
  assert.equal((await send(3, { type: 'drain' })).ok, true);
  assert.equal((await send(4, { type: 'finish' })).code, 'work-pending');
  assert.equal((await send(4, { type: 'buffer-close', path: 'draft.txt', version: 1 })).ok, true);
  assert.equal((await send(5, { type: 'finish' })).ok, true);
});

test('SESSIONS: cleanup and automatic attach use the same native mutex', async (t) => {
  const fx = await newRepo('session-clean-race');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('race');
  const result = await withUnclaimedWorktreeOwnership(wt, async () => {
    const attachment = await openWorktreeSession(wt);
    assert.equal(attachment.ok, false);
    assert.equal(attachment.code, 'busy');
    return { ok: true };
  });
  assert.equal(result.ok, true);
  assert.equal((await openWorktreeSession(wt)).ok, true);
  let callbackRan = false;
  const blocked = await withUnclaimedWorktreeOwnership(wt, async () => { callbackRan = true; });
  assert.equal(blocked.ok, false);
  assert.equal(callbackRan, false);
});

test('SESSIONS: public reports and serialised attachment responses never reveal release or recovery capabilities', async (t) => {
  const { wt, opened } = await attach(t, 'secrets');
  assert.ok(!JSON.stringify(opened).includes(opened.credential.capability));
  const target = await ownershipTarget(wt);
  const stored = JSON.parse(await fs.readFile(path.join(target.root, 'records', `${target.key}.json`), 'utf8'));
  assert.ok(!JSON.stringify(stored).includes(opened.credential.capability));
  const report = JSON.stringify(await inspectWorktreeOwnership(wt));
  assert.ok(!report.includes('capabilityHash'));
  assert.ok(!report.includes(stored.managed.sessions[0].capabilityHash));
});

test('SESSIONS: a handoff retains pending work and fences late acknowledgements from the previous host', async (t) => {
  const { wt, opened, send } = await attach(t, 'fenced-handoff');
  assert.equal((await send({ type: 'operation-start', operationId: 'edit', kind: 'write', paths: ['a.txt'] })).ok, true);
  const successor = await handoffWorktreeSession(wt, opened.credential, 1);
  assert.equal(successor.ok, true, JSON.stringify(successor));
  assert.notEqual(successor.credential.generation, opened.credential.generation);
  assert.ok(!JSON.stringify(successor).includes(successor.credential.capability));
  assert.equal((await send({ type: 'operation-finish', operationId: 'edit' })).code, 'session-credential-mismatch');
  assert.equal((await inspectWorktreeOwnership(wt)).sessions[0].pending.length, 1);
  assert.equal((await updateWorktreeSession(wt, successor.credential, { sequence: 2, type: 'operation-finish', operationId: 'edit' })).ok, true);
  assert.equal((await updateWorktreeSession(wt, successor.credential, { sequence: 3, type: 'drain' })).ok, true);
  const end = { sequence: 4, type: 'finish' };
  assert.equal((await updateWorktreeSession(wt, successor.credential, end)).closed, true);
  const nextTask = await openWorktreeSession(wt, { label: 'next task' });
  const retried = await updateWorktreeSession(wt, successor.credential, end);
  assert.equal(retried.closed, true);
  assert.equal(retried.repeated, true);
  assert.equal((await inspectWorktreeOwnership(wt)).sessions[0].id, nextTask.credential.id);
});

test('SESSIONS: nested property order and a backward clock do not strand a valid editor update', async (t) => {
  const { wt, opened } = await attach(t, 'clock');
  const buffer = { path: 'draft.txt', version: 1, digest: 'a'.repeat(64), dirty: true, recoveryRef: null };
  const event = { type: 'buffer', sequence: 1, buffer };
  assert.equal((await updateWorktreeSession(wt, opened.credential, event)).ok, true);
  const retry = { sequence: 1, buffer: Object.fromEntries(Object.entries(buffer).reverse()), type: 'buffer' };
  assert.equal((await updateWorktreeSession(wt, opened.credential, retry, { now: Date.now() - 3600000 })).repeated, true);
  assert.equal((await updateWorktreeSession(wt, opened.credential, { sequence: 2, type: 'heartbeat' }, { now: Date.now() - 3600000 })).ok, true);
});

test('SESSIONS: legacy takeover cannot replace malformed managed sessions or unknown future versions', async (t) => {
  const { wt } = await attach(t, 'no-downgrade');
  const target = await ownershipTarget(wt);
  const file = path.join(target.root, 'records', `${target.key}.json`);
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  raw.managed.sessions[0].pending = 'damaged';
  await fs.writeFile(file, JSON.stringify(raw));
  const before = await fs.readFile(file);
  const refused = await operateWorktreeOwnership(wt, { operation: 'claim', owner: 'operator', takeover: true, reason: 'reviewed legacy repair' });
  assert.equal(refused.code, 'session-recovery-required');
  assert.deepEqual(await fs.readFile(file), before);
});

test('SESSIONS: an editor opened on quarantine prevents restore and purge; finished quarantine still purges normally', async (t) => {
  const fx = await newRepo('session-quarantine');
  t.after(() => fx.cleanup());
  await fx.worktree('review');
  const moved = await clean(fx.root, { apply: true });
  const row = moved.actions.find((item) => item.action === 'quarantined');
  assert.ok(row, JSON.stringify(moved));
  const opened = await openWorktreeSession(row.quarantinePath, { kind: 'editor', label: 'quarantine review' });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.equal((await restoreQuarantine(fx.root, row.id)).blocked, true);
  assert.equal((await purgeQuarantine(fx.root, row.id, { apply: true })).blocked, true);
  assert.equal((await updateWorktreeSession(row.quarantinePath, opened.credential, { sequence: 1, type: 'drain' })).ok, true);
  assert.equal((await updateWorktreeSession(row.quarantinePath, opened.credential, { sequence: 2, type: 'finish' })).ok, true);
  const removed = await purgeQuarantine(fx.root, row.id, { apply: true, onBeforeRemove: async () => {
    assert.equal((await openWorktreeSession(row.quarantinePath)).code, 'busy');
  } });
  assert.equal(removed.purged, true, JSON.stringify(removed));
});
