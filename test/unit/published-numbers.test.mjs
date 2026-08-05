// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — every published surface must state the SAME numbers, or deliberately publish none.
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
 * This test does the half that needs no test run: every surface must AGREE. "No current figure"
 * is a valid state only when every surface says so explicitly. CI does the other half when a
 * figure is published — that the agreed number matches what the suite actually reports. Neither
 * alone is enough: agreement on a stale number is still wrong, and a correct README beside a
 * stale site is still a contradiction in public.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_COUNT_PATTERNS as TEST_COUNT, MUTATION_PATTERNS as MUTATION, claims } from '../lib/published-number-patterns.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SURFACES = ['README.md', 'BENCHMARKS.md', 'site/index.html'];
const WITHHELD_MARKER = /No current test count or mutation score is\s+published\./i;
// NO HARDCODED "MEASURED" CONSTANTS LIVE HERE ANY MORE, AND THAT IS THE POINT.
//
// This file carried `MEASURED_TEST_COUNT = '1055'` under a comment claiming it was measured
// independently. Nothing measured it — it was typed — and it was already wrong: the suite defined
// 1057. So this gate would have gone GREEN while the README published a false number, which is
// this project's signature defect (a conclusion asserted without a measurement behind it) occurring
// inside the gate written to prevent it.
//
// A test cannot honestly produce these numbers. It cannot count the suite it is running inside,
// and it must not spend two hours running the mutation harness. So this file asserts only what it
// can prove cheaply and truthfully: that the surfaces AGREE WITH EACH OTHER, that absence is an
// explicit public choice rather than a vacuous regex pass, that a score with survivors is never a
// headline, and that no install command is advertised before it works.
//
// Agreement between three copies of a stale number is still a publishing failure, so agreement is
// NOT sufficient — it is only the part a unit test can honestly check. Comparison against a
// measurement that actually ran is `scripts/verify-published-numbers.mjs`, the CI job the rules
// require for anything a test cannot prove on its own.

async function readAll() {
  const out = new Map();
  for (const f of SURFACES) out.set(f, await fs.readFile(path.join(ROOT, f), 'utf8'));
  return out;
}

function assertSynchronizedOrWithheld(files, { label, patterns, arity = 1, exceptions = [] }) {
  const byFile = new Map();
  for (const [f, text] of files) {
    byFile.set(f, [...new Set(claims(text, patterns, arity))].filter((c) => !exceptions.includes(c)));
  }

  // Absence is allowed only as a visible, synchronized publishing decision. This is the
  // anti-vacuity condition for the no-headline state: deleting or rewording every recognised
  // claim does not pass unless all three public surfaces tell readers the figure is withheld.
  const total = [...byFile.values()].flat().length;
  if (total === 0) {
    for (const [f, text] of files) {
      assert.match(text, WITHHELD_MARKER,
        `${f} publishes no ${label}, but does not explicitly state that current public figures are withheld`);
    }
    return { state: 'withheld', values: [], byFile };
  }

  // A mixed state is a contradiction: once any surface publishes a figure, all surfaces must
  // publish the same one and the withholding sentence must disappear from all of them.
  for (const [f, found] of byFile) {
    assert.ok(found.length > 0, `${f} publishes no ${label} this test can see — mixed or pattern-drifted state`);
    assert.doesNotMatch(files.get(f), WITHHELD_MARKER,
      `${f} both publishes a ${label} and says no current figure is published`);
    assert.equal(new Set(found).size, 1, `${f} publishes more than one ${label}: ${JSON.stringify(found)}`);
  }

  // Which value is correct is not knowable here; scripts/verify-published-numbers.mjs is what
  // compares the synchronized claim against a run that actually measured it.
  const values = new Set([...byFile.values()].flat());
  assert.equal(values.size, 1,
    `the surfaces disagree with each other about the ${label}: ${JSON.stringify([...byFile])}`);
  return { state: 'published', values: [...values], byFile };
}

test('published numbers: test count is synchronized or explicitly withheld everywhere', async () => {
  const files = await readAll();
  assertSynchronizedOrWithheld(files, { label: 'test count', patterns: TEST_COUNT });
});

test('published numbers: mutation score is synchronized, survivor-free, or explicitly withheld', async () => {
  const files = await readAll();
  // The falsification history ("the first run scored 10/12") is a deliberate, permanent record of
  // a WORSE past score, not a competing claim about today. It is the one legitimate exception.
  const result = assertSynchronizedOrWithheld(files, {
    label: 'mutation score',
    patterns: MUTATION,
    arity: 2,
    exceptions: ['10/12'],
  });
  if (result.state === 'withheld') return;

  // A SCORE WITH SURVIVORS IS NOT A HEADLINE. A survivor names a defect the suite cannot see, so
  // publishing "77/78" advertises the hole as though it were the achievement.
  const [current] = result.values;
  const [killed, of] = current.split('/').map(Number);
  assert.equal(killed, of, `a published mutation score with survivors (${current}) must not ship as a headline`);
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
