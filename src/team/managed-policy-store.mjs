// SPDX-License-Identifier: LicenseRef-holt-Commercial
// Commercial license — see src/team/LICENSE. NOT covered by the repository FSL-1.1-MIT grant.
/**
 * Crash-safe, filesystem-only storage for customer-controlled managed policy.
 *
 * SECURITY BOUNDARY: activateStagedManagedPolicy() does not verify TUF signatures. It consumes a
 * staging directory and receipt produced by a trusted verifier, then independently binds every
 * receipt hash and length to the bytes it is about to activate. No caller should expose this API
 * as "verified" until the separate TUF adapter exists and supplies that receipt.
 */

import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { relativeWithinAsync, samePathAsync, underOrEqualAsync } from '../paths.mjs';
import {
  MANAGED_POLICY_VERSION,
  MAX_BOOTSTRAP_ROOT_BYTES,
  MAX_MANAGED_POLICY_BYTES,
  MAX_METADATA_FILE_BYTES,
  MAX_METADATA_FILES,
  MAX_METADATA_TOTAL_BYTES,
  assertMetadataPath,
  assertProfileName,
  canonicalJson,
  managedPolicyRefuse,
  parseActivationReceipt,
  parseActivePointer,
  parseManagedTransition,
  parseManagedPolicy,
  parseManagedTrust,
  parseStrictJson,
  parseStrictTufRoot,
  validateManagedTrustObject,
  validateStagedVerificationObject,
} from './managed-policy-schema.mjs';

const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const READ_FLAGS = fsConstants.O_RDONLY | NOFOLLOW;
const WRITE_NEW_FLAGS = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW;
const POSIX_PERMISSION_CHECKS = process.platform !== 'win32';
const SYSTEM_MANAGED_POLICY_STORE_ROOT = path.resolve('/etc/holt/managed-policy');

// System policy is an integrity authority, not a confidentiality store. Its authenticated bytes
// must be readable by an unprivileged CI service account while remaining writable only by root.
// User-authority stores keep their original owner-private modes.
const managedDirectoryMode = (authority) => authority === 'system' ? 0o755 : 0o700;
const managedReadOnlyDirectoryMode = (authority) => authority === 'system' ? 0o555 : 0o500;
const managedReadOnlyFileMode = (authority) => authority === 'system' ? 0o444 : 0o400;
const managedPointerFileMode = (authority) => authority === 'system' ? 0o644 : 0o600;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const lexicalCompare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const sameEntryIdentity = (left, right) => left && right
  && String(left.dev) === String(right.dev)
  && String(left.ino) === String(right.ino);

function assertStoreRoot(storeRoot) {
  if (typeof storeRoot !== 'string' || !storeRoot || storeRoot.includes('\0')) {
    managedPolicyRefuse('MANAGED_POLICY_PATH', 'managed-policy store root must be a non-empty filesystem path');
  }
  return path.resolve(storeRoot);
}

export function managedPolicyProfilePaths(storeRoot, profile) {
  const root = assertStoreRoot(storeRoot);
  assertProfileName(profile);
  const profiles = path.join(root, 'profiles');
  const profileRoot = path.join(profiles, profile);
  return {
    root,
    profiles,
    profile: profileRoot,
    trust: path.join(profileRoot, 'trust.json'),
    bootstrap: path.join(profileRoot, 'bootstrap'),
    bootstrapRoot: path.join(profileRoot, 'bootstrap', 'root.json'),
    generations: path.join(profileRoot, 'generations'),
    active: path.join(profileRoot, 'active.json'),
    status: path.join(profileRoot, 'status.json'),
    lock: path.join(profileRoot, 'lock'),
    transition: path.join(profileRoot, 'transition.json'),
    quarantine: path.join(profileRoot, 'quarantine'),
  };
}

function permissionBits(stat) {
  return typeof stat.mode === 'bigint' ? Number(stat.mode & 0o777n) : (stat.mode & 0o777);
}

function assertNotGroupOrWorldWritable(stat, label) {
  if (POSIX_PERMISSION_CHECKS && (permissionBits(stat) & 0o022) !== 0) {
    managedPolicyRefuse(
      'MANAGED_POLICY_PERMISSIONS',
      `${label} is group/world writable (mode ${permissionBits(stat).toString(8).padStart(3, '0')})`,
    );
  }
}

function assertExpectedOwner(stat, label, expectedUid) {
  if (expectedUid !== null && POSIX_PERMISSION_CHECKS && stat.uid !== expectedUid) {
    managedPolicyRefuse(
      'MANAGED_POLICY_OWNER',
      `${label} is owned by uid ${stat.uid}, expected authoritative uid ${expectedUid}`,
    );
  }
}

async function systemOwnerUid(authority, storeRoot) {
  if (authority !== 'system') return null;
  if (process.platform === 'win32') {
    managedPolicyRefuse(
      'MANAGED_POLICY_AUTHORITY_UNSUPPORTED',
      'system-authoritative managed policy on Windows requires an ACL verifier that this filesystem core does not yet ship',
    );
  }
  if (!(await samePathAsync(storeRoot, SYSTEM_MANAGED_POLICY_STORE_ROOT))) {
    managedPolicyRefuse(
      'MANAGED_POLICY_SYSTEM_STORE',
      `production system authority is anchored to ${SYSTEM_MANAGED_POLICY_STORE_ROOT}`,
    );
  }
  return 0;
}

async function secureDirectory(directory, label, expectedUid = /** @type {number|null} */ (null)) {
  let stat;
  try { stat = await fs.lstat(directory); } catch (error) {
    if (error?.code === 'ENOENT') managedPolicyRefuse('MANAGED_POLICY_STATE_MISSING', `${label} is missing`);
    throw error;
  }
  if (stat.isSymbolicLink()) managedPolicyRefuse('MANAGED_POLICY_SYMLINK', `${label} must not be a symlink`);
  if (!stat.isDirectory()) managedPolicyRefuse('MANAGED_POLICY_LAYOUT', `${label} must be a directory`);
  assertNotGroupOrWorldWritable(stat, label);
  assertExpectedOwner(stat, label, expectedUid);
  return stat;
}

