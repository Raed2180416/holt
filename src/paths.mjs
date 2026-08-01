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
 * The canonical absolute location of a path, whether or not it exists yet.
 *
 * A path that does not exist STILL HAS a canonical location, and returning the raw string for it
 * was a live false positive: a move DESTINATION never exists yet, so the source canonicalised to
 * /private/var/... while the destination stayed /var/..., they landed in different worktrees, and
 * an ordinary rename looked like a move out of one. So the nearest EXISTING ancestor is resolved
 * and the remainder re-appended.
 */
export async function canonicalPath(p) {
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
