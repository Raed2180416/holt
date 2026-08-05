/**
 * holt Team — WHO IS ALLOWED TO WRITE THE RULES.
 *
 * A policy engine has one failure that matters more than every other combined: a GREEN build
 * produced by a rule that did not run. A team reads green as "the rules hold", and a gate the
 * subject can edit does not hold anything.
 *
 * Three doors were open, and all three were reproduced on real repositories before a line was
 * changed (probe output in the commit body):
 *
 *   1. THE CANDIDATE EDITS THE GATE. `holt ci` read `.holt/policy.json` from the WORKING TREE,
 *      which in a pull request is the candidate's own copy. Deleting the file went green;
 *      downgrading every rule to `severity: warn` went green.
 *
 *   2. THE BASE *IS* THE CANDIDATE. Reading from the base ref fixes (1) only if the base is a
 *      different commit. `resolveBase` ends in a `primary-head-fallback` — reached by any
 *      repository with no `origin/HEAD` and no branch called main/master/trunk/develop/default —
 *      and there `base.oid === HEAD`. "Read the rules from the base" then reads the candidate
 *      again, silently, in exactly the CI shape the base read exists to protect.
 *
 *   3. A RULE THAT CANNOT FIRE. `{"type":"protected-paths","paths":[]}` validated, matched
 *      nothing and passed; `paths:[null,17]` crashed the evaluator with a TypeError instead of
 *      refusing; unknown keys (`"sevrity"`, `"defaultSeverity"`) were silently ignored, so a
 *      policy could read as strict to its author and be inert in the binary.
 *
 * Everything below runs against REAL git — real refs, real commits, real detached heads. Every
 * one of these defects was green against a hand-built fixture object.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

import {
  loadPolicy, loadPolicyFromRef, loadGatePolicy, baseAuthority, gateVerdict,
  evaluatePolicy, parsePolicy, ciPolicyOutcome,
} from '../../src/team/policy.mjs';
import { branchAudit } from '../../src/branches.mjs';
import { resolveBase } from '../../src/scan.mjs';

/* ------------------------------------------------------------------ harness ---- */

function sh(cmd, args, cwd) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      cwd, timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
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
  fs.mkdtemp(path.join(process.env.HOLT_TMPDIR || os.tmpdir(), `holt-auth-${label}-`));

const write = async (dir, rel, body) => {
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body, 'utf8');
};

const STRICT = JSON.stringify({
  version: 1,
  rules: [{ id: 'no-abandoned', type: 'no-unlanded', severity: 'error' }],
}, null, 2);

const PERMISSIVE = JSON.stringify({
  version: 1,
  rules: [{ id: 'no-abandoned', type: 'no-unlanded', severity: 'warn' }],
}, null, 2);

/**
 * A repository that a correct gate must FAIL: a strict policy on the default branch, and a
 * branch holding content the base does not have.
 */
async function repoWithPolicy(dir, { branch = 'main', policy = STRICT } = {}) {
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
  await sh('git', ['commit', '-m', 'work that never landed', '--no-verify'], dir);
  await sh('git', ['checkout', '-q', branch], dir);
  return dir;
}

const headOidOf = async (dir) => (await sh('git', ['rev-parse', 'HEAD'], dir)).stdout.trim();

/** Run the whole gate the way `holt ci` does, and say only whether the build goes red. */
async function gate(dir, { env = {} } = {}) {
  const audit = await branchAudit(dir, { symbols: false });
  const base = await resolveBase(dir, null);
  const loaded = await loadGatePolicy(dir, { base, headOid: await headOidOf(dir), env });
  if (!loaded.found) return { red: false, why: 'no policy found', loaded };
  const res = evaluatePolicy(loaded.policy, { audit, report: null });
  const v = gateVerdict({ policyResult: res, flagFailures: [], trusted: loaded.trusted });
  return { red: !v.ok, why: `${res.errors} error(s)`, loaded, res };
}