async function readRegularFile(file, label, maxBytes, expectedUid = /** @type {number|null} */ (null)) {
  let handle;
  try {
    handle = await fs.open(file, READ_FLAGS);
  } catch (error) {
    if (error?.code === 'ELOOP') managedPolicyRefuse('MANAGED_POLICY_SYMLINK', `${label} must not be a symlink`);
    if (error?.code === 'ENOENT') managedPolicyRefuse('MANAGED_POLICY_STATE_MISSING', `${label} is missing`);
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) managedPolicyRefuse('MANAGED_POLICY_LAYOUT', `${label} must be a regular file`);
    if (before.nlink !== 1n) {
      managedPolicyRefuse('MANAGED_POLICY_HARDLINK', `${label} has ${before.nlink} hard links; managed-policy files must have exactly one name`);
    }
    assertNotGroupOrWorldWritable(before, label);
    assertExpectedOwner(before, label, expectedUid === null ? null : BigInt(expectedUid));
    if (before.size > BigInt(maxBytes)) {
      managedPolicyRefuse('MANAGED_POLICY_LIMIT', `${label} exceeds the ${maxBytes}-byte limit`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || BigInt(bytes.length) !== after.size) {
      managedPolicyRefuse('MANAGED_POLICY_RACE', `${label} changed while it was being read`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function fsyncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, READ_FLAGS);
    await handle.sync();
  } catch (error) {
    // Windows does not expose directory fsync. Never suppress a durability failure on platforms
    // where it is supported.
    if (!(process.platform === 'win32' && ['EISDIR', 'EINVAL', 'EPERM', 'EACCES'].includes(error?.code))) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeNewFile(file, bytes, mode = 0o600) {
  let handle;
  try {
    handle = await fs.open(file, WRITE_NEW_FLAGS, mode);
    await handle.writeFile(bytes);
    // Creation modes are filtered through the caller's umask. Re-apply the requested restrictive
    // mode so a hardened 0077 administrator umask cannot accidentally make system policy unreadable
    // to the unprivileged CI account it is meant to govern.
    if (POSIX_PERMISSION_CHECKS) await handle.chmod(mode);
    await handle.sync();
  } catch (error) {
    if (error?.code === 'ELOOP') managedPolicyRefuse('MANAGED_POLICY_SYMLINK', `${file} must not be a symlink`);
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function atomicWrite(file, bytes, mode = 0o600) {
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    await writeNewFile(temporary, bytes, mode);
    await fs.rename(temporary, file);
    await fsyncDirectory(directory);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

async function ensureStoreDirectories(paths, authority) {
  const mode = managedDirectoryMode(authority);
  await fs.mkdir(paths.root, { recursive: true, mode });
  await secureDirectory(paths.root, 'managed-policy store root', authority === 'system' ? 0 : null);
  if (authority === 'system' && POSIX_PERMISSION_CHECKS) await fs.chmod(paths.root, mode);
  await fs.mkdir(paths.profiles, { mode }).catch((error) => {
    if (error?.code !== 'EEXIST') throw error;
  });
  await secureDirectory(paths.profiles, 'managed-policy profiles directory', authority === 'system' ? 0 : null);
  if (authority === 'system' && POSIX_PERMISSION_CHECKS) await fs.chmod(paths.profiles, mode);
}

function validateBootstrapRoot(root, label) {
  if (!root || typeof root !== 'object' || Array.isArray(root)
    || !root.signed || typeof root.signed !== 'object' || Array.isArray(root.signed)
    || root.signed._type !== 'root' || !Number.isSafeInteger(root.signed.version) || root.signed.version < 1
    || !Array.isArray(root.signatures)) {
    managedPolicyRefuse(
      'MANAGED_POLICY_ROOT',
      `${label} must be a strict TUF root envelope with signed._type='root', a positive signed.version, and signatures[]`,
    );
  }
  return root;
}

/**
 * Explicit enrollment creates the out-of-repository trust root. Production `system` authority is
 * accepted only at the fixed root-owned store; tests require a module-issued opaque capability.
 */
export async function enrollManagedPolicyProfile({
  storeRoot,
  profile,
  authority,
  bootstrapRoot,
  repositoryBindings = [],
}) {
  const paths = managedPolicyProfilePaths(storeRoot, profile);
  if (authority !== 'system' && authority !== 'user') {
    managedPolicyRefuse('MANAGED_POLICY_AUTHORITY', "enrollment authority must be 'system' or 'user'");
  }
  const ownerUid = await systemOwnerUid(authority, paths.root);
  if (ownerUid !== null && typeof process.getuid === 'function' && process.getuid() !== ownerUid) {
    managedPolicyRefuse(
      'MANAGED_POLICY_OWNER',
      `system enrollment must run as authoritative uid ${ownerUid}; current uid is ${process.getuid()}`,
    );
  }
  if (!(typeof bootstrapRoot === 'string' || Buffer.isBuffer(bootstrapRoot))) {
    managedPolicyRefuse('MANAGED_POLICY_ROOT', 'bootstrapRoot must be the exact JSON bytes approved by the administrator');
  }
  const rootBytes = Buffer.isBuffer(bootstrapRoot) ? Buffer.from(bootstrapRoot) : Buffer.from(bootstrapRoot, 'utf8');
  validateBootstrapRoot(
    parseStrictTufRoot(rootBytes, 'bootstrap/root.json', { maxBytes: MAX_BOOTSTRAP_ROOT_BYTES }),
    'bootstrap/root.json',
  );
  if (!Array.isArray(repositoryBindings)) {
    managedPolicyRefuse('MANAGED_POLICY_SCHEMA', 'repositoryBindings must be an array');
  }
  const boundRepositories = [];
  for (let i = 0; i < repositoryBindings.length; i++) {
    const binding = repositoryBindings[i];
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)
      || Object.keys(binding).some((key) => key !== 'root' && key !== 'identity')) {
      managedPolicyRefuse('MANAGED_POLICY_SCHEMA', `repositoryBindings[${i}] needs only root and identity`);
    }
    if (typeof binding.root !== 'string' || !path.isAbsolute(binding.root)) {
      managedPolicyRefuse('MANAGED_POLICY_PATH', `repositoryBindings[${i}].root must be an absolute path`);
    }
    const stat = await fs.lstat(binding.root, { bigint: true }).catch(() => null);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
      managedPolicyRefuse('MANAGED_POLICY_PATH', `repositoryBindings[${i}].root must be an existing non-symlink directory`);
    }
    boundRepositories.push({
      root: await fs.realpath(binding.root),
      identity: binding.identity,
      device: String(stat.dev),
      inode: String(stat.ino),
    });
  }
  const trust = validateManagedTrustObject({
    version: MANAGED_POLICY_VERSION,
    profile,
    authority,
    rootSha256: sha256(rootBytes),
    repositoryBindings: boundRepositories,
  }, 'trust.json');

  await ensureStoreDirectories(paths, authority);
  if (ownerUid !== null) {
    await secureDirectory(paths.root, 'managed-policy store root', ownerUid);
    await secureDirectory(paths.profiles, 'managed-policy profiles directory', ownerUid);
  }
  const temporary = path.join(paths.profiles, `.${profile}.enroll-${randomUUID()}`);
  try {
    const directoryMode = managedDirectoryMode(authority);
    const readOnlyFileMode = managedReadOnlyFileMode(authority);
    await fs.mkdir(temporary, { mode: directoryMode });
    const bootstrap = path.join(temporary, 'bootstrap');
    const generations = path.join(temporary, 'generations');
    const quarantine = path.join(temporary, 'quarantine');
    await fs.mkdir(bootstrap, { mode: directoryMode });
    await fs.mkdir(generations, { mode: directoryMode });
    await fs.mkdir(quarantine, { mode: directoryMode });
    if (authority === 'system' && POSIX_PERMISSION_CHECKS) {
      await Promise.all([temporary, bootstrap, generations, quarantine]
        .map((directory) => fs.chmod(directory, directoryMode)));
    }
    await writeNewFile(path.join(bootstrap, 'root.json'), rootBytes, readOnlyFileMode);
    await writeNewFile(path.join(temporary, 'trust.json'), Buffer.from(canonicalJson(trust)), readOnlyFileMode);
    await fsyncDirectory(bootstrap);
    await fsyncDirectory(generations);
    await fsyncDirectory(quarantine);
    await fsyncDirectory(temporary);
    await fs.rename(temporary, paths.profile);
    await fsyncDirectory(paths.profiles);
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
    if (['EEXIST', 'ENOTEMPTY'].includes(error?.code)) {
      managedPolicyRefuse('MANAGED_POLICY_EXISTS', `managed-policy profile '${profile}' is already enrolled`);
    }
    throw error;
  }
  return { profile, authority, rootSha256: trust.rootSha256, path: paths.profile };
}

async function readTrust(paths, profile) {
  await secureDirectory(paths.root, 'managed-policy store root');
  await secureDirectory(paths.profiles, 'managed-policy profiles directory');
  await secureDirectory(paths.profile, `managed-policy profile '${profile}'`);
  await secureDirectory(paths.bootstrap, `managed-policy profile '${profile}' bootstrap directory`);
  await secureDirectory(paths.generations, `managed-policy profile '${profile}' generations directory`);
  await secureDirectory(paths.quarantine, `managed-policy profile '${profile}' quarantine directory`);

  const [trustBytes, rootBytes] = await Promise.all([
    readRegularFile(paths.trust, `${profile}/trust.json`, 16 * 1024),
    readRegularFile(paths.bootstrapRoot, `${profile}/bootstrap/root.json`, MAX_BOOTSTRAP_ROOT_BYTES),
  ]);
  const trust = parseManagedTrust(trustBytes, `${profile}/trust.json`);
  if (trust.profile !== profile) {
    managedPolicyRefuse('MANAGED_POLICY_PROFILE', `trust.json names profile '${trust.profile}', expected '${profile}'`);
  }
  const ownerUid = await systemOwnerUid(trust.authority, paths.root);
  if (ownerUid !== null) {
    await Promise.all([
      secureDirectory(paths.root, 'managed-policy store root', ownerUid),
      secureDirectory(paths.profiles, 'managed-policy profiles directory', ownerUid),
      secureDirectory(paths.profile, `managed-policy profile '${profile}'`, ownerUid),
      secureDirectory(paths.bootstrap, `managed-policy profile '${profile}' bootstrap directory`, ownerUid),
      secureDirectory(paths.generations, `managed-policy profile '${profile}' generations directory`, ownerUid),
      secureDirectory(paths.quarantine, `managed-policy profile '${profile}' quarantine directory`, ownerUid),
      readRegularFile(paths.trust, `${profile}/trust.json`, 16 * 1024, ownerUid),
      readRegularFile(paths.bootstrapRoot, `${profile}/bootstrap/root.json`, MAX_BOOTSTRAP_ROOT_BYTES, ownerUid),
    ]);
  }
  validateBootstrapRoot(
    parseStrictTufRoot(rootBytes, `${profile}/bootstrap/root.json`, { maxBytes: MAX_BOOTSTRAP_ROOT_BYTES }),
    `${profile}/bootstrap/root.json`,
  );
  const actualRootSha256 = sha256(rootBytes);
  if (actualRootSha256 !== trust.rootSha256) {
    managedPolicyRefuse(
      'MANAGED_POLICY_ROOT_MISMATCH',
      `bootstrap root fingerprint ${actualRootSha256} does not match enrolled fingerprint ${trust.rootSha256}`,
    );
  }
  return { trust, rootBytes, ownerUid };
}

async function inspectMetadataTree(metadataRoot, label, expectedUid = /** @type {number|null} */ (null)) {
  await secureDirectory(metadataRoot, label, expectedUid);
  const manifest = [];
  let totalBytes = 0;

  const walk = async (directory, prefix, depth) => {
    if (depth > 8) managedPolicyRefuse('MANAGED_POLICY_LIMIT', `${label} exceeds the metadata depth limit`);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => lexicalCompare(a.name, b.name));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      assertMetadataPath(relative, `${label} entry`);
      const absolute = path.join(directory, entry.name);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) managedPolicyRefuse('MANAGED_POLICY_SYMLINK', `${label}/${relative} must not be a symlink`);
      if (stat.isDirectory()) {
        assertNotGroupOrWorldWritable(stat, `${label}/${relative}`);
        assertExpectedOwner(stat, `${label}/${relative}`, expectedUid);
        await walk(absolute, relative, depth + 1);
        continue;
      }
      if (!stat.isFile()) managedPolicyRefuse('MANAGED_POLICY_LAYOUT', `${label}/${relative} must be a regular file`);
      const bytes = await readRegularFile(absolute, `${label}/${relative}`, MAX_METADATA_FILE_BYTES, expectedUid);
      totalBytes += bytes.length;
      if (totalBytes > MAX_METADATA_TOTAL_BYTES) {
        managedPolicyRefuse('MANAGED_POLICY_LIMIT', `${label} exceeds the metadata byte limit`);
      }
      manifest.push({ path: relative, sha256: sha256(bytes), length: bytes.length });
      if (manifest.length > MAX_METADATA_FILES) {
        managedPolicyRefuse('MANAGED_POLICY_LIMIT', `${label} exceeds the metadata file-count limit`);
      }
    }
  };
  await walk(metadataRoot, '', 0);
  if (!manifest.length) managedPolicyRefuse('MANAGED_POLICY_LAYOUT', `${label} must not be empty`);
  manifest.sort((a, b) => lexicalCompare(a.path, b.path));
  return { manifest, treeSha256: sha256(Buffer.from(canonicalJson(manifest))), totalBytes };
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function manifestSubset(metadata, predicate) {
  return metadata.filter((entry) => predicate(path.posix.basename(entry.path), entry.path));
}

function assertMonotonic(previous, next) {
  for (const key of ['root', 'timestamp', 'snapshot', 'targets']) {
    if (next.versions[key] < previous.versions[key]) {
      managedPolicyRefuse(
        'MANAGED_POLICY_ROLLBACK',
        `refusing ${key} metadata rollback from version ${previous.versions[key]} to ${next.versions[key]}`,
      );
    }
  }
  if (Date.parse(next.verifiedAt) < Date.parse(previous.verifiedAt)) {
    managedPolicyRefuse(
      'MANAGED_POLICY_ROLLBACK',
      `refusing verification-time rollback from ${previous.verifiedAt} to ${next.verifiedAt}`,
    );
  }
  if (next.versions.targets === previous.versions.targets
    && next.targetSha256 !== previous.targetSha256) {
    managedPolicyRefuse('MANAGED_POLICY_EQUIVOCATION', 'policy target changed without a targets metadata version increase');
  }
  if (next.versions.targets > previous.versions.targets
    && next.versions.snapshot === previous.versions.snapshot) {
    managedPolicyRefuse('MANAGED_POLICY_EQUIVOCATION', 'targets version increased without a snapshot version increase');
  }
  if (next.versions.snapshot > previous.versions.snapshot
    && next.versions.timestamp === previous.versions.timestamp) {
    managedPolicyRefuse('MANAGED_POLICY_EQUIVOCATION', 'snapshot version increased without a timestamp version increase');
  }

  /** @type {Array<[string, (base: string, relative: string) => boolean]>} */
  const roleChecks = [
    ['root', (base) => base === 'root.json' || /^\d+\.root\.json$/u.test(base)],
    ['timestamp', (base) => base === 'timestamp.json'],
    // A stable snapshot version binds targets plus delegated metadata. Root and timestamp may
    // legitimately refresh independently, so they are excluded from this comparison.
    ['snapshot', (base) => base !== 'root.json' && !/^\d+\.root\.json$/u.test(base) && base !== 'timestamp.json'],
    ['targets', (base) => base === 'targets.json'],
  ];
  for (const [role, predicate] of roleChecks) {
    if (next.versions[role] === previous.versions[role]
      && !sameJson(manifestSubset(previous.metadata, predicate), manifestSubset(next.metadata, predicate))) {
      managedPolicyRefuse('MANAGED_POLICY_EQUIVOCATION', `${role} metadata bytes changed without a version increase`);
    }
  }
}

function sameAuthenticatedGeneration(left, right) {
  const { generation: leftGeneration, verifiedAt: leftVerifiedAt, ...leftContent } = left;
  const { generation: rightGeneration, verifiedAt: rightVerifiedAt, ...rightContent } = right;
  void leftGeneration;
  void leftVerifiedAt;
  void rightGeneration;
  void rightVerifiedAt;
  return sameJson(leftContent, rightContent);
}

async function generationEntries(generationRoot, label, expectedUid = /** @type {number|null} */ (null)) {
  await secureDirectory(generationRoot, label, expectedUid);
  const entries = (await fs.readdir(generationRoot)).sort();
  const expected = ['activation.json', 'metadata', 'policy.json'];
  if (!sameJson(entries, expected)) {
    managedPolicyRefuse(
      'MANAGED_POLICY_LAYOUT',
      `${label} must contain exactly ${expected.join(', ')} (found: ${entries.join(', ') || 'nothing'})`,
    );
  }
}

async function readGeneration(paths, profile, trust, active, expectedUid = /** @type {number|null} */ (null)) {
  const generationRoot = path.join(paths.generations, active.generation);
  await generationEntries(generationRoot, `generation ${active.generation}`, expectedUid);
  const [policyBytes, activationBytes, metadata] = await Promise.all([
    readRegularFile(path.join(generationRoot, 'policy.json'), `${active.generation}/policy.json`, MAX_MANAGED_POLICY_BYTES, expectedUid),
    readRegularFile(path.join(generationRoot, 'activation.json'), `${active.generation}/activation.json`, 128 * 1024, expectedUid),
    inspectMetadataTree(path.join(generationRoot, 'metadata'), `${active.generation}/metadata`, expectedUid),
  ]);
  const policy = parseManagedPolicy(policyBytes, `${active.generation}/policy.json`);
  const activation = parseActivationReceipt(activationBytes, `${active.generation}/activation.json`);
  const actualPolicySha256 = sha256(policyBytes);
  const actualActivationSha256 = sha256(activationBytes);
  const { generation: receiptGeneration, ...activationCore } = activation;
  const computedGeneration = sha256(Buffer.from(canonicalJson(activationCore)));
  if (policy.profile !== profile || activation.profile !== profile || active.profile !== profile) {
    managedPolicyRefuse('MANAGED_POLICY_PROFILE', `active generation is not bound to profile '${profile}'`);
  }
  if (active.generation !== receiptGeneration || receiptGeneration !== computedGeneration
    || active.targetSha256 !== actualPolicySha256 || activation.targetSha256 !== actualPolicySha256) {
    managedPolicyRefuse('MANAGED_POLICY_CORRUPT', `active policy/receipt bytes do not match generation ${active.generation}`);
  }
  if (activation.policyLength !== policyBytes.length) {
    managedPolicyRefuse('MANAGED_POLICY_CORRUPT', 'active policy length does not match its activation receipt');
  }
  if (active.activationSha256 !== actualActivationSha256) {
    managedPolicyRefuse('MANAGED_POLICY_CORRUPT', 'active activation receipt does not match active.json');
  }
  if (trust.rootSha256 !== active.rootSha256 || trust.rootSha256 !== activation.rootSha256) {
    managedPolicyRefuse('MANAGED_POLICY_ROOT_MISMATCH', 'active generation is not bound to the enrolled root fingerprint');
  }
  if (!sameJson(active.versions, activation.versions)) {
    managedPolicyRefuse('MANAGED_POLICY_CORRUPT', 'active metadata versions do not match the activation receipt');
  }
  if (active.verifiedAt !== activation.verifiedAt || !sameJson(active.expires, activation.expires)) {
    managedPolicyRefuse('MANAGED_POLICY_CORRUPT', 'active freshness evidence does not match the activation receipt');
  }
  if (!sameJson(metadata.manifest, activation.metadata)
    || metadata.treeSha256 !== activation.metadataTreeSha256) {
    managedPolicyRefuse('MANAGED_POLICY_CORRUPT', 'active metadata bytes do not match the activation receipt');
  }
  return { path: generationRoot, policy, policyBytes, activation, activationBytes, metadata };
}

async function readActive(paths, profile, trust, expectedUid = /** @type {number|null} */ (null)) {
  let activeBytes;
  try {
    activeBytes = await readRegularFile(paths.active, `${profile}/active.json`, 16 * 1024, expectedUid);
  } catch (error) {
    if (error?.code !== 'MANAGED_POLICY_STATE_MISSING') throw error;
    const generations = await fs.readdir(paths.generations);
    if (generations.length) {
      managedPolicyRefuse(
        'MANAGED_POLICY_STATE_MISSING',
        `active.json is missing while ${generations.length} generation(s) exist; refusing to scan or guess a last-good generation`,
      );
    }
    return null;
  }
  const active = parseActivePointer(activeBytes, `${profile}/active.json`);
  const generation = await readGeneration(paths, profile, trust, active, expectedUid);
  return { active, activeBytes, generation };
}

async function optionalRegularFile(file, label, maxBytes, expectedUid = /** @type {number|null} */ (null)) {
  try {
    return await readRegularFile(file, label, maxBytes, expectedUid);
  } catch (error) {
    if (error?.code === 'MANAGED_POLICY_STATE_MISSING') return null;
    throw error;
  }
}

async function readTransition(paths, profile, expectedUid = /** @type {number|null} */ (null)) {
  const bytes = await optionalRegularFile(paths.transition, `${profile}/transition.json`, 32 * 1024, expectedUid);
  if (bytes === null) return null;
  return { bytes, transition: parseManagedTransition(bytes, `${profile}/transition.json`) };
}

/**
 * @param {{storeRoot: string, profile: string,
 *   lockToken?: string|null, allowTransition?: boolean}} options
 */
async function loadManagedPolicyProfileInternal({
  storeRoot,
  profile,
  lockToken = null,
  allowTransition = false,
}) {
  const paths = managedPolicyProfilePaths(storeRoot, profile);
  const { trust, ownerUid } = await readTrust(paths, profile);
  /** @type {any} */
  let lock = null;
  try { lock = await readLock(paths, profile, ownerUid); } catch (error) {
    if (error?.code !== 'MANAGED_POLICY_STATE_MISSING') throw error;
  }
  if (lock !== null && lock.token !== lockToken) {
    managedPolicyRefuse(
      'MANAGED_POLICY_LOCKED',
      `managed-policy profile '${profile}' is locked; inspect recovery state before trusting its active pointer`,
    );
  }
  const pending = await readTransition(paths, profile, ownerUid);
  if (pending !== null && !allowTransition) {
    managedPolicyRefuse(
      'MANAGED_POLICY_RECOVERY_REQUIRED',
      `managed-policy profile '${profile}' has an incomplete activation transition; explicit administrator recovery is required`,
    );
  }
  const loaded = await readActive(paths, profile, trust, ownerUid);
  return {
    paths,
    trust,
    ownerUid,
    active: loaded?.active ?? null,
    activeBytes: loaded?.activeBytes ?? null,
    generation: loaded?.generation ?? null,
    policy: loaded?.generation?.policy ?? null,
    transition: pending?.transition ?? null,
  };
}

/** Read only the exact active pointer. Corrupt/in-flight state refuses; generations are never scanned. */
export async function loadManagedPolicyProfile({ storeRoot, profile }) {
  return loadManagedPolicyProfileInternal({ storeRoot, profile });
}

async function acquireProfileLock(paths, profile) {
  const token = randomUUID();
  let handle;
  try {
    handle = await fs.open(paths.lock, WRITE_NEW_FLAGS, 0o600);
    await handle.writeFile(canonicalJson({ version: 1, profile, pid: process.pid, token }));
    await handle.sync();
    await fsyncDirectory(paths.profile);
  } catch (error) {
    await handle?.close().catch(() => {});
    await removeOwnedLock(paths, profile, token).catch(() => {});
    if (['EEXIST', 'ELOOP'].includes(error?.code)) {
      managedPolicyRefuse(
        'MANAGED_POLICY_LOCKED',
        `managed-policy profile '${profile}' is locked; stale locks require explicit administrator recovery`,
      );
    }
    throw error;
  }
  await handle.close();
  return {
    token,
    release: async () => removeOwnedLock(paths, profile, token),
  };
}

async function readLock(paths, profile, expectedUid = /** @type {number|null} */ (null)) {
  const bytes = await readRegularFile(paths.lock, `${profile}/lock`, 16 * 1024, expectedUid);
  let lock;
  try {
    lock = parseStrictJson(bytes, `${profile}/lock`, { maxBytes: 16 * 1024 });
  } catch (error) {
    if (['MANAGED_POLICY_PARSE', 'MANAGED_POLICY_DUPLICATE_KEY', 'MANAGED_POLICY_SCHEMA',
      'MANAGED_POLICY_CONTROL', 'MANAGED_POLICY_UNICODE', 'MANAGED_POLICY_LIMIT'].includes(error?.code)) {
      managedPolicyRefuse('MANAGED_POLICY_LOCKED', `managed-policy profile '${profile}' has a malformed lock`);
    }
    throw error;
  }
  const keys = lock && typeof lock === 'object' && !Array.isArray(lock) ? Object.keys(lock).sort() : [];
  if (!sameJson(keys, ['pid', 'profile', 'token', 'version']) || lock.version !== 1
    || lock.profile !== profile || !Number.isSafeInteger(lock.pid) || lock.pid < 0
    || typeof lock.token !== 'string' || !/^[a-f0-9-]{36}$/u.test(lock.token)) {
    managedPolicyRefuse('MANAGED_POLICY_LOCKED', `managed-policy profile '${profile}' has a malformed lock`);
  }
  return lock;
}

async function removeOwnedLock(paths, profile, token) {
  let lock;
  try { lock = await readLock(paths, profile); } catch (error) {
    if (error?.code === 'MANAGED_POLICY_STATE_MISSING') return;
    throw error;
  }
  if (lock.token !== token) {
    managedPolicyRefuse('MANAGED_POLICY_LOCK_OWNERSHIP', `refusing to release a replacement lock for profile '${profile}'`);
  }
  await fs.unlink(paths.lock);
  await fsyncDirectory(paths.profile);
}

async function inspectStagedGeneration(
  stagedDirectory,
  paths,
  profile,
  trust,
  verification,
  expectedUid = /** @type {number|null} */ (null),
  { ownedIncoming = false } = {},
) {
  if (typeof stagedDirectory !== 'string' || !stagedDirectory || stagedDirectory.includes('\0')) {
    managedPolicyRefuse('MANAGED_POLICY_PATH', 'stagedDirectory must be a filesystem path');
  }
  const staged = path.resolve(stagedDirectory);
  await secureDirectory(staged, 'staged managed-policy generation', expectedUid);
  const [stagedReal, profileReal, generationsReal] = await Promise.all([
    fs.realpath(staged), fs.realpath(paths.profile), fs.realpath(paths.generations),
  ]);
  if (!ownedIncoming && await underOrEqualAsync(stagedReal, profileReal)) {
    managedPolicyRefuse(
      'MANAGED_POLICY_PATH',
      'staged generation must live outside the active profile; the verifier owns a sibling staging area',
    );
  }
  if (ownedIncoming) {
    const relativeToGenerations = await relativeWithinAsync(generationsReal, stagedReal);
    if (!/^[^/\\]+$/u.test(relativeToGenerations) || !relativeToGenerations.startsWith('.incoming-')) {
      managedPolicyRefuse('MANAGED_POLICY_PATH', 'owned incoming generation escaped the generations directory');
    }
  }
  const entries = (await fs.readdir(staged)).sort();
  const expected = ['metadata', 'policy.json'];
  if (!sameJson(entries, expected)) {
    managedPolicyRefuse(
      'MANAGED_POLICY_LAYOUT',
      `staged generation must contain exactly ${expected.join(', ')} (found: ${entries.join(', ') || 'nothing'})`,
    );
  }
  const [policyBytes, metadata] = await Promise.all([
    readRegularFile(path.join(staged, 'policy.json'), 'staged policy.json', MAX_MANAGED_POLICY_BYTES, expectedUid),
    inspectMetadataTree(path.join(staged, 'metadata'), 'staged metadata', expectedUid),
  ]);
  const policy = parseManagedPolicy(policyBytes, 'staged policy.json');
  if (policy.profile !== profile) {
    managedPolicyRefuse('MANAGED_POLICY_PROFILE', `staged policy names profile '${policy.profile}', expected '${profile}'`);
  }

  validateStagedVerificationObject(verification);
  const policySha256 = sha256(policyBytes);
  if (verification.profile !== profile || verification.target.sha256 !== policySha256
    || verification.target.length !== policyBytes.length) {
    managedPolicyRefuse('MANAGED_POLICY_RECEIPT_MISMATCH', 'staged policy bytes do not match the verifier receipt');
  }
  if (verification.rootSha256 !== trust.rootSha256) {
    managedPolicyRefuse('MANAGED_POLICY_ROOT_MISMATCH', 'verifier receipt is not bound to the enrolled root fingerprint');
  }
  if (!sameJson(verification.metadata, metadata.manifest)) {
    managedPolicyRefuse('MANAGED_POLICY_RECEIPT_MISMATCH', 'staged metadata bytes do not match the verifier receipt');
  }
  const stagedStat = await fs.stat(staged);
  const generationsStat = await fs.stat(paths.generations);
  if (stagedStat.dev !== generationsStat.dev) {
    managedPolicyRefuse('MANAGED_POLICY_CROSS_DEVICE', 'staging and active generations must be on the same filesystem');
  }

  const activationCore = {
    version: MANAGED_POLICY_VERSION,
    profile,
    targetSha256: policySha256,
    policyLength: policyBytes.length,
    rootSha256: trust.rootSha256,
    versions: { ...verification.versions },
    metadata: metadata.manifest.map((item) => ({ ...item })),
    metadataTreeSha256: metadata.treeSha256,
    verifiedAt: verification.verifiedAt,
    expires: { ...verification.expires },
  };
  const activation = {
    ...activationCore,
    generation: sha256(Buffer.from(canonicalJson(activationCore))),
  };
  const activationBytes = Buffer.from(canonicalJson(activation));
  return { staged, policy, policyBytes, policySha256, metadata, activation, activationBytes };
}

async function fsyncTree(root) {
  const walk = async (directory) => {
    const directoryHandle = await fs.open(directory, READ_FLAGS);
    try {
      const openedDirectory = await directoryHandle.stat();
      const namedDirectory = await fs.lstat(directory);
      if (!openedDirectory.isDirectory() || namedDirectory.isSymbolicLink()
        || !sameEntryIdentity(openedDirectory, namedDirectory)) {
        managedPolicyRefuse('MANAGED_POLICY_RACE', `${directory} changed while the tree was being synced`);
      }
      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const absolute = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) managedPolicyRefuse('MANAGED_POLICY_SYMLINK', `${absolute} became a symlink during fsync`);
        if (entry.isDirectory()) {
          await walk(absolute);
          continue;
        }
        const handle = await fs.open(absolute, READ_FLAGS | (fsConstants.O_NONBLOCK ?? 0));
        try {
          const opened = await handle.stat();
          const named = await fs.lstat(absolute);
          if (!opened.isFile() || named.isSymbolicLink() || !sameEntryIdentity(opened, named)) {
            managedPolicyRefuse('MANAGED_POLICY_RACE', `${absolute} changed while the tree was being synced`);
          }
          await handle.sync();
        } finally { await handle.close(); }
      }
      const namedAfter = await fs.lstat(directory);
      if (namedAfter.isSymbolicLink() || !sameEntryIdentity(openedDirectory, namedAfter)) {
        managedPolicyRefuse('MANAGED_POLICY_RACE', `${directory} changed while the tree was being synced`);
      }
    } finally {
      await directoryHandle.close();
    }
    await fsyncDirectory(directory);
  };
  await walk(root);
}

