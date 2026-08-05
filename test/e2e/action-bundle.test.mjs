// SPDX-License-Identifier: FSL-1.1-MIT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BUNDLE = path.join(ROOT, 'dist', 'holt-action.mjs');

async function command(file, args, options = {}) {
  try {
    const result = await execFileAsync(file, args, {
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024,
      ...options,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: Number.isInteger(error?.code) ? error.code : 1,
      stdout: String(error?.stdout ?? ''),
      stderr: String(error?.stderr ?? error?.message ?? ''),
    };
  }
}

async function fixture(t) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-action-e2e-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const repo = path.join(workspace, 'repo');
  await fs.mkdir(repo);
  await command('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  await fs.writeFile(path.join(repo, 'one.txt'), 'one\n');
  await command('git', ['add', '--', 'one.txt'], { cwd: repo });
  const committed = await command('git', [
    '-c', 'user.name=Holt action test',
    '-c', 'user.email=action@holt.invalid',
    'commit', '-qm', 'base',
  ], { cwd: repo });
  assert.equal(committed.code, 0, committed.stderr);
  return { workspace, repo };
}

function actionEnv(workspace, extra = {}) {
  const privateHome = path.join(workspace, 'home');
  return {
    ...process.env,
    HOME: privateHome,
    USERPROFILE: privateHome,
    XDG_CONFIG_HOME: path.join(privateHome, '.config'),
    GITHUB_WORKSPACE: workspace,
    'INPUT_WORKING-DIRECTORY': 'repo',
    'INPUT_FAIL-ON-UNLANDED': 'true',
    HOLT_LICENSE: '',
    ...extra,
  };
}

test('committed action bundle and third-party notices are reproducible', async () => {
  const result = await command(process.execPath, ['scripts/build-action-bundle.mjs', '--check'], { cwd: ROOT });
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /GitHub Action bundle is current:/);
  const notices = await fs.readFile(path.join(ROOT, 'dist', 'THIRD-PARTY-NOTICES.txt'), 'utf8');
  for (const identity of ['@modelcontextprotocol/sdk@1.30.0', 'jsonc-parser@3.3.1', 'tuf-js@6.0.0']) {
    assert.match(notices, new RegExp(identity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('dependency-free JavaScript action executes free CI from the pinned bundle', async (t) => {
  const { workspace } = await fixture(t);
  const result = await command(process.execPath, [BUNDLE], {
    cwd: workspace,
    env: actionEnv(workspace),
  });
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.shallow, false);
});

test('bundle contains JSONC policy support rather than succeeding only when ambient node_modules exists', async (t) => {
  const { workspace, repo } = await fixture(t);
  await fs.mkdir(path.join(repo, '.holt'));
  await fs.writeFile(path.join(repo, '.holt', 'policy.jsonc'), `{
    // A strict-JSON parser cannot consume this comment.
    "version": 1,
    "rules": [{ "id": "classified", "type": "require-classified", "severity": "warn" }]
  }\n`);
  await command('git', ['add', '--', '.holt/policy.jsonc'], { cwd: repo });
  const committed = await command('git', [
    '-c', 'user.name=Holt action test',
    '-c', 'user.email=action@holt.invalid',
    'commit', '-qm', 'policy',
  ], { cwd: repo });
  assert.equal(committed.code, 0, committed.stderr);

  const result = await command(process.execPath, [BUNDLE], {
    cwd: workspace,
    env: actionEnv(workspace),
  });
  assert.equal(result.code, 3, `${result.stdout}\n${result.stderr}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.code, 'unlicensed-policy');
  assert.doesNotMatch(payload.reason, /jsonc-parser.*not installed/i);
});

test('action input grammar refuses booleans and paths it cannot prove safe', async (t) => {
  const { workspace } = await fixture(t);
  const badBoolean = await command(process.execPath, [BUNDLE], {
    cwd: workspace,
    env: actionEnv(workspace, { 'INPUT_FAIL-ON-UNLANDED': 'sometimes' }),
  });
  assert.equal(badBoolean.code, 2);
  assert.match(badBoolean.stderr, /must be exactly 'true' or 'false'/);

  const escape = await command(process.execPath, [BUNDLE], {
    cwd: workspace,
    env: actionEnv(workspace, { 'INPUT_WORKING-DIRECTORY': '../outside' }),
  });
  assert.equal(escape.code, 2);
  assert.match(escape.stderr, /must stay inside GITHUB_WORKSPACE/);
});