/* ================================================== 1. THE CANDIDATE'S EDIT ==== */

test('BYPASS 1: a candidate that DELETES the policy is still judged by the base policy', async (t) => {
  const root = await scratch('del');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = await repoWithPolicy(path.join(root, 'repo'));

  // Control: the instrument can see a positive. Without this, everything below is meaningless.
  assert.equal((await gate(repo)).red, true, 'CONTROL: the gate must fail on the untouched repository');

  // The pull request: a branch whose only change is removing the gate.
  await sh('git', ['checkout', '-q', '-b', 'feature/sneaky'], repo);
  await fs.rm(path.join(repo, '.holt', 'policy.json'));

  const after = await gate(repo);
  assert.equal(after.red, true,
    'deleting .holt/policy.json in the candidate must NOT neutralise the gate');
  assert.equal(after.loaded.source, 'base');
  assert.equal(after.loaded.trusted, true);
});

test('BYPASS 1b: a candidate that DOWNGRADES every rule to warn is still judged by the base policy', async (t) => {
  const root = await scratch('warn');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = await repoWithPolicy(path.join(root, 'repo'));

  await sh('git', ['checkout', '-q', '-b', 'feature/sneaky'], repo);
  await write(repo, '.holt/policy.json', PERMISSIVE);
  // Committed, not just edited — the strongest form of the attack.
  await sh('git', ['add', '-A'], repo);
  await sh('git', ['commit', '-m', 'relax policy', '--no-verify'], repo);

  const after = await gate(repo);
  assert.equal(after.red, true, 'a committed downgrade on the candidate must not weaken its own gate');
  assert.equal(after.res.violations[0].severity, 'error', 'the BASE severity is the one that applies');
});

test('the gate REPORTS that a candidate proposes changing it — a reviewer must see that', async (t) => {
  const root = await scratch('differs');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = await repoWithPolicy(path.join(root, 'repo'));
  await sh('git', ['checkout', '-q', '-b', 'feature/propose'], repo);
  await write(repo, '.holt/policy.json', PERMISSIVE);

  const g = await gate(repo);
  assert.equal(g.loaded.headDiffers, true, 'the working-tree policy differs from the enforced one');

  // Negative control: an untouched candidate must NOT be reported as proposing a change.
  await sh('git', ['checkout', '-q', '--', '.holt/policy.json'], repo);
  assert.equal((await gate(repo)).loaded.headDiffers, false);
});

test('ADOPTION is not a bypass: no policy in the base falls back to the working tree, UNTRUSTED', async (t) => {
  const root = await scratch('adopt');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = await repoWithPolicy(path.join(root, 'repo'), { policy: null });

  await sh('git', ['checkout', '-q', '-b', 'feature/adopt'], repo);
  await write(repo, '.holt/policy.json', STRICT);

  const g = await gate(repo);
  assert.equal(g.loaded.found, true, 'a repository adopting policy for the first time still gets it');
  assert.equal(g.loaded.source, 'worktree');
  assert.equal(g.loaded.trusted, false, 'a policy the base never approved is never trusted');
  assert.equal(g.red, true, 'and it can still turn the build RED — an untrusted policy may ADD failures');
});

test('AN UNTRUSTED POLICY CAN NEVER SUPPRESS A CHECK THAT WOULD OTHERWISE HAVE RUN', () => {
  const clean = { ok: true, errors: 0, warnings: 0 };
  const flags = ['2 branch(es) hold unlanded work'];

  // The other door: the candidate ADDS a permissive .holt/policy.json to switch off the
  // --fail-on-unlanded the repository owner asked for on the command line.
  const untrusted = gateVerdict({ policyResult: clean, flagFailures: flags, trusted: false });
  assert.equal(untrusted.ok, false, 'an untrusted policy must not cancel the inline flags');
  assert.deepEqual(untrusted.carriedFlagFailures, flags);

  // A policy the base carries is the reviewed statement of intent, and supersedes the flags.
  const trusted = gateVerdict({ policyResult: clean, flagFailures: flags, trusted: true });
  assert.equal(trusted.ok, true);
});

