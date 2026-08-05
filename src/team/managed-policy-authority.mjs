// SPDX-License-Identifier: LicenseRef-holt-Commercial
// Commercial license — see src/team/LICENSE. NOT covered by the repository FSL-1.1-MIT grant.
/**
 * Authority and additive evaluation for customer-controlled managed policy.
 *
 * This module accepts repository identity only as an explicit binding created by an administrator,
 * trusted CI integration, or an explicitly labelled user enrollment. It never reads repository
 * files, git config, process.env, or the network to discover identity.
 */

import { evaluatePolicyAuthoritySources } from './policy.mjs';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { loadManagedPolicyProfile } from './managed-policy-store.mjs';
import {
  assertRepositoryIdentity,
  managedPolicyRefuse,
} from './managed-policy-schema.mjs';

const BINDING_SOURCES = new Set(['system-enrollment', 'user-enrollment']);
const LAYER_ID_RE = /^[a-z][a-z0-9._-]{0,63}$/u;
const ISSUED_BINDINGS = new WeakSet();
const MAX_EXPIRY_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 60 * 60 * 1000;
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const DIRECTORY = fsConstants.O_DIRECTORY ?? 0;
const SYSTEM_BINDING_KEYS = new Set([
  'version', 'identity', 'source', 'profile', 'rootSha256', 'realRoot', 'device', 'inode',
]);
const USER_BINDING_KEYS = new Set(['version', 'identity', 'source']);

async function snapshotSystemRepositoryRoot(repositoryRoot) {
  if (typeof repositoryRoot !== 'string' || !repositoryRoot || repositoryRoot.includes('\0')) {
    managedPolicyRefuse('MANAGED_POLICY_IDENTITY_SOURCE', 'system repository root is required');
  }
  const candidate = path.resolve(repositoryRoot);
  let handle;
  try {
    handle = await fs.open(candidate, fsConstants.O_RDONLY | DIRECTORY | NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!before.isDirectory()) {
      managedPolicyRefuse('MANAGED_POLICY_IDENTITY_SOURCE', 'system repository root must be a directory');
    }
    const [realRoot, pathStat] = await Promise.all([
      fs.realpath(candidate),
      fs.lstat(candidate, { bigint: true }),
    ]);
    const after = await handle.stat({ bigint: true });
    if (pathStat.isSymbolicLink() || !pathStat.isDirectory()
      || before.dev !== after.dev || before.ino !== after.ino
      || before.dev !== pathStat.dev || before.ino !== pathStat.ino) {
      managedPolicyRefuse(
        'MANAGED_POLICY_IDENTITY_SOURCE',
        'system repository root changed while its identity was being measured',
      );
    }
    return Object.freeze({
      realRoot,
      device: String(after.dev),
      inode: String(after.ino),
    });
  } catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('MANAGED_POLICY_')) throw error;
    managedPolicyRefuse(
      'MANAGED_POLICY_IDENTITY_SOURCE',
      `system repository root is unavailable or changed during identity measurement (${error?.code ?? 'filesystem error'})`,
    );
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Create the only repository-identity value accepted by the authority loader.
 * The source is evidence provenance, not a caller-controlled display string.
 */
export function repositoryIdentityBinding({ identity, source }) {
  assertRepositoryIdentity(identity);
  if (source !== 'user-enrollment') {
    managedPolicyRefuse(
      'MANAGED_POLICY_IDENTITY_SOURCE',
      "public repository identity bindings are user-enrollment only; system identity must come from the system-owned binding adapter",
    );
  }
  const binding = Object.freeze({ version: 1, identity, source });
  ISSUED_BINDINGS.add(binding);
  return binding;
}

/**
 * Resolve a system binding only from root-owned trust.json plus the directory's device/inode.
 *
 * The absolute real path is the administrator's targeting boundary. A different path is therefore
 * not targeted by this profile. The same path naming a different inode is categorically different:
 * it is a replaced enrolled workspace and must refuse, never fall through to weaker CI policy.
 */
