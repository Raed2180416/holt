// SPDX-License-Identifier: FSL-1.1-MIT
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  activateStagedManagedPolicy,
  enrollManagedPolicyProfile,
  inspectManagedPolicyRecovery,
  loadManagedPolicyProfile,
  managedPolicyProfilePaths,
  readManagedPolicyStatus,
  recoverManagedPolicyActivation,
} from '../../src/team/managed-policy-store.mjs';
import {
  managedPolicyStore,
  prepareSystemManagedPolicyForCi,
  revalidatePreparedSystemManagedPolicyForCi,
  resolvePreparedSystemManagedPolicyForCi,
} from '../../src/team/managed-policy-cli.mjs';
import {
  evaluateManagedPolicyAuthority,
  repositoryIdentityBinding,
  revalidateManagedPolicyAuthority,
  revalidateSystemRepositoryIdentityBinding,
  resolveManagedPolicyAuthority,
  systemRepositoryIdentityBinding,
} from '../../src/team/managed-policy-authority.mjs';
import { canonicalJson } from '../../src/team/managed-policy-schema.mjs';
import {
  registerSystemManagedPolicyNamespace,
  systemManagedPolicyTest as test,
} from '../lib/system-managed-policy-namespace.mjs';

registerSystemManagedPolicyNamespace(
  import.meta.url,
  'system managed-policy authority suite passes under the real uid-0 and fixed-/etc contract',
);

const PROFILE = 'production';
const REPOSITORY = 'github-repository-id:123456';
const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/holt.mjs');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const DEFAULT_VERIFIED_AT = new Date(Date.now() - 60_000).toISOString();
const DEFAULT_EXPIRES = Object.freeze({
  timestamp: new Date(Date.now() + 86_400_000).toISOString(),
  snapshot: new Date(Date.now() + 172_800_000).toISOString(),
  targets: new Date(Date.now() + 259_200_000).toISOString(),
});

const bootstrapRoot = (version = 1) => canonicalJson({
  signed: { _type: 'root', version },
  signatures: [],
});

const rulePolicy = (ruleId = 'managed-no-unlanded') => ({
  version: 1,
  rules: [{ id: ruleId, type: 'no-unlanded', severity: 'error' }],
});

const bundle = (ruleId = 'managed-no-unlanded') => ({
  version: 1,
  profile: PROFILE,
  policies: [{ id: 'baseline', policy: rulePolicy(ruleId) }],
  assignments: [{ repository: REPOSITORY, policies: ['baseline'] }],
});

async function makeWritable(entry) {
  const stat = await fs.lstat(entry).catch(() => null);
  if (!stat || stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await fs.chmod(entry, 0o700);
    for (const name of await fs.readdir(entry)) await makeWritable(path.join(entry, name));
  } else {
    await fs.chmod(entry, 0o600);
  }
}

async function clearSystemStore() {
  const storeRoot = '/etc/holt/managed-policy';
  await makeWritable(storeRoot);
  await fs.rm(storeRoot, { recursive: true, force: true });
}

async function fixture(t, label, authority = 'system') {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), `holt-managed-${label}-`));
  const repositoryRoot = path.join(temporary, 'repository');
  await fs.mkdir(repositoryRoot, { mode: 0o700 });
  const storeRoot = '/etc/holt/managed-policy';
  t.after(async () => {
    const paths = managedPolicyProfilePaths(storeRoot, PROFILE);
    await fs.chmod(paths.profile, 0o700).catch(() => {});
    await fs.chmod(paths.generations, 0o700).catch(() => {});
    await fs.unlink(paths.lock).catch(() => {});
    await clearSystemStore();
    await makeWritable(temporary);
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const enrollment = await enrollManagedPolicyProfile({
    storeRoot,
    profile: PROFILE,
    authority,
    bootstrapRoot: bootstrapRoot(),
    repositoryBindings: [{ root: repositoryRoot, identity: REPOSITORY }],
  });
  return {
    temporary, repositoryRoot, storeRoot, enrollment,
    paths: managedPolicyProfilePaths(storeRoot, PROFILE),
  };
}

async function stagedGeneration(root, enrollment, {
  document = bundle(),
  versions = { root: 1, timestamp: 1, snapshot: 1, targets: 1 },
  verifiedAt = DEFAULT_VERIFIED_AT,
  expires = DEFAULT_EXPIRES,
  metadataFiles = 4,
  metadataBytes = 0,
} = {}) {
  // Activation is intentionally a same-filesystem rename. /etc is a private bind mount in this
  // suite, so staging beside (but never inside) the active profile exercises that real contract.
  const staged = path.join('/etc/holt/managed-policy', `stage-${randomUUID()}`);
  const metadataRoot = path.join(staged, 'metadata');
  await fs.mkdir(metadataRoot, { recursive: true, mode: 0o700 });
  const policyBytes = Buffer.from(canonicalJson(document));
  await fs.writeFile(path.join(staged, 'policy.json'), policyBytes, { mode: 0o600 });

  const baseNames = ['root.json', 'snapshot.json', 'targets.json', 'timestamp.json'];
  const names = Array.from({ length: metadataFiles }, (_, index) => baseNames[index]
    ?? `delegated-${String(index).padStart(3, '0')}.json`);
  for (let i = 0; i < names.length; i++) {
    const padding = metadataBytes ? 'x'.repeat(metadataBytes) : undefined;
    await fs.writeFile(
      path.join(metadataRoot, names[i]),
      canonicalJson({ version: i + 1, ...(padding ? { padding } : {}) }),
      { mode: 0o600 },
    );
  }
  const metadata = [];
  for (const name of [...names].sort()) {
    const bytes = await fs.readFile(path.join(metadataRoot, name));
    metadata.push({ path: name, sha256: sha256(bytes), length: bytes.length });
  }
  return {
    staged,
    verification: {
      version: 1,
      profile: PROFILE,
      target: { path: 'policy.json', sha256: sha256(policyBytes), length: policyBytes.length },
      rootSha256: enrollment.rootSha256,
      versions,
      metadata,
      verifiedAt,
      expires: { ...expires },
    },
  };
}

const rejectsCode = (promise, code) => assert.rejects(promise, (error) => error?.code === code);
const permissionBits = async (entry) => (await fs.stat(entry)).mode & 0o777;
const execute = (command, args, options = {}) => new Promise((resolve) => {
  execFile(command, args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, ...options },
    (error, stdout, stderr) => resolve({
      code: error ? (error.code ?? 1) : 0,
      stdout: String(stdout ?? ''),
      stderr: String(stderr ?? ''),
    }));
});

