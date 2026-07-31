/**
 * grove — the scanner.
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
 *                 state across worktrees; merge-tree sees only commits. In the repo grove
 *                 was built against, the committed layer flagged 4 interesting worktrees
 *                 while the uncommitted layer held 52 registry keys absent from base.
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
import { git, splitNul, pmap, resolveRef, GitRefused } from './git.mjs';
import { resolveBackend, symbolsOnDisk, symbolsAtBase, diffSymbols, symbolKey } from './symbols.mjs';

const BASE_CANDIDATES = ['main', 'master', 'trunk', 'develop', 'default'];

/** Pick the base ref to compare everything against. */
export async function resolveBase(root, explicit) {
  if (explicit) {
    const oid = await resolveRef(root, explicit);
    if (!oid) throw new Error(`grove: base ref '${explicit}' does not resolve in ${root}`);
    return { ref: explicit, oid, how: 'explicit' };
  }

  // origin/HEAD is the correct source for "what is this project's default branch" and is the
  // documented best practice. But it answers a DIFFERENT question from the one grove asks.
  //
  // grove asks: what will this work be landed INTO? That is the local branch. Measured on a
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

  throw new Error(`grove: could not determine a base ref in ${root} (is this an empty repository?)`);
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
async function committedDelta(root, baseOid, headOid, { strictReadOnly, timeout }) {
  if (!headOid || headOid === baseOid) {
    return { files: [], how: 'identical-to-base', conflicted: false };
  }

  if (strictReadOnly) {
    const r = await git(['diff', '--name-only', '-z', `${baseOid}...${headOid}`], { cwd: root, timeout });
    if (r.code !== 0) return { files: [], how: 'three-dot-failed', conflicted: false, error: r.stderr.trim() };
    return {
      files: splitNul(r.stdout),
      how: 'three-dot-approximate',
      conflicted: false,
      caveat: 'strictReadOnly: over-reports content base already acquired by another route',
    };
  }

  const mt = await git(['merge-tree', '--write-tree', baseOid, headOid], { cwd: root, timeout });
  // exit 0 = clean, 1 = conflicts (tree still on line 1), >1 = error.
  if (mt.code > 1) {
    return { files: [], how: 'merge-tree-failed', conflicted: false, error: mt.stderr.trim() };
  }
  const tree = mt.stdout.split('\n')[0].trim();
  if (!/^[0-9a-f]{40,64}$/.test(tree)) {
    return { files: [], how: 'merge-tree-no-tree', conflicted: mt.code === 1, error: 'unparseable merge-tree output' };
  }

  const names = await git(['diff', '--name-only', '-z', baseOid, tree], { cwd: root, timeout });
  return {
    files: names.code === 0 ? splitNul(names.stdout) : [],
    how: 'merge-tree',
    conflicted: mt.code === 1,
    mergedTree: tree,
  };
}

/** UNCOMMITTED delta: the layer no git relationship command can see. */
async function uncommittedDelta(wtPath, { timeout }) {
  const status = await git(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { cwd: wtPath, timeout },
  );
  if (status.code !== 0) {
    return { files: [], untracked: [], how: 'status-failed', error: status.stderr.trim() };
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

  return { files, untracked, how: 'status+diff-HEAD' };
}

/** Paths that are noise in every repo. Small and conservative on purpose. */
const GENERATED = [
  /(^|\/)node_modules\//, /(^|\/)\.git\//, /(^|\/)target\//, /(^|\/)dist\//, /(^|\/)build\//,
  /(^|\/)__pycache__\//, /(^|\/)\.venv\//, /(^|\/)venv\//, /(^|\/)vendor\//,
  /(^|\/)\.next\//, /(^|\/)coverage\//, /\.min\.(js|css)$/, /(^|\/)\.pytest_cache\//,
  // Dependency manifests. A lockfile records what a resolver decided, not what an agent wrote.
  // Left in, they contribute thousands of package-name "symbols" — measured on a real repo,
  // producing findings like `object:node_modules/@ts-morph/common` presented as unique work.
  /\.lock$/, /(^|\/)package-lock\.json$/, /(^|\/)yarn\.lock$/, /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)Cargo\.lock$/, /(^|\/)poetry\.lock$/, /(^|\/)composer\.lock$/, /(^|\/)Gemfile\.lock$/,
  /(^|\/)go\.sum$/, /(^|\/)Pipfile\.lock$/, /(^|\/)gradle\.lockfile$/, /(^|\/)packages\.lock\.json$/,
];
export function looksGenerated(p) {
  return GENERATED.some((re) => re.test(p));
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
    const [committed, uncommitted] = await Promise.all([
      committedDelta(root, base.oid, headOid, { strictReadOnly, timeout }),
      // jj snapshots the working copy into `@` automatically, so under jj there IS no separate
      // uncommitted layer — the thing git cannot relate across worktrees simply does not exist.
      // Asking git for status inside a jj workspace would fail (no .git) and, worse, a failure
      // there would read as "clean".
      ws.vcs === 'jj'
        ? Promise.resolve({ files: [], untracked: [], how: 'jj-snapshot (working copy is part of @)' })
        : uncommittedDelta(ws.path, { timeout }),
    ]);

    // FAIL-CLOSED ON INSTRUMENT FAILURE. Found by probing partial (blobless) clones: when
    // merge-tree cannot run — offline promisor remote, pruned objects, corrupt odb — it returns
    // an EMPTY file list, which is indistinguishable downstream from "no committed delta". A
    // worktree with committed-ahead work and a clean working tree would then be reported SAFE,
    // and clean --apply would delete it. An empty answer from a broken instrument is not an
    // answer (Law: prove the instrument can detect presence before trusting its silence).
    const committedFailed = ['merge-tree-failed', 'merge-tree-no-tree', 'three-dot-failed']
      .includes(committed.how);
    const statusFailed = uncommitted.how === 'status-failed';
    if (committedFailed || statusFailed) {
      result.reason = committedFailed
        ? `committed-delta instrument failed (${committed.how}: ${committed.error ?? 'unknown'}) — refusing to classify`
        : `status instrument failed (${uncommitted.error ?? 'unknown'}) — refusing to classify`;
      return result; // ok stays false -> UNKNOWN -> never safe, never cleaned
    }

    const cFiles = committed.files.filter((f) => !looksGenerated(f));
    const uFiles = uncommitted.files.filter((f) => !looksGenerated(f));
    const uUntracked = (uncommitted.untracked ?? []).filter((f) => !looksGenerated(f));

    result.ok = true;
    result.committed = {
      files: cFiles, count: cFiles.length, how: committed.how,
      conflicted: committed.conflicted, caveat: committed.caveat ?? null,
    };
    result.uncommitted = {
      files: uFiles, untracked: uUntracked, count: uFiles.length + uUntracked.length,
      how: uncommitted.how,
    };
    result.touched = [...new Set([...cFiles, ...uFiles, ...uUntracked])].sort();
    result.stats = {
      committedFiles: cFiles.length,
      uncommittedFiles: uFiles.length,
      untrackedFiles: uUntracked.length,
      addedSymbols: 0,
    };
  } catch (err) {
    if (err instanceof GitRefused) throw err; // a refusal is a grove bug, never swallowed
    result.reason = `scan error: ${err.message}`;
  }

  return result;
}

