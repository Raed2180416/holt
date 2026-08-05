// SPDX-License-Identifier: LicenseRef-holt-Commercial
// @ts-nocheck -- boundary adapter deliberately preserves exact core error payloads.
/**
 * User-facing orchestration for managed policy.
 *
 * This module deliberately does not import the TUF adapter. `sync` loads it at the
 * one explicit network call site; status and CI remain offline.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { checkEntitlement } from '../license.mjs';
import { samePathAsync } from '../paths.mjs';
import {
  enrollManagedPolicyProfile,
  inspectManagedPolicyRecovery,
  loadManagedPolicyProfile,
  readManagedPolicyStatus,
  recoverManagedPolicyActivation,
} from './managed-policy-store.mjs';
import {
  evaluateManagedPolicyAuthority,
  revalidateManagedPolicyAuthority,
  revalidateSystemRepositoryIdentityBinding,
  resolveManagedPolicyAuthority,
  systemRepositoryIdentityBinding,
} from './managed-policy-authority.mjs';
import { assertProfileName, ManagedPolicyError } from './managed-policy-schema.mjs';

export const SYSTEM_MANAGED_POLICY_STORE = process.platform === 'win32'
  ? null
  : '/etc/holt/managed-policy';

export class ManagedPolicyCliError extends Error {
  constructor(code, message, extra = null) {
    super(message);
    this.name = 'ManagedPolicyCliError';
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

const refuse = (code, message, extra = null) => { throw new ManagedPolicyCliError(code, message, extra); };

export function userManagedPolicyStore({ env = process.env, home = os.homedir() } = {}) {
  const config = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(config, 'holt', 'managed-policy');
}

/** There is intentionally no user-selectable system-store override. */
export async function managedPolicyStore({ authority, store = null, env = process.env } = {}) {
  if (authority !== 'system' && authority !== 'user') {
    refuse('MANAGED_POLICY_CLI_ARGUMENT', "--authority must be exactly 'system' or 'user'");
  }
  if (authority === 'user') {
    if (typeof store === 'string' && store) return path.resolve(store);
    return userManagedPolicyStore({ env });
  }
  if (process.platform === 'win32' || !SYSTEM_MANAGED_POLICY_STORE) {
    refuse('MANAGED_POLICY_AUTHORITY_UNSUPPORTED',
      'system-authoritative managed policy is unavailable on Windows because this build has no ACL verifier');
  }
  const fixed = path.resolve(SYSTEM_MANAGED_POLICY_STORE);
  if (store !== null && store !== undefined && !(await samePathAsync(store, fixed))) {
    refuse('MANAGED_POLICY_SYSTEM_STORE',
      `system authority is anchored to ${fixed}; a custom --store is user authority only`);
  }
  return fixed;
}

function required(value, flag) {
  if (typeof value !== 'string' || !value.trim()) refuse('MANAGED_POLICY_CLI_ARGUMENT', `${flag} is required`);
  return value;
}

function profileOf(opts) {
  const profile = required(opts.profile, '--profile');
  assertProfileName(profile, '--profile');
  return profile;
}

function authorityOf(opts) {
  return required(opts.authority, '--authority');
}

function entitlement() {
  const ent = checkEntitlement('managed-policy');
  if (!ent.entitled) {
    refuse('MANAGED_POLICY_UNLICENSED', ent.reason, { entitlement: ent });
  }
  return ent;
}

function requireSystemAdministrator(authority, action) {
  if (authority !== 'system' || action === 'status') return;
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
    refuse(
      'MANAGED_POLICY_OWNER',
      `managed-policy ${action} for system authority must run as uid 0; ordinary CI and status remain read-only and do not need elevation`,
    );
  }
}

function repositoryBindings(opts, authority) {
  const identity = opts.repository;
  if (!identity && authority === 'user') return [];
  const root = required(opts.repositoryRoot, '--repository-root');
  return [{ root, identity: required(identity, '--repository') }];
}

