/**
 * holt — the install receipt: what holt CREATED, recorded rather than inferred.
 *
 * WHY THIS EXISTS. `uninstall` has to answer one question: "is this file mine to delete?" Until
 * now it answered by INSPECTING THE RESIDUE — if what remains of `.cursor/hooks.json` is
 * `{"version": 1}`, that must be holt's default; if AGENTS.md is byte-identical to holt's
 * preamble, that must be holt's stub. Both inferences are wrong in the same way, and both were
 * reproduced destroying real files:
 *
 *   - a user's own, git-tracked `.cursor/hooks.json` containing exactly `{"version": 1}` was
 *     deleted, because `installCursorHooks` does `cfg.version ??= 1` — a no-op when the user
 *     already set it, which leaves holt no trace to distinguish its own default from theirs
 *   - a user's own, git-tracked `AGENTS.md` byte-identical to holt's 75-byte preamble was deleted
 *
 * Both arrive by clone. Both are ordinary. And the earlier, opposite bug — leftovers that made a
 * fully-uninstalled repo self-detect 13 hosts — came from the same root: nothing recorded what
 * holt had actually done, so both halves of the lifecycle were left guessing.
 *
 * SO STOP GUESSING. `integrate` writes down every path it CREATED (not merely edited), with the
 * content hash it left behind. `uninstall` deletes a path only when the receipt says holt created
 * it AND the bytes are still the ones holt wrote. Anything else — a file holt only edited, a file
 * holt created that the user has since changed, a file with no receipt entry at all — is the
 * user's, and holt strips its own block and leaves the file.
 *
 * WHERE IT LIVES. `<git-common-dir>/holt/install-receipt.json`, beside the journal. NOT in the
 * working tree: it must never appear in `git status`, never be committed, never be something a
 * user has to gitignore, and never be a file whose own removal needs a rule. Being outside the
 * tree also means a `git clean -fdx` cannot silently strip holt's memory of what it owns.
 *
 * FAILURE POLICY. A receipt that cannot be read is NOT an empty receipt. "holt could not look" and
 * "holt created nothing" are different answers, and conflating them is what turns this file into
 * the next over-deletion: an unreadable receipt would make every path look un-owned, which is the
 * safe direction here (nothing gets deleted), so the read returns `null` and callers must treat
 * `null` as "delete nothing", never as "delete everything".
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { constants as FSC } from 'node:fs';
import { ensurePrivateDirectory, readStableRegularFile } from '../stable-file.mjs';
import { execFile } from 'node:child_process';

const RECEIPT_VERSION = 3;
const NOFOLLOW = FSC.O_NOFOLLOW ?? 0;

const emptyReceipt = () => ({ version: RECEIPT_VERSION, created: {}, shared: {}, dirs: [] });

function normalizedReceipt(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    version: Number(value.version) || RECEIPT_VERSION,
    created: (value.created && typeof value.created === 'object') ? value.created : {},
    shared: (value.shared && typeof value.shared === 'object') ? value.shared : {},
    dirs: Array.isArray(value.dirs) ? value.dirs : [],
  };
}

function receiptFromBytes(bytes) {
  try {
    return normalizedReceipt(JSON.parse(Buffer.from(bytes).toString('utf8')));
  } catch {
    return null;
  }
}

function commonDir(cwd) {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, timeout: 10_000 },
      (err, stdout) => resolve(err ? null : String(stdout).trim() || null));
  });
}

function gitDir(cwd) {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', '--path-format=absolute', '--git-dir'], { cwd, timeout: 10_000 },
      (err, stdout) => resolve(err ? null : String(stdout).trim() || null));
  });
}

/**
 * Stable-enough namespace for one worktree within its shared receipt. Main is `main`; linked
 * worktrees use Git's common-dir-relative administrative path (`worktrees/<id>`). The token is not
 * deletion evidence by itself — inode/content still must match — but it lets a reinstall replace
 * this worktree's prior identity without erasing identities belonging to sibling worktrees.
 */
