// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — the scanner.
 *
 * Produces, for every workstream, the two deltas that matter:
 *
 *   committed   — what BASE LACKS from this workstream's HEAD.
 *                 Computed with `merge-tree --write-tree` then diffing base against the
 *                 merged tree. This is the ONLY correct instrument for the question.
 *                 `git diff base...head` answers "what did the branch do since divergence",
 *                 which over-reports the moment base acquires the same content by another
 *                 route — cherry-pick, re-implementation, a parallel landing. Using the
 *                 three-dot form here is a documented way to report work as stranded when
 *                 it is not.
 *
 *   uncommitted — tracked modifications plus untracked files.
 *                 THIS IS THE LAYER GIT CANNOT RELATE. No git command compares uncommitted
 *                 state across worktrees; merge-tree sees only commits. In the repo holt
 *                 was built against, the committed layer flagged 4 interesting worktrees
 *                 while the uncommitted layer held configuration keys absent from base.
 *                 A tool that scanned only the committed layer would have been confidently,
 *                 quietly wrong.
 *
 * Symbols are resolved in a second phase, because every workstream compares against the SAME
 * base: extracting base symbols once for the union of touched files turns an O(workstreams ×
 * files) problem into O(files) + one batched ctags run per workstream.
 *
 * Every field carries how it was obtained, so a caller can never mistake an approximation
 * for a measurement.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { git, gitPathBatched, catFileBatch, splitNul, pmap, resolveRef, GitRefused } from './git.mjs';
import { resolveBackend, symbolsOnDisk, symbolsAtBase, diffSymbols, symbolKey } from './symbols.mjs';
import { pathContentKey } from './content-identity.mjs';
import { readReceipt, ownershipOf } from './integrate/receipt.mjs';

const BASE_CANDIDATES = ['main', 'master', 'trunk', 'develop', 'default'];

/** Pick the base ref to compare everything against. */
export async function resolveBase(root, explicit) {
  if (explicit) {
    const oid = await resolveRef(root, explicit);
    if (!oid) throw new Error(`holt: base ref '${explicit}' does not resolve in ${root}`);
    return { ref: explicit, oid, how: 'explicit' };
  }

  // origin/HEAD is the correct source for "what is this project's default branch" and is the
  // documented best practice. But it answers a DIFFERENT question from the one holt asks.
  //
  // holt asks: what will this work be landed INTO? That is the local branch. Measured on a
  // real repository whose local `main` sat 363 commits ahead of `origin/main`: taking
  // origin/HEAD as the base made every one of 39 worktrees appear to carry ~1,700 files of
  // unique work, and reported ZERO as safe to delete. The tool was not wrong about the diff —
  // it was answering against a base nobody lands into. Local-ahead is the normal state for
  // anyone working offline, on a fork, or ahead of a slow remote.
  //
  // So: take origin/HEAD's branch NAME, then prefer the LOCAL branch of that name whenever it
  // is a strict descendant of the remote. Never prefer local when the two have diverged —
  // that would silently pick a base the user has not reconciled.
  const sym = await git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { cwd: root });
  if (sym.code === 0) {
    const remoteRef = sym.stdout.trim();
    const remoteOid = await resolveRef(root, remoteRef);
    if (remoteOid) {
      const localName = remoteRef.replace(/^origin\//, '');
      const localOid = await resolveRef(root, localName);
      if (localOid && localOid !== remoteOid) {
        const isDescendant = await git(
          ['merge-base', '--is-ancestor', remoteOid, localOid], { cwd: root },
        );
        if (isDescendant.code === 0) {
          const ahead = await git(['rev-list', '--count', `${remoteOid}..${localOid}`], { cwd: root });
          return {
            ref: localName,
            oid: localOid,
            how: 'local-ahead-of-origin',
            note: `local '${localName}' is ${ahead.stdout.trim()} commit(s) ahead of ${remoteRef}; using local because that is what work lands into`,
          };
        }
      }
      if (localOid === remoteOid) return { ref: localName, oid: localOid, how: 'origin/HEAD (local in sync)' };
      return { ref: remoteRef, oid: remoteOid, how: 'origin/HEAD' };
    }
  }

  for (const cand of BASE_CANDIDATES) {
    const oid = await resolveRef(root, cand);
    if (oid) return { ref: cand, oid, how: 'conventional-name' };
  }

  const oid = await resolveRef(root, 'HEAD');
  if (oid) return { ref: 'HEAD', oid, how: 'primary-head-fallback' };

  throw new Error(`holt: could not determine a base ref in ${root} (is this an empty repository?)`);
}

async function pathUsable(p) {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

/** COMMITTED delta: what does base lack from head? */
export async function committedDelta(root, baseOid, headOid, { strictReadOnly, timeout }) {
  if (!headOid || headOid === baseOid) {
    return { files: [], how: 'identical-to-base', conflicted: false, error: undefined };
  }

  if (strictReadOnly) {
    const r = await git(['diff', '--name-only', '-z', `${baseOid}...${headOid}`], { cwd: root, timeout });
    if (r.code !== 0) return { files: [], how: 'three-dot-failed', conflicted: false, error: r.stderr.trim() };
    return {
      files: splitNul(r.stdout),
      how: 'three-dot-approximate',
      conflicted: false,
      caveat: 'strictReadOnly: over-reports content base already acquired by another route',
      error: undefined,
    };
  }

  let mt;
  try {
    mt = await git(['merge-tree', '--write-tree', baseOid, headOid], { cwd: root, timeout });
  } catch (error) {
    if (error instanceof GitRefused && error.unmeasured) {
      return {
        files: [], how: 'merge-tree-external-driver-refused', conflicted: false,
        error: error.message,
      };
    }
    throw error;
  }
  // exit 0 = clean, 1 = conflicts (tree still on line 1), >1 = error.
  if (mt.code > 1) {
    return { files: [], how: 'merge-tree-failed', conflicted: false, error: mt.stderr.trim() };
  }
  const tree = mt.stdout.split('\n')[0].trim();
  if (!/^[0-9a-f]{40,64}$/.test(tree)) {
    return { files: [], how: 'merge-tree-no-tree', conflicted: mt.code === 1, error: 'unparseable merge-tree output' };
  }

  // A RENAME TOUCHES TWO PATHS, AND THE OLD ONE IS THE ONE THAT COLLIDES.
  //
  // `--name-only` reports only the destination when git detects a rename, so a worktree that
  // renamed shared.js -> alpha.js reported touching ONLY alpha.js. The collision prefilter pairs
  // workstreams by shared touched path, so against a sibling that renamed the same file to
  // beta.js there was no intersection, no pair, and merge-tree — which proves conflicts — was
  // never run on them. git says `CONFLICT (rename/rename)` and holt printed "No collisions. No two
  // workstreams contest the same content."
  //
  // That is the worst shape of wrong: not noise, but an active all-clear on a proven conflict.
  //
  // `--name-status -M` gives both sides of a rename, so the ORIGINAL path is recorded too. The
  // prefilter's job is "which pairs might conflict", where a false positive costs one merge-tree
  // run and a false negative costs a broken landing — so it should be generous, and now is.
  const names = await git(['diff', '--name-status', '-M', '-z', baseOid, tree], { cwd: root, timeout });
  if (names.code !== 0) {
    return {
      files: [], how: 'merge-tree-names-failed', conflicted: mt.code === 1,
      mergedTree: tree, error: names.stderr.trim() || 'git diff --name-status failed',
    };
  }
  const files = [];
  const parts = splitNul(names.stdout);
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i];
    if (!status) continue;
    // R and C carry TWO paths: source then destination. Everything else carries one.
    if (/^[RC]\d*$/.test(status)) {
      if (parts[i + 1]) files.push(parts[i + 1]);
      if (parts[i + 2]) files.push(parts[i + 2]);
      i += 2;
    } else {
      if (parts[i + 1]) files.push(parts[i + 1]);
      i += 1;
    }
  }
  return {
    files: [...new Set(files)],
    how: 'merge-tree',
    conflicted: mt.code === 1,
    mergedTree: tree,
    error: undefined,
  };
}

/**
 * Normalise CRLF and lone CR to LF, at the byte level. Never applied to binary content — see
 * `lineEndingOnlyVsBase` below, which decides binary-ness with git's own instrument BEFORE this
 * ever runs on a file's bytes.
 */
function normalizeEol(buf) {
  const out = Buffer.alloc(buf.length);
  let j = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0x0d) {
      out[j++] = 0x0a;
      if (buf[i + 1] === 0x0a) i++; // CRLF collapses to one LF, not two
    } else {
      out[j++] = b;
    }
  }
  return out.subarray(0, j);
}

/**
 * Parse `git diff --raw --no-renames -z`'s output into path -> {oldMode, newMode, status}.
 * Format, repeated per changed file: `:<oldmode> <newmode> <oldsha> <newsha> <status>\0<path>\0`.
 */
function parseRawDiff(stdout) {
  const parts = splitNul(stdout);
  const byPath = new Map();
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = /^:(\d+) (\d+) [0-9a-f]+ [0-9a-f]+ ([A-Z])/.exec(parts[i]);
    if (!meta) continue; // unparseable entry — simply absent from the map, which fails closed
    byPath.set(parts[i + 1], { oldMode: meta[1], newMode: meta[2], status: meta[3] });
  }
  return byPath;
}

/** Parse `git diff --numstat -z`'s output into path -> {binary: boolean}. */
function parseNumstat(stdout) {
  const byPath = new Map();
  for (const rec of splitNul(stdout)) {
    const [added, deleted, ...rest] = rec.split('\t');
    const p = rest.join('\t'); // a path could itself contain a tab
    if (!p) continue;
    byPath.set(p, { binary: added === '-' || deleted === '-' });
  }
  return byPath;
}

