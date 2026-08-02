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

  // THE CONTRACT CHANGED, AND FOR THE BETTER: holt now SCANS the only worktree, so the risk
  // verdict here is earned rather than vacuous. What is still empty for a reason unrelated to the
  // repository's health is the COMPARISON — collisions, duplicates, families — and that is what
  // has to be said out loud, because zero-because-nothing-to-compare and zero-because-verified
  // look identical in the output.
  const risk = await holt(['risk', '--cwd', fx.root], fx.root);
  assert.equal(risk.code, 0, `risk exited ${risk.code}: ${risk.stderr}`);
  assert.match(risk.stdout, /only the primary worktree/i,
    `risk must say the repo has no siblings yet, got: ${risk.stdout}`);
  assert.match(risk.stdout, /nothing to compare against yet/i,
    `and WHY the cross-worktree findings are empty, got: ${risk.stdout}`);
  assert.match(risk.stdout, /scanned\s+1\/1/,
    `the one worktree must actually have been scanned, got: ${risk.stdout}`);

  const status = await holt(['status', '--cwd', fx.root], fx.root);
  assert.equal(status.code, 0, `status exited ${status.code}: ${status.stderr}`);
  assert.match(status.stdout, /only the primary worktree/i,
    `status must say WHY every comparison row is zero, got: ${status.stdout}`);

  // TWO DIFFERENT AUDIENCES, TWO DIFFERENT CONTRACTS.
  //
  // A human who typed `holt brief` asked a question and deserves an answer, so one line of
  // orientation is right — provided it does not claim an all-clear it did not earn.
  const brief = await holt(['brief', '--cwd', fx.root], fx.root);
  assert.equal(brief.code, 0);
  assert.match(brief.stdout, /no other worktrees yet/i, `brief got: ${brief.stdout}`);
  assert.ok(!/no parallel workstream findings/.test(brief.stdout),
    'the old fixed sentence must be gone');

  // The HOOKS are injected into an agent's context unprompted, on every message and every turn,
  // forever. There, orientation with no news is noise, and noise on a clean repo is how a hook
  // gets uninstalled — which costs all of the protection it was providing. Every event must be
  // completely silent when there is nothing to say.
  for (const event of ['user-prompt-submit', 'session-start', 'stop']) {
    const h = await holt(['hook', event, '--host', 'claude-code', '--cwd', fx.root], fx.root);
    assert.equal(h.code, 0, `hook ${event} must exit 0 on a clean repo: ${h.stderr}`);
    assert.equal(h.stdout.trim(), '',
      `hook ${event} must be SILENT on a clean solo repo, got: ${JSON.stringify(h.stdout)}`);
  }
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

  // SOLO: there is no caveat to print any more, because there is nothing unaudited — holt scans
  // the only worktree and reports its at-risk work directly. A caveat pointing at a flag was
  // always the second-best answer; measuring the thing is the best one.
  const solo = await holt(['risk', '--cwd', fx.root], fx.root);
  assert.match(solo.stdout, /UNCOMMITTED_CRITICAL|unique-work-uncommitted/,
    `solo: the primary's at-risk work must be reported directly, no flag required: ${solo.stdout}`);
  assert.doesNotMatch(solo.stdout, /is NOT auditing/,
    `and nothing should be declared unaudited when it was audited: ${solo.stdout}`);

  // WITH A SIBLING the original design applies again: the primary drops out of the verdict so the
  // agent signal is not buried, and the caveat carries it instead — on the path with findings in
  // it, which is the one anybody with a fan-out running actually reads.
  await fx.git(['worktree', 'add', '-q', '-b', 'spawned', path.join(fx.root, '..', 'solo-caveat-sib'), 'main']);
  await fx.write('sib.mjs', 'export function SIB_WORK() {}\n', path.join(fx.root, '..', 'solo-caveat-sib'));
  const withSib = await holt(['risk', '--cwd', fx.root], fx.root);
  assert.match(withSib.stdout, /primary worktree .* holds 1 uncommitted change/,
    `with a sibling: the caveat must survive beside the real verdict: ${withSib.stdout}`);
  assert.match(withSib.stdout, /--include-primary/, 'and the covering command must be named');

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

    if (pointerText === null) {
      await fs.chmod(path.join(sib, '.git'), 0o000);
    } else {
      // UNLINK FIRST. git creates a linked worktree's `.git` pointer as a HIDDEN file on Windows,
      // and Node's fs.writeFile opens an existing hidden file with EPERM there — so the fixture
      // died in setup on every Windows run, at the very first fault, and reported it as a failure
      // of the brief. Removing then creating is allowed, and is a no-op difference elsewhere.
      await fs.rm(path.join(sib, '.git'), { force: true });
      await fs.writeFile(path.join(sib, '.git'), pointerText);
    }
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

