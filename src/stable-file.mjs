// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * Descriptor-bound filesystem primitives for decision-critical local state.
 *
 * A path check followed by readFile(path) is two different filesystem observations. Between them,
 * a concurrent process can replace the leaf with a symlink or a different same-size file. These
 * helpers bind the pathname, open descriptor, bytes, and final pathname to one regular-file
 * identity. A race becomes an explicit unavailable result, never invented evidence.
 */

import fs, { constants as FS } from 'node:fs/promises';
import { constants as FSC } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const NOFOLLOW = FSC.O_NOFOLLOW ?? 0;
const NONBLOCK = FSC.O_NONBLOCK ?? 0;
const identity = (a, b) => a && b
  && String(a.dev) === String(b.dev)
  && String(a.ino) === String(b.ino)
  && a.size === b.size
  && a.mtimeMs === b.mtimeMs
  && a.ctimeMs === b.ctimeMs;

const ownedByProcess = (stat) => typeof process.getuid !== 'function' || stat.uid === process.getuid();

/**
 * Read one regular file through a stable descriptor and re-bind the final pathname.
 * @param {string} file
 * @param {{maxBytes?:number, requireSingleLink?:boolean, requireOwner?:boolean}} [opts]
 * @returns {Promise<{ok:true,bytes:Buffer,stat:import('node:fs').Stats}|{ok:false,reason:string,code?:string}>}
 */
export async function readStableRegularFile(file, {
  maxBytes = Number.MAX_SAFE_INTEGER, requireSingleLink = false, requireOwner = false,
} = {}) {
  let handle;
  // O_NONBLOCK is not a performance flag here. Opening a FIFO read-only waits for a writer before
  // fstat can tell us that the node was never a regular file. A hostile repository could
  // therefore hang every caller at the type-check boundary. Regular-file reads are unchanged;
  // special nodes become inspectable descriptors that are refused below.
  try { handle = await fs.open(file, FSC.O_RDONLY | NOFOLLOW | NONBLOCK); } catch (error) {
    if (error?.code === 'ELOOP') return { ok: false, reason: 'not-regular-file', code: error.code };
    return { ok: false, reason: 'open-failed', code: error?.code };
  }
  try {
    const before = await handle.stat();
    let pathBefore;
    try { pathBefore = await fs.lstat(file); } catch (error) {
      return { ok: false, reason: 'path-unavailable', code: error?.code };
    }
    // Open first, then compare the descriptor to the pathname. O_NOFOLLOW blocks a symlink at
    // open time where the platform supports it; the lstat identity comparison closes the same
    // boundary on platforms where that flag is unavailable. There is no check-then-open window.
    if (!before.isFile() || !pathBefore.isFile() || pathBefore.isSymbolicLink()) {
      return { ok: false, reason: 'not-regular-file' };
    }
    if (!identity(pathBefore, before)) return { ok: false, reason: 'changed-before-read' };
    if (requireOwner && !ownedByProcess(before)) return { ok: false, reason: 'foreign-owner' };
    if (requireSingleLink && before.nlink !== 1) return { ok: false, reason: 'multiple-hardlinks' };
    if (before.size > maxBytes) return { ok: false, reason: 'too-large' };
    const bytes = await handle.readFile();
    const after = await handle.stat();
    let pathAfter;
    try { pathAfter = await fs.lstat(file); } catch {
      return { ok: false, reason: 'path-disappeared-after-read' };
    }
    if (!identity(before, after) || !identity(after, pathAfter)
      || !pathAfter.isFile() || pathAfter.isSymbolicLink() || bytes.length !== after.size) {
      return { ok: false, reason: 'changed-during-read' };
    }
    return { ok: true, bytes, stat: after };
  } catch (error) {
    return { ok: false, reason: 'read-failed', code: error?.code };
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Create or verify one process-owned 0700 directory without accepting a symlink. */
export async function ensurePrivateDirectory(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`private state path is not a real directory: ${dir}`);
  if (!ownedByProcess(stat)) throw new Error(`private state directory has a foreign owner: ${dir}`);
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    await fs.chmod(dir, 0o700);
    const tightened = await fs.lstat(dir);
    if (!tightened.isDirectory() || tightened.isSymbolicLink() || (tightened.mode & 0o077) !== 0) {
      throw new Error(`private state directory permissions could not be tightened: ${dir}`);
    }
  }
  return dir;
}

/** Publish one private file through a unique 0600 sibling and an atomic rename. */
export async function writePrivateFileAtomic(file, bytes) {
  const dir = await ensurePrivateDirectory(path.dirname(file));
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temp, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | NOFOLLOW, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temp, file);
    const published = await fs.lstat(file);
    if (!published.isFile() || published.isSymbolicLink() || !ownedByProcess(published)) {
      throw new Error(`published state is not one owned regular file: ${file}`);
    }
    if (process.platform !== 'win32' && (published.mode & 0o077) !== 0) await fs.chmod(file, 0o600);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}