/**
 * Is the WHOLE committed delta line-ending noise — every file identical to base once CRLF/CR is
 * normalised, and nothing else different?
 *
 * MEASURED, on the 50-language independent-oracle benchmark: 50 of 150 disposable misses were
 * one worktree per repository whose entire committed delta was the SAME FILE(S), re-saved with
 * CRLF line endings. `merge-tree` correctly reports "base lacks this exact tree" — a CRLF byte
 * and an LF byte are different bytes to git — but base holds the identical TEXT, so nothing here
 * is work a human or agent produced. This is `redundantWith`'s sibling-redundancy reasoning
 * (src/analyze.mjs) applied to base itself instead of a living worktree.
 *
 * A CONJUNCTION, not a majority vote, over every file in `files`: any ONE that this cannot prove
 * is line-ending-only disqualifies the ENTIRE workstream. Disqualifying cases:
 *   - missing from base or from `tree` (an add, a delete, or either half of a rename —
 *     `--no-renames` forces a rename's two halves to read as plain add/delete, rather than
 *     depending on this repo's diff.renames config)
 *   - a file-mode change (chmod +x with byte-identical content is still "another kind of change")
 *   - BINARY CONTENT — never normalised. `--numstat` is git's OWN binary call, the same
 *     instrument that decides whether to write a binary patch, so this defers to git rather than
 *     re-deriving a heuristic. A `.png` that happens to contain the byte pair 0x0D 0x0A is not a
 *     line ending, and treating it as one could call a real image change "nothing base lacks".
 *   - a git failure or unparseable output on any instrument — refusing is FAIL-CLOSED: an
 *     unproven file counts as a real change, never as line-ending noise.
 *
 * THREE GIT PROCESSES TOTAL, regardless of file count — one `--raw` (status+mode), one
 * `--numstat` (binary), one `catFileBatch` (content) — not three per file. A per-file loop here
 * would repeat exactly the spawn-per-file cost `catFileBatch` (see its doc comment in git.mjs)
 * was built to eliminate, for a check that runs on every workstream in every scan.
 *
 * Deliberately narrow to the instruments that can actually prove it: only runs when `committed`
 * came from a clean (non-conflicted) `merge-tree`, so there is one unambiguous merged tree to
 * compare files against. `strictReadOnly`'s three-dot approximation has no merged tree and is
 * already labelled approximate everywhere it surfaces — this does not try to extend it.
 */
async function lineEndingOnlyVsBase(root, baseOid, committed, files, { timeout }) {
  if (committed.how !== 'merge-tree' || committed.conflicted || !committed.mergedTree) return false;
  if (files.length === 0) return false;
  const tree = committed.mergedTree;

  // Batched for the SAME reason indexFlagDelta is — a workstream that touched tens of thousands
  // of files builds an argv past the kernel's ARG_MAX and `execve` answers E2BIG. `diff` over a
  // pathspec list is per-path, so the union over any partition of `files` is the same answer.
  const [raw, num] = await Promise.all([
    gitPathBatched(['diff', '--raw', '--no-renames', '-z', baseOid, tree, '--'], files, { cwd: root, timeout }),
    gitPathBatched(['diff', '--numstat', '-z', baseOid, tree, '--'], files, { cwd: root, timeout }),
  ]);
  if (raw.code !== 0 || num.code !== 0) return false;
  const statuses = parseRawDiff(raw.stdout);
  const stats = parseNumstat(num.stdout);

  for (const f of files) {
    const st = statuses.get(f);
    if (!st || st.status !== 'M' || st.oldMode !== st.newMode) return false;
    const ns = stats.get(f);
    if (!ns || ns.binary) return false;
  }

  // Content comparison, batched: one `git cat-file --batch` process for every base/tree blob
  // this workstream needs, instead of `files.length * 2` separate `git show` spawns.
  const specs = files.flatMap((f) => [`${baseOid}:${f}`, `${tree}:${f}`]);
  const blobs = new Map();
  await catFileBatch(specs, { cwd: root, timeout }, (spec, content) => {
    blobs.set(spec, content);
  });
  for (const f of files) {
    const baseBlob = blobs.get(`${baseOid}:${f}`);
    const headBlob = blobs.get(`${tree}:${f}`);
    if (!baseBlob || !headBlob) return false; // missing content — refuse, don't guess
    if (!normalizeEol(baseBlob).equals(normalizeEol(headBlob))) return false;
  }
  return true;
}

/**
 * Exact Git change identity for every committed-delta path.
 *
 * The tuple is Git's own `(path, mode, type, object id)` evidence. The path is kept as the map
 * key and joined by the analysis layer, so identical bytes at `.github/workflows/deploy.yml`
 * and `docs/examples/deploy.yml` are not interchangeable. Mode and type are load-bearing too:
 * a 100755 executable, a 100644 file and a 120000 symlink can carry the same blob bytes while
 * representing different work. A path absent from the merged result is an exact tombstone bound
 * to the base entry it removed. This lets a sibling's same deletion preserve the work without
 * pretending that the old blob still being present in base preserves the deletion intent.
 */
async function committedEntryIdentities(root, baseOid, committed, files, { timeout }) {
  if (committed.how !== 'merge-tree' || !committed.mergedTree || files.length === 0) {
    return { entries: {}, how: 'unavailable', error: undefined };
  }
  const result = await gitPathBatched(
    ['ls-tree', '-r', '-z', '--full-tree', committed.mergedTree, '--'],
    files,
    { cwd: root, timeout },
  );
  if (result.code !== 0) return { entries: {}, how: 'ls-tree-failed', error: result.stderr?.trim() };

  const entries = {};
  const parseEntries = (stdout, prefix = '') => {
    for (const rec of stdout.split('\0')) {
      if (!rec) continue;
      const tab = rec.indexOf('\t');
      if (tab < 0) continue;
      const meta = /^(\d+) ([^ ]+) ([0-9a-f]+)$/.exec(rec.slice(0, tab));
      if (!meta) continue;
      const file = rec.slice(tab + 1);
      entries[file] = `${prefix}${meta[1]}:${meta[2]}:${meta[3]}`;
    }
  };
  parseEntries(result.stdout);

  const missing = files.filter((file) => !entries[file]);
  if (missing.length === 0) return { entries, how: 'ls-tree-exact', error: undefined };

  // A missing result path is normally a deletion or rename source. Query the common base for the
  // exact entry removed and namespace it as a tombstone; absence of either side remains unknown.
  const base = await gitPathBatched(
    ['ls-tree', '-r', '-z', '--full-tree', baseOid, '--'],
    missing,
    { cwd: root, timeout },
  );
  if (base.code !== 0) {
    return { entries, how: 'ls-tree-partial', error: base.stderr?.trim() || 'base ls-tree failed' };
  }
  const before = { ...entries };
  for (const rec of base.stdout.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const meta = /^(\d+) ([^ ]+) ([0-9a-f]+)$/.exec(rec.slice(0, tab));
    if (!meta) continue;
    const file = rec.slice(tab + 1);
    if (!before[file]) entries[file] = `delete:${meta[1]}:${meta[2]}:${meta[3]}`;
  }
  const unresolved = missing.filter((file) => !entries[file]);
  return {
    entries,
    how: unresolved.length ? 'ls-tree-partial' : 'ls-tree-exact',
    error: unresolved.length ? `${unresolved.length} changed path(s) had no exact base/result entry` : undefined,
  };
}

/* ------------------------------------------- the index's per-path reporting filter ---- */

/**
 * THE COMPENSATING MEASUREMENT FOR `git status`'s PER-PATH REPORTING FILTER.
 *
 * THE FAULT THIS EXISTS TO CLOSE. Every "does this worktree hold content that exists nowhere
 * else" answer in holt was derived from `git status` alone, and an absent entry was read as the
 * positive fact "this path is unmodified". But `git status` is not a measurement of the working
 * tree. It is a measurement of the working tree AS FILTERED BY THE INDEX'S PER-PATH REPORTING
 * BITS, and holt never read the filter — so a path git was TOLD NOT TO REPORT was byte-for-byte
 * indistinguishable from a path that had nothing to report.
 *
 * MEASURED, on a fixture whose `config/local.json` held live credentials that exist in no commit:
 *
 *     git update-index --skip-worktree config/local.json
 *     git status --porcelain -uall            -> (empty)
 *     holt gate wt-a                          -> exit 0  "✓ disposable — no uncommitted changes"
 *     holt rescue wt-a --json                 -> {"nothingToRescue": true}
 *     holt clean --json                       -> wouldQuarantine: [wt-a]
 *     hook: rm config/local.json              -> exit 0  ALLOW
 *     git update-index --no-skip-worktree …   (same bytes, same command)
 *     hook: rm config/local.json              -> exit 2  BLOCK
 *
 * Four surfaces, one missing measurement. `--skip-worktree <config>` is the canonical advice for
 * keeping local credentials out of git, so the file this blinds holt to is precisely the file
 * whose only copy is on disk.
 *
 * THE INSTRUMENT. `git ls-files -v` is the one command that prints the filter: a per-entry tag,
 * lowercased when the entry is marked assume-unchanged. `-s` adds the index blob oid in the same
 * pass, so one call yields both the flag and the content to compare against.
 *
 * THE TAG VOCABULARY IS A DENYLIST, NOT AN ALLOWLIST, for the reason CACHE_INERT_OPTS gives:
 * a tag git adds later that suppresses status output must default to "resolve it", not to
 * "assume status already covered it". STATUS_VISIBLE_TAGS lists the tags git still reports
 * through `status` (H normal, M unmerged, R unstaged removal, C unstaged change, U resolve-undo,
 * K checkout conflict, ? untracked). Everything else, and every lowercase tag, is resolved here.
 *
 * "UNKNOWN MUST NOT SILENTLY BECOME EITHER ANSWER" — AND A CLEAN TREE IS A REAL ANSWER. This
 * does not report a flagged entry as at-risk; it RESOLVES it to one of three real outcomes:
 *
 *   not on disk        -> dropped. Nothing at that path can be destroyed. THIS IS THE
 *                         NEVER-ANNOYING KEYSTONE: `git sparse-checkout` implements itself with
 *                         the skip-worktree bit, so every excluded path in every sparse checkout
 *                         carries an `S`. Measured — in a `sparse-checkout set src` worktree,
 *                         `git ls-files -v` prints `S config/local.json` exactly as the
 *                         credentials case does. A rule keyed on the flag alone would report
 *                         every sparse worktree as unknown. The flag is not the evidence; the
 *                         file being there is.
 *   on disk, identical -> dropped. The developer flagged it and never changed it. Clean.
 *   on disk, different -> `atRisk`. The modification is in no commit, no index entry and no
 *                         stash. This is the loss holt exists to prevent.
 *   unmeasurable       -> `unknown`. Never folded into either of the above.
 *
 * CONTENT IS COMPARED WITH `git hash-object`, NOT AN IN-PROCESS SHA1, because the working-tree
 * bytes and the index blob are allowed to differ legitimately. Measured on a `*.txt text
 * eol=crlf` fixture: the file on disk is CRLF, the index blob is LF, `git status` says clean,
 * `git hash-object f.txt` returns the index oid e5c5c55… and `git hash-object --no-filters`
 * (what a hand-rolled sha1 computes) returns cf9b2a8… — so a hand-rolled hash would have called
 * an untouched file destroyed work and denied `rm` on it. Holt's central Git boundary empties
 * every configured external clean/smudge/process command before this invocation, while Git still
 * performs its built-in eol/ident/encoding conversion. A path with a `filter=<driver>` attribute
 * is therefore explicitly UNKNOWN below: executing that driver would be arbitrary code, and
 * pretending its disabled output is exact would be a different kind of lie.
 *
 * COST, AND IT IS MEASURED WHERE THE COST ACTUALLY IS. One extra `ls-files -v` per worktree.
 * On holt's own 20,189-file repository, where nothing is flagged: `status --porcelain -z -uall
 * --ignored=matching` (which every one of these call sites ALREADY runs) 29 ms, `ls-files -v -z`
 * 12 ms, and neither the second `ls-files` nor `hash-object` runs at all.
 *
 * THAT MEASUREMENT WAS ONCE THE WHOLE STORY AND IT WAS THE WRONG STORY, because holt's own
 * repository is the case where the expensive half never executes. The case that decides whether
 * this is annoying is a repository where MANY entries are flagged and NONE is on disk — which is
 * every sparse checkout, since `git sparse-checkout` implements itself with the skip-worktree
 * bit. Measured on an ordinary monorepo cone checkout with 40,000 excluded paths (65-char
 * average path):
 *
 *     git ls-files -v -z                                    15.8 ms
 *     directory-pruned existence over all 40,000 paths      11.1 ms   (ONE stat)
 *     naive lstat per path                                 518.5 ms
 *     git ls-files -s -z -- <all 40,000>                    spawn E2BIG   (argv 2.6 MB)
 *
 * So the ORDER of those steps is the cost. See the block comment in the body.
 *
 * @param {string} wtPath
 * @param {{timeout?: number}} [opts]
 * @returns {Promise<{atRisk:string[], unknown:string[], stamp:string, how:string, error?:string}>}
 */
