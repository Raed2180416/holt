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
 *   node scripts/verify-published-numbers.mjs              # measure both, compare, exit 1 on drift
 *   node scripts/verify-published-numbers.mjs --tests-only # skip the ~2h mutation harness
 *   node scripts/verify-published-numbers.mjs --write      # update the surfaces to what was measured
 *
 * --write EDITS THE SURFACES; it never edits a number it did not just measure in this process.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SURFACES = ['README.md', 'BENCHMARKS.md', 'site/index.html'];
const argv = new Set(process.argv.slice(2));
const TESTS_ONLY = argv.has('--tests-only');
const WRITE = argv.has('--write');

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
  const pass = /^ℹ pass (\d+)$/m.exec(r.stdout);
  const fail = /^ℹ fail (\d+)$/m.exec(r.stdout);
  const total = /^ℹ tests (\d+)$/m.exec(r.stdout);
  if (!pass || !fail || !total) {
    return { ok: false, why: 'could not parse the test runner summary — output format changed' };
  }
  if (Number(fail[1]) !== 0) {
    return { ok: false, why: `the suite is RED (${fail[1]} failing) — a red suite has no publishable count` };
  }
  return { ok: true, count: Number(pass[1]), defined: Number(total[1]) };
}

/** The mutation score the harness prints. A survivor is a hole, and a hole is not a headline. */
async function measureMutations() {
  const r = await run(process.execPath, ['test/mutation.mjs']);
  const text = `${r.stdout}\n${r.stderr}`;
  const killed = (text.match(/\bkilled\b/g) ?? []).length;
  const survived = (text.match(/\bSURVIVED\b/gi) ?? []).length;
  if (killed + survived === 0) return { ok: false, why: 'the mutation harness reported no results' };
  return { ok: true, killed, survived, total: killed + survived, score: `${killed}/${killed + survived}` };
}

const problems = [];
const measured = {};

const t = await measureTests();
if (!t.ok) problems.push(`TEST COUNT: ${t.why}`);
else {
  measured.testCount = String(t.count);
  console.log(`measured test count      ${t.count} passing of ${t.defined} defined`);
}

if (!TESTS_ONLY) {
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
} else console.log('mutation score           SKIPPED (--tests-only) — not eligible to publish');

// Compare against what the surfaces actually say.
const { TEST_COUNT_PATTERNS, MUTATION_PATTERNS, claims } = await import(
  path.join(ROOT, 'test/lib/published-number-patterns.mjs'));

for (const rel of SURFACES) {
  const text = await fs.readFile(path.join(ROOT, rel), 'utf8').catch(() => null);
  if (text === null) { problems.push(`${rel}: unreadable`); continue; }

  if (measured.testCount) {
    const found = [...new Set(claims(text, TEST_COUNT_PATTERNS, 1))];
    if (!found.length) problems.push(`${rel}: publishes no test count this checker can see — pattern drift`);
    else if (found.some((c) => c !== measured.testCount)) {
      problems.push(`${rel}: publishes test count ${JSON.stringify(found)}, measured ${measured.testCount}`);
    }
  }
  if (measured.mutationScore) {
    // '10/12' is the permanent falsification record — a WORSE past score, deliberately kept.
    const found = [...new Set(claims(text, MUTATION_PATTERNS, 2))].filter((c) => c !== '10/12');
    if (!found.length) problems.push(`${rel}: publishes no mutation score this checker can see — pattern drift`);
    else if (found.some((c) => c !== measured.mutationScore)) {
      problems.push(`${rel}: publishes mutation score ${JSON.stringify(found)}, measured ${measured.mutationScore}`);
    }
  }
}

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
          (m, ...g) => (`${g[0]}/${g[1]}` === '10/12' ? m : m.replace(`${g[0]}/${g[1]}`, measured.mutationScore)));
      }
    }
    if (text !== before) { await fs.writeFile(file, text, 'utf8'); console.log(`updated ${rel}`); }
  }
  console.log('\nsurfaces rewritten to the measured values; re-run without --write to confirm.');
  process.exit(0);
}

if (problems.length) {
  console.error(`\npublished numbers: FAILED\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  console.error('\nFix the SURFACES to match the measurement, or fix the product. Never edit the '
    + 'measurement to match the surfaces.');
  process.exit(1);
}
console.log('\npublished numbers: every surface matches a measurement that actually ran.');
