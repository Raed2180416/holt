// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * The instrument behind test/e2e/index-flag-blindness.test.mjs, pinned directly.
 *
 * These assertions import the function the fix ADDS, so they cannot be run against the tree
 * without the fix — they are new-API tests, and the behavioural red/green proof lives in the e2e
 * file, which goes through public surfaces only. What is pinned here is the CONTRACT the rest of
 * the fix is built on: three real outcomes plus a distinguishable failure, and a `how` that
 * separates "measured, nothing flagged" from "could not measure". Those two are both the empty
 * list, and conflating them is the original defect in miniature.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { newRepo } from '../fixtures.mjs';
import { indexFlagDelta } from '../../src/scan.mjs';

test('indexFlagDelta: resolves a flagged path to at-risk / clean / absent / unknown', async () => {
  const fx = await newRepo('ifd');
  await fx.write('modified.txt', 'original\n');
  await fx.write('untouched.txt', 'original\n');
  await fx.write('vanished.txt', 'original\n');
  await fx.write('weird.txt', 'original\n');
  await fx.commit('base');
  const wt = await fx.worktree('w');
  try {
    for (const f of ['modified.txt', 'untouched.txt', 'vanished.txt', 'weird.txt']) {
      await fx.git(['update-index', '--skip-worktree', f], wt);
    }
    await fx.write('modified.txt', 'CHANGED — exists nowhere else\n', wt);
    await fs.rm(path.join(wt, 'vanished.txt'));                 // absent (the sparse case)
    await fs.rm(path.join(wt, 'weird.txt'));
    await fs.mkdir(path.join(wt, 'weird.txt'));                 // unhashable

    assert.equal((await fx.git(['status', '--porcelain', '-uall'], wt)).trim(), '',
      'premise: git reports none of this');

    const r = await indexFlagDelta(wt);
    assert.equal(r.how, 'ls-files-v');
    assert.deepEqual(r.atRisk, ['modified.txt'], 'only the genuinely-different file is at risk');
    assert.deepEqual(r.unknown, ['weird.txt'], 'only the unhashable one is unknown');
    assert.ok(!r.stamp.includes('vanished.txt'), 'an absent path contributes nothing at all');
  } finally { await fx.cleanup(); }
});

test('indexFlagDelta: an unflagged repository is measured, not merely silent', async () => {
  const fx = await newRepo('ifd-clean');
  const wt = await fx.worktree('w');
  try {
    const r = await indexFlagDelta(wt);
    assert.equal(r.how, 'ls-files-v', 'a successful measurement says so');
    assert.deepEqual(r.atRisk, []);
    assert.deepEqual(r.unknown, []);
    assert.equal(r.stamp, '', 'and costs the cache nothing');
  } finally { await fx.cleanup(); }
});

test('indexFlagDelta: never throws, and a failed run is distinguishable from a clean one', async () => {
  // The guard's critical path calls this. A rejection there becomes an exception, and an
  // exception in a PreToolUse hook is exit 1 — which the protocol treats as non-blocking, so the
  // command RUNS. Failure has to arrive as a value.
  const fx = await newRepo('ifd-broken');
  try {
    const missing = await indexFlagDelta(path.join(fx.root, 'no-such-dir'));
    assert.notEqual(missing.how, 'ls-files-v',
      'an unrunnable instrument must not report the same `how` as a successful one');
    assert.deepEqual(missing.atRisk, [], 'a failed probe reports no findings…');
    assert.ok(missing.error, '…and says why, so a refusal can name the instrument');
  } finally { await fx.cleanup(); }
});

test('indexFlagDelta: the stamp moves when a flagged file changes, so a cached verdict cannot go stale', async () => {
  const fx = await newRepo('ifd-stamp');
  await fx.write('cfg.json', '{"a":1}\n');
  await fx.commit('base');
  const wt = await fx.worktree('w');
  try {
    await fx.git(['update-index', '--skip-worktree', 'cfg.json'], wt);
    const before = (await indexFlagDelta(wt)).stamp;
    await fx.write('cfg.json', '{"a":2,"secret":"only copy"}\n', wt);
    const after = (await indexFlagDelta(wt)).stamp;
    assert.notEqual(after, before,
      'the fingerprint must see an edit git status is silent about, or the cache re-opens the hole');
  } finally { await fx.cleanup(); }
});
