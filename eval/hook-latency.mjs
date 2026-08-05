#!/usr/bin/env node
// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — what the guard costs an agent, per tool call.
 *
 * Four regimes are measured because the cheap allow path and the destructive scan path answer
 * different questions. Every warmup and measured call is retained in the evidence artifact,
 * together with the verdict contract it was required to satisfy. A fast wrong answer is an
 * invalid benchmark, never a latency win.
 *
 * Usage:
 *   node eval/hook-latency.mjs [worktrees=12] [calls=12]
 *     [--warmups 2] [--work DIR] [--out FILE] [--keep]
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = path.resolve(HERE, '..');
const HOLT = path.join(SOURCE_ROOT, 'bin', 'holt.mjs');
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
const ARGS = process.argv.slice(2);
const valueAfter = (flag, fallback) => {
  const at = ARGS.indexOf(flag);
  return at === -1 ? fallback : ARGS[at + 1];
};
const positionals = ARGS.filter((arg, i) => /^\d+$/.test(arg)
  && !['--warmups', '--work', '--out'].includes(ARGS[i - 1]));
const N_WT = Number(positionals[0] ?? 12);
const N_CALLS = Number(positionals[1] ?? 12);
const N_WARMUPS = Number(valueAfter('--warmups', 2));
const KEEP = ARGS.includes('--keep');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const WORK = path.resolve(valueAfter('--work', process.env.HOLT_HOOK_BENCH_WORK
  ?? path.join(os.homedir(), '.cache', 'holt-hook-benchmark')));
const OUT = path.resolve(valueAfter('--out', path.join(
  os.homedir(), '.cache', 'holt-benchmark-evidence', `hook-latency-${stamp}.json`,
)));
const MARKER = '.holt-hook-benchmark-sandbox';
const MARKER_BODY = 'holt hook latency benchmark scratch v2\n';

function gitEnv() {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: 'holt benchmark',
    GIT_AUTHOR_EMAIL: 'bench@holt.invalid',
    GIT_COMMITTER_NAME: 'holt benchmark',
    GIT_COMMITTER_EMAIL: 'bench@holt.invalid',
    GIT_CONFIG_GLOBAL: NULL_DEVICE,
    GIT_CONFIG_SYSTEM: NULL_DEVICE,
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  };
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

async function assertFreshEvidencePath(out) {
  for (const candidate of [out, `${out}.sha256`]) {
    const present = await fs.lstat(candidate).then(() => true, () => false);
    if (present) throw new Error(`refusing to overwrite existing benchmark evidence: ${candidate}`);
  }
}

/** Prepare only a marker-owned scratch root; an unmarked pre-existing directory is untouchable. */
export async function prepareHookScratch(root = WORK, out = OUT) {
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
    const marker = await fs.readFile(path.join(resolved, MARKER), 'utf8').catch(() => null);
    if (marker !== MARKER_BODY) {
      throw new Error(`refusing to replace ${resolved}: it lacks Holt's exact ${MARKER} ownership marker`);
    }
    await fs.rm(resolved, { recursive: true, force: true });
  }
  await fs.mkdir(resolved, { recursive: true });
  await fs.writeFile(path.join(resolved, MARKER), MARKER_BODY, { encoding: 'utf8', flag: 'wx' });
}

