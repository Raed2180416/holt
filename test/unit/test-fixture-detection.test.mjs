/**
 * holt — test fixture detection.
 *
 * Test files and fixtures are counted as production code in metrics, producing wrong risk
 * scores and inflated ROI. These tests cover the convention-based detection and the
 * "domination" threshold that triggers a warning.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTestFile, testFixtureProfile } from '../../src/scan.mjs';

test('test-fixture: isTestFile detects conventional test directories', () => {
  assert.equal(isTestFile('test/foo.test.mjs'), true);
  assert.equal(isTestFile('tests/foo.spec.js'), true);
  assert.equal(isTestFile('src/__tests__/widget.test.ts'), true);
  assert.equal(isTestFile('spec/models.spec.rb'), true);
  assert.equal(isTestFile('specs/helpers.spec.js'), true);
});

test('test-fixture: isTestFile detects conventional test file patterns', () => {
  assert.equal(isTestFile('src/foo.test.mjs'), true);
  assert.equal(isTestFile('src/foo.spec.js'), true);
  assert.equal(isTestFile('src/foo_test.go'), true);
  assert.equal(isTestFile('src/test_foo.py'), true);
  assert.equal(isTestFile('lib/widget_test.rs'), true);
});

test('test-fixture: isTestFile does not misclassify production source', () => {
  // A source file that happens to contain the word "test" in a non-test position is NOT a test.
  assert.equal(isTestFile('src/contest.js'), false);
  assert.equal(isTestFile('src/protest.js'), false);
  assert.equal(isTestFile('src/index.mjs'), false);
  assert.equal(isTestFile('src/latest.mjs'), false);
  assert.equal(isTestFile('README.md'), false);
  assert.equal(isTestFile('src/attestation.mjs'), false);
});

test('test-fixture: isTestFile handles empty and edge inputs', () => {
  assert.equal(isTestFile(''), false);
  assert.equal(isTestFile(null), false);
  assert.equal(isTestFile(undefined), false);
});

test('test-fixture: testFixtureProfile reports the fraction and domination flag', () => {
  // A workstream dominated by test fixtures: 4 of 5 touched files are tests.
  const dominated = testFixtureProfile([
    'test/a.test.mjs', 'test/b.test.mjs', 'test/c.test.mjs', 'test/d.test.mjs', 'src/main.mjs',
  ]);
  assert.equal(dominated.testCount, 4);
  assert.equal(dominated.totalCount, 5);
  assert.equal(dominated.dominates, true);
  assert.equal(dominated.testFraction, 0.8);
  assert.equal(dominated.testPaths.length, 4);

  // A workstream where production code is the majority: 1 of 5.
  const production = testFixtureProfile([
    'test/a.test.mjs', 'src/main.mjs', 'src/util.mjs', 'src/render.mjs', 'src/config.mjs',
  ]);
  assert.equal(production.testCount, 1);
  assert.equal(production.dominates, false);

  // Exactly half is NOT domination — the threshold is strictly more than half.
  const half = testFixtureProfile(['test/a.test.mjs', 'src/main.mjs']);
  assert.equal(half.testCount, 1);
  assert.equal(half.dominates, false);
});

test('test-fixture: testFixtureProfile handles an empty path list', () => {
  const empty = testFixtureProfile([]);
  assert.equal(empty.testCount, 0);
  assert.equal(empty.totalCount, 0);
  assert.equal(empty.dominates, false);
  assert.equal(empty.testFraction, 0);
});
