// SPDX-License-Identifier: FSL-1.1-MIT
/** Read-only recovery inventory and exclusive export of privately captured editor text. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ownershipTarget, inspectWorktreeOwnership, updateWorktreeSession } from './ownership.mjs';
import { readStableRegularFile, writePrivateFileAtomic, syncPrivateDirectory } from './stable-file.mjs';
import { validSession, authenticSession, SESSION_MAX_BYTES } from './sessions.mjs';
import { readBufferSnapshot, recoverBufferSnapshot } from './session-buffers.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const LIMIT = 1024;

/** Includes retained receipts from workspaces that have since moved into quarantine. */
export async function listSessionBuffers(cwd) {
  const target = await ownershipTarget(cwd);
  if (!target.ok) return { ok: false, code: 'repository-unavailable', buffers: [], issues: [] };
  const items = [];
  const issues = [];
  let omitted = false;
  let bytesRead = 0;
  for (const directory of ['records', 'buffer-recoveries']) {
    let names;
    try { names = (await fs.readdir(path.join(target.root, directory))).filter((name) => name.endsWith('.json')).sort(); }
    catch (error) { if (error?.code === 'ENOENT') continue; issues.push({ directory, code: 'inventory-unavailable' }); continue; }
    if (names.length > LIMIT) omitted = true;
    for (const name of names.slice(0, LIMIT)) {
      if (items.length >= LIMIT || bytesRead >= 64 * 1024 * 1024) { omitted = true; break; }
      const stored = await readStableRegularFile(path.join(target.root, directory, name), { maxBytes: SESSION_MAX_BYTES, requireOwner: true, requireSingleLink: true });
      if (!stored.ok) { issues.push({ file: name, code: 'record-unavailable' }); continue; }
      bytesRead += stored.bytes.length;
      try {
        const record = JSON.parse(stored.bytes.toString('utf8'));
        if (!/^[0-9a-f]{64}$/.test(record.worktreeKey)) throw new Error('invalid worktree key');
        const captures = directory === 'records'
          ? (record.managed?.sessions ?? []).flatMap((session) => {
            if (!validSession(session)) throw new Error('invalid session');
            return session.buffers.map((buffer) => ({ sessionId: session.id, buffer, state: 'open' }));
          }) : [{ sessionId: record.sessionId, buffer: record.buffer, state: 'retained' }];
        for (const capture of captures) {
          if (items.length >= LIMIT || bytesRead >= 64 * 1024 * 1024) { omitted = true; break; }
          if (!capture.buffer?.recoveryRef) continue;
          const verified = await readBufferSnapshot(target.root, capture.buffer.recoveryRef);
          bytesRead += (verified.snapshot?.text.length ?? 0) * 2;
          if (!verified.ok || verified.digest !== capture.buffer.digest || verified.snapshot?.bufferPath !== capture.buffer.path) {
            issues.push({ file: name, code: 'buffer-integrity-failed' }); continue;
          }
          const id = hash(`${record.worktreeKey}\0${capture.sessionId}\0${capture.buffer.path}\0${capture.buffer.version}\0${capture.buffer.recoveryRef}`);
          items.push({ id, worktreeKey: record.worktreeKey, sessionId: capture.sessionId, path: capture.buffer.path,
            version: capture.buffer.version, dirty: capture.buffer.dirty, state: capture.state,
            digest: verified.digest, encoding: verified.snapshot.encoding, codeUnits: verified.snapshot.text.length,
            recoveryRef: capture.buffer.recoveryRef });
        }
      } catch { issues.push({ file: name, code: 'invalid-record' }); }
    }
  }
  const buffers = [...new Map(items.map((item) => [item.id, item])).values()];
  const result = { ok: true, buffers: buffers.map(({ recoveryRef, ...item }) => item), issues, omitted };
  Object.defineProperty(result, '_captures', { value: buffers, enumerable: false });
  Object.defineProperty(result, '_root', { value: target.root, enumerable: false });
  return /** @type {typeof result & {_captures:typeof buffers,_root:string}} */ (result);
}

/** An id selects a freshly verified captured version, never an arbitrary file path. */
export async function recoverSessionBuffer(cwd, id, destination) {
  const inventory = await listSessionBuffers(cwd);
  const found = inventory._captures?.find((item) => item.id === id);
  if (!found) return { ok: false, code: 'unknown-buffer', issues: inventory.issues };
  return recoverBufferSnapshot(inventory._root, found.recoveryRef, destination);
}

/** Positive OS completion evidence, persisted independently of the wrapper that may have died. */
function completedRunner(events, backend) {
  if (!Array.isArray(events) || events[0]?.type !== 'ready' || events[0]?.backend !== backend) return false;
  const drained = events.at(-1);
  if (drained?.type !== 'drained' || !Number.isSafeInteger(drained.exitCode)
    || !Number.isSafeInteger(drained.reaped) || drained.reaped < 0) return false;
  if (events.length === 2) return drained.exitCode === 127 && typeof drained.launchError === 'string' && drained.reaped === 0;
  return events.length === 4 && events[1]?.type === 'started' && Number.isSafeInteger(events[1]?.pid)
    && events[2]?.type === 'leader-exited' && events[2].exitCode === drained.exitCode && drained.reaped >= 1;
}

