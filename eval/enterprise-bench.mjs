#!/usr/bin/env node
// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — the enterprise-scale benchmark.
 *
 * Tests holt against REAL repositories at scale, with messy worktrees, noise, and
 * full command verification. See BENCHMARKS.md for results.
 *
 * Usage:
 *   node eval/enterprise-bench.mjs [repo-name] [--worktrees N] [--noise-level L] [--runs N]
 *
 * THIS HARNESS PUBLISHED FALSE NUMBERS ONCE. Every defect below was live in the version whose
 * output reached BENCHMARKS.md, and each one is the same shape as the bug holt itself exists to
 * catch — a measurement that cannot tell "nothing was wrong" from "nothing was measured":
 *
 *   1. verifyCorrectness() asked `report.safe.find(...)?.safe` and reported an error only when
 *      the answer was TRUE. A workstream holt never saw at all yielded `undefined`, which is
 *      falsy, which recorded no error — so a run in which holt found NOTHING printed
 *      "✓ NO ISSUES FOUND". That is precisely the fail-open-on-missing-evidence defect
 *      test/unit/eval-validity.test.mjs was written about one layer up, in the same eval/
 *      directory. Every planted workstream must now be FOUND before its verdict is graded.
 *
 *   2. `disc.worktrees?.length ?? 0` — discover() returns `workstreams`. The field does not
 *      exist, so the published "workstreams" column was 0 in every row ever printed.
 *
 *   3. peakRSS() read process.memoryUsage() ONCE, after the pipeline had already finished, and
 *      called the result a peak. It is now sampled while the pipeline runs.
 *
 *   4. The clone was CACHED and then COMMITTED TO: the "landed" pattern writes `base lands N`
 *      commits into the repository root so that content exists on base independently. Cached
 *      across runs, those commits accumulate, so run 2 measured a different repository from
 *      run 1 and "median of three runs" compared three different fixtures. Each run now works
 *      in a disposable local clone; the cache is never written to.
 *
 *   5. One run per invocation, with no warmup and no distribution. A single cold-cache sample
 *      was being reported as if it were a stable figure.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { discover } from '../src/discover.mjs';
import { scan } from '../src/scan.mjs';
import { analyze } from '../src/analyze.mjs';

const WORK = path.join(os.homedir(), '.holt-work', 'enterprise-bench');
const CACHE = path.join(WORK, 'cache');
const HOLT_BIN = path.resolve(path.join(import.meta.dirname, '..', 'bin/holt.mjs'));

const REPOS = {
  'holt-self': {
    url: null, local: '/home/raed/grove',
    desc: 'holt itself — 20K lines, the dogfooding case',
  },
  'redis': {
    url: 'https://github.com/redis/redis.git',
    desc: 'Redis — ~1,858 C files, the benchmark from BENCHMARKS.md',
  },
  'postgres': {
    url: 'https://github.com/postgres/postgres.git',
    desc: 'PostgreSQL — large C codebase, diverse file types',
  },
};

const args = process.argv.slice(2);
let repoName = 'holt-self';
let worktreeCount = 50;
let noiseLevel = 1;
let runs = 3;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--worktrees') worktreeCount = Number(args[++i]);
  else if (args[i] === '--noise-level') noiseLevel = Number(args[++i]);
  else if (args[i] === '--runs') runs = Number(args[++i]);
  else if (args[i] === '--all') repoName = 'all';
  else if (args[i] === '--list') { console.log('Available repos:', Object.keys(REPOS).join(', ')); process.exit(0); }
  else if (!args[i].startsWith('-')) repoName = args[i];
}

