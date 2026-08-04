// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — path comparison that survives macOS and Windows.
 *
 * THIS MODULE EXISTS BECAUSE THE SAME DEFECT SHIPPED THREE TIMES IN ONE DAY, in three different
 * files, each time invisible on Linux and each time caught only by the cross-OS matrix:
 *
 *   src/agent.mjs      `rm -rf <worktree holding the only copy of something>` was ALLOWED on macOS
 *                      and Windows. The core guarantee did not hold on two of three platforms.
 *   test fixtures      a workstream lookup silently matched NOTHING, so four tests asserted
 *                      nothing at all while reporting green.
 *   src/agent.mjs      `mv src/a.js src/b.js` — a rename inside one worktree — was DENIED, which
 *                      is the false positive that gets a guard uninstalled the same day.
 *
 * One cause each time: `path.resolve()` makes a path absolute but does NOT resolve symlinks, and
 * it does not fold case. On macOS `os.tmpdir()` is /var/folders/... while git reports the real
 * /private/var/folders/...; on Windows a temp path arrives as an 8.3 short name and the
 * filesystem is case-insensitive. Linux has neither, which is exactly why every instance passed
 * there and only there.
 *
 * Fixing it three times in three files is fixing instances. The class only closes when there is
 * ONE way to compare paths in this codebase and it is correct.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/** Windows and macOS default to case-insensitive filesystems; Linux does not. */
export const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

export const foldCase = (p) => (CASE_INSENSITIVE_FS ? String(p).toLowerCase() : String(p));

/**
 * A path argument that cannot be evaluated as a path. Typed and thrown, never returned, because
 * the alternative — handing back something path-SHAPED for input that was not a path — is the
 * defect this whole module exists to stop: every caller downstream then compares, joins and
 * containment-checks a value that never denoted a location, and each of those answers looks like
 * a real answer.
 */
export class PathBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PathBoundaryError';
    /** @type {string} */
    this.code = 'EPATHBOUNDARY';
  }
}

/**
 * The one thing `path.resolve` will happily do that it must not: build a path around a NUL.
 *
 * A NUL byte terminates the string at the syscall boundary while JavaScript keeps counting past
 * it, so `<repo>\0/etc/shadow` compares, folds and prefix-tests as a path under `<repo>` and then
 * reaches the filesystem as `<repo>`. That is a containment check that says yes about one path
 * while the kernel acts on another — a genuinely different location, agreed to by every helper
 * below. Node's own fs layer rejects it (ERR_INVALID_ARG_VALUE); path.resolve does not, and
 * canonicalPath's "the ancestry does not exist, hand the string back" branch swallowed the
 * evidence. So the check is here, at the point every comparison starts.
 */
export function assertUsablePath(value, label = 'path') {
  if (typeof value !== 'string') {
    throw new PathBoundaryError(`${label} must be a string path, got ${value === null ? 'null' : typeof value}`);
  }
  if (value.length === 0) throw new PathBoundaryError(`${label} must not be empty`);
  if (value.includes('\0')) throw new PathBoundaryError(`${label} contains a NUL byte, which cannot denote a location`);
  return value;
}

/**
 * The canonical absolute location of a path, whether or not it exists yet.
 *
 * A path that does not exist STILL HAS a canonical location, and returning the raw string for it
 * was a live false positive: a move DESTINATION never exists yet, so the source canonicalised to
 * /private/var/... while the destination stayed /var/..., they landed in different worktrees, and
 * an ordinary rename looked like a move out of one. So the nearest EXISTING ancestor is resolved
 * and the remainder re-appended.
 */
export async function canonicalPath(p) {
  assertUsablePath(p, 'path');
  const abs = path.resolve(p);
  try { return await fs.realpath(abs); } catch { /* does not exist yet — resolve its ancestry */ }

  const parts = [];
  let dir = abs;
  for (let i = 0; i < 64; i++) {
    const parent = path.dirname(dir);
    if (parent === dir) break;                 // reached the root with nothing real on the way
    parts.unshift(path.basename(dir));
    dir = parent;
    try {
      return path.join(await fs.realpath(dir), ...parts);
    } catch { /* keep walking up */ }
  }
  return abs;                                   // nothing in the ancestry exists; nothing to compare to
}

/** Are these the same location? Canonicalises both sides — never compare raw strings. */
export async function samePathAsync(a, b) {
  if (!a || !b) return false;
  return foldCase(await canonicalPath(a)) === foldCase(await canonicalPath(b));
}

/** Is `child` the same as `parent`, or inside it? Canonicalises both sides. */
export async function underOrEqualAsync(child, parent) {
  if (!child || !parent) return false;
  const c = foldCase(await canonicalPath(child));
  const q = foldCase(await canonicalPath(parent));
  return c === q || c.startsWith(q.endsWith(path.sep) ? q : q + path.sep);
}