function profileSummary({ profile, storeRoot, loaded, recovery, status, authority = loaded?.trust?.authority ?? null }) {
  const activation = loaded?.generation?.activation ?? null;
  return {
    profile,
    store: storeRoot,
    authority: authority === 'system' ? 'system (machine authority)' : 'user (non-system authority)',
    authorityKind: authority,
    rootFingerprint: loaded?.trust?.rootSha256 ?? null,
    generation: loaded?.active?.generation ?? null,
    freshness: activation ? {
      verifiedAt: activation.verifiedAt,
      earliestExpiry: Object.entries(activation.expires ?? {})
        .sort((a, b) => String(a[1]).localeCompare(String(b[1])))[0]?.[1] ?? null,
      expires: activation.expires ?? {},
    } : null,
    policyProvenance: loaded?.active ? {
      targetSha256: loaded.active.targetSha256,
      rootSha256: loaded.active.rootSha256,
      metadata: loaded.active.versions ?? {},
    } : null,
    recovery,
    lastGoodStatus: status,
  };
}

export async function managedPolicyCommand(action, opts = {}) {
  if (!['enroll', 'sync', 'status', 'recover'].includes(action)) {
    refuse('MANAGED_POLICY_CLI_ARGUMENT', "managed-policy requires one of: enroll, sync, status, recover");
  }
  const authority = authorityOf(opts);
  const profile = profileOf(opts);
  const storeRoot = await managedPolicyStore({ authority, store: opts.store, env: opts.env });
  const ent = entitlement();
  requireSystemAdministrator(authority, action);

  if (action === 'enroll') {
    if (authority === 'system') {
      const existing = await systemProfileNames(storeRoot);
      if (existing?.length && !existing.includes(profile)) {
        refuse(
          'MANAGED_POLICY_AMBIGUOUS',
          `system profile '${existing[0]}' already occupies this single-purpose runner; shared multi-profile enrollment is unsupported`,
        );
      }
    }
    const bootstrapRootPath = required(opts.bootstrapRoot, '--bootstrap-root');
    const bootstrapRoot = await fs.readFile(bootstrapRootPath);
    const result = await enrollManagedPolicyProfile({
      storeRoot, profile, authority, bootstrapRoot,
      repositoryBindings: repositoryBindings(opts, authority),
    });
    return { ok: true, action, entitlement: ent, ...result, authority: authority === 'system' ? 'system (machine authority)' : 'user (non-system authority)' };
  }
  if (action === 'sync') {
    const metadataBaseUrl = required(opts.metadataUrl, '--metadata-url');
    const targetBaseUrl = required(opts.targetsUrl, '--targets-url');
    // This is the sole dynamic TUF import and sole network path in this surface.
    const { syncManagedPolicyFromTuf } = await import('./managed-policy-tuf.mjs');
    const result = await syncManagedPolicyFromTuf({ storeRoot, profile, metadataBaseUrl, targetBaseUrl });
    return { ok: true, action, entitlement: ent, authority: authority === 'system' ? 'system (machine authority)' : 'user (non-system authority)', ...result };
  }
  if (action === 'status') {
    // Inspect recovery before the normal loader: an interrupted transition is intentionally
    // rejected by authority loading, but status must still show the exact recovery receipt.
    const recovery = await inspectManagedPolicyRecovery({ storeRoot, profile });
    let status = null;
    try { status = await readManagedPolicyStatus({ storeRoot, profile }); } catch (error) {
      if (!recovery.recoveryRequired) throw error;
    }
    if (recovery.recoveryRequired) {
      return {
        ok: true, action, entitlement: ent, profile, store: storeRoot,
        authority: authority === 'system' ? 'system (machine authority)' : 'user (non-system authority)',
        authorityKind: authority, recovery, lastGoodStatus: status,
        reason: 'authority is not active while recovery is required; run managed-policy recover with the exact status receipt',
      };
    }
    const loaded = await loadManagedPolicyProfile({ storeRoot, profile });
    return { ok: true, action, entitlement: ent, ...profileSummary({ profile, storeRoot, loaded, recovery, status }) };
  }
  if (action === 'recover') {
    const mode = required(opts.recoveryMode, '--recovery-mode');
    const result = await recoverManagedPolicyActivation({
      storeRoot, profile, mode, lockToken: opts.lockToken ?? null, orphan: opts.orphan ?? null,
    });
    return { ok: true, action, entitlement: ent, authority: authority === 'system' ? 'system (machine authority)' : 'user (non-system authority)', ...result };
  }
}

