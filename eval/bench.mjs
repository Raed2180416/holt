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
 *   node eval/bench.mjs [count] [--runs 5] [--warmups 1] [--out evidence.json]
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discover } from '../src/discover.mjs';
import { scan } from '../src/scan.mjs';
import { analyze } from '../src/analyze.mjs';

const ARGS = process.argv.slice(2);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const argValue = (name, fallback) => {
  const at = ARGS.indexOf(`--${name}`);
  return at === -1 ? fallback : ARGS[at + 1];
};
const positionalCount = ARGS.find((a) => /^\d+$/.test(a));
const COUNT = Number(positionalCount ?? 100);
const RUNS = Number(argValue('runs', 5));
const WARMUPS = Number(argValue('warmups', 1));
const KEEP = ARGS.includes('--keep');
const WORK = path.resolve(argValue('work', process.env.HOLT_BENCH_WORK
  ?? path.join(os.homedir(), '.cache', 'holt-bench')));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve(argValue('out', path.join(
  os.homedir(), '.cache', 'holt-benchmark-evidence', `scale-${stamp}.json`,
)));
// Git for Windows is an MSYS program and accepts /dev/null. The benchmark controller imposes no
// process deadline; cancellation belongs to the outer operator so a slow valid run cannot be
// silently reclassified as a product failure.
const NULL_DEVICE = '/dev/null';
const WORK_MARKER = '.holt-benchmark-sandbox';
const WORK_MARKER_BODY = 'holt scale benchmark sandbox v1\n';

function sh(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      cwd, maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'bench', GIT_AUTHOR_EMAIL: 'b@b', GIT_COMMITTER_NAME: 'bench',
        GIT_COMMITTER_EMAIL: 'b@b', GIT_CONFIG_GLOBAL: NULL_DEVICE, GIT_CONFIG_SYSTEM: NULL_DEVICE,
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

function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

/** A benchmark may erase only the scratch root it created and marked itself. */
async function prepareWorkRoot(root) {
  const forbidden = new Set([
    path.parse(root).root,
    path.resolve(os.homedir()),
    path.resolve(HERE, '..'),
    path.resolve(process.cwd()),
  ]);
  if (forbidden.has(root)) throw new Error(`refusing unsafe benchmark root: ${root}`);
  if (inside(OUT, root)) {
    throw new Error(`--out must be outside --work; cleanup would erase the only evidence (${OUT})`);
  }

  const exists = await fs.stat(root).then(() => true, () => false);
  if (exists) {
    const marker = await fs.readFile(path.join(root, WORK_MARKER), 'utf8').catch(() => null);
    if (marker !== WORK_MARKER_BODY) {
      throw new Error(
        `refusing to replace ${root}: it lacks Holt's exact ${WORK_MARKER} ownership marker`,
      );
    }
    await fs.rm(root, { recursive: true, force: true });
  }
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, WORK_MARKER), WORK_MARKER_BODY, 'utf8');
}

async function assertFreshEvidencePath(out = OUT) {
  for (const candidate of [out, `${out}.sha256`]) {
    if (await fs.lstat(candidate).then(() => true, () => false)) {
      throw new Error(`refusing to overwrite existing benchmark evidence: ${candidate}`);
    }
  }
}

async function cleanWorkRoot(root) {
  if (KEEP) return;
  const marker = await fs.readFile(path.join(root, WORK_MARKER), 'utf8').catch(() => null);
  if (marker !== WORK_MARKER_BODY) {
    throw new Error(`refusing cleanup: ${root} no longer has Holt's exact ownership marker`);
  }
  await fs.rm(root, { recursive: true, force: true });
}

function sampleStats(values) {
  const xs = [...values].sort((a, b) => a - b);
  const nearest = (p) => xs[Math.max(0, Math.min(xs.length - 1, Math.ceil(p * xs.length) - 1))];
  return {
    samples: xs.length,
    min: xs[0] ?? null,
    p50: xs.length ? nearest(0.50) : null,
    p90: xs.length ? nearest(0.90) : null,
    max: xs.at(-1) ?? null,
    mean: xs.length ? xs.reduce((sum, n) => sum + n, 0) / xs.length : null,
  };
}

async function commandVersion(cmd, args = ['--version']) {
  return new Promise((resolve) => {
    execFile(cmd, args, {}, (err, stdout, stderr) => {
      resolve(err ? { available: false, error: String(stderr || err.message).trim() }
        : { available: true, version: String(stdout || stderr).trim().split('\n')[0] });
    });
  });
}

