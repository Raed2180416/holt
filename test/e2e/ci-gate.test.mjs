/**
 * `holt ci` — the team gate, attacked from the two directions that made it pass on no evidence.
 *
 * Both defects here share one shape, and it is the shape a gate must never have: THE SITUATION
 * WHERE holt KNOWS LEAST WAS THE SITUATION WHERE IT WAS MOST REASSURING.
 *
 *   1. THE SUBJECT SUPPLIED ITS OWN RULES. The policy was read from the working tree, which in a
 *      pull request is the candidate's copy. Measured on the fixture below: on main the gate
 *      refused; on a branch whose only change was `rm .holt/policy.json` it exited 0.
 *
 *   2. AN EMPTY INSTRUMENT READ AS A CLEAN RESULT. `actions/checkout` defaults to fetch-depth 1.
 *      In that clone there are no other branches and no merge base, so the audit finds nothing
 *      unlanded and the gate reports green — measured, with `--fail-on-unlanded` set, on a
 *      repository that provably held abandoned work.
 *
 * Every test below carries its NEGATIVE CONTROL in the same repository: the case that must still
 * pass, and the case the instrument must still catch. A refusal that fires on everything is not
 * a gate, it is a wall.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'holt.mjs');

/**
 * A deliberately license-FREE environment. `holt ci` refuses a declared policy it is not
 * entitled to run (exit 3) rather than passing the build, so "exit 3, code unlicensed-policy,
 * and the payload names the policy path" is the observable that proves the policy WAS FOUND.
 * Pinning that requires the license lookup to be deterministic, hence the scrubbed HOME/XDG.
 */
function ciEnv(homeless) {
  return {
    ...process.env,
    HOLT_LICENSE: '',
    HOME: homeless,
    XDG_CONFIG_HOME: path.join(homeless, 'config'),
    GIT_AUTHOR_NAME: 'holt test', GIT_AUTHOR_EMAIL: 't@holt.invalid',
    GIT_COMMITTER_NAME: 'holt test', GIT_COMMITTER_EMAIL: 't@holt.invalid',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', LC_ALL: 'C',
    GITHUB_HEAD_REF: '',
  };
}

function sh(cmd, args, cwd, env) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: 120_000, maxBuffer: 16 * 1024 * 1024, env }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? -1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

async function scratch(label) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `holt-cigate-${label}-`));
  await fs.mkdir(path.join(dir, 'home', 'config'), { recursive: true });
  return { dir, home: path.join(dir, 'home'), env: ciEnv(path.join(dir, 'home')) };
}

/**
 * A repository that holds real abandoned work on `wip`, so every gate below is judged against a
 * repository where the honest answer is "not clean". `policy` is committed on main when given.
 */
async function repoWithAbandonedWork(label, policy, policyPath = '.holt/policy.json') {
  const s = await scratch(label);
  const root = path.join(s.dir, 'repo');
  await fs.mkdir(root, { recursive: true });
  const g = (...args) => sh('git', args, root, s.env);

  await g('init', '-q', '--initial-branch=main');
  await g('config', 'user.name', 'holt test');
  await g('config', 'user.email', 't@holt.invalid');
  await g('config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(root, 'README.md'), '# fixture\n');
  if (policy) {
    await fs.mkdir(path.join(root, path.dirname(policyPath)), { recursive: true });
    await fs.writeFile(path.join(root, policyPath), policy);
  }
  await g('add', '-A');
  await g('commit', '-q', '-m', 'base');

  await g('checkout', '-q', '-b', 'wip');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'only-here.js'), 'export const ONLY_ON_WIP = 1;\n');
  await g('add', '-A');
  await g('commit', '-q', '-m', 'work that exists nowhere else');
  await g('checkout', '-q', 'main');
  await fs.appendFile(path.join(root, 'README.md'), 'main moves on\n');
  await g('add', '-A');
  await g('commit', '-q', '-m', 'main moves on');

  return { ...s, root, g, cleanup: () => fs.rm(s.dir, { recursive: true, force: true }) };
}

const ci = (fx, cwd, ...flags) => sh(process.execPath, [BIN, 'ci', '--json', '--cwd', cwd, ...flags], cwd, fx.env);

const STRICT_POLICY = JSON.stringify({
  version: 1,
  rules: [{ id: 'no-abandoned-work', type: 'no-unlanded', severity: 'error' }],
});

/* ==========================================================================================
 * DEFECT 1 — a pull request could neutralise the policy that gates it.
 * ======================================================================================= */

