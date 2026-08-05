import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK_BENCH = path.join(ROOT, 'eval', 'hook-latency.mjs');
const ENTERPRISE_BENCH = path.join(ROOT, 'eval', 'enterprise-bench.mjs');
const hook = await import('../../eval/hook-latency.mjs');
const enterprise = await import('../../eval/enterprise-bench.mjs');

function runScript(script, argv, options = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...argv], {
      cwd: ROOT,
      timeout: options.timeout ?? 180_000,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, ...options.env },
    }, (error, stdout, stderr) => resolve({
      code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
      stdout: String(stdout ?? ''),
      stderr: String(stderr ?? ''),
    }));
  });
}

function runCommand(command, argv, cwd) {
  return new Promise((resolve, reject) => {
    execFile(command, argv, { cwd, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`${command} ${argv.join(' ')}: ${stderr || error.message}`));
        else resolve(String(stdout));
      });
  });
}

async function tinyGitRepo(base) {
  const repo = path.join(base, 'tiny-source');
  await fs.mkdir(repo);
  await runCommand('git', ['init', '-q', '-b', 'main', '.'], repo);
  await fs.mkdir(path.join(repo, 'src'));
  await fs.writeFile(path.join(repo, 'src', 'small.js'), 'export const small = true;\n');
  await runCommand('git', ['add', '-A'], repo);
  await runCommand('git', [
    '-c', 'user.name=holt benchmark test', '-c', 'user.email=bench@holt.invalid',
    'commit', '-qm', 'base',
  ], repo);
  return repo;
}

async function checksumMatches(out) {
  const encoded = await fs.readFile(out, 'utf8');
  const sidecar = (await fs.readFile(`${out}.sha256`, 'utf8')).trim().split(/\s+/)[0];
  assert.equal(sidecar, createHash('sha256').update(encoded).digest('hex'));
  return JSON.parse(encoded);
}

test('BENCH EVIDENCE: remote enterprise fixtures are exact commits, never moving HEAD', () => {
  assert.match(enterprise.REPOS.redis.commit, /^[0-9a-f]{40}$/);
  assert.match(enterprise.REPOS.postgres.commit, /^[0-9a-f]{40}$/);
  assert.equal(enterprise.REPOS.redis.commit, 'bf49481ad7cf93d136e7520d321448d9ef65b03a');
  assert.equal(enterprise.REPOS.postgres.commit, '589eb4c3b309f5eaa7c16592ff4edbbf780671fe');
});

test('BENCH EVIDENCE: missing numeric samples stay in the denominator', () => {
  assert.deepEqual(enterprise.sampleStats([3, null, 1], 3), {
    expected: 3,
    observed: 3,
    numeric: 2,
    missing: 1,
    min: 1,
    p50: 1,
    p90: 3,
    p99: 3,
    max: 3,
    mean: 2,
  });
});

for (const [name, prepare] of [
  ['hook latency', hook.prepareHookScratch],
  ['enterprise', enterprise.prepareEnterpriseScratch],
]) {
  test(`BENCH EVIDENCE: ${name} refuses an unmarked pre-existing scratch root`, async (t) => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-benchmark-owner-'));
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    const work = path.join(base, 'unowned');
    const sentinel = path.join(work, 'only-copy.txt');
    const out = path.join(base, 'evidence.json');
    await fs.mkdir(work);
    await fs.writeFile(sentinel, 'irreplaceable\n');

    await assert.rejects(prepare(work, out), /lacks Holt's exact .* ownership marker/);
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'irreplaceable\n');
    await assert.rejects(fs.stat(out), /ENOENT/);
  });

  test(`BENCH EVIDENCE: ${name} refuses a scratch root nested inside the live source tree`, async (t) => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-benchmark-live-root-'));
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    const dangerous = path.join(ROOT, `.holt-benchmark-must-not-create-${process.pid}-${name.replace(/\W/g, '-')}`);
    await assert.rejects(prepare(dangerous, path.join(base, 'evidence.json')), /unsafe benchmark root/);
    await assert.rejects(fs.stat(dangerous), /ENOENT/, 'the safety check must run before creating anything');
  });

  test(`BENCH EVIDENCE: ${name} refuses to place the only artifact inside disposable scratch`, async (t) => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-benchmark-output-boundary-'));
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    const work = path.join(base, 'work');
    await assert.rejects(prepare(work, path.join(work, 'evidence.json')), /--out must be outside --work/);
    await assert.rejects(fs.stat(work), /ENOENT/);
  });
}

