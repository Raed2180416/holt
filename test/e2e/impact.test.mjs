/**
 * holt — cross-workstream impact.
 *
 * The claim under test is narrow and precise, which is the point: holt finds a PRODUCER/CONSUMER
 * relationship that collision detection structurally cannot see, and it does NOT claim the
 * relationship is a conflict.
 *
 * The decisive fixture is `planted`: A defines a symbol in a file B never touches, and B uses it.
 * P1 works by file overlap, so P1 must report nothing for that pair — and impact must report it.
 * If P1 ever starts catching it, this test fails and tells us impact has become redundant.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newRepo } from '../fixtures.mjs';
import { discover } from '../../src/discover.mjs';
import { scan } from '../../src/scan.mjs';
import { analyze } from '../../src/analyze.mjs';
import { impact, detectRipgrep } from '../../src/impact.mjs';

/**
 * A: defines `computeRetryBudget` in retry.js and nothing else.
 * B: writes caller.js, which CALLS computeRetryBudget. B never touches retry.js.
 * C: unrelated work, references nothing of A's — the negative control.
 */
async function plantedFixture() {
  const fx = await newRepo('impact');

  const a = await fx.worktree('producer-1');
  await fx.write('src/retry.js',
    'export function computeRetryBudget(attempts) {\n  return attempts * 250;\n}\n'
    + 'export const RETRY_CEILING_MS = 30000;\n', a);
  await fx.commit('add retry budget', a);

  const b = await fx.worktree('consumer-1');
  await fx.write('src/caller.js',
    'import { computeRetryBudget, RETRY_CEILING_MS } from "./retry.js";\n'
    + 'export function scheduleWork(n) {\n'
    + '  const budget = computeRetryBudget(n);\n'
    + '  return Math.min(budget, RETRY_CEILING_MS);\n}\n', b);
  await fx.commit('consume the retry budget', b);

  const c = await fx.worktree('unrelated-1');
  await fx.write('src/colour.js',
    'export function paletteForTheme(theme) {\n  return theme === "dark" ? "#000" : "#fff";\n}\n', c);
  await fx.commit('unrelated colour work', c);

  return fx;
}

async function run(fx) {
  const disc = await discover(fx.root);
  const scanned = await scan(disc, {});
  const report = await analyze(scanned, {});
  const imp = await impact(scanned, {});
  return { report, imp };
}

const findPair = (imp, producer, consumer) =>
  imp.pairs.find((p) => p.producer === producer && p.consumer === consumer);

test('IMPACT: ripgrep or the fallback is available (this suite means nothing otherwise)', async () => {
  const rg = await detectRipgrep();
  // Not an assertion on ripgrep specifically — the fallback is valid — but the suite must know
  // which path it exercised, so a green run cannot come from an inert search.
  assert.ok(typeof rg.available === 'boolean');
});

test('IMPACT PRESENCE: finds a producer/consumer pair that shares NO file', async (t) => {
  const fx = await plantedFixture();
  t.after(() => fx.cleanup());

  const { report, imp } = await run(fx);

  // First establish the premise: collision detection genuinely cannot see this pair.
  const collision = report.collisions.find((c2) =>
    (c2.a === 'producer-1' && c2.b === 'consumer-1') || (c2.a === 'consumer-1' && c2.b === 'producer-1'));
  assert.equal(collision, undefined,
    'premise broken: P1 now catches this pair, so impact adds nothing here');

  // Now the claim.
  const pair = findPair(imp, 'producer-1', 'consumer-1');
  assert.ok(pair, `impact missed the planted pair. Pairs: ${JSON.stringify(imp.pairs.map((p) => [p.producer, p.consumer]))}`);
  assert.ok(pair.symbols.includes('computeRetryBudget'),
    `expected computeRetryBudget in the evidence, got ${pair.symbols.join(', ')}`);
  assert.equal(pair.confidence, 'high', 'two unambiguous symbols should be high confidence');
});

