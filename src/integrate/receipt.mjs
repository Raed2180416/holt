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
import { createHash, randomUUID } from 'node:crypto';
import { constants as FSC } from 'node:fs';
import { ensurePrivateDirectory, readStableRegularFile } from '../stable-file.mjs';
import { execFile } from 'node:child_process';

const RECEIPT_VERSION = 2;
const NOFOLLOW = FSC.O_NOFOLLOW ?? 0;

function commonDir(cwd) {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, timeout: 10_000 },
      (err, stdout) => resolve(err ? null : String(stdout).trim() || null));
  });
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
 * @returns {Promise<{version: number, created: Record<string, string|string[]|null>, shared: Record<string, string|string[]|null>, dirs: string[]}|null>}
 *   `null` means holt could not read it — which callers MUST treat as "own nothing", not "own all".
 */
export async function readReceipt(repoRoot) {
  const p = await receiptPath(repoRoot);
  // NOT A GIT REPOSITORY IS NOT "COULD NOT LOOK". There is no receipt here and there never could
  // be one, so holt knows exactly as much as it would from an empty receipt: it created nothing
  // recorded. Returning `null` here instead conflated "nowhere to keep a receipt" with "a receipt
  // I could not parse", and that froze uninstall in plain directories — a regression caught by
  // two pre-existing tests that uninstall from a non-git temp dir.
  if (!p) return { version: RECEIPT_VERSION, created: {}, shared: {}, dirs: [] };
  let raw;
  try {
    raw = await fs.readFile(p, 'utf8');
  } catch (e) {
    // ENOENT is a real answer: holt has never installed here, so it created nothing. Any other
    // error is "could not look", and must not be reported as an empty receipt.
    if (e && e.code === 'ENOENT') return { version: RECEIPT_VERSION, created: {}, shared: {}, dirs: [] };
    return null;
  }
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object') return null;
    return {
      version: Number(j.version) || RECEIPT_VERSION,
      created: (j.created && typeof j.created === 'object') ? j.created : {},
      shared: (j.shared && typeof j.shared === 'object') ? j.shared : {},
      dirs: Array.isArray(j.dirs) ? j.dirs : [],
    };
  } catch {
    // Corrupt JSON is "could not look". Deleting on a guess is exactly what this file prevents.
    return null;
  }
}

/**
 * Record paths holt CREATED during an install.
 *
 * Merges into whatever is already there — integrate is re-run routinely, and a second run that
 * creates one new file must not erase the record of the first run's five.
 *
 * @param {string} repoRoot
 * @param {{files?: string[], dirs?: string[]}} made  repo-relative paths holt brought into being
 */