export async function indexFlagDelta(wtPath, { timeout } = {}) {
  // `-v` ALONE, NOT `-v -s`. The oid is only needed for entries that turn out to be flagged, and
  // asking for it up front made every record ~50 bytes longer on a listing that has one record
  // per tracked file. See the two-call structure below.
  // THIS FUNCTION NEVER THROWS. Its callers are the guard's critical path and the scan's
  // Promise.all; a rejection there would propagate as an exception rather than as the
  // fail-closed `how` this contract is built on — and an exception in the guard is a FAIL-OPEN
  // exit 1 under the PreToolUse protocol. `git()` rejects, not resolves, when the binary cannot
  // be spawned at all (missing git, unreadable cwd), which a `code !== 0` check alone misses.
  const r = await git(['ls-files', '-v', '-z'], { cwd: wtPath, timeout })
    .catch((error) => ({ code: -1, stdout: '', stderr: error?.message ?? String(error) }));
  if (r.code !== 0) {
    return {
      atRisk: [], unknown: [], stamp: 'index-flags-failed',
      how: 'index-flags-failed', error: r.stderr?.trim() || `ls-files exited ${r.code}`,
    };
  }

  // THE SCAN ALLOCATES NOTHING FOR THE 99.99% OF RECORDS THAT ARE `H`, AND THAT IS THE WHOLE
  // POINT. This listing has one NUL-terminated `<tag> <path>` record per tracked file — 20,189 of
  // them in holt's own repository. The obvious `stdout.split('\0')` then slicing each record
  // costs ~100k string allocations per call and was MEASURED at +177 ms on `rm -rf node_modules`
  // (27.9 ms -> 205.3 ms), which is the annoyance axis, not a micro-optimisation: a guard that
  // stalls a fifth of a second on the most ordinary destructive-looking command in software is a
  // guard people switch off. Walking record boundaries with indexOf and testing ONE character
  // code brought it back to 30.9 ms. Only a non-`H` record is ever materialised.
  const s = r.stdout;
  const H = 72; // 'H'
  const flaggedTags = [];
  const flaggedPaths = [];
  for (let start = 0; start < s.length;) {
    let end = s.indexOf('\0', start);
    if (end < 0) end = s.length;
    if (end > start && s.charCodeAt(start) !== H) {
      const rec = s.slice(start, end);
      const sp = rec.indexOf(' ');
      const tag = sp === 1 ? rec[0] : '';
      const p = sp === 1 ? rec.slice(2) : '';
      // Lowercase = assume-unchanged (git-ls-files: "use lowercase letters for files that are
      // marked as assume unchanged"). Any tag outside the status-visible set is resolved too.
      if (tag && p && (tag !== tag.toUpperCase() || !STATUS_VISIBLE_TAGS.has(tag))) {
        flaggedTags.push(tag);
        flaggedPaths.push(p);
      }
    }
    start = end + 1;
  }

  if (!flaggedPaths.length) return { atRisk: [], unknown: [], stamp: '', how: 'ls-files-v' };

  /* ------------------------------------------------------------------------------------
   * EXISTENCE IS ASKED FIRST, AND IT IS ASKED OF THE FILESYSTEM.
   *
   * The three-outcome contract above already says it: "not on disk -> dropped … THIS IS THE
   * NEVER-ANNOYING KEYSTONE". What was wrong was the ORDER. The instrument used to run over
   * every flagged path and the disk test filtered its results afterwards, so a sparse checkout
   * — where `git sparse-checkout` sets skip-worktree on every excluded path, and NONE of those
   * paths is on disk — paid the whole instrument to answer about nothing at all. Both edges of
   * that were measured on an ordinary monorepo sparse checkout:
   *
   *   40,000 excluded paths, 65-char average   argv 2,600,000 B > ARG_MAX 2,097,152
   *       -> `spawn E2BIG` -> how:'index-flags-failed' -> the worktree is UNCLASSIFIABLE, so
   *          `rm -rf dist` answered exit 2 forever (allow -> ask, on every call, unrecoverably)
   *   12,000 excluded paths, under the ceiling
   *       -> the instrument SUCCEEDS and costs 890 ms per guarded Bash call (71 ms unpatched),
   *          against this file's own 200 ms annoyance bar, for a measurement over zero files.
   *
   * Asking the disk first makes both disappear, and it is the cheap question, not the dear one:
   * a sparse cone excludes whole DIRECTORIES, so one absent directory answers for every path
   * beneath it. MEASURED on that same 40,000-path checkout: 1 stat, 11 ms — against 518 ms for
   * a naive lstat per path and 2.6 MB of argv for the git call that no longer happens.
   *
   * THE PRUNE ONLY EVER DROPS A PATH THE FILESYSTEM POSITIVELY DENIES. ENOENT/ENOTDIR on an
   * ancestor is the one and only reason to skip; any other errno (EACCES on a parent, EIO)
   * falls through to the per-file lstat, which routes it to `unknown`. Unproven is not absent.
   * ---------------------------------------------------------------------------------- */
  /** @type {Map<string, boolean>} relative directory -> "the filesystem says it is there" */
  const dirSeen = new Map();
  const dirExists = async (rel) => {
    if (rel === '' || rel === '.') return true;
    const cached = dirSeen.get(rel);
    if (cached !== undefined) return cached;
    const slash = rel.lastIndexOf('/');
    // Shortest prefix first: an absent `apps` answers for all 40,000 paths under it with no
    // further syscall, and a present one is asked about exactly once.
    if (!(await dirExists(slash < 0 ? '' : rel.slice(0, slash)))) { dirSeen.set(rel, false); return false; }
    let there = true;
    // `stat`, not `lstat`: a symlinked directory in the path is still a directory to open(2),
    // and calling it absent would drop a real file. A dangling symlink throws ENOENT and is
    // absent, which is correct.
    try { there = (await fs.stat(path.join(wtPath, rel))).isDirectory(); }
    catch (error) { there = !(error?.code === 'ENOENT' || error?.code === 'ENOTDIR'); }
    dirSeen.set(rel, there);
    return there;
  };

  /** @type {{path:string, tag:string, st:import('node:fs').Stats|null}[]} */
  const onDisk = [];
  for (let i = 0; i < flaggedPaths.length; i++) {
    const p = flaggedPaths[i];
    const slash = p.lastIndexOf('/');
    if (slash > 0 && !(await dirExists(p.slice(0, slash)))) continue;
    try { onDisk.push({ path: p, tag: flaggedTags[i], st: await fs.lstat(path.join(wtPath, p)) }); }
    catch (error) {
      // ENOENT is the sparse-checkout case and every other "git was told not to write it out":
      // there is nothing at that path, so nothing at that path can be lost.
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue;
      onDisk.push({ path: p, tag: flaggedTags[i], st: null });   // unstattable: never dropped
    }
  }
  if (!onDisk.length) return { atRisk: [], unknown: [], stamp: '', how: 'ls-files-v' };

  // Second call, reached only for flagged paths that are ACTUALLY THERE: the index oid for
  // those and no others. `gitPathBatched` keeps the argument list under the OS ceiling however
  // many there are — see the E2BIG note in git.mjs. The answer is per-path, so the union over
  // any partition of the path list is the same answer.
  const staged = await gitPathBatched(['ls-files', '-s', '-z', '--'], onDisk.map((e) => e.path),
    { cwd: wtPath, timeout });
  if (staged.code !== 0) {
    const paths = onDisk.map((e) => e.path);
    return {
      atRisk: [], unknown: paths, stamp: `oid-unreadable:${paths.join('\0')}`,
      how: 'index-flags-failed', error: staged.stderr?.trim() || `ls-files -s exited ${staged.code}`,
    };
  }
  const indexByPath = new Map();
  for (const rec of staged.stdout.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const head = rec.slice(0, tab).split(' ');
    if (head.length < 3) continue;
    const p = rec.slice(tab + 1);
    // A non-zero stage is an unresolved merge entry, not one authoritative index identity.
    if (head[2] !== '0') indexByPath.set(p, null);
    else indexByPath.set(p, { mode: head[0], oid: head[1] });
  }

  // Only the suppressed entries that are on disk reach the stamp — a repository with none of
  // them pays for neither. No index entry for a path `ls-files -v` just listed means the two
  // calls disagree; that is an unreadable state, not a clean one.
  const present = [];
  const symlinks = [];
  const modeAtRisk = [];
  const unknown = [];
  const stampParts = [];
  for (const e of onDisk) {
    const indexed = indexByPath.get(e.path) ?? null;
    const oid = indexed?.oid ?? null;
    const mode = indexed?.mode ?? null;
    if (e.st === null) {
      unknown.push(e.path);
      stampParts.push(`${e.path}\0${e.tag}\0${mode}\0${oid}\0unstattable`);
      continue;
    }
    const fsType = e.st.isSymbolicLink() ? 'symlink'
      : (e.st.isFile() ? 'file' : (e.st.isDirectory() ? 'directory' : 'other'));
    const fsMode = (e.st.mode & 0o111) !== 0 ? 'exec' : 'plain';
    stampParts.push(`${e.path}\0${e.tag}\0${mode}\0${oid}\0${fsType}\0${fsMode}\0${e.st.size}\0${e.st.mtimeMs}`);
    if (!indexed) { unknown.push(e.path); continue; }

    if (mode === '120000') {
      if (e.st.isFile() && !e.st.isSymbolicLink()) { modeAtRisk.push(e.path); continue; }
      if (!e.st.isSymbolicLink()) { unknown.push(e.path); continue; }
      symlinks.push({ path: e.path, tag: e.tag, oid });
      continue;
    }
    if (mode === '100644' || mode === '100755') {
      if (e.st.isSymbolicLink()) { modeAtRisk.push(e.path); continue; }
      if (!e.st.isFile()) { unknown.push(e.path); continue; }
      if (process.platform !== 'win32') {
        const executable = (e.st.mode & 0o111) !== 0;
        if (executable !== (mode === '100755')) { modeAtRisk.push(e.path); continue; }
      }
      present.push({ path: e.path, tag: e.tag, oid });
      continue;
    }

    // Gitlinks and future index modes are not ordinary worktree blobs. Without a recursive
    // repository-aware instrument Holt cannot prove them unchanged, so they are unknown.
    unknown.push(e.path);
  }

  const stamp = stampParts.join('\n');
  const atRisk = [...modeAtRisk];

  if (symlinks.length) {
    const content = new Map();
    try {
      await catFileBatch([...new Set(symlinks.map((e) => e.oid))], { cwd: wtPath }, (oid, bytes) => {
        if (Buffer.isBuffer(bytes)) content.set(oid, bytes);
      });
      for (const entry of symlinks) {
        const indexBytes = content.get(entry.oid);
        if (!indexBytes) { unknown.push(entry.path); continue; }
        try {
          const target = Buffer.from(await fs.readlink(path.join(wtPath, entry.path), { encoding: 'buffer' }));
          if (!target.equals(indexBytes)) atRisk.push(entry.path);
        } catch {
          unknown.push(entry.path);
        }
      }
    } catch {
      unknown.push(...symlinks.map((entry) => entry.path));
    }
  }

  if (!present.length) return { atRisk, unknown: [...new Set(unknown)], stamp, how: 'ls-files-v' };

  // `filter=<driver>` is executable semantics, not merely text normalisation. The configured
  // clean/process command is deliberately disabled at the process boundary, which means Holt can
  // no longer prove whether its output would equal the index blob. Ask only for the effective
  // ATTRIBUTE (git check-attr never runs the driver), mark those paths unmeasured, and hash the
  // remaining paths through Git's builtin conversion pipeline. A failed attribute query taints
  // every candidate; silence from a broken classifier is never a clean answer.
  const filterAttrs = await filterAttributedPaths(wtPath, present.map((entry) => entry.path), { timeout });
  if (filterAttrs.error) {
    return {
      atRisk,
      unknown: [...new Set([...unknown, ...present.map((entry) => entry.path)])],
      stamp,
      how: 'ls-files-v',
      error: `filter attribute evidence is unmeasured: ${filterAttrs.error}`,
    };
  }
  const filterDependent = filterAttrs.paths;
  if (filterDependent.size) unknown.push(...filterDependent);
  const hashable = present.filter((entry) => !filterDependent.has(entry.path));
  if (!hashable.length) {
    return {
      atRisk,
      unknown: [...new Set(unknown)],
      stamp,
      how: 'ls-files-v',
      error: `${filterDependent.size} path(s) have an external filter attribute; Holt did not execute it`,
    };
  }

  // One batched hash-object for every suppressed file that is actually on disk, split across as
  // many spawns as the argument-list ceiling requires. `--` and the absolute paths keep a path
  // that begins with `-` from being read as an option.
  const hashed = await gitPathBatched(['hash-object', '--'],
    hashable.map((e) => path.join(wtPath, e.path)), { cwd: wtPath, timeout });
  if (hashed.code !== 0) {
    // The instrument failed. Absence of evidence is not evidence of absence: every file it was
    // asked about is unknown, not clean.
    return {
      atRisk, unknown: [...new Set([...unknown, ...hashable.map((e) => e.path)])], stamp,
      how: 'index-flags-hash-failed', error: hashed.stderr?.trim() || `hash-object exited ${hashed.code}`,
    };
  }
  const oids = hashed.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  if (oids.length !== hashable.length) {
    return {
      atRisk, unknown: [...new Set([...unknown, ...hashable.map((e) => e.path)])], stamp,
      how: 'index-flags-hash-failed',
      error: `hash-object returned ${oids.length} oid(s) for ${hashable.length} path(s)`,
    };
  }

  for (let i = 0; i < hashable.length; i++) {
    if (oids[i] !== hashable[i].oid) atRisk.push(hashable[i].path);
  }
  return {
    atRisk: [...new Set(atRisk)], unknown: [...new Set(unknown)], stamp, how: 'ls-files-v',
    error: filterDependent.size
      ? `${filterDependent.size} path(s) have an external filter attribute; Holt did not execute it`
      : undefined,
  };
}

