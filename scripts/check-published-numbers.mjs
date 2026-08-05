#!/usr/bin/env node
// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — the CI half of the published-numbers gate: do the published claims match what the
 * suite ACTUALLY reported this run?
 *
 * The step that used to do this was `grep -q "$ACTUAL_TESTS" "$f"` — true the instant the digits
 * of the real count appear ANYWHERE in the file, including inside an SVG coordinate, a hex
 * colour, a port number, or a year. A stale badge sitting three lines above a coincidentally
 * matching number in a `<path d="...">` would pass this check while publishing a lie.
 *
 * This script instead extracts every CLAIM using the same context-shaped patterns as
 * test/unit/published-numbers.test.mjs (imported from test/lib/published-number-patterns.mjs, one
 * definition, not two), and permits exactly two public states:
 *
 *   1. every surface carries the exact visible sentence that no current test count or mutation
 *      score is published, and no surface carries a current claim; or
 *   2. every surface carries one recognised claim for each figure, every claim equals the
 *      artifact-derived values supplied by CI, and no surface retains the withholding sentence.
 *
 * Usage:
 *   node scripts/check-published-numbers.mjs --tests 474 --mutation 39/39
 *   node scripts/check-published-numbers.mjs --tests 474 --mutation 39/39 --root /some/dir
 *   node scripts/check-published-numbers.mjs --tests 474 --mutation 39/39 --files a.md,b.html
 *
 * Partial withholding, a mixed claim/withholding state, stale values and pattern drift all exit 1.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  TEST_COUNT_PATTERNS,
  MUTATION_PATTERNS,
  MUTATION_HISTORICAL_EXCEPTION,
  matchesExactClaim,
} from '../test/lib/published-number-patterns.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '..');
const DEFAULT_SURFACES = ['README.md', 'BENCHMARKS.md', 'site/index.html'];
const WITHHELD_MARKER = /No current test count or mutation score is\s+published\./i;

function parseArgs(argv) {
  const o = { tests: null, mutation: null, root: DEFAULT_ROOT, files: DEFAULT_SURFACES };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tests') o.tests = argv[++i];
    else if (a === '--mutation') o.mutation = argv[++i];
    else if (a === '--root') o.root = path.resolve(argv[++i]);
    else if (a === '--files') o.files = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '-h' || a === '--help') {
      console.log('check-published-numbers — see file header for usage');
      process.exit(0);
    } else throw new Error(`unknown flag ${a}`);
  }
  return o;
}

/**
 * Run the gate over a set of already-loaded {file, text} entries against given actual values.
 * Exported so a test can prove this exact function passes on real files and fails on a scratch
 * copy with a wrong claim — without shelling out to the CLI.
 */
export function checkAll(entries, { actualTests, actualMutation }) {
  const failures = [];
  const rows = entries.map(([file, text]) => ({
    file,
    text,
    test: matchesExactClaim(text, TEST_COUNT_PATTERNS, actualTests),
    mutation: matchesExactClaim(text, MUTATION_PATTERNS, actualMutation, {
      arity: 2,
      exceptions: [MUTATION_HISTORICAL_EXCEPTION],
    }),
  }));

  function checkMetric({ key, label, measured, shapes }) {
    const hasAnyClaim = rows.some((row) => row[key].found.length > 0);
    if (!hasAnyClaim) {
      for (const row of rows) {
        if (!WITHHELD_MARKER.test(row.text)) {
          failures.push(`${row.file}: no ${label} claim found and the exact public withholding sentence is missing`);
        }
      }
      return;
    }

    for (const row of rows) {
      if (WITHHELD_MARKER.test(row.text)) {
        failures.push(`${row.file}: both publishes a ${label} and says no current figure is published`);
      }
      const result = row[key];
      if (!result.ok) {
        failures.push(
          result.found.length === 0
            ? `${row.file}: no ${label} claim found in a recognised shape (${shapes}) — partial publication or pattern drift`
            : `${row.file}: ${label} claim(s) ${JSON.stringify(result.found)} do not match the measured value ${measured}`,
        );
      }
    }
  }

  checkMetric({
    key: 'test',
    label: 'test-count',
    measured: actualTests,
    shapes: 'badge / "N tests passing" / tile / table row',
  });
  checkMetric({
    key: 'mutation',
    label: 'mutation-score',
    measured: actualMutation,
    shapes: 'badge / tile / "N/M killed"',
  });
  return failures;
}

async function main() {
  const o = parseArgs(process.argv);
  if (!o.tests || !o.mutation) {
    console.error('::error::--tests and --mutation are required and must not be empty — refusing to compare against an unmeasured number');
    process.exit(1);
  }
  const entries = [];
  for (const f of o.files) entries.push([f, await fs.readFile(path.join(o.root, f), 'utf8')]);
  const failures = checkAll(entries, { actualTests: o.tests, actualMutation: o.mutation });
  if (failures.length) {
    for (const line of failures) console.error(`::error::${line}`);
    process.exit(1);
  }
  if (entries.every(([, text]) => WITHHELD_MARKER.test(text))) {
    console.log('published-number state is synchronized: every surface explicitly withholds current figures.');
  } else {
    console.log(`published numbers match the measured inputs (${o.tests} tests, ${o.mutation} mutations)`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('::error::' + (err?.stack || err));
    process.exit(1);
  });
}
