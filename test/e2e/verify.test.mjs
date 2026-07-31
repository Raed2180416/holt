/**
 * grove — differential verification, against ground truth.
 *
 * The claim: `grove verify A B` runs YOUR tests on A alone, B alone, and A+B merged, and reports
 * only what the COMBINATION breaks. The fixture manufactures a textbook semantic conflict:
 *
 *   base    LIMIT = 10 (limit.mjs), FACTOR = 2 (factor.mjs); a test asserts LIMIT * FACTOR < 100.
 *   A       LIMIT = 30   (alone: 30*2  = 60  < 100 — green)
 *   B       FACTOR = 5   (alone: 10*5  = 50  < 100 — green)
 *   A+B     30*5 = 150 — red. Textually CLEAN (different files), both sides green, combination
 *           fails. Exactly the class of defect P4 is about, constructed so the answer is known.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newRepo } from '../fixtures.mjs';
import { verifyPair, extractFailures } from '../../src/verify.mjs';

/** base with a real test, plus two worktrees whose changes conflict only in combination. */
async function semanticFixture() {
  const fx = await newRepo('verify');

  // LIMIT and FACTOR live in SEPARATE FILES on purpose. The first cut put them on adjacent
  // lines of one two-line file, and git's textual merge reported a conflict — at which point
  // verify correctly short-circuits to "resolve the textual conflict first" and the semantic
  // machinery never runs. A true semantic conflict is textually CLEAN: the merge succeeds, both
  // sides are green alone, and only the combination is red. Different files guarantee the clean
  // merge; the shared invariant (LIMIT * FACTOR < 100) supplies the interaction.
  await fx.write('limit.mjs', 'export const LIMIT = 10;\n');
  await fx.write('factor.mjs', 'export const FACTOR = 2;\n');
  await fx.write('consumer.mjs',
    'import { LIMIT } from "./limit.mjs";\nimport { FACTOR } from "./factor.mjs";\n'
    + 'export const budget = () => LIMIT * FACTOR;\n');
  await fx.write('test.mjs',
    'import { budget } from "./consumer.mjs";\n'
    + 'const b = budget();\n'
    + 'if (b >= 100) { console.error(`FAIL budget_exceeds_cap b=${b}`); process.exit(1); }\n'
    + 'console.log("ok budget_within_cap");\n');
  await fx.commit('base with a real invariant test');

  const a = await fx.worktree('raise-limit');
  await fx.write('limit.mjs', 'export const LIMIT = 30;\n', a);
  await fx.commit('raise LIMIT to 30', a);

  const b = await fx.worktree('raise-factor');
  await fx.write('factor.mjs', 'export const FACTOR = 5;\n', b);
  await fx.commit('raise FACTOR to 5', b);

  // A compatible third workstream, for the negative control.
  const c = await fx.worktree('rename-nothing');
  await fx.write('docs.md', '# unrelated documentation change\n', c);
  await fx.commit('docs only', c);

  return fx;
}

const RUN = 'node test.mjs';

test('VERIFY: the manufactured interaction is REAL (premise check)', async (t) => {
  // Prove the fixture does what the header claims before trusting any verdict built on it:
  // each side green alone, the combination red. If this premise breaks, every other assertion
  // in this file is testing noise.
  const fx = await semanticFixture();
  t.after(() => fx.cleanup());

  const r = await verifyPair(fx.root, 'raise-limit', 'raise-factor', { run: RUN, timeout: 60_000 });
  assert.equal(r.ok, true, `verify failed to run: ${r.error}`);
  assert.equal(r.runs.a.passed, true, 'A alone must pass (30*2=60 < 100)');
  assert.equal(r.runs.b.passed, true, 'B alone must pass (10*5=50 < 100)');
  assert.equal(r.runs.ab.passed, false, 'A+B must fail (30*5=150 >= 100)');
});

