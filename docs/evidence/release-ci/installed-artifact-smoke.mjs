#!/usr/bin/env node
// Read-only release evidence helper. It creates and removes only its own fixture under HOLT_TMPDIR.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? null : process.argv[i + 1];
};
const bin = arg('--bin');
const expected = arg('--expect');
if (!bin || !expected) throw new Error('usage: installed-artifact-smoke.mjs --bin <path> --expect <version>');

const run = (cmd, args, cwd) => new Promise((resolve) => {
  execFile(cmd, args, {
    cwd,
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024,
    shell: process.platform === 'win32',
    env: { ...process.env, HOLT_TMPDIR: process.env.HOLT_TMPDIR ?? os.tmpdir() },
  }, (error, stdout, stderr) => resolve({
    code: typeof error?.code === 'number' ? error.code : error ? 127 : 0,
    stdout: stdout ?? '',
    stderr: stderr ?? '',
  }));
});

const root = await fs.mkdtemp(path.join(process.env.HOLT_TMPDIR ?? os.tmpdir(), 'release-smoke-'));
const repo = path.join(root, 'repo');
const precious = path.join(root, 'wt-precious');
const empty = path.join(root, 'wt-empty');
const checks = [];
const check = (condition, label, detail = '') => {
  checks.push({ ok: Boolean(condition), label, detail });
  console.log(`${condition ? 'ok ' : 'BAD'}  ${label}${condition || !detail ? '' : `: ${detail}`}`);
};

try {
  await fs.mkdir(repo);
  for (const [args, cwd = repo] of [
    [['init', '-q', '--initial-branch=main'], repo],
    [['config', 'user.email', 'release-smoke@holt.invalid']],
    [['config', 'user.name', 'holt release smoke']],
    [['commit', '-q', '--allow-empty', '-m', 'base']],
    [['worktree', 'add', '-q', '-b', 'precious', precious]],
    [['worktree', 'add', '-q', '-b', 'empty', empty]],
  ]) {
    const result = await run('git', args, cwd);
    if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  await fs.writeFile(path.join(precious, 'only-copy.mjs'), 'export const ONLY_RELEASE_SMOKE_COPY = 1;\n');

  const version = await run(bin, ['--version'], repo);
  check(version.code === 0 && version.stdout.includes(expected), `version is ${expected}`, version.stdout || version.stderr);

  const doctor = await run(bin, ['doctor'], repo);
  check((doctor.code === 0 || doctor.code === 1) && /symbol backend/i.test(`${doctor.stdout}${doctor.stderr}`),
    'doctor reports the installed environment', `${doctor.stdout}${doctor.stderr}`.slice(0, 240));

  const risk = await run(bin, ['risk', '--json'], repo);
  let report = null;
  try { report = JSON.parse(risk.stdout); } catch { /* recorded below */ }
  const atRisk = (report?.unique ?? []).filter((x) => x.verdict === 'unique-work-uncommitted').map((x) => x.id);
  check(risk.code === 0 && atRisk.includes('wt-precious'), 'risk finds the planted sole copy', risk.stderr || JSON.stringify(atRisk));
  check(risk.code === 0 && !atRisk.includes('wt-empty'), 'risk does not invent work in the empty worktree', JSON.stringify(atRisk));

  const deny = await run(bin, ['gate', 'wt-precious'], repo);
  check(deny.code === 1 && /HOLDS UNIQUE WORK/i.test(`${deny.stdout}${deny.stderr}`),
    'gate denies the sole-copy worktree with an explicit verdict', `${deny.stdout}${deny.stderr}`.slice(0, 240));
  const allow = await run(bin, ['gate', 'wt-empty'], repo);
  check(allow.code === 0, 'gate permits the provably empty worktree', `${allow.stdout}${allow.stderr}`.slice(0, 240));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

const passed = checks.filter((x) => x.ok).length;
console.log(`installed artifact: ${passed}/${checks.length} checks passed`);
process.exit(passed === checks.length ? 0 : 1);