async function initializeRepository(repositoryRoot) {
  const initialized = await execute('git', ['init', '--initial-branch=main', repositoryRoot]);
  assert.equal(initialized.code, 0, initialized.stderr);
  await fs.writeFile(path.join(repositoryRoot, 'README.md'), 'managed-policy fixture\n');
  assert.equal((await execute('git', ['-C', repositoryRoot, 'add', 'README.md'])).code, 0);
  const committed = await execute('git', [
    '-C', repositoryRoot,
    '-c', 'user.name=Holt Test',
    '-c', 'user.email=holt-test@example.invalid',
    'commit', '-m', 'fixture',
  ]);
  assert.equal(committed.code, 0, committed.stderr);
}

nodeTest('NODE_TEST_CONTEXT spoof and caller-selected uid cannot mint system authority', async (t) => {
  if (process.platform === 'win32') return t.skip('Windows intentionally has no system authority implementation');
  assert.match(process.env.NODE_TEST_CONTEXT ?? '', /^child(?:-|$)/u,
    'regression executes with the ambient value an external caller can spoof');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-system-policy-spoof-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  await rejectsCode(enrollManagedPolicyProfile({
    storeRoot: path.join(temporary, 'caller-selected-store'),
    profile: PROFILE,
    authority: 'system',
    bootstrapRoot: bootstrapRoot(),
    expectedSystemOwnerUid: typeof process.getuid === 'function' ? process.getuid() : 0,
    repositoryBindings: [],
  }), 'MANAGED_POLICY_SYSTEM_STORE');
  assert.equal(await fs.stat(path.join(temporary, 'caller-selected-store')).then(() => true, () => false), false,
    'refusal happens before the arbitrary store is created');
});