/** A retained OS receipt proves completion even after the live runner entry was retired. */
export async function verifyRunnerCompletion(cwd, id, backend) {
  if (!/^[0-9a-f-]{36}$/.test(id) || typeof backend !== 'string') return { ok: false, code: 'invalid-runner' };
  const target = await ownershipTarget(cwd);
  if (!target.ok) return { ok: false, code: 'workspace-unavailable' };
  const proof = await readStableRegularFile(path.join(target.root, 'runner-completions', `${id}.jsonl`),
    { maxBytes: 16384, requireOwner: true, requireSingleLink: true });
  let events;
  try { if (proof.ok && proof.bytes.at(-1) === 10) events = proof.bytes.toString('utf8').trim().split('\n').map((line) => JSON.parse(line)); } catch { /* retain */ }
  return completedRunner(events, backend) ? { ok: true, events } : { ok: false, code: 'command-tree-not-drained' };
}

/**
 * Retire only commands with a complete private supervisor proof. A missing supervisor, a live
 * descendant, malformed state or an expired heartbeat alone never authorizes retirement.
 * Read-only reports do not invoke this mutating recovery path.
 */
export async function recoverCompletedRunners(cwd, { onlyDisconnected = false } = {}) {
  const target = await ownershipTarget(cwd);
  if (!target.ok) return { ok: false, code: 'workspace-unavailable', recovered: [], retained: [] };
  let names;
  try { names = (await fs.readdir(path.join(target.root, 'runners'))).sort(); }
  catch (error) { return { ok: error?.code === 'ENOENT', recovered: [], retained: [] }; }
  const recovered = [];
  const retained = [];
  for (const name of names.filter((item) => /^[0-9a-f-]{36}\.json$/.test(item)).slice(0, 128)) {
    const stored = await readStableRegularFile(path.join(target.root, 'runners', name), { maxBytes: 8192, requireOwner: true, requireSingleLink: true });
    let record;
    try { if (stored.ok) record = JSON.parse(stored.bytes.toString('utf8')); } catch { /* retained */ }
    if (record?.worktreeKey !== target.key) continue;
    const id = name.slice(0, -5);
    if (record.version !== 2 || record.credential?.id !== id || typeof record.backend !== 'string') {
      retained.push({ id, code: 'runner-recovery-unavailable' }); continue;
    }
    if (onlyDisconnected && Number.isSafeInteger(record.wrapperPid) && record.wrapperPid > 0) {
      try { process.kill(record.wrapperPid, 0); continue; }
      catch (error) { if (error?.code !== 'ESRCH') continue; }
    }
    const proof = await readStableRegularFile(path.join(target.root, 'runner-completions', `${id}.jsonl`),
      { maxBytes: 16384, requireOwner: true, requireSingleLink: true });
    let events;
    try { if (proof.ok && proof.bytes.at(-1) === 10) events = proof.bytes.toString('utf8').trim().split('\n').map((line) => JSON.parse(line)); } catch { /* retained */ }
    if (!completedRunner(events, record.backend)) { retained.push({ id, code: 'command-tree-not-drained' }); continue; }
    /** @type {string|null} */
    let issue = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      const current = await inspectWorktreeOwnership(cwd);
      const session = current._record?.managed?.sessions.find((item) => item.id === id);
      if (!session) {
        if (current.state === 'unclaimed' || current._record) { recovered.push({ id, alreadyClosed: true }); break; }
        issue = 'session-state-unavailable'; break;
      }
      if (!authenticSession(session, record.credential) || session.kind !== 'runner'
        || session.buffers.length || session.pending.some((item) => item.id !== 'command' || item.kind !== 'command-tree')) {
        issue = 'session-changed'; break;
      }
      const event = session.pending.length ? { type: 'operation-finish', operationId: 'command' }
        : session.phase === 'active' ? { type: 'drain' } : { type: 'finish' };
      const result = await updateWorktreeSession(cwd, record.credential, { ...event, sequence: session.sequence + 1 });
      if (result.ok && result.closed) { recovered.push({ id, exitCode: events.at(-1).exitCode }); break; }
      if (!result.ok && !['busy', 'sequence-mismatch'].includes(result.code)) { issue = result.code; break; }
      if (attempt === 11) issue = 'recovery-busy';
    }
    if (issue) retained.push({ id, code: issue });
    else if (recovered.some((item) => item.id === id)) {
      // Keep the exact receipt and completion proof discoverable before retiring the live entry.
      await writePrivateFileAtomic(path.join(target.root, 'runner-recoveries', `${id}.json`),
        Buffer.from(JSON.stringify({ version: 1, record, events, recoveredAt: new Date().toISOString() }) + '\n'));
      await fs.unlink(path.join(target.root, 'runners', name)).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
      await syncPrivateDirectory(path.join(target.root, 'runners'));
    }
  }
  return { ok: true, recovered, retained, omitted: names.length > 128 };
}
