/**
 * holt Team — policy as code, attacked.
 *
 * The dangerous outcome for a policy engine is not a crash: it is a GREEN build produced by a
 * policy that never ran. A team reads green as "the rules hold". So every way a policy can fail
 * to run — unreadable file, unknown version, unknown rule type, empty rule list — must refuse
 * loudly, and the tests below exist to prove that the refusal cannot be silently removed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import {
  loadPolicy, loadPolicyFromRef, loadGatePolicy, gateVerdict, evaluatePolicy, globToRegExp,
} from '../../src/team/policy.mjs';

async function repoWith(policyText, name = 'policy.json') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-policy-'));
  await fs.mkdir(path.join(dir, '.holt'), { recursive: true });
  if (policyText !== null) await fs.writeFile(path.join(dir, '.holt', name), policyText);
  return dir;
}

function sh(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'holt test', GIT_AUTHOR_EMAIL: 't@holt.invalid',
        GIT_COMMITTER_NAME: 'holt test', GIT_COMMITTER_EMAIL: 't@holt.invalid',
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', LC_ALL: 'C',
      },
    }, (e, stdout) => (e ? reject(e) : resolve(String(stdout))));
  });
}

const STRICT = '{"version":1,"rules":[{"id":"no-abandoned","type":"no-unlanded","severity":"error"}]}';
const LAX = '{"version":1,"rules":[{"id":"whatever","type":"max-branch-age","days":9999,"severity":"warn"}]}';

/** A real repo whose committed policy is `committed`, then mutated in the working tree. */
async function gitRepoWithPolicy(committed) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-policy-git-'));
  await sh(['init', '-q', '--initial-branch=main'], dir);
  await sh(['config', 'user.name', 'holt test'], dir);
  await sh(['config', 'user.email', 't@holt.invalid'], dir);
  await sh(['config', 'commit.gpgsign', 'false'], dir);
  await fs.writeFile(path.join(dir, 'README.md'), '# fixture\n');
  if (committed !== null) {
    await fs.mkdir(path.join(dir, '.holt'), { recursive: true });
    await fs.writeFile(path.join(dir, '.holt', 'policy.json'), committed);
  }
  await sh(['add', '-A'], dir);
  await sh(['commit', '-q', '-m', 'base'], dir);
  const oid = (await sh(['rev-parse', 'HEAD'], dir)).trim();
  return { dir, oid };
}

const AUDIT = {
  unlanded: [
    { name: 'wip/old-thing', fileCount: 2, files: ['src/a.js', 'infra/terraform/main.tf'], ageDays: 90 },
    { name: 'spike/idea', fileCount: 1, files: ['docs/notes.md'], ageDays: 3 },
  ],
  unknown: [{ name: 'ghost', reason: 'instrument failed (merge-tree-failed)' }],
};

test('policy: absence is not an error — no file means no policy', async () => {
  const dir = await repoWith(null);
  const r = await loadPolicy(dir);
  assert.equal(r.found, false);
});

test('POLICY MUST REFUSE: unreadable JSON never degrades to "no rules"', async () => {
  const dir = await repoWith('{ this is not json');
  await assert.rejects(() => loadPolicy(dir), (e) => {
    assert.equal(e.code, 'POLICY_PARSE');
    assert.match(e.message, /refusing/);
    return true;
  });
});

test('POLICY MUST REFUSE: an unknown version, an empty rule list, and unknown rule types', async () => {
  const cases = [
    ['{"version":2,"rules":[]}', (e) => e.code === 'POLICY_VERSION'],
    ['{"version":1,"rules":[]}', (e) => e.code === 'POLICY_EMPTY'],
    ['{"version":1,"rules":[{"id":"x","type":"do-whatever"}]}',
      (e) => e.code === 'POLICY_RULE' && /unknown type/.test(e.message)],
    ['{"version":1,"rules":[{"id":"a","type":"no-unlanded"},{"id":"a","type":"no-unlanded"}]}',
      (e) => /duplicate rule id/.test(e.message)],
    ['{"version":1,"rules":[{"id":"a","type":"max-branch-age"}]}',
      (e) => /positive 'days'/.test(e.message)],
  ];
  for (const [text, check] of cases) {
    const dir = await repoWith(text);
    await assert.rejects(() => loadPolicy(dir), check, `must refuse: ${text}`);
  }
});

