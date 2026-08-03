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
import { execFile } from 'node:child_process';

const RECEIPT_VERSION = 1;

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
 * @returns {Promise<{version: number, created: Record<string, string|string[]|null>, dirs: string[]}|null>}
 *   `null` means holt could not read it — which callers MUST treat as "own nothing", not "own all".
 */
export async function readReceipt(repoRoot) {
  const p = await receiptPath(repoRoot);
  // NOT A GIT REPOSITORY IS NOT "COULD NOT LOOK". There is no receipt here and there never could
  // be one, so holt knows exactly as much as it would from an empty receipt: it created nothing
  // recorded. Returning `null` here instead conflated "nowhere to keep a receipt" with "a receipt
  // I could not parse", and that froze uninstall in plain directories — a regression caught by
  // two pre-existing tests that uninstall from a non-git temp dir.
  if (!p) return { version: RECEIPT_VERSION, created: {}, dirs: [] };
  let raw;
  try {
    raw = await fs.readFile(p, 'utf8');
  } catch (e) {
    // ENOENT is a real answer: holt has never installed here, so it created nothing. Any other
    // error is "could not look", and must not be reported as an empty receipt.
    if (e && e.code === 'ENOENT') return { version: RECEIPT_VERSION, created: {}, dirs: [] };
    return null;
  }
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object') return null;
    return {
      version: Number(j.version) || RECEIPT_VERSION,
      created: (j.created && typeof j.created === 'object') ? j.created : {},
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
      version: RECEIPT_VERSION, created, dirs: [...dirSet],
    }, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
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
