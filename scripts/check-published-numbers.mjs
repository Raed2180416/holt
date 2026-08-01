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
 * definition, not two), and requires:
 *
 *   1. at least one claim found per surface (anti-vacuity — a reworded badge that stops matching
 *      must fail loudly, not pass because grep found nothing to contradict);
 *   2. every claim found equal to the number the suite just measured.
 *
 * Usage:
 *   node scripts/check-published-numbers.mjs --tests 474 --mutation 39/39
 *   node scripts/check-published-numbers.mjs --tests 474 --mutation 39/39 --root /some/dir
 *   node scripts/check-published-numbers.mjs --tests 474 --mutation 39/39 --files a.md,b.html
 *
 * Exits 0 and prints "published numbers match the suite" when every surface's claims equal the
 * given actuals. Exits 1 with one line per failing surface otherwise.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TEST_COUNT_PATTERNS,
  MUTATION_PATTERNS,
  MUTATION_HISTORICAL_EXCEPTION,
  matchesExactClaim,
} from '../test/lib/published-number-patterns.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '..');
const DEFAULT_SURFACES = ['README.md', 'BENCHMARKS.md', 'site/index.html'];

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
  for (const [file, text] of entries) {
    const t = matchesExactClaim(text, TEST_COUNT_PATTERNS, actualTests);
    if (!t.ok) {
      failures.push(
        t.found.length === 0
          ? `${file}: no test-count claim found in a recognised shape (badge / "N tests passing" / tile / table row) — pattern drift or the number is missing`
          : `${file}: test-count claim(s) ${JSON.stringify(t.found)} do not match the measured count ${actualTests}`,
      );
    }
    const m = matchesExactClaim(text, MUTATION_PATTERNS, actualMutation, {
      arity: 2,
      exceptions: [MUTATION_HISTORICAL_EXCEPTION],
    });
    if (!m.ok) {
      failures.push(
        m.found.length === 0
          ? `${file}: no mutation-score claim found in a recognised shape (badge / tile / "N/M killed") — pattern drift or the number is missing`
          : `${file}: mutation-score claim(s) ${JSON.stringify(m.found)} do not match the measured score ${actualMutation}`,
      );
    }
  }
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
  console.log(`published numbers match the suite (${o.tests} tests, ${o.mutation} mutations)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('::error::' + (err?.stack || err));
    process.exit(1);
  });
}
