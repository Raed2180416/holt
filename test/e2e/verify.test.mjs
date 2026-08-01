/**
 * holt — differential verification, against ground truth.
 *
 * The claim: `holt verify A B` runs YOUR tests on A alone, B alone, and A+B merged, and reports
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

/**
 * base with a real test, plus two worktrees whose changes conflict only in combination.
 *
 * `failureLine` is the JS expression the runner prints when the invariant breaks. It is a
 * parameter because HOW A RUNNER WORDS A FAILURE IS NOT holt's BUSINESS: the same ground truth —
 * A green, B green, A+B red — has to produce the same verdict whether or not the wording happens
 * to match one of holt's regexes. Two callers below use the two wordings against one fixture.
 */
async function semanticFixture(failureLine = '`FAIL budget_exceeds_cap b=${b}`') {
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
    + `if (b >= 100) { console.error(${failureLine}); process.exit(1); }\n`
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

  // No --run, no holtTest in package.json: holt must refuse rather than guess. Running an
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
  assert.ok(!list.includes('holt-verify'), `scratch worktrees leaked:\n${list}`);
});

test('extractFailures: parses the frameworks it claims to', () => {
  // The duration used to be part of the identity — this assertion used to demand it, which
  // PINNED THE DEFECT: `node --test` stamps a fresh duration on every run, so the same test
  // carried a different identity in each of the three arms and every already-red suite reported
  // a false interaction. An identity must be a function of the test, not of the run.
  assert.deepEqual(
    extractFailures('✖ my failing test (2ms)\nok other'),
    ['my failing test'],
  );
  assert.deepEqual(extractFailures('FAILED tests/test_api.py::test_rate_limit'),
    ['tests/test_api.py::test_rate_limit']);
  assert.deepEqual(extractFailures('--- FAIL: TestBudget (0.01s)'), ['TestBudget']);
  assert.deepEqual(extractFailures('all green here'), []);
});

// =================================================================================================
// THE VERDICT COMES FROM THE RUN RESULTS, NOT FROM WHAT holt COULD PARSE
// =================================================================================================

test('VERIFY: an UNPARSEABLE failure wording still yields INTERACTION BREAKS', async (t) => {
  // Same ground truth as the fixture header: A green, B green, A+B red. The only difference is
  // that the runner words its failure in its own house style, matching none of holt's regexes.
  //
  // The verdict used to be derived from the parsed names, so no match meant an empty set meant
  // "nothing to report" — holt answered that neither side was even runnable and exited 0 on a
  // combination it had just watched break. A false crown on the one command whose whole job is
  // deciding this, firing on every runner whose output shape this module has not seen.
  const fx = await semanticFixture('`budget exceeded the cap: ${b}`');
  t.after(() => fx.cleanup());

  const r = await verifyPair(fx.root, 'raise-limit', 'raise-factor', { run: RUN, timeout: 60_000 });
  assert.equal(r.ok, true, r.error);

  // Premise first: the run booleans really are the reported shape.
  assert.equal(r.runs.a.passed, true);
  assert.equal(r.runs.b.passed, true);
  assert.equal(r.runs.ab.passed, false);
  // And holt genuinely could not parse a name — otherwise this test proves nothing about the
  // case it was written for.
  assert.deepEqual(r.interactionFailures, [],
    'premise: this wording must be unparseable, or this is not the case under test');

  assert.equal(r.interactionBreaks, true);
  assert.equal(r.evidence, 'exit-status');
  assert.match(r.verdict, /INTERACTION BREAKS/);
});