for (const [name, script, protocolArgs] of [
  ['scale', path.join(ROOT, 'eval', 'bench.mjs'), ['1', '--runs', '1', '--warmups', '0']],
  ['hook latency', HOOK_BENCH, ['2', '2', '--warmups', '1']],
  ['enterprise', ENTERPRISE_BENCH, ['holt-self', '--worktrees', '1', '--runs', '2', '--warmups', '1']],
]) {
  test(`BENCH EVIDENCE: ${name} never overwrites the only existing evidence`, async (t) => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-benchmark-no-overwrite-'));
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    const work = path.join(base, 'work');
    const out = path.join(base, 'evidence.json');
    await fs.writeFile(out, 'irreplaceable evidence\n');
    const result = await runScript(script, [...protocolArgs, '--work', work, '--out', out]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /refusing to overwrite existing benchmark evidence/);
    assert.equal(await fs.readFile(out, 'utf8'), 'irreplaceable evidence\n');
    await assert.rejects(fs.stat(work), /ENOENT/, 'output refusal must happen before scratch creation');
  });
}

test('BENCH EVIDENCE: hook latency retains every regime sample and independently grades verdicts', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-hook-evidence-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const work = path.join(base, 'scratch');
  const out = path.join(base, 'hook.json');
  const result = await runScript(HOOK_BENCH, [
    '2', '2', '--warmups', '1', '--work', work, '--out', out,
  ]);
  const artifact = await checksumMatches(out);
  assert.equal(result.code === 0, artifact.valid,
    `exit status must agree with artifact validity:\n${result.stdout}\n${result.stderr}`);
  assert.equal(artifact.valid, artifact.source.stable,
    'with every hook verdict correct, only real source drift may invalidate this live-worktree smoke');
  assert.equal(artifact.protocol.expectedMeasuredTotal, 8);
  assert.equal(artifact.protocol.expectedWarmupTotal, 4);
  assert.equal(artifact.denominators.observedMeasured, 8);
  assert.equal(artifact.denominators.observedWarmups, 4);
  assert.ok(artifact.correctnessFailures.every((failure) => failure.regime === 'source'));
  for (const regime of artifact.protocol.regimes) {
    const samples = artifact.samples[regime];
    assert.equal(samples.length, 3, `${regime}: one warmup and two measured calls must survive`);
    assert.equal(samples.filter((sample) => !sample.warmup).length, 2);
    for (const sample of samples) {
      assert.equal(sample.correctness.pass, true, `${regime}: ${JSON.stringify(sample)}`);
      assert.equal(sample.observed.decision, sample.expectedVerdict);
      assert.equal(typeof sample.observed.elapsedMs, 'number');
      assert.equal(typeof sample.observed.stdout, 'string');
      assert.equal(typeof sample.observed.stderr, 'string');
    }
  }
  assert.match(artifact.source.before.commit, /^[0-9a-f]{40}$/);
  assert.match(artifact.source.before.dirtyStateSha256, /^[0-9a-f]{64}$/);
  assert.equal(typeof artifact.source.stable, 'boolean');
  assert.equal(artifact.runtime.platform, process.platform);
  assert.ok(artifact.runtime.cpu.logicalCount >= 1);
  assert.ok(artifact.runtime.memory.totalBytes > 0);
  await assert.rejects(fs.stat(work), /ENOENT/, 'scratch cleanup happens only after external evidence exists');
});

test('BENCH EVIDENCE: a one-call latency invocation is refused without fabricating evidence', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-hook-one-sample-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const out = path.join(base, 'hook.json');
  const result = await runScript(HOOK_BENCH, [
    '2', '1', '--warmups', '1', '--work', path.join(base, 'work'), '--out', out,
  ]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /single-sample latency summary is not evidence/);
  await assert.rejects(fs.stat(out), /ENOENT/);
});