export async function systemRepositoryIdentityBinding({
  storeRoot,
  profile,
  repositoryRoot,
}) {
  const loaded = await loadManagedPolicyProfile({ storeRoot, profile });
  if (loaded.trust.authority !== 'system') {
    managedPolicyRefuse('MANAGED_POLICY_AUTHORITY', `profile '${profile}' is not system-enrolled`);
  }
  const snapshot = await snapshotSystemRepositoryRoot(repositoryRoot);
  const targeted = loaded.trust.repositoryBindings.find((entry) => entry.root === snapshot.realRoot);
  if (!targeted) {
    managedPolicyRefuse(
      'MANAGED_POLICY_NOT_TARGETED',
      `repository root '${snapshot.realRoot}' is outside system profile '${profile}'s enrolled workspace paths`,
    );
  }
  if (targeted.device !== snapshot.device || targeted.inode !== snapshot.inode) {
    managedPolicyRefuse(
      'MANAGED_POLICY_IDENTITY_MISMATCH',
      `repository root '${snapshot.realRoot}' no longer names the directory inode enrolled by system profile '${profile}'`,
    );
  }
  const binding = Object.freeze({
    version: 1,
    identity: targeted.identity,
    source: 'system-enrollment',
    profile,
    rootSha256: loaded.trust.rootSha256,
    realRoot: snapshot.realRoot,
    device: snapshot.device,
    inode: snapshot.inode,
  });
  ISSUED_BINDINGS.add(binding);
  return binding;
}

function validateBinding(binding) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding) || !ISSUED_BINDINGS.has(binding)) {
    managedPolicyRefuse('MANAGED_POLICY_IDENTITY_SOURCE', 'an explicit repository identity binding is required');
  }
  const expectedKeys = binding.source === 'system-enrollment' ? SYSTEM_BINDING_KEYS : USER_BINDING_KEYS;
  const keys = Object.keys(binding);
  if (keys.length !== expectedKeys.size || keys.some((key) => !expectedKeys.has(key)) || binding.version !== 1) {
    managedPolicyRefuse('MANAGED_POLICY_IDENTITY_SOURCE', 'repository identity binding is malformed');
  }
  assertRepositoryIdentity(binding.identity);
  if (!BINDING_SOURCES.has(binding.source)) {
    managedPolicyRefuse('MANAGED_POLICY_IDENTITY_SOURCE', 'repository identity binding source is invalid');
  }
  if (binding.source === 'system-enrollment') {
    if (typeof binding.profile !== 'string' || !binding.profile
      || typeof binding.rootSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(binding.rootSha256)
      || typeof binding.realRoot !== 'string' || !path.isAbsolute(binding.realRoot)
      || typeof binding.device !== 'string' || !/^\d+$/u.test(binding.device)
      || typeof binding.inode !== 'string' || !/^\d+$/u.test(binding.inode)) {
      managedPolicyRefuse('MANAGED_POLICY_IDENTITY_SOURCE', 'system repository identity evidence is malformed');
    }
  }
  return binding;
}

/** Re-measure the exact path and require it still names the issued system directory inode. */
export async function revalidateSystemRepositoryIdentityBinding(repositoryBinding) {
  const binding = validateBinding(repositoryBinding);
  if (binding.source !== 'system-enrollment') {
    managedPolicyRefuse('MANAGED_POLICY_IDENTITY_SOURCE', 'system repository identity revalidation requires a system binding');
  }
  const current = await snapshotSystemRepositoryRoot(binding.realRoot);
  if (current.realRoot !== binding.realRoot
    || current.device !== binding.device || current.inode !== binding.inode) {
    managedPolicyRefuse(
      'MANAGED_POLICY_IDENTITY_MISMATCH',
      `repository root '${binding.realRoot}' no longer names the system-enrolled directory inode`,
    );
  }
  return Object.freeze({
    realRoot: binding.realRoot,
    device: binding.device,
    inode: binding.inode,
  });
}

