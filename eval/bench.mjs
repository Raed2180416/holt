/**
 * holt — the scale benchmark.
 *
 * Correctness at N=8 says nothing about N=300, and "fast on my repo" is not a number. This
 * builds a repository with a configurable number of worktrees in a fixed composition, then
 * measures BOTH:
 *
 *   time         full scan+analyze wall clock, plus the per-phase split
 *   correctness  every planted at-risk worktree flagged, every disposable one identified —
 *                at scale, not just in the small fixtures
 *
 * A benchmark that measures speed without re-checking correctness would reward a scanner that
 * got faster by skipping work — the exact silent failure this project keeps finding. So the
 * correctness check IS part of the benchmark, and a wrong verdict fails the run outright.
 *
 * Composition per 10 worktrees (deterministic, seeded by index):
 *   3 committed-ahead (unique function each)     -> must be flagged, NOT disposable
 *   2 uncommitted-only (unique file each)        -> must be flagged at-risk
 *   3 landed (base independently has content)    -> must be disposable
 *   2 empty                                      -> must be disposable
 *
 *   node eval/bench.mjs [count]        # default 100
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { discover } from '../src/discover.mjs';
import { scan } from '../src/scan.mjs';
import { analyze } from '../src/analyze.mjs';

const COUNT = Number(process.argv[2] ?? 100);
const WORK = process.env.HOLT_BENCH_WORK
  ?? path.join(os.homedir(), '.holt-work', 'holt-bench');

function sh(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      cwd, timeout: 120_000, maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'bench', GIT_AUTHOR_EMAIL: 'b@b', GIT_COMMITTER_NAME: 'bench',
        GIT_COMMITTER_EMAIL: 'b@b', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
        LC_ALL: 'C',
      },
    }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.slice(0, 3).join(' ')}: ${stderr}`));
      else resolve(String(stdout));
    });
  });
}

async function write(dir, rel, content) {
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}


/**
 * Grade holt's verdicts against the planted ground truth.
 *
 * THE SHIPPED VERSION OF THIS COULD NOT PRINT A DISAGREEMENT. Two defects, stacked, in the
 * harness behind BENCHMARKS.md § 1's headline "1000/1000 correct" and the public tile
 * "1000 — copies checked, all correct":
 *
 *   1. THE HOLD CATEGORY WAS FAIL-OPEN. `const s = report.safe.find(...); if (s?.safe) error()`
 *      records an error only when the answer is TRUE. A worktree holt never reported on at all
 *      yields `undefined`, which is falsy, which is silence. Erasing all 9 committed-ahead
 *      worktrees from EVERY array in holt's report still printed "hold 9/9 held" and
 *      "✓ every planted verdict correct at this scale", exit 0. At N=1000 that is 300 of the
 *      1000 verdicts ungraded.
 *
 *   2. THE SUMMARY LINE WAS PLANTED DIVIDED BY ITSELF — literally
 *      `${expect.hold.size}/${expect.hold.size}`. Structurally incapable of printing anything
 *      but N/N. Holt actively returning the WRONG verdict, calling all 9 committed-ahead
 *      worktrees safe to delete, still printed "hold 9/9 held" beside its own error list.
 *
 * This is the identical fail-open defect eval/enterprise-bench.mjs was fixed for, in the same
 * directory, and it did not propagate because the grading was inline in main() with nothing
 * exported and no test file referencing it. It is exported now, and graded by
 * test/unit/eval-validity.test.mjs.
 *
 * NOT FOUND is an error in its own right, before any verdict is inspected. Every printed
 * numerator has a denominator counting what was actually graded.
 */
export function gradeVerdicts(report, expect) {
  const errors = [];
  const safeOf = (id) => (report.safe ?? []).find((x) => x.id === id);
  const uniqueOf = (id) => (report.unique ?? []).find((x) => x.id === id);

  let atRiskGraded = 0; let atRiskRight = 0;
  for (const id of expect.atRisk) {
    const s = safeOf(id); const u = uniqueOf(id);
    if (!s && !u) { errors.push(`${id}: planted at-risk, holt reported on it NOWHERE — ungraded, not correct`); continue; }
    atRiskGraded++;
    const flagged = !!u && u.uncommittedOnlyCount >= 1;
    if (!flagged) errors.push(`${id}: planted at-risk, not flagged`);
    if (s?.safe) errors.push(`${id}: planted at-risk, called SAFE`);
    if (flagged && !s?.safe) atRiskRight++;
  }

  let holdGraded = 0; let holdRight = 0;
  for (const id of expect.hold) {
    const s = safeOf(id);
    if (!s) { errors.push(`${id}: planted committed-ahead, absent from holt's safe report — ungraded, not correct`); continue; }
    holdGraded++;
    if (s.safe) errors.push(`${id}: planted committed-ahead, called SAFE`);
    else holdRight++;
  }

  let disposableGraded = 0; let disposableRight = 0;
  for (const id of expect.disposable) {
    const s = safeOf(id);
    if (!s) { errors.push(`${id}: planted disposable, absent from holt's safe report — ungraded, not correct`); continue; }
    disposableGraded++;
    if (s.safe) disposableRight++;
    else errors.push(`${id}: planted disposable, NOT called safe (${s.reasons?.join('; ')})`);
  }

  const plantedTotal = expect.atRisk.size + expect.hold.size + expect.disposable.size;
  const gradedTotal = atRiskGraded + holdGraded + disposableGraded;
  return {
    errors,
    atRiskGraded, atRiskRight, holdGraded, holdRight, disposableGraded, disposableRight,
    plantedTotal, gradedTotal,
    allRight: atRiskRight + holdRight + disposableRight,
  };
}

