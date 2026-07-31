/**
 * holt order — the landing-order optimizer is a pure function over the report, so every
 * property is tested directly: exact component splitting, deterministic peel order, the
 * proven-clean exclusion, and the honesty of conflictsWithLater.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { landingOrder } from '../../src/order.mjs';

const report = ({ ids, collisions = [], duplicates = [] }) => ({
  safe: ids.map((id) => ({ id })),
  unique: ids.map((id) => ({ id, committedFileCount: 0, uncommittedCount: 0, uniqueSymbolCount: 0 })),
  collisions,
  duplicates,
});

test('order: streams with no evidence land in the parallel group', () => {
  const plan = landingOrder(report({ ids: ['a', 'b', 'c'] }));
  assert.deepEqual(plan.parallel, ['a', 'b', 'c']);
  assert.equal(plan.lanes.length, 0);
});

test('order: a proven collision entangles exactly its pair, nothing else', () => {
  const plan = landingOrder(report({
    ids: ['a', 'b', 'c'],
    collisions: [{ a: 'a', b: 'b', kind: 'proven' }],
  }));
  assert.deepEqual(plan.parallel, ['c']);
  assert.equal(plan.lanes.length, 1);
  assert.deepEqual(plan.lanes[0].members, ['a', 'b']);
});

test('order: proven-clean is evidence of NON-interaction and creates no lane', () => {
  const plan = landingOrder(report({
    ids: ['a', 'b'],
    collisions: [{ a: 'a', b: 'b', kind: 'proven-clean' }],
  }));
  assert.deepEqual(plan.parallel, ['a', 'b']);
});

test('order: min-entanglement peel lands the least-connected stream first', () => {
  // hub conflicts with both spokes; spokes do not conflict with each other.
  const plan = landingOrder(report({
    ids: ['hub', 'spoke1', 'spoke2'],
    collisions: [
      { a: 'hub', b: 'spoke1', kind: 'predicted' },
      { a: 'hub', b: 'spoke2', kind: 'predicted' },
    ],
  }));
  const order = plan.lanes[0].order.map((s) => s.id);
  // Min-degree first: a spoke (degree 1) must land before the hub (degree 2). Beyond that the
  // total number of watched merges is identical for any order of a path graph, so the test
  // asserts the PROPERTIES, not one incidental sequence.
  assert.notEqual(order[0], 'hub', `a spoke must land first, got ${order}`);
  assert.deepEqual(plan.lanes[0].order[0].conflictsWithLater.map((c) => c.id), ['hub']);
  // Every edge is surfaced exactly once, at the step where its first endpoint lands.
  const surfaced = plan.lanes[0].order.flatMap((s) => s.conflictsWithLater.map((c) => [s.id, c.id].sort().join('~')));
  assert.deepEqual(surfaced.sort(), ['hub~spoke1', 'hub~spoke2']);
  // The final stream has nothing after it to conflict with.
  assert.deepEqual(plan.lanes[0].order.at(-1).conflictsWithLater, []);
});

test('order: duplicates entangle a pair with a stated why', () => {
  const plan = landingOrder(report({
    ids: ['x', 'y'],
    duplicates: [{ a: 'x', b: 'y', sharedCount: 3 }],
  }));
  assert.equal(plan.lanes.length, 1);
  const whys = plan.lanes[0].order[0].conflictsWithLater.flatMap((c) => c.why).join(' ');
  assert.match(whys, /duplicate work/);
});

test('order: deterministic across runs on identical input', () => {
  const input = report({
    ids: ['n1', 'n2', 'n3', 'n4'],
    collisions: [
      { a: 'n1', b: 'n2', kind: 'predicted' },
      { a: 'n2', b: 'n3', kind: 'proven' },
    ],
  });
  assert.deepEqual(landingOrder(input), landingOrder(input));
});

test('SEQUENCING: co-located pairs entangle the ORDER even though triage hides them', async (t) => {
  // The defect this prevents, and why one array cannot serve both consumers:
  // two agents append different keys to the same registry file. They share no SYMBOL, so the
  // human triage view correctly stays quiet (admitting bare file overlap produced 616 findings
  // with 6 real ones on a real repo). But sequencing them in PARALLEL means the second one fails
  // to apply — the flagship "landing layer" claim breaking on the exact case it exists for.
  const report = {
    safe: [{ id: 'a' }, { id: 'b' }],
    unique: [{ id: 'a' }, { id: 'b' }],
    collisions: [],                                   // what a human reads: nothing
    collisionsAll: [{ a: 'a', b: 'b', kind: 'co-located', sharedFiles: ['registry.mjs'] }],
    duplicates: [],
  };
  const plan = landingOrder(report);
  assert.equal(plan.parallel.length, 0, 'co-located workstreams must NOT be called parallel-safe');
  assert.equal(plan.lanes.length, 1, 'they belong in one lane');
  assert.deepEqual(plan.lanes[0].members, ['a', 'b']);
  const why = plan.lanes[0].order[0].conflictsWithLater.flatMap((c) => c.why).join(' ');
  assert.match(why, /registry\.mjs/, 'and the reason must name the shared file');
});

test('SEQUENCING: with no evidence at all, workstreams stay parallel — the fix is not trigger-happy', () => {
  const plan = landingOrder({
    safe: [{ id: 'x' }, { id: 'y' }], unique: [{ id: 'x' }, { id: 'y' }],
    collisions: [], collisionsAll: [], duplicates: [],
  });
  assert.deepEqual(plan.parallel, ['x', 'y']);
});