async function worktreeReceiptKey(cwd) {
  const [common, git] = await Promise.all([commonDir(cwd), gitDir(cwd)]);
  if (!common || !git) return null;
  const rel = path.relative(path.resolve(common), path.resolve(git));
  if (rel === '') return 'main';
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/** The receipt's location, or null when this is not a git repository holt can address. */
export async function receiptPath(repoRoot) {
  const common = await commonDir(repoRoot);
  return common ? path.join(common, 'holt', 'install-receipt.json') : null;
}

/** sha256 of a file's bytes, or null if it cannot be read (absent, unreadable, a directory). */
export async function fileHash(abs) {
  try {
    return createHash('sha256').update(await fs.readFile(abs)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Read the receipt.
 * A `created` entry is a LIST of accepted hashes; receipts written before that change carry a bare
 * string, and both forms are read everywhere (see recordCreated and ownershipOf).
 *
 * @returns {Promise<{version: number, created: Record<string, any>, shared: Record<string, any>, dirs: string[]}|null>}
 *   `null` means holt could not read it — which callers MUST treat as "own nothing", not "own all".
 */
export async function readReceipt(repoRoot) {
  const p = await receiptPath(repoRoot);
  // NOT A GIT REPOSITORY IS NOT "COULD NOT LOOK". There is no receipt here and there never could
  // be one, so holt knows exactly as much as it would from an empty receipt: it created nothing
  // recorded. Returning `null` here instead conflated "nowhere to keep a receipt" with "a receipt
  // I could not parse", and that froze uninstall in plain directories — a regression caught by
  // two pre-existing tests that uninstall from a non-git temp dir.
  if (!p) return emptyReceipt();
  let raw;
  try {
    raw = await fs.readFile(p, 'utf8');
  } catch (e) {
    // ENOENT is a real answer: holt has never installed here, so it created nothing. Any other
    // error is "could not look", and must not be reported as an empty receipt.
    if (e && e.code === 'ENOENT') return emptyReceipt();
    return null;
  }
  // Corrupt JSON is "could not look". Deleting on a guess is exactly what this file prevents.
  return receiptFromBytes(raw);
}

/**
 * Record paths holt CREATED during an install.
 *
 * Merges into whatever is already there — integrate is re-run routinely, and a second run that
 * creates one new file must not erase the record of the first run's five.
 *
 * Current callers must provide the exact publication token returned by the file transaction.
 * Bare string paths are retained in the accepted input shape only so an older caller fails closed
 * (`false`) instead of being silently upgraded through a pathname re-read.
 *
 * @param {string} repoRoot
 * @param {{files?: Array<string|{path:string,token:any}>, dirs?: string[],
 *   onBeforeReceiptMutation?:((details:{file:string,action:'create'|'replace'|'delete'})=>any)|null,
 *   onAfterReceiptPublish?:(()=>any)|null}} made
 */
export async function recordCreated(repoRoot, {
  files = [], dirs = [], onBeforeReceiptMutation = null, onAfterReceiptPublish = null,
} = {}) {
  const records = files.flatMap((entry) => (
    entry && typeof entry === 'object' && typeof entry.path === 'string'
      ? [{ path: entry.path, token: entry.token }]
      : []
  ));
  // Never reconstruct deletion authority from a later pathname read. If any caller omitted the
  // commit token, publish nothing — a partial receipt is more dangerous than a failed install.
  if (records.length !== files.length || records.some(({ token }) => !projectTokenShape(token))) {
    return false;
  }
  const verify = () => verifyProjectCreationRecords(repoRoot, records);
  return publishReceiptUpdate(repoRoot, (existing) => {
    const created = { ...existing.created };
    for (const { path: rel, token } of records) {
      const prior = Array.isArray(existing.created?.[rel])
        ? existing.created[rel]
        : (existing.created?.[rel] ? [existing.created[rel]] : []);
      // Keep legacy hashes readable for risk/reproducibility classification, but they no longer
      // authorise deletion. Among current identity entries retain siblings and replace exactly
      // this worktree's prior identity, so linked worktrees coexist without accumulating stale
      // deletion authority for repeated installs in one tree.
      created[rel] = [
        ...prior.filter((entry) => typeof entry === 'string'
          || !entry || typeof entry !== 'object' || entry.worktree !== token.worktree),
        token,
      ];
    }
    return {
      version: RECEIPT_VERSION,
      created,
      shared: existing.shared ?? {},
      dirs: [...new Set([...existing.dirs, ...dirs])],
    };
  }, {
    verify,
    onBeforeMutation: onBeforeReceiptMutation,
    onAfterPublish: onAfterReceiptPublish,
  });
}

const sameInode = (left, right) => left && right
  && String(left.dev) === String(right.dev)
  && String(left.ino) === String(right.ino);
// rename changes ctime on common filesystems, so ctime cannot survive the retirement primitive.
// mtime, size, mode and ownership do survive it and expose a same-inode rewrite/chmod that a
// byte-only comparison can miss (notably a concurrent idempotent receipt publication).
const sameRetiredObservation = (left, right) => sameInode(left, right)
  && Number(left.size) === Number(right.size)
  && Number(left.mtimeMs) === Number(right.mtimeMs)
  && Number(left.mode) === Number(right.mode)
  && String(left.uid) === String(right.uid)
  && String(left.gid) === String(right.gid)
  && Number(left.nlink) === Number(right.nlink);
const hashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
const identityToken = (sha256, stat) => ({
  sha256,
  dev: String(stat.dev),
  ino: String(stat.ino),
  size: Number(stat.size),
  ctimeMs: Number(stat.ctimeMs),
});
const projectIdentityToken = (sha256, stat, worktree) => ({
  ...identityToken(sha256, stat),
  worktree,
});
const tokenMatches = (token, sha256, stat) => !!token
  && token.sha256 === sha256
  && token.dev === String(stat.dev)
  && token.ino === String(stat.ino)
  && token.size === Number(stat.size)
  && token.ctimeMs === Number(stat.ctimeMs);
const projectTokenShape = (token) => !!token
  && typeof token === 'object'
  && typeof token.worktree === 'string'
  && token.worktree.length > 0
  && typeof token.sha256 === 'string'
  && typeof token.dev === 'string'
  && typeof token.ino === 'string'
  && Number.isFinite(token.size)
  && Number.isFinite(token.ctimeMs);
const projectTokenMatches = (token, observation) => projectTokenShape(token)
  && observation?.state === 'present'
  && token.worktree === observation.worktree
  && tokenMatches(token, observation.sha256, observation.stat);
// Shared-file ownership was introduced together with v2 identity receipts; no released v1
// receipt contained this namespace. A bare legacy/content hash is therefore evidence of bytes,
// not authority over the current inode, and must fail closed instead of being "upgraded" by use.
const receiptEntryMatches = (entry, sha256, stat) => !!entry
  && typeof entry === 'object'
  && tokenMatches(entry, sha256, stat);

/** Create one shared regular file exclusively and return the exact identity Holt authored. */
export async function createSharedRegularFileExclusive(absPath, bytes, { mode = 0o755 } = {}) {
  let handle;
  try {
    // Do not make a partially-written program executable. The descriptor starts private and
    // non-executable; only complete, synced bytes receive the requested final mode.
    handle = await fs.open(absPath, FSC.O_WRONLY | FSC.O_CREAT | FSC.O_EXCL | NOFOLLOW, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    if (process.platform !== 'win32') await handle.chmod(mode);
    await handle.sync();
    const stat = await handle.stat();
    const pathStat = await fs.lstat(absPath);
    if (!stat.isFile() || !pathStat.isFile() || pathStat.isSymbolicLink()
      || !sameInode(stat, pathStat)) {
      throw new Error('created shared file identity changed before publication');
    }
    return identityToken(hashBytes(Buffer.from(bytes)), stat);
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Record a generated file that lives in repository-shared Git state rather than one worktree.
 * The receipt binds the exact creation inode as well as bytes. A later same-byte replacement is
 * another file and cannot inherit deletion authority.
 */
export async function recordSharedCreated(repoRoot, key, absPath, expectedToken) {
  const exactRecord = identityToken(expectedToken?.sha256, expectedToken ?? {});
  if (!tokenMatches(expectedToken, exactRecord.sha256, expectedToken ?? {})) return false;
  const verify = async () => {
    const observed = await readStableRegularFile(absPath, {
      maxBytes: 1024 * 1024,
      requireSingleLink: true,
      requireOwner: true,
    });
    return observed.ok && tokenMatches(exactRecord, hashBytes(observed.bytes), observed.stat);
  };
  return publishReceiptUpdate(repoRoot, (existing) => ({
      version: RECEIPT_VERSION,
      created: existing.created ?? {},
      shared: {
        ...(existing.shared ?? {}),
        // A shared pathname has one active inode. Retaining prior inode identities expands
        // deletion authority without helping the current file.
        [key]: exactRecord,
      },
      dirs: existing.dirs ?? [],
    }), { verify });
}

/** True only when this receipt owns the exact current bytes of a shared generated file. */
export async function holtOwnsSharedFile(repoRoot, key, absPath, receipt) {
  const r = receipt ?? await readReceipt(repoRoot);
  if (!r) return false;
  const recorded = r.shared?.[key];
  if (!recorded) return false;
  const observed = await readStableRegularFile(absPath, {
    maxBytes: 1024 * 1024,
    requireSingleLink: true,
    requireOwner: true,
  });
  if (!observed.ok) return false;
  const now = hashBytes(observed.bytes);
  return (Array.isArray(recorded) ? recorded : [recorded])
    .some((entry) => receiptEntryMatches(entry, now, observed.stat));
}

/**
 * Does a worktree-file receipt own one already-stable observation?
 *
 * This is deliberately separate from `holtOwnsFile`: callers which are about to mutate a file
 * must ask about the descriptor-bound bytes they actually parsed, not re-read the pathname and
 * accidentally authorise a different inode. Legacy receipts contain content hashes; those remain
 * readable for reproducibility/risk classification, but cannot authorise deletion because a later
 * byte-identical replacement is indistinguishable by content alone. Current entries must match
 * bytes, inode metadata, and the worktree namespace observed by the transaction.
 */
export function receiptOwnsFileObservation(receipt, relPath, observation) {
  if (!receipt || !observation || observation.state !== 'present') return false;
  const recorded = receipt.created?.[relPath];
  if (!recorded) return false;
  return (Array.isArray(recorded) ? recorded : [recorded])
    .some((entry) => projectTokenMatches(entry, observation));
}

/**
 * Read the install receipt once and retain the same file transaction for final clearing.
 * Ownership decisions and receipt deletion therefore share one inode/content observation across
 * the whole uninstall instead of reopening the path after every adapter has already been visited.
 */
export async function openReceiptSnapshot(repoRoot) {
  const p = await receiptPath(repoRoot);
  if (!p) return { receipt: emptyReceipt(), transaction: null };
  try {
    const transaction = await openIntegrationFileTransaction(repoRoot, p);
    if (transaction.state === 'absent') {
      return { receipt: emptyReceipt(), transaction };
    }
    if (!Buffer.isBuffer(transaction.bytes)) return { receipt: null, transaction };
    return { receipt: receiptFromBytes(transaction.bytes), transaction };
  } catch {
    return { receipt: null, transaction: null };
  }
}

async function integrationRecoveryDirectory(repoRoot, absPath) {
  const receiptFile = await receiptPath(repoRoot);
  if (receiptFile) {
    const root = await ensurePrivateDirectory(path.join(path.dirname(receiptFile), 'recovery'));
    const [sourceParent, recovery] = await Promise.all([
      fs.stat(path.dirname(absPath)),
      fs.stat(root),
    ]);
    // rename is the identity-preserving primitive. Use the central Holt recovery namespace only
    // when it is on the same filesystem as the file; linked worktrees and user-scope configs can
    // legitimately live on another device.
    if (String(sourceParent.dev) === String(recovery.dev)) {
      const dir = await fs.mkdtemp(path.join(root, 'integration-file-'));
      if (process.platform !== 'win32') await fs.chmod(dir, 0o700);
      return dir;
    }
  }

  // Cross-device and non-repository fallback. The directory is a unique, private sibling so the
  // first move remains an atomic same-filesystem rename. It is intentionally retained: deleting
  // a later pathname occupant would recreate the exact TOCTOU this transaction exists to close.
  const dir = await fs.mkdtemp(path.join(path.dirname(absPath), '.holt-recovery-'));
  if (process.platform !== 'win32') await fs.chmod(dir, 0o700);
  return dir;
}

/**
 * @param {string} message
 * @param {string|null} [recoveryPath]
 * @param {unknown} [cause]
 * @returns {Error & {code:string,recoveryPath?:string}}
 */
function integrationRaceError(message, recoveryPath = null, cause = undefined) {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), {
    code: 'EINTEGRATIONRACE',
    ...(recoveryPath ? { recoveryPath } : {}),
  });
}

async function restoreIntegrationBytesExclusively(absPath, observed) {
  try {
    await createSharedRegularFileExclusive(absPath, observed.bytes, {
      mode: observed.stat.mode & 0o777,
    });
    return true;
  } catch {
    // A new file at the active pathname belongs to the concurrent writer. Never overwrite it.
    return false;
  }
}

/**
 * Open one compare-and-swap transaction for an integration-owned regular-file pathname.
 *
 * The transaction binds parsing, receipt ownership, and the eventual mutation to one stable
 * descriptor observation. `commit(null)` retires the file; `commit(bytes)` replaces or creates
 * it. Existing bytes are moved to a private recovery path and verified by inode+content before
 * the active pathname is changed. Publication is exclusive, so a concurrent replacement wins
 * and is preserved. Recovery bytes are retained even after success because portable filesystems
 * have no "unlink only if this path still names inode X" primitive.
 *
 * @param {string} repoRoot
 * @param {string} absPath
 * @param {{maxBytes?:number}} [options]
 */
export async function openIntegrationFileTransaction(repoRoot, absPath, {
  maxBytes = 64 * 1024 * 1024,
} = {}) {
  const [stable, worktree] = await Promise.all([
    readStableRegularFile(absPath, {
      maxBytes,
      requireSingleLink: true,
      requireOwner: true,
    }),
    worktreeReceiptKey(repoRoot),
  ]);
  if (!stable.ok && stable.code !== 'ENOENT') {
    const error = Object.assign(
      new Error(`integration file is not one stable owned regular file (${stable.reason})`),
      { code: stable.code ?? 'EINTEGRATIONUNAVAILABLE' },
    );
    throw error;
  }

  const present = stable.ok;
  const observation = present ? {
    state: 'present',
    bytes: stable.bytes,
    stat: stable.stat,
    sha256: hashBytes(stable.bytes),
    worktree,
  } : {
    state: 'absent', bytes: null, stat: null, sha256: null, worktree,
  };
  let committed = false;

  return {
    ...observation,
    /**
     * @param {Buffer|string|null} replacement null means remove from the active pathname
     * @param {{mode?:number,onBeforeMutation?:((details:{file:string,action:'create'|'replace'|'delete'})=>any)|null,onAfterPublish?:(()=>any)|null}} [commitOptions]
     */
    async commit(replacement, {
      mode = present ? (stable.stat.mode & 0o777) : 0o666,
      onBeforeMutation = null,
      onAfterPublish = null,
    } = {}) {
      if (committed) throw new Error(`integration file transaction already committed: ${absPath}`);
      committed = true;
      const desired = replacement === null ? null : Buffer.from(replacement);
      if (present && desired && desired.equals(stable.bytes)) {
        const publication = worktree
          ? projectIdentityToken(observation.sha256, stable.stat, worktree)
          : null;
        return { state: 'unchanged', creation: null, publication, recoveryPath: null };
      }
      if (!present && desired === null) {
        const current = await readStableRegularFile(absPath, {
          maxBytes, requireSingleLink: true, requireOwner: true,
        });
        if (!current.ok && current.code === 'ENOENT') {
          return { state: 'absent', creation: null, publication: null, recoveryPath: null };
        }
        throw integrationRaceError(
          'integration file appeared after the absence observation; left it untouched',
        );
      }

      const action = !present ? 'create' : desired === null ? 'delete' : 'replace';
      if (typeof onBeforeMutation === 'function') {
        await onBeforeMutation({ file: absPath, action });
      }

      if (!present) {
        try {
          const creation = await createSharedRegularFileExclusive(absPath, desired, { mode });
          if (typeof onAfterPublish === 'function') await onAfterPublish();
          const published = await readStableRegularFile(absPath, {
            maxBytes, requireSingleLink: true, requireOwner: true,
          });
          if (!published.ok
            || !tokenMatches(creation, hashBytes(published.bytes), published.stat)) {
            throw integrationRaceError(
              'integration file changed after exclusive creation; replacement was not adopted',
            );
          }
          const publication = worktree
            ? projectIdentityToken(creation.sha256, creation, worktree)
            : null;
          return { state: 'created', creation, publication, recoveryPath: null };
        } catch (cause) {
          if (cause?.code === 'EINTEGRATIONRACE') throw cause;
          throw integrationRaceError(
            'integration file appeared or changed before exclusive creation; left it untouched',
            null,
            cause,
          );
        }
      }

      const stagingDir = await integrationRecoveryDirectory(repoRoot, absPath);
      const stagedPath = path.join(stagingDir, path.basename(absPath));
      try {
        await fs.rename(absPath, stagedPath);
      } catch (cause) {
        throw integrationRaceError(
          `integration file could not be moved into recovery at ${stagedPath}`,
          stagedPath,
          cause,
        );
      }

      const moved = await readStableRegularFile(stagedPath, {
        maxBytes, requireSingleLink: true, requireOwner: true,
      });
      if (!moved.ok || !sameRetiredObservation(stable.stat, moved.stat)
        || hashBytes(moved.bytes) !== observation.sha256) {
        const restored = moved.ok && await restoreIntegrationBytesExclusively(absPath, moved);
        throw integrationRaceError(
          `integration file changed before mutation${restored ? '; raced bytes were restored' : ''}; retained at ${stagedPath}`,
          stagedPath,
        );
      }

      if (desired === null) {
        return { state: 'deleted', creation: null, publication: null, recoveryPath: stagedPath };
      }

      let creation;
      try {
        creation = await createSharedRegularFileExclusive(absPath, desired, { mode });
        if (typeof onAfterPublish === 'function') await onAfterPublish();
        const published = await readStableRegularFile(absPath, {
          maxBytes, requireSingleLink: true, requireOwner: true,
        });
        if (!published.ok
          || !tokenMatches(creation, hashBytes(published.bytes), published.stat)) {
          throw integrationRaceError(
            `integration replacement changed after publication; prior bytes retained at ${stagedPath}`,
            stagedPath,
          );
        }
      } catch (cause) {
        if (cause?.code === 'EINTEGRATIONRACE') throw cause;
        const restored = await restoreIntegrationBytesExclusively(absPath, moved);
        throw integrationRaceError(
          `integration replacement could not be published without overwriting another file${restored ? '; prior bytes were restored' : ''}; retained at ${stagedPath}`,
          stagedPath,
          cause,
        );
      }
      const publication = worktree
        ? projectIdentityToken(creation.sha256, creation, worktree)
        : null;
      return { state: 'replaced', creation, publication, recoveryPath: stagedPath };
    },
  };
}

function safeReceiptRelative(rel) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || rel.includes('\\')) return false;
  const parts = rel.split('/');
  return !parts.some((part) => part === '' || part === '.' || part === '..');
}

async function verifyProjectCreationRecords(repoRoot, records) {
  const worktree = await worktreeReceiptKey(repoRoot);
  if (!worktree) return false;
  for (const { path: rel, token } of records) {
    if (!safeReceiptRelative(rel) || token.worktree !== worktree) return false;
    const observed = await readStableRegularFile(path.join(repoRoot, rel), {
      maxBytes: 64 * 1024 * 1024,
      requireSingleLink: true,
      requireOwner: true,
    });
    if (!observed.ok || !tokenMatches(token, hashBytes(observed.bytes), observed.stat)) return false;
  }
  return true;
}

/**
 * Publish a merged receipt with compare-and-swap semantics. Every attempt binds parsing and
 * replacement to one receipt inode. If another integrate wins, its receipt is preserved and this
 * writer reopens/merges it; malformed state, unverifiable authored files, or repeated contention
 * returns false without overwriting the winner.
 *
 * @param {string} repoRoot
 * @param {(existing:any)=>any} update
 * @param {{verify?:(()=>Promise<boolean>)|null,
 *   onBeforeMutation?:((details:{file:string,action:'create'|'replace'|'delete'})=>any)|null,
 *   onAfterPublish?:(()=>any)|null,maxAttempts?:number}} [options]
 */
async function publishReceiptUpdate(repoRoot, update, {
  verify = null, onBeforeMutation = null, onAfterPublish = null, maxAttempts = 8,
} = {}) {
  const p = await receiptPath(repoRoot);
  if (!p) return false;
  try {
    await ensurePrivateDirectory(path.dirname(p));
  } catch {
    return false;
  }

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let transaction;
    try {
      transaction = await openIntegrationFileTransaction(repoRoot, p, { maxBytes: 4 * 1024 * 1024 });
    } catch {
      // Another publisher exposes at most a bounded absent/in-progress window while its exclusive
      // file is written and synced. Never interpret that transient as an empty/corrupt receipt.
      await new Promise((resolve) => setTimeout(resolve, Math.min(2 ** attempt, 20)));
      continue;
    }
    const existing = transaction.state === 'absent'
      ? emptyReceipt()
      : (Buffer.isBuffer(transaction.bytes) ? receiptFromBytes(transaction.bytes) : null);
    // An unreadable receipt is not licence to replace it with a partial view.
    if (!existing) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(2 ** attempt, 20)));
      continue;
    }
    if (verify && !(await verify())) return false;
    const next = normalizedReceipt(update(existing));
    if (!next) return false;
    try {
      await transaction.commit(`${JSON.stringify(next, null, 2)}\n`, {
        mode: 0o600,
        onBeforeMutation,
        onAfterPublish,
      });
    } catch (error) {
      if (error?.code === 'EINTEGRATIONRACE') continue;
      return false;
    }
    // The file token was the only authority supplied by the caller. Re-check after durable receipt
    // publication so a substitution during the publish window cannot be reported as installed.
    if (verify && !(await verify())) return false;
    return true;
  }
  return false;
}

