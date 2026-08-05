/**
 * THE NUMBERS ON THE MARKETING SURFACES, CHECKED AGAINST A MEASUREMENT THAT ACTUALLY RAN.
 *
 * `test/unit/published-numbers.test.mjs` used to hold `MEASURED_TEST_COUNT = '1055'` under a
 * comment saying "measured independently on 2026-08-03". Nothing measured it. A human typed it,
 * and it was already wrong — the suite defined 1057 — so the gate would have gone GREEN while the
 * README published a false number. That is this project's signature defect (a conclusion asserted
 * without a measurement behind it) sitting inside the gate built to prevent it.
 *
 * A unit test cannot honestly produce these numbers: it cannot count the suite it is running
 * inside, and it must not spend two hours running the mutation harness. So the measurement lives
 * here, as the CI job the rules require for anything a test cannot prove on its own, and the unit
 * test keeps only the checks it can make cheaply and truthfully (cross-surface agreement, no
 * survivors in a headline, no install command that does not work yet).
 *
 *   node scripts/verify-published-numbers.mjs              # measure each published figure, compare
 *   node scripts/verify-published-numbers.mjs --tests-only # verify only a published test count
 *   node scripts/verify-published-numbers.mjs --write      # update the surfaces to what was measured
 *
 * If all surfaces explicitly say that no current figure is published, the checker validates that
 * synchronized state and runs neither expensive harness. --write updates existing claims only;
 * it never invents a headline or edits a number it did not just measure in this process.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  TEST_COUNT_PATTERNS,
  MUTATION_PATTERNS,
  MUTATION_HISTORICAL_EXCEPTION,
  claims,
} from '../test/lib/published-number-patterns.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SURFACES = ['README.md', 'BENCHMARKS.md', 'site/index.html'];
const argv = new Set(process.argv.slice(2));
const TESTS_ONLY = argv.has('--tests-only');
const WRITE = argv.has('--write');
const WITHHELD_MARKER = /No current test count or mutation score is\s+published\./i;

/** Run a command to completion and hand back its REAL exit code — never a pipe's. */
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { cwd: ROOT, maxBuffer: 1 << 30, ...opts },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout: stdout ?? '', stderr: stderr ?? '' }));
    child.on('error', () => resolve({ code: -1, stdout: '', stderr: 'spawn failed' }));
  });
}

/**
 * The count the RUNNER reports, not a count of `test(` occurrences in the source. Those two drift
 * the moment a test is generated in a loop or skipped by a guard, and the published claim is about
 * what executes.
 */