/**
 * @param {string} wtPath
 * @param {string[]} paths
 * @param {{ timeout?: number, drivers?: string[] }} [opts]
 */
async function filterAttributedPaths(wtPath, paths, { timeout, drivers } = {}) {
  if (!paths.length) return { paths: new Set(), error: null };
  const checked = await gitPathBatched(['check-attr', '-z', 'filter', '--'], paths,
    { cwd: wtPath, timeout });
  if (checked.code !== 0) {
    return {
      paths: new Set(),
      error: checked.stderr?.trim() || `git check-attr exited ${checked.code}`,
    };
  }
  const fields = checked.stdout.split('\0');
  const filtered = new Set();
  const configured = drivers ? new Set(drivers) : null;
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const [file, attribute, value] = fields.slice(i, i + 3);
    if (attribute !== 'filter') continue;
    if (value && value !== 'unspecified' && value !== 'unset'
      && (!configured || configured.has(value))) filtered.add(file);
  }
  return { paths: filtered, error: null };
}

/**
 * External clean/process semantics can make a raw-index-equal file dirty, or a raw-different file
 * clean. Once those programs are disabled, status alone cannot distinguish either direction.
 * Enumerate every tracked pathname only when the exact status preflight found such a program,
 * then retain only regular on-disk paths whose effective attribute selects that driver.
 *
 * @param {string} wtPath
 * @param {string[]} drivers
 * @param {{ timeout?: number }} [opts]
 */
async function trackedExternalFilterPaths(wtPath, drivers, { timeout } = {}) {
  if (!drivers.length) return { paths: [], error: null };
  const listed = await git(['ls-files', '-z'], { cwd: wtPath, timeout });
  if (listed.code !== 0) {
    return {
      paths: [], error: listed.stderr?.trim() || `git ls-files exited ${listed.code}`,
    };
  }
  const tracked = splitNul(listed.stdout);
  const attributed = await filterAttributedPaths(wtPath, tracked, { timeout, drivers });
  if (attributed.error) return { paths: [], error: attributed.error };

  const paths = [];
  await pmap([...attributed.paths], async (file) => {
    try {
      const st = await fs.lstat(path.join(wtPath, file));
      // Git does not feed symlink targets or gitlinks through content filters. Everything else is
      // retained conservatively if its filesystem type changed underneath the tracked entry.
      if (!st.isSymbolicLink() && !st.isDirectory()) paths.push(file);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') paths.push(file);
    }
  }, 16);
  return { paths: paths.sort(), error: null };
}

/**
 * Tags `git ls-files -v` prints for entries `git status` still reports on. See indexFlagDelta().
 * H tracked/normal · M unmerged · R unstaged removal · C unstaged change · U resolve-undo ·
 * K checkout conflict · ? untracked.
 */
const STATUS_VISIBLE_TAGS = new Set(['H', 'M', 'R', 'C', 'U', 'K', '?']);

/**
 * UNCOMMITTED delta: the layer no git relationship command can see.
 *
 * @param {string} wtPath
 * @param {{timeout?: number}} opts
 * @returns {Promise<{files:string[], untracked:string[], unmeasured:string[], how:string,
 *   error?:string}>} `unmeasured` is present on EVERY branch, including the failure ones: a
 *   caller that has to decide "was this layer measured" must never have to test for the field's
 *   existence as well as its contents.
 */
async function uncommittedDelta(wtPath, { timeout }) {
  const [status, flags] = await Promise.all([
    git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: wtPath, timeout }),
    // The filter git applied to the answer above, measured rather than assumed. See
    // indexFlagDelta(): without it a `--skip-worktree` credentials file is reported as clean.
    indexFlagDelta(wtPath, { timeout }),
  ]);
  if (status.code !== 0) {
    return { files: [], untracked: [], unmeasured: [], how: 'status-failed', error: status.stderr.trim() };
  }

  const files = [];
  const untracked = [];
  const parts = status.stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    const xy = entry.slice(0, 2);
    const p = entry.slice(3);
    if (!p) continue;
    if (xy[0] === 'R' || xy[0] === 'C') i++; // consume rename source
    if (xy === '??') untracked.push(p);
    else files.push(p);
  }

  // Status was intentionally computed with repository filter programs disabled. For paths whose
  // effective attributes request one of those programs, the conservative modified-path result is
  // retained, but equivalence to the index remains unmeasured and is named as such. `check-attr`
  // reads attribute data only; it never launches the configured clean/process command.
  const statusFilterAttrs = await trackedExternalFilterPaths(
    wtPath, status.externalCheckinFilterDrivers ?? [], { timeout },
  );
  const statusFilterUnknown = statusFilterAttrs.paths;

  if (statusFilterAttrs.error) {
    return {
      files, untracked, unmeasured: [...new Set([...flags.unknown, ...files])],
      how: 'index-flags-failed',
      error: `filter attribute evidence is unmeasured: ${statusFilterAttrs.error}`,
    };
  }

  // A BROKEN FILTER-READER IS NOT A CLEAN FILTER. If `ls-files` could not run, holt does not
  // know what status was allowed to tell it, and the scan must refuse to classify rather than
  // publish an answer it cannot stand behind — the same rule committedDelta already follows.
  if (flags.how !== 'ls-files-v') {
    return {
      files, untracked, unmeasured: [...new Set([...flags.unknown, ...statusFilterUnknown])],
      how: 'index-flags-failed', error: flags.error ?? flags.how,
    };
  }

  return {
    files: [...new Set([...files, ...flags.atRisk])],
    untracked,
    unmeasured: [...new Set([...flags.unknown, ...statusFilterUnknown])],
    how: 'status+diff-HEAD',
    error: statusFilterUnknown.length
        ? `${statusFilterUnknown.length} tracked path(s) use an external filter attribute; Holt did not execute it`
        : undefined,
  };
}

/**
 * Paths that are noise in every repo. Small and conservative on purpose.
 *
 * DIRECTORIES ARE DECLARED AS NAMES, NOT AS HAND-WRITTEN REGEXES, because the anchor is where
 * the bug was. Every entry here used to read `(^|\/)node_modules\//` — anchored on a trailing
 * slash, so it matched paths INSIDE the directory and never the directory entry itself. Git
 * prints the bare entry whenever what it found is not a directory it can descend into: a SYMLINK
 * (`node_modules -> ../../node_modules`, what pnpm and every linked monorepo produce) or a plain
 * file of that name. `.gitignore` carries the identical trailing-slash rule, so `node_modules/`
 * does not match the symlink either, git reports it untracked, and holt counted a 29-byte pointer
 * as work found nowhere else. Measured on holt's own repository: 8 of 10 worktrees were reported
 * "AT RISK — delete these and the work is gone" on that basis alone.
 *
 * Compiling the anchor in ONE place makes the mistake unavailable rather than merely corrected —
 * a name added to this list cannot be written with the wrong anchor, and the guard test named
 * 'at-risk set: every generated DIRECTORY is recognised bare' walks every name in every form.
 */