/**
 * Move one receipt-owned shared file out of its executable pathname before mutating it.
 *
 * The ownership check and a later rm/write cannot safely be two pathname operations: another
 * process may replace the leaf in between. This transaction first reads one descriptor-bound
 * inode, then renames the pathname into a private same-directory quarantine and verifies that
 * the inode which moved is the inode which was authorised. If a replacement won the race, its
 * bytes are copied back to the original pathname without overwriting anything and the quarantined
 * inode is retained at the reported recovery path. They are never deleted as Holt-owned bytes.
 *
 * @param {string} repoRoot
 * @param {string} key
 * @param {string} absPath
 * @param {{receipt?:any,onBeforeRename?:(()=>any)|null,onAfterRecoveryPublish?:(()=>any)|null,classify?:((bytes:Buffer)=>('current'|'leave'|'stage'))}} [options]
 * @returns {Promise<
 *   {state:'absent'|'unavailable'|'unowned'|'current'|'leave',reason?:string,sha256?:string,stat?:any}
 *   |{state:'staged',originalPath:string,stagedPath:string,stagingDir:string,sha256:string,stat:any}
 * >}
 */
export async function quarantineReceiptOwnedSharedFile(repoRoot, key, absPath, {
  receipt = undefined, onBeforeRename = null, onAfterRecoveryPublish = null,
  classify = () => 'stage',
} = {}) {
  // This is the ONLY initial observation. Callers classify these exact descriptor-bound bytes;
  // they must not read the pathname first and then ask this function to authorise a later inode.
  const observed = await readStableRegularFile(absPath, {
    maxBytes: 1024 * 1024,
    requireSingleLink: true,
    requireOwner: true,
  });
  if (!observed.ok) {
    return {
      state: observed.code === 'ENOENT' ? 'absent' : 'unavailable',
      reason: observed.reason,
    };
  }
  const sha256 = hashBytes(observed.bytes);
  const disposition = classify(observed.bytes);
  if (!['current', 'leave', 'stage'].includes(disposition)) {
    throw new Error(`invalid shared-file disposition '${disposition}'`);
  }
  if (disposition !== 'stage') {
    return { state: disposition, sha256, stat: observed.stat };
  }

  const r = receipt === undefined ? await readReceipt(repoRoot) : receipt;
  if (!r) return { state: 'unowned', sha256, stat: observed.stat };
  const recorded = r.shared?.[key];
  if (!recorded) return { state: 'unowned', sha256, stat: observed.stat };
  const accepted = Array.isArray(recorded) ? recorded : [recorded];
  if (!accepted.some((entry) => receiptEntryMatches(entry, sha256, observed.stat))) {
    return { state: 'unowned', sha256, stat: observed.stat };
  }

  if (onBeforeRename) await onBeforeRename();
  const receiptFile = await receiptPath(repoRoot);
  if (!receiptFile) return { state: 'unowned', sha256, stat: observed.stat };
  // Recovery bytes are explicit product state, not anonymous executable-directory siblings.
  // Keeping them below <git-common-dir>/holt/recovery makes their ownership and future storage
  // inventory mechanically discoverable without walking the repository or guessing by name.
  const recoveryRoot = await ensurePrivateDirectory(path.join(path.dirname(receiptFile), 'recovery'));
  const stagingDir = await fs.mkdtemp(path.join(recoveryRoot, 'shared-hook-'));
  if (process.platform !== 'win32') await fs.chmod(stagingDir, 0o700);
  const stagedPath = path.join(stagingDir, path.basename(absPath));
  try {
    await fs.rename(absPath, stagedPath);
    const moved = await readStableRegularFile(stagedPath, {
      maxBytes: 1024 * 1024,
      requireSingleLink: true,
      requireOwner: true,
    });
    if (!moved.ok || !sameInode(observed.stat, moved.stat) || hashBytes(moved.bytes) !== sha256) {
      let restored = false;
      if (moved.ok) {
        try {
          // Re-publish a copy, never the quarantined inode itself. The quarantine remains a durable
          // recovery copy even if the newly published pathname is removed immediately afterward.
          await createSharedRegularFileExclusive(absPath, moved.bytes, {
            mode: moved.stat.mode & 0o777,
          });
          restored = true;
          if (typeof onAfterRecoveryPublish === 'function') await onAfterRecoveryPublish();
        } catch { /* retain the quarantined bytes for explicit recovery */ }
      }
      const error = Object.assign(new Error(
        `receipt-owned shared file changed before quarantine${restored ? '; a copy was restored' : ''}; retained at ${stagedPath}`,
      ), {
        code: 'ESHAREDRACE',
        recoveryPath: stagedPath,
      });
      throw error;
    }
    return {
      state: 'staged', originalPath: absPath, stagedPath, stagingDir, sha256, stat: moved.stat,
    };
  } catch (error) {
    // Even an empty transaction directory is retained in the explicit recovery namespace. A
    // later pathname cleanup cannot be proven to target the same directory we created, and a
    // storage inventory can safely classify this small artifact by its namespace.
    throw error;
  }
}

