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

export const MAX_PARTITION_AGENTS = 256;

const unitOf = (file, depth) => {
  const parts = String(file).split('/');
  const dirs = parts.slice(0, -1);
  if (!dirs.length) return depth >= 2 ? String(file) : '<root>';
  return depth > dirs.length ? String(file) : dirs.slice(0, depth).join('/');
};

/**
 * @param {Record<string, any>} report - analyze() report (uses full collision evidence when available)
 * @param {string[]} trackedFiles - repo-relative paths from `git ls-files`
 * @param {{agents?: number, paths?: string[], components?: string[]}} opts
 */
export function partitionPlan(report, trackedFiles, { agents = 2, paths = [], components = [] } = {}) {
  const requested = Number(agents);
  // One requested agent is a valid, useful answer. The old minimum of two contradicted the CLI
  // and MCP schemas and forced a meaningless empty second packet on a single-task repository.
  const requestedAgents = Math.min(MAX_PARTITION_AGENTS, Math.max(1,
    Number.isFinite(requested) ? Math.floor(requested) : 2));
  const files = [...new Set((trackedFiles ?? []).map(String))];
  const anchors = [...new Set([...paths, ...components].map(String).map((s) => s.trim()).filter(Boolean))];
  const compileAnchor = (selector) => {
    // Small, deterministic glob subset for task anchors. It is deliberately not shell-expanded:
    // task context is data, never a command. `**` crosses directories; `*` and `?` stay within
    // one. A literal directory anchor (for example `src`) owns its descendants; globs retain
    // normal exact-match semantics so `src/*.js` does not silently claim `src/deep/x.js`.
    let source = '';
    for (let i = 0; i < selector.length; i++) {
      const ch = selector[i];
      if (ch === '*' && selector[i + 1] === '*') {
        if (selector[i + 2] === '/') { source += '(?:.*/)?'; i += 2; }
        else { source += '.*'; i += 1; }
      } else if (ch === '*') source += '[^/]*';
      else if (ch === '?') source += '[^/]';
      else if (/[.+^${}()|[\]\\]/.test(ch)) source += `\\${ch}`;
      else source += ch;
    }
    const directorySuffix = !/[?*]/.test(selector) ? '(?:/.*)?' : '';
    try { return new RegExp(`^(?:${source})${directorySuffix}$`); } catch { return null; }
  };
  const selectors = anchors.map((anchor) => [anchor, compileAnchor(anchor)]);
  const matches = (file, selector) => selector?.test(file) === true;
  const scopedFiles = anchors.length
    ? files.filter((file) => selectors.some(([, selector]) => matches(file, selector)))
    : files;
  const unmatchedAnchors = anchors.filter((anchor, index) => {
    const selector = selectors[index]?.[1];
    return !files.some((file) => matches(file, selector));
  });
  const taskStatus = !anchors.length
    ? 'insufficient_task_context'
    : scopedFiles.length
      ? unmatchedAnchors.length ? 'partial' : 'provided'
      : 'unresolved';
  const evidenceFiles = [...new Set((report.collisionsAll ?? report.collisions ?? [])
    .flatMap((c) => c.sharedFiles ?? []).map(String))];
  const scopedEvidence = anchors.length
    ? evidenceFiles.filter((file) => selectors.some(([, selector]) => matches(file, selector)))
    : evidenceFiles;
  const allPaths = [...new Set([...scopedFiles, ...scopedEvidence])];
  const targetUnits = Math.min(requestedAgents, Math.max(1, allPaths.length));
  const maxDepth = Math.max(1, ...allPaths.map((f) => {
    const dirs = f.split('/').slice(0, -1);
    return dirs.length ? dirs.length + 1 : 2;
  }));
  let depth = 1;
  while (depth < maxDepth && new Set(allPaths.map((f) => unitOf(f, depth))).size < targetUnits) depth++;
  // Do not manufacture empty buckets when a repository has fewer defensible path units than the
  // requested fan-out. `requestedAgents` remains visible in the result so an orchestrator can
  // explain why it received fewer packets; `agents` is the executable allocation.
  const availableUnits = new Set(allPaths.map((f) => unitOf(f, depth))).size;
  const n = Math.min(requestedAgents, Math.max(1, availableUnits));

  // Weight per path unit. The unit deepens only when top-level directories cannot provide enough
  // independent buckets; this preserves locality for ordinary repositories while making a
  // single-directory monorepo useful for a larger fan-out.
  const dirWeight = new Map();
  for (const f of scopedFiles) {
    const seg = unitOf(f, depth);
    dirWeight.set(seg, (dirWeight.get(seg) ?? 0) + 1);
  }
  for (const f of scopedEvidence) {
    const seg = unitOf(f, depth);
    if (!dirWeight.has(seg)) dirWeight.set(seg, 0);
  }

  // Observed hotspots: files two or more live workstreams both touch, from collision evidence.
  const hotspots = new Map(); // file -> Set(workstream ids)
  for (const c of report.collisionsAll ?? report.collisions ?? []) {
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
  for (const c of report.collisionsAll ?? report.collisions ?? []) {
    const wtA = `wt:${c.a}`;
    const wtB = `wt:${c.b}`;
    uf.union(wtA, wtB);
    for (const f of c.sharedFiles ?? []) {
      const dTok = `dir:${unitOf(f, depth)}`;
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
  /** @type {{agent: number, dirs: string[], weight: number}[]} */
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
    const seg = unitOf(file, depth);
    return {
      file,
      currentlyHeldBy: [...owners].sort(),
      assignTo: dirOwner.get(seg) ?? null,
      rule: 'exactly one agent may touch this file; it is already contested',
    };
  });

  return {
    agents: n,
    requestedAgents,
    taskContext: taskStatus === 'insufficient_task_context'
      ? {
        status: taskStatus,
        reason: 'No intended task paths or components were supplied; this is a structural map, not a task allocation.',
        next: 'Supply --path/--component (or MCP paths/components), or explicitly treat this as an advanced structural view.',
      }
      : {
        status: taskStatus,
        anchors,
        matchedFiles: scopedFiles.length,
        unmatched: unmatchedAnchors,
      },
    granularity: depth === 1 ? 'top-level-directory' : depth >= maxDepth ? 'file-or-deep-directory' : `directory-depth-${depth}`,
    buckets,
    avoid,
    mode: 'structural',
    advisory: 'path units are disjoint; every connected tangle of conflicting workstreams '
      + '(transitively, not just pairwise) is glued into a single bucket, weight-balanced against '
      + 'everything else. Holt deepens units only when the requested fan-out needs it. Without '
      + 'explicit task anchors this is a structural starting map, not a work plan.',
  };
}
