/**
 * holt — the CLI surface itself.
 *
 * THIS FILE EXISTS BECAUSE 157 TESTS PASSED WITH THREE COMMANDS COMPLETELY UNWIRED.
 *
 * `protect`, `rescue` and `clean` were implemented, exported, and covered by 19 passing tests —
 * and `holt protect` printed "unknown command", because a scripted edit that was supposed to add
 * the dispatch silently failed to match. Every test called the FUNCTIONS directly, so nothing
 * noticed that the only interface a user or an agent actually touches was broken.
 *
 * A unit test proves the logic. It says nothing about whether the thing is reachable. So this
 * suite runs the real binary as a subprocess, for every command, and checks exit codes — because
 * the exit code is the contract that scripts and hooks chain on:
 *
 *     holt rescue X && git worktree remove X
 *
 * If `rescue` exits 0 on an unverified capture, that chain destroys work.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newRepo } from '../fixtures.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'holt.mjs');

function holt(args, cwd) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], {
      cwd, timeout: 180_000, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1' },
    }, (err, stdout, stderr) => resolve({
      code: err ? (err.code ?? 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''),
    }));
  });
}

/** A repo with one disposable and one work-holding worktree. */
async function fixture(label) {
  const fx = await newRepo(label);
  await fx.worktree('spent');
  const holds = await fx.worktree('holds');
  await fx.write('src/valuable.js', 'export function CLI_VALUABLE() { return 1; }\n', holds);
  return fx;
}

test('CLI: every command is REACHABLE and exits 0', async (t) => {
  const fx = await fixture('cli-reach');
  t.after(() => fx.cleanup());

  // The exact failure this file was written for: a command that exists in src/ but was never
  // wired into the dispatcher answers "unknown command".
  const readOnly = [
    ['status'], ['risk'], ['collisions'], ['duplicates'], ['plan'],
    ['impact'], ['graph'], ['doctor'], ['brief'], ['rescued'],
    ['context', 'holds'],
  ];
  for (const args of readOnly) {
    const r = await holt([...args, '--cwd', fx.root, '--json'], fx.root);
    assert.equal(r.code, 0, `holt ${args.join(' ')} exited ${r.code}: ${r.stderr.slice(0, 200)}`);
    assert.ok(!/unknown command/.test(r.stderr + r.stdout),
      `holt ${args.join(' ')} is not wired into the dispatcher`);
  }
});

test('CLI: the MUTATING commands are reachable too', async (t) => {
  const fx = await fixture('cli-mutating');
  t.after(() => fx.cleanup());

  for (const args of [['protect', '--dry-run'], ['clean'], ['unprotect']]) {
    const r = await holt([...args, '--cwd', fx.root], fx.root);
    assert.equal(r.code, 0, `holt ${args.join(' ')} exited ${r.code}: ${r.stderr.slice(0, 200)}`);
    assert.ok(!/unknown command/.test(r.stderr + r.stdout),
      `holt ${args.join(' ')} is not wired`);
  }
});

test('CLI: --json output is parseable for every command that claims it', async (t) => {
  const fx = await fixture('cli-json');
  t.after(() => fx.cleanup());

  for (const args of [['status'], ['risk'], ['collisions'], ['duplicates'], ['plan'], ['impact'], ['graph']]) {
    const r = await holt([...args, '--cwd', fx.root, '--json'], fx.root);
    assert.doesNotThrow(() => JSON.parse(r.stdout),
      `holt ${args.join(' ')} --json produced unparseable output: ${r.stdout.slice(0, 200)}`);
  }
});

/* ------------------------------------------------------------ exit codes ---- */

test('CLI: `gate` exit codes are the documented contract', async (t) => {
  const fx = await fixture('cli-gate');
  t.after(() => fx.cleanup());

  const disposable = await holt(['gate', 'spent', '--cwd', fx.root], fx.root);
  assert.equal(disposable.code, 0, 'disposable must exit 0');

  const holding = await holt(['gate', 'holds', '--cwd', fx.root], fx.root);
  assert.equal(holding.code, 1, 'holds unique work must exit 1 — scripts branch on this');

  const missing = await holt(['gate', 'no-such-thing', '--cwd', fx.root], fx.root);
  assert.equal(missing.code, 2, 'unknown must exit 2, never 0');
});