/**
 * THE RULE FOR THIS LIST, stated because getting it wrong destroys work.
 *
 * A directory belongs here only if its contents are REPRODUCIBLE BY A COMMAND from something else
 * in the repository — `npm ci` rebuilds node_modules, `cargo build` rebuilds target, a bundler
 * rebuilds dist. Losing them costs a rebuild. Nothing else qualifies, because everything on this
 * list is INVISIBLE to gate, rescue, risk, clean and the pre-tool-use guard: a worktree whose only
 * content sits here reads as byte-identical to an empty one.
 *
 * `vendor` WAS ON THIS LIST AND IS NOT REPRODUCIBLE. Go's `go mod vendor` regenerates it; a PHP
 * project's composer vendor is regenerable; but hand-vendored and hand-PATCHED dependencies are
 * the reason `vendor/` exists in most repositories that have one, and holt cannot tell which kind
 * it is looking at. Reproduced end to end: a worktree whose only content was
 * `vendor/patch.txt` reported "✓ disposable", `rescue` reported "nothingToRescue", the guard
 * ALLOWED `git worktree remove --force`, and after the removal the content existed in no git
 * object anywhere — permanently gone, with holt having said three times that there was nothing
 * there. That is the single catastrophic output this product exists to prevent.
 *
 * When in doubt a directory does NOT belong here. The cost of leaving one off is that a worktree
 * carrying only build output is not auto-reclaimed; the cost of putting one on wrongly is the
 * paragraph above.
 */
const GENERATED_DIRS = [
  'node_modules', '.git', 'target', 'dist', 'build', '__pycache__', '.venv', 'venv',
  '.next', 'coverage', '.pytest_cache', '.AppleDouble', '.idea', '.turbo',
  '.parcel-cache', '.gradle', '.terraform', '.tox',
  '.mypy_cache', '.ruff_cache',
];

/*
 * REMOVED, AND WHY — the rule above, applied to itself a second time.
 *
 * `tmp`, `temp`, `log`, `logs` and `.cache` were on this list and NONE of them is reproducible by
 * a command. They are conventional scratch names, and conventional scratch is exactly where people
 * put things that are not scratch. Both were reproduced end to end, with the loss verified rather
 * than assumed:
 *
 *   a hand-written logs/incident-postmortem.md   -> gate said "✓ disposable", the hook said allow,
 *                                                   `rm -rf` destroyed it, and `git fsck
 *                                                   --unreachable` found nothing, because the
 *                                                   content had never been a git object at all
 *   services/billing/tmp/reconciliation-notes.txt -> same, and `holt rescue` — the documented
 *                                                   escape hatch — returned nothingToRescue and
 *                                                   exited 0, inviting the deletion
 *
 * `.log` came off GENERATED_FILES for the same reason and by the same evidence (a top-level
 * decision.log was destroyed in the second reproduction).
 *
 * THE COST IS ACKNOWLEDGED: a worktree whose only content is a stray build log is no longer
 * auto-reclaimed. That is the correct trade. A worktree carrying only node_modules or dist is
 * still reclaimed, which is what keeps `clean` useful, and those two ARE reproducible — `npm ci`
 * and a build rebuild them. Losing a rebuild costs minutes; the paragraph above costs the work.
 *
 * This is the second time this list has destroyed real data (the first was `vendor`). The rule is
 * not "does this look like noise", it is "can a command in this repository recreate it".
 */

/**
 * Files, matched on their own terms.
 *
 * OS and editor droppings, and plainly regenerable output. Without these, a single .DS_Store —
 * created by merely opening a folder in Finder — would make every worktree on a Mac permanently
 * unclearable, which is the "safety that freezes the tool" failure mode.
 *
 * Dependency manifests are here too. A lockfile records what a resolver decided, not what an
 * agent wrote. Left in, they contribute thousands of package-name "symbols" — measured on a real
 * repo, producing findings like `object:node_modules/@ts-morph/common` presented as unique work.
 */
const GENERATED_FILES = [
  // `*.log` STAYS, and the split from the directory names above is deliberate rather than
  // inconsistent. A path SEGMENT named `logs` or `tmp` says nothing about provenance — people put
  // postmortems in logs/ and drafts in tmp/, which is how a hand-written
  // logs/incident-postmortem.md was destroyed. A file EXTENSION of `.log` is conventionally
  // machine-written, and the never-worse test pins the cost of pretending otherwise: `rm app.log`
  // became a refusal, which is daily friction on a daily action and exactly how a guard gets
  // uninstalled.
  //
  // The residual risk is named rather than hidden: content deliberately saved as `notes.log` is
  // invisible to holt. That is a worse trade to fix than to accept.
  /\.min\.(js|css)$/, /\.log$/,
  /(^|\/)\.DS_Store$/, /(^|\/)Thumbs\.db$/, /(^|\/)desktop\.ini$/,
  /\.lock$/, /(^|\/)package-lock\.json$/, /(^|\/)yarn\.lock$/, /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)Cargo\.lock$/, /(^|\/)poetry\.lock$/, /(^|\/)composer\.lock$/, /(^|\/)Gemfile\.lock$/,
  /(^|\/)go\.sum$/, /(^|\/)Pipfile\.lock$/, /(^|\/)gradle\.lockfile$/, /(^|\/)packages\.lock\.json$/,
];

/** A directory matches as the entry ITSELF (`x`, `a/x`) and as everything under it (`x/y`). */
const dirPattern = (name) =>
  new RegExp(`(^|/)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/|$)`);

const GENERATED = [...GENERATED_DIRS.map(dirPattern), ...GENERATED_FILES];

export { GENERATED_DIRS };

/**
 * THE COMMAND THAT RECREATES A GENERATED DIR, AS EVIDENCE IT EXISTS.
 *
 * The comment block above GENERATED_DIRS states the rule this list has now violated three times
 * (`vendor/`, then `logs/`+`tmp/`, now `build/`): "The rule is not 'does this look like noise',
 * it is 'can a command in this repository recreate it'" — and nothing ever checked for the
 * command. Reproduced end to end: a repo with NO build system, a hand-placed
 * `build/only.js`, `gate` printing "✓ disposable", `clean --apply` removing the worktree, and
 * `git fsck` finding nothing, because the content was never a git object. The directory's NAME
 * was the entire verdict, and names are exactly what this product exists to distrust.
 *
 * So each conditional name earns disposal from the MANIFEST whose install/build step recreates
 * it, checked per worktree root. `node_modules` is reproducible where package.json exists;
 * `target` where Cargo.toml (or a JVM build file) does; a bare `build/` in a repo with no build
 * system is just a directory somebody named build. `null` marks the unconditional entries —
 * `.git` (structural), OS/IDE droppings — which are machine-managed wherever they appear.
 *
 * THE NEVER-WORSE HALF IS PINNED TOO: with the manifest present, everything here stays
 * reclaimable — the monster fixture's worktree full of real build junk still cleans. Losing a
 * rebuild costs minutes; the alternative costs the work.
 */
const JS_MANIFESTS = ['package.json'];
const PY_MANIFESTS = ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile'];
const JVM_MANIFESTS = ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'];
const GENERATOR_MANIFESTS = {
  '.git': null,
  '.AppleDouble': null,
  '.idea': null,
  node_modules: JS_MANIFESTS,
  '.next': JS_MANIFESTS,
  '.turbo': JS_MANIFESTS,
  '.parcel-cache': JS_MANIFESTS,
  dist: [...JS_MANIFESTS, ...PY_MANIFESTS],
  build: [...JS_MANIFESTS, ...JVM_MANIFESTS, 'CMakeLists.txt', 'Makefile', 'meson.build'],
  target: ['Cargo.toml', ...JVM_MANIFESTS],
  coverage: [...JS_MANIFESTS, ...PY_MANIFESTS],
  __pycache__: PY_MANIFESTS,
  '.venv': PY_MANIFESTS,
  venv: PY_MANIFESTS,
  '.pytest_cache': PY_MANIFESTS,
  '.mypy_cache': PY_MANIFESTS,
  '.ruff_cache': PY_MANIFESTS,
  '.tox': ['tox.ini', ...PY_MANIFESTS],
  '.gradle': JVM_MANIFESTS,
  '.terraform': ['*.tf'],
};

/**
 * Which generated-dir names have their recreating command PRESENT in this worktree.
 * One readdir of the worktree root answers every manifest question at once.
 */
export async function generatedEvidence(wtPath) {
  let names = [];
  try { names = await fs.readdir(wtPath); } catch { /* unreadable root: no evidence, keep all conditional dirs protected */ }
  const present = new Set(names);
  const anyTf = names.some((n) => n.endsWith('.tf'));
  const active = new Set();
  for (const [dir, manifests] of Object.entries(GENERATOR_MANIFESTS)) {
    if (manifests === null) { active.add(dir); continue; }
    if (manifests.some((m) => (m === '*.tf' ? anyTf : present.has(m)))) active.add(dir);
  }
  return active;
}

const UNCONDITIONAL_DIR_RES = Object.entries(GENERATOR_MANIFESTS)
  .filter(([, m]) => m === null).map(([d]) => dirPattern(d));
const CONDITIONAL_DIR_RE = new Map(Object.entries(GENERATOR_MANIFESTS)
  .filter(([, m]) => m !== null).map(([d]) => [d, dirPattern(d)]));
/**
 * Scratch-named directories, treated as noise ONLY when the repository has gitignored them.
 *
 * These are deliberately NOT in GENERATED_DIRS. A path segment called `logs` or `tmp` proves
 * nothing about what is inside it — that assumption destroyed a hand-written incident postmortem.
 * But when the project's own .gitignore names the path, someone has stated it is not source, and
 * that statement is evidence in a way the folder name never was. See ignoredContent().
 */
const SCRATCH_WHEN_IGNORED = /(^|\/)(tmp|temp|log|logs|\.cache)(\/|$)/;

/**
 * @param {string} p
 * @param {Set<string>} [activeDirs]  the generated-dir names whose recreating manifest exists in
 *   the worktree under judgment (from generatedEvidence()). WITHOUT it, every name counts — the
 *   pre-evidence behaviour, kept for callers with no worktree in hand. WITH it, a conditional
 *   name matches only when its manifest was seen: `build/only.js` in a repo with no build system
 *   is not noise, it is the only copy of somebody's work wearing a noisy name.
 */
export function looksGenerated(p, activeDirs) {
  if (activeDirs === undefined) return GENERATED.some((re) => re.test(p));
  if (GENERATED_FILES.some((re) => re.test(p))) return true;
  if (UNCONDITIONAL_DIR_RES.some((re) => re.test(p))) return true;
  for (const d of activeDirs) {
    const re = CONDITIONAL_DIR_RE.get(d);
    if (re && re.test(p)) return true;
  }
  return false;
}