async function main() {
  console.log(`holt bench · ${COUNT} worktrees\n`);
  await fs.rm(WORK, { recursive: true, force: true });
  const root = path.join(WORK, 'repo');
  await fs.mkdir(root, { recursive: true });

  // ---- build ---------------------------------------------------------------
  const t0 = Date.now();
  await sh('git', ['init', '-q', '--initial-branch=main'], root);
  await write(root, 'src/base.js', 'export function baseline() { return 1; }\n');
  // A moderately real base: 50 files so scans do meaningful work.
  for (let i = 0; i < 50; i++) {
    await write(root, `src/mod_${i}.js`, `export function mod_${i}() { return ${i}; }\n`);
  }
  await sh('git', ['add', '-A'], root);
  await sh('git', ['commit', '-q', '-m', 'base'], root);
  const base = (await sh('git', ['rev-parse', 'HEAD'], root)).trim();

  const expect = { atRisk: new Set(), hold: new Set(), disposable: new Set() };
  const wtRoot = path.join(WORK, 'wt');
  await fs.mkdir(wtRoot, { recursive: true });

  for (let i = 0; i < COUNT; i++) {
    const id = `bench-${String(i).padStart(4, '0')}`;
    const wt = path.join(wtRoot, id);
    await sh('git', ['worktree', 'add', '-q', '--detach', wt, base], root);

    const kind = i % 10;
    if (kind < 3) {
      // committed-ahead
      await write(wt, `src/ahead_${i}.js`, `export function ahead_${i}() { return ${i}; }\n`);
      await sh('git', ['add', '-A'], wt);
      await sh('git', ['commit', '-q', '-m', `ahead ${i}`], wt);
      expect.hold.add(id);
    } else if (kind < 5) {
      // uncommitted-only
      await write(wt, `src/only_${i}.js`, `export function only_${i}() { return ${i}; }\n`);
      expect.atRisk.add(id);
    } else if (kind < 8) {
      // landed: committed here AND independently on base
      const body = `export function landed_${i}() { return ${i}; }\n`;
      await write(wt, `src/landed_${i}.js`, body);
      await sh('git', ['add', '-A'], wt);
      await sh('git', ['commit', '-q', '-m', `landed ${i}`], wt);
      await write(root, `src/landed_${i}.js`, body);
      await sh('git', ['add', '-A'], root);
      await sh('git', ['commit', '-q', '-m', `base lands ${i}`], root);
      expect.disposable.add(id);
    } else {
      expect.disposable.add(id);
    }
  }
  const buildMs = Date.now() - t0;
  console.log(`  build         ${(buildMs / 1000).toFixed(1)}s (${COUNT} worktrees, fixture cost — not holt)`);

  // ---- measure -------------------------------------------------------------
  const t1 = Date.now();
  const disc = await discover(root);
  const tDisc = Date.now();
  const scanned = await scan(disc, {});
  const tScan = Date.now();
  const report = await analyze(scanned, {});
  const tAnalyze = Date.now();

  console.log(`  discover      ${tDisc - t1}ms`);
  console.log(`  scan          ${tScan - tDisc}ms  (files + symbols, ${scanned.workstreams.length} workstreams)`);
  console.log(`  analyze       ${tAnalyze - tScan}ms  (${report.collisions.length} collisions, ${report.duplicates.length} dup pairs)`);
  console.log(`  TOTAL         ${tAnalyze - t1}ms  ·  ${((tAnalyze - t1) / COUNT).toFixed(1)}ms/worktree\n`);

  // ---- correctness AT SCALE ------------------------------------------------
  const g = gradeVerdicts(report, expect);
  const { errors } = g;

  console.log(`  correctness   at-risk ${g.atRiskRight}/${g.atRiskGraded} flagged · `
    + `hold ${g.holdRight}/${g.holdGraded} held · `
    + `disposable ${g.disposableRight}/${g.disposableGraded} identified`
    + (g.gradedTotal < g.plantedTotal
      ? `  ·  ${g.plantedTotal - g.gradedTotal} of ${g.plantedTotal} planted worktrees were NOT GRADED`
      : ''));

  if (errors.length) {
    console.error(`\n  ✗ ${errors.length} CORRECTNESS FAILURES AT SCALE — the speed number above is void:\n`
      + errors.slice(0, 10).map((e) => `    ${e}`).join('\n'));
    process.exitCode = 1;
  } else {
    console.log('  ✓ every planted verdict correct at this scale\n');
  }

  await fs.rm(WORK, { recursive: true, force: true }).catch(() => {});
}

// pathToFileURL, not a raw comparison: argv[1] is a backslash path on Windows and percent-encodes
// on a path containing a space, so the naive spellings of this guard are silently inert — and an
// inert guard here means main() runs on import and the grading tests can never load gradeVerdicts.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