async function systemProfileNames(storeRoot) {
  let root;
  try { root = await fs.lstat(storeRoot); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (root.isSymbolicLink() || !root.isDirectory()) {
    refuse('MANAGED_POLICY_LAYOUT', 'fixed system managed-policy store must be a non-symlink directory');
  }
  const profiles = path.join(storeRoot, 'profiles');
  let entries;
  try { entries = await fs.readdir(profiles, { withFileTypes: true }); } catch (error) {
    // A missing fixed store means no deployment. Once the fixed root exists, though, a missing
    // profiles directory is destructive/corrupt state, not an empty deployment to pass over.
    if (error?.code === 'ENOENT') {
      refuse('MANAGED_POLICY_STATE_MISSING', 'fixed system managed-policy store is missing its profiles directory');
    }
    throw error;
  }
  const names = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      refuse('MANAGED_POLICY_LAYOUT', `fixed system profiles contains unsafe entry '${entry.name}'`);
    }
    assertProfileName(entry.name, 'system profile name');
    names.push(entry.name);
  }
  return names.sort();
}

/** Offline CI discovery from the one fixed system authority location. */
/** Bind the exact system repository inode before any CI audit touches the checkout. */
export async function prepareSystemManagedPolicyForCi({ repositoryRoot } = {}) {
  if (process.platform === 'win32' || !SYSTEM_MANAGED_POLICY_STORE) return { present: false, claimed: false, authority: null };
  const fixedStore = path.resolve(SYSTEM_MANAGED_POLICY_STORE);
  const profiles = await systemProfileNames(fixedStore);
  if (profiles === null || profiles.length === 0) return { present: false, claimed: false, authority: null };
  if (profiles.length !== 1) {
    refuse(
      'MANAGED_POLICY_AMBIGUOUS',
      `the initial system-authority topology requires exactly one profile on a single-purpose runner; found ${profiles.length}: ${profiles.join(', ')}`,
    );
  }

  const candidates = [];
  for (const profile of profiles) {
    let loaded;
    try {
      loaded = await loadManagedPolicyProfile({ storeRoot: fixedStore, profile });
    } catch (error) {
      throw new ManagedPolicyCliError(error?.code ?? 'MANAGED_POLICY_CORRUPT',
        `fixed system profile '${profile}' could not be trusted: ${error?.message ?? error}`);
    }
    if (loaded.trust.authority !== 'system') {
      refuse('MANAGED_POLICY_AMBIGUOUS', `fixed system store contains non-system profile '${profile}'`);
    }
    const recovery = await inspectManagedPolicyRecovery({ storeRoot: fixedStore, profile });
    if (recovery.recoveryRequired) {
      refuse('MANAGED_POLICY_RECOVERY_REQUIRED',
        `system profile '${profile}' requires explicit recovery before CI can trust it`, { recovery });
    }
    // Once a system profile exists, this is a single-purpose runner. A different workspace is not
    // an ordinary untargeted repository: it is a deployment/path bypass and refuses. Supporting
    // shared multi-repository runners needs an authenticated assignment selector we do not ship.
    const binding = await systemRepositoryIdentityBinding({ storeRoot: fixedStore, profile, repositoryRoot });
    candidates.push({ profile, binding, recovery, storeRoot: fixedStore });
  }
  return { present: true, claimed: false, profiles, candidates, storeRoot: fixedStore };
}