test('THE COMPOSITION ITSELF is pinned — trust is DERIVED from the load, never passed alongside it', () => {
  const clean = { ok: true, errors: 0, warnings: 0, violations: [], exempted: [], rulesEvaluated: ['n'], disabledRules: [] };
  const flags = ['2 branch(es) hold unlanded work'];

  // This test exists because of a mutation that survived: with the composition written inline in
  // bin/holt.mjs, changing `trusted: loaded.trusted` to `trusted: true` — the precise bypass the
  // module exists to stop — killed no test at all, since the CLI's policy branch cannot be
  // reached without a paid license. The composition now lives in one pure function, and trust is
  // derived from the loaded policy inside it, so no caller can supply the wrong value.
  const fromWorktree = ciPolicyOutcome({
    loaded: { found: true, path: '.holt/policy.json', source: 'worktree', trusted: false },
    policyResult: clean, flagFailures: flags,
  });
  assert.equal(fromWorktree.verdict.ok, false, 'an untrusted policy must not cancel the inline flags');
  assert.deepEqual(fromWorktree.payload.carriedFlagFailures, flags);
  assert.equal(fromWorktree.payload.policySource.trusted, false);

  const fromBase = ciPolicyOutcome({
    loaded: { found: true, path: '.holt/policy.json', source: 'base', ref: 'main', trusted: true },
    policyResult: clean, flagFailures: flags,
  });
  assert.equal(fromBase.verdict.ok, true, 'a reviewed base policy supersedes the flags, as it always did');

  // FAIL CLOSED on missing evidence: a load result that does not SAY it is trusted is not.
  for (const loaded of [{}, { trusted: undefined }, { trusted: 'yes' }, { trusted: 1 }, null]) {
    const r = ciPolicyOutcome({ loaded, policyResult: clean, flagFailures: flags });
    assert.equal(r.verdict.ok, false, `trust must be explicit: ${JSON.stringify(loaded)}`);
  }
});

/* ============================================ 2. THE BASE *IS* THE CANDIDATE ==== */

test('BYPASS 2: when resolveBase falls back to HEAD, the "base" is the candidate — REFUSED in CI', async (t) => {
  const root = await scratch('headfb');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  // No origin, and a default branch none of BASE_CANDIDATES names: the documented shape that
  // reaches `primary-head-fallback`.
  const repo = await repoWithPolicy(path.join(root, 'repo'), { branch: 'release' });
  await sh('git', ['checkout', '-q', '-b', 'feature/sneaky'], repo);
  await write(repo, '.holt/policy.json', PERMISSIVE);
  await sh('git', ['add', '-A'], repo);
  await sh('git', ['commit', '-m', 'relax policy', '--no-verify'], repo);

  const base = await resolveBase(repo, null);
  const head = await headOidOf(repo);
  // Ground truth for the premise, measured rather than assumed.
  assert.equal(base.how, 'primary-head-fallback');
  assert.equal(base.oid, head, 'the premise: the "base" holt found IS the candidate commit');

  const auth = baseAuthority({ base, headOid: head, env: {} });
  assert.equal(auth.independent, false);
  assert.match(auth.reason, /candidate|same commit|HEAD/i);

  // In a pull-request context the correct base was knowable, so this is a refusal, not a shrug.
  await assert.rejects(
    () => loadGatePolicy(repo, { base, headOid: head, env: { GITHUB_BASE_REF: 'release', GITHUB_HEAD_REF: 'feature/sneaky' } }),
    (e) => {
      assert.equal(e.code, 'POLICY_NO_AUTHORITY');
      assert.match(e.message, /--base/);
      return true;
    },
    'a PR judged by rules that came from itself must REFUSE, never pass',
  );
});

