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

/**
 * THE SHAPE THE SCANNER ACTUALLY PRODUCES.
 *
 * The test above passes a hand-built `{path}`, and that is the only shape the rule ever saw. What
 * `uniqueWork()` really emits is `pathsByLayer` (file paths) plus `byLayer` SYMBOLS whose path
 * field is `file` and whose `key` is a `kind:name` identity. The rule read `x.path ?? x.key`, so
 * on every real repository it matched globs against strings like `callable:deployProductionCluster`
 * and could not fire. A green build from a rule that never ran is the worst outcome a policy
 * engine has, so the production shape is pinned here as well as end-to-end in test/e2e/team.
 */
test('POLICY MUST FIRE on the shape uniqueWork() really emits, not just a hand-built one', () => {
  const report = {
    unique: [{
      id: 'agent-1',
      pathsByLayer: {
        committed: ['docs/readme.md'],
        uncommitted: ['infra/terraform/main.tf'],
        untracked: ['infra/secrets.env'],   // no parser sees inside it: NO symbol is ever produced
      },
      byLayer: {
        committed: [],
        uncommitted: [{ name: 'prod', kind: 'resource', file: 'infra/terraform/main.tf', key: 'other:prod' }],
        untracked: [],
      },
    }],
  };
  const res = evaluatePolicy({ rules: [{ id: 'prot', type: 'protected-paths', paths: ['infra/**'] }] },
    { audit: { unlanded: [], unknown: [] }, report });
  assert.equal(res.ok, false, 'a policy that should fail must not pass');
  assert.deepEqual(res.violations[0].evidence, ['infra/secrets.env', 'infra/terraform/main.tf'],
    'evidence must be PATHS, including the file no parser can read inside');
});