async function measureTests() {
  // THE EXACT COMMAND package.json RUNS. `node --test test/` matched ONE file here and reported
  // a count of 1 — a checker that measures something other than what CI measures is worse than
  // no checker, because it reports with authority.
  const r = await run(process.execPath, ['--test', 'test/**/*.test.mjs']);
  const output = `${r.stdout}\n${r.stderr}`;
  // Node's default TAP reporter writes "# pass N"; the spec reporter writes "ℹ pass N".
  // Parse both exact summary shapes so a reporter choice cannot turn a real run into an empty
  // measurement (or, worse, make a grep for an empty string pass vacuously).
  const pass = /^(?:#|ℹ)\s*pass\s+(\d+)\s*$/m.exec(output);
  const fail = /^(?:#|ℹ)\s*fail\s+(\d+)\s*$/m.exec(output);
  const total = /^(?:#|ℹ)\s*tests\s+(\d+)\s*$/m.exec(output);
  if (!pass || !fail || !total) {
    return { ok: false, why: 'could not parse the test runner summary — output format changed' };
  }
  if (Number(fail[1]) !== 0) {
    return { ok: false, why: `the suite is RED (${fail[1]} failing) — a red suite has no publishable count` };
  }
  return { ok: true, count: Number(pass[1]), defined: Number(total[1]) };
}

/**
 * The mutation score the harness prints. A survivor is a hole, and a hole is not a headline.
 *
 * READ THE HARNESS'S OWN SUMMARY LINE, DO NOT COUNT WORDS. This function used to count occurrences
 * of /\bkilled\b/, and the harness's final line is itself "78/78 mutations killed (100%)" — which
 * contains the word. So it reported 80 for a set of 79 and WROTE THAT NUMBER TO ALL THREE PUBLIC
 * SURFACES: this checker committed, in its first real run, precisely the defect it exists to
 * prevent. The summary line is authoritative; the per-mutation lines are cross-checked against it
 * so a run that dies half way cannot be published as a complete one.
 */
async function measureMutations() {
  const r = await run(process.execPath, ['test/mutation.mjs']);
  const text = `${r.stdout}\n${r.stderr}`;
  const summary = /(\d+)\/(\d+) mutations killed/.exec(text);
  if (!summary) {
    return { ok: false, why: 'the mutation harness printed no "N/M mutations killed" summary — it '
      + 'crashed, was killed, or its output format changed. No score may be published from this.' };
  }
  const killed = Number(summary[1]);
  const total = Number(summary[2]);
  const survived = total - killed;

  // A run that ended early still prints a summary for what it did reach. Count the per-mutation
  // verdict lines and require them to account for the whole set.
  const declared = /deliberate defects/.exec(text) ? Number(/— (\d+) deliberate defects/.exec(text)?.[1] ?? total) : total;
  const verdicts = (text.match(/^\s+\S+\s+(killed|SURVIVED)\b/gm) ?? []).length;
  if (verdicts !== declared || total !== declared) {
    return { ok: false, why: `the harness declared ${declared} defects, printed ${verdicts} verdict `
      + `line(s) and summarised ${total} — an incomplete run must not be published` };
  }
  return { ok: true, killed, survived, total, score: `${killed}/${total}` };
}

const problems = [];
const measured = {};

const initialSurfaces = new Map();
for (const rel of SURFACES) {
  const text = await fs.readFile(path.join(ROOT, rel), 'utf8').catch(() => null);
  initialSurfaces.set(rel, text);
  if (text === null) problems.push(`${rel}: unreadable`);
}

function publicationState(patterns, arity = 1, exceptions = []) {
  const byFile = new Map();
  for (const [rel, text] of initialSurfaces) {
    const found = text === null
      ? []
      : [...new Set(claims(text, patterns, arity))].filter((c) => !exceptions.includes(c));
    byFile.set(rel, found);
  }
  return { byFile, published: [...byFile.values()].some((found) => found.length > 0) };
}

function validatePublicationState(label, state) {
  if (!state.published) {
    for (const [rel, text] of initialSurfaces) {
      if (text !== null && !WITHHELD_MARKER.test(text)) {
        problems.push(`${rel}: publishes no ${label}, but does not explicitly say that current public figures are withheld`);
      }
    }
    return;
  }

  // A published figure is all-or-nothing across the public surfaces. Missing claims are pattern
  // drift or partial publication; retaining the withholding sentence is a direct contradiction.
  for (const [rel, found] of state.byFile) {
    if (!found.length) problems.push(`${rel}: publishes no ${label} this checker can see — mixed or pattern-drifted state`);
    const text = initialSurfaces.get(rel);
    if (text !== null && WITHHELD_MARKER.test(text)) {
      problems.push(`${rel}: both publishes a ${label} and says no current figure is published`);
    }
  }
}

const testState = publicationState(TEST_COUNT_PATTERNS);
const mutationState = publicationState(
  MUTATION_PATTERNS,
  2,
  [MUTATION_HISTORICAL_EXCEPTION],
);
validatePublicationState('test count', testState);
validatePublicationState('mutation score', mutationState);

// Withholding both figures is an intentional public state, not a vacuous pass. The exact visible
// sentence above is checked on every surface, and no expensive measurement is needed until a
// surface actually publishes a current claim.
if (!testState.published && !mutationState.published) {
  if (problems.length) {
    console.error(`\npublished numbers: FAILED\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exit(1);
  }
  console.log('published numbers: all surfaces explicitly withhold current test and mutation figures.');
  if (WRITE) console.log('--write made no change; it does not invent a public claim.');
  process.exit(0);
}

// Structural contradictions should fail before spending time on either harness.
if (problems.length) {
  console.error(`\npublished numbers: FAILED\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}

if (testState.published) {
  const t = await measureTests();
  if (!t.ok) problems.push(`TEST COUNT: ${t.why}`);
  else {
    measured.testCount = String(t.count);
    console.log(`measured test count      ${t.count} passing of ${t.defined} defined`);
  }
} else console.log('test count               WITHHELD on every surface — measurement skipped');

if (!TESTS_ONLY && mutationState.published) {
  const m = await measureMutations();
  if (!m.ok) problems.push(`MUTATION SCORE: ${m.why}`);
  else {
    measured.mutationScore = m.score;
    console.log(`measured mutation score  ${m.score}${m.survived ? `  (${m.survived} SURVIVED)` : ''}`);
    if (m.survived > 0) {
      problems.push(`MUTATION SCORE: ${m.survived} mutation(s) survived. A score with survivors names a `
        + 'hole in the suite and must not be published as a headline — fix the hole, do not print the number.');
    }
  }
} else if (TESTS_ONLY && mutationState.published) {
  console.log('mutation score           UNCHECKED (--tests-only) — run without the flag before publishing');
} else console.log('mutation score           WITHHELD on every surface — measurement skipped');

/** Every place a surface disagrees with what was just measured. */
async function compareSurfaces() {
  const out = [];
  for (const rel of SURFACES) {
    const text = await fs.readFile(path.join(ROOT, rel), 'utf8').catch(() => null);
    if (text === null) { out.push(`${rel}: unreadable`); continue; }
    if (measured.testCount) {
      const found = [...new Set(claims(text, TEST_COUNT_PATTERNS, 1))];
      if (!found.length) out.push(`${rel}: publishes no test count this checker can see — pattern drift`);
      else if (found.some((c) => c !== measured.testCount)) {
        out.push(`${rel}: publishes test count ${JSON.stringify(found)}, measured ${measured.testCount}`);
      }
    }
    if (measured.mutationScore) {
      // The permanent falsification record is a WORSE past score, deliberately kept.
      const found = [...new Set(claims(text, MUTATION_PATTERNS, 2))]
        .filter((c) => c !== MUTATION_HISTORICAL_EXCEPTION);
      if (!found.length) out.push(`${rel}: publishes no mutation score this checker can see — pattern drift`);
      else if (found.some((c) => c !== measured.mutationScore)) {
        out.push(`${rel}: publishes mutation score ${JSON.stringify(found)}, measured ${measured.mutationScore}`);
      }
    }
  }
  return out;
}

problems.push(...await compareSurfaces());

if (WRITE && !problems.some((p) => p.startsWith('MUTATION SCORE') || p.startsWith('TEST COUNT'))) {
  for (const rel of SURFACES) {
    const file = path.join(ROOT, rel);
    let text = await fs.readFile(file, 'utf8');
    const before = text;
    if (measured.testCount) {
      for (const re of TEST_COUNT_PATTERNS) {
        text = text.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`),
          (m, ...g) => m.replace(String(g[0]), measured.testCount));
      }
    }
    if (measured.mutationScore) {
      for (const re of MUTATION_PATTERNS) {
        text = text.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`),
          (m, ...g) => (`${g[0]}/${g[1]}` === MUTATION_HISTORICAL_EXCEPTION
            ? m
            : m.replace(`${g[0]}/${g[1]}`, measured.mutationScore)));
      }
    }
    if (text !== before) { await fs.writeFile(file, text, 'utf8'); console.log(`updated ${rel}`); }
  }

  // RE-READ AND RE-COMPARE. A REWRITE THAT ONLY PARTLY LANDS IS WORSE THAN NONE.
  //
  // This is not belt-and-braces, it is a defect this script already committed: the first real
  // --write replaced the plain-text claims and MISSED the URL-encoded badge
  // (`mutation%20score-54%2F54%20killed`), leaving README publishing 54/54 and 79/79 at once — and
  // then printed "surfaces rewritten" and exited 0. A half-written surface is a surface that
  // contradicts itself, which is strictly worse than the stale-but-consistent state it replaced.
  // So success is now something the script PROVES by re-reading, never something it assumes from
  // having called writeFile.
  const residual = await compareSurfaces();
  if (residual.length) {
    console.error(`\nPARTIAL WRITE — ${residual.length} claim(s) did NOT update and must be fixed by hand:`);
    for (const r of residual) console.error(`  - ${r}`);
    console.error('\nThe surfaces are now INCONSISTENT. Fix these before publishing anything.');
    process.exit(1);
  }
  console.log('\nsurfaces rewritten AND re-verified against the measurement.');
  process.exit(0);
}

if (problems.length) {
  console.error(`\npublished numbers: FAILED\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  console.error('\nFix the SURFACES to match the measurement, or fix the product. Never edit the '
    + 'measurement to match the surfaces.');
  process.exit(1);
}
if (TESTS_ONLY && mutationState.published) {
  console.log('\npublished numbers: the test count matches this run; the published mutation score remains unchecked.');
} else {
  console.log('\npublished numbers: every published figure matches a measurement that actually ran.');
}