test('policy: comments are allowed so a policy can explain itself to reviewers', async () => {
  const dir = await repoWith(`{
    // why: abandoned work has bitten us twice
    "version": 1,
    /* block comments too */
    "rules": [{ "id": "no-abandoned", "type": "no-unlanded" }]
  }`);
  const r = await loadPolicy(dir);
  assert.equal(r.found, true);
  assert.equal(r.policy.rules[0].id, 'no-abandoned');
});

test('policy: no-unlanded fires per branch, and exemptions are recorded not hidden', () => {
  const res = evaluatePolicy({ rules: [{ id: 'nu', type: 'no-unlanded', exempt: ['spike/*'] }] }, { audit: AUDIT });
  assert.equal(res.ok, false);
  assert.equal(res.errors, 1);
  assert.equal(res.violations[0].subject, 'wip/old-thing');
  assert.deepEqual(res.exempted.map((e) => e.subject), ['spike/idea']);
});

test('policy: max-branch-age only fires past the limit', () => {
  const res = evaluatePolicy({ rules: [{ id: 'age', type: 'max-branch-age', days: 30, severity: 'warn' }] }, { audit: AUDIT });
  assert.equal(res.ok, true, 'warnings never fail a build');
  assert.equal(res.warnings, 1);
  assert.equal(res.violations[0].subject, 'wip/old-thing');
});

test('policy: protected-paths matches globs across segments and names the offending file', () => {
  const res = evaluatePolicy({ rules: [{ id: 'prot', type: 'protected-paths', paths: ['infra/**'] }] }, { audit: AUDIT });
  assert.equal(res.ok, false);
  assert.deepEqual(res.violations[0].evidence, ['infra/terraform/main.tf']);
});

test('policy: protected-paths also sees UNCOMMITTED worktree work, which is the riskiest kind', () => {
  const report = { unique: [{ id: 'wt-1', byLayer: { uncommitted: [{ path: 'src/billing/charge.ts' }], untracked: [] } }] };
  const res = evaluatePolicy({ rules: [{ id: 'prot', type: 'protected-paths', paths: ['src/billing/**'] }] },
    { audit: { unlanded: [], unknown: [] }, report });
  assert.equal(res.ok, false);
  assert.match(res.violations[0].message, /UNCOMMITTED/);
});

test('policy: require-classified turns an instrument failure into a build failure', () => {
  const res = evaluatePolicy({ rules: [{ id: 'rc', type: 'require-classified' }] }, { audit: AUDIT });
  assert.equal(res.ok, false);
  assert.equal(res.violations[0].subject, 'ghost');
  assert.match(res.violations[0].message, /missing evidence/);
});

test('policy: an all-clean audit passes and still reports which rules ran', () => {
  const res = evaluatePolicy(
    { rules: [{ id: 'nu', type: 'no-unlanded' }, { id: 'rc', type: 'require-classified' }] },
    { audit: { unlanded: [], unknown: [] } });
  assert.equal(res.ok, true);
  assert.deepEqual(res.rulesEvaluated, ['nu', 'rc']);
});

/* ------------------------------------------------------------------------------------------
 * THE SUBJECT OF A GATE MUST NOT SUPPLY ITS OWN RULES.
 *
 * Measured defect: `holt ci` loaded .holt/policy.json from the WORKING TREE, which in a pull
 * request is the candidate's copy. On main the gate refused; on a branch whose only change was
 * `rm .holt/policy.json` it went green. Rules now come from the BASE, exactly as GitHub reads
 * CODEOWNERS, and the working tree is a fallback that can only ever add strictness.
 * ---------------------------------------------------------------------------------------- */

test('GATE POLICY: a change that DELETES the policy is still judged by the base copy', async () => {
  const { dir, oid } = await gitRepoWithPolicy(STRICT);
  await fs.rm(path.join(dir, '.holt', 'policy.json')); // the pull request neutralises its gate

  assert.equal((await loadPolicy(dir)).found, false, 'control: the working tree really has none');

  const gate = await loadGatePolicy(dir, { baseRef: oid });
  assert.equal(gate.found, true, 'the base copy must still govern');
  assert.equal(gate.source, 'base');
  assert.equal(gate.trusted, true);
  assert.equal(gate.policy.rules[0].id, 'no-abandoned');
});