/**
 * Verify and retain a quarantined shared file as the recovery copy.
 *
 * Portable filesystems do not offer an atomic "unlink this path only if it still names inode X"
 * primitive. Retention is therefore the only class-level rule that cannot turn a late pathname
 * substitution into deletion of the wrong bytes.
 */
export async function retainQuarantinedSharedFile(staged) {
  const observed = await readStableRegularFile(staged.stagedPath, {
    maxBytes: 1024 * 1024,
    requireSingleLink: true,
    requireOwner: true,
  });
  if (!observed.ok || !sameInode(staged.stat, observed.stat)
    || hashBytes(observed.bytes) !== staged.sha256) {
    const error = Object.assign(
      new Error(`shared-file quarantine changed; retained at ${staged.stagedPath}`),
      { code: 'ESHAREDRACE', recoveryPath: staged.stagedPath },
    );
    throw error;
  }
  return staged.stagedPath;
}

/**
 * Restore a copy without replacing a file which appeared at the original pathname. The staged
 * inode is always retained, including after successful publication, so loss of the new pathname
 * cannot erase the final recovery copy.
 *
 * @param {{originalPath:string,stagedPath:string,stagingDir:string,sha256:string,stat:import('node:fs').Stats}} staged
 * @param {{onAfterPublish?:(()=>any)|null}} [options]
 */