test('VERIFY: reports the interaction, attributed to the COMBINATION', async (t) => {
  const fx = await semanticFixture();
  t.after(() => fx.cleanup());

  const r = await verifyPair(fx.root, 'raise-limit', 'raise-factor', { run: RUN, timeout: 60_000 });
  assert.equal(r.ok, true);
  assert.ok(r.interactionFailures.length >= 1,
    `the combination-only failure must be reported: ${JSON.stringify(r.runs)}`);
  assert.match(r.verdict, /INTERACTION BREAKS/);
});

test('VERIFY: a compatible pair reports NOT-CAUGHT, never "compatible"', async (t) => {
  const fx = await semanticFixture();
  t.after(() => fx.cleanup());

  const r = await verifyPair(fx.root, 'raise-limit', 'rename-nothing', { run: RUN, timeout: 60_000 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.interactionFailures.length, 0);
  // The honest wording is load-bearing: recall is bounded by the suite, so a clean run is
  // "the existing tests did not catch anything", NOT a compatibility certificate.
  assert.match(r.verdict, /did not catch/i);
  assert.doesNotMatch(r.verdict, /\bcompatible\b/i);
});

test('VERIFY: refuses to run without an explicit test command', async (t) => {
  const fx = await semanticFixture();
  t.after(() => fx.cleanup());

  // No --run, no groveTest in package.json: grove must refuse rather than guess. Running an
  // inferred command in someone's repository is the failure, not the fallback.
  const r = await verifyPair(fx.root, 'raise-limit', 'raise-factor', {});
  assert.equal(r.ok, false);
  assert.match(r.error, /no test command/i);
});

test('VERIFY: a textual conflict short-circuits — nothing is executed', async (t) => {
  const fx = await newRepo('verify-textual');
  t.after(() => fx.cleanup());

  await fx.write('same.mjs', 'export const V = 1;\n');
  await fx.commit('base');
  const a = await fx.worktree('edit-a');
  await fx.write('same.mjs', 'export const V = 2;\n', a);
  await fx.commit('a', a);
  const b = await fx.worktree('edit-b');
  await fx.write('same.mjs', 'export const V = 3;\n', b);
  await fx.commit('b', b);

  const r = await verifyPair(fx.root, 'edit-a', 'edit-b', { run: 'node -e "process.exit(0)"' });
  assert.equal(r.ok, true);
  assert.equal(r.textualConflict, true, 'a textual conflict is P1\'s answer; there is nothing to run yet');
});

test('VERIFY: leaves the repository and its worktrees untouched', async (t) => {
  const fx = await semanticFixture();
  t.after(() => fx.cleanup());

  const fsp = await import('node:fs/promises');
  const before = await fsp.readFile(`${fx.root}/limit.mjs`, "utf8");
  const beforeWt = await fsp.readFile(`${fx.wt('raise-limit')}/limit.mjs`, "utf8");

  await verifyPair(fx.root, 'raise-limit', 'raise-factor', { run: RUN, timeout: 60_000 });

  assert.equal(await fsp.readFile(`${fx.root}/limit.mjs`, "utf8"), before,
    'verify must not touch the primary worktree');
  assert.equal(await fsp.readFile(`${fx.wt('raise-limit')}/limit.mjs`, "utf8"), beforeWt,
    'verify must not touch the workstreams it verifies');

  // And no scratch worktrees may be left registered.
  const { execFile } = await import('node:child_process');
  const list = await new Promise((res) => execFile('git', ['worktree', 'list'], { cwd: fx.root },
    (e, so) => res(String(so ?? ''))));
  assert.ok(!list.includes('grove-verify'), `scratch worktrees leaked:\n${list}`);
});

test('extractFailures: parses the frameworks it claims to', () => {
  assert.deepEqual(
    extractFailures('✖ my failing test (2ms)\nok other'),
    ['my failing test (2ms)'],
  );
  assert.deepEqual(extractFailures('FAILED tests/test_api.py::test_rate_limit'),
    ['tests/test_api.py::test_rate_limit']);
  assert.deepEqual(extractFailures('--- FAIL: TestBudget (0.01s)'), ['TestBudget']);
  assert.deepEqual(extractFailures('all green here'), []);
});
