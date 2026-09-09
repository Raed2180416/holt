// SPDX-License-Identifier: FSL-1.1-MIT
/** Private, immutable editor recovery objects. They never save over a user's working file. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ensurePrivateDirectory, readStableRegularFile, syncPrivateDirectory } from './stable-file.mjs';
import { sessionPath, sessionText } from './sessions.mjs';

export const BUFFER_MAX_CODE_UNITS = 4 * 1024 * 1024;
const MAX_OBJECT_BYTES = BUFFER_MAX_CODE_UNITS * 6 + 8192;
const SHA256 = /^[0-9a-f]{64}$/;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** JS text is hashed as UTF-16 code units, preserving lone surrogates and every line ending. */
export function bufferTextDigest(text) { return sha256(Buffer.from(text, 'utf16le')); }

function validSnapshot(snapshot) {
  return snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
    && Object.keys(snapshot).sort().join(',') === 'bufferPath,encoding,text,version'
    && snapshot.version === 1 && sessionPath(snapshot.bufferPath)
    && (snapshot.encoding === null || sessionText(snapshot.encoding, 64))
    && typeof snapshot.text === 'string' && snapshot.text.length <= BUFFER_MAX_CODE_UNITS;
}

/** @param {string} root @param {string} ref */
export async function readBufferSnapshot(root, ref) {
  if (!SHA256.test(ref)) return { ok: false, code: 'invalid-buffer-reference' };
  const stored = await readStableRegularFile(path.join(root, 'buffers', `${ref}.json`), {
    maxBytes: MAX_OBJECT_BYTES, requireOwner: true, requireSingleLink: true,
  });
  if (!stored.ok) return { ok: false, code: 'buffer-unavailable', reason: stored.reason };
  if (sha256(stored.bytes) !== ref) return { ok: false, code: 'buffer-integrity-failed' };
  try {
    const snapshot = JSON.parse(stored.bytes.toString('utf8'));
    if (!validSnapshot(snapshot)) return { ok: false, code: 'invalid-buffer-object' };
    return { ok: true, snapshot, digest: bufferTextDigest(snapshot.text) };
  } catch { return { ok: false, code: 'invalid-buffer-object' }; }
}

/**
 * Publish a content-addressed object with an exclusive hard-link, so neither a concurrent
 * capture nor a corrupted existing object can be overwritten. No shared refs name the object
 * until its complete bytes have been synced and the temporary link has been removed.
 * @param {string} root
 * @param {{bufferPath:string,text:string,encoding?:string|null}} options
 */
export async function storeBufferSnapshot(root, { bufferPath, text, encoding = null }) {
  const snapshot = { version: 1, bufferPath, encoding, text };
  if (!validSnapshot(snapshot)) return { ok: false, code: 'invalid-buffer-snapshot' };
  const bytes = Buffer.from(JSON.stringify(snapshot) + '\n', 'utf8');
  const ref = sha256(bytes);
  const dir = await ensurePrivateDirectory(path.join(root, 'buffers'));
  const file = path.join(dir, `${ref}.json`);
  const existing = await readBufferSnapshot(root, ref);
  if (existing.ok) return { ok: true, recoveryRef: ref, digest: existing.digest };
  const temp = path.join(dir, `.${randomUUID()}.tmp`);
  const handle = await fs.open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    try { await fs.link(temp, file); } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  } finally {
    await handle.close().catch(() => {});
    await fs.unlink(temp).catch(() => {});
  }
  const verified = await readBufferSnapshot(root, ref);
  if (!verified.ok) return verified;
  await syncPrivateDirectory(dir);
  return { ok: true, recoveryRef: ref, digest: verified.digest };
}

/**
 * Recover the exact text to a new file chosen by the caller. The exclusive create is the final
 * authority: existing files and symlinks are never overwritten. JSON also preserves malformed
 * Unicode code units that could not be faithfully represented in a plain UTF-8 file.
 */
export async function recoverBufferSnapshot(root, ref, destination) {
  const stored = await readBufferSnapshot(root, ref);
  if (!stored.ok || !stored.snapshot) return stored;
  if (!path.isAbsolute(destination)) return { ok: false, code: 'absolute-destination-required' };
  let handle;
  try {
    handle = await fs.open(destination, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(stored.snapshot, null, 2) + '\n', 'utf8');
    await handle.sync();
    await syncPrivateDirectory(path.dirname(destination));
    return { ok: true, destination, format: 'holt-editor-buffer-json', bufferPath: stored.snapshot.bufferPath };
  } catch (error) {
    return { ok: false, code: error?.code === 'EEXIST' ? 'destination-exists' : 'recovery-write-failed', reason: error.message };
  } finally { await handle?.close().catch(() => {}); }
}