/**
 * Find the entry in `items` whose `.path` is this directory. The lookup every caller was writing
 * by hand with `path.resolve(x) === path.resolve(y)` — which returns undefined on macOS and
 * Windows, and then quietly reports whatever "no match" means in that caller's context.
 */
export async function findByPath(items, dir, key = 'path') {
  if (!dir) return undefined;
  const want = foldCase(await canonicalPath(dir));
  for (const it of items ?? []) {
    if (!it?.[key]) continue;
    if (foldCase(await canonicalPath(it[key])) === want) return it;
  }
  return undefined;
}

/**
 * The path of `abs` relative to `root`, with BOTH SIDES CANONICALISED FIRST.
 *
 * `path.relative` is arithmetic on strings, so it is exactly as wrong as a raw comparison when the
 * two sides came from different sources — and they routinely do here: git reports a worktree at
 * /private/var/folders/... on macOS while mkdtemp handed the caller /var/folders/..., and
 * path.relative dutifully produced `../../../../../../../var/folders/...`. That string was then
 * handed to `git add`, which indexed nothing, and the operation refused with "not captured".
 *
 * It is the same class the rest of this module exists to close, and the guard test did not catch
 * it because path.relative is not a COMPARISON — which is why this helper exists rather than a
 * note telling the next person to remember.
 *
 * Returns POSIX-separated, because every consumer hands the result to git.
 */
export async function relativeWithinAsync(root, abs) {
  const [a, b] = await Promise.all([canonicalPath(root), canonicalPath(abs)]);
  return path.relative(a, b).split(path.sep).join('/');
}

/**
 * The SYNCHRONOUS forms, for callers that have ALREADY canonicalised both sides.
 *
 * They exist so src/agent.mjs can stop keeping its own private copy of this logic. A second copy
 * of a rule drifts, and the guard test that keeps path comparison honest greps for the RAW form —
 * so a faithful re-implementation in another file was invisible to it, which is precisely how
 * this class keeps surviving.
 *
 * These do NOT canonicalise. Handing them raw paths is the original bug; the async forms above
 * are what you want unless you are comparing two values you canonicalised yourself.
 */
export const samePathSync = (a, b) => foldCase(a) === foldCase(b);

export const underOrEqualSync = (child, parent) => {
  const c = foldCase(child);
  const q = foldCase(parent);
  return c === q || c.startsWith(q.endsWith(path.sep) ? q : q + path.sep);
};

/**
 * Like relativeWithinAsync, but the FINAL component is never followed.
 *
 * canonicalPath resolves symlinks all the way down, which is exactly right when you are asking
 * "is this path inside that worktree" and exactly wrong when you are asking "which entry did the
 * user name". `holt discard link.txt` on a symlink resolved to the link's TARGET, captured the
 * target, and wrote the target's committed content back over it — destroying the target's
 * uncommitted work while leaving the symlink the user actually named untouched.
 *
 * So the directory is canonicalised (which is what fixes /var vs /private/var) and the basename
 * is appended verbatim (which is what preserves the identity of the thing named).
 */
export async function relativeLinkAwareAsync(root, abs) {
  const [r, dir] = await Promise.all([canonicalPath(root), canonicalPath(path.dirname(abs))]);
  return path.relative(r, path.join(dir, path.basename(abs))).split(path.sep).join('/');
}

/**
 * NETWORK FILESYSTEM DETECTION — NFS/SMB latency handling.
 *
 * WHY THIS EXISTS. holt's git operations assume local-disk latency: a `git status` that takes
 * 30s on an NFS mount times out at the default 30s ceiling and reads as "instrument failed",
 * which fail-closed classification turns into "refusing to classify" — the right safety call,
 * but a call the user never needed to make, because the repository is fine and only the mount
 * is slow. A stale read on SMB (the working copy cached while the server's copy moved on) is
 * the other half: holt reports a delta that no longer exists. Neither is a defect holt can fix,
 * but both are defects holt can NAME, so the user knows the verdict came through a slow link
 * rather than from the repository itself.
 *
 * DETECTION is best-effort and never throws: a mount table that cannot be read yields
 * `{ network: false, reason: 'unreadable' }`, which is the safe default (treat as local) —
 * because refusing to scan a local disk we misclassified as networked is the same class of
 * false positive this whole module exists to close.
 *
 * On Linux, `/proc/mounts` is the kernel's own mount table and is always present. On macOS,
 * `mount` output carries the type (`nfs`, `smbfs`, `cifs`). On Windows, `net use` lists SMB
 * shares; NFS is rare there and reported the same way. A path is on a network filesystem when
 * its canonical location is UNDER a mount whose type is one of the known network types.
 */