/** Final async identity boundary for callers immediately before publishing an enforcement verdict. */
export async function revalidateManagedPolicyAuthority(authority) {
  if (!authority || typeof authority !== 'object' || Array.isArray(authority)) {
    managedPolicyRefuse('MANAGED_POLICY_AUTHORITY', 'resolved managed-policy authority is required');
  }
  const binding = validateBinding(authority.binding);
  if (binding.source !== 'system-enrollment') return null;
  if (authority.profile !== binding.profile || authority.rootSha256 !== binding.rootSha256) {
    managedPolicyRefuse('MANAGED_POLICY_IDENTITY_SOURCE', 'resolved authority is not bound to its issued system identity evidence');
  }
  return revalidateSystemRepositoryIdentityBinding(binding);
}

function boundedMilliseconds(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    managedPolicyRefuse('MANAGED_POLICY_FRESHNESS_CONFIG', `${label} must be an integer from 0 through ${maximum}`);
  }
  return value;
}

function validateFreshness(activation, { now, expiryGraceMs, clockSkewToleranceMs }) {
  if (!Number.isSafeInteger(now) || now < 0) {
    managedPolicyRefuse('MANAGED_POLICY_FRESHNESS_CONFIG', 'now must be a non-negative epoch-millisecond integer');
  }
  boundedMilliseconds(expiryGraceMs, 'expiryGraceMs', MAX_EXPIRY_GRACE_MS);
  boundedMilliseconds(clockSkewToleranceMs, 'clockSkewToleranceMs', MAX_CLOCK_SKEW_MS);
  const verifiedMs = Date.parse(activation.verifiedAt);
  if (verifiedMs > now + clockSkewToleranceMs) {
    managedPolicyRefuse(
      'MANAGED_POLICY_FUTURE_VERIFICATION',
      `active policy verification time ${activation.verifiedAt} is ahead of the trusted clock`,
    );
  }
  const roleExpiries = Object.entries(activation.expires)
    .map(([role, timestamp]) => ({ role, timestamp, milliseconds: Date.parse(timestamp) }));
  roleExpiries.sort((left, right) => left.milliseconds - right.milliseconds || left.role.localeCompare(right.role));
  const earliest = roleExpiries[0];
  if (now >= earliest.milliseconds + expiryGraceMs) {
    managedPolicyRefuse(
      'MANAGED_POLICY_EXPIRED',
      `active ${earliest.role} metadata expired at ${earliest.timestamp}; offline authority refuses stale policy`,
    );
  }
  return {
    verifiedAt: activation.verifiedAt,
    expires: { ...activation.expires },
    earliestRole: earliest.role,
    earliestExpiry: earliest.timestamp,
    remainingMs: earliest.milliseconds + expiryGraceMs - now,
    expiryGraceMs,
    clockSkewToleranceMs,
  };
}

/**
 * Resolve exactly one profile and exact repository assignment from the active generation.
 * A missing/corrupt active pointer throws in the store; this function never scans generations.
 */
