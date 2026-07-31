/**
 * `holt ci` — the gate, driven through the REAL binary.
 *
 * The unit and repository-level tests beside this one prove the policy layer behaves. They cannot
 * prove the CLI is WIRED to it, and that is where this product's defects have actually lived: a
 * rule that matched symbol identities instead of paths was green in every unit test it had. So
 * these spawn `bin/holt.mjs` and read exit codes, exactly as a CI job does.
 *
 * A LICENSE IS NOT NEEDED FOR ANY ASSERTION HERE, and that is deliberate rather than a compromise.
 * Every behaviour below is a REFUSAL, and holt establishes where its rules came from BEFORE it
 * asks whether the customer paid for them. That order is the correct one — "may these rules judge
 * this commit" is a question about the gate's own integrity, not about billing — and it is what
 * makes the security-critical paths testable in open CI with no secret in the repository.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const HOLT = fileURLToPath(new URL('../../bin/holt.mjs', import.meta.url));

function run(args, cwd, extraEnv = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [HOLT, ...args], {
      cwd, timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', LC_ALL: 'C', NO_COLOR: '1',
        // A stray license or CI variable in the developer's shell must not change what these
        // tests measure.
        HOLT_LICENSE: '', GITHUB_BASE_REF: '', GITHUB_HEAD_REF: '',
        CHANGE_TARGET: '', CI_MERGE_REQUEST_TARGET_BRANCH_NAME: '',
        BITBUCKET_PR_DESTINATION_BRANCH: '', SYSTEM_PULLREQUEST_TARGETBRANCH: '',
        ...extraEnv,
      },
    }, (err, stdout, stderr) => resolve({
      code: err ? (err.code ?? -1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''),
    }));
  });
}

function sh(cmd, args, cwd) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      cwd, timeout: 60_000,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'holt test', GIT_AUTHOR_EMAIL: 't@holt.invalid',
        GIT_COMMITTER_NAME: 'holt test', GIT_COMMITTER_EMAIL: 't@holt.invalid',
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', LC_ALL: 'C',
      },
    }, (err, stdout, stderr) => resolve({
      code: err ? (err.code ?? -1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''),
    }));
  });
}

const scratch = (label) =>
  fs.mkdtemp(path.join(process.env.HOLT_TMPDIR || os.tmpdir(), `holt-cigate-${label}-`));

const write = async (dir, rel, body) => {
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body, 'utf8');
};

const STRICT = JSON.stringify({ version: 1, rules: [{ id: 'no-abandoned', type: 'no-unlanded', severity: 'error' }] });

async function repo(dir, { branch = 'main', policy = STRICT } = {}) {
  await fs.mkdir(dir, { recursive: true });
  await sh('git', ['init', `--initial-branch=${branch}`, '-q'], dir);
  await sh('git', ['config', 'user.name', 'holt test'], dir);
  await sh('git', ['config', 'user.email', 't@holt.invalid'], dir);
  await sh('git', ['config', 'commit.gpgsign', 'false'], dir);
  await write(dir, 'README.md', '# r\n');
  if (policy !== null) await write(dir, '.holt/policy.json', policy);
  await sh('git', ['add', '-A'], dir);
  await sh('git', ['commit', '-m', 'base', '--no-verify'], dir);
  await sh('git', ['checkout', '-q', '-b', 'wip/abandoned'], dir);
  await write(dir, 'src/orphan.js', 'export const orphan = 1;\n');
  await sh('git', ['add', '-A'], dir);
  await sh('git', ['commit', '-m', 'never landed', '--no-verify'], dir);
  await sh('git', ['checkout', '-q', branch], dir);
  return dir;
}

/* ------------------------------------------------------------------------------ */

test('CLI: a policy the candidate cannot be judged by is REFUSED, exit 2, with the fix named', async (t) => {
  const root = await scratch('refuse');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  // `release` is named by none of holt's base candidates and there is no origin: the shape that
  // reaches `primary-head-fallback`, where the "base" holt would read rules from is HEAD itself.
  const dir = await repo(path.join(root, 'r'), { branch: 'release' });
  await sh('git', ['checkout', '-q', '-b', 'feature/x'], dir);
  await write(dir, '.holt/policy.json', JSON.stringify({ version: 1, rules: [{ id: 'n', type: 'no-unlanded', severity: 'warn' }] }));
  await sh('git', ['add', '-A'], dir);
  await sh('git', ['commit', '-m', 'relax', '--no-verify'], dir);

  const r = await run(['ci', '--json'], dir, { GITHUB_BASE_REF: 'release' });
  assert.equal(r.code, 2, `a gate that cannot establish its own authority must refuse: ${r.stdout}${r.stderr}`);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.code, 'POLICY_NO_AUTHORITY');
  assert.match(payload.reason, /--base/, 'the refusal must name the flag that fixes it');
});