async function cleanHookScratch(root = WORK) {
  if (KEEP) return;
  const marker = await fs.readFile(path.join(root, MARKER), 'utf8').catch(() => null);
  if (marker !== MARKER_BODY) {
    throw new Error(`refusing cleanup: ${root} no longer has Holt's exact ownership marker`);
  }
  await fs.rm(root, { recursive: true, force: true });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function commandVersion(cmd, args = ['--version']) {
  try {
    const { stdout, stderr } = await run(cmd, args, { maxBuffer: 1024 * 1024 });
    return { available: true, version: String(stdout || stderr).trim().split(/\r?\n/)[0] };
  } catch (error) {
    return { available: false, error: String(error?.stderr || error?.message || error).trim() };
  }
}

async function untrackedManifest(root) {
  const { stdout } = await run('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: root, env: gitEnv(), encoding: 'buffer', maxBuffer: 256 * 1024 * 1024,
  });
  const names = Buffer.from(stdout).toString('utf8').split('\0').filter(Boolean).sort();
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

/** Exact commit plus a content-addressed manifest of every Git-visible dirty input. */
async function sourceState() {
  const [{ stdout: commitOut }, { stdout: statusOut }, { stdout: diffOut }, untracked] = await Promise.all([
    run('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: SOURCE_ROOT, env: gitEnv(), encoding: 'buffer' }),
    run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd: SOURCE_ROOT, env: gitEnv(), encoding: 'buffer', maxBuffer: 64 * 1024 * 1024,
    }),
    run('git', ['diff', '--binary', '--no-ext-diff', 'HEAD', '--', '.'], {
      cwd: SOURCE_ROOT, env: gitEnv(), encoding: 'buffer', maxBuffer: 256 * 1024 * 1024,
    }),
    untrackedManifest(SOURCE_ROOT),
  ]);
  const status = Buffer.from(statusOut);
  const diff = Buffer.from(diffOut);
  const dirtyState = {
    statusSha256: sha256(status),
    trackedDiffSha256: sha256(diff),
    untracked,
  };
  return {
    commit: Buffer.from(commitOut).toString('utf8').trim(),
    dirty: status.length > 0,
    dirtyStateSha256: sha256(JSON.stringify(dirtyState)),
    dirtyState,
  };
}

async function runtimeMetadata() {
  const cpus = os.cpus();
  const [git, ctags, enry, jj, holt] = await Promise.all([
    commandVersion('git'), commandVersion('ctags'), commandVersion('enry'), commandVersion('jj'),
    commandVersion(process.execPath, [HOLT, '--version']),
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

function sampleStats(values) {
  const xs = [...values].sort((a, b) => a - b);
  const nearest = (p) => xs[Math.max(0, Math.min(xs.length - 1, Math.ceil(p * xs.length) - 1))];
  return {
    samples: xs.length,
    min: xs[0] ?? null,
    p50: xs.length ? nearest(0.50) : null,
    p90: xs.length ? nearest(0.90) : null,
    p99: xs.length ? nearest(0.99) : null,
    max: xs.at(-1) ?? null,
    mean: xs.length ? xs.reduce((sum, n) => sum + n, 0) / xs.length : null,
  };
}

function parseDecision(stdout, exitCode) {
  const text = String(stdout ?? '').trim();
  if (!text) return exitCode === 0 ? { decision: 'allow', parsed: null } : { decision: 'error', parsed: null };
  try {
    const parsed = JSON.parse(text);
    return {
      decision: parsed.decision ?? parsed.hookSpecificOutput?.permissionDecision
        ?? (exitCode === 0 ? 'allow' : 'error'),
      parsed,
    };
  } catch {
    return { decision: 'invalid-json', parsed: null };
  }
}

function invokeHook(cwd, command) {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = execFile(process.execPath, [HOLT, 'hook', 'pre-tool-use', '--cwd', cwd], {
      // No benchmark-controller deadline: the outer operator owns cancellation.
      cwd, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, HOLT_TMPDIR: path.join(WORK, 'holt-runtime') },
    }, (error, stdout, stderr) => {
      const exitCode = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      const parsed = parseDecision(stdout, exitCode);
      resolve({
        elapsedMs: performance.now() - started,
        exitCode,
        signal: error?.signal ?? null,
        error: error?.message ?? null,
        decision: parsed.decision,
        parsedOutput: parsed.parsed,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      });
    });
    child.stdin.end(JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }));
  });
}

