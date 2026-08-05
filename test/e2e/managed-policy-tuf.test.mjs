// SPDX-License-Identifier: FSL-1.1-MIT
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { Metadata, MetaFile, TargetFile, Targets } from '@tufjs/models';
import { KeyPair } from '../../node_modules/@tufjs/repo-mock/dist/key.js';
import {
  createRootMeta,
  createSnapshotMeta,
  createTargetsMeta,
  createTimestampMeta,
} from '../../node_modules/@tufjs/repo-mock/dist/metadata.js';
import { Delegations } from '../../node_modules/@tufjs/models/dist/delegations.js';
import { DelegatedRole } from '../../node_modules/@tufjs/models/dist/role.js';

import { syncManagedPolicyFromTuf } from '../../src/team/managed-policy-tuf.mjs';
import {
  enrollManagedPolicyProfile,
  loadManagedPolicyProfile,
  managedPolicyProfilePaths,
} from '../../src/team/managed-policy-store.mjs';
import {
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
  'system managed-policy TUF suite passes under the real uid-0 and fixed-/etc contract',
);

const PROFILE = 'production';
const REPOSITORY = 'github-repository-id:123456';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const future = () => new Date(Date.now() + 86_400_000).toISOString();
const past = () => new Date(Date.now() - 86_400_000).toISOString();

const policy = (rule = 'central-rule') => canonicalJson({
  version: 1,
  profile: PROFILE,
  policies: [{
    id: 'baseline',
    policy: { version: 1, rules: [{ id: rule, type: 'no-unlanded', severity: 'error' }] },
  }],
  assignments: [{ repository: REPOSITORY, policies: ['baseline'] }],
});

function resign(metadata, key, { version, expires = future() } = {}) {
  if (version !== undefined) metadata.signed.version = version;
  metadata.signed.expires = expires;
  metadata.sign((bytes) => key.sign(bytes), false);
  return metadata;
}

function metaFile(metadata) {
  const bytes = Buffer.from(JSON.stringify(metadata.toJSON()));
  return new MetaFile({ version: metadata.signed.version, length: bytes.length, hashes: { sha256: sha256(bytes) } });
}

function repository(content, {
  key = new KeyPair(),
  versions = { root: 1, timestamp: 1, snapshot: 1, targets: 1 },
  expires = future(),
  delegated = false,
  declaredTargetLength = null,
} = {}) {
  const bytes = Buffer.from(content);
  const target = new TargetFile({
    path: 'policy.json',
    length: declaredTargetLength ?? bytes.length,
    hashes: { sha256: sha256(bytes) },
  });
  let targets;
  let delegatedTargets = null;
  if (delegated) {
    targets = createTargetsMeta([], key);
    targets.signed.delegations = new Delegations({
      keys: { [key.publicKey.keyID]: key.publicKey },
      roles: {
        policy: new DelegatedRole({
          name: 'policy', keyIDs: [key.publicKey.keyID], threshold: 1,
          terminating: true, paths: ['policy.json'],
        }),
      },
    });
    resign(targets, key, { version: versions.targets, expires });
    delegatedTargets = resign(
      new Metadata(new Targets({ version: versions.targets, expires, targets: { 'policy.json': target } })),
      key,
      { version: versions.targets, expires },
    );
  } else {
    targets = resign(createTargetsMeta([target], key), key, { version: versions.targets, expires });
  }
  const snapshot = createSnapshotMeta(targets, key);
  snapshot.signed.meta['targets.json'] = metaFile(targets);
  if (delegatedTargets) snapshot.signed.meta['policy.json'] = metaFile(delegatedTargets);
  resign(snapshot, key, { version: versions.snapshot, expires });
  const timestamp = createTimestampMeta(snapshot, key);
  timestamp.signed.snapshotMeta = metaFile(snapshot);
  resign(timestamp, key, { version: versions.timestamp, expires });
  const root = resign(createRootMeta(key), key, { version: versions.root, expires: future() });
  return { key, root, timestamp, snapshot, targets, delegatedTargets, targetBytes: bytes };
}

function metadataBytes(metadata) {
  return Buffer.from(JSON.stringify(metadata.toJSON()));
}