test('CLI: a FAILED rescue must exit non-zero', async (t) => {
  const fx = await newRepo('cli-rescue-exit');
  t.after(() => fx.cleanup());

  const wt = await fx.worktree('nested-holder');
  await fx.write('src/normal.js', 'export function NORMAL() {}\n', wt);
  // A nested git repo makes the capture genuinely partial.
  await fs.mkdir(path.join(wt, 'nested'), { recursive: true });
  await new Promise((res) => execFile('git', ['init', '-q'], { cwd: path.join(wt, 'nested') }, res));
  await fs.writeFile(path.join(wt, 'nested', 'inner.txt'), 'INNER\n');

  const r = await holt(['rescue', 'nested-holder', '--cwd', fx.root], fx.root);
  // THE CONTRACT: `holt rescue X && git worktree remove X` must STOP here. Exiting 0 on an
  // unverified capture would make that chain destroy work.
  assert.equal(r.code, 1, `an incomplete rescue must exit non-zero, got ${r.code}: ${r.stdout.slice(0, 200)}`);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.ok, false);
  assert.match(payload.error, /INCOMPLETE/);
});

test('CLI: a successful rescue exits 0 and reports a verified ref', async (t) => {
  const fx = await fixture('cli-rescue-ok');
  t.after(() => fx.cleanup());

  const r = await holt(['rescue', 'holds', '--cwd', fx.root], fx.root);
  assert.equal(r.code, 0, `a clean rescue must exit 0: ${r.stdout.slice(0, 200)}`);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.verified, true);
  assert.match(payload.ref, /^refs\/holt\/rescue\//);
});

test('CLI: `rescue` with no id is an error, not a silent no-op', async (t) => {
  const fx = await fixture('cli-rescue-noid');
  t.after(() => fx.cleanup());

  const r = await holt(['rescue', '--cwd', fx.root], fx.root);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /needs a workstream id/);
});

test('CLI: an unknown command exits non-zero and says so', async (t) => {
  const fx = await fixture('cli-unknown');
  t.after(() => fx.cleanup());

  const r = await holt(['definitely-not-a-command', '--cwd', fx.root], fx.root);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /unknown command/);
});

test('CLI: a non-repository exits 2 rather than crashing', async () => {
  const r = await holt(['status', '--cwd', '/nonexistent/definitely/not/a/repo'], '/');
  assert.equal(r.code, 2);
  assert.match(r.stderr, /not a git repository/);
});

/* --------------------------------------------------- destructive defaults ---- */

test('CLI: `clean` does NOT delete without --apply', async (t) => {
  const fx = await fixture('cli-clean-default');
  t.after(() => fx.cleanup());

  const r = await holt(['clean', '--cwd', fx.root], fx.root);
  assert.equal(r.code, 0);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.dryRun, true, 'clean must be dry-run by default at the CLI too');

  // And the worktree is still there.
  assert.ok(await fs.stat(fx.wt('spent')).then(() => true, () => false),
    'dry-run must not have deleted anything');
});

test('CLI: `protect --dry-run` locks nothing', async (t) => {
  const fx = await fixture('cli-protect-dry');
  t.after(() => fx.cleanup());

  const r = await holt(['protect', '--dry-run', '--cwd', fx.root], fx.root);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.dryRun, true);

  // A dry run must leave the worktree removable.
  const rm = await new Promise((res) => {
    execFile('git', ['worktree', 'remove', '--force', fx.wt('holds')], { cwd: fx.root },
      (err) => res(err ? 1 : 0));
  });
  assert.equal(rm, 0, 'protect --dry-run must not have actually locked anything');
});

