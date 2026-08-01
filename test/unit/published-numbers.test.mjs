// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — every published surface must state the SAME numbers.
 *
 * This repository has shipped its test count three different ways at once: README said 348, the
 * live site said 199, and the suite actually reported 352. The site sat under its own sentence
 * promising that no number is published without its conditions, which is worse than saying
 * nothing — a visitor who checks GitHub right after the site sees two quality claims for one
 * product and has no way to tell which is the lie.
 *
 * The CI gate that was supposed to prevent this checked README.md and BENCHMARKS.md and never
 * looked at site/index.html, so the most public surface was the only unguarded one. It also used
 * `grep -q <number>`, which passes when the number appears ANYWHERE — "352 languages" would
 * satisfy a check meant to be about tests.
 *
 * This test does the half that needs no test run: every surface must AGREE. CI does the other
 * half — that the agreed number matches what the suite actually reports. Neither alone is enough:
 * agreement on a stale number is still wrong, and a correct README beside a stale site is still
 * a contradiction in public.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_COUNT_PATTERNS as TEST_COUNT, MUTATION_PATTERNS as MUTATION, claims } from '../lib/published-number-patterns.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SURFACES = ['README.md', 'BENCHMARKS.md', 'site/index.html'];

async function readAll() {
  const out = new Map();
  for (const f of SURFACES) out.set(f, await fs.readFile(path.join(ROOT, f), 'utf8'));
  return out;
}

test('published numbers: every surface states the SAME test count', async () => {
  const files = await readAll();
  const byFile = new Map();
  for (const [f, text] of files) byFile.set(f, [...new Set(claims(text, TEST_COUNT))]);

  // Anti-vacuity. If the patterns stop matching — a badge is reworded, the tile markup changes —
  // this test would agree with itself about nothing and pass forever. The claims must be FOUND.
  const total = [...byFile.values()].flat().length;
  assert.ok(total >= SURFACES.length,
    `only ${total} test-count claims matched across ${SURFACES.length} surfaces — the patterns ` +
    `have drifted from the copy, so this test is no longer reading the published numbers: ` +
    JSON.stringify([...byFile]));
  for (const [f, found] of byFile) {
    assert.ok(found.length > 0, `${f} publishes no test count this test can see — pattern drift`);
  }

  const distinct = [...new Set([...byFile.values()].flat())];
  assert.equal(distinct.length, 1,
    `the published test count disagrees with itself: ${JSON.stringify([...byFile])}`);
});

test('published numbers: every surface states the SAME mutation score', async () => {
  const files = await readAll();
  const byFile = new Map();
  for (const [f, text] of files) byFile.set(f, [...new Set(claims(text, MUTATION, 2))]);

  const total = [...byFile.values()].flat().length;
  assert.ok(total >= 3,
    `only ${total} mutation-score claims matched — pattern drift: ${JSON.stringify([...byFile])}`);

  // The falsification history ("the first run scored 10/12") is a deliberate, permanent record of
  // a WORSE past score, not a competing claim about today. It is the one legitimate exception.
  const distinct = [...new Set([...byFile.values()].flat())].filter((c) => c !== '10/12');
  assert.equal(distinct.length, 1,
    `the published mutation score disagrees with itself: ${JSON.stringify([...byFile])}`);

  const [killed, of] = distinct[0].split('/').map(Number);
  assert.equal(killed, of, `a published mutation score with survivors (${distinct[0]}) must not ship as a headline`);
});

test('published numbers: no surface advertises an install command that does not exist yet', async () => {
  // `npm install -g holt` was the lead command on both the README and the live site while the
  // package 404ed on the registry — every reader's first action failed. Until it is published,
  // the copy has to say what is true, the same way the pricing tiers do.
  const files = await readAll();
  for (const [f, text] of files) {
    const bare = [...text.matchAll(/npm\s+install\s+-g\s+holt/g)];
    if (!bare.length) continue;
    assert.match(text, /lands with v1|not (?:yet )?(?:on|published)/i,
      `${f} advertises \`npm install -g holt\` with no note that the package is unpublished`);
  }
});