test('CLI: an unparseable interaction failure exits 1 (deny), never 0', async (t) => {
  // The exit code is the contract a script or a hook chains on, and it had the same defect:
  // it keyed off the parsed-name count, so this case exited 0 = allow.
  const fx = await semanticFixture('`budget exceeded the cap: ${b}`');
  t.after(() => fx.cleanup());

  const BIN = new URL('../../bin/holt.mjs', import.meta.url).pathname;
  const { execFile } = await import('node:child_process');
  const code = await new Promise((res) => execFile(
    process.execPath, [BIN, 'verify', 'raise-limit', 'raise-factor', '--run', RUN, '--cwd', fx.root],
    { timeout: 180_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1' } },
    (e) => res(e ? (e.code ?? 1) : 0)));

  assert.equal(code, 1, 'a broken combination must DENY (1), not allow (0)');
});

test('VERIFY: an already-red suite is NOT reported as an interaction', async (t) => {
  // `node --test` stamps a per-run duration on every failure line: "✖ name (0.49ms)". That made
  // the same failing test a different identity in all three arms, so its failure looked
  // combination-only and every repository with a pre-existing red test got a false
  // "INTERACTION BREAKS". This is both the pin for that and the never-worse control for the
  // verdict change: holt must still refuse to draw an interaction conclusion here.
  const fx = await newRepo('verify-already-red');
  t.after(() => fx.cleanup());

  await fx.write('t.test.mjs',
    'import { test } from "node:test";\n'
    + 'test("already broken", () => { throw new Error("red before anybody branched"); });\n');
  await fx.commit('base ships a red test');

  const a = await fx.worktree('adds-x');
  await fx.write('x.mjs', 'export const x = 1;\n', a);
  await fx.commit('A adds an unrelated file', a);

  const b = await fx.worktree('adds-y');
  await fx.write('y.mjs', 'export const y = 1;\n', b);
  await fx.commit('B adds a different unrelated file', b);

  const r = await verifyPair(fx.root, 'adds-x', 'adds-y',
    { run: 'node --test t.test.mjs', timeout: 60_000 });
  assert.equal(r.ok, true, r.error);

  // Premise: all three arms are red, and the runner really did emit a timed failure line.
  // This assertion is ALSO the pin for the environment leak: holt's own suite is a node:test
  // process, so without scrubbing NODE_TEST_CONTEXT the nested `node --test` reports upward over
  // a private channel and EXITS 0 WITH A FAILING TEST — every arm would read green here.
  assert.equal(r.runs.a.passed, false);
  assert.equal(r.runs.ab.passed, false);
  assert.ok(r.runs.ab.failures.length >= 1, 'premise: the runner must emit a parseable failure');

  assert.deepEqual(r.interactionFailures, [],
    'the same test failing in all three arms is not a combination-only failure');
  assert.equal(r.interactionBreaks, false);
  assert.match(r.verdict, /at least one side fails on its own/);
});

test('VERIFY: a combination-only failure is still found when both sides are ALREADY red', async (t) => {
  // Exit status cannot decide this case — every arm exits non-zero — so the parsed names remain
  // the fallback rung, and tightening the verdict must not have cost that detection. It did not,
  // and in fact this case never worked: the parser dropped every second consecutive failure line,
  // so the second of the two FAIL lines below was invisible and the combination-only failure with
  // it. Both halves are needed for this to go green.
  const fx = await newRepo('verify-red-plus');
  t.after(() => fx.cleanup());

  await fx.write('limit.mjs', 'export const LIMIT = 10;\n');
  await fx.write('factor.mjs', 'export const FACTOR = 2;\n');
  await fx.write('test.mjs',
    'import { LIMIT } from "./limit.mjs";\nimport { FACTOR } from "./factor.mjs";\n'
    + 'const failures = ["preexisting_red"];\n'
    + 'if (LIMIT * FACTOR >= 100) failures.push("budget_exceeds_cap");\n'
    + 'for (const f of failures) console.error(`FAIL ${f}`);\n'
    + 'process.exit(failures.length ? 1 : 0);\n');
  await fx.commit('base is already red, and also carries the invariant');

  const a = await fx.worktree('raise-limit');
  await fx.write('limit.mjs', 'export const LIMIT = 30;\n', a);
  await fx.commit('raise LIMIT', a);

  const b = await fx.worktree('raise-factor');
  await fx.write('factor.mjs', 'export const FACTOR = 5;\n', b);
  await fx.commit('raise FACTOR', b);

  const r = await verifyPair(fx.root, 'raise-limit', 'raise-factor', { run: RUN, timeout: 60_000 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.runs.a.passed, false, 'premise: A is already red on its own');
  assert.equal(r.runs.b.passed, false, 'premise: B is already red on its own');

  assert.deepEqual(r.interactionFailures, ['budget_exceeds_cap']);
  assert.equal(r.interactionBreaks, true);
  assert.equal(r.evidence, 'failure-names', 'exit status cannot decide here, and holt must say so');
  assert.match(r.verdict, /INTERACTION BREAKS/);
});

// =================================================================================================
// ONE BASE FOR ALL THREE ARMS
// =================================================================================================

test('VERIFY: a base commit made AFTER the pair branched is not an interaction', async (t) => {
  // A and B touch different files and cannot interact. But the base moved on after they branched,
  // and the arms used to be built against two different bases: A and B were merged onto the
  // CURRENT base and so contained the new commit, while A+B was merge-tree(a.head, b.head) whose
  // merge base is the pair's own branch point and so did not. The arms then differed by the
  // BASE'S history rather than by the changes under test, and holt attributed that difference to
  // A and B — a false INTERACTION BREAKS on a pair with nothing between them.
  const fx = await newRepo('verify-base-skew');
  t.after(() => fx.cleanup());

  await fx.write('needed.mjs', 'export const needed = () => 0;\n');
  await fx.write('test.mjs',
    'import { needed } from "./needed.mjs";\n'
    + 'if (needed() < 1) { console.error("FAIL broken_invariant"); process.exit(1); }\n'
    + 'console.log("ok");\n');
  await fx.commit('base, with a known-red invariant');

  const a = await fx.worktree('touch-x');
  await fx.write('x.mjs', 'export const x = 1;\n', a);
  await fx.commit('A adds an unrelated file', a);

  const b = await fx.worktree('touch-y');
  await fx.write('y.mjs', 'export const y = 1;\n', b);
  await fx.commit('B adds a different unrelated file', b);

  // The base fixes its own invariant AFTER both branched — the everyday case, not a corner one.
  await fx.write('needed.mjs', 'export const needed = () => 1;\n');
  await fx.commit('base fixes the invariant');

  const r = await verifyPair(fx.root, 'touch-x', 'touch-y', { run: RUN, timeout: 60_000 });
  assert.equal(r.ok, true, r.error);

  // Every arm must contain the base's fix, so every arm is green.
  assert.equal(r.runs.a.passed, true);
  assert.equal(r.runs.b.passed, true);
  assert.equal(r.runs.ab.passed, true,
    'A+B must be built from the same base as A and B, or the base itself shows up as a conflict');
  assert.equal(r.interactionBreaks, false);
  assert.match(r.verdict, /did not catch/i);
});

test('VERIFY: a side that conflicts with the BASE is refused, not run as an interaction', async (t) => {
  // The single-side merges could come back conflicted and the code only checked for code > 1, so
  // a tree full of conflict markers was executed and its failures attributed to the pair.
  const fx = await newRepo('verify-base-conflict');
  t.after(() => fx.cleanup());

  await fx.write('shared.mjs', 'export const V = 1;\n');
  await fx.commit('base');

  const a = await fx.worktree('side-a');
  await fx.write('shared.mjs', 'export const V = 2;\n', a);
  await fx.commit('A edits the shared line', a);

  const b = await fx.worktree('side-b');
  await fx.write('unrelated.mjs', 'export const U = 1;\n', b);
  await fx.commit('B is unrelated', b);

  // The base edits the same line differently, after A branched.
  await fx.write('shared.mjs', 'export const V = 3;\n');
  await fx.commit('base edits the same line');

  const r = await verifyPair(fx.root, 'side-a', 'side-b', { run: RUN, timeout: 60_000 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.textualConflict, true);
  assert.equal(r.conflictsWith, 'base');
  assert.equal(r.runs, undefined, 'nothing may be executed against a conflicted tree');
  assert.match(r.verdict, /side-a conflicts TEXTUALLY with the base/);
});

// =================================================================================================
// FAILURE IDENTITY IS A FUNCTION OF THE TEST, NOT OF THE RUN
// =================================================================================================

test('extractFailures: identity is stable across runs, and still distinguishes tests', () => {
  const runOne = extractFailures('✖ budget stays under cap (12.345678ms)');
  const runTwo = extractFailures('✖ budget stays under cap (9.870123ms)');
  assert.deepEqual(runOne, runTwo, 'the same test must carry the same identity in every run');

  // Every duration shape a runner might append, and the TAP metadata form.
  for (const line of ['✖ t (5 ms)', '✖ t (0.01s)', '✖ t [1.5 sec]', '✖ t 250ms', '✖ t # time=3ms']) {
    assert.deepEqual(extractFailures(line), ['t'], `not normalised: ${line}`);
  }

  // The run's scratch directory is different in all three arms by construction.
  const wd = '/scratch/holt-verify-ab-9f2/wt';
  assert.deepEqual(extractFailures(`1) ${wd}/spec/api.js should retry`, { workdir: wd }),
    ['<workdir>/spec/api.js should retry']);

  // CONSECUTIVE failures: the patterns used to swallow the newline that ended each match, so the
  // next line had none in front of it and every second failure was silently dropped. A set that
  // is missing half the failures is wrong in both directions of the differential.
  assert.deepEqual(extractFailures('FAIL one\nFAIL two\nFAIL three'), ['one', 'two', 'three']);
  assert.deepEqual(extractFailures('✖ a (1ms)\n✖ b (2ms)\n✖ c (3ms)'), ['a', 'b', 'c']);
  assert.deepEqual(extractFailures('FAILED t/a.py::x\nFAILED t/b.py::y'), ['t/a.py::x', 't/b.py::y']);
  // CRLF output must parse the same as LF.
  assert.deepEqual(extractFailures('FAIL one\r\nFAIL two\r\n'), ['one', 'two']);

  // NEVER-WORSE: normalisation must not gut a legitimate name or collapse distinct tests.
  assert.deepEqual(extractFailures('✖ handles 2 items'), ['handles 2 items']);
  assert.deepEqual(extractFailures('✖ TestTimeout5s'), ['TestTimeout5s']);
  assert.deepEqual(extractFailures('✖ parses v2 headers (3ms)'), ['parses v2 headers']);
  assert.deepEqual(
    extractFailures('✖ alpha (1ms)\n✖ beta (1ms)').sort(),
    ['alpha', 'beta'],
    'distinct tests must keep distinct identities',
  );
});