test('GATE POLICY: a change that WEAKENS the policy is judged by the base copy, not its own', async () => {
  const { dir, oid } = await gitRepoWithPolicy(STRICT);
  await fs.writeFile(path.join(dir, '.holt', 'policy.json'), LAX);

  assert.equal((await loadPolicy(dir)).policy.rules[0].id, 'whatever', 'control: the tree is lax');

  const gate = await loadGatePolicy(dir, { baseRef: oid });
  assert.equal(gate.policy.rules[0].type, 'no-unlanded', 'the strict base rule must be the one enforced');
  assert.equal(gate.trusted, true);
});

test('GATE POLICY: a repo with NO base policy still works — the working tree is the fallback', async () => {
  const { dir, oid } = await gitRepoWithPolicy(null);
  assert.equal((await loadGatePolicy(dir, { baseRef: oid })).found, false,
    'no policy anywhere means no policy — absence is not an error');

  await fs.mkdir(path.join(dir, '.holt'), { recursive: true });
  await fs.writeFile(path.join(dir, '.holt', 'policy.json'), STRICT);
  const gate = await loadGatePolicy(dir, { baseRef: oid });
  assert.equal(gate.found, true, 'adopting a policy for the first time must work');
  assert.equal(gate.source, 'worktree');
  assert.equal(gate.trusted, false, 'a policy the base has not reviewed is never trusted');
});

test('GATE POLICY MUST REFUSE: the base declares a policy whose content cannot be read', async () => {
  const { dir, oid } = await gitRepoWithPolicy(STRICT);
  const blob = (await sh(['rev-parse', `${oid}:.holt/policy.json`], dir)).trim();
  await fs.rm(path.join(dir, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
  await fs.rm(path.join(dir, '.holt', 'policy.json')); // …and the candidate deleted it too

  // "I cannot read the rules" must never collapse into "there are no rules" — that is the same
  // absent-evidence-reads-as-pass defect, and it would hand the bypass straight back.
  await assert.rejects(() => loadGatePolicy(dir, { baseRef: oid }), (e) => {
    assert.equal(e.code, 'POLICY_BASE_UNREADABLE');
    assert.match(e.message, /refusing/);
    return true;
  });
});

test('GATE POLICY: an invalid base policy refuses, and the refusal names the REF it came from', async () => {
  const { dir, oid } = await gitRepoWithPolicy('{"version":1,"rules":[{"id":"x","type":"do-whatever"}]}');
  await assert.rejects(() => loadPolicyFromRef(dir, oid), (e) => {
    assert.equal(e.code, 'POLICY_RULE');
    assert.ok(e.message.startsWith(`${oid}:.holt/policy.json`),
      `the label must prove the bytes came from the ref, not from disk: ${e.message}`);
    return true;
  });
});

test('GATE VERDICT: an UNTRUSTED policy may add failures and may never remove them', () => {
  const clean = { ok: true, errors: 0, warnings: 0 };
  const flags = ['1 branch(es) hold unlanded work: wip (1 file(s))'];

  // The other door onto the same bypass: a PR that ADDS a permissive policy would otherwise
  // switch off the --fail-on-unlanded the user asked for, because policy mode supersedes flags.
  const untrusted = gateVerdict({ policyResult: clean, flagFailures: flags, trusted: false });
  assert.equal(untrusted.ok, false, 'a candidate-supplied policy must not suppress the flags');
  assert.deepEqual(untrusted.carriedFlagFailures, flags);

  // A reviewed policy in the base keeps the original behaviour exactly: it supersedes the flags.
  const trusted = gateVerdict({ policyResult: clean, flagFailures: flags, trusted: true });
  assert.equal(trusted.ok, true);
  assert.deepEqual(trusted.carriedFlagFailures, []);

  // And a failing policy still fails, with or without flags in play.
  assert.equal(gateVerdict({ policyResult: { ok: false, errors: 2 }, trusted: true }).ok, false);
});

test('policy: glob translation is anchored — a prefix match must not pass as a full match', () => {
  assert.equal(globToRegExp('infra/**').test('infra/x/y.tf'), true);
  assert.equal(globToRegExp('infra/**').test('other/infra/x'), false);
  assert.equal(globToRegExp('src/*.ts').test('src/a.ts'), true);
  assert.equal(globToRegExp('src/*.ts').test('src/nested/a.ts'), false);
  assert.equal(globToRegExp('a.b').test('axb'), false, 'dots must be literal, not any-char');
});