async function checkedSample({ regime, index, warmup, cwd, command, expectedVerdict }) {
  const observed = await invokeHook(cwd, command);
  const exitContract = expectedVerdict === 'allow' ? observed.exitCode === 0 : observed.exitCode !== 0;
  const decisionContract = observed.decision === expectedVerdict;
  const failures = [];
  if (!exitContract) failures.push(`expected ${expectedVerdict} exit contract, got exit ${observed.exitCode}`);
  if (!decisionContract) failures.push(`expected decision ${expectedVerdict}, got ${observed.decision}`);
  return {
    regime, index, warmup, command, expectedVerdict, observed,
    correctness: { pass: failures.length === 0, failures },
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

function validateProtocol() {
  if (!Number.isInteger(N_WT) || N_WT < 2) throw new Error('worktrees must be an integer >= 2');
  if (!Number.isInteger(N_CALLS) || N_CALLS < 2) {
    throw new Error('calls must be an integer >= 2; a single-sample latency summary is not evidence');
  }
  if (!Number.isInteger(N_WARMUPS) || N_WARMUPS < 1) throw new Error('warmups must be an integer >= 1');
}

async function buildFixture() {
  const repo = path.join(WORK, 'repo');
  await fs.mkdir(repo);
  const g = (args, cwd = repo) => run('git', args, {
    cwd, env: gitEnv(), maxBuffer: 64 * 1024 * 1024,
  });
  await g(['init', '-q', '-b', 'main', '.']);
  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  await Promise.all(Array.from({ length: 60 }, (_, i) => fs.writeFile(
    path.join(repo, 'src', `f${i}.js`), `export function base${i}(){return ${i};}\n`,
  )));
  await g(['add', '-A']);
  await g(['commit', '-qm', 'base']);

  const worktrees = [];
  for (let i = 0; i < N_WT; i++) {
    const worktree = path.join(WORK, `wt${i}`);
    await g(['worktree', 'add', '-q', '--detach', worktree]);
    await fs.writeFile(path.join(worktree, 'src', `agent${i}.js`), `export function agent${i}(){return ${i};}\n`);
    worktrees.push(worktree);
  }
  return { repo, worktrees };
}

async function runRegime({ name, cwd, expectedVerdict, commandAt, before }, samples = []) {
  for (let index = 0; index < N_WARMUPS + N_CALLS; index++) {
    const warmup = index < N_WARMUPS;
    if (before) await before(index);
    samples.push(await checkedSample({
      regime: name, index, warmup, cwd, command: commandAt(index), expectedVerdict,
    }));
  }
  return samples;
}

function regimeSummary(samples) {
  const measured = samples.filter((sample) => !sample.warmup);
  const warmups = samples.filter((sample) => sample.warmup);
  return {
    expectedWarmups: N_WARMUPS,
    observedWarmups: warmups.length,
    expectedMeasured: N_CALLS,
    observedMeasured: measured.length,
    correctWarmups: warmups.filter((sample) => sample.correctness.pass).length,
    correctMeasured: measured.filter((sample) => sample.correctness.pass).length,
    latencyMs: sampleStats(measured.map((sample) => sample.observed.elapsedMs)),
    correctnessFailures: samples.flatMap((sample) => sample.correctness.failures.map((failure) => ({
      index: sample.index, warmup: sample.warmup, failure,
    }))),
  };
}

async function main() {
  validateProtocol();
  await assertFreshEvidencePath(OUT);
  await prepareHookScratch(WORK, OUT);

  let artifactWritten = false;
  const evidence = {
    schemaVersion: 1,
    benchmark: 'holt-hook-latency',
    generatedAt: new Date().toISOString(),
    command: { executable: process.execPath, argv: [fileURLToPath(import.meta.url), ...ARGS], cwd: process.cwd() },
    protocol: {
      worktrees: N_WT, measuredCallsPerRegime: N_CALLS, warmupsPerRegime: N_WARMUPS,
      regimes: ['steadyState', 'activeFanOut', 'destructiveUnderChurn', 'destructiveCacheHit'],
      expectedMeasuredTotal: 4 * N_CALLS,
      expectedWarmupTotal: 4 * N_WARMUPS,
    },
    source: { before: null, after: null, stable: false },
    runtime: await runtimeMetadata(),
    samples: {},
    summary: {},
    correctnessFailures: [],
    fatalError: null,
    valid: false,
  };
  for (const regime of evidence.protocol.regimes) evidence.samples[regime] = [];

  try {
    evidence.source.before = await sourceState();
    const { repo, worktrees } = await buildFixture();
    let churnSerial = 0;
    await runRegime({
      name: 'steadyState', cwd: repo, expectedVerdict: 'allow', commandAt: () => 'git status',
    }, evidence.samples.steadyState);
    await runRegime({
      name: 'activeFanOut', cwd: repo, expectedVerdict: 'allow', commandAt: () => 'git status',
      before: async (index) => {
        const wt = worktrees[index % worktrees.length];
        await fs.writeFile(path.join(wt, 'src', `churn_${churnSerial}.js`), `export const churn_${churnSerial++}=1;\n`);
      },
    }, evidence.samples.activeFanOut);
    await runRegime({
      name: 'destructiveUnderChurn', cwd: repo, expectedVerdict: 'deny',
      commandAt: (index) => `rm -rf "${worktrees[(index + 1) % worktrees.length]}"`,
      before: async (index) => {
        const wt = worktrees[index % worktrees.length];
        await fs.writeFile(path.join(wt, 'src', `churn_${churnSerial}.js`), `export const churn_${churnSerial++}=1;\n`);
      },
    }, evidence.samples.destructiveUnderChurn);
    await runRegime({
      name: 'destructiveCacheHit', cwd: repo, expectedVerdict: 'deny',
      commandAt: () => `rm -rf "${worktrees[0]}"`,
    }, evidence.samples.destructiveCacheHit);
  } catch (error) {
    evidence.fatalError = { message: error?.message ?? String(error), stack: error?.stack ?? null };
  }

  for (const [name, samples] of Object.entries(evidence.samples)) {
    evidence.summary[name] = regimeSummary(samples);
    evidence.correctnessFailures.push(...evidence.summary[name].correctnessFailures.map((failure) => ({
      regime: name, ...failure,
    })));
  }

  evidence.source.after = await sourceState().catch((error) => ({ error: error?.message ?? String(error) }));
  evidence.source.stable = !!evidence.source.before
    && evidence.source.before.commit === evidence.source.after?.commit
    && evidence.source.before.dirtyStateSha256 === evidence.source.after?.dirtyStateSha256;
  if (!evidence.source.stable) {
    evidence.correctnessFailures.push({ regime: 'source', failure: 'source state changed while the benchmark ran' });
  }
  evidence.runtime.loadAverageAtEnd = os.loadavg();
  const summaries = Object.values(evidence.summary);
  const complete = summaries.length === evidence.protocol.regimes.length
    && summaries.every((summary) => summary.observedMeasured === N_CALLS
      && summary.observedWarmups === N_WARMUPS);
  evidence.denominators = {
    expectedMeasured: evidence.protocol.expectedMeasuredTotal,
    observedMeasured: summaries.reduce((sum, summary) => sum + summary.observedMeasured, 0),
    expectedWarmups: evidence.protocol.expectedWarmupTotal,
    observedWarmups: summaries.reduce((sum, summary) => sum + summary.observedWarmups, 0),
    correctnessFailures: evidence.correctnessFailures.length,
  };
  evidence.valid = !evidence.fatalError && complete && evidence.source.stable
    && evidence.correctnessFailures.length === 0;

  try {
    const digest = await writeEvidence(evidence, OUT);
    artifactWritten = true;
    console.log(JSON.stringify({
      valid: evidence.valid,
      summary: evidence.summary,
      denominators: evidence.denominators,
      evidence: OUT,
      sha256: digest,
    }, null, 2));
  } finally {
    // If the artifact could not be persisted, retain the marked scratch tree. It may contain the
    // only surviving state from which the interrupted measurement can be diagnosed.
    if (artifactWritten) await cleanHookScratch(WORK);
  }
  if (!evidence.valid) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