/**
 * TEST FIXTURE DETECTION — test files and fixtures counted as production code.
 *
 * WHY THIS EXISTS. holt's metrics count every touched file as production code, so a workstream
 * that added 200 test fixtures and 3 source files reported 203 "symbols" and a risk score
 * driven by the fixtures. The ROI was inflated (test churn read as productive work) and the
 * risk score was wrong (a test fixture that exists nowhere else is not the same risk class as
 * a source file that exists nowhere else). A tool whose whole job is "what did this workstream
 * actually contribute" cannot answer that question while test scaffolding reads as authorship.
 *
 * DETECTION is by CONVENTION, not by content: the directories and file patterns the ecosystem
 * has converged on (test/, tests/, __tests__, spec/, specs/, *.test.*, *.spec.*, *_test.*).
 * Content-based detection ("this file has `assert` in it") is exactly the kind of heuristic
 * that misclassifies a source file that happens to validate its inputs, so it is not used.
 *
 * NOT FILTERED OUT BY DEFAULT. A test file CAN hold the only copy of something (a fixture that
 * documents a bug, a regression test that is itself the spec), so holt does not silently drop
 * them from the at-risk set the way it drops node_modules/. Instead they are FLAGGED —
 * `isTestFile` on the path — so the analysis can report "test fixtures dominate this workstream"
 * and the user can decide whether the risk is real. This is the same principle GENERATED_DIRS
 * follows: name the provenance, let the verdict use it.
 */

/** Directory segments that conventionally hold test code. */
const TEST_DIR_SEGMENTS = new Set([
  'test', 'tests', '__tests__', '__test__', 'spec', 'specs', '__specs__',
]);

/** File patterns that conventionally mark a test file. */
const TEST_FILE_PATTERNS = [
  /\.test\.[A-Za-z0-9]+$/,
  /\.spec\.[A-Za-z0-9]+$/,
  /_test\.[A-Za-z0-9]+$/,
  /(^|\/)test_[A-Za-z0-9_]+\.[A-Za-z0-9]+$/,  // Python: test_foo.py
  /(^|\/)[A-Za-z0-9_]+_test\.[A-Za-z0-9]+$/,  // Go/Rust: foo_test.go
];

/**
 * Is `p` a test file or fixture, by conventional directory or file-name pattern?
 *
 * Pure and exported so the analysis layer and the CLI agree on what counts as a test — a
 * second copy of this rule drifts, and the "test fixtures dominate" warning is the one a user
 * acts on, so it must come from one place.
 *
 * @param {string} p  a repo-relative or absolute path
 * @returns {boolean}
 */
export function isTestFile(p) {
  if (!p) return false;
  // Directory segment match: any path containing a test-dir segment is a test file.
  const segs = String(p).split(/[/\\]/);
  for (const s of segs) {
    if (TEST_DIR_SEGMENTS.has(s)) return true;
  }
  // File-name pattern match.
  const base = segs[segs.length - 1];
  for (const re of TEST_FILE_PATTERNS) {
    if (re.test(base)) return true;
  }
  return false;
}

/**
 * How many of `paths` are test files, and does that dominate?
 *
 * "Dominates" = more than half of the touched files are test files. That is the threshold at
 * which the risk score and ROI are materially wrong: below it, test files are a minority and
 * the production-code majority drives the verdict; above it, the verdict is driven by fixtures.
 *
 * @param {string[]} paths
 * @returns {{ testCount: number, totalCount: number, testFraction: number, dominates: boolean, testPaths: string[] }}
 */
export function testFixtureProfile(paths) {
  const testPaths = (paths ?? []).filter(isTestFile);
  const totalCount = (paths ?? []).length;
  const testCount = testPaths.length;
  const testFraction = totalCount > 0 ? testCount / totalCount : 0;
  return {
    testCount,
    totalCount,
    testFraction,
    dominates: totalCount > 0 && testCount > totalCount / 2,
    testPaths,
  };
}

/**
 * THE AT-RISK FILE SET, in one place.
 *
 * The files in a scanned workstream whose content exists ONLY on disk: nothing in git holds them,
 * so removing or emptying the file destroys the only copy. Three layers, and the reason each is
 * in and `committed` is out:
 *
 *   uncommitted.files      tracked, modified — the MODIFICATION exists nowhere else
 *   uncommitted.untracked  untracked        — the whole file exists nowhere else
 *   ignored.files          gitignored       — git cannot see it, so holt cannot prove anything
 *                                             about it, and `clean --apply` already learned what
 *                                             deleting it costs
 *   committed.files        EXCLUDED         — a commit holds the content; `rm` of one is
 *                                             recoverable, so denying it would be pure noise
 *
 * No pathname convention removes evidence from this set. `node_modules/`, `dist/`, lockfiles and
 * logs can contain hand edits or incident evidence; a name or manifest is not a recovery proof.
 * The command guard may use generated-looking names to choose ASK rather than DENY, but it must
 * first retain the paths here so cleanup can never become a silent ALLOW.
 */
export function atRiskFiles(ws) {
  if (!ws || !ws.ok) return [];
  const uncommitted = (ws.uncommitted?.files ?? []).filter(Boolean);
  const untracked = (ws.uncommitted?.untracked ?? []).filter(Boolean);
  const ignored = (ws.ignored?.files ?? []).filter(Boolean);
  return [...new Set([...uncommitted, ...untracked, ...ignored])];
}

/**
 * The same set, read straight from one `git status --porcelain=v1 -z --untracked-files=all
 * --ignored=matching` run instead of from a completed scan.
 *
 * WHY BOTH EXIST. atRiskFiles() is the authority and carries the full analysis with it, but
 * producing it costs a scan. A pre-tool hook runs in the agent's critical path on every single
 * shell command, so the guard needs a way to answer "is this path even interesting?" for the
 * common case — `rm -rf node_modules` — without paying for one. This parses the identical raw
 * status evidence, without a pathname filter, so the two cannot drift apart on what counts as at
 * risk — and the test named 'FILE GATE: the fast probe and scan.mjs agree on what
 * is at risk' walks every file atRiskFiles() reports and asserts the guard refuses to lose it,
 * because a probe that saw LESS than the scan would silently re-open the hole.
 *
 * @returns {Map<string,'uncommitted'|'untracked'|'gitignored'>} path -> which layer it is in
 */
export function atRiskFromStatus(stdoutZ, _activeDirs) {
  const out = new Map();
  const parts = String(stdoutZ ?? '').split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry || entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const p = entry.slice(3);
    if (!p) continue;
    // A rename entry is followed by its source path; consume it so it is not read as an entry.
    if (xy[0] === 'R' || xy[0] === 'C') i++;
    if (xy === '!!') out.set(p, 'gitignored');
    else if (xy === '??') out.set(p, 'untracked');
    else out.set(p, 'uncommitted');
  }
  return out;
}

/**
 * Remove collapsed ignored-directory markers that contain no filesystem object Git could
 * capture. Git status reports an ignored directory as one trailing-slash entry whether it
 * contains a unique file or is completely empty. Treating both as a file produced an impossible
 * remediation loop: Holt claimed an empty directory held sole-copy bytes, while discard and
 * rescue correctly said a Git tree cannot represent it.
 *
 * This walks only directory markers and stops at the first non-directory entry. Symlinks and
 * special entries stay protected; unreadable or racing paths stay protected too. Only a fully
 * measured tree containing directories and nothing else is omitted.
 */
async function ignoredDirectoryContentState(abs, depth = 0) {
  if (depth > 256) return 'unknown';
  let dir;
  try {
    dir = await fs.opendir(abs);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return 'empty';
    return 'unknown';
  }
  try {
    for await (const entry of dir) {
      if (!entry.isDirectory()) return 'content';
      const child = await ignoredDirectoryContentState(path.join(abs, entry.name), depth + 1);
      if (child !== 'empty') return child;
    }
    return 'empty';
  } catch {
    return 'unknown';
  }
}

export async function omitEmptyIgnoredDirectories(wtPath, entries) {
  const kept = [];
  for (const entry of entries) {
    if (!String(entry).endsWith('/')) {
      kept.push(entry);
      continue;
    }
    const rel = String(entry).replace(/\/+$/, '');
    const abs = path.join(wtPath, ...rel.split('/'));
    if (await ignoredDirectoryContentState(abs) !== 'empty') kept.push(entry);
  }
  return kept;
}


/**
 * Gitignored content a worktree is carrying.
 *
 * holt's analysis is built on git's view, and git deliberately does not track ignored files — so
 * holt cannot prove anything about them. That is fine for ANALYSIS, and it is stated as a limit.
 * It is NOT fine for DELETION: a worktree whose only extra content is a `.env` full of live
 * credentials, or a node_modules with a hand-applied patch, was being called "provably nothing to
 * lose" and removed. Absence of evidence is not evidence of absence — the same rule the rest of
 * this file follows.
 *
 * Ignored content is retained in full, including recognisable build output. `.gitignore` says Git
 * should not track a path; it does not prove the current bytes can be recreated. Usability is
 * handled at the command boundary, where an all-generated-looking deletion asks for confirmation
 * instead of issuing a confident denial. The worktree itself is never called disposable on a
 * naming guess.
 */
async function ignoredContent(wtPath, { timeout, activeDirs }) {
  const r = await git(['status', '--porcelain', '-z', '--ignored=matching', '--untracked-files=all'],
    { cwd: wtPath, timeout });
  if (r.code !== 0) return { files: [], how: 'ignored-probe-failed', error: r.stderr?.trim() };
  const files = [];
  for (const entry of r.stdout.split('\0')) {
    if (!entry || entry.length < 4) continue;
    if (entry.slice(0, 2) !== '!!') continue;      // '!!' marks an ignored path
    const p = entry.slice(3);
    // `.gitignore` IS NOT A PROVENANCE OR REPRODUCIBILITY CERTIFICATE. It can hide generated
    // output, local credentials, a patched dependency, or an incident log; none of those names
    // tells us whether these exact bytes exist anywhere else. Keep every reported path. Generated
    // evidence remains advisory metadata for the interactive command verdict only.
    if (!p) continue;
    // A TRAILING SLASH IS A DIRECTORY, AND SKIPPING IT DESTROYED REAL DATA.
    //
    // When .gitignore names a directory (`secrets/`), git's --ignored=matching collapses the whole
    // subtree to the ONE entry `secrets/` and never lists the files inside it. Dropping that entry
    // therefore erased the entire subtree from the verdict, and a worktree whose only unique
    // content was `secrets/prod.env` was reported as holding nothing base lacks — so
    // the older, destructive `holt clean --apply` deleted the only copy of live credentials.
    // Reproduced 40/40 before clean was changed to recoverable quarantine.
    //
    // The directory IS the evidence. It is kept, with its slash, so the verdict downgrades to
    // "holt cannot verify this" exactly as it does for an ignored file. That applies equally to
    // node_modules/, dist/ and caches: ordinary cleanup can be confirmed, but worktree deletion
    // cannot assume their bytes are reproducible.
    files.push(p);
  }
  // A non-empty collapsed directory remains evidence. An empty directory tree contains no bytes,
  // symlink target, or special entry to lose, so it must not be reported as a changed file.
  const nonEmpty = await omitEmptyIgnoredDirectories(wtPath, files);
  return { files: nonEmpty.sort(), how: 'status --ignored', error: undefined };
}