async function serveRepository(t, initial) {
  const state = {
    repo: initial,
    tamperMetadata: null,
    tamperTarget: null,
    partialPath: null,
    transient: new Map(),
    requests: [],
  };
  const server = http.createServer((request, response) => {
    const requestPath = new URL(request.url, 'http://local').pathname;
    state.requests.push(requestPath);
    let status = 200;
    let body;
    const transient = state.transient.get(requestPath) ?? 0;
    if (transient > 0) {
      state.transient.set(requestPath, transient - 1);
      status = 503;
      body = Buffer.from('temporary failure');
    } else if (/^\/metadata\/[1-9]\d*\.root\.json$/u.test(requestPath)) {
      const version = Number(path.basename(requestPath).split('.')[0]);
      const root = state.repo.rootRotations?.[version];
      status = root ? 200 : 404;
      body = root ? metadataBytes(root) : Buffer.alloc(0);
    } else if (requestPath === '/metadata/timestamp.json') body = metadataBytes(state.repo.timestamp);
    else if (requestPath === '/metadata/snapshot.json') body = metadataBytes(state.repo.snapshot);
    else if (requestPath === '/metadata/targets.json') body = metadataBytes(state.repo.targets);
    else if (requestPath === '/metadata/policy.json' && state.repo.delegatedTargets) {
      body = metadataBytes(state.repo.delegatedTargets);
    } else if (requestPath === '/targets/policy.json') body = state.repo.targetBytes;
    else {
      status = 404;
      body = Buffer.alloc(0);
    }
    if (state.tamperMetadata === requestPath && body.length) {
      body = Buffer.from(body);
      body[Math.floor(body.length / 2)] ^= 1;
    }
    if (state.tamperTarget === requestPath) body = Buffer.from('tampered target');
    response.statusCode = status;
    if (state.partialPath === requestPath && body.length > 1) {
      response.setHeader('content-length', String(body.length));
      response.write(body.subarray(0, Math.floor(body.length / 2)));
      response.socket.destroy();
      return;
    }
    response.setHeader('content-length', String(body.length));
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return {
    state,
    metadataBaseUrl: `http://127.0.0.1:${address.port}/metadata/`,
    targetBaseUrl: `http://127.0.0.1:${address.port}/targets/`,
  };
}

async function makeFixture(t, label, repo) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), `holt-tuf-${label}-`));
  const storeRoot = '/etc/holt/managed-policy';
  const paths = managedPolicyProfilePaths(storeRoot, PROFILE);
  t.after(async () => {
    const makeWritable = async (entry) => {
      const stat = await fs.lstat(entry).catch(() => null);
      if (!stat || stat.isSymbolicLink()) return;
      if (stat.isDirectory()) {
        await fs.chmod(entry, 0o700);
        for (const name of await fs.readdir(entry)) await makeWritable(path.join(entry, name));
      } else await fs.chmod(entry, 0o600);
    };
    await makeWritable(storeRoot);
    await fs.rm(storeRoot, { recursive: true, force: true });
    await makeWritable(temporary);
    await fs.rm(temporary, { recursive: true, force: true });
  });
  await enrollManagedPolicyProfile({
    storeRoot,
    profile: PROFILE,
    authority: 'system',
    bootstrapRoot: metadataBytes(repo.root),
    repositoryBindings: [{ root: temporary, identity: REPOSITORY }],
  });
  return { temporary, storeRoot, paths };
}

async function sync(fixture, remote, options = {}) {
  return syncManagedPolicyFromTuf({
    storeRoot: fixture.storeRoot,
    profile: PROFILE,
    metadataBaseUrl: remote.metadataBaseUrl,
    targetBaseUrl: remote.targetBaseUrl,
    timeoutMs: 2_000,
    retries: 0,
    ...options,
  });
}

async function assertNoStaging(fixture) {
  assert.deepEqual((await fs.readdir(fixture.storeRoot)).filter((name) => name.startsWith('.tuf-')), []);
}