test('INTEGRATE: --dry-run writes NOTHING, and says what it would have written', async (t) => {
  // `--dry-run` was accepted by the global argument parser and ignored. `holt integrate
  // --dry-run` exited 0 having created .mcp.json, installed a git pre-commit hook and edited
  // AGENTS.md — 21 files — while printing "created"/"refreshed" in the past tense as though it
  // were previewing. The flag is documented on protect/rescue/discard/clean, so a user has every
  // reason to expect it on the command that touches the most files by an order of magnitude.
  const fx = await newRepo('integrate-dry');
  t.after(() => fx.cleanup());

  const before = (await fs.readdir(fx.root)).sort();
  const r = await holt(['integrate', '--dry-run', '--cwd', fx.root], fx.root);
  assert.equal(r.code, 0, `dry run must succeed: ${r.stdout} ${r.stderr}`);

  // GRADE FROM THE FILESYSTEM. The claim is about what is on disk, not about what was printed.
  assert.deepEqual((await fs.readdir(fx.root)).sort(), before,
    'a dry run must not create a single file in the repository root');
  for (const f of ['.mcp.json', 'AGENTS.md', '.claude/settings.json', '.git/hooks/pre-commit']) {
    await assert.rejects(fs.stat(path.join(fx.root, f)), `${f} must not exist after a dry run`);
  }

  // ANTI-VACUITY: it must have actually planned something, or "wrote nothing" is trivially true.
  assert.match(r.stdout, /DRY RUN/, r.stdout);
  assert.match(r.stdout, /would CREATE \d+ file\(s\)/, r.stdout);
  assert.match(r.stdout, /\.mcp\.json/, `the plan must name the files: ${r.stdout}`);
  assert.match(r.stdout, /pre-commit/, `including the git hook: ${r.stdout}`);

  // And --json carries the same plan, so a wrapper can gate on it.
  const j = await holt(['integrate', '--dry-run', '--json', '--cwd', fx.root], fx.root);
  const plan = JSON.parse(j.stdout);
  assert.equal(plan.dryRun, true);
  assert.ok(plan.planned.length > 5, `the JSON plan must list targets: ${j.stdout.slice(0, 300)}`);
  assert.ok(plan.planned.every((p) => p.file && p.action), 'every planned row names a file and an action');
  assert.deepEqual((await fs.readdir(fx.root)).sort(), before, 'the --json dry run must also write nothing');
});

test('HOOK: answers and EXITS while the host still holds stdin open', async (t) => {
  // MEASURED: the verdict was computed and printed, and then holt sat there — the 'data'/'end'
  // listeners keep the event loop alive for as long as the host holds the pipe. A producer that
  // wrote the payload and kept stdin open for 25 seconds blocked holt for the full 25.
  //
  // Claude Code, Cursor and every other host that reuses one descriptor across a session does
  // exactly that, so this was a guard that stalled EVERY tool call for as long as the host held
  // the pipe. A guard that makes the agent unusable gets uninstalled the same day, which costs
  // all of the protection it was providing.
  const fx = await newRepo('hook-stdin');
  t.after(() => fx.cleanup());
  await fx.worktree('sib');

  const payload = JSON.stringify({
    tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: fx.root,
  });

  const started = Date.now();
  const { out, code } = await new Promise((resolve) => {
    const child = execFile(process.execPath, [BIN, 'hook', 'pre-tool-use', '--cwd', fx.root], {
      cwd: fx.root, timeout: 60_000, env: { ...process.env, NO_COLOR: '1' },
    }, (err, stdout) => resolve({ out: String(stdout ?? ''), code: err ? (err.code ?? 1) : 0 }));
    child.stdin.write(payload);
    // DELIBERATELY NOT CLOSED. This is the whole test: the host is still holding the pipe.
    const hold = setTimeout(() => { try { child.stdin.end(); } catch { /* already gone */ } }, 30_000);
    child.on('exit', () => clearTimeout(hold));
  });
  const elapsed = Date.now() - started;

  // THE THRESHOLD IS THE POINT, and a loose one made this test vacuous on the first attempt: at
  // 15 s it passed against the unfixed code, which answered in 4.2 s — the readStdin timeout —
  // and only hung indefinitely in some host shapes. The property that actually holds is stronger
  // and always observable: a COMPLETE payload must never pay the stdin timeout at all. Unfixed
  // that is ~4.2 s (the timeout, every time, on every tool call); fixed it is ~0.6 s.
  assert.ok(elapsed < 2_500,
    `a complete payload must be answered without waiting out the stdin timeout — took ${elapsed}ms `
    + 'with the pipe held open (unfixed: ~4200ms, the full readStdin timeout)');
  assert.ok(out.trim().length > 0, `and it must still answer: ${JSON.stringify(out)}`);
  assert.doesNotThrow(() => JSON.parse(out), `the answer must be the usual JSON: ${out}`);
  assert.equal(code, 0, 'a benign command is allowed, exit 0');
});

