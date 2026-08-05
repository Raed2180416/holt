// SPDX-License-Identifier: FSL-1.1-MIT
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_MANAGED_POLICY_BYTES,
  assertMetadataPath,
  assertProfileName,
  assertRepositoryIdentity,
  parseManagedPolicy,
  parseStrictJson,
  parseStrictTufRoot,
  validateManagedPolicyObject,
  validateStagedVerificationObject,
} from '../../src/team/managed-policy-schema.mjs';
import {
  evaluatePolicy, evaluatePolicySources, parsePolicy, validatePolicyObject,
} from '../../src/team/policy.mjs';

const policy = (id = 'no-abandoned') => ({
  version: 1,
  rules: [{ id, type: 'no-unlanded', severity: 'error' }],
});

const managed = () => ({
  version: 1,
  profile: 'production',
  policies: [{ id: 'baseline', policy: policy() }],
  assignments: [{ repository: 'github-repository-id:123456', policies: ['baseline'] }],
});

const throwsCode = (fn, code) => assert.throws(fn, (error) => error?.code === code);

test('strict JSON rejects duplicate keys at any depth instead of evaluating the last spelling', () => {
  throwsCode(
    () => parseManagedPolicy(`{
      "version": 1,
      "profile": "production",
      "policies": [{"id":"baseline","id":"replacement","policy":${JSON.stringify(policy())}}],
      "assignments": [{"repository":"github-repository-id:123456","policies":["baseline"]}]
    }`),
    'MANAGED_POLICY_DUPLICATE_KEY',
  );
  throwsCode(() => parseStrictJson('{"a":{"b":1,"b":2}}'), 'MANAGED_POLICY_DUPLICATE_KEY');
});

test('managed JSON is strict, bounded, normalized, and free of dangerous/control keys', () => {
  throwsCode(() => parseStrictJson('{/* comment */"a":1}'), 'MANAGED_POLICY_PARSE');
  throwsCode(() => parseStrictJson('{"a":1,}'), 'MANAGED_POLICY_PARSE');
  throwsCode(() => parseStrictJson('{"__proto__":1}'), 'MANAGED_POLICY_SCHEMA');
  throwsCode(() => parseStrictJson('{"a":"\\u0000"}'), 'MANAGED_POLICY_CONTROL');
  throwsCode(() => parseStrictJson('{"a":"e\\u0301"}'), 'MANAGED_POLICY_UNICODE');
  throwsCode(
    () => parseStrictJson(`{"a":"${'x'.repeat(MAX_MANAGED_POLICY_BYTES)}"}`),
    'MANAGED_POLICY_LIMIT',
  );
  let nested = '0';
  for (let i = 0; i < 30; i++) nested = `{"a":${nested}}`;
  throwsCode(() => parseStrictJson(nested), 'MANAGED_POLICY_LIMIT');
  assert.equal(parseStrictJson(Buffer.from('{"a":"�"}')).a, '�', 'a literal replacement character is valid UTF-8');
  throwsCode(() => parseStrictJson(Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d])),
    'MANAGED_POLICY_ENCODING');
});

test('strict TUF root parsing permits only escaped PEM line breaks at keyval.public', () => {
  const root = JSON.stringify({
    signed: {
      _type: 'root', version: 1,
      keys: { abc: { keytype: 'rsa', scheme: 'rsassa-pss-sha256', keyval: { public: '-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----\n' } } },
    },
    signatures: [],
  });
  assert.match(parseStrictTufRoot(root).signed.keys.abc.keyval.public, /BEGIN PUBLIC KEY/u);
  throwsCode(() => parseStrictJson(root), 'MANAGED_POLICY_CONTROL');
  throwsCode(
    () => parseStrictTufRoot(JSON.stringify({ signed: { _type: 'root', version: 1, note: 'not\nPEM' }, signatures: [] })),
    'MANAGED_POLICY_CONTROL',
  );
});

