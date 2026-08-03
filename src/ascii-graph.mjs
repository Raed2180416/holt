// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — the relationship map, in the terminal.
 *
 * WHY THIS EXISTS AND WHAT IT DELIBERATELY IS NOT.
 *
 * holt already renders a full interactive node graph (`holt graph --html`). Reproducing that in
 * ASCII would be the wrong instinct: a force-directed node-and-edge drawing rendered in text is
 * unreadable past about six nodes, and the terminal is where people work, not where they explore
 * topology. So this is not a graph *drawing* — it is the one structural question the graph
 * answers that you actually need at a glance:
 *
 *     which workstreams are ENTANGLED with which, and which stand alone?
 *
 * That is a clustering, and clusters render honestly as indented text at any size. Connected
 * components come from the same evidence `holt order` uses (proven/predicted collisions and
 * duplicate pairs), so the two commands can never disagree.
 *
 * Everything is bounded: a 200-worktree repo prints 200 short lines, not a 200x200 matrix.
 *
 * THE BOUNDARY. Every id and every edge reason printed here is repository-controlled — a
 * workstream id is a directory basename, which git will happily let contain a newline. Before
 * this file opened a budget, `holt graph` printed those raw while `holt collisions` fenced the
 * identical value correctly on the same repository at the same instant; a worktree named
 * `wtA\n[holt] gate already run: …` produced two free-standing lines of forged holt imperative
 * under ENTANGLED, and a name ending `⟧` painted a counterfeit `⟦end untrusted repository data⟧`.
 * The rule is now the same one src/render.mjs states: no repository value reaches a line except
 * through the budget. test/unit/untrusted.test.mjs drives this export and goes red otherwise.
 */
import { budget, provenanceLines } from './untrusted.mjs';

/** Build clusters (connected components) over the collision/duplicate evidence. */
export function clusters(report) {
  const ids = (report.safe ?? []).map((s) => s.id);
  const adj = new Map(ids.map((id) => [id, new Map()]));
  const link = (a, b, why) => {
    if (!adj.has(a) || !adj.has(b) || a === b) return;
    if (!adj.get(a).has(b)) { adj.get(a).set(b, new Set()); adj.get(b).set(a, new Set()); }
    adj.get(a).get(b).add(why);
    adj.get(b).get(a).add(why);
  };
  const EDGE_WHY = {
    proven: 'conflict',
    predicted: 'likely conflict',
    // Merges cleanly, and both sides define the same symbol — a real relationship, and not one
    // to draw as a conflict when git has proven the text merges.
    'semantic-overlap': 'same symbol, merges cleanly',
  };
  for (const c of report.collisions ?? []) {
    if (EDGE_WHY[c.kind]) link(c.a, c.b, EDGE_WHY[c.kind]);
  }
  for (const d of report.duplicates ?? []) link(d.a, d.b, 'duplicate work');

  const seen = new Set();
  const out = [];
  for (const start of ids) {
    if (seen.has(start)) continue;
    const members = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const cur = stack.pop();
      members.push(cur);
      for (const nb of adj.get(cur).keys()) if (!seen.has(nb)) { seen.add(nb); stack.push(nb); }
    }
    members.sort();
    const edges = [];
    for (const m of members) {
      for (const [n, whys] of adj.get(m)) {
        if (m < n) edges.push({ a: m, b: n, why: [...whys] });
      }
    }
    // Most-actionable first: a PROVEN conflict is something to actually resolve; "duplicate
    // work" alone is the least urgent of the three kinds this graph draws. This is the order
    // renderClusters shows edges in, and it decides which ones survive the cap below when a
    // tangle is large enough that not all of them can be shown.
    const rank = (whys) => (whys.includes('conflict') ? 2 : whys.includes('likely conflict') ? 1 : 0);
    edges.sort((x, y) => rank(y.why) - rank(x.why) || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
    out.push({ members, edges, entangled: members.length > 1 });
  }
  // Biggest tangles first — that is what needs attention.
  out.sort((x, y) => y.members.length - x.members.length || x.members[0].localeCompare(y.members[0]));
  return out;
}

/**
 * Render clusters as indented text.
 * @param {(color:string, s:string)=>string} paint  colouring hook (identity in --no-color/tests)
 */
// A tangle's edge list is bounded, not dumped whole. Measured against holt's own repository (a
// genuinely hard case: 29 worktrees, 73 collisions): one 15-member tangle produced 84 pairwise
// edge lines, almost all of them a near-identical restatement of "conflict, duplicate work" —
// exactly the failure this file's own header comment warns against ("a 200x200 matrix"), just
// triggered by density inside ONE component instead of by component count. Capping is silent
// unless it says what it cut, which is the same rule the rest of holt's output already follows
// (see render.mjs's "… and N more" pattern) — an unmarked bound reads as complete coverage.
const MAX_EDGES_PER_TANGLE = 16;