test('BYPASS 2b: outside CI the same shape DEGRADES to untrusted rather than refusing', async (t) => {
  const root = await scratch('headfb-local');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = await repoWithPolicy(path.join(root, 'repo'), { branch: 'release' });

  const base = await resolveBase(repo, null);
  const g = await loadGatePolicy(repo, { base, headOid: await headOidOf(repo), env: {} });
  assert.equal(g.found, true, 'running holt locally on the tip must still work');
  assert.equal(g.trusted, false, 'but the policy is not an independent authority, and says so');
  assert.match(g.note, /base/i);
});

test('an EXPLICIT --base restores authority, which is what the refusal tells the user to do', async (t) => {
  const root = await scratch('explicit');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = await repoWithPolicy(path.join(root, 'repo'), { branch: 'release' });
  await sh('git', ['checkout', '-q', '-b', 'feature/sneaky'], repo);
  await write(repo, '.holt/policy.json', PERMISSIVE);
  await sh('git', ['add', '-A'], repo);
  await sh('git', ['commit', '-m', 'relax', '--no-verify'], repo);

  const base = await resolveBase(repo, 'release');
  const head = await headOidOf(repo);
  assert.notEqual(base.oid, head);
  const g = await loadGatePolicy(repo, { base, headOid: head, env: { GITHUB_BASE_REF: 'release' } });
  assert.equal(g.trusted, true);
  assert.equal(g.source, 'base');
  assert.equal(g.policy.rules[0].severity, 'error', 'the rules are the reviewed ones');
});

test('CI declared a base that holt did not use — that is a misconfiguration, not a pass', async (t) => {
  const root = await scratch('mismatch');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = await repoWithPolicy(path.join(root, 'repo'));
  const base = await resolveBase(repo, null);
  const auth = baseAuthority({
    base, headOid: await headOidOf(repo),
    env: { GITHUB_BASE_REF: 'some-other-release-branch' },
  });
  assert.equal(auth.independent, false);
  assert.match(auth.reason, /some-other-release-branch/);
});

