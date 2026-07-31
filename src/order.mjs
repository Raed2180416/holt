/**
 * holt — landing-order optimizer.
 *
 * Input: the pairwise evidence a scan already produced — proven/predicted collisions and
 * duplicate pairs. Output: which workstreams can land in PARALLEL (no evidence connects
 * them), and for the entangled ones, an order that keeps every predicted conflict as late
 * and as contained as possible.
 *
 * Honesty about the method: connected components over the evidence graph are exact — two
 * components share no observed interaction, so they are independent lanes. WITHIN a
 * component, optimal ordering is NP-hard in general; we use a greedy min-entanglement peel
 * (repeatedly land the stream with the fewest edges into the not-yet-landed set; ties broken
 * by fewer touched files, then id) and we label it a heuristic. The output never claims a
 * landing will be conflict-free — it reports which edges remain at each step so the person
 * or agent landing knows exactly which merges to watch.
 */

const CONFLICT_KINDS = new Set(['proven', 'predicted']);

/**
 * @param {object} report - the analyze() report (uses .safe, .unique, .collisions, .duplicates)
 * @returns {{lanes: Array, parallel: string[], note: string}}
 */
export function landingOrder(report) {
  const ids = (report.safe ?? []).map((s) => s.id);
  const weight = new Map();
  for (const u of report.unique ?? []) {
    weight.set(u.id, (u.committedFileCount ?? 0) + (u.uncommittedCount ?? 0) + (u.uniqueSymbolCount ?? 0));
  }

  // Build the evidence graph. proven-clean pairs are evidence of NON-interaction and add no edge.
  const edges = new Map(ids.map((id) => [id, new Map()]));
  const addEdge = (a, b, why) => {
    if (!edges.has(a) || !edges.has(b) || a === b) return;
    if (!edges.get(a).has(b)) { edges.get(a).set(b, []); edges.get(b).set(a, []); }
    edges.get(a).get(b).push(why);
    edges.get(b).get(a).push(why);
  };
  for (const c of report.collisions ?? []) {
    if (CONFLICT_KINDS.has(c.kind)) addEdge(c.a, c.b, `${c.kind} collision`);
  }
  for (const d of report.duplicates ?? []) {
    addEdge(d.a, d.b, `duplicate work (${d.sharedCount} shared symbol${d.sharedCount === 1 ? '' : 's'})`);
  }

  // Connected components = independent lanes.
  const seen = new Set();
  const lanes = [];
  for (const start of ids) {
    if (seen.has(start)) continue;
    const members = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const cur = stack.pop();
      members.push(cur);
      for (const nb of edges.get(cur).keys()) {
        if (!seen.has(nb)) { seen.add(nb); stack.push(nb); }
      }
    }
    members.sort();
    lanes.push(members);
  }

  // Within each lane: greedy min-entanglement peel.
  const ordered = lanes.map((members) => {
    const remaining = new Set(members);
    const order = [];
    while (remaining.size) {
      let pick = null;
      let pickDegree = Infinity;
      for (const id of [...remaining].sort()) {
        const deg = [...edges.get(id).keys()].filter((n) => remaining.has(n)).length;
        const better = deg < pickDegree
          || (deg === pickDegree && (weight.get(id) ?? 0) < (weight.get(pick) ?? 0));
        if (better) { pick = id; pickDegree = deg; }
      }
      remaining.delete(pick);
      const conflictsWithLater = [...edges.get(pick).entries()]
        .filter(([n]) => remaining.has(n))
        .map(([n, why]) => ({ id: n, why: [...new Set(why)] }));
      order.push({ id: pick, conflictsWithLater });
    }
    return { members, order, entangled: members.length > 1 };
  });

  // Singleton lanes are parallel-safe by evidence; report them as one group up front.
  const parallel = ordered.filter((l) => !l.entangled).map((l) => l.members[0]).sort();
  const entangledLanes = ordered.filter((l) => l.entangled)
    .sort((x, y) => x.members.length - y.members.length);

  return {
    parallel,
    lanes: entangledLanes,
    note: 'parallel = no observed interaction (not a compatibility certificate). Lane order is a '
      + 'min-entanglement heuristic; conflictsWithLater names the merges to watch at each step.',
  };
}
