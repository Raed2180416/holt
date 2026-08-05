#!/usr/bin/env node
// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — the enterprise-scale benchmark.
 *
 * Tests holt against REAL repositories at scale, with messy worktrees, noise, and
 * full command verification. See BENCHMARKS.md for results.
 *
 * Usage:
 *   node eval/enterprise-bench.mjs [repo-name] [--worktrees N] [--noise-level L]
 *     [--runs N] [--warmups N] [--work DIR] [--out FILE] [--keep]
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
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discover } from '../src/discover.mjs';
import { scan } from '../src/scan.mjs';
import { analyze } from '../src/analyze.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = path.resolve(HERE, '..');
// Git for Windows is an MSYS program and accepts /dev/null. The benchmark controller owns no
// deadline; only the outer operator may cancel a slow run.
const NULL_DEVICE = '/dev/null';
const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const WORK = path.resolve(argValue('work', process.env.HOLT_ENTERPRISE_BENCH_WORK
  ?? path.join(os.homedir(), '.cache', 'holt-enterprise-benchmark')));
const CACHE = path.join(WORK, 'cache');
const HOLT_BIN = path.resolve(path.join(import.meta.dirname, '..', 'bin/holt.mjs'));
const OUT = path.resolve(argValue('out', path.join(
  os.homedir(), '.cache', 'holt-benchmark-evidence', `enterprise-${stamp}.json`,
)));
const KEEP = args.includes('--keep');
const WORK_MARKER = '.holt-enterprise-benchmark-sandbox';
const WORK_MARKER_BODY = 'holt enterprise benchmark scratch v2\n';

export function localRepoPath(env = process.env, moduleDir = import.meta.dirname) {
  return path.resolve(env.HOLT_SELF_REPO || path.join(moduleDir, '..'));
}

export const REPOS = {
  'holt-self': {
    url: null, local: localRepoPath(),
    desc: 'holt itself — 20K lines, the dogfooding case',
  },
  'redis': {
    url: 'https://github.com/redis/redis.git',
    commit: 'bf49481ad7cf93d136e7520d321448d9ef65b03a',
    desc: 'Redis — ~1,858 C files, the benchmark from BENCHMARKS.md',
  },
  'postgres': {
    url: 'https://github.com/postgres/postgres.git',
    commit: '589eb4c3b309f5eaa7c16592ff4edbbf780671fe',
    desc: 'PostgreSQL — large C codebase, diverse file types',
  },
};

let repoName = 'holt-self';
let worktreeCount = 50;
let noiseLevel = 1;
let runs = 3;
let warmups = Number(argValue('warmups', 1));
let listOnly = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--worktrees') worktreeCount = Number(args[++i]);
  else if (args[i] === '--noise-level') noiseLevel = Number(args[++i]);
  else if (args[i] === '--runs') runs = Number(args[++i]);
  else if (args[i] === '--warmups') i++;
  else if (args[i] === '--work' || args[i] === '--out') i++;
  else if (args[i] === '--keep') { /* parsed above */ }
  else if (args[i] === '--all') repoName = 'all';
  else if (args[i] === '--list') listOnly = true;
  else if (!args[i].startsWith('-')) repoName = args[i];
}

function sh(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      cwd, maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, GIT_AUTHOR_NAME: 'bench', GIT_AUTHOR_EMAIL: 'b@b',
        GIT_COMMITTER_NAME: 'bench', GIT_COMMITTER_EMAIL: 'b@b',
        GIT_CONFIG_GLOBAL: NULL_DEVICE, GIT_CONFIG_SYSTEM: NULL_DEVICE,
        GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.slice(0, 5).join(' ')}: ${stderr || err.message}`));
      else resolve(String(stdout));
    });
  });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}

async function canonicalFuturePath(target) {
  let ancestor = path.resolve(target);
  const tail = [];
  while (true) {
    try {
      const real = await fs.realpath(ancestor);
      return path.resolve(real, ...tail.reverse());
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      tail.push(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

async function assertFreshEvidencePath(out = OUT) {
  for (const candidate of [out, `${out}.sha256`]) {
    if (await fs.lstat(candidate).then(() => true, () => false)) {
      throw new Error(`refusing to overwrite existing benchmark evidence: ${candidate}`);
    }
  }
}

/** A run may recursively replace only this exact marker-owned scratch root. */
export async function prepareEnterpriseScratch(root = WORK, out = OUT) {
  const resolved = path.resolve(root);
  const st = await fs.lstat(resolved).catch(() => null);
  if (st?.isSymbolicLink()) throw new Error(`refusing symlink benchmark root: ${resolved}`);
  const [canonicalRoot, canonicalOut, canonicalHome, canonicalSource, canonicalCwd] = await Promise.all([
    canonicalFuturePath(resolved), canonicalFuturePath(out), canonicalFuturePath(os.homedir()),
    canonicalFuturePath(SOURCE_ROOT), canonicalFuturePath(process.cwd()),
  ]);
  const forbidden = new Set([
    path.parse(canonicalRoot).root, canonicalHome, canonicalSource, canonicalCwd,
  ]);
  const overlapsLiveTree = inside(canonicalRoot, canonicalSource) || inside(canonicalSource, canonicalRoot)
    || inside(canonicalRoot, canonicalCwd) || inside(canonicalCwd, canonicalRoot);
  if (forbidden.has(canonicalRoot) || overlapsLiveTree) {
    throw new Error(`refusing unsafe benchmark root: ${resolved}`);
  }
  if (inside(canonicalOut, canonicalRoot)) {
    throw new Error(`--out must be outside --work; cleanup would erase the only evidence (${out})`);
  }
  if (st) {
    if (!st.isDirectory()) throw new Error(`refusing non-directory benchmark root: ${resolved}`);
    const marker = await fs.readFile(path.join(resolved, WORK_MARKER), 'utf8').catch(() => null);
    if (marker !== WORK_MARKER_BODY) {
      throw new Error(`refusing to replace ${resolved}: it lacks Holt's exact ${WORK_MARKER} ownership marker`);
    }
    await fs.rm(resolved, { recursive: true, force: true });
  }
  await fs.mkdir(resolved, { recursive: true });
  await fs.writeFile(path.join(resolved, WORK_MARKER), WORK_MARKER_BODY, { encoding: 'utf8', flag: 'wx' });
}