export async function restoreQuarantinedSharedFile(staged, { onAfterPublish = null } = {}) {
  const observed = await readStableRegularFile(staged.stagedPath, {
    maxBytes: 1024 * 1024,
    requireSingleLink: true,
    requireOwner: true,
  });
  if (!observed.ok || !sameInode(staged.stat, observed.stat)
    || hashBytes(observed.bytes) !== staged.sha256) {
    const error = Object.assign(
      new Error(`shared-file quarantine changed; retained at ${staged.stagedPath}`),
      { code: 'ESHAREDRACE', recoveryPath: staged.stagedPath },
    );
    throw error;
  }
  try {
    const creation = await createSharedRegularFileExclusive(staged.originalPath, observed.bytes, {
      mode: observed.stat.mode & 0o777,
    });
    if (typeof onAfterPublish === 'function') await onAfterPublish();
    return { recoveryPath: staged.stagedPath, creation };
  } catch (cause) {
    const error = Object.assign(new Error(
      `shared-file quarantine could not be restored without overwriting another file; retained at ${staged.stagedPath}`,
      { cause },
    ), { code: 'ESHAREDRACE', recoveryPath: staged.stagedPath });
    throw error;
  }
}

/**
 * May holt delete this path outright?
 *
 * TRUE only when the receipt says holt created it AND the bytes on disk are still the ones holt
 * wrote. A file holt created that the user has since edited is the USER'S FILE NOW — holt strips
 * its own block from it and leaves it behind, which is the same rule that already governs a file
 * holt merely appended to.
 */