test('HOOK: NEVER-WORSE — a closed pipe still gets the right verdict, deny included', async (t) => {
  // The other direction. A readStdin that resolved too eagerly — on the first chunk, say — would
  // satisfy the timing test above and then grade a truncated payload, which is a guard reading
  // half a command. Both the allow and the deny path are asserted on a normally-closed pipe.
  const fx = await newRepo('hook-closed');
  t.after(() => fx.cleanup());
  await fx.worktree('sib');
  await fx.write('only.js', 'export function HOOK_SOLE_COPY() {}\n', fx.wt('sib'));

  const run = (command, cwd) => new Promise((resolve) => {
    const child = execFile(process.execPath, [BIN, 'hook', 'pre-tool-use', '--cwd', fx.root], {
      cwd: fx.root, timeout: 60_000, env: { ...process.env, NO_COLOR: '1' },
    }, (err, stdout) => resolve({ out: String(stdout ?? ''), code: err ? (err.code ?? 1) : 0 }));
    child.stdin.end(JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }));
  });

  const allowed = await run('git status', fx.root);
  assert.equal(JSON.parse(allowed.out).decision, 'allow', `benign must be allowed: ${allowed.out}`);

  const denied = await run(`rm -rf ${fx.wt('sib')}`, fx.root);
  const v = JSON.parse(denied.out);
  assert.equal(v.decision, 'deny', `destroying the only copy must be refused: ${denied.out}`);
  assert.match(v.reason, /HOOK_SOLE_COPY|nowhere else/, `and the refusal must name the work: ${v.reason}`);
});

/* ------------------------------------------- the solo repository is the common shape ---- */

/**
 * A REPOSITORY WITH ONE WORKTREE IS NOT A REPOSITORY WITH NOTHING IN IT.
 *
 * holt excludes the primary worktree from its scan, because in a fan-out the primary is the
 * human's tree rather than a dispatched agent and reporting on it buries the signal about the
 * agents. That reasoning is void when there are no agents — and one worktree is the commonest
 * shape there is, the shape of every first run, and the shape a user is in on the day they
 * install holt.
 *
 * MEASURED on a real repository belonging to another team, at one moment, two commands apart:
 *
 *   holt risk                    ->  scanned 0/0 workstreams · nothing at risk
 *   holt risk --include-primary  ->  ● interactive-textbook  9 uniq  24 uncomm
 *
 * The engineer reading the first one concluded holt reported no risk. The caveat WAS printed —
 * grey, parenthesised, under a headline that read as an all-clear — and that is the only test of
 * a caveat that matters. Hiding a repository's real risk behind a flag the user has to know to
 * pass is not a default; it is a trap with documentation.
 */