test('CI GATE: a branch that DELETES .holt/policy.json is still gated by the base policy', async (t) => {
  const fx = await repoWithAbandonedWork('delete-policy', STRICT_POLICY);
  t.after(() => fx.cleanup());

  // Control: on main the policy is found and the gate does NOT go green.
  const onMain = await ci(fx, fx.root);
  assert.equal(onMain.code, 3, `control: the base policy must be enforced on main: ${onMain.stdout}${onMain.stderr}`);
  assert.equal(JSON.parse(onMain.stdout).code, 'unlicensed-policy');

  // The attack: a pull request whose only change is removing the file that judges it.
  await fx.g('checkout', '-q', '-b', 'weaken');
  await fs.rm(path.join(fx.root, '.holt', 'policy.json'));
  await fx.g('add', '-A');
  await fx.g('commit', '-q', '-m', 'chore: drop policy');

  const onPr = await ci(fx, fx.root);
  assert.notEqual(onPr.code, 0,
    `a PR that deletes the policy must not neutralise it — got exit 0: ${onPr.stdout}`);
  const body = JSON.parse(onPr.stdout);
  assert.equal(body.code, 'unlicensed-policy',
    'the base policy must still be FOUND, so the gate still refuses to pass unenforced');
  assert.equal(body.policy, '.holt/policy.json');
  assert.equal(body.policySource, 'base');
  assert.equal(body.policyTrusted, true);
});

test('CI GATE: a branch that WEAKENS the policy is judged by the base copy, not its own', async (t) => {
  // The base commits `.holt/policy.jsonc` and the pull request adds `.holt/policy.json`, which
  // the working-tree loader prefers. The FILENAME in the verdict is therefore an unambiguous
  // answer to "which copy governed" — without it this test would pass whichever way the attack
  // went, since an unlicensed policy from EITHER source refuses.
  const fx = await repoWithAbandonedWork('weaken-policy', STRICT_POLICY, '.holt/policy.jsonc');
  t.after(() => fx.cleanup());

  await fx.g('checkout', '-q', '-b', 'lax');
  await fs.writeFile(path.join(fx.root, '.holt', 'policy.json'), JSON.stringify({
    version: 1, rules: [{ id: 'toothless', type: 'max-branch-age', days: 99999, severity: 'warn' }],
  }));
  await fx.g('add', '-A');
  await fx.g('commit', '-q', '-m', 'chore: soften policy');

  const r = await ci(fx, fx.root);
  assert.notEqual(r.code, 0, `a rewritten policy must not judge its own pull request: ${r.stdout}`);
  const body = JSON.parse(r.stdout);
  assert.equal(body.policy, '.holt/policy.jsonc',
    `the BASE file must be the one enforced, not the one the PR added: ${r.stdout}`);
  assert.equal(body.policySource, 'base');
});

test('CI GATE: a repository with NO policy anywhere still works, both green and red', async (t) => {
  // The never-worse control for the base-ref read: the free, flag-driven gate is untouched.
  const fx = await repoWithAbandonedWork('no-policy', null);
  t.after(() => fx.cleanup());

  const reportOnly = await ci(fx, fx.root);
  assert.equal(reportOnly.code, 0, `report-only must still exit 0: ${reportOnly.stdout}${reportOnly.stderr}`);
  assert.equal(JSON.parse(reportOnly.stdout).ok, true);

  const strict = await ci(fx, fx.root, '--fail-on-unlanded');
  assert.equal(strict.code, 1, 'the flag gate must still catch the abandoned branch');
  assert.ok(JSON.parse(strict.stdout).failures.some((f) => f.includes('wip')),
    'and must still NAME it — proving the instrument sees presence, not just absence');

  const ignored = await ci(fx, fx.root, '--fail-on-unlanded', '--ignore', 'wip');
  assert.equal(ignored.code, 0, `an exempted branch must still pass: ${ignored.stdout}`);
});

test('CI GATE: adopting a policy for the first time is reached, marked untrusted, and never green', async (t) => {
  // CONTROL, not a pin — say so rather than let it look like one. The other door onto defect 1 is
  // "the PR ADDS a permissive policy", and policy mode supersedes the inline flags, so that file
  // would switch off the --fail-on-unlanded the user asked for. The rule that stops it
  // (an untrusted policy may add failures, never remove them) is pinned by
  // test/unit/policy.test.mjs → 'GATE VERDICT', because observing it end-to-end needs a team
  // license and this suite deliberately runs with none. What IS proven here: the fallback path
  // still loads, is classified untrusted, and does not produce a green build.
  const fx = await repoWithAbandonedWork('adopt-policy', null);
  t.after(() => fx.cleanup());

  await fs.mkdir(path.join(fx.root, '.holt'), { recursive: true });
  await fs.writeFile(path.join(fx.root, '.holt', 'policy.json'), JSON.stringify({
    version: 1, rules: [{ id: 'toothless', type: 'max-branch-age', days: 99999, severity: 'warn' }],
  }));

  const r = await ci(fx, fx.root, '--fail-on-unlanded');
  assert.notEqual(r.code, 0,
    `a policy the base never reviewed must not suppress --fail-on-unlanded: ${r.stdout}`);
  const body = JSON.parse(r.stdout);
  assert.equal(body.policySource, 'worktree', 'the fallback must be REACHED when the base has none');
  assert.equal(body.policyTrusted, false, 'and must never be trusted');
});

/* ==========================================================================================
 * DEFECT 2 — a shallow checkout made the gate pass on zero evidence.
 * ======================================================================================= */