/**
 * Scan every workstream.
 *
 * @param {object} disc  result of discover()
 * @param {object} opts  {base, strictReadOnly, concurrency, timeout, symbols, includePrimary}
 */
export async function scan(disc, opts = {}) {
  if (!disc.root) throw new Error('grove: not a git repository');

  const base = await resolveBase(disc.root, opts.base);
  const ctx = {
    root: disc.root,
    base,
    strictReadOnly: !!opts.strictReadOnly,
    timeout: opts.timeout ?? 60_000,
  };

  const targets = disc.workstreams.filter((w) => !w.isPrimary || opts.includePrimary);

  // ---- Phase 1: file-level deltas -------------------------------------------------
  const scanned = await pmap(targets, (ws) => scanFiles(ws, ctx), opts.concurrency ?? 8);

  // ---- Phase 2: symbols -----------------------------------------------------------
  let backend = { kind: 'disabled', label: 'symbols disabled', degraded: false };
  if (opts.symbols !== false) {
    backend = await resolveBackend({ force: opts.symbolBackend });

    const union = [...new Set(scanned.flatMap((w) => (w.ok ? w.touched : [])))];
    const baseSyms = await symbolsAtBase(disc.root, base.oid, union, backend);

    await pmap(
      scanned.filter((w) => w.ok && w.touched.length),
      async (w) => {
        const headSyms = await symbolsOnDisk(w.path, w.touched, backend);
        w.added = diffSymbols(headSyms, baseSyms);
        w.addedKeys = [...new Set(w.added.map(symbolKey))];
        w.stats.addedSymbols = w.addedKeys.length;
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
    strictReadOnly: ctx.strictReadOnly,
  };
}