export async function holtOwnsFile(repoRoot, relPath, receipt) {
  const r = receipt ?? await readReceipt(repoRoot);
  if (!r) return false;                              // could not look -> own nothing
  if (!(relPath in r.created)) return false;         // never created it -> not ours
  try {
    const observation = await openIntegrationFileTransaction(repoRoot, path.join(repoRoot, relPath));
    return receiptOwnsFileObservation(r, relPath, observation);
  } catch {
    return false;
  }
}

/**
 * Three-state ownership for a set of paths — the same question `holtOwnsFile` answers, asked in
 * the direction this file was never asked about.
 *
 * `holtOwnsFile` answers "may I DELETE this?", so every uncertainty collapses to false. The risk
 * layer needs "is this the USER'S work?", where the same uncertainty must collapse the other way.
 * Reusing the delete-shaped predicate there would read "could not look" as "not holt's" as "the
 * user's irreplaceable work" — and one `null` would silently protect the whole tree.
 *
 *   MINE_UNTOUCHED  recorded, bytes unchanged -> holt's own output. Contributes ZERO to
 *                   irreplaceability: `holt integrate` recreates it byte-for-byte, and the receipt
 *                   lives in <git-common-dir>/holt/ so it outlives `git clean -fdx` and the
 *                   worktree itself.
 *   MINE_EDITED     recorded, bytes differ -> THE USER'S FILE NOW. Full protection. This is the
 *                   cell that makes the scheme honest: holt writing a file once does not give it a
 *                   permanent claim on whatever the user later puts there.
 *   NOT_MINE        no entry, or an entry with no hash. A NAME is never evidence, in either
 *                   direction — files holt only APPENDED to are not in `created` and land here.
 *   UNKNOWN         receipt unreadable -> PROTECT.
 *
 * `null` MEANS PROTECT IN BOTH CONSUMERS, and it is written as one invariant precisely because the
 * two readings are opposite: for uninstall an unreadable receipt means "delete nothing", and here
 * it must mean "protect everything" rather than "holt owns nothing".
 *
 * @param {string} wtPath  the worktree the paths live in — NOT necessarily the repo root
 * @param {string[]} rels
 * @param {{created?: Record<string, any>}|null} receipt
 *   already-read receipt, or null for "could not look"
 * @returns {Promise<Map<string, 'MINE_UNTOUCHED'|'MINE_EDITED'|'NOT_MINE'|'UNKNOWN'>>}
 */