async function cleanEnterpriseScratch(root = WORK) {
  if (KEEP) return;
  const marker = await fs.readFile(path.join(root, WORK_MARKER), 'utf8').catch(() => null);
  if (marker !== WORK_MARKER_BODY) {
    throw new Error(`refusing cleanup: ${root} no longer has Holt's exact ownership marker`);
  }
  await fs.rm(root, { recursive: true, force: true });
}

async function commandVersion(cmd, argv = ['--version']) {
  return new Promise((resolve) => {
    execFile(cmd, argv, { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve(error
        ? { available: false, error: String(stderr || error.message).trim() }
        : { available: true, version: String(stdout || stderr).trim().split(/\r?\n/)[0] });
    });
  });
}

async function untrackedManifest(root) {
  const names = (await sh('git', ['ls-files', '--others', '--exclude-standard', '-z'], root))
    .split('\0').filter(Boolean).sort();
  const entries = [];
  for (const name of names) {
    const abs = path.join(root, name);
    const st = await fs.lstat(abs);
    let type = 'other'; let content = Buffer.alloc(0);
    if (st.isFile()) { type = 'file'; content = await fs.readFile(abs); }
    else if (st.isSymbolicLink()) { type = 'symlink'; content = Buffer.from(await fs.readlink(abs)); }
    else if (st.isDirectory()) type = 'directory';
    entries.push({
      path: name, type, mode: (st.mode & 0o777777).toString(8), size: st.size,
      sha256: sha256(content),
    });
  }
  return entries;
}