function sh(cmd, args, cwd, timeout = 300_000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      cwd, timeout, maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, GIT_AUTHOR_NAME: 'bench', GIT_AUTHOR_EMAIL: 'b@b',
        GIT_COMMITTER_NAME: 'bench', GIT_COMMITTER_EMAIL: 'b@b',
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', LC_ALL: 'C' },
    }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.slice(0, 5).join(' ')}: ${stderr || err.message}`));
      else resolve(String(stdout));
    });
  });
}

/**
 * Sample RSS WHILE the work runs. The previous version read process.memoryUsage() once, after the
 * pipeline had returned, and published it as "peak RSS" — a number taken at the one moment the
 * peak is guaranteed to be over. V8 does not return memory to the OS promptly, so the reading was
 * not nonsense, but it was not a peak either, and it could not see a spike that had already been
 * collected.
 */
function rssSampler(everyMs = 25) {
  let peak = process.memoryUsage().rss;
  const t = setInterval(() => {
    const r = process.memoryUsage().rss;
    if (r > peak) peak = r;
  }, everyMs);
  if (typeof t.unref === 'function') t.unref();
  return { stop: () => { clearInterval(t); return Math.round(peak / 1024 / 1024); } };
}
async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

/** p-th percentile of a numeric sample, nearest-rank. Small n, so no interpolation games. */
export function percentile(xs, p) {
  const s = [...xs].filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

/** The upstream copy. Fetched once, then treated as read-only for the life of the machine. */
async function prepareCache(name, spec) {
  const cacheDir = path.join(CACHE, name);
  if (await exists(path.join(cacheDir, '.git'))) {
    console.log(`  using cached clone: ${cacheDir}`);
    return cacheDir;
  }
  await fs.mkdir(CACHE, { recursive: true });
  if (spec.local) {
    console.log(`  cloning local repo ${spec.local}...`);
    await sh('git', ['clone', spec.local, cacheDir], CACHE, 300_000);
  } else {
    console.log(`  shallow-cloning ${name} from ${spec.url}...`);
    const t0 = Date.now();
    await sh('git', ['clone', '--depth', '1', spec.url, cacheDir], CACHE, 900_000);
    console.log(`  clone took ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  return cacheDir;
}

/**
 * A DISPOSABLE COPY PER RUN, because this benchmark MUTATES the repository it measures.
 *
 * The "landed" pattern has to commit content to the repository root — that is what makes the
 * content exist on base independently, which is the whole point of the case. The old harness did
 * that directly in the cached clone and then reused the cache, so every run inherited the
 * previous run's `base lands N` commits. Run 2 measured a repository run 1 had edited; "median of
 * three runs" was the median of three different fixtures; and the tracked-file count crept up on
 * every invocation.
 *
 * `git clone --local` hardlinks the object store, so this costs a checkout and almost no disk.
 */