test('SOLO REPO: the only worktree is scanned by default, without a flag', async (t) => {
  const fx = await newRepo('solo-default');
  t.after(() => fx.cleanup());
  await fx.write('src/only.js', 'export function SOLO_ONLY_COPY() { return 1; }\n');

  // PRECONDITION: this really is a one-worktree repository.
  const wl = await fx.git(['worktree', 'list']);
  assert.equal(wl.trim().split('\n').length, 1, `PRECONDITION: exactly one worktree, got:\n${wl}`);

  const r = await holt(['risk', '--json', '--cwd', fx.root], fx.root);
  assert.equal(r.code, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.counts.scanned, 1, `the one worktree must be scanned: ${JSON.stringify(j.counts)}`);
  assert.ok(j.unique.length >= 1,
    `uncommitted work in the only worktree must be reported as at risk: ${JSON.stringify(j.unique)}`);
  assert.ok(JSON.stringify(j.unique).includes('SOLO_ONLY_COPY'),
    `and the symbol that exists nowhere else must be named: ${JSON.stringify(j.unique).slice(0, 400)}`);

  // The human-readable surface must agree — this is the one the engineer actually read.
  const human = await holt(['risk', '--cwd', fx.root], fx.root);
  assert.doesNotMatch(human.stdout, /no other worktrees yet/,
    `a solo repo must not be told its answer is about worktrees that do not exist: ${human.stdout}`);
  assert.match(human.stdout, /unique-work-uncommitted|SOLO_ONLY_COPY|uncomm/,
    `and it must show the risk: ${human.stdout}`);
});

test('SOLO REPO: NEVER-WORSE — a clean solo repo still reports nothing at risk', async (t) => {
  // The other direction. Scanning the primary must not invent risk where there is none, or the
  // first thing every new user sees is a false alarm.
  const fx = await newRepo('solo-clean');
  t.after(() => fx.cleanup());

  const j = JSON.parse((await holt(['risk', '--json', '--cwd', fx.root], fx.root)).stdout);
  assert.equal(j.counts.scanned, 1, 'the primary is scanned');
  assert.equal(j.counts.atRisk, 0, `a clean repo has nothing at risk: ${JSON.stringify(j.counts)}`);
  assert.deepEqual(j.unique.map((u) => u.verdict), ['nothing-unique'],
    `and the one workstream is reported as holding nothing unique: ${JSON.stringify(j.unique.map((u) => u.verdict))}`);
});

test('SOLO REPO: NEVER-WORSE — with siblings, the primary is still excluded and still named', async (t) => {
  // The original design holds the moment there is a fan-out to report on: the primary drops out
  // of the verdict and the caveat carries it instead. A fix for the solo case that also changed
  // this would bury the agent signal under the human's own working tree.
  const fx = await newRepo('solo-with-sibs');
  t.after(() => fx.cleanup());
  await fx.worktree('agent1');
  await fx.write('src/primary_work.js', 'export function PRIMARY_UNCOMMITTED() {}\n');
  await fx.write('src/agent_work.js', 'export function AGENT_UNCOMMITTED() {}\n', fx.wt('agent1'));

  const j = JSON.parse((await holt(['risk', '--json', '--cwd', fx.root], fx.root)).stdout);
  assert.equal(j.counts.scanned, 1, `only the sibling is scanned: ${JSON.stringify(j.counts)}`);
  assert.ok(!JSON.stringify(j.unique).includes('PRIMARY_UNCOMMITTED'),
    'the primary must stay out of the verdict when there are agents to report on');
  assert.ok(JSON.stringify(j.unique).includes('AGENT_UNCOMMITTED'),
    `the sibling's work must be reported: ${JSON.stringify(j.unique).slice(0, 300)}`);

  // ...and the thing holt is NOT auditing must still be named, with the covering command.
  const st = JSON.parse((await holt(['status', '--json', '--cwd', fx.root], fx.root)).stdout);
  assert.ok(st.primaryUnscanned, `the unscanned primary must still be declared: ${JSON.stringify(st).slice(0, 400)}`);
  assert.ok(st.primaryUnscanned.dirtyFiles >= 1, 'and it must say the primary is dirty');
  const human = await holt(['risk', '--cwd', fx.root], fx.root);
  assert.match(human.stdout, /--include-primary/, `the covering command must be named: ${human.stdout}`);
});

