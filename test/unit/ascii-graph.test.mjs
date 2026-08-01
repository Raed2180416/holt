/**
 * The terminal relationship map. It is deliberately a CLUSTERING, not a node drawing — a
 * force-directed graph rendered in text is unreadable past a handful of nodes, and the terminal
 * is where people work, not where they explore topology. So the tests assert the structural
 * claims: components are exact, evidence is named, and the output stays bounded at scale.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clusters, renderClusters } from '../../src/ascii-graph.mjs';

const report = ({ ids, collisions = [], duplicates = [], unique = [], redundant = [] }) => ({
  safe: ids.map((id) => ({
    id,
    safe: !unique.some((u) => u.id === id),
    // Mirrors analyze.mjs's safeToDelete(): present (and non-empty) only for a workstream that
    // is disposable BECAUSE a living sibling holds the identical content, absent otherwise.
    ...(redundant.includes(id) ? { redundantWith: ['some-sibling'] } : {}),
  })),
  unique,
  collisions,
  duplicates,
});

test('clusters: unrelated workstreams are each their own component', () => {
  const g = clusters(report({ ids: ['a', 'b', 'c'] }));
  assert.equal(g.length, 3);
  assert.ok(g.every((x) => !x.entangled));
});

test('clusters: collisions and duplicates both entangle, and the WHY is carried', () => {
  const g = clusters(report({
    ids: ['a', 'b', 'c', 'd'],
    collisions: [{ a: 'a', b: 'b', kind: 'proven' }],
    duplicates: [{ a: 'c', b: 'd', sharedCount: 2 }],
  }));
  const tangles = g.filter((x) => x.entangled);
  assert.equal(tangles.length, 2);
  const whys = tangles.flatMap((t) => t.edges.flatMap((e) => e.why));
  assert.ok(whys.includes('conflict'), `proven collision must read as a conflict: ${whys}`);
  assert.ok(whys.includes('duplicate work'), `duplicates must be named: ${whys}`);
});

test('clusters: proven-clean is NOT an edge — evidence of non-interaction must not entangle', () => {
  const g = clusters(report({ ids: ['a', 'b'], collisions: [{ a: 'a', b: 'b', kind: 'proven-clean' }] }));
  assert.equal(g.filter((x) => x.entangled).length, 0);
});

test('clusters: a transitive chain forms ONE component, not three pairs', () => {
  const g = clusters(report({
    ids: ['a', 'b', 'c'],
    collisions: [{ a: 'a', b: 'b', kind: 'predicted' }, { a: 'b', b: 'c', kind: 'predicted' }],
  }));
  const tangles = g.filter((x) => x.entangled);
  assert.equal(tangles.length, 1);
  assert.deepEqual(tangles[0].members, ['a', 'b', 'c']);
});

test('render: names every entangled member and its evidence, and separates the independent', () => {
  const text = renderClusters(report({
    ids: ['x', 'y', 'lonely'],
    collisions: [{ a: 'x', b: 'y', kind: 'predicted' }],
  }));
  assert.match(text, /ENTANGLED/);
  assert.match(text, /x ── y/);
  assert.match(text, /likely conflict/);
  assert.match(text, /INDEPENDENT/);
  assert.match(text, /lonely/);
});

test('render: stays BOUNDED at scale — 200 independent workstreams do not print a 200x200 matrix', () => {
  const ids = Array.from({ length: 200 }, (_, i) => `w${String(i).padStart(3, '0')}`);
  const text = renderClusters(report({ ids }));
  const lines = text.split('\n');
  assert.ok(lines.length < 80, `200 workstreams must render compactly, got ${lines.length} lines`);
  assert.ok(text.includes('w000') && text.includes('w199'), 'and must still show every workstream');
});

test('render: an empty repo says so rather than printing an empty frame', () => {
  assert.match(renderClusters(report({ ids: [] })), /no workstreams/);
});

/**
 * THE DEFECT THIS PINS: a workstream that is disposable because it holds NOTHING and one that is
 * disposable ONLY because a living sibling holds the identical content (`redundantWith`) rendered
 * with the exact same glyph. Landing/removing every hollow-looking member of a tangle at once
 * would take the sibling with it and destroy the only copy — the failure mode this graph exists
 * to prevent, so it must not draw the two cases identically.
 */
test('render: a redundant-but-safe workstream draws a different marker than a genuinely empty one', () => {
  const text = renderClusters(report({
    ids: ['twin-a', 'twin-b', 'lonely-empty'],
    duplicates: [{ a: 'twin-a', b: 'twin-b', sharedCount: 1 }],
    redundant: ['twin-a', 'twin-b'],
  }));
  const lineFor = (id) => text.split('\n').find((l) => l.includes(id));
  const twinAMark = lineFor('twin-a').trim()[0];
  const twinBMark = lineFor('twin-b').trim()[0];
  const emptyMark = lineFor('lonely-empty').trim()[0];

  assert.equal(twinAMark, twinBMark, 'both redundant siblings must share the same marker');
  assert.notEqual(twinAMark, emptyMark,
    `a redundant-safe workstream and a genuinely empty one drew the SAME marker: ${JSON.stringify({ twinAMark, emptyMark })}`);
  assert.match(text, /redundant/i, 'the legend must explain what the extra marker means');
});

/**
 * THE DEFECT THIS PINS, measured on holt's own repository (29 worktrees, 73 collisions): one
 * 15-member tangle printed 84 individual pairwise edge lines — almost all of them a near-
 * identical restatement of "conflict, duplicate work" — which is unreadable at a glance and is
 * exactly the "200x200 matrix" this file's own header comment says the design must never produce,
 * just triggered by density inside one component rather than by component count.
 */
test('render: a dense tangle bounds its edge list and says how much it cut', () => {
  const ids = Array.from({ length: 8 }, (_, i) => `w${i}`);
  const collisions = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) collisions.push({ a: ids[i], b: ids[j], kind: 'proven' });
  }
  const totalEdges = collisions.length; // 8 choose 2 = 28
  const text = renderClusters(report({ ids, collisions }));
  const lines = text.split('\n');

  const edgeLines = lines.filter((l) => l.includes('──'));
  assert.ok(edgeLines.length < totalEdges,
    `expected the edge list to be bounded, but all ${totalEdges} edges were printed`);
  assert.ok(edgeLines.length > 0, 'must still show SOME edges, or the tangle looks like decoration');

  // Filtering is never silent: the omission must be stated, and stated with the right count.
  const hidden = totalEdges - edgeLines.length;
  assert.match(text, new RegExp(`and ${hidden} more relationship`),
    `the cut must say exactly how many relationships it omitted: ${JSON.stringify({ hidden, text })}`);
  assert.match(text, /holt collisions/, 'and point at the command that lists every pair');

  // ANTI-VACUITY: every member must still be named even though most of their edges are not.
  for (const id of ids) assert.ok(text.includes(id), `member '${id}' must still be listed: ${text}`);
});