export async function ownershipOf(wtPath, rels, receipt) {
  if (!receipt) return new Map(rels.map((f) => [f, 'UNKNOWN']));
  const out = new Map();
  for (const f of rels) {
    const rec = receipt.created?.[f];
    if (!rec) { out.set(f, 'NOT_MINE'); continue; }
    const now = await fileHash(path.join(wtPath, f));
    if (now === null) { out.set(f, 'NOT_MINE'); continue; }
    // A SET of accepted hashes, not one. `integrate` runs per worktree against a receipt shared
    // through the git common dir, and `recordCreated` is last-writer-wins — so with a single hash
    // every OTHER worktree's byte-identical copy silently demotes to MINE_EDITED. Safe, but it
    // makes MINE_UNTOUCHED unreachable and this whole fix stops working the moment there are two
    // worktrees, which is holt's entire subject matter.
    const accepted = Array.isArray(rec) ? rec : [rec];
    // Risk classification asks whether the bytes are reproducible, not whether deletion is
    // authorised. Legacy hashes remain meaningful for that narrower question; identity entries
    // contribute their bound hash without weakening uninstall's object-only authority rule.
    const reproducible = accepted.some((entry) => (
      typeof entry === 'string' ? entry === now : entry?.sha256 === now
    ));
    out.set(f, reproducible ? 'MINE_UNTOUCHED' : 'MINE_EDITED');
  }
  return out;
}

