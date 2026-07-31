/**
 * holt partition — the pre-flight split. Pure function, so the guarantees it advertises are
 * asserted directly: disjoint buckets, every observed hotspot owned by exactly one agent,
 * weight balance sanity, determinism.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partitionPlan } from '../../src/partition.mjs';

const FILES = [
  'src/a.js', 'src/b.js', 'src/c.js', 'src/d.js',
  'docs/x.md', 'docs/y.md',
  'test/t1.js', 'test/t2.js', 'test/t3.js',
  'README.md',
];

test('partition: buckets are disjoint and cover every top-level segment', () => {
  const plan = partitionPlan({ collisions: [] }, FILES, { agents: 3 });
  assert.equal(plan.buckets.length, 3);
  const all = plan.buckets.flatMap((b) => b.dirs);
  assert.equal(new Set(all).size, all.length, 'a directory appeared in two buckets');
  assert.deepEqual(new Set(all), new Set(['src', 'docs', 'test', '<root>']));
});

test('partition: every observed hotspot gets exactly one owner, with holders named', () => {
  const plan = partitionPlan({
    collisions: [
      { a: 'wt1', b: 'wt2', kind: 'predicted', sharedFiles: ['src/a.js'] },
      { a: 'wt2', b: 'wt3', kind: 'proven', sharedFiles: ['src/a.js', 'docs/x.md'] },
    ],
  }, FILES, { agents: 2 });
  assert.equal(plan.avoid.length, 2);
  const hot = plan.avoid.find((h) => h.file === 'src/a.js');
  assert.deepEqual(hot.currentlyHeldBy, ['wt1', 'wt2', 'wt3']);
  assert.equal(typeof hot.assignTo, 'number', 'hotspot must be assigned to exactly one agent');
  const srcOwner = plan.buckets.find((b) => b.dirs.includes('src')).agent;
  assert.equal(hot.assignTo, srcOwner, 'hotspot owner must be the owner of its directory');
});

test('partition: weight is balanced within one heaviest-directory of even', () => {
  const plan = partitionPlan({ collisions: [] }, FILES, { agents: 2 });
  const weights = plan.buckets.map((b) => b.weight);
  assert.equal(weights.reduce((a, b) => a + b, 0), FILES.length);
  assert.ok(Math.abs(weights[0] - weights[1]) <= 4, `imbalanced: ${weights}`);
});

test('partition: agents below 2 clamp to 2, and output is deterministic', () => {
  const one = partitionPlan({ collisions: [] }, FILES, { agents: 0 });
  assert.equal(one.buckets.length, 2);
  assert.deepEqual(
    partitionPlan({ collisions: [] }, FILES, { agents: 3 }),
    partitionPlan({ collisions: [] }, FILES, { agents: 3 }));
});