export async function resolveManagedPolicyAuthority({
  storeRoot,
  profile,
  repositoryBinding,
  expectedAuthority = null,
  now = Date.now(),
  expiryGraceMs = 0,
  clockSkewToleranceMs = 5 * 60 * 1000,
}) {
  const binding = validateBinding(repositoryBinding);
  if (binding.source === 'system-enrollment') {
    await revalidateSystemRepositoryIdentityBinding(binding);
  }
  const loaded = await loadManagedPolicyProfile({ storeRoot, profile });
  if (!loaded.active || !loaded.policy || !loaded.generation) {
    managedPolicyRefuse(
      'MANAGED_POLICY_NOT_ACTIVE',
      `managed-policy profile '${profile}' is enrolled but has no active generation`,
    );
  }
  if (expectedAuthority !== null && loaded.trust.authority !== expectedAuthority) {
    managedPolicyRefuse(
      'MANAGED_POLICY_AUTHORITY',
      `profile '${profile}' is enrolled as '${loaded.trust.authority}', expected '${expectedAuthority}'`,
    );
  }
  if (binding.source !== `${loaded.trust.authority}-enrollment`) {
    managedPolicyRefuse(
      'MANAGED_POLICY_IDENTITY_SOURCE',
      `${loaded.trust.authority} profile '${profile}' requires a matching ${loaded.trust.authority}-enrollment identity binding`,
    );
  }
  if (binding.source === 'system-enrollment') {
    if (binding.profile !== profile || binding.rootSha256 !== loaded.trust.rootSha256) {
      managedPolicyRefuse(
        'MANAGED_POLICY_IDENTITY_SOURCE',
        `system identity binding was issued by a different managed-policy profile or trust root`,
      );
    }
    const enrolled = loaded.trust.repositoryBindings.find((entry) => entry.identity === binding.identity
      && entry.root === binding.realRoot && entry.device === binding.device && entry.inode === binding.inode);
    if (!enrolled) {
      managedPolicyRefuse(
        'MANAGED_POLICY_IDENTITY_SOURCE',
        `system identity binding no longer matches profile '${profile}' enrollment evidence`,
      );
    }
    // Detect a persistent replacement that happened while the authoritative profile was loaded.
    await revalidateSystemRepositoryIdentityBinding(binding);
  }
  const freshness = validateFreshness(loaded.generation.activation, {
    now, expiryGraceMs, clockSkewToleranceMs,
  });

  const assignment = loaded.policy.assignments.find((item) => item.repository === binding.identity) ?? null;
  if (!assignment) {
    return {
      profile,
      authority: loaded.trust.authority,
      binding,
      generation: loaded.active.generation,
      rootSha256: loaded.trust.rootSha256,
      claimed: false,
      mandatory: false,
      freshness,
      policies: [],
      note: `active profile '${profile}' does not claim repository '${binding.identity}'`,
    };
  }

  const definitions = new Map(loaded.policy.policies.map((entry) => [entry.id, entry.policy]));
  const policies = assignment.policies.map((id) => {
    const policy = definitions.get(id);
    if (!policy) {
      // Schema validation already guarantees this. Keep the check at the authority boundary so a
      // mutated in-memory object cannot turn a missing mandatory policy into an empty set.
      managedPolicyRefuse('MANAGED_POLICY_CORRUPT', `assignment references missing policy '${id}'`);
    }
    return { id, namespace: `managed:${profile}:${id}`, policy };
  });
  return {
    profile,
    authority: loaded.trust.authority,
    binding,
    generation: loaded.active.generation,
    rootSha256: loaded.trust.rootSha256,
    claimed: true,
    mandatory: loaded.trust.authority === 'system',
    freshness,
    policies,
    note: loaded.trust.authority === 'system'
      ? `system-managed profile '${profile}' claims this repository; every managed rule is mandatory`
      : `user-managed profile '${profile}' claims this repository; enforcement is active but labelled user authority`,
  };
}

function normalizeLayer(layer, entries) {
  if (!Array.isArray(entries)) {
    managedPolicyRefuse('MANAGED_POLICY_LAYERS', `${layer} policies must be an array`);
  }
  const seen = new Set();
  return entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      managedPolicyRefuse('MANAGED_POLICY_LAYERS', `${layer} policy ${index} must be an object`);
    }
    const unknown = Object.keys(entry).filter((key) => key !== 'id' && key !== 'policy');
    if (unknown.length || typeof entry.id !== 'string' || !LAYER_ID_RE.test(entry.id)) {
      managedPolicyRefuse('MANAGED_POLICY_LAYERS', `${layer} policy ${index} needs only a canonical id and policy`);
    }
    if (seen.has(entry.id)) managedPolicyRefuse('MANAGED_POLICY_LAYERS', `${layer} repeats policy id '${entry.id}'`);
    seen.add(entry.id);
    return { namespace: `${layer}:${entry.id}`, policy: entry.policy };
  });
}

