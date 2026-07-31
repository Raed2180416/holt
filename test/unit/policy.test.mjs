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
import { loadPolicy, evaluatePolicy, globToRegExp } from '../../src/team/policy.mjs';

async function repoWith(policyText, name = 'policy.json') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-policy-'));
  await fs.mkdir(path.join(dir, '.holt'), { recursive: true });
  if (policyText !== null) await fs.writeFile(path.join(dir, '.holt', name), policyText);
  return dir;
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

test('policy: glob translation is anchored — a prefix match must not pass as a full match', () => {
  assert.equal(globToRegExp('infra/**').test('infra/x/y.tf'), true);
  assert.equal(globToRegExp('infra/**').test('other/infra/x'), false);
  assert.equal(globToRegExp('src/*.ts').test('src/a.ts'), true);
  assert.equal(globToRegExp('src/*.ts').test('src/nested/a.ts'), false);
  assert.equal(globToRegExp('a.b').test('axb'), false, 'dots must be literal, not any-char');
});