test('CI GATE: a SHALLOW checkout REFUSES and names fetch-depth: 0, instead of reporting green', async (t) => {
  const fx = await repoWithAbandonedWork('shallow', null);
  t.after(() => fx.cleanup());

  // Presence control FIRST: with full history the same repository fails, so a later refusal
  // cannot be confused with "there was nothing to find here anyway".
  const full = await ci(fx, fx.root, '--fail-on-unlanded');
  assert.equal(full.code, 1, `control: full history must catch the abandoned branch: ${full.stdout}`);

  const shallowPath = path.join(fx.dir, 'shallow');
  const cloned = await sh('git', ['clone', '-q', '--depth', '1', `file://${fx.root}`, shallowPath], fx.dir, fx.env);
  assert.equal(cloned.code, 0, `fixture: shallow clone failed: ${cloned.stderr}`);
  assert.equal(
    (await sh('git', ['rev-parse', '--is-shallow-repository'], shallowPath, fx.env)).stdout.trim(),
    'true', 'fixture: the clone must actually be shallow');

  const r = await ci(fx, shallowPath, '--fail-on-unlanded');
  assert.equal(r.code, 2, `a shallow checkout must REFUSE, not pass: ${r.stdout}${r.stderr}`);
  const body = JSON.parse(r.stdout);
  assert.equal(body.ok, false);
  assert.equal(body.code, 'incomplete-history:shallow');
  assert.match(`${body.reason} ${body.fix}`, /fetch-depth: 0/,
    'the refusal must be actionable: it has to name the setting that fixes it');

  // The refusal is a property of the EVIDENCE, not of the flags — report-only must refuse too,
  // otherwise the default invocation keeps reporting a reassuring green.
  assert.equal((await ci(fx, shallowPath)).code, 2, 'report-only must refuse on a shallow clone too');
});

test('CI GATE: unshallowing the SAME clone restores a verdict — the refusal is not a wall', async (t) => {
  const fx = await repoWithAbandonedWork('unshallow', null);
  t.after(() => fx.cleanup());

  const p = path.join(fx.dir, 'clone');
  await sh('git', ['clone', '-q', '--depth', '1', `file://${fx.root}`, p], fx.dir, fx.env);
  assert.equal((await ci(fx, p, '--fail-on-unlanded')).code, 2, 'shallow: refused');

  const un = await sh('git', ['fetch', '-q', '--unshallow'], p, fx.env);
  assert.equal(un.code, 0, `fixture: --unshallow failed: ${un.stderr}`);
  assert.equal((await sh('git', ['rev-parse', '--is-shallow-repository'], p, fx.env)).stdout.trim(), 'false');

  const r = await ci(fx, p, '--fail-on-unlanded');
  assert.notEqual(r.code, 2, `a full clone must get a real verdict again: ${r.stdout}${r.stderr}`);
  assert.doesNotThrow(() => JSON.parse(r.stdout));
});

test('CI GATE: a full clone with nothing abandoned still passes GREEN', async (t) => {
  // The never-worse control for the shallow refusal: an ordinary healthy repository is unaffected.
  const s = await scratch('healthy');
  t.after(() => fs.rm(s.dir, { recursive: true, force: true }));
  const root = path.join(s.dir, 'repo');
  await fs.mkdir(root, { recursive: true });
  const g = (...args) => sh('git', args, root, s.env);
  await g('init', '-q', '--initial-branch=main');
  await g('config', 'user.name', 'holt test');
  await g('config', 'user.email', 't@holt.invalid');
  await g('config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(root, 'README.md'), '# clean\n');
  await g('add', '-A');
  await g('commit', '-q', '-m', 'base');

  const r = await sh(process.execPath, [BIN, 'ci', '--json', '--cwd', root, '--fail-on-unlanded'], root, s.env);
  assert.equal(r.code, 0, `a healthy repository must still pass: ${r.stdout}${r.stderr}`);
  assert.equal(JSON.parse(r.stdout).ok, true);
});

test('CI GATE: GRAFTED history refuses too — a replaced commit graph is not the real one', async (t) => {
  const fx = await repoWithAbandonedWork('grafted', null);
  t.after(() => fx.cleanup());

  // Control: ungrafted, the same repository yields a verdict.
  assert.equal((await ci(fx, fx.root, '--fail-on-unlanded')).code, 1, 'control: a real verdict first');

  // Re-graft HEAD as a parentless root: the visible graph now genuinely differs from the real one.
  const head = (await sh('git', ['rev-parse', 'HEAD'], fx.root, fx.env)).stdout.trim();
  const made = await sh('git', ['replace', '--graft', head], fx.root, fx.env);
  assert.equal(made.code, 0, `fixture: git replace --graft failed: ${made.stderr}`);
  assert.ok((await sh('git', ['for-each-ref', 'refs/replace'], fx.root, fx.env)).stdout.trim(),
    'fixture: a replacement ref must actually exist');

  const r = await ci(fx, fx.root, '--fail-on-unlanded');
  assert.equal(r.code, 2, `a grafted repository must refuse, not answer: ${r.stdout}${r.stderr}`);
  assert.equal(JSON.parse(r.stdout).code, 'incomplete-history:grafted');
});