test('CLI: with an explicit --base the same repository is judged by the BASE rules, exit 1', async (t) => {
  const root = await scratch('explicit');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = await repo(path.join(root, 'r'), { branch: 'release' });
  await sh('git', ['checkout', '-q', '-b', 'feature/x'], dir);
  // The attack, committed: downgrade every rule to a warning.
  await write(dir, '.holt/policy.json', JSON.stringify({ version: 1, rules: [{ id: 'n', type: 'no-unlanded', severity: 'warn' }] }));
  await sh('git', ['add', '-A'], dir);
  await sh('git', ['commit', '-m', 'relax', '--no-verify'], dir);

  const r = await run(['ci', '--json', '--base', 'release'], dir, { GITHUB_BASE_REF: 'release' });
  assert.notEqual(r.code, 0, `the candidate's own downgrade must not produce a green build: ${r.stdout}${r.stderr}`);
  const payload = JSON.parse(r.stdout || '{}');
  // UNCONDITIONAL. An earlier draft of this test wrapped the assertions below in
  // `if (payload.mode === 'policy')`, with the unlicensed exit as the else branch — and because
  // this suite runs with no license, the else branch is the one that ran and the assertions that
  // matter never executed once. A conditional assertion passes whichever way the attack goes,
  // which makes it worse than no test. `policySource` is reported on every outcome so this can
  // be checked without a license, and the verdict itself is covered against real git in
  // test/e2e/policy-authority.test.mjs.
  assert.equal(payload.policySource.from, 'base', 'the rules must come from the base, not the candidate');
  assert.equal(payload.policySource.trusted, true);
  assert.equal(payload.policySource.headProposesChange, true, 'the reviewer must be told the change edits the gate');
});

test('CLI: a malformed policy REFUSES loudly (exit 2) instead of passing the build', async (t) => {
  const root = await scratch('malformed');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = await repo(path.join(root, 'r'), { policy: '{ not json at all' });

  const r = await run(['ci', '--json'], dir);
  assert.equal(r.code, 2, `${r.stdout}${r.stderr}`);
  assert.equal(JSON.parse(r.stdout).code, 'POLICY_PARSE');
});

test('CLI: a rule that can never fire REFUSES (exit 2) — the green build nobody earned', async (t) => {
  const root = await scratch('vacuous');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = await repo(path.join(root, 'r'), {
    policy: JSON.stringify({ version: 1, rules: [{ id: 'p', type: 'protected-paths', paths: [] }] }),
  });

  const r = await run(['ci', '--json'], dir);
  assert.equal(r.code, 2, `${r.stdout}${r.stderr}`);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.code, 'POLICY_VACUOUS');
  assert.match(payload.reason, /enabled/, 'and it must say how to turn a rule off deliberately');
});

test('CLI: an unknown key REFUSES (exit 2) — a policy must not read strict and run inert', async (t) => {
  const root = await scratch('unknown');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = await repo(path.join(root, 'r'), {
    policy: JSON.stringify({ version: 1, rules: [{ id: 'n', type: 'no-unlanded', sevrity: 'warn' }] }),
  });

  const r = await run(['ci', '--json'], dir);
  assert.equal(r.code, 2, `${r.stdout}${r.stderr}`);
  assert.equal(JSON.parse(r.stdout).code, 'POLICY_SCHEMA');
});

test('CLI NEVER-WORSE: a repository with NO policy still behaves exactly as before', async (t) => {
  const root = await scratch('nopolicy');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = await repo(path.join(root, 'r'), { policy: null });

  const clean = await run(['ci', '--json'], dir);
  assert.equal(clean.code, 0, `report-only mode must stay green: ${clean.stdout}${clean.stderr}`);
  assert.equal(JSON.parse(clean.stdout).ok, true);

  const strict = await run(['ci', '--json', '--fail-on-unlanded'], dir);
  assert.equal(strict.code, 1, 'and the free inline flag must still fail the build');
  assert.match(JSON.parse(strict.stdout).failures.join(' '), /unlanded/);
});

test('CLI: an UNTRUSTED policy cannot cancel the inline flag the repository owner asked for', async (t) => {
  const root = await scratch('suppress');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  // The base carries no policy, so the working-tree copy is the only one there is — untrusted.
  const dir = await repo(path.join(root, 'r'), { policy: null });
  await sh('git', ['checkout', '-q', '-b', 'feature/x'], dir);
  // A policy whose every rule passes. Before, policy mode short-circuited the flags, so this
  // switched off --fail-on-unlanded and the build went green.
  await write(dir, '.holt/policy.json', JSON.stringify({
    version: 1, rules: [{ id: 'n', type: 'no-unlanded', exempt: ['wip/*'] }],
  }));

  const r = await run(['ci', '--json', '--fail-on-unlanded'], dir);
  assert.notEqual(r.code, 0, `an added permissive policy must not neutralise the flag: ${r.stdout}${r.stderr}`);
  const payload = JSON.parse(r.stdout || '{}');
  assert.equal(payload.policySource.from, 'worktree');
  assert.equal(payload.policySource.trusted, false, 'a policy the base never approved is never trusted');
  // That an untrusted policy cannot CANCEL the flag is asserted directly against gateVerdict and
  // against real git in test/e2e/policy-authority.test.mjs, which needs no license to run.
});