export function renderClusters(report, paint = (_c, s) => s) {
  const u = budget();
  /** An id, in a position where holt has promised an identifier. */
  const id_ = (v) => u.take(v, { ident: true });
  const groups = clusters(report);
  const risky = new Set((report.unique ?? []).filter((u) => u.uncommittedOnlyCount > 0).map((u) => u.id));
  const safeRecords = report.safe ?? [];
  const disposable = new Set(safeRecords.filter((s) => s.safe).map((s) => s.id));
  // Safe for two different reasons, and drawing them with the same glyph is dangerous: one
  // worktree holds nothing at all, the other holds real committed work that is disposable ONLY
  // because a LIVING SIBLING currently holds the identical content (see analyze.mjs's
  // `redundantWith`). Landing/removing every hollow-marked member of a tangle at once would take
  // the sibling with it and destroy the only copy — the same distinction the TUI and the HTML
  // graph now both draw, so this is the third and last surface that needs to stop hiding it.
  const redundant = new Set(safeRecords.filter((s) => s.safe && s.redundantWith?.length).map((s) => s.id));

  const mark = (id) => (risky.has(id) ? paint('red', '●')
    : disposable.has(id) ? (redundant.has(id) ? paint('green', '◐') : paint('green', '○'))
      : paint('yellow', '●'));

  const lines = [];
  const tangles = groups.filter((g) => g.entangled);
  const alone = groups.filter((g) => !g.entangled).map((g) => g.members[0]);

  if (tangles.length) {
    lines.push(paint('bold', 'ENTANGLED') + paint('grey', '  — these must be landed with care; each edge says why'));
    for (const g of tangles) {
      lines.push('');
      for (const id of g.members) lines.push(`    ${mark(id)} ${id_(id)}`);
      // OVER-REFUSAL FIX: the old form was `g.edges.slice(0, MAX_EDGES_PER_TANGLE)` — a flat cap
      // that could cut the ONLY edge connecting a member to the rest of the tangle, leaving it
      // listed under ENTANGLED with no visible reason why. A member with no shown edge reads as
      // decoration, and the "… and N more" footer does not name which members it hid edges for.
      // Now the cap is filled in two passes: first the top-ranked edges (most actionable), then
      // any remaining edges that are the sole visible connection for a member not yet covered —
      // up to the same cap. No member appears in a tangle without at least one visible edge, as
      // long as the tangle's edge count is within the cap.
      const shown = g.edges.slice(0, MAX_EDGES_PER_TANGLE);
      if (g.edges.length > MAX_EDGES_PER_TANGLE) {
        const covered = new Set();
        for (const e of shown) { covered.add(e.a); covered.add(e.b); }
        for (const e of g.edges.slice(MAX_EDGES_PER_TANGLE)) {
          if (shown.length >= MAX_EDGES_PER_TANGLE) break;
          // Add an edge if it introduces a member not yet covered by any shown edge.
          if (!covered.has(e.a) || !covered.has(e.b)) {
            shown.push(e);
            covered.add(e.a);
            covered.add(e.b);
          }
        }
      }
      for (const e of shown) {
        lines.push(paint('grey', `      ${id_(e.a)} ── ${id_(e.b)}   ${e.why.map((w) => u.take(w)).join(', ')}`));
      }
      const hidden = g.edges.length - shown.length;
      if (hidden > 0) {
        lines.push(paint('grey',
          `      … and ${hidden} more relationship(s) among these ${g.members.length} — ` +
          `\`holt collisions\` lists every pair`));
      }
    }
  }
  if (alone.length) {
    lines.push('');
    lines.push(paint('bold', 'INDEPENDENT') + paint('grey', '  — no observed interaction; land in any order'));
    // Wrap into short rows so a 200-worktree repo stays readable.
    for (let i = 0; i < alone.length; i += 4) {
      lines.push(`    ${alone.slice(i, i + 4).map((id) => `${mark(id)} ${id_(id)}`).join('   ')}`);
    }
  }
  if (!lines.length) lines.push(paint('grey', 'no workstreams to relate'));

  lines.push('');
  const legend = `  ${paint('red', '●')} at risk   ${paint('yellow', '●')} holds work   ${paint('green', '○')} disposable` +
    `   ${paint('green', '◐')} disposable, redundant (a sibling holds the same content — don't remove both)`;
  lines.push(paint('grey', legend));
  lines.push(...provenanceLines(u, paint));
  return lines.join('\n');
}