async function freshWorkingCopy(cacheDir, tag) {
  const dest = path.join(WORK, `run-${tag}`);
  await fs.rm(dest, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(WORK, { recursive: true });
  await sh('git', ['clone', '--local', '--no-hardlinks', cacheDir, dest], WORK, 600_000);
  // The bench commits to this copy; give it an identity that does not depend on the machine.
  await sh('git', ['config', 'user.email', 'bench@holt.invalid'], dest);
  await sh('git', ['config', 'user.name', 'holt bench'], dest);
  return dest;
}

async function createWorktrees(root, count, noise) {
  const wtRoot = path.join(WORK, 'wt');
  await fs.rm(wtRoot, { recursive: true, force: true }).catch(() => {});
  // Prune stale worktree registrations from previous runs
  await sh('git', ['worktree', 'prune'], root).catch(() => {});
  await fs.mkdir(wtRoot, { recursive: true });
  const head = (await sh('git', ['rev-parse', 'HEAD'], root)).trim();
  const planted = { atRisk: [], hold: [], disposable: [], gitignored: [], binary: [], huge: [] };
  const failures = [];

  // A CASE THAT WAS NOT PLANTED MUST NOT BE CLAIMED AS PLANTED.
  //
  // Every write here used to end in `.catch(() => {})` and every commit in `try {} catch {}`, and
  // the id was pushed into its bucket unconditionally afterwards. So a repository without a `src/`
  // directory — the write target is hardcoded, and not every repo has one — silently produced
  // worktrees with no content that the grader then held to the standard of the case they were
  // supposed to be. An empty worktree IS disposable, so holt correctly called it safe, and the
  // grader recorded "hold ent-0003: called SAFE but has committed-ahead content" as a CRITICAL
  // correctness failure of the product. The fixture's own breakage, published as a defect.
  const writeIn = async (dir, file, body) => {
    const abs = path.join(dir, file);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body);
    const st = await fs.stat(abs);          // GRADE FROM THE FILESYSTEM, including your own fixture
    if (!st.size && body.length) throw new Error(`wrote ${file} but it is empty`);
  };

  for (let i = 0; i < count; i++) {
    const id = `ent-${String(i).padStart(4, '0')}`;
    const wt = path.join(wtRoot, id);
    const write = (file, body) => writeIn(wt, file, body);
    const kind = i % 10;
    try { await sh('git', ['worktree', 'add', '-q', '--detach', wt, head], root); }
    catch (e) { failures.push(`${id}: worktree add failed: ${e.message}`); continue; }
    try {
      if (kind < 2) {
        await write(`holt_bench/ent_${i}.js`, `// UNIQUE ${id}\nexport function ent_${i}() { return ${i}; }\n`);
        await sh('git', ['add', '-A'], wt);
        await sh('git', ['commit', '-q', '-m', `ent ${i}`], wt);
        planted.hold.push(id);
      } else if (kind < 4) {
        await write(`holt_bench/uncommitted_${i}.js`, `// ONLY COPY ${id}\nexport function ent_only_${i}() { return ${i}; }\n`);
        planted.atRisk.push(id);
      } else if (kind < 5 && noise >= 1) {
        await write('.gitignore', `secret_${i}.env\n`);
        await write(`secret_${i}.env`, `API_KEY=unique_to_${id}\n`);
        planted.gitignored.push(id);
      } else if (kind < 6 && noise >= 2) {
        const buf = Buffer.alloc(1024); buf[0] = 0; buf[1] = 0x89;
        await write(`holt_bench/binary_${i}.png`, buf);
        planted.binary.push(id);
      } else if (kind < 7 && noise >= 2) {
        await write(`holt_bench/huge_${i}.js`, Buffer.alloc(3 * 1024 * 1024, 0x41));
        planted.huge.push(id);
      } else if (kind < 8) {
        // landed: committed here AND independently on base -> disposable
        const body = `export function ent_landed_${i}() { return ${i}; }\n`;
        await write(`holt_bench/landed_${i}.js`, body);
        await sh('git', ['add', '-A'], wt);
        await sh('git', ['commit', '-q', '-m', `landed ${i}`], wt);
        // Also commit to base so the content exists there independently. This is why the run
        // needs its own disposable clone — see freshWorkingCopy().
        const rootFile = path.join(root, 'holt_bench', `landed_${i}.js`);
        await fs.mkdir(path.dirname(rootFile), { recursive: true });
        await fs.writeFile(rootFile, body);
        await sh('git', ['add', '-A'], root);
        await sh('git', ['commit', '-q', '-m', `base lands ${i}`], root);
        planted.disposable.push(id);
      } else {
        // An untouched worktree. Genuinely disposable, and nothing has to be planted for it — but
        // it is still verified below that it exists and is empty.
        const dirty = (await sh('git', ['status', '--porcelain'], wt)).trim();
        if (dirty) throw new Error(`expected an untouched worktree, found: ${dirty.slice(0, 120)}`);
        planted.disposable.push(id);
      }
    } catch (e) {
      failures.push(`${id} (kind ${kind}): ${e.message}`);
    }
  }
  return { wtRoot, planted, failures };
}