test('profile, repository identity, and metadata paths cannot traverse or use ambiguous Unicode', () => {
  assert.equal(assertProfileName('production-1'), 'production-1');
  assert.equal(assertRepositoryIdentity('github-repository-id:123456'), 'github-repository-id:123456');
  assert.equal(assertMetadataPath('delegations/team.targets.json'), 'delegations/team.targets.json');
  for (const bad of ['../production', 'Production', 'a/b', '.', '..']) {
    throwsCode(() => assertProfileName(bad), 'MANAGED_POLICY_PATH');
  }
  for (const bad of ['repo', 'github:../repo', 'github:repo\\admin', 'github:répo', 'github:repo\nother']) {
    assert.throws(() => assertRepositoryIdentity(bad));
  }
  for (const bad of ['../root.json', '/root.json', 'C:/root.json', 'a\\root.json', 'a//root.json']) {
    throwsCode(() => assertMetadataPath(bad), 'MANAGED_POLICY_PATH');
  }
});

test('managed schema rejects unknown, duplicate, dangling, and inert policy definitions', () => {
  assert.equal(validateManagedPolicyObject(managed()).profile, 'production');

  const unknown = managed();
  unknown.silentDefault = true;
  throwsCode(() => validateManagedPolicyObject(unknown), 'MANAGED_POLICY_SCHEMA');

  const duplicateAssignment = managed();
  duplicateAssignment.assignments.push({ ...duplicateAssignment.assignments[0] });
  throwsCode(() => validateManagedPolicyObject(duplicateAssignment), 'MANAGED_POLICY_SCHEMA');

  const dangling = managed();
  dangling.assignments[0].policies = ['does-not-exist'];
  throwsCode(() => validateManagedPolicyObject(dangling), 'MANAGED_POLICY_SCHEMA');

  const inert = managed();
  inert.policies.push({ id: 'unused', policy: policy('unused-rule') });
  throwsCode(() => validateManagedPolicyObject(inert), 'MANAGED_POLICY_VACUOUS');
});

test('the staged receipt is exact, sorted, and cannot omit monotonic versions', () => {
  const receipt = {
    version: 1,
    profile: 'production',
    target: { path: 'policy.json', sha256: 'a'.repeat(64), length: 12 },
    rootSha256: 'b'.repeat(64),
    versions: { root: 1, timestamp: 2, snapshot: 3, targets: 4 },
    verifiedAt: '2026-08-05T00:00:00Z',
    expires: {
      timestamp: '2026-08-06T00:00:00Z',
      snapshot: '2026-08-07T00:00:00Z',
      targets: '2026-08-08T00:00:00Z',
    },
    metadata: [
      { path: 'root.json', sha256: 'c'.repeat(64), length: 3 },
      { path: 'targets.json', sha256: 'd'.repeat(64), length: 3 },
    ],
  };
  assert.equal(validateStagedVerificationObject(receipt).versions.targets, 4);
  throwsCode(
    () => validateStagedVerificationObject({ ...receipt, versions: { root: 1, timestamp: 2, snapshot: 3 } }),
    'MANAGED_POLICY_SCHEMA',
  );
  throwsCode(
    () => validateStagedVerificationObject({ ...receipt, metadata: [...receipt.metadata].reverse() }),
    'MANAGED_POLICY_SCHEMA',
  );
});

test('receipt timestamps reject calendar normalization while preserving valid leap dates and nanoseconds', () => {
  const receipt = {
    version: 1,
    profile: 'production',
    target: { path: 'policy.json', sha256: 'a'.repeat(64), length: 12 },
    rootSha256: 'b'.repeat(64),
    versions: { root: 1, timestamp: 2, snapshot: 3, targets: 4 },
    verifiedAt: '2028-02-29T00:00:00.123456789Z',
    expires: {
      timestamp: '2028-02-29T00:00:01.123456789Z',
      snapshot: '2028-03-01T00:00:00Z',
      targets: '2028-03-02T00:00:00Z',
    },
    metadata: [{ path: 'root.json', sha256: 'c'.repeat(64), length: 3 }],
  };
  assert.equal(validateStagedVerificationObject(receipt).verifiedAt, receipt.verifiedAt);
  for (const impossible of [
    '2026-02-29T00:00:00Z',
    '2026-02-30T00:00:00Z',
    '2026-04-31T00:00:00Z',
    '2026-01-01T24:00:00Z',
  ]) {
    throwsCode(
      () => validateStagedVerificationObject({ ...receipt, verifiedAt: impossible }),
      'MANAGED_POLICY_SCHEMA',
    );
  }
});

