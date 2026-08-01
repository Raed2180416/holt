// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — the CI gate ("published numbers must match reality") used to be `grep -q "$N" "$f"`,
 * which is satisfied by the digits of N appearing ANYWHERE in the file: an SVG coordinate, a hex
 * colour, a port number, a year. That means a stale badge sitting next to an unrelated,
 * coincidentally-matching number would pass a check whose whole job is to catch a stale badge.
 *
 * This file proves the REPLACEMENT (scripts/check-published-numbers.mjs, built on the same
 * context-shaped patterns as published-numbers.test.mjs) actually closes that hole, using the
 * three things a "we tightened it" claim needs and a bare assertion does not:
 *
 *   1. it still passes on the real, current files (tightening it did not just make it refuse
 *      everything — see CLAUDE.md's "conservative is not correct");
 *   2. it fails when a real claim is wrong, on a scratch copy, not asserted from memory;
 *   3. it does NOT fail (as the old `grep -q` implementation did) merely from a wrong claim
 *      sitting near a coincidentally-matching decoy number — proving the fix is about SHAPE, not
 *      about being stricter in a way that would also reject correct files.
 *
 * Scratch copies are written under os.tmpdir() (TMPDIR=/home/raed/.holt-work in this repo's test
 * runs) — never over the real README/BENCHMARKS/site files.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claims, TEST_COUNT_PATTERNS, MUTATION_PATTERNS, MUTATION_HISTORICAL_EXCEPTION } from '../lib/published-number-patterns.mjs';
import { checkAll } from '../../scripts/check-published-numbers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SURFACES = ['README.md', 'BENCHMARKS.md', 'site/index.html'];

async function readAll() {
  const out = [];
  for (const f of SURFACES) out.push([f, await fs.readFile(path.join(ROOT, f), 'utf8')]);
  return out;
}

/** The number every surface currently agrees on — derived, never hardcoded, so this file does
 *  not need editing every time the suite grows. published-numbers.test.mjs already proves all
 *  surfaces agree; this reuses that same fact rather than re-deriving a different way to be wrong
 *  twice. */
async function currentAgreedNumbers() {
  const entries = await readAll();
  const testCounts = new Set();
  const mutationScores = new Set();
  for (const [, text] of entries) {
    for (const c of claims(text, TEST_COUNT_PATTERNS)) testCounts.add(c);
    for (const c of claims(text, MUTATION_PATTERNS, 2)) {
      if (c !== MUTATION_HISTORICAL_EXCEPTION) mutationScores.add(c);
    }
  }
  assert.equal(testCounts.size, 1, `expected the surfaces to already agree on a test count: ${[...testCounts]}`);
  assert.equal(mutationScores.size, 1, `expected the surfaces to already agree on a mutation score: ${[...mutationScores]}`);
  return { actualTests: [...testCounts][0], actualMutation: [...mutationScores][0] };
}

test('gate: the tightened checker PASSES on the real files against the currently agreed numbers', async () => {
  const entries = await readAll();
  const actual = await currentAgreedNumbers();
  const failures = checkAll(entries, actual);
  assert.deepEqual(failures, [], `tightened checker should pass on real, current, agreeing surfaces: ${JSON.stringify(failures)}`);
});

test('gate: the tightened checker FAILS when a real claim is wrong (scratch copy, not asserted)', async () => {
  const { actualTests } = await currentAgreedNumbers();
  const wrong = String(Number(actualTests) + 1);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-pubnum-gate-'));
  const file = path.join(dir, 'stale-badge.html');
  await fs.writeFile(
    file,
    `<img src="https://img.shields.io/badge/tests-${actualTests}%20passing-brightgreen">\n` +
      `<img src="https://img.shields.io/badge/mutation%20score-39%2F39%20killed-brightgreen">\n`,
    'utf8',
  );

  const text = await fs.readFile(file, 'utf8');
  const failures = checkAll([[file, text]], { actualTests: wrong, actualMutation: '39/39' });
  assert.ok(failures.length > 0, 'checker should have reported the stale badge as a failure, but reported none');
  assert.match(failures[0], new RegExp(`do not match the measured count ${wrong}`));
});

test('gate: a coincidental decoy number (SVG coordinate / hex colour) does NOT fool the checker, ' +
     'even though the old `grep -q "$N" file` substring check WOULD be fooled by it', async () => {
  const { actualMutation } = await currentAgreedNumbers();
  const staleCount = '474'; // the badge's real (stale) claim, deliberately never updated below
  const measuredCount = '475'; // what the suite "actually reports" this run — one more than published

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-pubnum-decoy-'));
  const file = path.join(dir, 'decoy.html');
  // The badge is stale (still says 474). Elsewhere, purely by coincidence, "475" appears inside an
  // SVG coordinate and a hex-colour-shaped string — never inside a recognised claim shape.
  await fs.writeFile(
    file,
    `<img src="https://img.shields.io/badge/tests-${staleCount}%20passing-brightgreen">\n` +
      `<svg viewBox="0 0 ${measuredCount} 300"><rect x="${measuredCount}" y="10" fill="#475869"/></svg>\n` +
      `<img src="https://img.shields.io/badge/mutation%20score-39%2F39%20killed-brightgreen">\n`,
    'utf8',
  );
  const text = await fs.readFile(file, 'utf8');

  // Reproduce the OLD gate's exact logic and show it gives a FALSE PASS: the stale badge (474)
  // sits right beside a coincidentally-matching "475", and a bare substring search cannot tell
  // the difference between a claim and a coordinate.
  const oldCheckWouldPass = text.includes(measuredCount);
  assert.equal(oldCheckWouldPass, true,
    'this test is only meaningful if the OLD substring check would have been fooled — construct a better decoy if this fails');

  // The NEW checker, told the suite actually measured 475 tests, must FAIL — the only claim it can
  // find in a recognised shape is the stale "474" badge, and 474 !== 475.
  const failures = checkAll([[file, text]], { actualTests: measuredCount, actualMutation });
  assert.ok(failures.length > 0,
    'tightened checker must fail here — the old grep-based gate would have silently passed a stale badge');
  assert.match(failures[0], /\["474"\]/, `expected the checker to report the real (stale) claim "474", not the decoy: ${JSON.stringify(failures)}`);
});
