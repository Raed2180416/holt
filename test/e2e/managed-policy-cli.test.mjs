// SPDX-License-Identifier: FSL-1.1-MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { FEATURE_TIER, tierEntitles } from '../../src/license.mjs';
import {
  evaluateSystemManagedPolicyForCi,
  managedPolicyCommand,
  managedPolicyStore,
  resolveSystemManagedPolicyForCi,
  userManagedPolicyStore,
} from '../../src/team/managed-policy-cli.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'holt.mjs');
const holt = (args) => new Promise((resolve) => {
  execFile(process.execPath, [BIN, ...args], {
    cwd: process.cwd(), timeout: 30_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1', HOLT_LICENSE: '' },
  }, (error, stdout, stderr) => resolve({
    code: error ? (error.code ?? 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''),
  }));
});

test('managed-policy is a real Enterprise entitlement with a reachable command surface', async () => {
  assert.equal(FEATURE_TIER['managed-policy'], 'enterprise');
  assert.equal(tierEntitles('team', 'managed-policy'), false);
  assert.equal(tierEntitles('enterprise', 'managed-policy'), true);

  await assert.rejects(
    managedPolicyCommand('status', { authority: 'user', profile: 'production', store: path.join(os.tmpdir(), 'unused-managed-store') }),
    (error) => error?.code === 'MANAGED_POLICY_UNLICENSED',
  );
  await assert.rejects(
    managedPolicyCommand('status', { profile: 'production' }),
    (error) => error?.code === 'MANAGED_POLICY_CLI_ARGUMENT' && /--authority/.test(error.message),
  );

  const malformed = await holt(['managed-policy', 'nope', '--json']);
  assert.equal(malformed.code, 2);
  assert.equal(JSON.parse(malformed.stdout).code, 'MANAGED_POLICY_CLI_ARGUMENT');
  const unlicensed = await holt(['managed-policy', 'status', '--authority', 'user', '--profile', 'production',
    '--store', path.join(os.tmpdir(), `holt-unlicensed-${process.pid}`), '--json']);
  assert.equal(unlicensed.code, 3);
  assert.equal(JSON.parse(unlicensed.stdout).code, 'MANAGED_POLICY_UNLICENSED');
});

test('system authority has one fixed canonical store identity; user stores remain explicitly non-system', async () => {
  const user = userManagedPolicyStore({ env: { XDG_CONFIG_HOME: '/safe/config' }, home: '/ignored' });
  assert.equal(user, path.join('/safe/config', 'holt', 'managed-policy'));
  assert.equal(await managedPolicyStore({ authority: 'user', store: '/custom/customer-store' }), path.resolve('/custom/customer-store'));
  if (process.platform !== 'win32') {
    assert.equal(await managedPolicyStore({ authority: 'system' }), '/etc/holt/managed-policy');
    await assert.rejects(
      managedPolicyStore({ authority: 'system', store: '/custom/customer-store' }),
      (error) => error?.code === 'MANAGED_POLICY_SYSTEM_STORE',
    );
  }
});

test('CI has no system profile regression when the fixed store is absent', async (t) => {
  if (process.platform === 'win32') t.skip('Windows correctly has no system authority implementation');
  const absent = await resolveSystemManagedPolicyForCi({ repositoryRoot: process.cwd() });
  // A developer machine with an administrator-deployed profile is outside this no-profile
  // regression fixture; do not reinterpret that real deployment as an absent store.
  if (!absent.present) assert.deepEqual(absent, { present: false, claimed: false, authority: null });
  else assert.equal(absent.claimed, false, 'this repository is not an enrolled machine binding');
});

test('system CI composition is additive: candidate policy and inline ignore cannot suppress the central rule', () => {
  const central = { version: 1, rules: [{ id: 'central', type: 'no-unlanded', severity: 'error' }] };
  const candidate = { version: 1, rules: [{ id: 'candidate', type: 'no-unlanded', severity: 'error', exempt: ['sole-copy'] }] };
  const result = evaluateSystemManagedPolicyForCi({
    resolved: {
      claimed: true,
      storeRoot: '/etc/holt/managed-policy',
      authority: {
        profile: 'production', authority: 'system', rootSha256: 'a'.repeat(64), generation: 'b'.repeat(64),
        binding: { identity: 'github-repository-id:123456', source: 'system-enrollment' },
        freshness: { earliestExpiry: '2030-01-01T00:00:00.000Z' },
        policies: [{ id: 'baseline', namespace: 'managed:production:baseline', policy: central }],
      },
      recovery: { state: 'clean', recoveryRequired: false }, status: { state: 'active' },
    },
    audit: { unlanded: [{ name: 'sole-copy', fileCount: 1, files: ['secret.txt'] }], unknown: [] },
    report: { unique: [] },
    candidatePolicies: [{ id: 'candidate', policy: candidate }],
    inlineFailures: [],
    ignore: ['sole-copy'],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.violations.map((entry) => entry.source), ['managed:production:baseline']);
  assert.equal(result.system.authority, 'system (machine authority)');
  assert.equal(result.system.rootFingerprint, 'a'.repeat(64));
  assert.equal(result.system.generation, 'b'.repeat(64));
  assert.equal(result.system.lastGoodStatus.state, 'active');
});