function requireCompleteManagedEvidence(audit, report) {
  if (!audit || typeof audit !== 'object' || Array.isArray(audit)
    || !Array.isArray(audit.unlanded) || !Array.isArray(audit.unknown)) {
    managedPolicyRefuse(
      'MANAGED_POLICY_EVIDENCE',
      'managed policy requires an audit with explicit unlanded[] and unknown[] evidence',
    );
  }
  if (!report || typeof report !== 'object' || Array.isArray(report) || !Array.isArray(report.unique)) {
    managedPolicyRefuse(
      'MANAGED_POLICY_EVIDENCE',
      'managed policy requires an explicit workstream report with unique[] evidence',
    );
  }
  for (let i = 0; i < audit.unlanded.length; i++) {
    const branch = audit.unlanded[i];
    if (!branch || typeof branch !== 'object' || Array.isArray(branch)
      || typeof branch.name !== 'string' || !branch.name
      || !Number.isSafeInteger(branch.fileCount) || branch.fileCount < 0) {
      managedPolicyRefuse('MANAGED_POLICY_EVIDENCE', `audit.unlanded[${i}] is incomplete`);
    }
  }
  for (let i = 0; i < audit.unknown.length; i++) {
    const branch = audit.unknown[i];
    if (!branch || typeof branch !== 'object' || Array.isArray(branch)
      || typeof branch.name !== 'string' || !branch.name || typeof branch.reason !== 'string' || !branch.reason) {
      managedPolicyRefuse('MANAGED_POLICY_EVIDENCE', `audit.unknown[${i}] is incomplete`);
    }
  }
}

function combineAdditiveResults(first, second) {
  const violations = [...first.violations, ...second.violations];
  const errors = violations.filter((entry) => entry.severity === 'error').length;
  return {
    ok: errors === 0,
    violations,
    errors,
    warnings: violations.length - errors,
    exempted: [...first.exempted, ...second.exempted],
    rulesEvaluated: [...first.rulesEvaluated, ...second.rulesEvaluated],
    disabledRules: [...first.disabledRules, ...second.disabledRules],
    sourceResults: [...first.sourceResults, ...second.sourceResults],
    additive: true,
  };
}

/**
 * Evaluate managed, reviewed-base, candidate, and inline constraints additively.
 * Ordering is deterministic for explanation only; it grants no source override semantics.
 */
export function evaluateManagedPolicyAuthority({
  authority,
  basePolicies = [],
  candidatePolicies = [],
  inlineFailures = [],
  audit,
  report = null,
  ignore = [],
}) {
  if (!authority || typeof authority !== 'object' || Array.isArray(authority)) {
    managedPolicyRefuse('MANAGED_POLICY_AUTHORITY', 'resolved managed-policy authority is required');
  }
  if (authority.claimed === true && (!Array.isArray(authority.policies) || authority.policies.length === 0)) {
    managedPolicyRefuse('MANAGED_POLICY_CORRUPT', 'a profile that claims this repository has no policies');
  }
  const managed = (authority.policies ?? []).map((entry) => ({ namespace: entry.namespace, policy: entry.policy }));
  if (authority.claimed === true) requireCompleteManagedEvidence(audit, report);
  const lowerSources = [
    ...normalizeLayer('base', basePolicies),
    ...normalizeLayer('candidate', candidatePolicies),
  ];
  // Candidate/user ignore lists are intentionally absent from the managed call. A centrally
  // assigned rule cannot be suppressed by the repository it judges.
  const { managedResult, lowerResult } = evaluatePolicyAuthoritySources({
    managedSources: managed,
    lowerSources,
    audit,
    report,
    lowerIgnore: ignore,
    inlineFailures,
  });
  const result = combineAdditiveResults(managedResult, lowerResult);
  return {
    ...result,
    managed: {
      profile: authority.profile ?? null,
      authority: authority.authority ?? null,
      repository: authority.binding?.identity ?? null,
      identitySource: authority.binding?.source ?? null,
      generation: authority.generation ?? null,
      claimed: authority.claimed === true,
      mandatory: authority.mandatory === true,
      policies: managed.map((entry) => entry.namespace),
    },
    additiveOrder: ['managed', 'base', 'candidate', 'inline'],
    note: 'all layers are additive; no lower layer can suppress a managed, base, candidate, or inline failure',
  };
}