test('real Updater verifies and activates policy with a root-bound sorted receipt, then offline authority load performs zero fetches', async (t) => {
  const repo = repository(policy());
  const f = await makeFixture(t, 'happy', repo);
  const remote = await serveRepository(t, repo);
  const result = await sync(f, remote);
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.authentication, 'tuf-js/6.0.0');
  assert.deepEqual(result.verifier, { implementation: 'tuf-js', version: '6.0.0', authorizingRole: 'targets' });
  assert.equal(result.verification.rootSha256, sha256(metadataBytes(repo.root)));
  assert.deepEqual(result.verification.metadata.map((entry) => entry.path),
    [...result.verification.metadata.map((entry) => entry.path)].sort());
  assert.deepEqual(result.verification.versions, { root: 1, timestamp: 1, snapshot: 1, targets: 1 });
  assert.ok(Date.parse(result.verification.expires.timestamp) > Date.parse(result.verification.verifiedAt));
  await assertNoStaging(f);

  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = () => { fetches++; throw new Error('offline path attempted network'); };
  try {
    const loaded = await loadManagedPolicyProfile({ storeRoot: f.storeRoot, profile: PROFILE });
    assert.equal(loaded.policy.profile, PROFILE);
    const binding = await systemRepositoryIdentityBinding({
      storeRoot: f.storeRoot, profile: PROFILE, repositoryRoot: f.temporary,
    });
    const authority = await resolveManagedPolicyAuthority({
      storeRoot: f.storeRoot, profile: PROFILE, repositoryBinding: binding,
    });
    assert.equal(authority.claimed, true);
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('delegated policy is verified by the real Updater and receipt binds the authorizing role', async (t) => {
  const repo = repository(policy('delegated-rule'), { delegated: true, versions: { root: 1, timestamp: 4, snapshot: 3, targets: 2 } });
  const f = await makeFixture(t, 'delegated', repo);
  const remote = await serveRepository(t, repo);
  const result = await sync(f, remote);
  assert.equal(result.ok, true);
  assert.equal(result.verification.versions.targets, 2);
  assert.ok(result.verification.metadata.some((entry) => entry.path === 'policy.json'));
  assert.ok(remote.state.requests.includes('/metadata/policy.json'));
  await assertNoStaging(f);
});

test('root rotation is verified by old and new keys while receipt remains bound to enrolled root', async (t) => {
  const enrolled = repository(policy('root-one'));
  const nextKey = new KeyPair();
  const remoteRepo = repository(policy('root-two'), {
    key: nextKey, versions: { root: 2, timestamp: 2, snapshot: 2, targets: 2 },
  });
  const rotatedRoot = createRootMeta(nextKey);
  resign(rotatedRoot, nextKey, { version: 2, expires: future() });
  rotatedRoot.sign((bytes) => enrolled.key.sign(bytes), true);
  remoteRepo.rootRotations = { 2: rotatedRoot };
  const f = await makeFixture(t, 'root-rotation', enrolled);
  const remote = await serveRepository(t, remoteRepo);
  const result = await sync(f, remote);
  assert.equal(result.verification.versions.root, 2);
  assert.equal(result.verification.rootSha256, sha256(metadataBytes(enrolled.root)));
  assert.ok(remote.state.requests.includes('/metadata/2.root.json'));
  await assertNoStaging(f);
});

test('bounded retry handles one transient metadata failure without broadening URL scope', async (t) => {
  const repo = repository(policy('retry'));
  const f = await makeFixture(t, 'retry', repo);
  const remote = await serveRepository(t, repo);
  remote.state.transient.set('/metadata/timestamp.json', 1);
  const result = await sync(f, remote, { retries: 1 });
  assert.equal(result.ok, true);
  assert.equal(remote.state.requests.filter((item) => item === '/metadata/timestamp.json').length, 2);
  await assert.rejects(
    syncManagedPolicyFromTuf({
      storeRoot: f.storeRoot,
      profile: PROFILE,
      metadataBaseUrl: `${remote.metadataBaseUrl}?redirect=elsewhere`,
      targetBaseUrl: remote.targetBaseUrl,
    }),
    (error) => error?.code === 'MANAGED_POLICY_TUF_URL',
  );
  await assertNoStaging(f);
});

for (const attack of ['metadata', 'target']) {
  test(`tampered ${attack} retains exact last-good generation and cleans verifier staging`, async (t) => {
    const repo = repository(policy());
    const f = await makeFixture(t, `tampered-${attack}`, repo);
    const remote = await serveRepository(t, repo);
    await sync(f, remote);
    const active = await fs.readFile(f.paths.active);
    remote.state[attack === 'metadata' ? 'tamperMetadata' : 'tamperTarget'] =
      attack === 'metadata' ? '/metadata/timestamp.json' : '/targets/policy.json';
    await assert.rejects(sync(f, remote), (error) => error?.code === 'MANAGED_POLICY_TUF_VERIFICATION');
    assert.deepEqual(await fs.readFile(f.paths.active), active);
    await assertNoStaging(f);
  });
}

test('expired signed metadata and invalid signed policy schema both fail closed', async (t) => {
  const baseline = repository(policy('last-good'));
  const f = await makeFixture(t, 'expiry-schema', baseline);
  const remote = await serveRepository(t, baseline);
  await sync(f, remote);
  const active = await fs.readFile(f.paths.active);

  remote.state.repo = repository(policy('expired'), {
    key: baseline.key, versions: { root: 1, timestamp: 2, snapshot: 2, targets: 2 }, expires: past(),
  });
  await assert.rejects(sync(f, remote), (error) => error?.code === 'MANAGED_POLICY_TUF_VERIFICATION');
  assert.deepEqual(await fs.readFile(f.paths.active), active);
  await assertNoStaging(f);

  remote.state.repo = repository(canonicalJson({ version: 1, profile: PROFILE }), {
    key: baseline.key, versions: { root: 1, timestamp: 2, snapshot: 2, targets: 2 },
  });
  await assert.rejects(sync(f, remote), (error) => error?.code === 'MANAGED_POLICY_SCHEMA');
  assert.deepEqual(await fs.readFile(f.paths.active), active);
  await assertNoStaging(f);
});

test('signed oversized target length refuses before any target request', async (t) => {
  const repo = repository(policy(), { declaredTargetLength: 1024 * 1024 + 1 });
  const f = await makeFixture(t, 'oversized', repo);
  const remote = await serveRepository(t, repo);
  await assert.rejects(sync(f, remote), (error) => error?.code === 'MANAGED_POLICY_LIMIT');
  assert.equal(remote.state.requests.includes('/targets/policy.json'), false);
  await assertNoStaging(f);
});

test('partial network response leaves last-good pointer byte-identical and cleans staging', async (t) => {
  const first = repository(policy('last-good'));
  const f = await makeFixture(t, 'partial', first);
  const remote = await serveRepository(t, first);
  await sync(f, remote);
  const before = await fs.readFile(f.paths.active);
  remote.state.repo = repository(policy('candidate'), {
    key: first.key, versions: { root: 1, timestamp: 2, snapshot: 2, targets: 2 },
  });
  remote.state.partialPath = '/metadata/snapshot.json';
  await assert.rejects(sync(f, remote), (error) => error?.code === 'MANAGED_POLICY_TUF_VERIFICATION');
  assert.deepEqual(await fs.readFile(f.paths.active), before);
  await assertNoStaging(f);
});

test('rollback and equal-version changed bytes retain exact last-good state', async (t) => {
  const first = repository(policy('version-two'), {
    versions: { root: 1, timestamp: 2, snapshot: 2, targets: 2 },
  });
  const f = await makeFixture(t, 'rollback', first);
  const remote = await serveRepository(t, first);
  await sync(f, remote);
  const active = await fs.readFile(f.paths.active);

  remote.state.repo = repository(policy('rollback'), {
    key: first.key, versions: { root: 1, timestamp: 1, snapshot: 1, targets: 1 },
  });
  await assert.rejects(sync(f, remote), (error) => error?.code === 'MANAGED_POLICY_TUF_VERIFICATION');
  assert.deepEqual(await fs.readFile(f.paths.active), active);

  remote.state.repo = repository(policy('equivocation'), {
    key: first.key, versions: { root: 1, timestamp: 2, snapshot: 2, targets: 2 },
  });
  await assert.rejects(sync(f, remote), (error) => error?.code === 'MANAGED_POLICY_TUF_VERIFICATION');
  assert.deepEqual(await fs.readFile(f.paths.active), active);
  await assertNoStaging(f);
});

test('no-op refresh cleans staging and does not install another generation', async (t) => {
  const repo = repository(policy());
  const f = await makeFixture(t, 'noop', repo);
  const remote = await serveRepository(t, repo);
  const first = await sync(f, remote);
  const second = await sync(f, remote);
  assert.equal(second.changed, false);
  assert.equal(second.generation, first.generation);
  assert.equal(second.installed, false);
  assert.equal((await fs.readdir(f.paths.generations)).length, 1);
  await assertNoStaging(f);
});

test('hardlinked enrolled root refuses before network', async (t) => {
  const repo = repository(policy());
  const f = await makeFixture(t, 'hardlink', repo);
  const remote = await serveRepository(t, repo);
  const copy = path.join(f.storeRoot, 'root-copy.json');
  await fs.link(f.paths.bootstrapRoot, copy);
  await assert.rejects(sync(f, remote), (error) => error?.code === 'MANAGED_POLICY_HARDLINK');
  assert.deepEqual(remote.state.requests, []);
  await assertNoStaging(f);
});

test('symlinked enrolled root refuses before network', async (t) => {
  const repo = repository(policy());
  const f = await makeFixture(t, 'symlink', repo);
  const remote = await serveRepository(t, repo);
  const copy = path.join(f.temporary, 'root-copy.json');
  await fs.copyFile(f.paths.bootstrapRoot, copy);
  await fs.unlink(f.paths.bootstrapRoot);
  await fs.symlink(copy, f.paths.bootstrapRoot);
  await assert.rejects(sync(f, remote), (error) => error?.code === 'MANAGED_POLICY_SYMLINK');
  assert.deepEqual(remote.state.requests, []);
  await assertNoStaging(f);
});