test('CLI: --help lists every command that exists', async (t) => {
  const fx = await fixture('cli-help');
  t.after(() => fx.cleanup());

  const r = await holt(['--help'], fx.root);
  for (const cmd of [
    'status', 'risk', 'collisions', 'duplicates', 'context', 'plan', 'impact',
    'graph', 'gate', 'doctor', 'protect', 'rescue', 'clean', 'integrate', 'brief', 'mcp',
  ]) {
    assert.match(r.stdout, new RegExp(`\\b${cmd}\\b`),
      `--help does not mention '${cmd}' — an undocumented command is an unreachable one`);
  }
});

test('FIRST RUN: a repo with no commits gets a one-line message, never a stack trace', async (t) => {
  // The single most common first-run state: create a repo, run the tool before committing.
  // This previously printed a Node stack trace containing the maintainer's own file paths.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-empty-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await new Promise((res) => execFile('git', ['init', '-q', '-b', 'main'], { cwd: dir }, res));

  for (const cmd of [[], ['status'], ['risk'], ['plan']]) {
    const r = await holt(cmd, dir);
    assert.equal(r.code, 2, `holt ${cmd.join(' ') || '(default)'} should exit 2, got ${r.code}`);
    assert.ok(!/node:internal|\bat async\b/.test(r.stderr), `no stack trace, got: ${r.stderr.slice(0, 200)}`);
    assert.match(r.stderr, /empty repository|base ref/i, 'and must explain the state in plain words');
  }
});

test('FIRST RUN: branches outside a repo matches every other command', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-nogit-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const cmd of ['branches', 'status']) {
    const r = await holt([cmd], dir);
    assert.equal(r.code, 2, `${cmd} outside a repo must exit 2, got ${r.code}`);
    assert.ok(!/node:internal|\bat async\b/.test(r.stderr), `${cmd} must not print a stack trace`);
    assert.match(r.stderr, /not a git repository/i);
  }
});

test('SCRIPTABILITY: context exits non-zero for an unknown id, zero for a real one', async (t) => {
  const fx = await newRepo('ctx-exit');
  t.after(() => fx.cleanup());
  await fx.worktree('realwt');

  const bad = await holt(['context', 'no-such-id'], fx.root);
  assert.notEqual(bad.code, 0, 'an unknown id is a failed lookup, not a successful empty answer');

  const good = await holt(['context', 'realwt'], fx.root);
  assert.equal(good.code, 0, `a real id must succeed: ${good.stderr}`);
});

test('INSTALLER: --install never runs anything without explicit consent', async (t) => {
  // An installer that silently runs package managers is a bigger footgun than the missing
  // dependency it fixes — especially for a tool whose whole pitch is "no surprises on your
  // machine". Without a TTY and without --yes it must PRINT the command and stop.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-install-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await new Promise((res) => execFile('git', ['init', '-q', '-b', 'main'], { cwd: dir }, res));
  await new Promise((res) => execFile('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: dir }, res));

  // Strip the optional backends from PATH so doctor sees them as missing.
  const fake = path.join(dir, 'bin');
  await fs.mkdir(fake, { recursive: true });
  for (const b of ['node', 'git', 'sh']) {
    const which = await new Promise((r) => execFile('sh', ['-c', `command -v ${b}`], (e, o) => r(String(o).trim())));
    if (which) await fs.symlink(which, path.join(fake, b)).catch(() => {});
  }

  const r = await new Promise((resolve) => {
    const child = execFile(process.execPath, [BIN, 'doctor', '--install', '--cwd', dir], {
      cwd: dir, timeout: 60_000, env: { ...process.env, PATH: fake, NO_COLOR: '1' },
    }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) }));
    child.stdin?.end(); // no TTY, no input
  });

  // It may either find no package manager, or print the command and stop for confirmation.
  // What it must NEVER do is claim to have installed anything.
  assert.ok(!/installing…[\s\S]*done —/.test(r.stdout),
    `must not run an installer without consent: ${r.stdout.slice(0, 300)}`);
  assert.match(r.stdout, /no supported package manager|re-run with --yes|holt will run/,
    'and must explain what it would do or why it cannot');
});
