// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * Durable state for an interrupted `holt discard`.
 *
 * A capture ref protects bytes after Git has accepted them, but it cannot explain which of many
 * same-parent quarantines were restored, conflicted, or still need physical reconciliation after
 * a process dies. These receipts live in the repository's shared Git state, never in a worktree,
 * and are published as private regular files through an fsync + atomic rename boundary.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { git } from './git.mjs';
import {
  ensurePrivateDirectory, readStableRegularFile, writePrivateFileAtomic,
} from './stable-file.mjs';
import { samePathSync } from './paths.mjs';

const VERSION = 1;
const MAX_RECEIPT_BYTES = 128 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9._-]{1,200}$/;
const QUARANTINE_LEAF_RE = /^\.holt-discard-\d+-[0-9a-f]{16}$/;
const PHASES = new Set(['planned', 'quarantined', 'captured', 'pending', 'rollback-pending']);

async function commonDir(cwd) {
  const r = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd })
    .catch(() => null);
  const dir = r?.code === 0 ? r.stdout.trim() : '';
  if (!dir || !path.isAbsolute(dir)) throw new Error('could not locate the repository Git common directory');
  return dir;
}

async function transactionDir(cwd, { create = false } = {}) {
  // Keep the safety-critical recovery state independent from the best-effort journal namespace.
  // A broken `.git/holt` journal must be reported, but it must not make a capture transaction
  // impossible to publish or recover.
  const dir = path.join(await commonDir(cwd), 'holt-discard-transactions');
  if (create) return ensurePrivateDirectory(dir);
  return dir;
}

function assertId(id) {
  if (!ID_RE.test(String(id ?? ''))) throw new Error('discard transaction id is invalid');
  return String(id);
}

/**
 * @param {any} record
 * @param {string|null} [expectedId]
 */
function assertRecord(record, expectedId = null) {
  if (!record || record.version !== VERSION || record.kind !== 'holt-discard-transaction') {
    throw new Error('discard transaction has an unsupported format');
  }
  assertId(record.id);
  if (!PHASES.has(record.phase)) throw new Error('discard transaction has an invalid phase');
  if (expectedId !== null && record.id !== expectedId) throw new Error('discard transaction id does not match its filename');
  if (!record.worktree || !path.isAbsolute(record.worktree.path)
    || !Array.isArray(record.selections) || record.selections.length === 0) {
    throw new Error('discard transaction is missing its worktree or selections');
  }
  for (const row of record.selections) {
    const pieces = typeof row.relative === 'string' ? row.relative.split('/') : [];
    const leaf = typeof row.path === 'string' ? path.basename(row.path) : '';
    if (!path.isAbsolute(row.path) || pieces.length === 0
      || pieces.some((piece) => piece === '' || piece === '.' || piece === '..')
      || leaf === '' || leaf === '.' || leaf === '..'
      || !row.parentIdentity || !path.isAbsolute(row.parentIdentity.path)
      || !path.isAbsolute(row.parentIdentity.canonical)
      || typeof row.parentIdentity.dev !== 'string' || typeof row.parentIdentity.ino !== 'string'
      || (row.quarantineDir !== null && !path.isAbsolute(row.quarantineDir))
      || (row.payload !== null && !path.isAbsolute(row.payload))) {
      throw new Error('discard transaction contains an unsafe path');
    }
    if ((row.quarantineDir === null) !== (row.payload === null)) {
      throw new Error('discard transaction contains an incomplete quarantine path pair');
    }
    if (row.quarantineDir !== null
      && (!QUARANTINE_LEAF_RE.test(path.basename(row.quarantineDir))
        || !samePathSync(row.payload, path.join(row.quarantineDir, 'payload')))) {
      throw new Error('discard transaction contains an uncontrolled quarantine path');
    }
    if (!Array.isArray(row.manifest) || !Array.isArray(row.emptyDirectories)) {
      throw new Error('discard transaction contains invalid capture evidence');
    }
  }
  return record;
}

async function syncDirectory(dir) {
  let handle;
  try {
    handle = await fs.open(dir, 'r');
    await handle.sync();
  } catch {
    // Windows and some network filesystems do not fsync directory handles. The receipt file itself
    // is still synced; recovery remains conservative if the directory entry was not persisted.
  } finally {
    await handle?.close().catch(() => {});
  }
}

function bytesFor(record) {
  const bytes = Buffer.from(`${JSON.stringify(assertRecord(record))}\n`, 'utf8');
  if (bytes.length > MAX_RECEIPT_BYTES) {
    throw new Error(`discard transaction receipt exceeds ${MAX_RECEIPT_BYTES} bytes`);
  }
  return bytes;
}