/** Phase 1: file-level deltas for one workstream. */
async function scanFiles(ws, ctx) {
  const { root, base, strictReadOnly, timeout } = ctx;

  const result = {
    ...ws,
    ok: false,
    reason: null,
    committed: { files: [], count: 0, how: 'not-run' },
    uncommitted: { files: [], untracked: [], count: 0, how: 'not-run' },
    touched: [],
    added: [],
    addedKeys: [],
    stats: { committedFiles: 0, uncommittedFiles: 0, untrackedFiles: 0, addedSymbols: 0 },
  };

  if (ws.prunable) {
    result.reason = `prunable: ${ws.prunableReason || 'working tree is gone'}`;
    return result;
  }
  if (!ws.path || !(await pathUsable(ws.path))) {
    result.reason = 'working directory missing or unreadable';
    return result;
  }

  // A jj workspace has no .git of its own, so `rev-parse HEAD` there fails. Its head arrives
  // pre-resolved from src/jj.mjs as the git commit id of `<name>@`.
  const headOid = ws.head ?? (ws.vcs === 'jj' ? null : await resolveRef(ws.path, 'HEAD'));
  if (!headOid) {
    result.reason = ws.vcs === 'jj'
      ? 'jj workspace commit could not be resolved (is this a colocated repo?)'
      : 'HEAD does not resolve (unborn branch?)';
    return result;
  }
  result.head = headOid;

  try {
    // Which generated-dir names have their recreating manifest in THIS worktree — one readdir,
    // shared by every layer below and carried on the result for downstream consumers, so the
    // scan and the guard cannot disagree about what counts as noise here.
    const activeDirs = await generatedEvidence(ws.path);
    result.generatedActive = [...activeDirs];

    const [committed, uncommitted, ignored] = await Promise.all([
      committedDelta(root, base.oid, headOid, { strictReadOnly, timeout }),
      // jj snapshots the working copy into `@` automatically, so under jj there IS no separate
      // uncommitted layer — the thing git cannot relate across worktrees simply does not exist.
      // Asking git for status inside a jj workspace would fail (no .git) and, worse, a failure
      // there would read as "clean".
      ws.vcs === 'jj'
        ? Promise.resolve({ files: [], untracked: [], unmeasured: [], how: 'jj-snapshot (working copy is part of @)', error: undefined })
        : uncommittedDelta(ws.path, { timeout }),
      // Ignored content cannot be analysed, but it CAN be destroyed — so it must be seen.
      ws.vcs === 'jj'
        ? Promise.resolve({ files: [], how: 'n/a (jj)', error: undefined })
        : ignoredContent(ws.path, { timeout, activeDirs }),
    ]);

    // FAIL-CLOSED ON INSTRUMENT FAILURE. Found by probing partial (blobless) clones: when
    // merge-tree cannot run — offline promisor remote, pruned objects, corrupt odb — it returns
    // an EMPTY file list, which is indistinguishable downstream from "no committed delta". A
    // worktree with committed-ahead work and a clean working tree would then be reported SAFE,
    // and the older destructive clean implementation would delete it. An empty answer from a
    // broken instrument is not an
    // answer (Law: prove the instrument can detect presence before trusting its silence).
    const committedFailed = [
      'merge-tree-failed', 'merge-tree-no-tree', 'merge-tree-names-failed',
      'merge-tree-external-driver-refused', 'three-dot-failed',
    ]
      .includes(committed.how);
    // `index-flags-failed` joins `status-failed` here rather than getting its own branch: both
    // mean "the working-tree layer was not measured", and the only safe reading of an unmeasured
    // layer is UNKNOWN. See indexFlagDelta() — `git status` answers through a per-path filter,
    // so a status run whose filter could not be read is an unread instrument, not a clean one.
    const statusFailed = uncommitted.how === 'status-failed' || uncommitted.how === 'index-flags-failed';
    if (committedFailed || statusFailed) {
      result.reason = committedFailed
        ? `committed-delta instrument failed (${committed.how}: ${committed.error ?? 'unknown'}) — refusing to classify`
        : `${uncommitted.how === 'index-flags-failed' ? 'index-flag' : 'status'} instrument failed (${uncommitted.error ?? 'unknown'}) — refusing to classify`;
      return result; // ok stays false -> UNKNOWN -> never safe, never cleaned
    }

    // DESTRUCTIVE AUTHORITY RETAINS EVERY PATH GIT REPORTED. A filename, manifest or ignore rule
    // can rank likely build output, but none proves the bytes are reproducible. In particular,
    // tracked lockfile edits, hand-authored dist files and gitignored incident logs have all been
    // reproduced as the only copy of real work. Filtering them here made scan, gate, rescue,
    // clean and the guard agree on a false empty answer.
    const cFiles = [...committed.files];
    // `let`: holt's own untouched output is subtracted from both below. See the note there.
    let uFiles = [...uncommitted.files];
    let uUntracked = [...(uncommitted.untracked ?? [])];

    // THE SYMBOL-EXTRACTION SET IS UNCONDITIONAL, NOT MANIFEST-GATED.
    //
    // The manifest gate above protects at-risk FILES — a hand-placed `build/only.js` with no
    // build system is the only copy of somebody's work, and the at-risk set must not lose it.
    // But `touched` feeds SYMBOL EXTRACTION, and a generated-named directory is never source
    // code worth extracting symbols from — even a hand-copied `node_modules` patch is a
    // dependency, not authored work. ctags' own `--exclude=node_modules` only filters directory
    // traversal, not explicit file paths (verified: passing `node_modules/pkg/index.js` as an
    // explicit arg extracts its symbols despite `--exclude`). So `touched` is filtered with the
    // unconditional GENERATED list (no activeDirs), keeping the symbol layer clean while the
    // at-risk layers stay manifest-gated.
    // FILES HOLT ITSELF WROTE ARE NOT THE USER'S IRREPLACEABLE WORK.
    //
    // `holt setup` writes its adapter configs — .claude/settings.json, .mcp.json, AGENTS.md,
    // .cursor/hooks.json and about sixteen more — into EVERY worktree, so agents get holt wiring
    // wherever they start. Those files are untracked, and untracked was read as
    // work-existing-nowhere-else, so holt made every worktree permanently undeletable using
    // evidence it had manufactured about itself. Measured on a fresh repo:
    //
    //   before `holt setup`: gate = exit 0, disposable, 1 file
    //   after  `holt setup`: gate = exit 1, "20 uncommitted file(s), 38 symbol(s) found nowhere
    //                        else" — and those 38 symbols are holt's own config keys
    //                        (mcpServers, PreToolUse, HOLT_CMD, module.exports)
    //   git worktree remove / --force / rm -rf: ALL THREE BLOCKED. holt clean --apply: quarantines 0.
    //
    // The refusal was provably false by md5: repo/AGENTS.md and scratch/AGENTS.md were
    // byte-identical. holt was reporting "found nowhere else" about content it had duplicated
    // itself, which is this project's signature defect committed against its own user. And it is
    // self-amplifying — the more worktrees, the more undeletable ones.
    //
    // PROVENANCE IS RECORDED, NOT INFERRED. src/integrate/receipt.mjs already stores a hash for
    // every file holt writes, precisely so ownership is a fact rather than a guess about names.
    // It had zero consumers outside the uninstall path. Only MINE_UNTOUCHED is subtracted: a file
    // holt wrote and the USER HAS SINCE EDITED is the user's file now and keeps full protection,
    // and an unreadable receipt yields UNKNOWN, which protects everything (see ownershipOf).
    //
    // Subtracted HERE because `uFiles`/`uUntracked` feed both vetoes — `touchedFiles` below, which
    // becomes the symbol surface, and `result.uncommitted`, which becomes the file counts. Fixing
    // one and not the other is what leaves `holt gate` still refusing after a "fix".
    let holtOwned = new Set();
    try {
      const receipt = await readReceipt(ws.path);
      const candidates = [...new Set([...uFiles, ...uUntracked])];
      if (candidates.length) {
        const owned = await ownershipOf(ws.path, candidates, receipt);
        holtOwned = new Set([...owned].filter(([, v]) => v === 'MINE_UNTOUCHED').map(([f]) => f));
      }
    } catch {
      holtOwned = new Set();          // could not look -> subtract nothing -> protect everything
    }
    const notHoltOwned = (f) => !holtOwned.has(f);
    uFiles = uFiles.filter(notHoltOwned);
    uUntracked = uUntracked.filter(notHoltOwned);

    const touchedFiles = [...new Set([...cFiles, ...uFiles, ...uUntracked])].sort();
    // Symbol extraction is advisory analysis and may filter known dependency/build trees for
    // cost and signal quality. It is deliberately separate from `touched`, which is the full
    // collision/review/destructive surface.
    const symbolFiles = touchedFiles.filter((f) => !looksGenerated(f));

    // Text normalisation is useful duplicate-work evidence, but never destructive authority.
    // Preserve the measurement for review/diagnostics while the exact Git entry identities below
    // decide whether base or a sibling durably holds the same path, mode, type and object.
    const [lineEndingOnlyVsBaseFlag, committedIdentities] = await Promise.all([
      lineEndingOnlyVsBase(root, base.oid, committed, cFiles, { timeout }),
      committedEntryIdentities(root, base.oid, committed, cFiles, { timeout }),
    ]);

    result.ok = true;
    result.committed = {
      files: cFiles, count: cFiles.length, how: committed.how,
      conflicted: committed.conflicted, caveat: committed.caveat ?? null,
      // CARRIED THROUGH, because it is a CONTENT IDENTITY and nothing else here is.
      //
      // merge-tree already computed it and it was being discarded one line later. Two worktrees
      // whose merged trees are the same oid carry byte-identical work relative to base — which is
      // exactly the question "does a living sibling already hold this", and answering it took
      // disposable recall from 0.40 to 1.00. File LISTS cannot answer it: two worktrees can touch
      // the same paths with different content, or different paths with the same content.
      mergedTree: committed.mergedTree ?? null,
      identities: committedIdentities.entries,
      identitiesHow: committedIdentities.how,
      identitiesError: committedIdentities.error,
      // See lineEndingOnlyVsBase() above: true only when the ENTIRE committed delta disappears
      // once CRLF/CR line endings are normalised against base. This remains advisory raw
      // instrument output; it never turns into deletion authority.
      lineEndingOnlyVsBase: lineEndingOnlyVsBaseFlag,
    };
    result.uncommitted = {
      files: uFiles, untracked: uUntracked, count: uFiles.length + uUntracked.length,
      how: uncommitted.how,
      error: uncommitted.error,
      // Paths the index flagged as not-status-reported that holt could not resolve to a real
      // answer (unreadable, or not a regular file). NOT folded into `files`: an unknown is not
      // an at-risk file, and it is not a clean one either. contentAtRisk() turns it into `blind`,
      // which is what stops safeToDelete() calling the workstream disposable.
      unmeasured: uncommitted.unmeasured ?? [],
    };
    // THE FULL LIST, NOT A SAMPLE. This used to be `.slice(0, 50)` while `count` stayed the true
    // length — a list whose length disagreed with its own count. That is fine for a display
    // sample and fatal for an action: `holt rescue` has to CAPTURE every one of these paths and
    // then VERIFY each is in the resulting tree, and it cannot verify what it was never shown.
    // Callers that print take their own sample (safeToDelete slices to 3 and 10).
    result.ignored = {
      files: ignored?.files ?? [],
      count: ignored?.files?.length ?? 0,
      how: ignored?.how ?? 'not-run',
      error: ignored?.error,
    };
    result.touched = touchedFiles;
    result.symbolFiles = symbolFiles;
    result.stats = {
      committedFiles: cFiles.length,
      uncommittedFiles: uFiles.length,
      untrackedFiles: uUntracked.length,
      addedSymbols: 0,
    };

    // TEST FIXTURE PROFILE. Flagged, not filtered: a test file CAN hold the only copy of
    // something, so it stays in the at-risk set. But when test files DOMINATE the touched set
    // the risk score and ROI are materially wrong, and the analysis layer needs to say so.
    // See isTestFile()/testFixtureProfile() above for the convention-based detection.
    result.testFixture = testFixtureProfile(touchedFiles);

    // Advisory per-file content identity for symbol/duplicate analysis. Destructive redundancy
    // uses `committed.identities` above: exact Git path + mode + type + object id. These raw
    // filesystem keys must never authorise deletion.
    //
    // Keyed by path so a partial match (one of two committed files has a twin, the other does
    // not) is visible to the caller rather than forcing an all-or-nothing verdict. A file that
    // fails to read (race, permission, symlink loop) gets `null` — the safe direction, since it
    // can only make this file LESS likely to be matched, never falsely redundant.
    //
    // EVERY ADVISORY SYMBOL FILE GOES THROUGH ONE READER, AND THAT READER NEVER FOLLOWS A
    // SYMLINK. It used to be a bare
    // `fs.readFile`, which follows symlinks and hashes the RESOLVED TARGET: two worktrees each
    // committing an unrelated symlink to two DIFFERENT external files that happened to hold the same
    // bytes fingerprinted identically, `safeToDelete` called each redundantWith the other, and
    // the older destructive clean implementation would have removed the only copy.
    // `pathContentKey` (content-identity.mjs)
    // lstats first and keys a symlink by its TARGET STRING — which is exactly the blob git stores
    // for it — so identity is over what git tracks, not what the filesystem resolves.
    result.contentKeys = {};
    await pmap(result.symbolFiles, async (f) => {
      result.contentKeys[f] = await pathContentKey(path.join(ws.path, f));
    }, 6);
  } catch (err) {
    if (err instanceof GitRefused) throw err; // a refusal is a holt bug, never swallowed
    result.reason = `scan error: ${err.message}`;
  }

  return result;
}