/** Revalidate every exact binding after audit and immediately before authority resolution. */
export async function revalidatePreparedSystemManagedPolicyForCi(prepared) {
  for (const candidate of prepared?.candidates ?? []) {
    await revalidateSystemRepositoryIdentityBinding(candidate.binding);
  }
  return prepared;
}

/** Resolve prepared system bindings only after they have survived the audit boundary. */
export async function resolvePreparedSystemManagedPolicyForCi(prepared) {
  if (!prepared?.present) return { present: false, claimed: false, authority: null };
  if (!Array.isArray(prepared.candidates) || prepared.candidates.length !== 1) {
    refuse(
      prepared?.candidates?.length > 1 ? 'MANAGED_POLICY_AMBIGUOUS' : 'MANAGED_POLICY_NOT_TARGETED',
      'a present system-authority deployment must resolve exactly one enrolled workspace binding',
    );
  }
  const claims = [];
  for (const candidate of prepared.candidates ?? []) {
    const authority = await resolveManagedPolicyAuthority({
      storeRoot: candidate.storeRoot, profile: candidate.profile, repositoryBinding: candidate.binding,
      expectedAuthority: 'system',
    });
    const status = await readManagedPolicyStatus({
      storeRoot: candidate.storeRoot, profile: candidate.profile,
    });
    if (!authority.claimed) {
      refuse(
        'MANAGED_POLICY_ASSIGNMENT_MISSING',
        `system profile '${candidate.profile}' enrolls repository '${authority.binding.identity}' but its active signed policy has no assignment for that identity`,
      );
    }
    claims.push({ authority, status, recovery: candidate.recovery, storeRoot: candidate.storeRoot });
  }
  if (claims.length > 1) {
    refuse('MANAGED_POLICY_AMBIGUOUS', `multiple system profiles claim this exact repository: ${claims.map((x) => x.authority.profile).join(', ')}`);
  }
  if (claims.length === 0) return { present: true, claimed: false, authority: null, profiles: prepared.profiles };
  const claim = claims[0];
  const ent = checkEntitlement('managed-policy');
  if (!ent.entitled) refuse('MANAGED_POLICY_UNLICENSED', ent.reason, { entitlement: ent });
  return { present: true, claimed: true, profiles: prepared.profiles, entitlement: ent, ...claim };
}

/** Compatibility wrapper for callers that do not need the explicit audit boundary. */
export async function resolveSystemManagedPolicyForCi(opts = {}) {
  const prepared = await prepareSystemManagedPolicyForCi(opts);
  await revalidatePreparedSystemManagedPolicyForCi(prepared);
  return resolvePreparedSystemManagedPolicyForCi(prepared);
}

/** Final identity check immediately before publishing or acting on a system-policy verdict. */
export async function revalidateResolvedSystemManagedPolicyForCi(resolved) {
  if (resolved?.claimed) await revalidateManagedPolicyAuthority(resolved.authority);
  return resolved;
}

export function evaluateSystemManagedPolicyForCi({ resolved, audit, report, basePolicies = [], candidatePolicies = [], inlineFailures = [], ignore = [] } = {}) {
  if (!resolved?.claimed) return null;
  const result = evaluateManagedPolicyAuthority({
    authority: resolved.authority, audit, report, basePolicies, candidatePolicies, inlineFailures, ignore,
  });
  return {
    ...result,
    system: {
      authority: 'system (machine authority)',
      store: resolved.storeRoot,
      rootFingerprint: resolved.authority.rootSha256,
      generation: resolved.authority.generation,
      freshness: resolved.authority.freshness,
      policyProvenance: resolved.authority.policies.map((entry) => entry.namespace),
      recovery: resolved.recovery,
      lastGoodStatus: resolved.status,
    },
  };
}

export { ManagedPolicyError };