async function sourceMetadata() {
  const sourceRoot = path.resolve(HERE, '..');
  const [commit, status, gitVersion, ctagsVersion, enryVersion, jjVersion] = await Promise.all([
    sh('git', ['rev-parse', 'HEAD'], sourceRoot).then((s) => s.trim()).catch(() => null),
    sh('git', ['status', '--porcelain=v1', '--untracked-files=all'], sourceRoot).catch(() => ''),
    commandVersion('git'),
    commandVersion('ctags'),
    commandVersion('enry'),
    commandVersion('jj'),
  ]);
  return {
    commit,
    dirty: status.length > 0,
    dirtyStateSha256: status ? createHash('sha256').update(status).digest('hex') : null,
    tools: { git: gitVersion, ctags: ctagsVersion, enry: enryVersion, jj: jjVersion },
  };
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
  if (!Number.isInteger(COUNT) || COUNT < 1) throw new Error(`count must be a positive integer, got ${COUNT}`);
  if (!Number.isInteger(RUNS) || RUNS < 1) throw new Error(`--runs must be a positive integer, got ${RUNS}`);
  if (!Number.isInteger(WARMUPS) || WARMUPS < 0) throw new Error(`--warmups must be a non-negative integer, got ${WARMUPS}`);

  console.log(`holt bench · ${COUNT} worktrees · ${WARMUPS} warmup(s) + ${RUNS} measured run(s)\n`);
  await assertFreshEvidencePath(OUT);
  await prepareWorkRoot(WORK);
  const root = path.join(WORK, 'repo');
  await fs.mkdir(root, { recursive: true });

  const evidence = {
    schemaVersion: 1,
    benchmark: 'holt-scale-correctness',
    generatedAt: new Date().toISOString(),
    command: [process.execPath, ...process.argv.slice(1)],
    source: await sourceMetadata(),
    runtime: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      osRelease: os.release(),
      kernelType: os.type(),
      cpuModel: os.cpus()[0]?.model ?? null,
      logicalCpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      loadAverageAtStart: os.loadavg(),
    },
    fixture: {
      count: COUNT,
      baseFileCount: 51,
      compositionPerTen: { committedAhead: 3, uncommittedOnly: 2, landed: 3, empty: 2 },
      baseCommit: null,
      expected: null,
      buildMs: null,
    },
    protocol: { warmups: WARMUPS, measuredRuns: RUNS, clock: 'performance.now monotonic milliseconds' },
    samples: [],
    summary: null,
    valid: false,
  };

  try {
    // ---- build -------------------------------------------------------------
    const buildStarted = performance.now();
    await sh('git', ['init', '-q', '--initial-branch=main'], root);
    await write(root, 'src/base.js', 'export function baseline() { return 1; }\n');
    for (let i = 0; i < 50; i++) {
      await write(root, `src/mod_${i}.js`, `export function mod_${i}() { return ${i}; }\n`);
    }
    await sh('git', ['add', '-A'], root);
    await sh('git', ['commit', '-q', '-m', 'base'], root);
    const base = (await sh('git', ['rev-parse', 'HEAD'], root)).trim();
    evidence.fixture.baseCommit = base;

    const expect = { atRisk: new Set(), hold: new Set(), disposable: new Set() };
    const wtRoot = path.join(WORK, 'wt');
    await fs.mkdir(wtRoot, { recursive: true });

    for (let i = 0; i < COUNT; i++) {
      const id = `bench-${String(i).padStart(4, '0')}`;
      const wt = path.join(wtRoot, id);
      await sh('git', ['worktree', 'add', '-q', '--detach', wt, base], root);

      const kind = i % 10;
      if (kind < 3) {
        await write(wt, `src/ahead_${i}.js`, `export function ahead_${i}() { return ${i}; }\n`);
        await sh('git', ['add', '-A'], wt);
        await sh('git', ['commit', '-q', '-m', `ahead ${i}`], wt);
        expect.hold.add(id);
      } else if (kind < 5) {
        await write(wt, `src/only_${i}.js`, `export function only_${i}() { return ${i}; }\n`);
        expect.atRisk.add(id);
      } else if (kind < 8) {
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
    evidence.fixture.buildMs = performance.now() - buildStarted;
    evidence.fixture.expected = {
      atRisk: expect.atRisk.size,
      hold: expect.hold.size,
      disposable: expect.disposable.size,
      total: expect.atRisk.size + expect.hold.size + expect.disposable.size,
    };
    console.log(`  build         ${(evidence.fixture.buildMs / 1000).toFixed(1)}s (fixture cost; excluded from Holt timings)`);

    // ---- repeated measurement + a fresh independent grade every time ------
    for (let i = 0; i < WARMUPS + RUNS; i++) {
      const warmup = i < WARMUPS;
      const started = performance.now();
      const disc = await discover(root);
      const discovered = performance.now();
      const scanned = await scan(disc, {});
      const scanFinished = performance.now();
      const report = await analyze(scanned, {});
      const finished = performance.now();
      const grade = gradeVerdicts(report, expect);
      const sample = {
        iteration: i + 1,
        warmup,
        discoverMs: discovered - started,
        scanMs: scanFinished - discovered,
        analyzeMs: finished - scanFinished,
        totalMs: finished - started,
        workstreamsReported: scanned.workstreams.length,
        collisions: report.collisions.length,
        duplicatePairs: report.duplicates.length,
        correctness: {
          atRiskRight: grade.atRiskRight,
          atRiskGraded: grade.atRiskGraded,
          holdRight: grade.holdRight,
          holdGraded: grade.holdGraded,
          disposableRight: grade.disposableRight,
          disposableGraded: grade.disposableGraded,
          allRight: grade.allRight,
          gradedTotal: grade.gradedTotal,
          plantedTotal: grade.plantedTotal,
          errors: grade.errors,
        },
      };
      evidence.samples.push(sample);
      console.log(`  ${warmup ? 'warmup ' : 'run    '} ${String(warmup ? i + 1 : i - WARMUPS + 1).padStart(2)}  `
        + `${sample.totalMs.toFixed(1)}ms · ${grade.allRight}/${grade.plantedTotal} correct`
        + (grade.errors.length ? ` · ${grade.errors.length} ERROR(S)` : ''));
    }

    const measured = evidence.samples.filter((s) => !s.warmup);
    const bad = measured.filter((s) => s.correctness.errors.length > 0
      || s.correctness.gradedTotal !== s.correctness.plantedTotal
      || s.correctness.allRight !== s.correctness.plantedTotal);
    evidence.summary = {
      discoverMs: sampleStats(measured.map((s) => s.discoverMs)),
      scanMs: sampleStats(measured.map((s) => s.scanMs)),
      analyzeMs: sampleStats(measured.map((s) => s.analyzeMs)),
      totalMs: sampleStats(measured.map((s) => s.totalMs)),
      totalMsPerWorktree: sampleStats(measured.map((s) => s.totalMs / COUNT)),
      correctRuns: measured.length - bad.length,
      measuredRuns: measured.length,
      everyVerdictGradedAndCorrect: bad.length === 0,
    };
    evidence.valid = bad.length === 0;
    evidence.runtime.loadAverageAtEnd = os.loadavg();

    await fs.mkdir(path.dirname(OUT), { recursive: true });
    const encoded = `${JSON.stringify(evidence, null, 2)}\n`;
    await fs.writeFile(OUT, encoded, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const digest = createHash('sha256').update(encoded).digest('hex');
    await fs.writeFile(`${OUT}.sha256`, `${digest}  ${path.basename(OUT)}\n`, {
      encoding: 'utf8', flag: 'wx', mode: 0o600,
    });

    console.log(`\n  p50 total     ${evidence.summary.totalMs.p50.toFixed(1)}ms`);
    console.log(`  p90 total     ${evidence.summary.totalMs.p90.toFixed(1)}ms`);
    console.log(`  correctness   ${evidence.summary.correctRuns}/${evidence.summary.measuredRuns} runs fully graded and correct`);
    console.log(`  raw evidence  ${OUT}`);
    console.log(`  sha256        ${digest}\n`);

    if (!evidence.valid) {
      const examples = bad.flatMap((s) => s.correctness.errors).slice(0, 10);
      console.error(`  ✗ correctness failed; every timing above is void:\n${examples.map((e) => `    ${e}`).join('\n')}`);
      process.exitCode = 1;
    }
  } finally {
    await cleanWorkRoot(WORK);
  }
}

// pathToFileURL, not a raw comparison: argv[1] is a backslash path on Windows and percent-encodes
// on a path containing a space, so the naive spellings of this guard are silently inert — and an
// inert guard here means main() runs on import and the grading tests can never load gradeVerdicts.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
