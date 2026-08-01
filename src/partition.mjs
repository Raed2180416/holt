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
 * Tiny union-find over an arbitrary token space. Used below to merge directories that a
 * conflicting pair of workstreams both touch — see partitionPlan for why this has to operate
 * on WORKSTREAMS, not directly on directories.
 */
function makeUnionFind() {
  const parent = new Map();
  function find(x) {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur);
      parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  function union(x, y) {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent.set(rx, ry);
  }
  return { find, union, has: (x) => parent.has(x) };
}

const dirOf = (f) => (f.includes('/') ? f.slice(0, f.indexOf('/')) : '<root>');

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
    const seg = dirOf(f);
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

  // THE CONFLICT GRAPH, NOT JUST THE FILE LIST.
  //
  // A hotspot file's directory cannot be bucketed on its own: two workstreams that conflict may
  // each anchor a different hotspot in a different top-level directory, and greedy weight-balance
  // (below) is free to hand those directories to two different agents — which is exactly the bug.
  // A path graph makes this concrete: A conflicts B in dirX, B conflicts C in dirY, A does not
  // conflict C at all. A and C's directories share no file, so nothing about them looks linked —
  // until B is read as the bridge that makes {A, B, C} one connected component, which is not
  // transitive-safe to split among independent agents no matter how balanced the halves look.
  //
  // Union-find over a MIXED token space (workstream ids and directory names together) captures
  // that bridge: every collision unions its two workstreams to each other AND to the directory of
  // every file they share. Two directories anchored by a common workstream end up in the same
  // component even though no single collision names them both — which is the whole point.
  const uf = makeUnionFind();
  for (const c of report.collisions ?? []) {
    const wtA = `wt:${c.a}`;
    const wtB = `wt:${c.b}`;
    uf.union(wtA, wtB);
    for (const f of c.sharedFiles ?? []) {
      const dTok = `dir:${dirOf(f)}`;
      uf.union(wtA, dTok);
      uf.union(wtB, dTok);
    }
  }

  // Directories the conflict graph has glued together become ONE unit for bucket assignment,
  // its weight the sum of its members'. A directory no collision ever named stays a singleton,
  // free to land wherever keeps the buckets balanced — gluing is the exception, not the default.
  const groups = new Map(); // union-find root -> { dirs: Set, weight }
  const singles = [];
  for (const [dir, w] of dirWeight) {
    const tok = `dir:${dir}`;
    if (!uf.has(tok)) { singles.push({ dirs: [dir], weight: w }); continue; }
    const root = uf.find(tok);
    if (!groups.has(root)) groups.set(root, { dirs: new Set(), weight: 0 });
    const g = groups.get(root);
    g.dirs.add(dir);
    g.weight += w;
  }
  const units = [
    ...singles,
    ...[...groups.values()].map((g) => ({ dirs: [...g.dirs], weight: g.weight })),
  ];

  // Greedy balanced assignment: heaviest UNIT first, always into the lightest bucket. A unit may
  // be several directories glued together by the conflict graph above; gluing, not the individual
  // directory, is the thing that may never be split across buckets.
  const buckets = Array.from({ length: n }, (_, i) => ({ agent: i + 1, dirs: [], weight: 0 }));
  const byWeight = units
    .map((u) => ({ dirs: [...u.dirs].sort(), weight: u.weight }))
    .sort((a, b) => b.weight - a.weight || (a.dirs[0] < b.dirs[0] ? -1 : 1));
  for (const u of byWeight) {
    const lightest = buckets.reduce((m, b) => (b.weight < m.weight ? b : m), buckets[0]);
    lightest.dirs.push(...u.dirs);
    lightest.weight += u.weight;
  }
  for (const b of buckets) b.dirs.sort();

  const dirOwner = new Map();
  for (const b of buckets) for (const d of b.dirs) dirOwner.set(d, b.agent);

  const avoid = [...hotspots.entries()].sort().map(([file, owners]) => {
    const seg = dirOf(file);
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
    advisory: 'directory buckets are disjoint; every connected tangle of conflicting workstreams '
      + '(transitively, not just pairwise) is glued into a single bucket, weight-balanced against '
      + 'everything else. holt cannot know your task split — treat this as the collision-free '
      + 'starting map, not a work plan.',
  };
}
