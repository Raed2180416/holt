// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — workstream discovery.
 *
 * A "workstream" is one parallel line of work. Today that is a git worktree or a jj
 * workspace, but the model is deliberately VCS-agnostic: a workstream is
 * {id, path, head, base} plus content. Nothing downstream of this file knows what a
 * worktree is. That is what lets a jj (or future) backend drop in without a rewrite —
 * and it matters, because jj's automatic snapshotting eliminates the uncommitted layer
 * that git makes invisible.
 */

import { git, repoRoot } from './git.mjs';
import { discoverJjWorkspaces as _discoverJj } from './jj.mjs';
import path from 'node:path';
import { canonicalPath, foldCase } from './paths.mjs';

/**
 * Family inference.
 *
 * Agents fan out with generated names. Grouping them recovers "these 5 came from one
 * dispatch", which is what makes duplicate detection meaningful — 5 siblings solving the
 * same task is expected; 2 strangers solving it is waste.
 *
 * This is heuristic, and it is the single most likely thing to be wrong on a layout we
 * have not seen. It is therefore (a) overridable via config and (b) reported, so a user
 * can see the grouping holt chose rather than having it silently applied.
 */
const FAMILY_PATTERNS = [
  // wf_11177c4b-466-1  ->  wf_11177c4b-466      (Claude Code / workflow fan-out)
  { re: /^(.*?)-\d+$/, name: 'numeric-suffix' },
  // agent-aa19e5803c75700cb -> agent            (generic agent-<hash>)
  { re: /^(agent|task|job|run|session)[-_][0-9a-f]{6,}$/i, name: 'agent-hash' },
  // feature/foo-1 -> feature/foo
  { re: /^(.*)\.\d+$/, name: 'dotted-suffix' },
];

export function inferFamily(name, overrides = []) {
  for (const o of overrides) {
    try {
      const re = o instanceof RegExp ? o : new RegExp(o);
      const m = name.match(re);
      if (m) return { family: m[1] ?? m[0], rule: 'user-override' };
    } catch {
      /* a bad user regex must not take down the scan */
    }
  }
  for (const { re, name: rule } of FAMILY_PATTERNS) {
    const m = name.match(re);
    if (m) return { family: m[1], rule };
  }
  return { family: name, rule: 'singleton' };
}

/**
 * Parse `git worktree list --porcelain`.
 * Records are blank-line separated; each is a set of "key value" lines, with bare
 * keys (bare, detached, locked, prunable) having no value.
 */