test('policy-object validation is exported and source evaluation can only add failures', () => {
  assert.equal(validatePolicyObject(policy()).rules.length, 1);
  const sources = [
    { namespace: 'managed:production:baseline', policy: policy('managed-rule') },
    { namespace: 'base:reviewed', policy: policy('base-rule') },
    { namespace: 'candidate:proposal', policy: policy('candidate-rule') },
  ];
  const result = evaluatePolicySources(sources, {
    audit: { unlanded: [{ name: 'work', fileCount: 1, files: ['a.js'] }], unknown: [] },
    inlineFailures: [{ message: 'inline gate also refused', subject: 'work' }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors, 4);
  assert.deepEqual(result.violations.map((item) => item.source), [
    'managed:production:baseline', 'base:reviewed', 'candidate:proposal', 'inline',
  ]);
  assert.deepEqual(result.rulesEvaluated, [
    'managed:production:baseline:managed-rule',
    'base:reviewed:base-rule',
    'candidate:proposal:candidate-rule',
  ]);
});

test('policy thresholds and exemptions cannot become non-finite or universally vacuous', () => {
  for (const days of [Infinity, -Infinity, NaN, 'Infinity', 0, -1, 365_001]) {
    assert.throws(
      () => validatePolicyObject({ version: 1, rules: [{ id: 'age', type: 'max-branch-age', days }] }),
      (error) => error?.code === 'POLICY_RULE',
    );
  }
  assert.throws(
    () => parsePolicy('{"version":1,"rules":[{"id":"age","type":"max-branch-age","days":1e400}]}', 'overflow'),
    (error) => error?.code === 'POLICY_RULE',
  );
  for (const glob of ['**', '***', '****', '**/**', '**/*']) {
    assert.throws(
      () => validatePolicyObject({ version: 1, rules: [{ id: 'rule', type: 'no-unlanded', exempt: [glob] }] }),
      (error) => error?.code === 'POLICY_VACUOUS',
      `glob ${glob} must not exempt every subject`,
    );
  }
  assert.equal(validatePolicyObject({
    version: 1, rules: [{ id: 'rule', type: 'no-unlanded', exempt: ['*/**'] }],
  }).rules.length, 1, 'a nested-only exemption is not falsely rejected as universal');
});

test('age and protected-path rules fail closed on missing, duplicate, or malformed evidence', () => {
  const missingAge = evaluatePolicy(
    { version: 1, rules: [{ id: 'age', type: 'max-branch-age', days: 10, severity: 'warn' }] },
    { audit: { unlanded: [{ name: 'unknown-age', fileCount: 0, files: [] }], unknown: [] } },
  );
  assert.equal(missingAge.ok, false);
  assert.equal(missingAge.violations[0].severity, 'error');

  for (const branch of [
    { name: 'duplicate', fileCount: 2, carriedPaths: ['src/a.js', 'src/a.js'] },
    { name: 'wrong-count', fileCount: 2, carriedPaths: ['src/a.js'] },
    { name: 'invalid-path', fileCount: 1, carriedPaths: ['bad\0path'] },
  ]) {
    const result = evaluatePolicy(
      { version: 1, rules: [{ id: 'protect', type: 'protected-paths', paths: ['secrets/**'] }] },
      { audit: { unlanded: [branch], unknown: [] }, report: { unique: [] } },
    );
    assert.equal(result.ok, false, branch.name);
    assert.match(result.violations[0].message, /inventory/u);
  }

  const invalidWorktree = evaluatePolicy(
    { version: 1, rules: [{ id: 'protect', type: 'protected-paths', paths: ['secrets/**'] }] },
    {
      audit: { unlanded: [], unknown: [] },
      report: { unique: [{ id: 'wt', pathsByLayer: { uncommitted: 'not-an-array', untracked: [] } }] },
    },
  );
  assert.equal(invalidWorktree.ok, false);
  assert.match(invalidWorktree.violations[0].message, /evidence is invalid/u);
});
