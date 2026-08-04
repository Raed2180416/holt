/**
 * The social-proof gate. Two failure directions, both embarrassing in different ways: enabling
 * badges too early argues against the project, and a lookup failure that reads as "threshold
 * met" would enable them at zero. The second is the one worth testing hardest.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { evaluate, enable, isDisabled, THRESHOLDS, BEGIN, END } from '../../scripts/milestone.mjs';

test('milestone: below threshold is not met, and says how far off', () => {
  const v = evaluate({ stars: 12 });
  assert.equal(v.met, false);
  assert.equal(v.shortfall.stars, THRESHOLDS.stars - 12);
});

test('milestone: meeting the star threshold is enough', () => {
  assert.equal(evaluate({ stars: THRESHOLDS.stars }).met, true);
  assert.equal(evaluate({ stars: THRESHOLDS.stars - 1 }).met, false);
});

test('SAFETY: missing or zeroed counts can never satisfy the gate', () => {
  for (const counts of [{}, { stars: 0 }, { stars: undefined }, { stars: null }]) {
    assert.equal(evaluate(counts).met, false, `a failed lookup must not enable badges: ${JSON.stringify(counts)}`);
  }
});

test('milestone: the README ships with the block DISABLED', () => {
  const readme = fs.readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  assert.ok(readme.includes(BEGIN), 'the social-proof block must exist');
  assert.ok(isDisabled(readme), 'and it must be commented out until the threshold is reached');
  assert.ok(!/\[!\[stars\]\(https:\/\/img\.shields\.io\/github\/stars[^)]*\)\]/.test(
    readme.split(BEGIN)[0]), 'no star badge may appear before the gated block');
});

test('milestone: enabling is a real change, and then idempotent', () => {
  const readme = fs.readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  const first = enable(readme);
  assert.equal(first.changed, true, first.reason);
  assert.equal(isDisabled(first.readme), false);
  assert.ok(first.readme.includes('shields.io/github/stars'));

  const second = enable(first.readme);
  assert.equal(second.changed, false, 'a scheduled job must not rewrite an already-enabled README');
  assert.equal(second.reason, 'already enabled');
});

test('milestone: a README without the block is left alone rather than corrupted', () => {
  const r = enable('# holt\n\nno block here\n');
  assert.equal(r.changed, false);
  assert.match(r.reason, /no social-proof block/);
});