export function parseWorktreePorcelain(stdout) {
  const out = [];
  let cur = null;
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === '') {
      if (cur) { out.push(cur); cur = null; }
      continue;
    }
    const sp = line.indexOf(' ');
    const key = sp === -1 ? line : line.slice(0, sp);
    const val = sp === -1 ? true : line.slice(sp + 1);
    if (key === 'worktree') {
      if (cur) out.push(cur);
      cur = { path: val, detached: false, bare: false, locked: false, prunable: false };
    } else if (cur) {
      if (key === 'HEAD') cur.head = val;
      else if (key === 'branch') cur.branch = val;
      else if (key === 'detached') cur.detached = true;
      else if (key === 'bare') cur.bare = true;
      else if (key === 'locked') { cur.locked = true; cur.lockReason = val === true ? '' : val; }
      else if (key === 'prunable') { cur.prunable = true; cur.prunableReason = val === true ? '' : val; }
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Discover git worktrees from any path inside the repo. */
export async function discoverGitWorktrees(cwd) {
  const root = await repoRoot(cwd);
  if (!root) return { root: null, workstreams: [], vcs: null };

  const r = await git(['worktree', 'list', '--porcelain'], { cwd: root });
  if (r.code !== 0) {
    return { root, workstreams: [], vcs: 'git', error: r.stderr.trim() };
  }

  const records = parseWorktreePorcelain(r.stdout).filter((w) => !w.bare);
  // isPrimary is CANONICALISED, not string-compared. git reports the real path while the caller
  // may hold a symlinked or short-name one — on macOS /var vs /private/var, on Windows an 8.3
  // name — so a raw comparison marks NO worktree as primary. That silently disables the
  // primary-tree protection, which matters more than it looks: git REFUSES to lock the main
  // worktree, so the hook is its only defence, and it is selected by exactly this flag.
  const canonRoot = foldCase(await canonicalPath(root));
  const workstreams = await Promise.all(records.map(async (w) => ({
    id: path.basename(w.path),
    path: w.path,
    vcs: 'git',
    head: w.head ?? null,
    branch: w.branch ? w.branch.replace(/^refs\/heads\//, '') : null,
    detached: w.detached,
    locked: w.locked,
    lockReason: w.lockReason ?? null,
    prunable: w.prunable,
    prunableReason: w.prunableReason ?? null,
    isPrimary: foldCase(await canonicalPath(w.path)) === canonRoot,
  })));

  return { root, workstreams, vcs: 'git' };
}

/**
 * jj workspace discovery lives in src/jj.mjs — it needs real work to resolve paths, because
 * `jj workspace list` does not print them. Re-exported here so callers have one entry point.
 *
 * Absence of jj is not an error and must never be reported as "no workstreams" — that would be
 * exactly the fail-open-on-missing-evidence defect this tool exists to catch.
 */
export { discoverJjWorkspaces } from './jj.mjs';

/**
 * Full discovery. Returns every workstream holt can see, tagged by backend,
 * with families assigned.
 */
export async function discover(cwd, { familyOverrides = [], includeJj = true } = {}) {
  const g = await discoverGitWorktrees(cwd);
  if (!g.root) {
    return { root: null, vcs: null, workstreams: [], jj: null, error: 'not-a-git-repository' };
  }

  let jj = null;
  if (includeJj) {
    try {
      jj = await _discoverJj(g.root);
    } catch (err) {
      jj = { available: false, workstreams: [], unresolved: [], reason: `jj-probe-threw: ${err.message}` };
    }
  }

  // Merge: a jj workspace whose path matches a git worktree is the same workstream.
  const byPath = new Map();
  for (const w of g.workstreams) byPath.set(path.resolve(w.path), w);
  if (jj?.workstreams?.length) {
    for (const w of jj.workstreams) {
      if (!w.path) continue;
      const key = path.resolve(w.path);
      if (byPath.has(key)) byPath.get(key).alsoJj = true;
      else byPath.set(key, w);
    }
  }

  const workstreams = disambiguate([...byPath.values()]).map((w) => {
    const { family, rule } = inferFamily(w.id, familyOverrides);
    return { ...w, family, familyRule: rule };
  });

  return { root: g.root, vcs: g.vcs, workstreams, jj, error: null };
}

/**
 * Make workstream ids unique.
 *
 * FOUND ON A REAL REPOSITORY: six worktrees at
 *   .../landing/A-memory-core/stage, .../landing/B-context-compiler/stage, …
 * all had the basename `stage`. Everything downstream keys on id — unique work, collisions,
 * the delete gate — so six distinct workstreams silently became one. `holt gate stage` would
 * have answered about whichever happened to be found first, which for a tool that authorises
 * deletion is the worst possible kind of wrong.
 *
 * Only ambiguous ids get lengthened, so the common case stays readable.
 */
export function disambiguate(workstreams) {
  const counts = new Map();
  for (const w of workstreams) counts.set(w.id, (counts.get(w.id) ?? 0) + 1);

  const used = new Set();
  return workstreams.map((w) => {
    if (counts.get(w.id) === 1) { used.add(w.id); return w; }

    const segments = String(w.path ?? '').split(path.sep).filter(Boolean);
    // Walk up the path adding parent segments until the id is unique.
    for (let take = 2; take <= Math.min(segments.length, 5); take++) {
      const candidate = segments.slice(-take).join('/');
      if (!used.has(candidate)) {
        used.add(candidate);
        return { ...w, id: candidate, ambiguousBasename: w.id };
      }
    }
    // Pathological fallback: full path is always unique.
    const full = String(w.path);
    used.add(full);
    return { ...w, id: full, ambiguousBasename: w.id };
  });
}