async function publishExclusive(file, bytes) {
  const dir = await ensurePrivateDirectory(path.dirname(file));
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temp, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    // link(2) publishes the fully-written inode and fails atomically if the final id already
    // exists. Removing the private temp link leaves the published receipt single-linked.
    await fs.link(temp, file);
    // A recovery reader may remove this same-inode publication link after a process interruption
    // (or in the tiny interval before this line). The final link is already durable content, so a
    // missing temp name is success rather than a reason to report the transaction as unpublished.
    await fs.rm(temp, { force: true });
    await syncDirectory(dir);
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

/**
 * Heal the only ambiguous crash point in exclusive publication: link(final) succeeded but the
 * process died before unlink(temp). The extra link is removable only when its controlled temp
 * name and inode both match the final receipt. Any other hard link remains a hard refusal.
 */
async function repairInterruptedPublish(file) {
  let published;
  try { published = await fs.lstat(file, { bigint: true }); } catch { return; }
  if (!published.isFile() || published.isSymbolicLink() || published.nlink <= 1n) return;

  const dir = path.dirname(file);
  const prefix = `.${path.basename(file)}.`;
  let names;
  try { names = await fs.readdir(dir); } catch { return; }
  let removed = false;
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
    const candidate = path.join(dir, name);
    let observed;
    try { observed = await fs.lstat(candidate, { bigint: true }); } catch { continue; }
    if (!observed.isFile() || observed.isSymbolicLink()
      || observed.dev !== published.dev || observed.ino !== published.ino) continue;
    await fs.rm(candidate, { force: true });
    removed = true;
  }
  if (removed) await syncDirectory(dir);
}

export function newDiscardTransactionId(worktreeId, stamp) {
  const prefix = String(worktreeId ?? 'worktree').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 48) || 'worktree';
  const when = String(stamp ?? new Date().toISOString().replace(/[:.]/g, '-'))
    .replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 48);
  return `${prefix}-${when}-${randomUUID()}`;
}

export async function createDiscardTransaction(cwd, record) {
  const normalized = assertRecord({
    ...record,
    version: VERSION,
    kind: 'holt-discard-transaction',
    createdAt: record.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const dir = await transactionDir(cwd, { create: true });
  const file = path.join(dir, `${assertId(normalized.id)}.json`);
  await publishExclusive(file, bytesFor(normalized));
  return { ...normalized, _file: file };
}

export async function updateDiscardTransaction(cwd, record, patch = {}) {
  const id = assertId(record.id);
  const file = record._file ?? path.join(await transactionDir(cwd, { create: true }), `${id}.json`);
  const next = assertRecord({
    ...record,
    ...patch,
    version: VERSION,
    kind: 'holt-discard-transaction',
    id,
    updatedAt: new Date().toISOString(),
  }, id);
  const publicRecord = { ...next };
  delete publicRecord._file;
  await writePrivateFileAtomic(file, bytesFor(publicRecord));
  await syncDirectory(path.dirname(file));
  return { ...publicRecord, _file: file };
}

export async function readDiscardTransaction(cwd, id) {
  const safeId = assertId(id);
  const file = path.join(await transactionDir(cwd), `${safeId}.json`);
  await repairInterruptedPublish(file);
  const stable = await readStableRegularFile(file, {
    maxBytes: MAX_RECEIPT_BYTES, requireOwner: true, requireSingleLink: true,
  });
  if (!stable.ok) throw new Error(`discard transaction '${safeId}' is unavailable (${stable.reason})`);
  let record;
  try { record = JSON.parse(stable.bytes.toString('utf8')); } catch { throw new Error(`discard transaction '${safeId}' is not valid JSON`); }
  return { ...assertRecord(record, safeId), _file: file };
}

export async function listDiscardTransactionRecords(cwd) {
  let dir;
  try { dir = await transactionDir(cwd); } catch (error) {
    return { transactions: [], errors: [{ id: null, error: error?.message ?? String(error) }] };
  }
  let names;
  try { names = await fs.readdir(dir); } catch (error) {
    if (error?.code === 'ENOENT') return { transactions: [], errors: [] };
    return { transactions: [], errors: [{ id: null, error: error?.message ?? String(error) }] };
  }
  const transactions = [];
  const errors = [];
  for (const name of names.filter((entry) => entry.endsWith('.json')).sort()) {
    const id = name.slice(0, -'.json'.length);
    try { transactions.push(await readDiscardTransaction(cwd, id)); } catch (error) {
      errors.push({ id, error: error?.message ?? String(error) });
    }
  }
  return { transactions, errors };
}

export async function removeDiscardTransaction(cwd, record) {
  const id = assertId(record.id);
  const file = record._file ?? path.join(await transactionDir(cwd), `${id}.json`);
  await fs.rm(file, { force: false });
  await syncDirectory(path.dirname(file));
}