async function makeGenerationReadOnly(root, authority = 'user') {
  if (!POSIX_PERMISSION_CHECKS) return;
  const fileMode = managedReadOnlyFileMode(authority);
  const directoryMode = managedReadOnlyDirectoryMode(authority);
  const walk = async (directory) => {
    const directoryHandle = await fs.open(directory, READ_FLAGS);
    try {
      const directoryStat = await directoryHandle.stat();
      const namedDirectory = await fs.lstat(directory);
      if (!directoryStat.isDirectory() || namedDirectory.isSymbolicLink()
        || !sameEntryIdentity(directoryStat, namedDirectory)) {
        managedPolicyRefuse('MANAGED_POLICY_RACE', `${directory} changed while the tree was being hardened`);
      }
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) managedPolicyRefuse('MANAGED_POLICY_SYMLINK', `${absolute} became a symlink during hardening`);
        if (entry.isDirectory()) {
          await walk(absolute);
          continue;
        }
        const handle = await fs.open(absolute, READ_FLAGS | (fsConstants.O_NONBLOCK ?? 0));
        try {
          const opened = await handle.stat();
          const named = await fs.lstat(absolute);
          if (!opened.isFile() || named.isSymbolicLink() || !sameEntryIdentity(opened, named)) {
            managedPolicyRefuse('MANAGED_POLICY_RACE', `${absolute} changed while the tree was being hardened`);
          }
          await handle.chmod(fileMode);
        } finally {
          await handle.close();
        }
      }
      const namedAfter = await fs.lstat(directory);
      if (namedAfter.isSymbolicLink() || !sameEntryIdentity(directoryStat, namedAfter)) {
        managedPolicyRefuse('MANAGED_POLICY_RACE', `${directory} changed while the tree was being hardened`);
      }
      await directoryHandle.chmod(directoryMode);
    } finally {
      await directoryHandle.close();
    }
  };
  await walk(root);
}