async function runPipeline(root) {
  const results = { phases: {}, errors: [] };
  const rss = rssSampler();
  const t0 = Date.now();
  let disc;
  try { disc = await discover(root); } catch (e) { results.errors.push(`discover: ${e.message}`); results.peakRSS = rss.stop(); return results; }
  results.phases.discover = Date.now() - t0;
  // `workstreams`, not `worktrees`. discover() has never had a `worktrees` field, so this read
  // `undefined?.length ?? 0` and the published column was 0 in every row this harness ever
  // printed — including the rows that reached BENCHMARKS.md.
  results.workstreamCount = disc.workstreams?.length ?? 0;
  if (!Number.isInteger(results.workstreamCount) || results.workstreamCount === 0) {
    results.errors.push('discover returned no workstreams — the fixture did not build, so nothing below is a measurement');
    results.peakRSS = rss.stop();
    return results;
  }
  const t1 = Date.now();
  let scanned;
  try { scanned = await scan(disc, {}); } catch (e) { results.errors.push(`scan: ${e.message}`); results.phases.scan = Date.now() - t1; results.peakRSS = rss.stop(); return results; }
  results.phases.scan = Date.now() - t1;
  const t2 = Date.now();
  let report;
  try { report = await analyze(scanned, {}); } catch (e) { results.errors.push(`analyze: ${e.message}`); results.phases.analyze = Date.now() - t2; results.peakRSS = rss.stop(); return results; }
  results.phases.analyze = Date.now() - t2;
  results.total = Date.now() - t0;
  results.peakRSS = rss.stop();
  results.report = report;
  results.collisions = report.collisions?.length ?? 0;
  results.duplicates = report.duplicates?.length ?? 0;
  results.safeCount = report.safe?.filter((s) => s.safe).length ?? 0;
  results.atRiskCount = report.unique?.length ?? 0;
  results.skippedCount = report.skipped?.length ?? 0;
  return results;
}

async function testCommands(root) {
  const results = {};
  const commands = [
    ['status', ['status', '--json']],
    ['risk', ['risk', '--json']],
    ['collisions', ['collisions', '--json']],
    ['graph', ['graph', '--html', path.join(WORK, 'graph-test.html')]],
    ['clean', ['clean']],
    ['doctor', ['doctor']],
    ['stash', ['stash', '--json']],
  ];
  for (const [name, cmd] of commands) {
    const t0 = Date.now();
    try {
      const out = await new Promise((resolve, reject) => {
        execFile('node', [HOLT_BIN, ...cmd], {
          cwd: root, timeout: 120_000, maxBuffer: 256 * 1024 * 1024,
          env: { ...process.env, HOME: os.homedir() },
        }, (err, stdout, stderr) => { if (err) reject({ err, stderr, stdout }); else resolve({ stdout, stderr }); });
      });
      results[name] = { ok: true, ms: Date.now() - t0, stdoutLen: out.stdout.length, stderrLen: out.stderr.length, stderr: out.stderr.slice(0, 500) };
      if (cmd.includes('--json')) { try { JSON.parse(out.stdout); results[name].validJson = true; } catch { results[name].validJson = false; results[name].error = 'invalid JSON'; } }
    } catch (e) {
      results[name] = { ok: false, ms: Date.now() - t0, error: e.err?.message || e.message, stderr: (e.stderr || '').slice(0, 500), exitCode: e.err?.code };
    }
  }
  return results;
}

/**
 * Grade holt's verdicts against what the fixture planted.
 *
 * THE RULE THIS FILE GOT WRONG: A VERDICT THAT WAS NEVER RENDERED IS NOT A CORRECT VERDICT.
 *
 * Every check here used to read `report.safe.find(...)?.safe` and record an error only when that
 * was TRUE. A workstream holt never reported on — because the worktree directory was missing,
 * because the scan died, because the ids did not match the shape the finder expected — produced
 * `undefined`. Undefined is falsy. No error was recorded, for any of the four categories, and the
 * harness printed "✓ NO ISSUES FOUND" for a run that had graded nothing at all. That is the same
 * fail-open-on-missing-evidence defect eval/run.mjs was fixed for (see
 * test/unit/eval-validity.test.mjs, "an unrun trial is INVALID, never SAFE") — in the same
 * directory, one layer over, six weeks later.
 *
 * So: NOT FOUND is now an error in its own right, before any verdict is looked at.
 */
