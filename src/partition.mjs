// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — pre-flight partitioning: the cleanup problem, inverted.
 *
 * Before spawning N agents, answer "how should they split the repository so they do not
 * collide at all?" — using the same evidence the cleanup side measures after the fact:
 * (1) files ALREADY contested by two or more live workstreams (observed hotspots), and
 * (2) the repository's own shape (tracked-file weight per top-level directory).
 *
 * Output: N disjoint directory buckets balanced by weight, with every observed hotspot
 * assigned to EXACTLY ONE bucket (whoever owns the hotspot's directory), plus an avoid-list
 * naming each contested file and who currently holds changes to it.
 *
 * Advisory BY CONSTRUCTION and labeled as such: holt cannot know the tasks you are about to
 * assign. What it can guarantee is that the buckets are disjoint and every known-contested
 * path has exactly one owner — the two properties whose absence causes the collisions the
 * rest of holt exists to clean up.
 */

/**
 * @param {object} report - analyze() report (uses .collisions for observed hotspots)
 * @param {string[]} trackedFiles - repo-relative paths from `git ls-files`
 * @param {{agents?: number}} opts
 */
export function partitionPlan(report, trackedFiles, { agents = 2 } = {}) {
  const n = Math.max(2, Math.floor(agents));

  // Weight per top-level segment (files at the root get their own pseudo-dir "<root>").
  const dirWeight = new Map();
  for (const f of trackedFiles) {
    const seg = f.includes('/') ? f.slice(0, f.indexOf('/')) : '<root>';
    dirWeight.set(seg, (dirWeight.get(seg) ?? 0) + 1);
  }

  // Observed hotspots: files two or more live workstreams both touch, from collision evidence.
  const hotspots = new Map(); // file -> Set(workstream ids)
  for (const c of report.collisions ?? []) {
    for (const key of c.sharedFiles ?? []) {
      if (!hotspots.has(key)) hotspots.set(key, new Set());
      hotspots.get(key).add(c.a);
      hotspots.get(key).add(c.b);
    }
  }

  // Greedy balanced assignment: heaviest directory first, always into the lightest bucket.
  const buckets = Array.from({ length: n }, (_, i) => ({ agent: i + 1, dirs: [], weight: 0 }));
  const byWeight = [...dirWeight.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  for (const [dir, w] of byWeight) {
    const lightest = buckets.reduce((m, b) => (b.weight < m.weight ? b : m), buckets[0]);
    lightest.dirs.push(dir);
    lightest.weight += w;
  }
  for (const b of buckets) b.dirs.sort();

  const dirOwner = new Map();
  for (const b of buckets) for (const d of b.dirs) dirOwner.set(d, b.agent);

  const avoid = [...hotspots.entries()].sort().map(([file, owners]) => {
    const seg = file.includes('/') ? file.slice(0, file.indexOf('/')) : '<root>';
    return {
      file,
      currentlyHeldBy: [...owners].sort(),
      assignTo: dirOwner.get(seg) ?? null,
      rule: 'exactly one agent may touch this file; it is already contested',
    };
  });

  return {
    agents: n,
    buckets,
    avoid,
    advisory: 'directory buckets are disjoint and balanced by tracked-file weight; every observed '
      + 'hotspot has exactly one assigned owner. holt cannot know your task split — treat this as '
      + 'the collision-free starting map, not a work plan.',
  };
}