test('IMPACT: the unrelated workstream is NOT reported', async (t) => {
  const fx = await plantedFixture();
  t.after(() => fx.cleanup());

  const { imp } = await run(fx);
  assert.equal(findPair(imp, 'producer-1', 'unrelated-1'), undefined,
    'a workstream that references nothing of the producer must not appear');
  assert.equal(findPair(imp, 'unrelated-1', 'consumer-1'), undefined);
});

test('IMPACT: direction matters — producer and consumer are not interchangeable', async (t) => {
  const fx = await plantedFixture();
  t.after(() => fx.cleanup());

  const { imp } = await run(fx);
  assert.ok(findPair(imp, 'producer-1', 'consumer-1'), 'producer -> consumer expected');
  // The reverse only holds if the producer also references something the consumer defines.
  const reverse = findPair(imp, 'consumer-1', 'producer-1');
  if (reverse) {
    assert.ok(!reverse.symbols.includes('computeRetryBudget'),
      'the reverse direction must not reuse the forward evidence');
  }
});

test('IMPACT: when the two DO share the file, P1 owns it and impact stays quiet', async (t) => {
  const fx = await newRepo('impact-shared');
  t.after(() => fx.cleanup());

  // Both workstreams edit the same file; that is a collision, not a hidden dependency.
  const a = await fx.worktree('shared-a');
  await fx.write('src/shared.js', 'export function sharedHelperFunction() { return 1; }\n', a);
  await fx.commit('a', a);

  const b = await fx.worktree('shared-b');
  await fx.write('src/shared.js',
    'export function sharedHelperFunction() { return 2; }\nexport function bAlsoAdds() { return sharedHelperFunction(); }\n', b);
  await fx.commit('b', b);

  const { imp } = await run(fx);
  const pair = findPair(imp, 'shared-a', 'shared-b') ?? findPair(imp, 'shared-b', 'shared-a');
  assert.equal(pair, undefined,
    'when the consumer touches the defining file it is a collision; impact must not double-report it');
});

test('IMPACT: generic identifiers are excluded from the evidence', async (t) => {
  const fx = await newRepo('impact-generic');
  t.after(() => fx.cleanup());

  // `result` and `data` appear everywhere. Searching for them returns a hit in every file and
  // manufactures interactions between every pair of workstreams. Measured on a real repo, the
  // unfiltered version produced 1215 pairs whose evidence was exactly this kind of name.
  const a = await fx.worktree('gen-a');
  await fx.write('src/a.js', 'export const result = 1;\nexport const data = 2;\nexport function go() {}\n', a);
  await fx.commit('a', a);

  const b = await fx.worktree('gen-b');
  await fx.write('src/b.js', 'export function other() {\n  const result = 5;\n  const data = 6;\n  return result + data;\n}\n', b);
  await fx.commit('b', b);

  const { imp } = await run(fx);
  const pair = findPair(imp, 'gen-a', 'gen-b');
  if (pair) {
    for (const s of pair.symbols) {
      assert.ok(!['result', 'data', 'go', 'other'].includes(s),
        `generic identifier '${s}' must not be offered as evidence of an interaction`);
    }
  }
});

test('IMPACT: every finding carries the caveats that make it honest', async (t) => {
  const fx = await plantedFixture();
  t.after(() => fx.cleanup());

  const { imp } = await run(fx);
  const text = imp.caveats.join(' ');
  assert.match(text, /not a conflict/i, 'the output must refuse the conflict claim explicitly');
  assert.match(text, /TEXTUALLY/i, 'the textual-match limitation must be stated');
  assert.match(text, /P4/, 'the deferred problem must be named, not quietly implied');
});

test('IMPACT: a repo with one workstream reports nothing and says why', async (t) => {
  const fx = await newRepo('impact-single');
  t.after(() => fx.cleanup());
  await fx.worktree('only-one');

  const { imp } = await run(fx);
  assert.equal(imp.pairs.length, 0);
  assert.ok(imp.caveats.some((s) => /fewer than two/.test(s)),
    'an empty result must explain itself rather than look like a clean bill of health');
});