test('DISCARD: the human path prints the recovery route, not a pointer to nothing', async (t) => {
  // `holt discard` at a TTY printed exactly one grey line — "the edits you threw away are captured
  // in the ref above and recoverable" — with NO ref above it. No ref, no commit, no restore
  // command: a dangling reference to output that was never emitted, pointing the reader at
  // something that is not there, immediately after destroying their work. The JSON payload
  // carried `ref`, `commit`, `restore` and `inspect` all along; only the renderer dropped them,
  // and the renderer is what a person sees.
  //
  // This is what makes an aggressive guard tolerable: the escape hatch has to say how to escape.
  const fx = await newRepo('discard-ref');
  t.after(() => fx.cleanup());
  await fx.write('a.txt', 'committed\n');
  await fx.commit('base');
  await fx.write('a.txt', 'an hour of hand edits\n');
  await fx.write('junk.js', 'export function THROWAWAY() {}\n');

  // --plain forces the human renderer even though stdout is a pipe here.
  const r = await holt(['discard', 'a.txt', 'junk.js', '--plain', '--cwd', fx.root], fx.root);
  assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);

  assert.match(r.stdout, /refs\/holt\/discard\//,
    `the capture ref must be printed: ${r.stdout}`);
  assert.match(r.stdout, /restore with:.*git checkout refs\/holt\/discard\//,
    `and the exact command that brings it back: ${r.stdout}`);
  assert.match(r.stdout, /commit:\s*[0-9a-f]{7,}/, `and the commit that holds it: ${r.stdout}`);
  assert.match(r.stdout, /a\.txt/, `and which paths were touched: ${r.stdout}`);

  // THE REF MUST ACTUALLY EXIST AND ACTUALLY HOLD THE CONTENT — grade from the filesystem, not
  // from what was printed.
  const ref = /refs\/holt\/discard\/[^\s]+/.exec(r.stdout)[0];
  const show = await fx.git(['show', `${ref}:a.txt`]);
  assert.match(show, /an hour of hand edits/,
    `the printed ref must really hold the discarded content, got: ${JSON.stringify(show)}`);
});

/**
 * A GUARD THAT IS PRESENT AND INERT IS WORSE THAN AN ABSENT ONE, because its presence is what
 * stops anyone looking.
 *
 * MEASURED: the identical `rm -rf <worktree holding the only copy>` came back `deny` for Claude
 * Code's payload shape and `{"permission":"allow"}` for Cursor's. Cursor's `beforeShellExecution`
 * carries the command at the TOP LEVEL; holt only looked inside `tool_input`, found nothing, and
 * took the `!command` early-allow path.
 *
 * So every Cursor user had a deny hook installed, wired correctly, emitting a correctly-shaped
 * response — that permitted everything, while HOSTS.md listed Cursor as a deterministic blocker.
 */
test('HOOK PAYLOADS: every host shape reaches the same verdict', async (t) => {
  const fx = await newRepo('hook-shapes');
  t.after(() => fx.cleanup());
  await fx.worktree('victim');
  await fx.write('only.js', 'export function SHAPES_SOLE() {}\n', fx.wt('victim'));
  const target = fx.wt('victim');

  const shapes = {
    'claude-code': (cmd) => ({ tool_name: 'Bash', tool_input: { command: cmd }, cwd: fx.root }),
    cursor: (cmd) => ({ command: cmd, cwd: fx.root }),
    generic: (cmd) => ({ toolInput: { command: cmd }, cwd: fx.root }),
  };

  const drive = (host, payload) => new Promise((resolve) => {
    const child = execFile(process.execPath,
      [BIN, 'hook', 'pre-tool-use', '--host', host, '--cwd', fx.root],
      { cwd: fx.root, timeout: 120_000, env: { ...process.env, NO_COLOR: '1' } },
      (err, stdout) => resolve(String(stdout ?? '')));
    child.stdin.end(JSON.stringify(payload));
  });

  for (const [host, mk] of Object.entries(shapes)) {
    const denied = await drive(host, mk(`rm -rf ${target}`));
    assert.match(denied, /"(permissionDecision|permission|decision)"\s*:\s*"deny"/,
      `${host}: destroying the only copy must be refused in this host's own shape, got: ${denied}`);

    // NEVER-WORSE: a benign command must still be allowed, or the fix is "refuse everything".
    const allowed = await drive(host, mk('git status'));
    assert.match(allowed, /"(permissionDecision|permission|decision)"\s*:\s*"allow"/,
      `${host}: a benign command must still be allowed, got: ${allowed}`);
  }
});
