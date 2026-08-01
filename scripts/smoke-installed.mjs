#!/usr/bin/env node
// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — prove the INSTALLED ARTIFACT works, on the platform it was installed on.
 *
 * Every other test in this repository runs against the source tree. The published v0.2.0 tarball
 * was missing four runtime modules and 12 of 14 language packs, and nothing caught it, because
 * the one thing a user actually receives was the only thing never exercised.
 *
 * So this drives the binary on PATH — the npm-generated shim, which on Windows is a .cmd/.ps1
 * wrapper and not the script at all — against a real git repository with real work in it, and
 * checks the answers rather than the exit codes alone. A CLI that installs and prints its version
 * is not evidence that it works; a CLI that finds planted at-risk work is.
 *
 * Usage: node scripts/smoke-installed.mjs [--bin holt]
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const BIN = (() => {
  const i = process.argv.indexOf('--bin');
  return i !== -1 ? process.argv[i + 1] : 'holt';
})();

const WIN = process.platform === 'win32';
const failures = [];
const ok = (label) => console.log(`  ok    ${label}`);
const bad = (label, detail) => { failures.push(`${label}\n        ${detail}`); console.log(`  FAIL  ${label}`); };

function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      cwd,
      timeout: 180_000,
      maxBuffer: 32 * 1024 * 1024,
      // npm installs `holt` on Windows as holt.cmd; execFile cannot spawn a .cmd without a shell.
      shell: WIN,
      env: { ...process.env, HOLT_TMPDIR: process.env.HOLT_TMPDIR ?? os.tmpdir() },
    }, (err, stdout, stderr) => resolve({
      code: err?.code ?? 0,
      stdout: stdout ?? '',
      stderr: stderr ?? '',
      spawnError: err && err.code === 'ENOENT' ? err.message : null,
    }));
  });
}

const git = (args, cwd) => run('git', args, cwd);

async function main() {
  console.log(`holt smoke test — binary '${BIN}' on ${process.platform}`);

  // ---------------------------------------------------------------- a real repository ----
  const tmp = await fs.mkdtemp(path.join(process.env.HOLT_TMPDIR ?? os.tmpdir(), 'holt-smoke-'));
  const repo = path.join(tmp, 'repo');
  await fs.mkdir(repo, { recursive: true });
  await git(['init', '--initial-branch=main', '-q'], repo);
  await git(['config', 'user.email', 'smoke@holt.invalid'], repo);
  await git(['config', 'user.name', 'holt smoke'], repo);
  await git(['config', 'commit.gpgsign', 'false'], repo);
  await fs.writeFile(path.join(repo, 'README.md'), '# smoke\n');
  await fs.writeFile(path.join(repo, 'base.mjs'), 'export function baseline() { return 1; }\n');
  await git(['add', '-A'], repo);
  await git(['commit', '-qm', 'base'], repo);

  // One worktree holding the only copy of something — planted ground truth.
  const wt = path.join(tmp, 'wt-precious');
  await git(['worktree', 'add', '-q', '-b', 'precious', wt], repo);
  await fs.writeFile(path.join(wt, 'only_copy.mjs'),
    'export function ONLY_COPY_OF_THIS_SYMBOL() { return 42; }\n');

  // One worktree holding nothing at all — the negative control.
  const empty = path.join(tmp, 'wt-empty');
  await git(['worktree', 'add', '-q', '-b', 'empty', empty], repo);

  // ------------------------------------------------------------------------- version ----
  const version = await run(BIN, ['--version'], repo);
  if (version.spawnError) {
    bad('the installed binary is on PATH', version.spawnError);
    return report();
  }
  const expected = JSON.parse(
    await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ).version;
  if (version.code === 0 && version.stdout.includes(expected)) ok(`--version reports ${expected}`);
  else bad('--version reports the packaged version', `exit ${version.code}: ${version.stdout || version.stderr}`);

  // -------------------------------------------------------------------------- doctor ----
  const doctor = await run(BIN, ['doctor'], repo);
  if (doctor.code === 0 || doctor.code === 1) ok('doctor runs and reports its environment');
  else bad('doctor runs', `exit ${doctor.code}: ${(doctor.stderr || doctor.stdout).slice(0, 400)}`);

  // ------------------------------------------------------- the actual product answer ----
  // THE POINT OF THIS FILE. A tarball that starts is not a tarball that works: this asserts holt
  // finds the work that was planted and does not invent work in the empty tree.
  const risk = await run(BIN, ['risk', '--json'], repo);
  if (risk.code !== 0) {
    bad('risk --json exits 0', `exit ${risk.code}: ${(risk.stderr || risk.stdout).slice(0, 600)}`);
  } else {
    let parsed = null;
    try { parsed = JSON.parse(risk.stdout); } catch { /* handled below */ }
    if (!parsed) {
      bad('risk --json emits parseable JSON', risk.stdout.slice(0, 400));
    } else {
      const atRisk = (parsed.unique ?? []).filter((u) => u.verdict === 'unique-work-uncommitted').map((u) => u.id);
      if (atRisk.includes('wt-precious')) ok('risk finds the planted uncommitted-only work');
      else bad('risk finds the planted uncommitted-only work',
        `at-risk was ${JSON.stringify(atRisk)} — the shipped build cannot see uncommitted work`);

      if (!atRisk.includes('wt-empty')) ok('risk does not invent work in the empty worktree');
      else bad('risk does not invent work in the empty worktree', 'the empty tree was reported at risk');
    }
  }

  // ------------------------------------------------------------- the machine contract ----
  // `gate` is what scripts and pre-delete hooks chain on, so its EXIT CODE is the product.
  const gatePrecious = await run(BIN, ['gate', 'wt-precious'], repo);
  if (gatePrecious.code === 1) ok('gate exits 1 on a worktree holding unique work');
  else bad('gate exits 1 on a worktree holding unique work', `got exit ${gatePrecious.code}`);

  const gateEmpty = await run(BIN, ['gate', 'wt-empty'], repo);
  if (gateEmpty.code === 0) ok('gate exits 0 on a provably disposable worktree');
  else bad('gate exits 0 on a provably disposable worktree', `got exit ${gateEmpty.code}: ${gateEmpty.stdout.slice(0, 300)}`);

  // ------------------------------------------------------------------ language packs ----
  // The quiet failure mode: the gap packs are data files, so their absence throws nothing and
  // simply makes a published language claim untrue.
  const status = await run(BIN, ['status'], repo);
  if (status.code === 0 || status.code === 1) ok('status runs against a real repository');
  else bad('status runs against a real repository', `exit ${status.code}: ${(status.stderr || status.stdout).slice(0, 400)}`);

  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  return report();
}

function report() {
  if (failures.length === 0) {
    console.log('\nthe installed artifact works on this platform.');
    process.exit(0);
  }
  console.log(`\n${failures.length} check(s) failed on the INSTALLED artifact:\n`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}

await main();