/**
 * Scan every workstream.
 *
 * @param {{root: string|null, vcs: string|null, workstreams: any[], jj: any, error: string|null, bare?: boolean}} disc  result of discover()
 * @param {{base?: string, strictReadOnly?: boolean, concurrency?: number, timeout?: number,
 *          symbols?: boolean, includePrimary?: boolean, symbolBackend?: string}} [opts]
 */
export async function scan(disc, opts = {}) {
  if (!disc.root) {
    throw new Error(disc.bare
      ? 'holt: this is a bare repository (no working tree) — holt compares file content across '
        + 'worktrees and needs at least one checkout; run it from a normal clone instead'
      : 'holt: not a git repository');
  }

  const base = await resolveBase(disc.root, opts.base);
  // NETWORK FILESYSTEM TIMEOUT ESCALATION. When the repository root is on a detected NFS/SMB
  // mount and no explicit timeout was given, escalate the default so a slow link does not
  // become a false instrument failure. The warning is carried on the scan result so every
  // surface (CLI, MCP, TUI) can say "this verdict came through a slow link" rather than
  // silently changing the timeout. See src/git.mjs resolveTimeout().
  /** @type {{network: boolean, warning?: string}|null} */
  let networkFs = null;
  let resolvedTimeout = opts.timeout ?? 60_000;
  if (opts.timeout === undefined || opts.timeout === null) {
    const { resolveTimeout } = await import('./git.mjs');
    const rt = await resolveTimeout(disc.root);
    resolvedTimeout = rt.timeout;
    if (rt.network) networkFs = { network: true, warning: rt.warning };
  }
  const ctx = {
    root: disc.root,
    base,
    strictReadOnly: !!opts.strictReadOnly,
    timeout: resolvedTimeout,
  };

  // THE PRIMARY IS EXCLUDED ONLY WHEN THERE IS SOMETHING ELSE TO TALK ABOUT.
  //
  // Excluding it is right in a fan-out: the human's own worktree is not a dispatched agent, and
  // reporting on it would bury the signal about the agents. That rationale is void when there are
  // no agents — and a repository with one worktree is the commonest shape there is, the shape of
  // every first run, and the shape a user is in on the day they install holt.
  //
  // MEASURED on a real repository belonging to another team, at one moment, two commands apart:
  //
  //   holt risk                    scanned 0/0 workstreams · nothing at risk
  //   holt risk --include-primary  ● interactive-textbook  9 uniq  24 uncomm  unique-work-uncommitted
  //
  // The default answered a question about worktrees that did not exist while 24 uncommitted
  // changes and 9 symbols that live nowhere else sat in the one worktree that did. The caveat WAS
  // printed — in grey, in parentheses, below a headline that read as an all-clear — and the
  // engineer reading it still concluded holt reported no risk, which is the only test of a
  // caveat that matters. Hiding a repository's real risk behind a flag the user has to know to
  // pass is not a default; it is a trap with documentation.
  //
  // So: if the primary is the ONLY workstream, it IS the workstream. Nothing changes for a repo
  // with siblings, where the original reasoning still holds and the caveat still prints.
  const soloPrimary = disc.workstreams.length === 1 && disc.workstreams[0]?.isPrimary;
  const includePrimary = opts.includePrimary || soloPrimary;
  const targets = disc.workstreams.filter((w) => !w.isPrimary || includePrimary);

  // WHAT HOLT IS NOT AUDITING MUST STILL BE NAMED. The primary worktree is excluded from the
  // scan by default — it is where the human lives, not a dispatched agent — but excluded is not
  // the same as nonexistent. Adversarial review built the commonest first-run shape there is: one
  // repository, no fan-out yet, uncommitted-only work sitting in the primary — and holt answered
  // "Nothing unique anywhere. Every workstream is reproducible from base." That sentence is true
  // of the zero workstreams scanned and false of the repository. One porcelain status call
  // records whether the unscanned primary is dirty, so every surface can say what holt is NOT
  // vouching for instead of implying it checked.
  /** @type {{id: any, path: any, dirtyFiles: number|null}|null} */
  let primaryUnscanned = null;
  const primary = disc.workstreams.find((w) => w.isPrimary);
  if (primary && !includePrimary) {
    const st = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: primary.path })
      .catch(() => null);
    const entries = st && st.code === 0 ? st.stdout.split('\0').filter(Boolean).length : null;
    primaryUnscanned = {
      id: primary.id,
      path: primary.path,
      dirtyFiles: entries, // null = even the status read failed; never reported as "clean"
    };
  }

  // ---- Phase 1: file-level deltas -------------------------------------------------
  const scanned = await pmap(targets, (ws) => scanFiles(ws, ctx), opts.concurrency ?? 8);

  // ---- Phase 2: symbols -----------------------------------------------------------
  let backend = { kind: 'disabled', label: 'symbols disabled', degraded: false };
  /** @type {string|null} */
  let minifiedWarning = null;
  if (opts.symbols !== false) {
    backend = await resolveBackend({ force: opts.symbolBackend });

    const union = [...new Set(scanned.flatMap((w) => (w.ok ? (w.symbolFiles ?? w.touched) : [])))];
    const baseSyms = await symbolsAtBase(disc.root, base.oid, union, backend);

    await pmap(
      scanned.filter((w) => w.ok && (w.symbolFiles ?? w.touched).length),
      async (w) => {
        const headSyms = await symbolsOnDisk(w.path, w.symbolFiles ?? w.touched, backend);
        w.added = diffSymbols(headSyms, baseSyms);
        w.addedKeys = [...new Set(w.added.map(symbolKey))];
        w.stats.addedSymbols = w.addedKeys.length;
        // AN EXTRACTION THAT FAILED IS NOT AN EMPTY ANSWER. Measured: a file with a real symbol
        // comes back with zero under a timeout, byte-identical to a file that has none — so under
        // load, "could not look" became a confident "shares nothing with anyone", and a worktree
        // holding unique work looked disposable. Recording WHICH files could not be read lets the
        // verdict say unmeasured instead of nothing; silence must never read as a negative result.
        w.symbolsUnmeasured = headSyms.failed ?? [];
      },
      Math.min(opts.concurrency ?? 8, 6),
    );
  }

  return {
    root: disc.root,
    vcs: disc.vcs,
    base,
    jj: disc.jj,
    backend,
    workstreams: scanned,
    skipped: scanned.filter((w) => !w.ok).map((w) => ({ id: w.id, reason: w.reason })),
    primaryUnscanned,
    // The reader is in a repository with no fan-out yet. The risk verdict is now EARNED here (the
    // one worktree IS scanned), but every CROSS-worktree finding — collisions, duplicates,
    // families, landing order — is necessarily empty for a reason that has nothing to do with the
    // repository's health, and a reader who has simply not run `git worktree add` yet cannot tell
    // those two empty states apart from the output alone.
    soloPrimary,
    strictReadOnly: ctx.strictReadOnly,
    // Present (and {network:true}) when the repository root was detected on an NFS/SMB mount and
    // the timeout was escalated as a result. Carries a human-readable warning. See resolveTimeout
    // in src/git.mjs. null when the root is on a local disk or an explicit timeout was given.
    networkFs,
    // A human-readable warning when the regex fallback is in use and minified files were
    // detected — their symbol counts are unreliable. null when ctags is in use (it is immune
    // to minification) or when no minified files were found. See isMinified() in symbols.mjs.
    minifiedWarning,
  };
}