async function writeTransition(paths, transition) {
  await writeNewFile(paths.transition, Buffer.from(canonicalJson(transition)), 0o600);
  await fsyncDirectory(paths.profile);
}

async function clearTransition(paths, profile, expected, expectedUid = /** @type {number|null} */ (null)) {
  const observed = await readTransition(paths, profile, expectedUid);
  if (observed === null) {
    managedPolicyRefuse('MANAGED_POLICY_TRANSITION_OWNERSHIP', `transition for profile '${profile}' disappeared`);
  }
  if (!sameJson(observed.transition, expected)) {
    managedPolicyRefuse(
      'MANAGED_POLICY_TRANSITION_OWNERSHIP',
      `refusing to clear a replacement transition for profile '${profile}'`,
    );
  }
  await fs.unlink(paths.transition);
  await fsyncDirectory(paths.profile);
}

/**
 * Consume one separately verified staging directory and atomically select it as active.
 * Existing active state is fully re-verified before any mutation. On every pre-commit failure,
 * active.json remains byte-for-byte unchanged; an orphan generation is never an implicit fallback.
 */
export async function activateStagedManagedPolicy({
  storeRoot,
  profile,
  stagedDirectory,
  verification,
}) {
  const paths = managedPolicyProfilePaths(storeRoot, profile);
  // Establish that the profile is structurally sound before creating a lock inside it.
  await loadManagedPolicyProfile({ storeRoot, profile });
  const heldLock = await acquireProfileLock(paths, profile);
  try {
    // Re-read under the lock. Another process may have activated between the first read and lock.
    const current = await loadManagedPolicyProfileInternal({
      storeRoot, profile, lockToken: heldLock.token,
    });
    let verificationBytes;
    try { verificationBytes = Buffer.from(canonicalJson(verification)); } catch {
      managedPolicyRefuse('MANAGED_POLICY_SCHEMA', 'staged verification receipt must contain JSON data only');
    }
    const stableVerification = validateStagedVerificationObject(
      parseStrictJson(verificationBytes, 'staged verification receipt', { maxBytes: 128 * 1024 }),
      'staged verification receipt',
    );
    const staged = await inspectStagedGeneration(
      stagedDirectory, paths, profile, current.trust, stableVerification, current.ownerUid,
    );
    if (current.generation) assertMonotonic(current.generation.activation, staged.activation);

    // An identical authenticated refresh often has a new verifier wall-clock timestamp. That
    // timestamp remains part of every generation we do activate, but it must not manufacture a
    // new enforcement state when target/root/metadata/versions/expiry are byte-for-byte equal.
    // This comparison is under the profile lock, so an adapter-side precheck cannot race it.
    if (current.generation
      && sameAuthenticatedGeneration(current.generation.activation, staged.activation)) {
      return {
        ok: true,
        changed: false,
        profile,
        authority: current.trust.authority,
        generation: current.active.generation,
        active: current.active,
        installed: false,
        activated: false,
        noOp: true,
        stagingConsumed: false,
        previousGeneration: current.active.generation,
        statusWarning: null,
        recoveryRequired: false,
        authentication: 'external-verifier-required',
      };
    }

    const activationSha256 = sha256(staged.activationBytes);
    const nextActive = {
      version: MANAGED_POLICY_VERSION,
      profile,
      generation: staged.activation.generation,
      targetSha256: staged.policySha256,
      activationSha256,
      rootSha256: current.trust.rootSha256,
      versions: { ...staged.activation.versions },
      verifiedAt: staged.activation.verifiedAt,
      expires: { ...staged.activation.expires },
    };
    const destination = path.join(paths.generations, staged.activation.generation);
    let destinationExists = false;
    let installed = false;
    try {
      const existing = await fs.lstat(destination);
      if (existing.isSymbolicLink()) managedPolicyRefuse('MANAGED_POLICY_SYMLINK', `generation ${staged.activation.generation} is a symlink`);
      const verifiedExisting = await readGeneration(paths, profile, current.trust, nextActive, current.ownerUid);
      if (!sameJson(verifiedExisting.activation, staged.activation)) {
        managedPolicyRefuse('MANAGED_POLICY_GENERATION_COLLISION', 'immutable generation hash exists with a different activation receipt');
      }
      destinationExists = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    if (destinationExists && current.active !== null && sameJson(current.active, nextActive)) {
      return {
        ok: true,
        changed: false,
        profile,
        authority: current.trust.authority,
        generation: nextActive.generation,
        active: nextActive,
        installed: false,
        activated: false,
        noOp: true,
        stagingConsumed: false,
        previousGeneration: current.active.generation,
        statusWarning: null,
        recoveryRequired: false,
        authentication: 'external-verifier-required',
      };
    }

    const transactionId = randomUUID();
    const incomingName = `.incoming-${transactionId}`;
    const incoming = path.join(paths.generations, incomingName);
    const transition = {
      version: MANAGED_POLICY_VERSION,
      profile,
      transaction: transactionId,
      incoming: incomingName,
      nextActive,
      previousActive: current.active,
    };
    // The transaction journal lands before any store-owned candidate bytes. A crash at every
    // later instruction therefore leaves one exact, administrator-recoverable intent rather than
    // an unnamed "newest" generation that a loader might be tempted to guess from.
    await writeTransition(paths, transition);
    let stagingConsumed = false;
    if (!destinationExists) {
      // First take ownership with one same-filesystem rename. Only after the bytes live under the
      // store-controlled generations directory do we write activation.json. Re-verify there so a
      // staging-parent symlink swap can at worst leave the journalled incoming directory; it can
      // never redirect a privileged write outside the store.
      await fs.rename(staged.staged, incoming);
      stagingConsumed = true;
      await fsyncDirectory(paths.generations);
      const consumed = await inspectStagedGeneration(
        incoming, paths, profile, current.trust, stableVerification, current.ownerUid, { ownedIncoming: true },
      );
      if (!sameJson(consumed.activation, staged.activation)) {
        managedPolicyRefuse('MANAGED_POLICY_RACE', 'staged generation changed while ownership was transferred');
      }
      await writeNewFile(path.join(incoming, 'activation.json'), consumed.activationBytes, 0o400);
      await fsyncTree(incoming);
      await fs.rename(incoming, destination);
      await fsyncDirectory(paths.generations);
      // Harden only after the same-filesystem rename. Some protected filesystems refuse moving a
      // directory once it is non-writable; the generation is not selectable until active.json is
      // replaced, so hardening here preserves the same commit boundary without a copy fallback.
      await makeGenerationReadOnly(destination, current.trust.authority);
      await fsyncTree(destination);
      await fsyncDirectory(paths.generations);
      installed = true;
    }

    // Verify from its final path before selecting it. The active pointer is the only commit point.
    await readGeneration(paths, profile, current.trust, nextActive, current.ownerUid);
    const activeBytes = Buffer.from(canonicalJson(nextActive));
    await atomicWrite(paths.active, activeBytes, managedPointerFileMode(current.trust.authority));

    /** @type {string|null} */
    let transitionCleanupWarning = null;
    await clearTransition(paths, profile, transition, current.ownerUid)
      .catch((error) => { transitionCleanupWarning = `transition.json was not cleared: ${error.message}`; });

    // status.json is explicitly advisory. A status-write failure after the active commit cannot
    // turn a successful activation into a reported failure or roll the pointer back.
    /** @type {string|null} */
    let statusWarning = null;
    const status = {
      version: MANAGED_POLICY_VERSION,
      profile,
      state: 'active',
      generation: nextActive.generation,
      activationSha256: nextActive.activationSha256,
      targetSha256: nextActive.targetSha256,
      versions: { ...nextActive.versions },
      verifiedAt: nextActive.verifiedAt,
      expires: { ...nextActive.expires },
    };
    await atomicWrite(paths.status, Buffer.from(canonicalJson(status)), managedPointerFileMode(current.trust.authority))
      .catch((error) => { statusWarning = `status.json was not updated: ${error.message}`; });

    return {
      ok: true,
      changed: true,
      profile,
      authority: current.trust.authority,
      generation: nextActive.generation,
      active: nextActive,
      installed,
      activated: true,
      noOp: false,
      stagingConsumed,
      previousGeneration: current.active?.generation ?? null,
      statusWarning,
      transitionCleanupWarning,
      recoveryRequired: transitionCleanupWarning !== null,
      authentication: 'external-verifier-required',
    };
  } finally {
    await heldLock.release();
  }
}

async function readActiveForRecovery(paths, profile, trust, expectedUid = /** @type {number|null} */ (null)) {
  const activeBytes = await optionalRegularFile(paths.active, `${profile}/active.json`, 16 * 1024, expectedUid);
  if (activeBytes === null) return { active: null, activeBytes: null, generation: null };
  const active = parseActivePointer(activeBytes, `${profile}/active.json`);
  const generation = await readGeneration(paths, profile, trust, active, expectedUid);
  return { active, activeBytes, generation };
}

function sameActive(left, right) {
  return left === null ? right === null : right !== null && sameJson(left, right);
}

async function entryKind(entry) {
  try {
    const stat = await fs.lstat(entry);
    if (stat.isSymbolicLink()) return 'symlink';
    if (stat.isDirectory()) return 'directory';
    return 'other';
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing';
    throw error;
  }
}

async function quarantineDirectory(
  paths,
  source,
  name,
  expectedUid = /** @type {number|null} */ (null),
  authority = 'user',
) {
  await secureDirectory(source, `recovery candidate '${name}'`, expectedUid);
  const destination = path.join(paths.quarantine, `${randomUUID()}-${name.replace(/^\./u, '')}`);
  // POSIX may require write permission on a moved directory itself in order to update its `..`
  // entry. Open without following links, temporarily grant only its authoritative owner access,
  // then lock the quarantined tree read-only again.
  if (POSIX_PERMISSION_CHECKS) {
    const handle = await fs.open(source, READ_FLAGS);
    try { await handle.chmod(0o700); } finally { await handle.close(); }
  }
  try {
    await fs.rename(source, destination);
  } catch (error) {
    await makeGenerationReadOnly(source, authority).catch(() => {});
    throw error;
  }
  await makeGenerationReadOnly(destination, authority);
  await fsyncTree(destination);
  await fsyncDirectory(paths.generations);
  await fsyncDirectory(paths.quarantine);
  return destination;
}

/**
 * Inspect only recovery receipts and exact directory names. This never selects a generation and
 * never treats mtimes, lexical order, or "newest" as authority.
 */
export async function inspectManagedPolicyRecovery({ storeRoot, profile }) {
  const paths = managedPolicyProfilePaths(storeRoot, profile);
  const { trust, ownerUid } = await readTrust(paths, profile);
  /** @type {any} */
  let lock = null;
  try { lock = await readLock(paths, profile, ownerUid); } catch (error) {
    if (error?.code !== 'MANAGED_POLICY_STATE_MISSING') throw error;
  }
  const pending = await readTransition(paths, profile, ownerUid);
  const active = await readActiveForRecovery(paths, profile, trust, ownerUid);
  const entries = (await fs.readdir(paths.generations)).sort();
  const incoming = [];
  const unselectedGenerations = [];
  for (const name of entries) {
    if (/^\.incoming-[a-f0-9-]{36}$/u.test(name)) incoming.push(name);
    else if (/^[a-f0-9]{64}$/u.test(name) && name !== active.active?.generation) unselectedGenerations.push(name);
    else if (name !== active.active?.generation) {
      managedPolicyRefuse('MANAGED_POLICY_LAYOUT', `generations directory contains unrecognized entry '${name}'`);
    }
  }
  const recoveryRequired = lock !== null || pending !== null || incoming.length > 0
    || (active.active === null && unselectedGenerations.length > 0);
  return {
    version: MANAGED_POLICY_VERSION,
    profile,
    state: recoveryRequired ? 'recovery-required' : 'clean',
    recoveryRequired,
    lock,
    transition: pending?.transition ?? null,
    active: active.active,
    incoming,
    unselectedGenerations,
    note: recoveryRequired
      ? 'Use the exact lock token and transition/orphan name with recoverManagedPolicyActivation; no generation was guessed.'
      : 'No lock, transition, or unselected first-generation state is present.',
  };
}

async function takeRecoveryLock(paths, profile, ownerUid, lockToken) {
  /** @type {any} */
  let observed = null;
  try { observed = await readLock(paths, profile, ownerUid); } catch (error) {
    if (error?.code !== 'MANAGED_POLICY_STATE_MISSING') throw error;
  }
  if (observed !== null) {
    if (typeof lockToken !== 'string' || observed.token !== lockToken) {
      managedPolicyRefuse(
        'MANAGED_POLICY_LOCK_OWNERSHIP',
        `recovery requires the exact currently inspected lock token for profile '${profile}'`,
      );
    }
    await removeOwnedLock(paths, profile, lockToken);
  } else if (lockToken !== null && lockToken !== undefined) {
    managedPolicyRefuse('MANAGED_POLICY_LOCK_OWNERSHIP', `the inspected lock for profile '${profile}' no longer exists`);
  }
  return acquireProfileLock(paths, profile);
}

/**
 * Explicit administrator recovery. `complete` follows only transition.json. `quarantine` moves
 * only the exact journalled candidate (or one exact orphan name supplied by the administrator)
 * into same-filesystem recoverable quarantine. Neither mode scans for a plausible generation.
 */
export async function recoverManagedPolicyActivation({
  storeRoot,
  profile,
  mode,
  lockToken = null,
  orphan = null,
}) {
  if (mode !== 'complete' && mode !== 'quarantine') {
    managedPolicyRefuse('MANAGED_POLICY_RECOVERY', "recovery mode must be 'complete' or 'quarantine'");
  }
  if (orphan !== null && (typeof orphan !== 'string'
    || (!/^\.incoming-[a-f0-9-]{36}$/u.test(orphan) && !/^[a-f0-9]{64}$/u.test(orphan)))) {
    managedPolicyRefuse('MANAGED_POLICY_PATH', 'recovery orphan must be one exact incoming or generation basename');
  }
  const paths = managedPolicyProfilePaths(storeRoot, profile);
  const enrollment = await readTrust(paths, profile);
  const heldLock = await takeRecoveryLock(paths, profile, enrollment.ownerUid, lockToken);
  try {
    // Re-establish trust and ownership under our replacement lock.
    const { trust, ownerUid } = await readTrust(paths, profile);
    const pending = await readTransition(paths, profile, ownerUid);
    const current = await readActiveForRecovery(paths, profile, trust, ownerUid);

    if (mode === 'complete') {
      if (orphan !== null) {
        managedPolicyRefuse('MANAGED_POLICY_RECOVERY', 'complete recovery follows transition.json and does not accept an orphan name');
      }
      if (pending === null) {
        managedPolicyRefuse('MANAGED_POLICY_RECOVERY', `profile '${profile}' has no transition to complete`);
      }
      const transition = pending.transition;
      if (sameActive(current.active, transition.nextActive)) {
        await readGeneration(paths, profile, trust, transition.nextActive, ownerUid);
        await clearTransition(paths, profile, transition, ownerUid);
        return {
          ok: true, profile, mode, outcome: 'already-committed',
          generation: transition.nextActive.generation, activated: false, noOp: true,
        };
      }
      if (!sameActive(current.active, transition.previousActive)) {
        managedPolicyRefuse(
          'MANAGED_POLICY_RECOVERY_DIVERGED',
          `active.json matches neither side of transaction '${transition.transaction}'`,
        );
      }
      const incoming = path.join(paths.generations, transition.incoming);
      const destination = path.join(paths.generations, transition.nextActive.generation);
      const [incomingKind, destinationKind] = await Promise.all([entryKind(incoming), entryKind(destination)]);
      if (incomingKind === 'symlink' || destinationKind === 'symlink') {
        managedPolicyRefuse('MANAGED_POLICY_SYMLINK', 'recovery candidate must not be a symlink');
      }
      if (incomingKind !== 'missing' && incomingKind !== 'directory') {
        managedPolicyRefuse('MANAGED_POLICY_LAYOUT', 'journalled incoming candidate is not a directory');
      }
      if (destinationKind !== 'missing' && destinationKind !== 'directory') {
        managedPolicyRefuse('MANAGED_POLICY_LAYOUT', 'journalled destination is not a directory');
      }
      if (incomingKind === 'directory' && destinationKind === 'directory') {
        managedPolicyRefuse('MANAGED_POLICY_RECOVERY_DIVERGED', 'both incoming and final transaction candidates exist');
      }
      if (incomingKind === 'missing' && destinationKind === 'missing') {
        managedPolicyRefuse('MANAGED_POLICY_STATE_MISSING', 'transaction candidate is missing; quarantine the empty transition instead');
      }
      if (incomingKind === 'directory') {
        await fs.rename(incoming, destination);
        await fsyncDirectory(paths.generations);
        await makeGenerationReadOnly(destination, trust.authority);
        await fsyncTree(destination);
        await fsyncDirectory(paths.generations);
      }
      await readGeneration(paths, profile, trust, transition.nextActive, ownerUid);
      await atomicWrite(
        paths.active,
        Buffer.from(canonicalJson(transition.nextActive)),
        managedPointerFileMode(trust.authority),
      );
      await clearTransition(paths, profile, transition, ownerUid);
      return {
        ok: true, profile, mode, outcome: 'completed',
        generation: transition.nextActive.generation, activated: true, noOp: false,
      };
    }

    if (pending !== null && orphan !== null) {
      managedPolicyRefuse('MANAGED_POLICY_RECOVERY', 'quarantine a transition or an orphan in one recovery operation, not both');
    }
    /** @type {string|null} */
    let quarantined = null;
    if (pending !== null) {
      const transition = pending.transition;
      if (sameActive(current.active, transition.nextActive)) {
        managedPolicyRefuse(
          'MANAGED_POLICY_RECOVERY_COMMITTED',
          'the transaction is already active; complete recovery to clear its journal instead of quarantining active bytes',
        );
      }
      if (!sameActive(current.active, transition.previousActive)) {
        managedPolicyRefuse('MANAGED_POLICY_RECOVERY_DIVERGED', 'active.json diverged from the transition being quarantined');
      }
      const incoming = path.join(paths.generations, transition.incoming);
      const destination = path.join(paths.generations, transition.nextActive.generation);
      const [incomingKind, destinationKind] = await Promise.all([entryKind(incoming), entryKind(destination)]);
      if (incomingKind === 'directory' && destinationKind === 'directory') {
        managedPolicyRefuse('MANAGED_POLICY_RECOVERY_DIVERGED', 'both incoming and final transaction candidates exist');
      }
      if (incomingKind === 'symlink' || destinationKind === 'symlink') {
        managedPolicyRefuse('MANAGED_POLICY_SYMLINK', 'recovery candidate must not be a symlink');
      }
      if (incomingKind === 'directory') {
        quarantined = await quarantineDirectory(paths, incoming, transition.incoming, ownerUid, trust.authority);
      } else if (destinationKind === 'directory') {
        quarantined = await quarantineDirectory(paths, destination, transition.nextActive.generation, ownerUid, trust.authority);
      } else if (incomingKind !== 'missing' || destinationKind !== 'missing') {
        managedPolicyRefuse('MANAGED_POLICY_LAYOUT', 'transaction candidate is not a directory');
      }
      await clearTransition(paths, profile, transition, ownerUid);
    } else if (orphan !== null) {
      if (orphan === current.active?.generation) {
        managedPolicyRefuse('MANAGED_POLICY_RECOVERY_COMMITTED', 'refusing to quarantine the exact active generation');
      }
      const source = path.join(paths.generations, orphan);
      quarantined = await quarantineDirectory(paths, source, orphan, ownerUid, trust.authority);
    }
    return {
      ok: true, profile, mode, outcome: quarantined === null ? 'stale-lock-cleared' : 'quarantined',
      quarantined, activated: false, noOp: quarantined === null,
    };
  } finally {
    await heldLock.release();
  }
}

/** Read advisory status without using it for any authorization decision. */
export async function readManagedPolicyStatus({ storeRoot, profile }) {
  const paths = managedPolicyProfilePaths(storeRoot, profile);
  const { ownerUid } = await readTrust(paths, profile);
  try {
    const bytes = await readRegularFile(paths.status, `${profile}/status.json`, 16 * 1024, ownerUid);
    return parseStrictJson(bytes, `${profile}/status.json`, { maxBytes: 16 * 1024 });
  } catch (error) {
    if (error?.code === 'MANAGED_POLICY_STATE_MISSING') return null;
    throw error;
  }
}