test('system-enrolled active policy resolves by exact trusted identity and evaluates every layer additively without fetch', async (t) => {
  const f = await fixture(t, 'happy');
  const storeAlias = path.join(f.temporary, 'system-store-alias');
  await fs.symlink(f.storeRoot, storeAlias, 'dir');
  assert.equal(await managedPolicyStore({ authority: 'system', store: storeAlias }), f.storeRoot,
    'CLI store identity canonicalizes aliases instead of comparing native path spellings');
  await rejectsCode(enrollManagedPolicyProfile({
    storeRoot: storeAlias,
    profile: 'alias-boundary',
    authority: 'system',
    bootstrapRoot: bootstrapRoot(),
    repositoryBindings: [],
  }), 'MANAGED_POLICY_SYMLINK');

  const staged = await stagedGeneration(f.temporary, f.enrollment);
  const activated = await activateStagedManagedPolicy({
    storeRoot: f.storeRoot,
    profile: PROFILE,
    stagedDirectory: staged.staged,
    verification: staged.verification,
  });
  assert.equal(activated.ok, true);
  assert.equal(activated.installed, true);
  assert.equal(activated.authentication, 'external-verifier-required');
  assert.equal(await fs.stat(staged.staged).then(() => true, () => false), false, 'staging is consumed by rename');

  const loaded = await loadManagedPolicyProfile({ storeRoot: f.storeRoot, profile: PROFILE });
  assert.equal(loaded.active.targetSha256, staged.verification.target.sha256);
  assert.equal(loaded.policy.profile, PROFILE);
  assert.equal((await readManagedPolicyStatus({ storeRoot: f.storeRoot, profile: PROFILE })).state, 'active');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('managed policy attempted a network fetch'); };
  try {
    const repositoryBinding = await systemRepositoryIdentityBinding({
      storeRoot: f.storeRoot,
      profile: PROFILE,
      repositoryRoot: f.repositoryRoot,
    });
    const identityEvidence = await revalidateSystemRepositoryIdentityBinding(repositoryBinding);
    assert.equal(identityEvidence.realRoot, f.repositoryRoot);
    assert.equal(identityEvidence.device, repositoryBinding.device);
    assert.equal(Object.isFrozen(repositoryBinding), true);
    const authority = await resolveManagedPolicyAuthority({
      storeRoot: f.storeRoot,
      profile: PROFILE,
      repositoryBinding,
      expectedAuthority: 'system',
    });
    assert.equal(authority.claimed, true);
    assert.equal(authority.mandatory, true);

    const result = evaluateManagedPolicyAuthority({
      authority,
      basePolicies: [{ id: 'reviewed', policy: rulePolicy('base-no-unlanded') }],
      candidatePolicies: [{ id: 'proposal', policy: rulePolicy('candidate-no-unlanded') }],
      inlineFailures: [{ message: 'inline constraint refused', subject: 'sole-copy' }],
      audit: { unlanded: [{ name: 'sole-copy', fileCount: 1, files: ['secret.txt'] }], unknown: [] },
      report: { unique: [] },
    });
    assert.equal(result.ok, false);
    assert.equal(result.errors, 4);
    assert.deepEqual(result.violations.map((item) => item.source), [
      'managed:production:baseline', 'base:reviewed', 'candidate:proposal', 'inline',
    ]);
    assert.equal(result.managed.mandatory, true);

    const cannotIgnoreManaged = evaluateManagedPolicyAuthority({
      authority,
      ignore: ['sole-copy'],
      audit: { unlanded: [{ name: 'sole-copy', fileCount: 1, files: ['secret.txt'] }], unknown: [] },
      report: { unique: [] },
    });
    assert.equal(cannotIgnoreManaged.ok, false);
    assert.deepEqual(cannotIgnoreManaged.violations.map((item) => item.source), ['managed:production:baseline']);
    assert.equal((await revalidateManagedPolicyAuthority(authority)).inode, repositoryBinding.inode);
    assert.throws(
      () => evaluateManagedPolicyAuthority({ authority, audit: { unlanded: [], unknown: [] } }),
      (error) => error?.code === 'MANAGED_POLICY_EVIDENCE',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.throws(
    () => repositoryIdentityBinding({ identity: REPOSITORY, source: 'trusted-ci' }),
    (error) => error?.code === 'MANAGED_POLICY_IDENTITY_SOURCE',
  );
  await rejectsCode(
    resolveManagedPolicyAuthority({
      storeRoot: f.storeRoot,
      profile: PROFILE,
      repositoryBinding: repositoryIdentityBinding({ identity: REPOSITORY, source: 'user-enrollment' }),
    }),
    'MANAGED_POLICY_IDENTITY_SOURCE',
  );
  await rejectsCode(
    resolveManagedPolicyAuthority({
      storeRoot: f.storeRoot,
      profile: PROFILE,
      repositoryBinding: Object.freeze({ version: 1, identity: REPOSITORY, source: 'system-enrollment' }),
    }),
    'MANAGED_POLICY_IDENTITY_SOURCE',
  );
});

test('system repository binding fails closed after its enrolled path is replaced', async (t) => {
  const f = await fixture(t, 'identity-swap');
  const staged = await stagedGeneration(f.temporary, f.enrollment);
  await activateStagedManagedPolicy({
    storeRoot: f.storeRoot, profile: PROFILE,
    stagedDirectory: staged.staged, verification: staged.verification,
  });
  const binding = await systemRepositoryIdentityBinding({
    storeRoot: f.storeRoot, profile: PROFILE,
    repositoryRoot: f.repositoryRoot,
  });
  const authority = await resolveManagedPolicyAuthority({
    storeRoot: f.storeRoot, profile: PROFILE, repositoryBinding: binding,
  });
  assert.equal((await revalidateManagedPolicyAuthority(authority)).inode, binding.inode,
    'unchanged enrolled root passes the final identity boundary');

  const displaced = path.join(f.temporary, 'repository-before-swap');
  await fs.rename(f.repositoryRoot, displaced);
  await fs.mkdir(f.repositoryRoot, { mode: 0o700 });
  const replacement = await fs.lstat(f.repositoryRoot, { bigint: true });
  assert.notEqual(String(replacement.ino), binding.inode, 'the path now names a different directory inode');

  await rejectsCode(revalidateSystemRepositoryIdentityBinding(binding), 'MANAGED_POLICY_IDENTITY_MISMATCH');
  await rejectsCode(revalidateManagedPolicyAuthority(authority), 'MANAGED_POLICY_IDENTITY_MISMATCH');
  await rejectsCode(
    resolveManagedPolicyAuthority({
      storeRoot: f.storeRoot, profile: PROFILE, repositoryBinding: binding,
    }),
    'MANAGED_POLICY_IDENTITY_MISMATCH',
  );
});

test('CI targeting is path-authoritative: alternate workspaces and spoofed labels refuse, and same-path replacement refuses', async (t) => {
  const previousUmask = process.umask(0o077);
  let f;
  try {
    f = await fixture(t, 'ci-targeting');
  } finally {
    process.umask(previousUmask);
  }
  const staged = await stagedGeneration(f.temporary, f.enrollment);
  const activated = await activateStagedManagedPolicy({
    storeRoot: f.storeRoot, profile: PROFILE,
    stagedDirectory: staged.staged, verification: staged.verification,
  });

  // A system deployment must be readable by an ordinary CI service account but writable only by
  // root. These exact modes are an executable proxy for that cross-uid deployment contract.
  assert.equal(await permissionBits(f.storeRoot), 0o755);
  assert.equal(await permissionBits(path.join(f.storeRoot, 'profiles')), 0o755);
  assert.equal(await permissionBits(f.paths.profile), 0o755);
  assert.equal(await permissionBits(f.paths.bootstrapRoot), 0o444);
  assert.equal(await permissionBits(f.paths.active), 0o644);
  assert.equal(await permissionBits(f.paths.status), 0o644);
  const generationRoot = path.join(f.paths.generations, activated.generation);
  assert.equal(await permissionBits(generationRoot), 0o555);
  assert.equal(await permissionBits(path.join(generationRoot, 'policy.json')), 0o444);

  const untargetedRoot = path.join(f.temporary, 'different-workspace');
  await fs.mkdir(untargetedRoot, { mode: 0o700 });
  await initializeRepository(untargetedRoot);
  const priorRepository = process.env.GITHUB_REPOSITORY;
  const priorRepositoryId = process.env.GITHUB_REPOSITORY_ID;
  process.env.GITHUB_REPOSITORY = 'spoofed-owner/spoofed-repository';
  process.env.GITHUB_REPOSITORY_ID = '123456';
  try {
    await rejectsCode(
      prepareSystemManagedPolicyForCi({
        repositoryRoot: untargetedRoot,
        // Unknown properties are intentionally irrelevant: only the discovered filesystem root
        // and root-owned enrollment can target a checkout.
        repository: REPOSITORY,
      }),
      'MANAGED_POLICY_NOT_TARGETED',
    );
    const cli = await execute(process.execPath, [BIN, 'ci', '--cwd', untargetedRoot, '--json'], {
      cwd: untargetedRoot,
      env: {
        ...process.env,
        HOLT_LICENSE: '',
        GITHUB_REPOSITORY: 'spoofed-owner/spoofed-repository',
        GITHUB_REPOSITORY_ID: '123456',
      },
    });
    assert.equal(cli.code, 2, `${cli.stdout}\n${cli.stderr}`);
    assert.equal(JSON.parse(cli.stdout).code, 'MANAGED_POLICY_NOT_TARGETED',
      'the shipped CLI refuses an alternate checkout before ordinary policy can run');
  } finally {
    if (priorRepository === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = priorRepository;
    if (priorRepositoryId === undefined) delete process.env.GITHUB_REPOSITORY_ID;
    else process.env.GITHUB_REPOSITORY_ID = priorRepositoryId;
  }

  const targeted = await prepareSystemManagedPolicyForCi({ repositoryRoot: f.repositoryRoot });
  assert.equal(targeted.candidates.length, 1);
  assert.equal(targeted.candidates[0].binding.identity, REPOSITORY,
    'the identity comes only from root-owned enrollment, not process input');
  await revalidatePreparedSystemManagedPolicyForCi(targeted);

  const displaced = path.join(f.temporary, 'enrolled-workspace-before-replacement');
  await fs.rename(f.repositoryRoot, displaced);
  await fs.mkdir(f.repositoryRoot, { mode: 0o700 });
  await rejectsCode(
    prepareSystemManagedPolicyForCi({ repositoryRoot: f.repositoryRoot }),
    'MANAGED_POLICY_IDENTITY_MISMATCH',
  );
});

test('initial system authority rejects a shared multi-profile runner instead of guessing which repository is exempt', async (t) => {
  const f = await fixture(t, 'ci-multiple-profiles');
  const secondRoot = path.join(f.temporary, 'second-repository');
  await fs.mkdir(secondRoot, { mode: 0o700 });
  await enrollManagedPolicyProfile({
    storeRoot: f.storeRoot,
    profile: 'secondary',
    authority: 'system',
    bootstrapRoot: bootstrapRoot(),
    repositoryBindings: [{ root: secondRoot, identity: 'github-repository-id:999999' }],
  });
  await rejectsCode(
    prepareSystemManagedPolicyForCi({ repositoryRoot: f.repositoryRoot }),
    'MANAGED_POLICY_AMBIGUOUS',
  );
});

test('a targeted system workspace without a signed assignment refuses instead of falling through to ordinary CI', async (t) => {
  const f = await fixture(t, 'ci-assignment-missing');
  await initializeRepository(f.repositoryRoot);
  const otherRepository = 'github-repository-id:999999';
  const staged = await stagedGeneration(f.temporary, f.enrollment, {
    document: {
      version: 1,
      profile: PROFILE,
      policies: [{ id: 'baseline', policy: rulePolicy() }],
      assignments: [{ repository: otherRepository, policies: ['baseline'] }],
    },
  });
  await activateStagedManagedPolicy({
    storeRoot: f.storeRoot, profile: PROFILE,
    stagedDirectory: staged.staged, verification: staged.verification,
  });
  const prepared = await prepareSystemManagedPolicyForCi({ repositoryRoot: f.repositoryRoot });
  assert.equal(prepared.candidates.length, 1);
  await rejectsCode(resolvePreparedSystemManagedPolicyForCi(prepared), 'MANAGED_POLICY_ASSIGNMENT_MISSING');
  const cli = await execute(process.execPath, [BIN, 'ci', '--cwd', f.repositoryRoot, '--json'], {
    cwd: f.repositoryRoot,
    env: { ...process.env, HOLT_LICENSE: '' },
  });
  assert.equal(cli.code, 2, `${cli.stdout}\n${cli.stderr}`);
  assert.equal(JSON.parse(cli.stdout).code, 'MANAGED_POLICY_ASSIGNMENT_MISSING');
});

test('exclusive lock, symlink, and receipt mismatch defenses refuse before activation', async (t) => {
  const f = await fixture(t, 'hostile-stage');
  const locked = await stagedGeneration(f.temporary, f.enrollment);
  await fs.writeFile(f.paths.lock, 'held', { mode: 0o600 });
  await rejectsCode(
    activateStagedManagedPolicy({
      storeRoot: f.storeRoot, profile: PROFILE,
      stagedDirectory: locked.staged, verification: locked.verification,
    }),
    'MANAGED_POLICY_LOCKED',
  );
  await fs.unlink(f.paths.lock);
  assert.equal((await fs.readdir(f.paths.generations)).length, 0);

  const wrongHash = await stagedGeneration(f.temporary, f.enrollment);
  wrongHash.verification.target.sha256 = 'f'.repeat(64);
  await rejectsCode(
    activateStagedManagedPolicy({
      storeRoot: f.storeRoot, profile: PROFILE,
      stagedDirectory: wrongHash.staged, verification: wrongHash.verification,
    }),
    'MANAGED_POLICY_RECEIPT_MISMATCH',
  );
  assert.equal((await fs.readdir(f.paths.generations)).length, 0);

  const linked = await stagedGeneration(f.temporary, f.enrollment);
  const external = path.join(f.temporary, 'outside-policy.json');
  await fs.writeFile(external, canonicalJson(bundle()), { mode: 0o600 });
  await fs.unlink(path.join(linked.staged, 'policy.json'));
  await fs.symlink(external, path.join(linked.staged, 'policy.json'));
  await rejectsCode(
    activateStagedManagedPolicy({
      storeRoot: f.storeRoot, profile: PROFILE,
      stagedDirectory: linked.staged, verification: linked.verification,
    }),
    'MANAGED_POLICY_SYMLINK',
  );
  assert.equal((await fs.readdir(f.paths.generations)).length, 0);

  const hardlinked = await stagedGeneration(f.temporary, f.enrollment);
  await fs.link(
    path.join(hardlinked.staged, 'policy.json'),
    path.join(f.storeRoot, 'outside-hardlink.json'),
  );
  await rejectsCode(
    activateStagedManagedPolicy({
      storeRoot: f.storeRoot, profile: PROFILE,
      stagedDirectory: hardlinked.staged, verification: hardlinked.verification,
    }),
    'MANAGED_POLICY_HARDLINK',
  );
  assert.equal((await fs.readdir(f.paths.generations)).length, 0);

  const nested = await stagedGeneration(f.temporary, f.enrollment);
  const nestedInsideProfile = path.join(f.paths.profile, 'attacker-controlled-stage');
  await fs.rename(nested.staged, nestedInsideProfile);
  await rejectsCode(
    activateStagedManagedPolicy({
      storeRoot: f.storeRoot, profile: PROFILE,
      stagedDirectory: nestedInsideProfile, verification: nested.verification,
    }),
    'MANAGED_POLICY_PATH',
  );
  assert.equal((await fs.readdir(f.paths.generations)).length, 0);
});

test('invalid and rollback candidates retain exact last-good active bytes', async (t) => {
  const f = await fixture(t, 'last-good');
  const first = await stagedGeneration(f.temporary, f.enrollment, {
    document: bundle('generation-one'),
    versions: { root: 2, timestamp: 8, snapshot: 7, targets: 6 },
  });
  await activateStagedManagedPolicy({
    storeRoot: f.storeRoot, profile: PROFILE,
    stagedDirectory: first.staged, verification: first.verification,
  });
  const activeBefore = await fs.readFile(f.paths.active);

  const mismatched = await stagedGeneration(f.temporary, f.enrollment, {
    document: bundle('generation-two'),
    versions: { root: 2, timestamp: 9, snapshot: 8, targets: 7 },
  });
  mismatched.verification.target.length++;
  await rejectsCode(
    activateStagedManagedPolicy({
      storeRoot: f.storeRoot, profile: PROFILE,
      stagedDirectory: mismatched.staged, verification: mismatched.verification,
    }),
    'MANAGED_POLICY_RECEIPT_MISMATCH',
  );
  assert.deepEqual(await fs.readFile(f.paths.active), activeBefore);

  const equalVersionChangedTarget = await stagedGeneration(f.temporary, f.enrollment, {
    document: bundle('same-version-equivocation'),
    versions: { root: 2, timestamp: 8, snapshot: 7, targets: 6 },
  });
  await rejectsCode(
    activateStagedManagedPolicy({
      storeRoot: f.storeRoot, profile: PROFILE,
      stagedDirectory: equalVersionChangedTarget.staged,
      verification: equalVersionChangedTarget.verification,
    }),
    'MANAGED_POLICY_EQUIVOCATION',
  );
  assert.deepEqual(await fs.readFile(f.paths.active), activeBefore);

  const rollback = await stagedGeneration(f.temporary, f.enrollment, {
    document: bundle('generation-three'),
    versions: { root: 1, timestamp: 9, snapshot: 8, targets: 7 },
  });
  await rejectsCode(
    activateStagedManagedPolicy({
      storeRoot: f.storeRoot, profile: PROFILE,
      stagedDirectory: rollback.staged, verification: rollback.verification,
    }),
    'MANAGED_POLICY_ROLLBACK',
  );
  assert.deepEqual(await fs.readFile(f.paths.active), activeBefore);
  assert.equal((await loadManagedPolicyProfile({ storeRoot: f.storeRoot, profile: PROFILE })).policy
    .policies[0].policy.rules[0].id, 'generation-one');
});

test('journalled crash after immutable install refuses normal load and completes only the exact transaction', async (t) => {
  const f = await fixture(t, 'commit-recovery');
  const first = await stagedGeneration(f.temporary, f.enrollment, {
    document: bundle('last-good'),
    versions: { root: 1, timestamp: 1, snapshot: 1, targets: 1 },
  });
  await activateStagedManagedPolicy({
    storeRoot: f.storeRoot, profile: PROFILE,
    stagedDirectory: first.staged, verification: first.verification,
  });
  const activeBefore = await fs.readFile(f.paths.active);
  const previousActive = JSON.parse(activeBefore);

  const next = await stagedGeneration(f.temporary, f.enrollment, {
    document: bundle('recovered-generation'),
    versions: { root: 2, timestamp: 2, snapshot: 2, targets: 2 },
  });
  const committed = await activateStagedManagedPolicy({
    storeRoot: f.storeRoot, profile: PROFILE,
    stagedDirectory: next.staged, verification: next.verification,
  });
  assert.equal(committed.changed, true);

  // Recreate the exact durable state of a process death after final-generation install and before
  // active.json commit. This deterministic oracle does not depend on scheduler/permission races.
  await fs.writeFile(f.paths.active, activeBefore, { mode: 0o600 });
  const transaction = randomUUID();
  const token = randomUUID();
  await fs.writeFile(f.paths.transition, canonicalJson({
    version: 1,
    profile: PROFILE,
    transaction,
    incoming: `.incoming-${transaction}`,
    nextActive: committed.active,
    previousActive,
  }), { mode: 0o600 });
  await fs.writeFile(f.paths.lock, canonicalJson({ version: 1, profile: PROFILE, pid: 999_999, token }), { mode: 0o600 });

  await rejectsCode(
    loadManagedPolicyProfile({ storeRoot: f.storeRoot, profile: PROFILE }),
    'MANAGED_POLICY_LOCKED',
  );
  const inspection = await inspectManagedPolicyRecovery({
    storeRoot: f.storeRoot, profile: PROFILE,
  });
  assert.equal(inspection.recoveryRequired, true);
  assert.equal(inspection.lock.token, token);
  assert.equal(inspection.transition.nextActive.generation, committed.generation);

  await rejectsCode(
    recoverManagedPolicyActivation({
      storeRoot: f.storeRoot, profile: PROFILE, mode: 'complete', lockToken: randomUUID(),
    }),
    'MANAGED_POLICY_LOCK_OWNERSHIP',
  );

  const recovered = await recoverManagedPolicyActivation({
    storeRoot: f.storeRoot, profile: PROFILE, mode: 'complete', lockToken: token,
  });
  assert.equal(recovered.outcome, 'completed');
  assert.equal(recovered.generation, committed.generation);
  const loaded = await loadManagedPolicyProfile({ storeRoot: f.storeRoot, profile: PROFILE });
  assert.equal(loaded.policy.policies[0].policy.rules[0].id, 'recovered-generation');
  assert.equal(await fs.stat(f.paths.transition).then(() => true, () => false), false);
  assert.equal(await fs.stat(f.paths.lock).then(() => true, () => false), false);
});

test('administrator can quarantine the exact failed candidate and retain byte-identical last-good', async (t) => {
  const f = await fixture(t, 'quarantine-recovery');
  const first = await stagedGeneration(f.temporary, f.enrollment, {
    document: bundle('last-good'),
    versions: { root: 1, timestamp: 1, snapshot: 1, targets: 1 },
  });
  await activateStagedManagedPolicy({
    storeRoot: f.storeRoot, profile: PROFILE,
    stagedDirectory: first.staged, verification: first.verification,
  });
  const activeBefore = await fs.readFile(f.paths.active);
  const previousActive = JSON.parse(activeBefore);
  const next = await stagedGeneration(f.temporary, f.enrollment, {
    document: bundle('candidate'),
    versions: { root: 2, timestamp: 2, snapshot: 2, targets: 2 },
  });
  const committed = await activateStagedManagedPolicy({
    storeRoot: f.storeRoot, profile: PROFILE,
    stagedDirectory: next.staged, verification: next.verification,
  });
  await fs.writeFile(f.paths.active, activeBefore, { mode: 0o600 });
  const transaction = randomUUID();
  const token = randomUUID();
  await fs.writeFile(f.paths.transition, canonicalJson({
    version: 1, profile: PROFILE, transaction, incoming: `.incoming-${transaction}`,
    nextActive: committed.active, previousActive,
  }), { mode: 0o600 });
  await fs.writeFile(f.paths.lock, canonicalJson({ version: 1, profile: PROFILE, pid: 999_999, token }), { mode: 0o600 });

  const recovered = await recoverManagedPolicyActivation({
    storeRoot: f.storeRoot, profile: PROFILE, mode: 'quarantine', lockToken: token,
  });
  assert.equal(recovered.outcome, 'quarantined');
  assert.ok(recovered.quarantined.startsWith(f.paths.quarantine));
  assert.deepEqual(await fs.readFile(f.paths.active), activeBefore);
  assert.equal((await loadManagedPolicyProfile({ storeRoot: f.storeRoot, profile: PROFILE }))
    .policy.policies[0].policy.rules[0].id, 'last-good');
});

test('first-activation crash is recoverable without guessing a generation', async (t) => {
  const f = await fixture(t, 'first-activation-recovery');
  const staged = await stagedGeneration(f.temporary, f.enrollment, { document: bundle('first-recovered') });
  const committed = await activateStagedManagedPolicy({
    storeRoot: f.storeRoot, profile: PROFILE,
    stagedDirectory: staged.staged, verification: staged.verification,
  });
  await fs.unlink(f.paths.active);
  const transaction = randomUUID();
  const token = randomUUID();
  await fs.writeFile(f.paths.transition, canonicalJson({
    version: 1, profile: PROFILE, transaction, incoming: `.incoming-${transaction}`,
    nextActive: committed.active, previousActive: null,
  }), { mode: 0o600 });
  await fs.writeFile(f.paths.lock, canonicalJson({ version: 1, profile: PROFILE, pid: 999_999, token }), { mode: 0o600 });

  const inspection = await inspectManagedPolicyRecovery({
    storeRoot: f.storeRoot, profile: PROFILE,
  });
  assert.equal(inspection.active, null);
  assert.deepEqual(inspection.unselectedGenerations, [committed.generation]);
  await recoverManagedPolicyActivation({
    storeRoot: f.storeRoot, profile: PROFILE, mode: 'complete', lockToken: token,
  });
  assert.equal((await loadManagedPolicyProfile({ storeRoot: f.storeRoot, profile: PROFILE }))
    .policy.policies[0].policy.rules[0].id, 'first-recovered');
});

test('offline authority enforces authenticated expiry and future-verification clock bounds', async (t) => {
  const now = Date.now();
  const f = await fixture(t, 'freshness');
  const staged = await stagedGeneration(f.temporary, f.enrollment, {
    verifiedAt: new Date(now - 60_000).toISOString(),
    expires: {
      timestamp: new Date(now + 2_000).toISOString(),
      snapshot: new Date(now + 20_000).toISOString(),
      targets: new Date(now + 30_000).toISOString(),
    },
  });
  await activateStagedManagedPolicy({
    storeRoot: f.storeRoot, profile: PROFILE,
    stagedDirectory: staged.staged, verification: staged.verification,
  });
  const binding = await systemRepositoryIdentityBinding({
    storeRoot: f.storeRoot, profile: PROFILE, repositoryRoot: f.repositoryRoot,
  });
  const fresh = await resolveManagedPolicyAuthority({
    storeRoot: f.storeRoot, profile: PROFILE, repositoryBinding: binding,
    now, clockSkewToleranceMs: 0,
  });
  assert.equal(fresh.freshness.earliestRole, 'timestamp');
  await rejectsCode(
    resolveManagedPolicyAuthority({
      storeRoot: f.storeRoot, profile: PROFILE, repositoryBinding: binding,
      now: now + 2_000, clockSkewToleranceMs: 0,
    }),
    'MANAGED_POLICY_EXPIRED',
  );
  const explicitGrace = await resolveManagedPolicyAuthority({
    storeRoot: f.storeRoot, profile: PROFILE, repositoryBinding: binding,
    now: now + 2_000, expiryGraceMs: 1_000, clockSkewToleranceMs: 0,
  });
  assert.equal(explicitGrace.freshness.expiryGraceMs, 1_000);

  await clearSystemStore();
  const futureFixture = await fixture(t, 'future-verification');
  const futureStage = await stagedGeneration(futureFixture.temporary, futureFixture.enrollment, {
    verifiedAt: new Date(now + 60_000).toISOString(),
    expires: {
      timestamp: new Date(now + 120_000).toISOString(),
      snapshot: new Date(now + 180_000).toISOString(),
      targets: new Date(now + 240_000).toISOString(),
    },
  });
  await activateStagedManagedPolicy({
    storeRoot: futureFixture.storeRoot, profile: PROFILE,
    stagedDirectory: futureStage.staged, verification: futureStage.verification,
  });
  const futureBinding = await systemRepositoryIdentityBinding({
    storeRoot: futureFixture.storeRoot, profile: PROFILE,
    repositoryRoot: futureFixture.repositoryRoot,
  });
  await rejectsCode(
    resolveManagedPolicyAuthority({
      storeRoot: futureFixture.storeRoot, profile: PROFILE, repositoryBinding: futureBinding,
      now, clockSkewToleranceMs: 0,
    }),
    'MANAGED_POLICY_FUTURE_VERIFICATION',
  );
});

test('corrupt or missing active monotonic state hard-refuses instead of scanning generations', async (t) => {
  const f = await fixture(t, 'corrupt-active');
  const staged = await stagedGeneration(f.temporary, f.enrollment);
  await activateStagedManagedPolicy({
    storeRoot: f.storeRoot, profile: PROFILE,
    stagedDirectory: staged.staged, verification: staged.verification,
  });
  const activeBytes = await fs.readFile(f.paths.active);
  await fs.writeFile(f.paths.active, '{"version":1,');
  await rejectsCode(
    loadManagedPolicyProfile({ storeRoot: f.storeRoot, profile: PROFILE }),
    'MANAGED_POLICY_PARSE',
  );

  await fs.writeFile(f.paths.active, activeBytes, { mode: 0o600 });
  await fs.unlink(f.paths.active);
  await rejectsCode(
    loadManagedPolicyProfile({ storeRoot: f.storeRoot, profile: PROFILE }),
    'MANAGED_POLICY_STATE_MISSING',
  );
});

test('root, generation bytes, permissions, and profile symlinks are re-verified on every load', async (t) => {
  const f = await fixture(t, 'load-integrity');
  const staged = await stagedGeneration(f.temporary, f.enrollment);
  await activateStagedManagedPolicy({
    storeRoot: f.storeRoot, profile: PROFILE,
    stagedDirectory: staged.staged, verification: staged.verification,
  });

  await fs.chmod(f.paths.active, 0o666);
  await rejectsCode(
    loadManagedPolicyProfile({ storeRoot: f.storeRoot, profile: PROFILE }),
    'MANAGED_POLICY_PERMISSIONS',
  );
  await fs.chmod(f.paths.active, 0o600);

  const active = await loadManagedPolicyProfile({ storeRoot: f.storeRoot, profile: PROFILE });
  const policyPath = path.join(f.paths.generations, active.active.generation, 'policy.json');
  const originalPolicy = await fs.readFile(policyPath);
  await fs.chmod(policyPath, 0o600);
  await fs.appendFile(policyPath, '\n');
  await rejectsCode(
    loadManagedPolicyProfile({ storeRoot: f.storeRoot, profile: PROFILE }),
    'MANAGED_POLICY_CORRUPT',
  );
  await fs.writeFile(policyPath, originalPolicy);
  await fs.chmod(policyPath, 0o400);

  await fs.chmod(f.paths.bootstrapRoot, 0o600);
  await fs.writeFile(f.paths.bootstrapRoot, bootstrapRoot(2));
  await fs.chmod(f.paths.bootstrapRoot, 0o400);
  await rejectsCode(
    loadManagedPolicyProfile({ storeRoot: f.storeRoot, profile: PROFILE }),
    'MANAGED_POLICY_ROOT_MISMATCH',
  );

  const symlinkRoot = path.join(f.temporary, 'symlink-store');
  const profiles = path.join(symlinkRoot, 'profiles');
  const outside = path.join(f.temporary, 'outside-profile');
  await fs.mkdir(profiles, { recursive: true, mode: 0o700 });
  await fs.mkdir(outside, { mode: 0o700 });
  await fs.symlink(outside, path.join(profiles, 'linked'));
  await rejectsCode(
    loadManagedPolicyProfile({ storeRoot: symlinkRoot, profile: 'linked' }),
    'MANAGED_POLICY_SYMLINK',
  );
});