export function verifyCorrectness(report, planted) {
  const errors = [], warnings = [];
  const rows = report?.safe ?? [];
  const find = (id) => rows.find((x) => x.id === id || x.id?.endsWith(id));

  // ANTI-VACUITY, FIRST: if holt reported on nothing, say so once and loudly rather than
  // reporting four categories of silence as four categories of correctness.
  const planted_all = [...planted.atRisk, ...planted.hold, ...planted.disposable, ...planted.gitignored];
  const missing = planted_all.filter((id) => !find(id));
  if (missing.length) {
    errors.push(
      `${missing.length} of ${planted_all.length} planted workstream(s) do not appear in holt's report at all `
      + `(e.g. ${missing.slice(0, 3).join(', ')}) — an ungraded workstream is not a correct one`);
  }

  const graded = { atRisk: 0, hold: 0, disposable: 0, gitignored: 0 };
  for (const [bucket, why] of [
    ['atRisk', 'has uncommitted-only content'],
    ['hold', 'has committed-ahead content'],
    ['gitignored', 'has gitignored-only content'],
  ]) {
    for (const id of planted[bucket]) {
      const s = find(id);
      if (!s) continue;                    // already counted in `missing` above
      graded[bucket]++;
      if (s.safe) errors.push(`${bucket} ${id}: called SAFE but ${why}`);
    }
  }

  let disposableRight = 0;
  for (const id of planted.disposable) {
    const s = find(id);
    if (!s) continue;
    graded.disposable++;
    if (s.safe) disposableRight++;
    else warnings.push(`disposable ${id}: not called safe (${(s.reasons ?? []).join('; ') || 'no reason given'})`);
  }

  return {
    errors,
    warnings,
    disposableRight,
    // Denominators over what was actually GRADED, so a rate can never be inflated by workstreams
    // that were never seen. `plantedTotal` is kept beside it so the gap is visible rather than
    // divided away.
    disposableTotal: graded.disposable,
    disposablePlanted: planted.disposable.length,
    graded,
    plantedTotal: planted_all.length,
    gradedTotal: Object.values(graded).reduce((a, b) => a + b, 0),
  };
}

