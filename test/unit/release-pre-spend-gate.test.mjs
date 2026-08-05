import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNNER = path.join(ROOT, 'eval', 'run.mjs');

function execute(argv, cwd = ROOT) {
  return new Promise((resolve) => {
    execFile(process.execPath, argv, { cwd, timeout: 15_000 }, (error, stdout, stderr) => {
      resolve({
        exitCode: typeof error?.code === 'number' ? error.code : error ? 1 : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      });
    });
  });
}

function git(argv, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', argv, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'pre-spend-test', GIT_AUTHOR_EMAIL: 'pre-spend@test.invalid',
        GIT_COMMITTER_NAME: 'pre-spend-test', GIT_COMMITTER_EMAIL: 'pre-spend@test.invalid',
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      },
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message)));
      else resolve(String(stdout).trim());
    });
  });
}

function cliOptions(options) {
  return Object.entries(options).flatMap(([name, value]) => (
    value === null || value === undefined ? [] : [`--${name}`, String(value)]
  ));
}

test('RELEASE EVAL PRE-SPEND RED: malformed Codex cells launch zero agent/provider processes', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-pre-spend-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sentinel = path.join(base, 'agent-was-launched');
  const fakeCodex = path.join(base, 'codex');
  await fs.writeFile(fakeCodex, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'launched\\n');\n`);
  await fs.chmod(fakeCodex, 0o700);

  const missingSource = path.join(base, 'source-does-not-exist');
  const missingRuntime = path.join(base, 'runtime-does-not-exist');
  const common = {
    agent: 'codex',
    'codex-bin': fakeCodex,
    model: 'gpt-5.6-luna',
    'reasoning-effort': 'high',
    scenario: 'cleanup',
    treatments: 'no-holt,integrate-only',
    trials: 1,
    'timeout-ms': 0,
    retries: 0,
    'order-seed': 260805,
    'contain-codex': 'true',
    'bwrap-bin': '/usr/bin/bwrap',
    src: missingSource,
    'expected-src-commit': 'a'.repeat(40),
    'holt-bin': path.join(missingRuntime, 'node_modules', 'holt', 'bin', 'holt.mjs'),
    'holt-root': path.join(missingRuntime, 'node_modules', 'holt'),
    'holt-install-root': missingRuntime,
    'holt-tarball': path.join(base, 'missing.tgz'),
    'holt-freeze-evidence': path.join(base, 'missing-freeze.json'),
    'retain-fixtures': 'true',
    work: path.join(base, 'work'),
  };
  const malformed = [
    ['arms', { treatments: 'integrate-only' }],
    ['scenario', { scenario: 'all' }],
    ['trials', { trials: 0 }],
    ['commit', { 'expected-src-commit': null }],
    ['timeout', { 'timeout-ms': 1 }],
    ['retry', { retries: 1 }],
    ['order', { 'order-seed': 1 }],
    ['containment', { 'contain-codex': 'false' }],
    ['fixtures', { 'retain-fixtures': 'false' }],
    ['model', { model: 'wrong-model' }],
    ['reasoning', { 'reasoning-effort': 'low' }],
  ];
  for (const [name, override] of malformed) {
    const out = path.join(base, `${name}.json`);
    const result = await execute([
      RUNNER,
      ...cliOptions({ ...common, ...override, out }),
    ]);
    assert.notEqual(result.exitCode, 0, `${name} unexpectedly ran`);
    assert.match(result.stderr, /refused before any agent\/provider process/);
    assert.equal(await fs.lstat(sentinel).then(() => true, () => false), false,
      `${name} launched the fake Codex process`);
  }

  const collisionOut = path.join(base, 'collision.json');
  await fs.mkdir(`${collisionOut}.namespace`);
  const collision = await execute([
    RUNNER,
    ...cliOptions({ ...common, out: collisionOut }),
  ]);
  assert.notEqual(collision.exitCode, 0);
  assert.match(collision.stderr, /namespace is not fresh/);
  assert.equal(await fs.lstat(sentinel).then(() => true, () => false), false,
    'namespace collision launched the fake Codex process');

  const source = path.join(base, 'source');
  await fs.mkdir(source);
  await git(['init', '-q', '-b', 'main'], source);
  await fs.writeFile(path.join(source, 'README.md'), 'source fixture\n');
  await git(['add', '-A'], source);
  await git(['commit', '-qm', 'fixture'], source);
  const commit = await git(['rev-parse', 'HEAD'], source);

  const wrongSource = await execute([
    RUNNER,
    ...cliOptions({
      ...common,
      src: source,
      'expected-src-commit': 'f'.repeat(40),
      out: path.join(base, 'wrong-source.json'),
    }),
  ]);
  assert.notEqual(wrongSource.exitCode, 0);
  assert.match(wrongSource.stderr, /expected f{40}/);
  assert.equal(await fs.lstat(sentinel).then(() => true, () => false), false,
    'wrong source commit launched the fake Codex process');

  await fs.writeFile(path.join(source, 'UNTRACKED'), 'dirty\n');
  const dirtySource = await execute([
    RUNNER,
    ...cliOptions({
      ...common,
      src: source,
      'expected-src-commit': commit,
      out: path.join(base, 'dirty-source.json'),
    }),
  ]);
  assert.notEqual(dirtySource.exitCode, 0);
  assert.match(dirtySource.stderr, /source repository is dirty/);
  assert.equal(await fs.lstat(sentinel).then(() => true, () => false), false,
    'dirty source launched the fake Codex process');

  // Restore cleanliness by committing the diagnostic file; this is a disposable test repository.
  await git(['add', '-A'], source);
  await git(['commit', '-qm', 'clean again'], source);
  const cleanCommit = await git(['rev-parse', 'HEAD'], source);
  const runtime = path.join(base, 'runtime');
  const packageRoot = path.join(runtime, 'node_modules', 'holt');
  await fs.mkdir(path.join(packageRoot, 'bin'), { recursive: true });
  await fs.mkdir(path.join(packageRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'holt', version: '0.3.1' }));
  const invalidFreeze = await execute([
    RUNNER,
    ...cliOptions({
      ...common,
      src: source,
      'expected-src-commit': cleanCommit,
      'holt-bin': path.join(packageRoot, 'bin', 'holt.mjs'),
      'holt-root': packageRoot,
      'holt-install-root': runtime,
      out: path.join(base, 'invalid-freeze.json'),
    }),
  ]);
  assert.notEqual(invalidFreeze.exitCode, 0);
  assert.match(invalidFreeze.stderr, /runtime\/freeze refused before any agent\/provider process/);
  assert.equal(await fs.lstat(sentinel).then(() => true, () => false), false,
    'invalid frozen runtime launched the fake Codex process');
});
