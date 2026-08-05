// SPDX-License-Identifier: LicenseRef-holt-Commercial
// Commercial license — see src/team/LICENSE. NOT covered by the repository FSL-1.1-MIT grant.
/**
 * Explicit, networked TUF delivery for managed policy.
 *
 * Importing this module performs no I/O. The sole network entry point is
 * syncManagedPolicyFromTuf(), so authority resolution, hooks, status, and MCP remain offline.
 */

import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { Updater } from 'tuf-js';
import { DownloadHTTPError, DownloadLengthMismatchError } from 'tuf-js/dist/error.js';
import {
  MANAGED_POLICY_VERSION,
  MAX_MANAGED_POLICY_BYTES,
  MAX_METADATA_FILE_BYTES,
  MAX_METADATA_FILES,
  MAX_METADATA_TOTAL_BYTES,
  ManagedPolicyError,
  assertMetadataPath,
  managedPolicyRefuse,
  parseManagedPolicy,
} from './managed-policy-schema.mjs';
import {
  activateStagedManagedPolicy,
  loadManagedPolicyProfile,
} from './managed-policy-store.mjs';

const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const READ_FLAGS = fsConstants.O_RDONLY | NOFOLLOW;
const WRITE_NEW_FLAGS = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const ROLE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export const MANAGED_POLICY_TUF_LIMITS = Object.freeze({
  timeoutMs: 10_000,
  retries: 2,
  maxRootRotations: 32,
  maxDelegations: 32,
  maxMetadataFiles: MAX_METADATA_FILES,
  maxMetadataFileBytes: MAX_METADATA_FILE_BYTES,
  maxMetadataTotalBytes: MAX_METADATA_TOTAL_BYTES,
  maxTargetBytes: MAX_MANAGED_POLICY_BYTES,
});

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const lexicalCompare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function tufError(code, message, cause) {
  const error = new ManagedPolicyError(code, message);
  if (cause !== undefined) error.cause = cause;
  return error;
}

