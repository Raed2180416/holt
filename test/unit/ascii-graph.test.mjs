/**
 * The terminal relationship map. It is deliberately a CLUSTERING, not a node drawing — a
 * force-directed graph rendered in text is unreadable past a handful of nodes, and the terminal
 * is where people work, not where they explore topology. So the tests assert the structural
 * claims: components are exact, evidence is named, and the output stays bounded at scale.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clusters, renderClusters } from '../../src/ascii-graph.mjs';

const report = ({ ids, collisions = [], duplicates = [], unique = [] }) => ({
  safe: ids.map((id) => ({ id, safe: !unique.some((u) => u.id === id) })),
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