async function sourceState() {
  const [commit, status, diff, untracked] = await Promise.all([
    sh('git', ['rev-parse', '--verify', 'HEAD^{commit}'], SOURCE_ROOT).then((s) => s.trim()),
    sh('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], SOURCE_ROOT),
    sh('git', ['diff', '--binary', '--no-ext-diff', 'HEAD', '--', '.'], SOURCE_ROOT),
    untrackedManifest(SOURCE_ROOT),
  ]);
  const dirtyState = {
    statusSha256: sha256(status),
    trackedDiffSha256: sha256(diff),
    untracked,
  };
  return {
    commit,
    dirty: status.length > 0,
    dirtyStateSha256: sha256(JSON.stringify(dirtyState)),
    dirtyState,
  };
}

async function runtimeMetadata() {
  const cpus = os.cpus();
  const [git, ctags, enry, jj, holt] = await Promise.all([
    commandVersion('git'), commandVersion('ctags'), commandVersion('enry'), commandVersion('jj'),
    commandVersion(process.execPath, [HOLT_BIN, '--version']),
  ]);
  return {
    platform: process.platform,
    arch: process.arch,
    os: { type: os.type(), release: os.release(), version: os.version(), kernel: `${os.type()} ${os.release()}` },
    cpu: { logicalCount: cpus.length, models: [...new Set(cpus.map((cpu) => cpu.model))], speedsMHz: cpus.map((cpu) => cpu.speed) },
    memory: { totalBytes: os.totalmem(), freeBytesAtStart: os.freemem() },
    node: { version: process.version, execPath: process.execPath, versions: process.versions },
    tools: { git, ctags, enry, jj, holt },
    loadAverageAtStart: os.loadavg(),
  };
}

async function writeEvidence(evidence, out = OUT) {
  await fs.mkdir(path.dirname(out), { recursive: true });
  const encoded = `${JSON.stringify(evidence, null, 2)}\n`;
  await fs.writeFile(out, encoded, { encoding: 'utf8', flag: 'wx' });
  const digest = sha256(encoded);
  await fs.writeFile(`${out}.sha256`, `${digest}  ${path.basename(out)}\n`, { encoding: 'utf8', flag: 'wx' });
  return digest;
}

/**
 * Sample RSS WHILE the work runs. The previous version read process.memoryUsage() once, after the
 * pipeline had returned, and published it as "peak RSS" — a number taken at the one moment the
 * peak is guaranteed to be over. V8 does not return memory to the OS promptly, so the reading was
 * not nonsense, but it was not a peak either, and it could not see a spike that had already been
 * collected.
 */
function rssSampler(everyMs = 25) {
  // MEASURE THE PIPELINE, NOT THE HARNESS THAT IS HOLDING ITS RESULTS.
  //
  // This used to publish the bench process's absolute peak RSS as holt's memory cost, and the
  // bench retains a full report per run plus every fixture map it built. Measured on redis with
  // 31 worktrees: absolute peak 63 MB, of which the pipeline accounts for ELEVEN. The published
  // figure was 222 MB. Almost all of it was the harness's own bookkeeping, attributed to the
  // product — a benchmark defaming the thing it exists to measure.
  //
  // Both numbers are now reported. The delta is holt's cost and is the honest headline; the
  // absolute is kept beside it so nobody has to trust the subtraction.
  if (global.gc) { try { global.gc(); global.gc(); } catch { /* --expose-gc not on */ } }
  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  const t = setInterval(() => {
    const r = process.memoryUsage().rss;
    if (r > peak) peak = r;
  }, everyMs);
  if (typeof t.unref === 'function') t.unref();
  return {
    stop: () => {
      clearInterval(t);
      return {
        peakMB: Math.round(peak / 1024 / 1024),
        baselineMB: Math.round(baseline / 1024 / 1024),
        pipelineMB: Math.max(0, Math.round((peak - baseline) / 1024 / 1024)),
      };
    },
  };
}
async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

/** p-th percentile of a numeric sample, nearest-rank. Small n, so no interpolation games. */
export function percentile(xs, p) {
  const s = [...xs].filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

/** Keep missing measurements visible instead of silently filtering them out of a denominator. */
export function sampleStats(values, expected = values.length) {
  const numeric = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  return {
    expected,
    observed: values.length,
    numeric: numeric.length,
    missing: values.length - numeric.length,
    min: percentile(numeric, 0),
    p50: percentile(numeric, 50),
    p90: percentile(numeric, 90),
    p99: percentile(numeric, 99),
    max: percentile(numeric, 100),
    mean: numeric.length ? numeric.reduce((sum, value) => sum + value, 0) / numeric.length : null,
  };
}

/**
 * Materialize one exact source commit. Remote repositories are never cloned from a moving HEAD:
 * the requested 40-hex commit is fetched directly, checked out detached, and verified again.
 */
async function prepareCache(name, spec) {
  const expectedCommit = spec.local
    ? (await sh('git', ['rev-parse', '--verify', 'HEAD^{commit}'], spec.local)).trim()
    : spec.commit;
  if (!/^[0-9a-f]{40}$/.test(expectedCommit ?? '')) {
    throw new Error(`${name}: benchmark fixture requires an exact 40-hex commit, got ${expectedCommit ?? '<none>'}`);
  }
  const cacheDir = path.join(CACHE, `${name}-${expectedCommit}`);
  if (await exists(path.join(cacheDir, '.git'))) {
    const actual = (await sh('git', ['rev-parse', '--verify', 'HEAD^{commit}'], cacheDir)).trim();
    if (actual !== expectedCommit) {
      throw new Error(`${name}: cached fixture drifted: expected ${expectedCommit}, got ${actual}`);
    }
    console.log(`  using exact cached clone: ${cacheDir} @ ${expectedCommit}`);
    return { cacheDir, requestedCommit: expectedCommit, verifiedCommit: actual };
  }
  await fs.mkdir(CACHE, { recursive: true });
  if (spec.local) {
    console.log(`  cloning local repo ${spec.local} at ${expectedCommit}...`);
    await sh('git', ['clone', '--no-hardlinks', '--no-checkout', spec.local, cacheDir], CACHE);
    await sh('git', ['checkout', '--detach', expectedCommit], cacheDir);
  } else {
    console.log(`  fetching ${name} at pinned commit ${expectedCommit} from ${spec.url}...`);
    const t0 = Date.now();
    await fs.mkdir(cacheDir);
    await sh('git', ['init', '-q', '.'], cacheDir);
    await sh('git', ['remote', 'add', 'origin', spec.url], cacheDir);
    await sh('git', ['fetch', '--depth', '1', 'origin', expectedCommit], cacheDir);
    await sh('git', ['checkout', '--detach', expectedCommit], cacheDir);
    console.log(`  exact fetch took ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  const actual = (await sh('git', ['rev-parse', '--verify', 'HEAD^{commit}'], cacheDir)).trim();
  if (actual !== expectedCommit) {
    throw new Error(`${name}: fixture checkout drifted: expected ${expectedCommit}, got ${actual}`);
  }
  return { cacheDir, requestedCommit: expectedCommit, verifiedCommit: actual };
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
async function freshWorkingCopy(cache, tag) {
  const dest = path.join(WORK, `run-${tag}`);
  if (!inside(dest, WORK)) throw new Error(`refusing run path outside marked scratch root: ${dest}`);
  if (await exists(dest)) throw new Error(`refusing to replace unexpected existing run path: ${dest}`);
  await fs.mkdir(WORK, { recursive: true });
  await sh('git', ['clone', '--local', '--no-hardlinks', cache.cacheDir, dest], WORK);
  const actual = (await sh('git', ['rev-parse', '--verify', 'HEAD^{commit}'], dest)).trim();
  if (actual !== cache.verifiedCommit) {
    throw new Error(`working copy drifted: expected ${cache.verifiedCommit}, got ${actual}`);
  }
  // The bench commits to this copy; give it an identity that does not depend on the machine.
  await sh('git', ['config', 'user.email', 'bench@holt.invalid'], dest);
  await sh('git', ['config', 'user.name', 'holt bench'], dest);
  return dest;
}

async function createWorktrees(root, count, noise, tag = 'current') {
  const wtRoot = path.join(WORK, 'worktrees', tag);
  if (!inside(wtRoot, WORK)) throw new Error(`refusing worktree path outside marked scratch root: ${wtRoot}`);
  if (await exists(wtRoot)) throw new Error(`refusing to replace unexpected worktree path: ${wtRoot}`);
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
  try { disc = await discover(root); } catch (e) { results.errors.push(`discover: ${e.message}`); Object.assign(results, { mem: rss.stop() }); return results; }
  results.phases.discover = Date.now() - t0;
  // `workstreams`, not `worktrees`. discover() has never had a `worktrees` field, so this read
  // `undefined?.length ?? 0` and the published column was 0 in every row this harness ever
  // printed — including the rows that reached BENCHMARKS.md.
  results.workstreamCount = disc.workstreams?.length ?? 0;
  if (!Number.isInteger(results.workstreamCount) || results.workstreamCount === 0) {
    results.errors.push('discover returned no workstreams — the fixture did not build, so nothing below is a measurement');
    results.mem = rss.stop();
    return results;
  }
  const t1 = Date.now();
  let scanned;
  try { scanned = await scan(disc, {}); } catch (e) { results.errors.push(`scan: ${e.message}`); results.phases.scan = Date.now() - t1; Object.assign(results, { mem: rss.stop() }); return results; }
  results.phases.scan = Date.now() - t1;
  const t2 = Date.now();
  let report;
  try { report = await analyze(scanned, {}); } catch (e) { results.errors.push(`analyze: ${e.message}`); results.phases.analyze = Date.now() - t2; Object.assign(results, { mem: rss.stop() }); return results; }
  results.phases.analyze = Date.now() - t2;
  results.total = Date.now() - t0;
  results.mem = rss.stop();
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
  const graphArtifact = path.join(WORK, 'graph-test.html');
  const commands = [
    ['status', ['status', '--json']],
    ['risk', ['risk', '--json']],
    ['collisions', ['collisions', '--json']],
    ['graph', ['graph', '--html', graphArtifact]],
    ['clean', ['clean']],
    ['doctor', ['doctor']],
    ['stash', ['stash', '--json']],
  ];
  for (const [name, cmd] of commands) {
    const t0 = Date.now();
    try {
      const commandOutput = await new Promise((resolve, reject) => {
        execFile(process.execPath, [HOLT_BIN, ...cmd], {
          cwd: root, maxBuffer: 256 * 1024 * 1024,
          env: { ...process.env, HOME: os.homedir() },
        }, (err, stdout, stderr) => { if (err) reject({ err, stderr, stdout }); else resolve({ stdout, stderr }); });
      });
      results[name] = {
        ok: true, ms: Date.now() - t0,
        stdoutLen: commandOutput.stdout.length, stderrLen: commandOutput.stderr.length,
        stdout: commandOutput.stdout, stderr: commandOutput.stderr,
      };
      if (cmd.includes('--json')) {
        try {
          const parsed = JSON.parse(commandOutput.stdout);
          results[name].validJson = true;
          results[name].jsonTopLevelType = Array.isArray(parsed) ? 'array' : typeof parsed;
        } catch {
          results[name].validJson = false;
          results[name].error = 'invalid JSON';
        }
      }
      if (name === 'graph') {
        const html = await fs.readFile(graphArtifact, 'utf8');
        if (!/<html[\s>]/i.test(html)) throw new Error('graph command exited zero but produced no HTML document');
        results[name].artifact = { path: graphArtifact, bytes: Buffer.byteLength(html), sha256: sha256(html) };
      }
    } catch (e) {
      results[name] = {
        ok: false, ms: Date.now() - t0, error: e.err?.message || e.message,
        stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? ''), exitCode: e.err?.code,
      };
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
  const observations = [];
  const rows = report?.safe ?? [];
  const find = (id) => rows.find((x) => x.id === id || x.id?.endsWith(id));

  // ANTI-VACUITY, FIRST: if holt reported on nothing, say so once and loudly rather than
  // reporting four categories of silence as four categories of correctness.
  const protectedBuckets = ['atRisk', 'hold', 'gitignored', 'binary', 'huge'];
  const planted_all = [
    ...protectedBuckets.flatMap((bucket) => planted[bucket] ?? []),
    ...(planted.disposable ?? []),
  ];
  const missing = planted_all.filter((id) => !find(id));
  if (missing.length) {
    errors.push(
      `${missing.length} of ${planted_all.length} planted workstream(s) do not appear in holt's report at all `
      + `(e.g. ${missing.slice(0, 3).join(', ')}) — an ungraded workstream is not a correct one`);
  }

  const graded = Object.fromEntries([...protectedBuckets, 'disposable'].map((bucket) => [bucket, 0]));
  for (const [bucket, why] of [
    ['atRisk', 'has uncommitted-only content'],
    ['hold', 'has committed-ahead content'],
    ['gitignored', 'has gitignored-only content'],
    ['binary', 'has uncommitted binary content'],
    ['huge', 'has uncommitted large-file content'],
  ]) {
    for (const id of planted[bucket] ?? []) {
      const s = find(id);
      observations.push({
        id, expected: bucket, found: !!s, observedSafe: s ? !!s.safe : null,
        reasons: s?.reasons ?? [],
      });
      if (!s) continue;                    // already counted in `missing` above
      graded[bucket]++;
      if (s.safe) errors.push(`${bucket} ${id}: called SAFE but ${why}`);
    }
  }

  let disposableRight = 0;
  for (const id of planted.disposable ?? []) {
    const s = find(id);
    observations.push({
      id, expected: 'disposable', found: !!s, observedSafe: s ? !!s.safe : null,
      reasons: s?.reasons ?? [],
    });
    if (!s) continue;
    graded.disposable++;
    if (s.safe) disposableRight++;
    else errors.push(`disposable ${id}: not called safe (${(s.reasons ?? []).join('; ') || 'no reason given'})`);
  }

  return {
    errors,
    warnings,
    observations,
    disposableRight,
    // Denominators over what was actually GRADED, so a rate can never be inflated by workstreams
    // that were never seen. `plantedTotal` is kept beside it so the gap is visible rather than
    // divided away.
    disposableTotal: graded.disposable,
    disposablePlanted: planted.disposable?.length ?? 0,
    graded,
    plantedTotal: planted_all.length,
    gradedTotal: Object.values(graded).reduce((a, b) => a + b, 0),
  };
}

async function removeRunFixture(root, wtRoot) {
  if (KEEP) return;
  if (wtRoot) {
    if (!inside(wtRoot, WORK)) throw new Error(`refusing cleanup outside marked scratch root: ${wtRoot}`);
    await fs.rm(wtRoot, { recursive: true, force: true });
  }
  if (root) {
    if (!inside(root, WORK)) throw new Error(`refusing cleanup outside marked scratch root: ${root}`);
    await sh('git', ['worktree', 'prune'], root).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function benchmarkRepo(name, spec) {
  console.log(`\n${'═'.repeat(70)}\n  REPO: ${name} — ${spec.desc}\n  worktrees: ${worktreeCount}, noise: ${noiseLevel}\n${'═'.repeat(70)}\n`);
  const issues = [];
  const samples = [];
  console.log('  [1/5] Preparing exact repository revision...');
  let cache;
  try { cache = await prepareCache(name, spec); }
  catch (error) {
    issues.push({ phase: 'fixture-source', severity: 'critical', msg: error.message });
    return {
      name, ok: false, error: `prepare: ${error.message}`, issues, samples,
      fixtureSource: { url: spec.url, requestedCommit: spec.commit ?? null, verifiedCommit: null },
      denominators: { expectedWarmups: warmups, observedWarmups: 0, expectedMeasured: runs, observedMeasured: 0 },
    };
  }

  let lastRoot = null; let lastWtRoot = null; let fileCount = null;
  const totalAttempts = warmups + runs;
  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    const warmup = attempt < warmups;
    let root = null; let wtInfo = null;
    const sample = {
      index: attempt,
      warmup,
      fixture: {
        requestedCommit: cache.requestedCommit,
        verifiedCommit: cache.verifiedCommit,
        worktreesRequested: worktreeCount,
        noiseLevel,
        createMs: null,
        planted: null,
        failures: [],
      },
      pipeline: null,
      correctness: null,
      valid: false,
      fatalError: null,
    };
    try {
      root = await freshWorkingCopy(cache, `${name}-${attempt}`);
      lastRoot = root;
      if (fileCount === null) {
        fileCount = (await sh('git', ['ls-files', '--', '.'], root)).split('\n').filter(Boolean).length;
        console.log(`  tracked files: ${fileCount}`);
      }
      if (attempt === 0) console.log(`  [2/5] Creating fixtures (${warmups} warmup, ${runs} measured; none discarded)...`);
      const t0 = Date.now();
      wtInfo = await createWorktrees(root, worktreeCount, noiseLevel, `${name}-${attempt}`);
      lastWtRoot = wtInfo.wtRoot;
      sample.fixture.createMs = Date.now() - t0;
      sample.fixture.planted = wtInfo.planted;
      sample.fixture.failures = wtInfo.failures ?? [];
      for (const failure of sample.fixture.failures) {
        issues.push({ sample: attempt, warmup, phase: 'fixture', severity: 'critical', msg: failure });
      }

      if (attempt === 0) console.log('  [3/5] Running holt pipeline and grading every planted case...');
      const pipe = await runPipeline(root);
      const verify = verifyCorrectness(pipe.report, wtInfo.planted);
      const { report: _report, ...rawPipeline } = pipe;
      sample.pipeline = rawPipeline;
      sample.correctness = verify;
      for (const error of pipe.errors ?? []) {
        issues.push({ sample: attempt, warmup, phase: 'pipeline', severity: 'critical', msg: error });
      }
      if ((pipe.skippedCount ?? 0) > 0) {
        issues.push({
          sample: attempt, warmup, phase: 'pipeline', severity: 'critical',
          msg: `${pipe.skippedCount} workstream(s) skipped — a partial scan is not benchmark evidence`,
        });
      }
      for (const error of verify.errors) {
        issues.push({ sample: attempt, warmup, phase: 'correctness', severity: 'critical', msg: error });
      }
      for (const warning of verify.warnings) {
        issues.push({ sample: attempt, warmup, phase: 'correctness', severity: 'critical', msg: warning });
      }
      sample.valid = sample.fixture.failures.length === 0
        && (pipe.errors?.length ?? 0) === 0
        && (pipe.skippedCount ?? 0) === 0
        && verify.errors.length === 0
        && verify.warnings.length === 0
        && verify.gradedTotal === verify.plantedTotal;
    } catch (error) {
      sample.fatalError = { message: error?.message ?? String(error), stack: error?.stack ?? null };
      issues.push({ sample: attempt, warmup, phase: 'harness', severity: 'critical', msg: sample.fatalError.message });
    }
    samples.push(sample);

    if (attempt < totalAttempts - 1) {
      try {
        await removeRunFixture(root, wtInfo?.wtRoot);
        if (!KEEP) { lastRoot = null; lastWtRoot = null; }
      } catch (error) {
        sample.valid = false;
        issues.push({
          sample: attempt, warmup, phase: 'fixture-cleanup', severity: 'critical',
          msg: error?.message ?? String(error),
        });
      }
    }
  }

  const measured = samples.filter((sample) => !sample.warmup);
  const warmupSamples = samples.filter((sample) => sample.warmup);
  const value = (sample, selector) => selector(sample);
  const dist = {
    warmupTotalMs: sampleStats(warmupSamples.map((sample) => value(sample, (s) => s.pipeline?.total)), warmups),
    totalMs: sampleStats(measured.map((sample) => value(sample, (s) => s.pipeline?.total)), runs),
    discoverMs: sampleStats(measured.map((sample) => value(sample, (s) => s.pipeline?.phases?.discover)), runs),
    scanMs: sampleStats(measured.map((sample) => value(sample, (s) => s.pipeline?.phases?.scan)), runs),
    analyzeMs: sampleStats(measured.map((sample) => value(sample, (s) => s.pipeline?.phases?.analyze)), runs),
    pipelineRssMB: sampleStats(measured.map((sample) => value(sample, (s) => s.pipeline?.mem?.pipelineMB)), runs),
    processRssMB: sampleStats(measured.map((sample) => value(sample, (s) => s.pipeline?.mem?.peakMB)), runs),
  };
  const denominators = {
    expectedWarmups: warmups,
    observedWarmups: warmupSamples.length,
    validWarmups: warmupSamples.filter((sample) => sample.valid).length,
    expectedMeasured: runs,
    observedMeasured: measured.length,
    validMeasured: measured.filter((sample) => sample.valid).length,
    planted: samples.reduce((sum, sample) => sum + (sample.correctness?.plantedTotal ?? 0), 0),
    graded: samples.reduce((sum, sample) => sum + (sample.correctness?.gradedTotal ?? 0), 0),
    correctnessFailures: issues.filter((issue) => issue.severity === 'critical').length,
  };

  console.log(`  warmup total samples ${JSON.stringify(warmupSamples.map((sample) => sample.pipeline?.total ?? null))}`);
  console.log(`  measured total p50 ${dist.totalMs.p50 ?? '?'}ms p90 ${dist.totalMs.p90 ?? '?'}ms `
    + `(n=${dist.totalMs.numeric}/${runs}, ${JSON.stringify(measured.map((sample) => sample.pipeline?.total ?? null))})`);
  console.log(`  scan p50 ${dist.scanMs.p50 ?? '?'}ms p90 ${dist.scanMs.p90 ?? '?'}ms`);
  console.log(`  memory: pipeline p50 ${dist.pipelineRssMB.p50 ?? '?'}MB; process p50 ${dist.processRssMB.p50 ?? '?'}MB`);
  console.log(`  graded ${denominators.graded}/${denominators.planted} planted verdicts across every raw sample`);

  console.log('  [4/5] Correctness failures are retained beside their samples...');
  for (const issue of issues) console.log(`  ✗ [sample ${issue.sample ?? '-'}] ${issue.phase}: ${issue.msg}`);

  console.log('  [5/5] Testing commands on the final measured fixture...');
  let commands;
  if (lastRoot) {
    commands = await testCommands(lastRoot);
    for (const [commandName, result] of Object.entries(commands)) {
      if (!result.ok) {
        issues.push({ phase: 'command', severity: 'critical', cmd: commandName, msg: result.error });
        console.log(`  ✗ holt ${commandName}: ${result.error}`);
      } else if (result.validJson === false) {
        issues.push({ phase: 'command', severity: 'critical', cmd: commandName, msg: 'invalid JSON' });
        console.log(`  ✗ holt ${commandName}: invalid JSON`);
      } else {
        console.log(`  ✓ holt ${commandName}: ${result.ms}ms${result.validJson ? ', valid JSON' : ''}`);
      }
    }
  } else {
    commands = { skipped: true, reason: 'no final measured fixture survived' };
    issues.push({ phase: 'command', severity: 'critical', msg: commands.reason });
  }

  try {
    await removeRunFixture(lastRoot, lastWtRoot);
  } catch (error) {
    issues.push({ phase: 'fixture-cleanup', severity: 'critical', msg: error?.message ?? String(error) });
  }
  denominators.correctnessFailures = issues.filter((issue) => issue.severity === 'critical').length;
  const ok = issues.every((issue) => issue.severity !== 'critical')
    && denominators.observedWarmups === warmups
    && denominators.validWarmups === warmups
    && denominators.observedMeasured === runs
    && denominators.validMeasured === runs
    && denominators.graded === denominators.planted;
  const lastMeasured = measured.at(-1);
  const verify = lastMeasured?.correctness ?? {};
  const pipe = lastMeasured?.pipeline ?? { phases: {} };
  return {
    name,
    ok,
    fixtureSource: { url: spec.url, ...cache },
    issues,
    trackedFiles: fileCount,
    protocol: { warmups, measuredRuns: runs, worktrees: worktreeCount, noiseLevel },
    denominators,
    samples,
    commands,
    dist,
    metrics: {
      total: dist.totalMs.p50, totalP90: dist.totalMs.p90,
      warmupTotal: dist.warmupTotalMs.p50,
      discover: dist.discoverMs.p50, scan: dist.scanMs.p50, scanP90: dist.scanMs.p90,
      analyze: dist.analyzeMs.p50,
      peakRSS: dist.pipelineRssMB.p50, peakRSSMax: dist.pipelineRssMB.max,
      processRSS: dist.processRssMB.p50,
      workstreams: pipe.workstreamCount, collisions: pipe.collisions, duplicates: pipe.duplicates,
      safe: pipe.safeCount, atRisk: pipe.atRiskCount, skipped: pipe.skippedCount,
      disposableRight: verify.disposableRight, disposableTotal: verify.disposableTotal,
      graded: verify.gradedTotal, planted: verify.plantedTotal,
    },
  };
}

async function main() {
  if (listOnly) {
    console.log('Available repos:', Object.entries(REPOS)
      .map(([name, spec]) => `${name}${spec.commit ? `@${spec.commit}` : '@local-HEAD'}`).join(', '));
    return;
  }
  if (!Number.isInteger(worktreeCount) || worktreeCount < 1) throw new Error('--worktrees must be an integer >= 1');
  if (!Number.isInteger(noiseLevel) || noiseLevel < 0 || noiseLevel > 2) throw new Error('--noise-level must be 0, 1, or 2');
  if (!Number.isInteger(runs) || runs < 2) {
    throw new Error('--runs must be an integer >= 2; a single-sample enterprise summary is not evidence');
  }
  if (!Number.isInteger(warmups) || warmups < 1) throw new Error('--warmups must be an integer >= 1');

  await assertFreshEvidencePath(OUT);
  await prepareEnterpriseScratch(WORK, OUT);
  let artifactWritten = false;
  const targets = repoName === 'all' ? Object.entries(REPOS) : [[repoName, REPOS[repoName]]];
  const evidence = {
    schemaVersion: 1,
    benchmark: 'holt-enterprise-real-repositories',
    generatedAt: new Date().toISOString(),
    command: { executable: process.execPath, argv: [fileURLToPath(import.meta.url), ...args], cwd: process.cwd() },
    protocol: {
      requestedRepositories: targets.map(([name]) => name),
      measuredRunsPerRepository: runs,
      warmupsPerRepository: warmups,
      worktreesPerRun: worktreeCount,
      noiseLevel,
    },
    source: { before: await sourceState(), after: null, stable: false },
    runtime: await runtimeMetadata(),
    repositories: [],
    correctnessFailures: [],
    summary: null,
    fatalError: null,
    valid: false,
  };

  console.log('╔════════════════════════════════════════════════════════════════════╗');
  console.log('║  holt enterprise benchmark — real repos, real mess, real scale    ║');
  console.log('╚════════════════════════════════════════════════════════════════════╝');
  console.log(`  date: ${new Date().toISOString()}`);
  console.log(`  platform: ${process.platform} ${process.arch}, Node ${process.version}`);
  for (const [name, spec] of targets) {
    if (!spec) {
      const failure = { phase: 'configuration', severity: 'critical', msg: `unknown repo: ${name}` };
      evidence.repositories.push({ name, ok: false, issues: [failure], samples: [], denominators: {
        expectedWarmups: warmups, observedWarmups: 0, expectedMeasured: runs, observedMeasured: 0,
      } });
      continue;
    }
    try {
      evidence.repositories.push(await benchmarkRepo(name, spec));
    } catch (error) {
      console.log(`  FATAL: ${error.message}`);
      evidence.repositories.push({
        name, ok: false, error: error.message,
        issues: [{ phase: 'harness', severity: 'critical', msg: error.message }],
        samples: [],
        denominators: { expectedWarmups: warmups, observedWarmups: 0, expectedMeasured: runs, observedMeasured: 0 },
      });
    }
  }
  console.log(`\n${'═'.repeat(70)}\n  SUMMARY\n${'═'.repeat(70)}\n`);
  console.log('  | repo | files | wt | total p50 | p90 | warmup p50 | scan p50 | holt RSS p50 | proc RSS | graded | disposable | issues |');
  console.log('  |---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of evidence.repositories) {
    const m = r.metrics || {};
    const crit = r.issues?.filter((i) => i.severity === 'critical').length ?? 0;
    console.log(
      `  | ${r.name} | ${r.trackedFiles ?? '?'} | ${m.workstreams ?? '?'} | ${m.total ?? '?'}ms | ${m.totalP90 ?? '?'}ms `
      + `| ${m.warmupTotal ?? '?'}ms | ${m.scan ?? '?'}ms | ${m.peakRSS ?? '?'}MB | ${m.processRSS ?? '?'}MB `
      + `| ${m.graded ?? '?'}/${m.planted ?? '?'} | ${m.disposableRight ?? '?'}/${m.disposableTotal ?? '?'} `
      + `| ${crit}c, ${r.issues?.length ?? 0}t |`);
  }
  evidence.source.after = await sourceState().catch((error) => ({ error: error?.message ?? String(error) }));
  evidence.source.stable = evidence.source.before.commit === evidence.source.after?.commit
    && evidence.source.before.dirtyStateSha256 === evidence.source.after?.dirtyStateSha256;
  const allIssues = evidence.repositories.flatMap((result) => result.issues?.map((issue) => ({
    ...issue, repo: result.name,
  })) ?? []);
  if (!evidence.source.stable) {
    allIssues.push({
      repo: 'holt-source', phase: 'source', severity: 'critical',
      msg: 'source commit or dirty-state hash changed while the benchmark ran',
    });
  }
  evidence.correctnessFailures = allIssues.filter((issue) => issue.severity === 'critical');
  evidence.summary = {
    expectedRepositories: targets.length,
    observedRepositories: evidence.repositories.length,
    validRepositories: evidence.repositories.filter((result) => result.ok).length,
    expectedWarmups: targets.length * warmups,
    observedWarmups: evidence.repositories.reduce((sum, result) => sum + (result.denominators?.observedWarmups ?? 0), 0),
    expectedMeasuredRuns: targets.length * runs,
    observedMeasuredRuns: evidence.repositories.reduce((sum, result) => sum + (result.denominators?.observedMeasured ?? 0), 0),
    plantedVerdicts: evidence.repositories.reduce((sum, result) => sum + (result.denominators?.planted ?? 0), 0),
    gradedVerdicts: evidence.repositories.reduce((sum, result) => sum + (result.denominators?.graded ?? 0), 0),
    correctnessFailures: evidence.correctnessFailures.length,
  };
  if (allIssues.length) { console.log(`\n  ISSUES (${allIssues.length}):`); for (const i of allIssues) console.log(`  [${i.severity}] ${i.repo}/${i.phase}: ${i.msg}`); }
  // "NO ISSUES FOUND" IS A CLAIM ABOUT SOMETHING THAT WAS GRADED. Printing it for a run in which
  // nothing was graded is the exact sentence this harness produced against thirty missing
  // worktrees, and it is what put wrong numbers in BENCHMARKS.md.
  else if (evidence.repositories.every((r) => (r.metrics?.graded ?? 0) > 0)) console.log('\n  ✓ NO ISSUES FOUND');
  else console.log('\n  ✗ NOTHING WAS GRADED — this run measured nothing and proves nothing');
  evidence.runtime.loadAverageAtEnd = os.loadavg();
  evidence.valid = evidence.source.stable
    && evidence.repositories.length === targets.length
    && evidence.repositories.every((result) => result.ok)
    && evidence.summary.observedWarmups === evidence.summary.expectedWarmups
    && evidence.summary.observedMeasuredRuns === evidence.summary.expectedMeasuredRuns
    && evidence.summary.gradedVerdicts === evidence.summary.plantedVerdicts
    && evidence.correctnessFailures.length === 0;

  try {
    const digest = await writeEvidence(evidence, OUT);
    artifactWritten = true;
    console.log(`\n  raw evidence  ${OUT}`);
    console.log(`  sha256       ${digest}`);
  } finally {
    // A failed artifact write leaves the marked scratch tree intact. Deleting it at that point
    // could erase the only surviving diagnostic state from an interrupted run.
    if (artifactWritten) await cleanEnterpriseScratch(WORK);
  }
  if (!evidence.valid) process.exitCode = 1;
}

// pathToFileURL, not a raw comparison: on Windows argv[1] is a backslash path with no scheme, and
// a path with a space percent-encodes, so the naive forms of this guard are silently inert — and
// an inert guard here means `main()` runs on import and the tests below can never load the
// functions they grade. Same class as the entry guards in scripts/.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