test('BENCH EVIDENCE: a one-run enterprise invocation is refused without fabricating evidence', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-enterprise-one-sample-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const work = path.join(base, 'work');
  const out = path.join(base, 'enterprise.json');
  const result = await runScript(ENTERPRISE_BENCH, [
    'holt-self', '--worktrees', '1', '--runs', '1', '--warmups', '1',
    '--work', work, '--out', out,
  ]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /single-sample enterprise summary is not evidence/);
  await assert.rejects(fs.stat(work), /ENOENT/);
  await assert.rejects(fs.stat(out), /ENOENT/);
});

test('BENCH EVIDENCE: enterprise smoke preserves warmups, repetitions, grading, commands, and source identity', { timeout: 180_000 }, async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-enterprise-evidence-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const work = path.join(base, 'scratch');
  const out = path.join(base, 'enterprise.json');
  const sourceRepo = await tinyGitRepo(base);
  const result = await runScript(ENTERPRISE_BENCH, [
    'holt-self', '--worktrees', '1', '--noise-level', '0', '--runs', '2', '--warmups', '1',
    '--work', work, '--out', out,
  ], { timeout: 180_000, env: { HOLT_SELF_REPO: sourceRepo } });
  const artifact = await checksumMatches(out);
  assert.equal(result.code === 0, artifact.valid,
    `exit status must agree with artifact validity:\n${result.stdout}\n${result.stderr}`);
  assert.equal(artifact.valid, artifact.source.stable,
    'with every repository sample correct, only real source drift may invalidate this live-worktree smoke');
  assert.equal(artifact.protocol.measuredRunsPerRepository, 2);
  assert.equal(artifact.protocol.warmupsPerRepository, 1);
  assert.equal(artifact.summary.observedMeasuredRuns, 2);
  assert.equal(artifact.summary.observedWarmups, 1);
  assert.equal(artifact.summary.correctnessFailures, artifact.source.stable ? 0 : 1);
  assert.equal(artifact.repositories.length, 1);
  const [repo] = artifact.repositories;
  assert.equal(repo.fixtureSource.requestedCommit, repo.fixtureSource.verifiedCommit);
  assert.match(repo.fixtureSource.verifiedCommit, /^[0-9a-f]{40}$/);
  assert.equal(repo.samples.length, 3);
  assert.equal(repo.denominators.validMeasured, 2);
  assert.equal(repo.denominators.validWarmups, 1);
  assert.equal(repo.denominators.graded, repo.denominators.planted);
  assert.ok(repo.samples.every((sample) => sample.valid));
  assert.equal(repo.commands.skipped, undefined);
  assert.equal(typeof repo.commands.status.stdout, 'string');
  assert.equal(repo.dist.totalMs.numeric, 2);
  assert.equal(repo.dist.totalMs.missing, 0);
  assert.match(artifact.source.before.dirtyStateSha256, /^[0-9a-f]{64}$/);
  assert.equal(typeof artifact.source.stable, 'boolean');
  assert.equal(artifact.runtime.node.version, process.version);
  assert.ok(artifact.runtime.tools.git.available);
  await assert.rejects(fs.stat(work), /ENOENT/);
});

test('BENCH EVIDENCE: enterprise grades binary, large, and disposable cases instead of hiding them', () => {
  const planted = {
    atRisk: [], hold: [], gitignored: [],
    binary: ['binary'], huge: ['huge'], disposable: ['spent'],
  };
  const result = enterprise.verifyCorrectness({ safe: [
    { id: 'binary', safe: true, reasons: [] },
    { id: 'spent', safe: false, reasons: ['invented risk'] },
  ] }, planted);
  assert.equal(result.plantedTotal, 3);
  assert.equal(result.gradedTotal, 2);
  assert.deepEqual(result.observations.map(({ id, expected, found, observedSafe }) => ({
    id, expected, found, observedSafe,
  })), [
    { id: 'binary', expected: 'binary', found: true, observedSafe: true },
    { id: 'huge', expected: 'huge', found: false, observedSafe: null },
    { id: 'spent', expected: 'disposable', found: true, observedSafe: false },
  ]);
  assert.ok(result.errors.some((error) => /binary.*called SAFE/.test(error)));
  assert.ok(result.errors.some((error) => /do not appear.*report/.test(error)));
  assert.ok(result.errors.some((error) => /disposable spent: not called safe/.test(error)));
});