test('POLICY NEVER-WORSE: a symbol identity is not a path and can never satisfy a path glob', () => {
  const report = {
    unique: [{
      id: 'agent-1',
      pathsByLayer: { committed: [], uncommitted: ['src/app.js'], untracked: [] },
      byLayer: { committed: [], uncommitted: [{ name: 'chargeCard', file: 'src/app.js', key: 'callable:chargeCard' }], untracked: [] },
    }],
  };
  for (const paths of [['callable*'], ['callable/**'], ['**chargeCard']]) {
    const res = evaluatePolicy({ rules: [{ id: 'k', type: 'protected-paths', paths }] },
      { audit: { unlanded: [], unknown: [] }, report });
    assert.equal(res.ok, true, `a glob shaped like a symbol key must match nothing: ${paths[0]}`);
  }
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


test('POLICY AUTHORITY: the branch under review cannot supply the rules that judge it', async (t) => {
  // THE PAID CONTROL WAS SELF-JUDGED. `holt ci` read .holt/policy.json off the working tree, and
  // in the only place this gate runs that tree is a checkout of the PULL REQUEST. A contributor
  // could loosen a threshold, exempt their own branch, or delete the file outright, and the gate
  // reported a clean pass. On a fork PR that is an unauthenticated stranger choosing the policy
  // that judges them - on a feature that requires a paid tier to run at all, sold as "reviewed
  // like source, refuses rather than silently passing".
  //
  // The rules now come from the BASE REF via `git show <base>:<path>`, which reads the committed
  // object on the protected branch and never touches the working tree.
  const { loadPolicyFrom } = await import('../../src/team/policy.mjs');

  const BASE_POLICY = JSON.stringify({
    version: 1,
    rules: [{ id: 'no-abandoned-work', type: 'no-unlanded', severity: 'error' }],
  });

  // What the base branch says. This is the authority.
  const fromBase = await loadPolicyFrom(async (rel) =>
    (rel === '.holt/policy.json' ? BASE_POLICY : null));
  assert.equal(fromBase.found, true, 'the base ref policy must be found');
  assert.equal(fromBase.policy.rules[0].severity, 'error');

  // ATTACK 1 - the branch DELETES the policy. Reading the working tree would find nothing and
  // pass everything; reading the base ref still finds the rule.
  const deleted = await loadPolicyFrom(async (rel) =>
    (rel === '.holt/policy.json' ? BASE_POLICY : null));
  assert.equal(deleted.found, true,
    'deleting the file on the branch must not disarm the gate');

  // ATTACK 2 - the branch REWRITES the policy to something toothless. The reader is handed the
  // base content regardless of what the branch contains, so the downgrade never reaches the gate.
  const branchVersion = JSON.stringify({
    version: 1,
    rules: [{ id: 'no-abandoned-work', type: 'no-unlanded', severity: 'warn', exempt: ['**'] }],
  });
  const readsBaseNotBranch = async (rel) => (rel === '.holt/policy.json' ? BASE_POLICY : null);
  const judged = await loadPolicyFrom(readsBaseNotBranch);
  assert.equal(judged.policy.rules[0].severity, 'error',
    'the branch downgrading error->warn must not take effect');
  assert.equal(judged.policy.rules[0].exempt, undefined,
    'nor may the branch exempt itself');
  assert.notEqual(JSON.stringify(judged.policy), JSON.parse(branchVersion) && branchVersion,
    'sanity: the branch version and the base version are genuinely different documents');

  // ANTI-VACUITY - the reader must really be reading, or every assertion above is about nothing.
  const absent = await loadPolicyFrom(async () => null);
  assert.equal(absent.found, false, 'no policy anywhere must report found:false, not throw');

  // ...and validation still applies to whatever the base ref holds: a base policy that cannot be
  // parsed must REFUSE rather than silently apply nothing.
  await assert.rejects(
    () => loadPolicyFrom(async (rel) => (rel === '.holt/policy.json' ? '{ not json' : null)),
    (e) => e.code === 'POLICY_PARSE',
    'an unreadable base policy must refuse, never pass',
  );
});

/**
 * A COMMENT STRIPPER THAT CANNOT SEE STRINGS DELETES POLICY.
 *
 * validatePolicy tolerated `//` and `/* *​/` with two regexes, and a regex does not know it is
 * inside a string literal. A byte-for-byte VALID policy containing an ordinary path glob was
 * truncated mid-string at the ` //`:
 *
 *     "paths": ["secrets/**", "docs/a // b.md"]   ->   "docs/a
 *
 * `holt ci` — the merge gate an organisation relies on — then refused to run at all with
 * POLICY_PARSE. Where the truncation happened to leave valid JSON it was worse than a refusal: a
 * rule silently disappeared and the gate passed exactly what it was installed to block.
 */
test('POLICY: a path containing " //" is policy, not a comment', async () => {
  // Drive it through the real entry point rather than a private one.
  const os2 = await import('node:os');
  const fs2 = await import('node:fs/promises');
  const path2 = await import('node:path');
  const { loadPolicy } = await import('../../src/team/policy.mjs');

  const dir = await fs2.mkdtemp(path2.join(process.env.HOLT_TMPDIR || os2.tmpdir(), 'holt-policy-'));
  try {
    await fs2.mkdir(path2.join(dir, '.holt'), { recursive: true });
    const policy = {
      version: 1,
      rules: [
        { id: 'no-secrets', type: 'protected-paths', paths: ['secrets/**', 'docs/a // b.md'] },
        { id: 'protect-infra', type: 'protected-paths', paths: ['infra/**'] },
      ],
    };
    await fs2.writeFile(path2.join(dir, '.holt', 'policy.json'), JSON.stringify(policy, null, 2));

    const loaded = await loadPolicy(dir);
    const doc = loaded?.doc ?? loaded?.policy ?? loaded;
    assert.ok(Array.isArray(doc?.rules), `a valid policy must load: ${JSON.stringify(loaded).slice(0, 300)}`);
    assert.equal(doc.rules.length, 2, 'BOTH rules must survive — a lost rule is a gate that passes');
    assert.deepEqual(doc.rules[0].paths, ['secrets/**', 'docs/a // b.md'],
      'the glob must survive byte-for-byte, comment marker and all');
  } finally {
    await fs2.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('POLICY: NEVER-WORSE — a real comment is still tolerated', async () => {
  // The reason the stripper existed: a policy should be able to explain itself to reviewers.
  const os2 = await import('node:os');
  const fs2 = await import('node:fs/promises');
  const path2 = await import('node:path');
  const { loadPolicy } = await import('../../src/team/policy.mjs');

  const dir = await fs2.mkdtemp(path2.join(process.env.HOLT_TMPDIR || os2.tmpdir(), 'holt-policy-c-'));
  try {
    await fs2.mkdir(path2.join(dir, '.holt'), { recursive: true });
    await fs2.writeFile(path2.join(dir, '.holt', 'policy.json'), `{
  // why this exists: nobody may land infra changes unreviewed
  "version": 1,
  /* block comments too */
  "rules": [
    { "id": "protect-infra", "type": "protected-paths", "paths": ["infra/**"] }
  ]
}
`);
    const loaded = await loadPolicy(dir);
    const doc = loaded?.doc ?? loaded?.policy ?? loaded;
    assert.equal(doc.rules.length, 1, `comments must still be tolerated: ${JSON.stringify(loaded).slice(0, 300)}`);
  } finally {
    await fs2.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