/** Did holt create this directory? Empty-directory cleanup is only safe for directories holt made. */
export async function holtOwnsDir(repoRoot, relDir, receipt) {
  const r = receipt ?? await readReceipt(repoRoot);
  if (!r) return false;
  return r.dirs.includes(relDir);
}

/**
 * Forget everything at the end of a successful uninstall, but only if no concurrent integrate
 * changed the receipt after uninstall took its ownership snapshot.
 */
/**
 * @param {string} repoRoot
 * @param {any} [expectedReceipt]
 * @param {{onBeforeMutation?:((details:{file:string,action:'create'|'replace'|'delete'})=>any)|null,
 *   transaction?:any}} [options]
 */
async function clearReceiptResult(repoRoot, expectedReceipt = undefined, {
  onBeforeMutation = null, transaction: suppliedTransaction = null,
} = {}) {
  const p = await receiptPath(repoRoot);
  if (!p) return { ok: false, recoveryPath: null };
  try {
    const transaction = suppliedTransaction
      ?? await openIntegrationFileTransaction(repoRoot, p);
    if (transaction.state === 'absent') {
      if (expectedReceipt !== undefined
        && JSON.stringify(expectedReceipt) !== JSON.stringify(emptyReceipt())) {
        return { ok: false, recoveryPath: null };
      }
      const mutation = await transaction.commit(null, { onBeforeMutation });
      return { ok: true, recoveryPath: mutation.recoveryPath };
    }
    if (expectedReceipt !== undefined) {
      let current;
      try {
        const receiptBytes = transaction.bytes;
        if (!Buffer.isBuffer(receiptBytes)) return { ok: false, recoveryPath: null };
        current = receiptFromBytes(receiptBytes);
      } catch {
        return { ok: false, recoveryPath: null };
      }
      if (!current) return { ok: false, recoveryPath: null };
      if (JSON.stringify(current) !== JSON.stringify(expectedReceipt)) {
        return { ok: false, recoveryPath: null };
      }
    }
    const mutation = await transaction.commit(null, { onBeforeMutation });
    return { ok: true, recoveryPath: mutation.recoveryPath };
  } catch (error) {
    return {
      ok: false,
      recoveryPath: typeof error?.recoveryPath === 'string' ? error.recoveryPath : null,
    };
  }
}

/** Forget the current receipt, preserving the historical boolean API used by the CLI. */
export async function clearReceipt(repoRoot) {
  return (await clearReceiptResult(repoRoot)).ok;
}

/**
 * Clear only the receipt whose parsed snapshot the caller already used for ownership decisions.
 * @param {string} repoRoot
 * @param {any} expectedReceipt
 * @param {{onBeforeMutation?:((details:{file:string,action:'create'|'replace'|'delete'})=>any)|null,
 *   transaction?:any}} [options]
 */
export async function clearReceiptIfUnchanged(repoRoot, expectedReceipt, options = {}) {
  return clearReceiptResult(repoRoot, expectedReceipt, options);
}