const NETWORK_FS_TYPES = new Set([
  'nfs', 'nfs4', 'smbfs', 'cifs', 'smb2', 'smb3', 'fuse.sshfs', 'fuse.osxfs',
  'afp', 'afpfs', 'webdav', 'davfs',
]);

/**
 * Read the system mount table as a list of { device, mountPoint, type, opts }.
 *
 * Best-effort: returns [] when the table cannot be read (non-Linux without `mount`, a
 * containerised environment with no mounts, a permission error). Callers treat [] as "no
 * network mounts detected", which is the safe default — see the note above.
 */
async function readMounts() {
  // Linux: /proc/mounts is the kernel's own view, always present and always readable.
  if (process.platform === 'linux') {
    try {
      const raw = await fs.readFile('/proc/mounts', 'utf8');
      return raw.split('\n').filter(Boolean).map((line) => {
        const [device, mountPoint, type, opts] = line.split(/\s+/);
        return { device, mountPoint: mountPoint ? decodeURIComponent(mountPoint) : '', type, opts };
      });
    } catch { /* unreadable — fall through to the `mount` command */ }
  }
  // macOS / other Unix: `mount` prints `device on mountPoint (type, opts)`.
  try {
    const { execFile } = await import('node:child_process');
    const out = await new Promise((resolve) => {
      execFile('mount', [], { timeout: 5000 }, (err, stdout) => resolve(err ? '' : String(stdout)));
    });
    return out.split('\n').filter(Boolean).map((line) => {
      // `device on /mount/point (nfs, nodev, nosuid)`  or  `//server/share on /mnt (smbfs,...)`
      const m = line.match(/^(.*?)\s+on\s+(.*?)\s+\(([^,)]+)/);
      if (!m) return { device: '', mountPoint: '', type: '', opts: '' };
      return { device: m[1], mountPoint: decodeURIComponent(m[2]), type: m[3], opts: '' };
    });
  } catch { return []; }
}

/**
 * Is `p` on a network filesystem (NFS/SMB/SSHFS/WebDAV/AFS)?
 *
 * Canonicalises `p` first, then checks whether any network-typed mount is an ancestor of it.
 * Returns `{ network: boolean, type?: string, mountPoint?: string, reason?: string }`.
 *
 * Never throws: an unreadable mount table yields `{ network: false, reason: 'mount-table-unreadable' }`.
 * The safe default is "treat as local" — a false "network" would refuse to scan a local disk,
 * which is the same class of false positive this module exists to close.
 *
 * @param {string} p
 */
export async function detectNetworkFilesystem(p) {
  assertUsablePath(p, 'path');
  let canon;
  try { canon = await canonicalPath(p); } catch { canon = path.resolve(p); }
  const mounts = await readMounts();
  if (!mounts.length) return { network: false, reason: 'mount-table-unreadable' };

  // Find the longest mount point that is an ancestor of (or equal to) the canonical path.
  // A path under /mnt/nfs/projects/repo is on the /mnt/nfs mount, not on /.
  /** @type {{device:string, mountPoint:string, type:string, opts:string}|null} */
  let best = null;
  const folded = foldCase(canon);
  for (const m of mounts) {
    if (!m.mountPoint) continue;
    const mp = foldCase(m.mountPoint);
    const prefix = mp.endsWith(path.sep) ? mp : mp + path.sep;
    if (folded === mp || folded.startsWith(prefix)) {
      if (!best || m.mountPoint.length > best.mountPoint.length) best = m;
    }
  }
  if (!best) return { network: false };
  if (NETWORK_FS_TYPES.has(String(best.type).toLowerCase())) {
    return { network: true, type: best.type, mountPoint: best.mountPoint };
  }
  return { network: false, type: best.type, mountPoint: best.mountPoint };
}

/**
 * A human-readable warning for when a network filesystem is detected.
 *
 * Exported so the CLI and the scan can surface the SAME text, rather than each deriving its
 * own — a second copy of a warning drifts, and the scan's "this came through a slow link"
 * caveat is the one a user acts on.
 *
 * @param {{ type?: string, mountPoint?: string }} info  from detectNetworkFilesystem()
 */
export function networkFilesystemWarning(info) {
  const where = info?.mountPoint ? ` (mount: ${info.mountPoint}, type: ${info.type ?? 'unknown'})` : '';
  return `holt: this path is on a network filesystem${where}. git operations may time out or ` +
    'produce stale reads; verdicts through a slow link are less reliable than local-disk ones. ' +
    'If a scan fails with an instrument error, re-run from a local checkout.';
}
