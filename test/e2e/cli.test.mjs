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

test('CLI: `gate` and `rescue` must not give a script two different answers', async (t) => {
  const fx = await newRepo('cli-parity');
  t.after(() => fx.cleanup());

  await fx.write('.gitignore', 'notes.local\nsecrets/\n');
  await fx.commit('ignore rules');
  const wt = await fx.worktree('w1');
  await fx.write('notes.local', 'an hour of hand-written notes\n', wt);
  await fx.write('secrets/prod.env', 'API_KEY=live-do-not-lose\n', wt);

  // MEASURED, AND THIS IS THE WHOLE DEFECT: `gate` exited 1 saying HOLDS UNIQUE WORK while
  // `rescue` exited 0 saying "this worktree holds nothing base lacks". A script chaining
  //     holt rescue w1 && git worktree remove w1
  // trusts the 0 and deletes the only copy of the credentials.
  const gate = await holt(['gate', 'w1', '--cwd', fx.root], fx.root);
  assert.equal(gate.code, 1, `gate must refuse: ${gate.stdout}${gate.stderr}`);

  const resc = await holt(['rescue', 'w1', '--cwd', fx.root], fx.root);
  const payload = JSON.parse(resc.stdout);
  assert.notEqual(payload.nothingToRescue, true,
    `rescue must not report nothing-to-rescue for work gate refuses on: ${resc.stdout}`);

  // Either it captured the work (exit 0 with a verified ref) or it refused and NAMED what it
  // could not capture (non-zero). Silence with exit 0 is the one outcome that is never allowed.
  if (payload.ok === true) {
    assert.equal(resc.code, 0);
    assert.equal(payload.verified, true, `a success must be verified: ${resc.stdout}`);
    assert.ok(payload.commit, 'and must name the commit that now holds the work');
  } else {
    assert.equal(resc.code, 1, 'a refusal must exit non-zero so the chain stops');
    assert.ok((payload.missing?.length ?? 0) + (payload.blind?.length ?? 0) > 0,
      `a refusal must NAME what could not be captured: ${resc.stdout}`);
  }

  // NEVER-WORSE, at the same layer: an empty worktree still exits 0 with nothing-to-rescue.
  await fx.worktree('spent');
  const empty = await holt(['rescue', 'spent', '--cwd', fx.root], fx.root);
  assert.equal(empty.code, 0, `an empty worktree must still exit 0: ${empty.stdout}${empty.stderr}`);
  assert.equal(JSON.parse(empty.stdout).nothingToRescue, true);
  const emptyGate = await holt(['gate', 'spent', '--cwd', fx.root], fx.root);
  assert.equal(emptyGate.code, 0, 'and gate must agree it is disposable');
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

test('FIRST RUN: no worktrees yet gets an honest message, never a silent all-clear', async (t) => {
  // The overwhelmingly common first run: a git repo that nobody has fanned out of yet. Every
  // count in `status` and `risk` is zero here for a reason that has NOTHING to do with the
  // repository's health — there was nothing to compare against — and printing the exact same
  // all-zero table (or "Nothing unique anywhere. Every workstream is reproducible from base.")
  // that a genuinely clean multi-worktree scan would print reads as a verified all-clear to
  // someone who has simply not run `git worktree add` yet.
  const fx = await newRepo('no-siblings');
  t.after(() => fx.cleanup());

  const risk = await holt(['risk', '--cwd', fx.root], fx.root);
  assert.equal(risk.code, 0, `risk exited ${risk.code}: ${risk.stderr}`);
  assert.match(risk.stdout, /no other worktrees yet/i,
    `risk must say WHY everything is zero — and "no OTHER worktrees": the primary exists and the reader is in it, got: ${risk.stdout}`);
  assert.ok(!/Nothing unique anywhere/.test(risk.stdout),
    'must not print the "verified clean" verdict when nothing was ever compared');

  const status = await holt(['status', '--cwd', fx.root], fx.root);
  assert.equal(status.code, 0, `status exited ${status.code}: ${status.stderr}`);
  assert.match(status.stdout, /no other worktrees yet/i,
    `status must say WHY every DECISIONS row is zero, got: ${status.stdout}`);

  // `holt brief` collapses onto the same fixed sentence regardless of WHY there was nothing to
  // say — indistinguishable from "not a repo" and from "genuinely nothing to report".
  const brief = await holt(['brief', '--cwd', fx.root], fx.root);
  assert.equal(brief.code, 0);
  assert.match(brief.stdout, /no other worktrees yet/i, `brief got: ${brief.stdout}`);
  assert.ok(!/no parallel workstream findings/.test(brief.stdout),
    'the old fixed sentence must be gone');
});

test('FIRST RUN: `setup` outside a repository fails fast, not mid-sentence', async (t) => {
  // Previously: `holt setup` printed the FULL backends section and the FULL agent-wiring
  // section, THEN reached step 3's buildReport(), which calls process.exit(2) directly —
  // bypassing the try/catch wrapped around it — and died with no indication of what to do.
  // The one command every artifact tells a new user to run first must not do that.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-setup-nogit-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const r = await holt(['setup', '--cwd', dir], dir);
  assert.equal(r.code, 2, `setup outside a repo should exit 2, got ${r.code}: ${r.stdout}`);
  assert.ok(!/node:internal|\bat async\b/.test(r.stdout + r.stderr), 'must not print a stack trace');
  assert.match(r.stderr, /not a git repository/i);
  // And must not have printed the sections that promise things this directory cannot deliver
  // (the intro tagline itself says "agent wiring" in passing, so check for the numbered step).
  assert.ok(!/1\. analysis backends|2\. agent wiring/.test(r.stdout),
    `must fail before step 1/2, got: ${r.stdout}`);
});

test('FIRST RUN: a bare repository is diagnosed correctly, not called "not a git repository"', async (t) => {
  // A bare repo IS a real git repository — it just has no working tree. `not a git repository`
  // is simply false there, and holt exists to give people accurate information about their own
  // repositories. Cover every command a first-run user is told to run.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-bare-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bare = path.join(dir, 'repo.git');
  await new Promise((res, rej) => execFile('git', ['init', '-q', '--bare', '-b', 'main', bare], (e) => (e ? rej(e) : res())));

  for (const cmd of [['status'], ['risk'], ['integrate']]) {
    const r = await holt([...cmd, '--cwd', bare], bare);
    assert.equal(r.code, 2, `${cmd[0]} in a bare repo should exit 2, got ${r.code}`);
    assert.ok(!/node:internal|\bat async\b/.test(r.stderr), `${cmd[0]} must not print a stack trace`);
    assert.match(r.stderr, /bare repository/i, `${cmd[0]} must name the actual state, got: ${r.stderr}`);
    assert.ok(!/^holt: not a git repository/im.test(r.stderr),
      `${cmd[0]} must not claim this is not a git repository at all, got: ${r.stderr}`);
  }

  const setup = await holt(['setup', '--cwd', bare], bare);
  assert.equal(setup.code, 2, `setup in a bare repo should exit 2, got ${setup.code}`);
  assert.match(setup.stderr, /bare repository/i, `setup got: ${setup.stderr}`);

  const doctor = await holt(['doctor', '--cwd', bare, '--json'], bare);
  assert.equal(doctor.code, 0, `doctor should still exit 0 in a bare repo: ${doctor.stderr}`);
  const info = JSON.parse(doctor.stdout);
  assert.equal(info.bare, true, `doctor --json must flag bare:true, got: ${doctor.stdout}`);

  const brief = await holt(['brief', '--cwd', bare], bare);
  assert.equal(brief.code, 0);
  assert.match(brief.stdout, /bare repository/i, `brief got: ${brief.stdout}`);
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

test('CLI: --version answers, in every spelling people actually try', async () => {
  // holt answered none of these. A bug report that cannot name the version that produced it is
  // not actionable, and `--version` is the first thing anyone runs against an unfamiliar binary.
  const { version } = JSON.parse(await fs.readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  for (const flag of ['--version', '-v', '-V', 'version']) {
    const r = await holt([flag], process.cwd());
    assert.equal(r.code, 0, `holt ${flag} must exit 0, got ${r.code}: ${r.stderr}`);
    assert.match(r.stdout, new RegExp(`holt ${version.replace(/\./g, '\\.')}`),
      `holt ${flag} must print the package version, got: ${r.stdout || r.stderr}`);
  }
});

test('FIRST RUN: a bare repo WITH linked worktrees answers from the bare side — the canonical layout is not a dead end', async (t) => {
  // Adversarial review refuted the bare-repo refusal above with the layout it is FOR: `repo.git`
  // plus linked checkouts is the recommended way to run worktrees, `git worktree list` from the
  // bare side enumerates every checkout, and the old message ("needs at least one checkout; run
  // it from a normal clone instead") was false in both halves — there were two checkouts, and
  // there was no clone to run from. Discovery now re-roots at the first live checkout; the
  // refusal survives only where its message is true (a bare repo with NO worktrees — the test
  // above, which stays).
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-bare-wt-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bare = path.join(dir, 'repo.git');
  const sh = (args, cwd) => new Promise((res, rej) =>
    execFile('git', args, { cwd }, (e, so, se) => (e ? rej(new Error(String(se))) : res(String(so)))));
  await sh(['init', '-q', '--bare', '-b', 'main', bare], dir);
  await sh(['-C', bare, 'worktree', 'add', '-q', '--orphan', '-b', 'main', path.join(dir, 'wt-a')], dir);
  await sh(['config', 'user.email', 't@t'], path.join(dir, 'wt-a'));
  await sh(['config', 'user.name', 't'], path.join(dir, 'wt-a'));
  await fs.writeFile(path.join(dir, 'wt-a', 'a.txt'), 'base\n');
  await sh(['add', '-A'], path.join(dir, 'wt-a'));
  await sh(['commit', '-qm', 'base'], path.join(dir, 'wt-a'));
  await sh(['-C', bare, 'worktree', 'add', '-q', '-b', 'feat-b', path.join(dir, 'wt-b'), 'main'], dir);
  await fs.writeFile(path.join(dir, 'wt-b', 'only.js'), 'export function UNIQUE_B() { return 1; }\n');

  const r = await holt(['risk', '--cwd', bare], bare);
  assert.equal(r.code, 0, `risk from the bare side must answer, got exit ${r.code}: ${r.stderr}`);
  assert.doesNotMatch(r.stderr + r.stdout, /run it from a normal clone/,
    'the false prescription must be gone for the layout that has no clone to run from');
  assert.match(r.stdout, /wt-b/, `wt-b must be scanned from the bare side: ${r.stdout}`);
  assert.match(r.stdout, /unique-work-uncommitted|uncommitted/,
    `wt-b's uncommitted-only work must be found: ${r.stdout}`);
});

test('FIRST RUN: the solo-repo caveat — a dirty, unscanned primary is NAMED beside every all-clear', async (t) => {
  // The commonest first-run shape there is: one repository, no fan-out, uncommitted-only work in
  // the primary. "Nothing unique anywhere. Every workstream is reproducible from base." was true
  // of the zero workstreams scanned and false of the repository — and the prescribed remedy
  // (add a worktree, re-run) produced the same false all-clear. The verdict now carries the
  // caveat naming what holt is NOT auditing, in both shapes, with the command that covers it.
  const fx = await newRepo('solo-caveat');
  t.after(() => fx.cleanup());
  await fx.write('newfile.mjs', 'export function UNCOMMITTED_CRITICAL() {}\n');

  const solo = await holt(['risk', '--cwd', fx.root], fx.root);
  assert.match(solo.stdout, /primary worktree .* holds 1 uncommitted change/,
    `solo: the dirty primary must be named: ${solo.stdout}`);
  assert.match(solo.stdout, /--include-primary/, 'and the covering command must be named');

  await fx.git(['worktree', 'add', '-q', '-b', 'spawned', path.join(fx.root, '..', 'solo-caveat-sib'), 'main']);
  const withSib = await holt(['risk', '--cwd', fx.root], fx.root);
  assert.match(withSib.stdout, /primary worktree .* holds 1 uncommitted change/,
    `with a sibling: the caveat must survive beside the real verdict: ${withSib.stdout}`);

  // And --include-primary actually covers it — the caveat is a pointer, not a dead end.
  const covered = await holt(['risk', '--include-primary', '--cwd', fx.root], fx.root);
  assert.match(covered.stdout, /unique-work-uncommitted/,
    `--include-primary must surface the primary's at-risk work: ${covered.stdout}`);
});

test('FIRST RUN: `holt brief` never fabricates a clean bill when the scan could not answer', async (t) => {
  // Adversarial review reproduced this with two mundane breakages (an unreadable .git pointer, a
  // missing base object): buildBrief() returns null for "clean", "scan threw" AND "every sibling
  // skipped", and the CLI printed "every sibling workstream is clean right now" at exit 0 while
  // `holt status` in the same repo said "scanned 0/2 · 2 skipped". Fail-open on missing evidence,
  // in the one channel agents read. The claim is now made only after re-deriving the scan.
  // THE FAULT MUST BE REAL ON THIS PLATFORM: the original shape here was `chmod(sib/.git, 0o000)`,
  // and Node's chmod on Windows only toggles the read-only bit — NTFS has no POSIX mode — so on
  // every Windows run the pointer stayed readable, the scan answered normally, and this test
  // asserted the product's response to a fault that was never injected. It failed for the right
  // reason (the brief was correct; the fixture was not), which is the worst kind of red: it reads
  // as a product defect on the one platform holt is least proven on.
  //
  // So the fault is a broken gitdir POINTER, real on every filesystem, and it is only asserted
  // against after `holt status` confirms the workstream really did become unscannable.
  const faults = [
    ['the .git pointer names a gitdir that does not exist', 'gitdir: /nonexistent/holt-broken-gitdir\n'],
    ['the .git pointer is not parseable at all', ' not a gitdir pointer at all\n'],
  ];
  // A POSIX-only EXTRA shape: an unreadable pointer and a pointer-to-nowhere reach the scan
  // through different errno paths, so both are worth grading where both are expressible.
  if (process.platform !== 'win32') faults.push(['the .git pointer is unreadable', null]);

  // ONE FIXTURE PER FAULT, rather than rewriting `.git` in place between iterations. On Windows
  // the second rewrite failed with EPERM — a file git and holt had just had open is not reliably
  // reopenable for writing there — so the loop died in the fixture again rather than in the code
  // under test. A fault injected into a fresh repository also grades each shape independently,
  // which is what the assertions claim to be doing.
  for (const [i, [what, pointerText]] of faults.entries()) {
    const fx = await newRepo('brief-truth');
    t.after(() => fx.cleanup());
    const sib = path.join(fx.root, '..', `brief-truth-sib-${i}`);
    await fx.git(['worktree', 'add', '-q', '-b', 'sib2', sib, 'main']);
    await fs.writeFile(path.join(sib, 'unique.txt'), 'only here\n');

    // Healthy shape first (anti-vacuity): with a real dirty sibling the brief has plenty to say.
    const healthy = await holt(['brief', '--cwd', fx.root], fx.root);
    assert.match(healthy.stdout, /holt/, `sanity: ${healthy.stdout}`);
    assert.doesNotMatch(healthy.stdout, /clean right now/,
      'a repo with a dirty sibling must never read as clean');

    if (pointerText === null) await fs.chmod(path.join(sib, '.git'), 0o000);
    else await fs.writeFile(path.join(sib, '.git'), pointerText);
    t.after(() => fs.chmod(path.join(sib, '.git'), 0o644).catch(() => {}));

    // ANTI-VACUITY: prove the fault landed before grading the response to it.
    const st = await holt(['status', '--json', '--cwd', fx.root], fx.root);
    const scanned = JSON.parse(st.stdout);
    assert.equal(scanned.counts.scanned, 0,
      `${what}: the fault must actually make the workstream unscannable on this platform, `
      + `got counts ${JSON.stringify(scanned.counts)}`);
    assert.ok((scanned.skipped ?? []).some((w) => w.reason),
      `${what}: and the skip must be named with a reason, got: ${JSON.stringify(scanned.skipped)}`);

    const broken = await holt(['brief', '--cwd', fx.root], fx.root);
    assert.doesNotMatch(broken.stdout, /clean right now/,
      `${what}: a scan that could not answer must never print the clean bill: ${broken.stdout}`);
    assert.match(broken.stdout + broken.stderr, /could not (be )?scan|cannot vouch/i,
      `${what}: the brief must say it cannot vouch: ${broken.stdout} ${broken.stderr}`);
    assert.notEqual(broken.code, 0, `${what}: and it must not exit 0 while unable to vouch`);
  }
});