async function benchmarkRepo(name, spec) {
  console.log(`\n${'═'.repeat(70)}\n  REPO: ${name} — ${spec.desc}\n  worktrees: ${worktreeCount}, noise: ${noiseLevel}\n${'═'.repeat(70)}\n`);
  const issues = [];
  console.log('  [1/5] Preparing repository...');
  let cache;
  try { cache = await prepareCache(name, spec); }
  catch (e) { return { name, ok: false, error: `prepare: ${e.message}`, issues }; }

  // A WARMUP RUN, DISCARDED, THEN `runs` MEASURED ONES. The first pass over a freshly cloned tree
  // pays for a cold page cache on every object git touches; publishing that as the figure a user
  // will see is not honest, and publishing only the warm figure is not honest either — so the
  // cold number is reported separately rather than averaged in.
  const samples = [];
  let lastVerify = null, lastPipe = null, lastRoot = null, fileCount = null, coldTotal = null;

  for (let attempt = 0; attempt < runs + 1; attempt++) {
    const warmup = attempt === 0;
    const root = await freshWorkingCopy(cache, `${name}-${attempt}`);
    lastRoot = root;
    if (fileCount === null) {
      try { fileCount = (await sh('git', ['ls-files', '--', '.'], root)).split('\n').filter(Boolean).length; } catch {}
      console.log(`  tracked files: ${fileCount}`);
    }
    if (warmup) console.log('  [2/5] Creating messy worktrees (warmup run, discarded)...');
    else if (attempt === 1) console.log('  [2/5] Creating messy worktrees...');

    const t0 = Date.now();
    let wtInfo;
    try { wtInfo = await createWorktrees(root, worktreeCount, noiseLevel); }
    catch (e) { return { name, ok: false, error: `worktrees: ${e.message}`, issues }; }
    if (attempt <= 1) console.log(`  created in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    // THE FIXTURE'S OWN FAILURES ARE REPORTED AS THE FIXTURE'S, not as the product's. A planting
    // failure used to be swallowed and the case counted anyway, so the grader then held holt to
    // the standard of a case that did not exist.
    for (const f of wtInfo.failures ?? []) {
      console.log(`  ⚠ FIXTURE: ${f}`);
      issues.push({ phase: 'fixture', severity: 'high', msg: f });
    }

    if (attempt === 1) console.log('  [3/5] Running holt pipeline...');
    const pipe = await runPipeline(root);
    if (warmup) {
      coldTotal = pipe.total ?? null;
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
      continue;
    }
    samples.push(pipe);
    lastPipe = pipe;
    lastVerify = verifyCorrectness(pipe.report, wtInfo.planted);
    if (attempt < runs) await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }

  const root = lastRoot;
  const pipe = lastPipe ?? { phases: {}, errors: ['no measured run completed'] };
  const wtInfo = { wtRoot: path.join(WORK, 'wt'), planted: { atRisk: [], hold: [], disposable: [], gitignored: [] } };
  const totals = samples.map((s) => s.total).filter((x) => typeof x === 'number');
  const scans = samples.map((s) => s.phases?.scan).filter((x) => typeof x === 'number');
  const rsss = samples.map((s) => s.peakRSS).filter((x) => typeof x === 'number');
  const dist = {
    runs: samples.length,
    coldTotal,
    totalP50: percentile(totals, 50), totalP90: percentile(totals, 90),
    totalMin: percentile(totals, 0), totalMax: percentile(totals, 100),
    scanP50: percentile(scans, 50), scanP90: percentile(scans, 90),
    rssP50: percentile(rsss, 50), rssMax: percentile(rsss, 100),
    samples: totals,
  };

  for (const e of pipe.errors) { console.log(`  ✗ PIPELINE: ${e}`); issues.push({ phase: 'pipeline', severity: 'critical', msg: e }); }
  console.log(`  cold(discarded): ${coldTotal ?? '?'}ms | warm total p50 ${dist.totalP50 ?? '?'}ms p90 ${dist.totalP90 ?? '?'}ms (n=${dist.runs}, ${JSON.stringify(totals)})`);
  console.log(`  scan p50 ${dist.scanP50 ?? '?'}ms p90 ${dist.scanP90 ?? '?'}ms | peak RSS p50 ${dist.rssP50 ?? '?'}MB max ${dist.rssMax ?? '?'}MB`);
  console.log(`  verdicts: ${pipe.safeCount} safe, ${pipe.atRiskCount} at-risk, ${pipe.skippedCount} skipped, ${pipe.workstreamCount} workstreams discovered`);
  console.log('  [4/5] Verifying correctness...');
  const verify = lastVerify ?? { errors: ['no measured run completed'], warnings: [], disposableRight: 0, disposableTotal: 0, gradedTotal: 0, plantedTotal: 0 };
  console.log(`  graded ${verify.gradedTotal}/${verify.plantedTotal} planted workstream(s)`);
  for (const e of verify.errors) { console.log(`  ✗ ${e}`); issues.push({ phase: 'correctness', severity: 'critical', msg: e }); }
  for (const w of verify.warnings) { console.log(`  ⚠ ${w}`); issues.push({ phase: 'correctness', severity: 'medium', msg: w }); }
  console.log(`  disposable: ${verify.disposableRight}/${verify.disposableTotal} correct`);
  console.log('  [5/5] Testing commands...');
  const cmds = await testCommands(root);
  for (const [name, r] of Object.entries(cmds)) {
    if (!r.ok) { console.log(`  ✗ holt ${name}: ${r.error}`); issues.push({ phase: 'command', severity: 'critical', cmd: name, msg: r.error }); }
    else if (r.validJson === false) { console.log(`  ✗ holt ${name}: invalid JSON`); issues.push({ phase: 'command', severity: 'high', cmd: name, msg: 'invalid JSON' }); }
    // Writing to stderr is not a defect. holt deliberately puts advisory text there so that
    // `holt status --json | jq` stays clean, and flagging it as an issue trained the reader to
    // scroll past a list of non-problems — which is how the real ones got missed.
    else { console.log(`  ✓ holt ${name}: ${r.ms}ms${r.validJson ? ', valid JSON' : ''}${r.stderrLen ? `, ${r.stderrLen}b stderr` : ''}`); }
  }
  try { await sh('git', ['worktree', 'prune'], root); await fs.rm(wtInfo.wtRoot, { recursive: true, force: true }).catch(() => {}); } catch {}
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  return { name, ok: issues.filter((i) => i.severity === 'critical').length === 0, issues,
    trackedFiles: fileCount,
    dist,
    metrics: { total: dist.totalP50, totalP90: dist.totalP90, coldTotal, discover: pipe.phases.discover, scan: dist.scanP50, scanP90: dist.scanP90, analyze: pipe.phases.analyze, peakRSS: dist.rssP50, peakRSSMax: dist.rssMax, workstreams: pipe.workstreamCount, collisions: pipe.collisions, duplicates: pipe.duplicates, safe: pipe.safeCount, atRisk: pipe.atRiskCount, skipped: pipe.skippedCount, disposableRight: verify.disposableRight, disposableTotal: verify.disposableTotal, graded: verify.gradedTotal, planted: verify.plantedTotal } };
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════════════╗');
  console.log('║  holt enterprise benchmark — real repos, real mess, real scale    ║');
  console.log('╚════════════════════════════════════════════════════════════════════╝');
  console.log(`  date: ${new Date().toISOString()}`);
  console.log(`  platform: ${process.platform} ${process.arch}, Node ${process.version}`);
  const repos = repoName === 'all' ? Object.entries(REPOS) : [[repoName, REPOS[repoName]]];
  const allResults = [];
  for (const [name, spec] of repos) {
    if (!spec) { console.log(`  unknown repo: ${name}`); continue; }
    try { allResults.push(await benchmarkRepo(name, spec)); }
    catch (e) { console.log(`  FATAL: ${e.message}`); allResults.push({ name, ok: false, error: e.message, issues: [] }); }
  }
  console.log(`\n${'═'.repeat(70)}\n  SUMMARY\n${'═'.repeat(70)}\n`);
  console.log('  | repo | files | wt | total p50 | p90 | cold | scan p50 | RSS p50 | graded | disposable | issues |');
  console.log('  |---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of allResults) {
    const m = r.metrics || {};
    const crit = r.issues?.filter((i) => i.severity === 'critical').length ?? 0;
    console.log(
      `  | ${r.name} | ${r.trackedFiles ?? '?'} | ${m.workstreams ?? '?'} | ${m.total ?? '?'}ms | ${m.totalP90 ?? '?'}ms `
      + `| ${m.coldTotal ?? '?'}ms | ${m.scan ?? '?'}ms | ${m.peakRSS ?? '?'}MB `
      + `| ${m.graded ?? '?'}/${m.planted ?? '?'} | ${m.disposableRight ?? '?'}/${m.disposableTotal ?? '?'} `
      + `| ${crit}c, ${r.issues?.length ?? 0}t |`);
  }
  const allIssues = allResults.flatMap((r) => r.issues?.map((i) => ({ ...i, repo: r.name })) ?? []);
  if (allIssues.length) { console.log(`\n  ISSUES (${allIssues.length}):`); for (const i of allIssues) console.log(`  [${i.severity}] ${i.repo}/${i.phase}: ${i.msg}`); }
  // "NO ISSUES FOUND" IS A CLAIM ABOUT SOMETHING THAT WAS GRADED. Printing it for a run in which
  // nothing was graded is the exact sentence this harness produced against thirty missing
  // worktrees, and it is what put wrong numbers in BENCHMARKS.md.
  else if (allResults.every((r) => (r.metrics?.graded ?? 0) > 0)) console.log('\n  ✓ NO ISSUES FOUND');
  else console.log('\n  ✗ NOTHING WAS GRADED — this run measured nothing and proves nothing');
  await fs.mkdir(WORK, { recursive: true });
  await fs.writeFile(path.join(WORK, 'enterprise-bench-results.json'), JSON.stringify(allResults, null, 2));
  const ungraded = allResults.some((r) => (r.metrics?.graded ?? 0) === 0);
  process.exitCode = (allIssues.filter((i) => i.severity === 'critical').length > 0 || ungraded) ? 1 : 0;
}

// pathToFileURL, not a raw comparison: on Windows argv[1] is a backslash path with no scheme, and
// a path with a space percent-encodes, so the naive forms of this guard are silently inert — and
// an inert guard here means `main()` runs on import and the tests below can never load the
// functions they grade. Same class as the entry guards in scripts/.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