export async function recordCreated(repoRoot, { files = [], dirs = [] } = {}) {
  const p = await receiptPath(repoRoot);
  if (!p) return false;
  const existing = await readReceipt(repoRoot);
  // An unreadable receipt is not licence to start a fresh one — that would silently forget
  // everything an earlier install created, and those files would then never be cleaned up.
  if (existing === null) return false;

  const created = { ...existing.created };
  for (const rel of files) {
    // The hash is taken AFTER writing, so it is the content holt is responsible for. If the user
    // edits the file later, the hash stops matching and holt no longer claims it.
    //
    // A LIST, NOT ONE HASH, and the reason is holt's own subject matter. `integrate` runs per
    // worktree against a receipt shared through the git common dir, last-writer-wins, so a single
    // slot means worktree 2's write erases worktree 1's hash — and worktree 1's byte-identical
    // copy then reads as edited-by-the-user. Safe in the delete direction, wrong in the risk
    // direction, and it would have made the P0-1 fix stop working at exactly two worktrees.
    // Capped and deduped so a hundred re-runs cannot grow the receipt without bound. Reading is
    // backward-compatible by construction (see ownershipOf's Array.isArray), so a receipt written
    // by an older holt keeps working untouched.
    const prior = Array.isArray(existing.created?.[rel])
      ? existing.created[rel]
      : (existing.created?.[rel] ? [existing.created[rel]] : []);
    const now = await fileHash(path.join(repoRoot, rel));
    // flatMap, not filter: a boolean-returning filter does not narrow the element type, so the
    // result would still read as possibly-null and the receipt's own contract would not typecheck.
    const hashes = [...prior, now].flatMap((h) => (typeof h === 'string' && h ? [h] : []));
    created[rel] = [...new Set(hashes)].slice(-8);
  }
  const dirSet = new Set([...existing.dirs, ...dirs]);

  try {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, `${JSON.stringify({
      version: RECEIPT_VERSION, created, shared: existing.shared ?? {}, dirs: [...dirSet],
    }, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

const sameInode = (left, right) => left && right
  && String(left.dev) === String(right.dev)
  && String(left.ino) === String(right.ino);
const hashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
const identityToken = (sha256, stat) => ({
  sha256,
  dev: String(stat.dev),
  ino: String(stat.ino),
  size: Number(stat.size),
  ctimeMs: Number(stat.ctimeMs),
});
const tokenMatches = (token, sha256, stat) => !!token
  && token.sha256 === sha256
  && token.dev === String(stat.dev)
  && token.ino === String(stat.ino)
  && token.size === Number(stat.size)
  && token.ctimeMs === Number(stat.ctimeMs);
// Shared-file ownership was introduced together with v2 identity receipts; no released v1
// receipt contained this namespace. A bare legacy/content hash is therefore evidence of bytes,
// not authority over the current inode, and must fail closed instead of being "upgraded" by use.
const receiptEntryMatches = (entry, sha256, stat) => !!entry
  && typeof entry === 'object'
  && tokenMatches(entry, sha256, stat);

async function writeReceiptAtomic(file, value) {
  const dir = path.dirname(file);
  const temp = path.join(dir, `.install-receipt.${process.pid}.${randomUUID()}.tmp`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  // A successful rename consumes the unique temporary pathname. On failure retain it rather than
  // issuing a later path-based delete: another process must never be able to substitute a leaf
  // between our failed publication and cleanup and have Holt erase that substitute.
  await fs.rename(temp, file);
}

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
  const p = await receiptPath(repoRoot);
  if (!p) return false;
  const existing = await readReceipt(repoRoot);
  if (existing === null) return false;
  const observed = await readStableRegularFile(absPath, {
    maxBytes: 1024 * 1024,
    requireSingleLink: true,
    requireOwner: true,
  });
  if (!observed.ok) return false;
  const now = hashBytes(observed.bytes);
  if (!tokenMatches(expectedToken, now, observed.stat)) return false;
  const exactRecord = identityToken(now, observed.stat);
  const shared = {
    ...(existing.shared ?? {}),
    // A shared pathname has one active inode. Retaining prior inode identities expands deletion
    // authority without helping the current file, and silently capping that history makes the
    // receipt appear complete when it is not. Publish only the exact current identity.
    [key]: exactRecord,
  };
  try {
    await writeReceiptAtomic(p, {
      version: RECEIPT_VERSION,
      created: existing.created ?? {},
      shared,
      dirs: existing.dirs ?? [],
    });
    const after = await readStableRegularFile(absPath, {
      maxBytes: 1024 * 1024,
      requireSingleLink: true,
      requireOwner: true,
    });
    return after.ok && tokenMatches(exactRecord, hashBytes(after.bytes), after.stat);
  } catch {
    return false;
  }
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
  const recorded = r.created[relPath];
  if (!recorded) return false;                       // no hash recorded -> cannot prove it is ours
  const now = await fileHash(path.join(repoRoot, relPath));
  if (now === null) return false;                    // gone or unreadable -> nothing to delete
  // A receipt entry is a LIST of accepted hashes (see recordCreated); older receipts hold a bare
  // string. Both are read here, so an in-place upgrade never makes holt forget what it owns —
  // which would strand its own files as undeletable on exactly the uninstall that needed them gone.
  return (Array.isArray(recorded) ? recorded : [recorded]).includes(now);
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
 * @param {{created?: Record<string, string|string[]|null>}|null} receipt
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
    out.set(f, accepted.includes(now) ? 'MINE_UNTOUCHED' : 'MINE_EDITED');
  }
  return out;
}

/** Did holt create this directory? Empty-directory cleanup is only safe for directories holt made. */
export async function holtOwnsDir(repoRoot, relDir, receipt) {
  const r = receipt ?? await readReceipt(repoRoot);
  if (!r) return false;
  return r.dirs.includes(relDir);
}

/** Forget everything — called at the end of a successful uninstall. */
export async function clearReceipt(repoRoot) {
  const p = await receiptPath(repoRoot);
  if (!p) return false;
  try {
    await fs.rm(p, { force: true });
    return true;
  } catch {
    return false;
  }
}
