// SPDX-License-Identifier: FSL-1.1-MIT
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

// 'semantic-overlap' is a pair git PROVED merges cleanly whose sides nonetheless define the same
// symbol. It entangles landing order exactly as a predicted conflict does: the text merges, and
// the result is a duplicate declaration. Excluding it — as 'proven-clean' is excluded — would
// sequence the two in parallel and break the landing on the case holt exists to catch.
const CONFLICT_KINDS = new Set(['proven', 'predicted', 'semantic-overlap']);

/**
 * @param {Record<string, any>} report - the analyze() report (uses .safe, .unique, .collisions, .duplicates)
 * @returns {{lanes: Array, parallel: string[], excluded: Array, note: string}}
 */
export function landingOrder(report) {
  // Landing order is an action aid, not an inventory. A primary worktree is the user's active
  // checkout, not an agent branch to land, and an approximate/unknown verdict has no evidence
  // strong enough to call it parallel-safe. Keep those rows visible in status/plan, but never put
  // them in a lane that says “land concurrently.” Test fixtures predating the typed confidence
  // field remain compatible: an absent confidence is treated as the old exact fixture contract.
  const excluded = (report.safe ?? []).filter((s) => s.isPrimary || s.familyRule === 'primary-worktree'
    || s.confidence === 'unknown' || s.confidence === 'approximate' || s.confidence === 'unverifiable'
    || s.safe === true);
  const eligible = (report.safe ?? []).filter((s) => !excluded.includes(s));
  const ids = eligible.map((s) => s.id);
  const weight = new Map();
  for (const u of report.unique ?? []) {
    weight.set(u.id, (u.committedFileCount ?? 0) + (u.uncommittedOnlyCount ?? u.uncommittedCount ?? 0)
      + (u.uniqueSymbolCount ?? 0));
  }

  // Build the evidence graph. proven-clean pairs are evidence of NON-interaction and add no edge.
  const edges = new Map(ids.map((id) => [id, new Map()]));
  const addEdge = (a, b, why) => {
    if (!edges.has(a) || !edges.has(b) || a === b) return;
    if (!edges.get(a).has(b)) { edges.get(a).set(b, []); edges.get(b).set(a, []); }
    edges.get(a).get(b).push(why);
    edges.get(b).get(a).push(why);
  };
  // Use the FULL collision evidence, not the human-filtered view. Bare file overlap
  // ("co-located") is deliberately hidden from triage surfaces because it drowns them — but for
  // SEQUENCING it is exactly the signal that matters: two workstreams editing the same file are
  // not independent, and sequencing them in parallel means the second one fails to apply. A
  // false positive here costs a little serialisation; a false negative costs a broken landing.
  for (const c of report.collisionsAll ?? report.collisions ?? []) {
    if (CONFLICT_KINDS.has(c.kind)) addEdge(c.a, c.b, `${c.kind} collision`);
    else if (c.kind === 'co-located') addEdge(c.a, c.b, `both edit ${(c.sharedFiles ?? [])[0] ?? 'a shared file'}`);
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
    excluded: excluded.map((s) => ({
      id: s.id,
      reason: s.isPrimary || s.familyRule === 'primary-worktree'
        ? 'primary worktree is not a landing candidate'
        : s.safe === true
          ? 'disposable workstream is already reproducible from base'
          : 'landing safety is not exact; review the workstream before ordering it',
    })),
    note: 'parallel = no observed interaction (not a compatibility certificate). Lane order is a '
      + 'min-entanglement heuristic; conflictsWithLater names the merges to watch at each step. '
      + 'Primary, disposable, and non-exact workstreams are excluded from landing candidates.',
  };
}