function boundedInteger(value, label, { minimum = 0, maximum }) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    managedPolicyRefuse('MANAGED_POLICY_TUF_CONFIG', `${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function repositoryBaseUrl(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    managedPolicyRefuse('MANAGED_POLICY_TUF_URL', `${label} must be a non-empty URL`);
  }
  let parsed;
  try { parsed = new URL(value); } catch (cause) {
    throw tufError('MANAGED_POLICY_TUF_URL', `${label} is not a valid URL`, cause);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
    || parsed.search || parsed.hash) {
    managedPolicyRefuse(
      'MANAGED_POLICY_TUF_URL',
      `${label} must be an http(s) URL without credentials, query, or fragment`,
    );
  }
  if (!parsed.pathname.endsWith('/')) parsed.pathname += '/';
  return parsed;
}

async function secureRead(file, label, maxBytes) {
  let handle;
  try { handle = await fs.open(file, READ_FLAGS); } catch (error) {
    if (error?.code === 'ELOOP') throw tufError('MANAGED_POLICY_SYMLINK', `${label} must not be a symlink`, error);
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) managedPolicyRefuse('MANAGED_POLICY_LAYOUT', `${label} must be a regular file`);
    if (before.nlink !== 1n) {
      managedPolicyRefuse('MANAGED_POLICY_HARDLINK', `${label} must have exactly one hard link`);
    }
    if (before.size > BigInt(maxBytes)) {
      managedPolicyRefuse('MANAGED_POLICY_LIMIT', `${label} exceeds the ${maxBytes}-byte limit`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || after.size !== BigInt(bytes.length)) {
      managedPolicyRefuse('MANAGED_POLICY_RACE', `${label} changed while it was read`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function writeNew(file, bytes, mode = 0o600) {
  let handle;
  try {
    handle = await fs.open(file, WRITE_NEW_FLAGS, mode);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function assertAuthoritativeDirectory(directory, label) {
  const stat = await fs.lstat(directory, { bigint: true });
  if (stat.isSymbolicLink()) managedPolicyRefuse('MANAGED_POLICY_SYMLINK', `${label} must not be a symlink`);
  if (!stat.isDirectory()) managedPolicyRefuse('MANAGED_POLICY_LAYOUT', `${label} must be a directory`);
  if (process.platform !== 'win32' && (Number(stat.mode & 0o777n) & 0o022) !== 0) {
    managedPolicyRefuse('MANAGED_POLICY_PERMISSIONS', `${label} must not be group/world writable`);
  }
}

function metadataRequestName(candidate, base) {
  if (candidate.origin !== base.origin || !candidate.pathname.startsWith(base.pathname)
    || candidate.search || candidate.hash || candidate.username || candidate.password) return null;
  const relative = candidate.pathname.slice(base.pathname.length);
  if (!relative || relative.includes('/') || relative.includes('\\') || /%2f|%5c/iu.test(relative)) return null;
  let decoded;
  try { decoded = decodeURIComponent(relative); } catch { return null; }
  const match = /^(?:([1-9]\d*)\.)?([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.json$/u.exec(decoded);
  if (!match || !ROLE_RE.test(match[2])) return null;
  return { requestName: decoded, role: match[2] };
}

class BoundedTufFetcher {
  constructor({ metadataBase, targetBase, fetchImpl, timeoutMs, retries, temporaryDirectory }) {
    this.metadataBase = metadataBase;
    this.targetUrl = new URL('policy.json', targetBase).href;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.temporaryDirectory = temporaryDirectory;
    this.metadataResponses = 0;
    this.metadataBytes = 0;
    this.requestAttempts = 0;
  }

  async fetchBytes(url, maxLength, kind) {
    let candidate;
    try { candidate = new URL(url); } catch (cause) {
      throw tufError('MANAGED_POLICY_TUF_URL', `tuf-js produced an invalid ${kind} URL`, cause);
    }
    const metadataName = kind === 'metadata' ? metadataRequestName(candidate, this.metadataBase) : null;
    if ((kind === 'metadata' && metadataName === null)
      || (kind === 'target' && candidate.href !== this.targetUrl)) {
      managedPolicyRefuse('MANAGED_POLICY_TUF_URL', `refusing unbound TUF ${kind} URL`);
    }
    const hardLimit = kind === 'metadata' ? MAX_METADATA_FILE_BYTES : MAX_MANAGED_POLICY_BYTES;
    const effectiveLimit = Math.min(maxLength, hardLimit);
    let lastError;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      this.requestAttempts++;
      let response;
      try {
        response = await this.fetchImpl(candidate.href, {
          redirect: 'error',
          headers: { 'user-agent': 'holt-managed-policy tuf-js/6.0.0' },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        lastError = error;
        if (attempt < this.retries) continue;
        throw error;
      }
      if (!response?.ok || !response.body) {
        const status = Number.isInteger(response?.status) ? response.status : 0;
        const error = new DownloadHTTPError('Failed to download', status);
        if (status >= 500 && status < 600 && attempt < this.retries) {
          lastError = error;
          continue;
        }
        throw error;
      }
      const declared = response.headers?.get?.('content-length');
      if (declared !== null && declared !== undefined && declared !== '') {
        const length = Number(declared);
        if (!Number.isSafeInteger(length) || length < 0 || length > effectiveLimit) {
          throw new DownloadLengthMismatchError(`${kind} Content-Length exceeds its bound`);
        }
        if (kind === 'metadata' && this.metadataBytes + length > MAX_METADATA_TOTAL_BYTES) {
          managedPolicyRefuse('MANAGED_POLICY_LIMIT', 'TUF metadata exceeds the total byte limit');
        }
      }
      const chunks = [];
      let length = 0;
      for await (const chunk of response.body) {
        const bytes = Buffer.from(chunk);
        length += bytes.length;
        if (length > effectiveLimit) throw new DownloadLengthMismatchError(`${kind} exceeds its byte bound`);
        if (kind === 'metadata' && this.metadataBytes + length > MAX_METADATA_TOTAL_BYTES) {
          managedPolicyRefuse('MANAGED_POLICY_LIMIT', 'TUF metadata exceeds the total byte limit');
        }
        chunks.push(bytes);
      }
      if (kind === 'metadata') {
        this.metadataResponses++;
        if (this.metadataResponses > MAX_METADATA_FILES) {
          managedPolicyRefuse('MANAGED_POLICY_LIMIT', 'TUF refresh exceeds the metadata response-count limit');
        }
        this.metadataBytes += length;
      }
      return Buffer.concat(chunks, length);
    }
    throw lastError ?? new Error(`unable to download ${kind}`);
  }

  downloadBytes(url, maxLength) {
    return this.fetchBytes(url, maxLength, 'metadata');
  }

  async downloadFile(url, maxLength, handler) {
    const bytes = await this.fetchBytes(url, maxLength, 'target');
    const temporary = path.join(this.temporaryDirectory, `target-${randomUUID()}`);
    try {
      await writeNew(temporary, bytes);
      return await handler(temporary);
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
  }
}

async function seedMetadataCache(loaded, metadataDirectory) {
  if (loaded.generation) {
    const source = path.join(loaded.generation.path, 'metadata');
    const sourceStat = await fs.lstat(source);
    if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
      managedPolicyRefuse('MANAGED_POLICY_LAYOUT', 'active metadata must be a non-symlink directory');
    }
    for (const name of await fs.readdir(source)) {
      assertMetadataPath(name, 'active metadata path');
      if (name.includes('/')) managedPolicyRefuse('MANAGED_POLICY_PATH', 'active TUF cache metadata must be flat');
      const bytes = await secureRead(path.join(source, name), `active metadata/${name}`, MAX_METADATA_FILE_BYTES);
      await writeNew(path.join(metadataDirectory, name), bytes);
    }
    await secureRead(path.join(metadataDirectory, 'root.json'), 'active metadata/root.json', MAX_METADATA_FILE_BYTES);
    return;
  }
  const rootBytes = await secureRead(loaded.paths.bootstrapRoot, 'bootstrap/root.json', MAX_METADATA_FILE_BYTES);
  await writeNew(path.join(metadataDirectory, 'root.json'), rootBytes);
}

function findAuthorizingRole(trustedSet, targetInfo) {
  for (const [name, metadata] of Object.entries(trustedSet.trustedSet)) {
    if (metadata?.signed?.targets?.['policy.json'] === targetInfo) return { name, metadata };
  }
  managedPolicyRefuse('MANAGED_POLICY_TUF_TARGET', 'verified policy target is not bound to a trusted targets role');
}

async function stageTrustedMetadata(trustedSet, cacheDirectory, destination) {
  const roles = Object.keys(trustedSet.trustedSet);
  if (roles.length < 4 || roles.length > MAX_METADATA_FILES) {
    managedPolicyRefuse('MANAGED_POLICY_LIMIT', 'trusted TUF metadata role count is outside the supported bound');
  }
  const manifest = [];
  let total = 0;
  for (const role of roles.sort(lexicalCompare)) {
    if (!ROLE_RE.test(role)) {
      managedPolicyRefuse('MANAGED_POLICY_TUF_ROLE', `TUF role '${role}' cannot be represented safely on disk`);
    }
    const receiptPath = `${role}.json`;
    assertMetadataPath(receiptPath, 'verified metadata path');
    const cachedPath = path.join(cacheDirectory, `${encodeURIComponent(role)}.json`);
    const bytes = await secureRead(cachedPath, `verified ${role} metadata`, MAX_METADATA_FILE_BYTES);
    total += bytes.length;
    if (total > MAX_METADATA_TOTAL_BYTES) {
      managedPolicyRefuse('MANAGED_POLICY_LIMIT', 'trusted TUF metadata exceeds the total byte limit');
    }
    await writeNew(path.join(destination, receiptPath), bytes);
    manifest.push({ path: receiptPath, sha256: sha256(bytes), length: bytes.length });
  }
  return manifest;
}

function assertSignedTarget(targetInfo) {
  if (!targetInfo || targetInfo.path !== 'policy.json') {
    managedPolicyRefuse('MANAGED_POLICY_TUF_TARGET', "repository must publish exactly the target 'policy.json'");
  }
  if (!Number.isSafeInteger(targetInfo.length) || targetInfo.length < 1
    || targetInfo.length > MAX_MANAGED_POLICY_BYTES) {
    managedPolicyRefuse(
      'MANAGED_POLICY_LIMIT',
      `signed policy target length must be between 1 and ${MAX_MANAGED_POLICY_BYTES} bytes`,
    );
  }
  if (typeof targetInfo.hashes?.sha256 !== 'string' || !SHA256_RE.test(targetInfo.hashes.sha256)) {
    managedPolicyRefuse('MANAGED_POLICY_TUF_TARGET', 'policy target must carry a lowercase SHA-256 digest');
  }
}

/**
 * Explicitly refresh one enrolled profile from a bound TUF repository and atomically activate it.
 * The caller supplies repository URLs; redirects and every URL outside those exact bases refuse.
 */
export async function syncManagedPolicyFromTuf({
  storeRoot,
  profile,
  metadataBaseUrl,
  targetBaseUrl,
  timeoutMs = MANAGED_POLICY_TUF_LIMITS.timeoutMs,
  retries = MANAGED_POLICY_TUF_LIMITS.retries,
  maxRootRotations = MANAGED_POLICY_TUF_LIMITS.maxRootRotations,
  maxDelegations = MANAGED_POLICY_TUF_LIMITS.maxDelegations,
  fetchImpl = globalThis.fetch,
}) {
  const metadataBase = repositoryBaseUrl(metadataBaseUrl, 'metadataBaseUrl');
  const targetBase = repositoryBaseUrl(targetBaseUrl, 'targetBaseUrl');
  boundedInteger(timeoutMs, 'timeoutMs', { minimum: 1, maximum: 60_000 });
  boundedInteger(retries, 'retries', { maximum: 4 });
  boundedInteger(maxRootRotations, 'maxRootRotations', { minimum: 1, maximum: 64 });
  boundedInteger(maxDelegations, 'maxDelegations', { minimum: 1, maximum: 64 });
  if (typeof fetchImpl !== 'function') {
    managedPolicyRefuse('MANAGED_POLICY_TUF_CONFIG', 'fetchImpl must be a fetch-compatible function');
  }

  const loaded = await loadManagedPolicyProfile({ storeRoot, profile });
  const resolvedStore = path.resolve(storeRoot);
  await assertAuthoritativeDirectory(resolvedStore, 'managed-policy store root');
  const workspace = await fs.mkdtemp(path.join(resolvedStore, `.tuf-${profile}-`));
  await fs.chmod(workspace, 0o700);
  const cacheDirectory = path.join(workspace, 'cache');
  const temporaryDirectory = path.join(workspace, 'transport');
  const stagedDirectory = path.join(workspace, 'generation');
  const stagedMetadata = path.join(stagedDirectory, 'metadata');
  try {
    await fs.mkdir(cacheDirectory, { mode: 0o700 });
    await fs.mkdir(temporaryDirectory, { mode: 0o700 });
    await fs.mkdir(stagedDirectory, { mode: 0o700 });
    await fs.mkdir(stagedMetadata, { mode: 0o700 });
    await seedMetadataCache(loaded, cacheDirectory);

    const fetcher = new BoundedTufFetcher({
      metadataBase, targetBase, fetchImpl, timeoutMs, retries, temporaryDirectory,
    });
    const updater = new Updater({
      metadataDir: cacheDirectory,
      metadataBaseUrl: metadataBase.href,
      targetDir: stagedDirectory,
      targetBaseUrl: targetBase.href,
      fetcher,
      config: {
        maxRootRotations,
        maxDelegations,
        rootMaxLength: MAX_METADATA_FILE_BYTES,
        timestampMaxLength: MAX_METADATA_FILE_BYTES,
        snapshotMaxLength: MAX_METADATA_FILE_BYTES,
        targetsMaxLength: MAX_METADATA_FILE_BYTES,
        fetchTimeout: timeoutMs,
        fetchRetries: retries,
        prefixTargetsWithHash: false,
        userAgent: 'holt-managed-policy',
      },
    });

    let targetInfo;
    try {
      await updater.refresh();
      targetInfo = await updater.getTargetInfo('policy.json');
      assertSignedTarget(targetInfo);
      await updater.downloadTarget(targetInfo, path.join(stagedDirectory, 'policy.json'));
    } catch (error) {
      if (error instanceof ManagedPolicyError) throw error;
      throw tufError('MANAGED_POLICY_TUF_VERIFICATION', `TUF refresh refused: ${error.message}`, error);
    }

    const policyBytes = await secureRead(
      path.join(stagedDirectory, 'policy.json'), 'verified policy.json', MAX_MANAGED_POLICY_BYTES,
    );
    if (policyBytes.length !== targetInfo.length || sha256(policyBytes) !== targetInfo.hashes.sha256) {
      managedPolicyRefuse('MANAGED_POLICY_TUF_TARGET', 'downloaded policy bytes do not match signed target metadata');
    }
    const policy = parseManagedPolicy(policyBytes, 'verified policy.json');
    if (policy.profile !== profile) {
      managedPolicyRefuse('MANAGED_POLICY_PROFILE', `verified policy names profile '${policy.profile}', expected '${profile}'`);
    }

    // tuf-js deliberately keeps the verified role store private. Its public API does not expose
    // receipt versions/expiries, so read the runtime field reflectively after refresh solely to
    // bind the activation receipt to the metadata the real Updater accepted.
    const trustedSet = Reflect.get(updater, 'trustedSet');
    const authorizing = findAuthorizingRole(trustedSet, targetInfo);
    const metadata = await stageTrustedMetadata(trustedSet, cacheDirectory, stagedMetadata);
    const referenceTime = trustedSet.referenceTime;
    const roles = {
      root: trustedSet.root,
      timestamp: trustedSet.timestamp,
      snapshot: trustedSet.snapshot,
      targets: authorizing.metadata,
    };
    for (const [role, value] of Object.entries(roles)) {
      if (!value?.signed || value.signed.isExpired(referenceTime)) {
        managedPolicyRefuse('MANAGED_POLICY_TUF_EXPIRED', `verified ${role} metadata is expired`);
      }
    }
    const verification = {
      version: MANAGED_POLICY_VERSION,
      profile,
      target: { path: 'policy.json', sha256: sha256(policyBytes), length: policyBytes.length },
      rootSha256: loaded.trust.rootSha256,
      versions: {
        root: roles.root.signed.version,
        timestamp: roles.timestamp.signed.version,
        snapshot: roles.snapshot.signed.version,
        targets: roles.targets.signed.version,
      },
      metadata,
      verifiedAt: referenceTime.toISOString(),
      expires: {
        timestamp: roles.timestamp.signed.expires,
        snapshot: roles.snapshot.signed.expires,
        targets: roles.targets.signed.expires,
      },
    };

    const activated = await activateStagedManagedPolicy({
      storeRoot,
      profile,
      stagedDirectory,
      verification,
    });
    return {
      ...activated,
      changed: activated.previousGeneration !== activated.generation,
      authentication: 'tuf-js/6.0.0',
      verifier: { implementation: 'tuf-js', version: '6.0.0', authorizingRole: authorizing.name },
      verification,
      transport: {
        metadataResponses: fetcher.metadataResponses,
        metadataBytes: fetcher.metadataBytes,
        requestAttempts: fetcher.requestAttempts,
      },
    };
  } finally {
    // Cleanup failure is itself a security-relevant failure: never report a clean sync while
    // verifier-owned network/cache bytes remain beside the authoritative store.
    await fs.rm(workspace, { recursive: true, force: true });
  }
}