test('a base that DECLARES a policy holt cannot read fails CLOSED, never open', async (t) => {
  const root = await scratch('unreadable');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = await repoWithPolicy(path.join(root, 'repo'));
  // A ref that does not resolve is the readable form of "the object is missing" — a partial
  // clone or a pruned object produces the same class of answer.
  await assert.rejects(
    () => loadPolicyFromRef(repo, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'),
    (e) => { assert.equal(e.code, 'POLICY_BASE_UNREADABLE'); return true; },
  );
});

test('a base with no policy at all is ABSENCE, not an error', async (t) => {
  const root = await scratch('nopolicy');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = await repoWithPolicy(path.join(root, 'repo'), { policy: null });
  const r = await loadPolicyFromRef(repo, 'main');
  assert.equal(r.found, false);
});

/* ================================================== 3. A RULE THAT CANNOT FIRE ==== */

test('BYPASS 3: a rule that is structurally incapable of firing is REFUSED, not silently passed', () => {
  const cases = [
    ['{"version":1,"rules":[{"id":"p","type":"protected-paths","paths":[]}]}', 'POLICY_VACUOUS'],
    ['{"version":1,"rules":[{"id":"p","type":"protected-paths","paths":["  "]}]}', 'POLICY_RULE'],
    ['{"version":1,"rules":[{"id":"n","type":"no-unlanded","exempt":["**"]}]}', 'POLICY_VACUOUS'],
    ['{"version":1,"rules":[{"id":"n","type":"no-unlanded","exempt":["**/*","spike/*"]}]}', 'POLICY_VACUOUS'],
  ];
  for (const [text, code] of cases) {
    assert.throws(() => parsePolicy(text, 'x'), (e) => {
      assert.equal(e.code, code, `${text} -> expected ${code}, got ${e.code}: ${e.message}`);
      return true;
    }, `must refuse a rule that can never fire: ${text}`);
  }
});

test('BYPASS 3b: a non-string glob REFUSES at load time instead of crashing the evaluator', () => {
  // Before: globToRegExp(null) threw a TypeError from inside evaluatePolicy — a stack trace
  // where an actionable refusal belonged, and only by luck not a pass.
  assert.throws(() => parsePolicy('{"version":1,"rules":[{"id":"p","type":"protected-paths","paths":[null,17]}]}', 'x'),
    (e) => { assert.equal(e.code, 'POLICY_RULE'); assert.match(e.message, /string/); return true; });
});

test('BYPASS 3c: an unknown key is REFUSED — a policy must not read as strict and run as inert', () => {
  const cases = [
    '{"version":1,"rules":[{"id":"n","type":"no-unlanded"}],"defaultSeverity":"error"}',
    '{"version":1,"rules":[{"id":"n","type":"no-unlanded","sevrity":"warn"}]}',
    '{"version":1,"rules":[{"id":"n","type":"no-unlanded","paths":["infra/**"]}]}',
    '{"version":1,"rules":[{"id":"a","type":"max-branch-age","days":30,"exmpt":["spike/*"]}]}',
  ];
  for (const text of cases) {
    assert.throws(() => parsePolicy(text, 'x'), (e) => {
      assert.equal(e.code, 'POLICY_SCHEMA', `${text} -> ${e.code}: ${e.message}`);
      assert.match(e.message, /unknown/i);
      return true;
    }, `must refuse an unknown key: ${text}`);
  }
});

test('TURNING A RULE OFF IS ALLOWED — but only in words, and the verdict says which rules are off', () => {
  const doc = parsePolicy(
    '{"version":1,"rules":[{"id":"n","type":"no-unlanded","enabled":false},{"id":"r","type":"require-classified"}]}', 'x');
  const res = evaluatePolicy(doc, {
    audit: { unlanded: [{ name: 'wip/x', fileCount: 1, files: ['a.js'], ageDays: 1 }], unknown: [] },
  });
  assert.equal(res.ok, true, 'a rule explicitly disabled does not fire');
  assert.deepEqual(res.disabledRules, ['n'], 'and a disabled rule is REPORTED, never invisible');
  assert.deepEqual(res.rulesEvaluated, ['r'], 'rulesEvaluated names only what actually ran');
});

test('NEVER-WORSE: every policy the old validator accepted and that CAN fire is still accepted', () => {
  const good = [
    '{"version":1,"rules":[{"id":"n","type":"no-unlanded"}]}',
    '{"version":1,"rules":[{"id":"n","type":"no-unlanded","severity":"warn","exempt":["spike/*"]}]}',
    '{"version":1,"rules":[{"id":"a","type":"max-branch-age","days":30}]}',
    '{"version":1,"rules":[{"id":"p","type":"protected-paths","paths":["infra/**","src/billing/**"]}]}',
    '{"version":1,"rules":[{"id":"r","type":"require-classified","severity":"error"}]}',
    '{ /* c */ "version":1, // why\n "rules":[{"id":"n","type":"no-unlanded"}]}',
  ];
  for (const text of good) assert.ok(parsePolicy(text, 'x').rules.length >= 1, `must still accept: ${text}`);
});

test('the working-tree loader and the ref loader apply the SAME validation', async (t) => {
  const root = await scratch('sameval');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = await repoWithPolicy(path.join(root, 'repo'), {
    policy: '{"version":1,"rules":[{"id":"p","type":"protected-paths","paths":[]}]}',
  });
  // A vacuous policy committed to the base must refuse from the ref exactly as it does from disk.
  await assert.rejects(() => loadPolicyFromRef(repo, 'main'),
    (e) => { assert.equal(e.code, 'POLICY_VACUOUS'); return true; });
  await assert.rejects(() => loadPolicy(repo),
    (e) => { assert.equal(e.code, 'POLICY_VACUOUS'); return true; });
});
