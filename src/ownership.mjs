// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — cooperative live ownership for a worktree.
 *
 * Content evidence answers "would removing these bytes lose work?"  It cannot answer whether a
 * clean-looking worktree is currently being edited in an unsaved buffer, because there are no
 * bytes to inspect yet.  This module carries that separate fact as an explicit, local lease.
 *
 * A lease is deliberately NOT process discovery, a timestamp guess, or a claim that Holt can
 * tell whether an arbitrary agent is alive.  An agent has to claim before it starts work and
 * renew while it works.  An active lease blocks cleanup even when every content probe is clean.
 * An expired or malformed lease is not evidence of abandonment: it remains a hard review block
 * until its owner releases it or someone explicitly takes it over with a recorded reason.
 *
 * Records live below Git's common directory, so linked worktrees share them and neither a record
 * nor its lock appears in `git status`.  The worktree key derives from its private Git directory,
 * not its display id: ids can be disambiguated for presentation and paths can be moved, while the
 * private Git directory is the worktree identity Git itself maintains.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { git, repoIdentity } from './git.mjs';
import { ensurePrivateDirectory, readStableRegularFile, writePrivateFileAtomic, syncPrivateDirectory } from './stable-file.mjs';
import { appendEvent } from './journal.mjs';
import { canonicalPath, relativeWithinAsync } from './paths.mjs';
import {
  SESSION_RECORD_VERSION, SESSION_LIMIT, SESSION_MAX_BYTES, validSession, createSession,
  authenticSession, publicSession, applySessionEvent, rotateSession, sessionEventHash,
} from './sessions.mjs';
import { readBufferSnapshot } from './session-buffers.mjs';

export const OWNERSHIP_VERSION = 1;
export const DEFAULT_LEASE_SECONDS = 15 * 60;
export const MIN_LEASE_SECONDS = 60;
export const MAX_LEASE_SECONDS = 24 * 60 * 60;

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const OWNER_MAX = 256;
const NATIVE_LOCK_PREFIX = 'holt: live ownership lease ';

/**
 * @typedef {object} LeaseRecord
 * @property {number} version
 * @property {string} worktreeKey
 * @property {string} owner
 * @property {string} claimedAt
 * @property {string} heartbeatAt
 * @property {string} expiresAt
 * @property {string|null} nativeLockToken
 * @property {{manual:boolean,sessions:import('./sessions.mjs').SessionRecord[]}} [managed]
 *
 * @typedef {object} OwnershipEvidence
 * @property {string} state
 * @property {string} [owner]
 * @property {string} [claimedAt]
 * @property {string} [heartbeatAt]
 * @property {string} [expiresAt]
 * @property {string} [reason]
 * @property {ReturnType<typeof publicSession>[]} [sessions]
 * @property {boolean} [manual]
 * @property {string} [worktreeKey]
 * @property {LeaseRecord} [_record]
 */

/** A content-protection command must not release a session's separate native lock. */
export function isOwnershipGitLock(reason) {
  return typeof reason === 'string' && reason.startsWith(NATIVE_LOCK_PREFIX);
}

/** Ownership is a reason to defer landing, never evidence that work is ready to merge. */
export function ownershipLandingReason(ownership) {
  if (!ownership?.state || ownership.state === 'unclaimed') return null;
  if (ownership.sessions?.length) return `${ownership.sessions.length} session attachment(s) still use this writable worktree; finish them before landing the workspace`;
  return ownership.state === 'active'
    ? `session ${ownership.owner} still owns this worktree; wait for its owner to release it before landing`
    : `ownership is ${ownership.state}; resolve the session claim before landing`;
}

function ownershipRoot(commonDir) {
  return path.join(commonDir, 'holt-ownership-v1');
}

function recordPath(target) {
  return path.join(target.root, 'records', `${target.key}.json`);
}

function lockPath(target) {
  return path.join(target.root, 'locks', `${target.key}.sqlite`);
}

function keyFor(gitDirRelative) {
  return createHash('sha256')
    // The private Git directory's relative path is Git's durable identity for this worktree.
    // Absolute paths would silently turn an active lease into "unclaimed" when a repository is
    // moved as a unit, even though its common directory and worktree administration moved with it.
    .update('holt-ownership-v1\0').update(gitDirRelative.split(path.sep).join('/'))
    .digest('hex');
}

/** @param {unknown} owner @returns {owner is string} */
function validOwner(owner) {
  return typeof owner === 'string' && owner.length > 0 && owner.length <= OWNER_MAX && !CONTROL.test(owner);
}

function validInstant(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/** @param {string} state @param {LeaseRecord|null} [record] @param {string|null} [reason] @returns {OwnershipEvidence} */
function publicLease(state, record = null, reason = null, now = Date.now()) {
  if (!record) return reason ? { state, reason } : { state };
  const sessions = record.managed?.sessions ?? [];
  const automatic = record.managed && !record.managed.manual && sessions.length;
  return {
    state,
    worktreeKey: record.worktreeKey,
    owner: automatic ? sessions.slice(0, 3).map((session) => session.label).join(', ') + (sessions.length > 3 ? ` and ${sessions.length - 3} more` : '') : record.owner,
    claimedAt: automatic ? sessions.map((session) => session.startedAt).sort()[0] : record.claimedAt,
    heartbeatAt: automatic ? sessions.map((session) => session.heartbeatAt).sort().at(-1) : record.heartbeatAt,
    expiresAt: automatic ? sessions.map((session) => session.expiresAt).sort().at(-1) : record.expiresAt,
    ...(record.managed ? {
      manual: record.managed.manual,
      sessions: record.managed.sessions.map((session) => publicSession(session, now)),
    } : {}),
    ...(reason ? { reason } : {}),
  };
}

// Lifecycle mutations need the native Git-lock token, while report/MCP/CLI output must never
// leak it.  Keep it non-enumerable so ordinary spreads and JSON serialisation remain public.
/** @param {string} state @param {LeaseRecord} record @param {string|null} [reason] */
function leaseWithRecord(state, record, reason = null, now = Date.now()) {
  const lease = publicLease(state, record, reason, now);
  Object.defineProperty(lease, '_record', { value: record, enumerable: false });
  return lease;
}

function parseRecord(raw, target, now) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return publicLease('invalid', null, 'ownership record is not an object');
  }
  const keys = Object.keys(raw).sort();
  const expected = ['claimedAt', 'expiresAt', 'heartbeatAt', 'nativeLockToken', 'owner', 'version', 'worktreeKey'];
  if (raw.version === SESSION_RECORD_VERSION) expected.push('managed');
  expected.sort();
  if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) {
    return publicLease('invalid', null, 'ownership record has an unsupported shape');
  }
  if (![OWNERSHIP_VERSION, SESSION_RECORD_VERSION].includes(raw.version) || raw.worktreeKey !== target.key || !validOwner(raw.owner)
    || !validInstant(raw.claimedAt) || !validInstant(raw.heartbeatAt) || !validInstant(raw.expiresAt)) {
    return publicLease('invalid', null, 'ownership record failed validation');
  }
  if (raw.nativeLockToken !== null && (typeof raw.nativeLockToken !== 'string' || !/^[0-9a-f-]{36}$/i.test(raw.nativeLockToken))) {
    return publicLease('invalid', null, 'ownership record has an invalid native lock token');
  }
  const claimedAt = Date.parse(raw.claimedAt);
  const heartbeatAt = Date.parse(raw.heartbeatAt);
  const expiresAt = Date.parse(raw.expiresAt);
  if (heartbeatAt < claimedAt || expiresAt <= heartbeatAt
    || expiresAt - heartbeatAt > MAX_LEASE_SECONDS * 1000) {
    return publicLease('invalid', null, 'ownership record has invalid lease times');
  }
  if (raw.version === SESSION_RECORD_VERSION) {
    const managed = raw.managed;
    if (!managed || typeof managed !== 'object' || Array.isArray(managed)
      || Object.keys(managed).sort().join(',') !== 'manual,sessions'
      || typeof managed.manual !== 'boolean' || !Array.isArray(managed.sessions)
      || !managed.sessions.length || managed.sessions.length > SESSION_LIMIT
      || !managed.sessions.every(validSession)
      || new Set(managed.sessions.map((session) => session.id)).size !== managed.sessions.length) {
      return publicLease('invalid', null, 'automatic session record failed validation');
    }
  }
  const record = {
    version: raw.version,
    worktreeKey: raw.worktreeKey,
    owner: raw.owner,
    claimedAt: raw.claimedAt,
    heartbeatAt: raw.heartbeatAt,
    expiresAt: raw.expiresAt,
    nativeLockToken: raw.nativeLockToken,
    ...(raw.version === SESSION_RECORD_VERSION ? { managed: raw.managed } : {}),
  };
  const active = record.managed
    ? (record.managed.manual && expiresAt > now) || record.managed.sessions.some((session) => Date.parse(session.expiresAt) > now)
    : expiresAt > now;
  return leaseWithRecord(active ? 'active' : 'expired', record, null, now);
}

function asErrorReason(error) {
  return error?.code ? `${error.code}` : (error?.message ?? String(error));
}

/**
 * Resolve one worktree to the private Git identity used by a lease record.
 * @param {string} worktreePath
 * @param {{commonDir?:string|null}} [options]
 * @returns {Promise<{ok:true,commonDir:string,gitDir:string,root:string,key:string}|{ok:false,ownership:OwnershipEvidence}>}
 */
export async function ownershipTarget(worktreePath, { commonDir = null } = {}) {
  const common = commonDir ?? await repoIdentity(worktreePath);
  if (!common || !path.isAbsolute(common)) {
    return { ok: false, ownership: publicLease('unavailable', null, 'Git common directory could not be resolved') };
  }
  let gitDir;
  try {
    const result = await git(['rev-parse', '--path-format=absolute', '--git-dir'], { cwd: worktreePath });
    gitDir = result.code === 0 ? result.stdout.trim() : null;
  } catch {
    gitDir = null;
  }
  if (!gitDir || !path.isAbsolute(gitDir)) {
    return { ok: false, ownership: publicLease('unavailable', null, 'worktree Git directory could not be resolved') };
  }
  const commonResolved = await canonicalPath(common);
  const gitDirResolved = await canonicalPath(gitDir);
  const relativeGitDir = await relativeWithinAsync(commonResolved, gitDirResolved);
  if (relativeGitDir.startsWith('../') || relativeGitDir === '..' || path.isAbsolute(relativeGitDir)) {
    return { ok: false, ownership: publicLease('unavailable', null, 'worktree Git directory is not within its common Git directory') };
  }
  const root = ownershipRoot(commonResolved);
  return {
    ok: true,
    commonDir: commonResolved,
    gitDir: gitDirResolved,
    root,
    key: keyFor(relativeGitDir || 'main'),
  };
}

async function readLeaseAt(target, now = Date.now()) {
  const stored = await readStableRegularFile(recordPath(target), {
    maxBytes: SESSION_MAX_BYTES, requireSingleLink: true, requireOwner: true,
  });
  if (!stored.ok) {
    if (stored.code === 'ENOENT') return publicLease('unclaimed');
    return publicLease('unavailable', null, `ownership record could not be read (${stored.reason}${stored.code ? `: ${stored.code}` : ''})`);
  }
  try {
    return parseRecord(JSON.parse(stored.bytes.toString('utf8')), target, now);
  } catch {
    return publicLease('invalid', null, 'ownership record is not valid JSON');
  }
}

/**
 * Read-only lease evidence used by discovery and every report surface.
 * @param {string} worktreePath
 * @param {{commonDir?:string|null,now?:number}} [options]
 */
export async function inspectWorktreeOwnership(worktreePath, { commonDir = null, now = Date.now() } = {}) {
  const target = await ownershipTarget(worktreePath, { commonDir });
  if (!target.ok) return target.ownership;
  const ownership = await readLeaseAt(target, now);
  ownership.worktreeKey = target.key;
  return ownership;
}

async function ensureOwnershipDirectories(target) {
  await ensurePrivateDirectory(target.root);
  await ensurePrivateDirectory(path.join(target.root, 'records'));
  await ensurePrivateDirectory(path.join(target.root, 'locks'));
}

/**
 * Serialize a claim mutation with clean's final move check. SQLite's native transaction lock
 * is released by the operating system even if this short-lived process crashes. That says
 * nothing about the agent's session: its separate lease record survives unchanged.
 *
 * No rows or session state live in this database; BEGIN IMMEDIATE is the cross-platform lock.
 * Never unlink this file to recover contention: all contenders must lock the same inode.
 */
export async function withLeaseLock(target, fn) {
  try {
    await ensureOwnershipDirectories(target);
  } catch (error) {
    return { ok: false, code: 'unavailable', ownership: publicLease('unavailable', null, `ownership state directory is unavailable (${asErrorReason(error)})`) };
  }
  const lock = lockPath(target);
  let database;
  try {
    try {
      const created = await fs.open(lock, 'wx', 0o600);
      await created.close();
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const before = await fs.lstat(lock);
    if (!before.isFile() || before.nlink !== 1
      || (typeof process.getuid === 'function' && before.uid !== process.getuid())) {
      throw new Error('ownership mutex is not an owned regular file');
    }
    // Available in every supported official Node release; loaded only by mutating operations.
    const { DatabaseSync } = await import('node:sqlite');
    database = new DatabaseSync(lock, { timeout: 0, allowExtension: false });
    database.exec('BEGIN IMMEDIATE');
    const after = await fs.lstat(lock);
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error('ownership mutex identity changed during acquisition');
    }
  } catch (error) {
    try { database?.close(); } catch {}
    if (error?.errcode === 5 || error?.errcode === 6) {
      return { ok: false, code: 'busy', ownership: publicLease('unavailable', null, 'another ownership or cleanup operation is in progress') };
    }
    return { ok: false, code: 'unavailable', ownership: publicLease('unavailable', null, `ownership lock could not be acquired (${asErrorReason(error)})`) };
  }
  try {
    return { ok: true, value: await fn() };
  } finally {
    // Closing rolls back the empty transaction and releases the native lock. A process crash
    // performs the same lock release, so there is no timestamp or process-name stale-lock guess.
    database.close();
  }
}

function validLeaseSeconds(value) {
  return Number.isInteger(value) && value >= MIN_LEASE_SECONDS && value <= MAX_LEASE_SECONDS;
}

/** @returns {LeaseRecord} */
function newRecord(target, owner, ttlSeconds, now) {
  const at = new Date(now).toISOString();
  return {
    version: OWNERSHIP_VERSION,
    worktreeKey: target.key,
    owner,
    claimedAt: at,
    heartbeatAt: at,
    expiresAt: new Date(now + ttlSeconds * 1000).toISOString(),
    nativeLockToken: null,
  };
}

async function writeRecord(target, record) {
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
  if (bytes.length > SESSION_MAX_BYTES) throw new Error('session ledger reached its bounded storage limit');
  await writePrivateFileAtomic(recordPath(target), bytes);
}

/** Keep one authority record while an explicit lease and automatic attachments coexist. */
function withSessions(record, previous) {
  if (!previous?._record?.managed?.sessions.length) return record;
  return {
    ...(record ?? previous._record), version: SESSION_RECORD_VERSION,
    managed: { manual: !!record, sessions: previous._record.managed.sessions },
  };
}

function manualEvidence(ownership, now) {
  if (!ownership._record?.managed) return ownership;
  if (!ownership._record.managed.manual) return publicLease('unclaimed');
  const { managed, ...record } = ownership._record;
  record.version = OWNERSHIP_VERSION;
  return leaseWithRecord(Date.parse(record.expiresAt) > now ? 'active' : 'expired', record, null, now);
}

function nativeLockReason(token) {
  return `${NATIVE_LOCK_PREFIX}${token}`;
}

async function leaseNativeLockMatches(target, token) {
  if (!token) return false;
  const stored = await readStableRegularFile(path.join(target.gitDir, 'locked'), {
    maxBytes: 1024, requireSingleLink: true, requireOwner: true,
  });
  return stored.ok && stored.bytes.toString('utf8').trim() === nativeLockReason(token);
}

async function nativeLeaseLockToken(target) {
  const stored = await readStableRegularFile(path.join(target.gitDir, 'locked'), {
    maxBytes: 1024, requireSingleLink: true, requireOwner: true,
  });
  if (!stored.ok) return null;
  const match = new RegExp(`^${NATIVE_LOCK_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([0-9a-f-]{36})$`, 'i')
    .exec(stored.bytes.toString('utf8').trim());
  return match ? match[1] : null;
}

/**
 * Git's own lock makes the active local lease visible to ordinary `git worktree remove` and
 * `prune`, while the lease record remains the authoritative state for Holt and for the primary
 * worktree (which Git refuses to lock).  A pre-existing lock is never replaced.
 */
async function acquireNativeLeaseLock(target, worktreePath) {
  const token = randomUUID();
  const locked = await git(['worktree', 'lock', '--reason', nativeLockReason(token), worktreePath], {
    cwd: worktreePath, allowMutation: true,
  }).catch(() => null);
  return locked?.code === 0 ? token : null;
}

async function releaseNativeLeaseLock(target, worktreePath, token) {
  if (!await leaseNativeLockMatches(target, token)) return false;
  const result = await git(['worktree', 'unlock', worktreePath], {
    cwd: worktreePath, allowMutation: true,
  }).catch(() => null);
  return result?.code === 0;
}

async function journalLifecycle(worktreePath, result, { owner, toOwner, reason }) {
  // Heartbeats deliberately do not become an unbounded audit log. Claims, explicit releases,
  // handoffs and takeovers change the authority boundary, so those are the durable decisions.
  if (!result.ok || result.action === 'renewed') return result;
  const event = {
    action: `ownership-${result.action}`,
    path: worktreePath,
    leaseOwner: result.ownership?.owner ?? owner,
    ...(toOwner ? { handoffTo: toOwner } : {}),
    ...(result.action === 'taken-over' ? { reason } : {}),
  };
  const journal = await appendEvent(worktreePath, event);
  return journal.ok ? result : {
    ...result,
    journalWarning: `ownership changed but its audit event was not recorded: ${journal.error}`,
  };
}

/**
 * Perform one explicit ownership lifecycle action for a resolved worktree path.
 * The caller resolves a presentation id to this path before entering here, keeping this module
 * independent of discovery and therefore usable from discovery itself.
 * @param {string} worktreePath
 * @param {{operation?:string,owner?:string|null,toOwner?:string|null,ttlSeconds?:number,takeover?:boolean,reason?:string|null,commonDir?:string|null,now?:number}} [options]
 */
export async function operateWorktreeOwnership(worktreePath, {
  operation = 'status', owner = null, toOwner = null, ttlSeconds = DEFAULT_LEASE_SECONDS,
  takeover = false, reason = null, commonDir = null, now = Date.now(),
} = {}) {
  const target = await ownershipTarget(worktreePath, { commonDir });
  if (!target.ok) return { ok: false, code: 'unavailable', ownership: target.ownership };

  if (operation === 'status') {
    const ownership = await readLeaseAt(target, now);
    return { ok: ownership.state !== 'unavailable', ownership };
  }
  if (!['claim', 'heartbeat', 'release', 'handoff'].includes(operation)) {
    return { ok: false, code: 'invalid-operation', ownership: publicLease('unavailable', null, `unknown ownership operation '${operation}'`) };
  }
  if (!validLeaseSeconds(ttlSeconds)) {
    return { ok: false, code: 'invalid-ttl', ownership: publicLease('unavailable', null, `lease length must be an integer from ${MIN_LEASE_SECONDS} to ${MAX_LEASE_SECONDS} seconds`) };
  }
  if (!validOwner(owner)) {
    return { ok: false, code: 'invalid-owner', ownership: publicLease('unavailable', null, 'owner must be a non-empty printable identifier of at most 256 characters') };
  }
  if (operation === 'handoff' && !validOwner(toOwner)) {
    return { ok: false, code: 'invalid-target-owner', ownership: publicLease('unavailable', null, 'handoff target must be a non-empty printable identifier of at most 256 characters') };
  }
  if (takeover && (typeof reason !== 'string' || !reason.trim() || CONTROL.test(reason) || reason.length > 512)) {
    return { ok: false, code: 'takeover-reason-required', ownership: publicLease('unavailable', null, 'taking over an expired or invalid lease requires a printable --reason of at most 512 characters') };
  }

  const guarded = await withLeaseLock(target, async () => {
    const aggregate = await readLeaseAt(target, now);
    const current = manualEvidence(aggregate, now);
    if (current.state === 'unavailable') {
      return { ok: false, code: current.state, ownership: current };
    }
    if (operation === 'claim') {
      if (current.state === 'invalid' && takeover) {
        const stored = await readStableRegularFile(recordPath(target), { maxBytes: SESSION_MAX_BYTES, requireOwner: true, requireSingleLink: true });
        if (!stored.ok) return { ok: false, code: 'recovery-required', ownership: aggregate };
        let raw;
        try { raw = JSON.parse(stored.bytes.toString('utf8')); } catch { raw = null; }
        if (raw && (raw.version !== OWNERSHIP_VERSION || Object.hasOwn(raw, 'managed'))) {
          return { ok: false, code: 'session-recovery-required', ownership: aggregate };
        }
        // A reviewed legacy repair still preserves every byte of the damaged authority record.
        const saved = createHash('sha256').update(stored.bytes).digest('hex');
        await writePrivateFileAtomic(path.join(target.root, 'record-recoveries', `${target.key}-${saved}.json`), stored.bytes);
      }
      if (current.state === 'active' && current.owner !== owner) {
        return { ok: false, code: 'held', ownership: current };
      }
      if (['expired', 'invalid'].includes(current.state) && !takeover) {
        return { ok: false, code: current.state === 'expired' ? 'expired-needs-takeover' : 'invalid-needs-takeover', ownership: current };
      }
      const record = newRecord(target, owner, ttlSeconds, now);
      if (aggregate._record?.managed) record.nativeLockToken = aggregate._record.nativeLockToken;
      if (current.state === 'active' && current.claimedAt) record.claimedAt = current.claimedAt;
      if (['active', 'expired'].includes(current.state)
        && await leaseNativeLockMatches(target, current._record?.nativeLockToken)) {
        record.nativeLockToken = current._record?.nativeLockToken ?? null;
      } else if (current.state === 'invalid') {
        // A corrupt record cannot name a trustworthy owner, but its matching Git lock is still
        // recognisably Holt's.  An explicit reviewed takeover adopts that lock rather than
        // stranding it forever or weakening an unrelated foreign lock.
        record.nativeLockToken = await nativeLeaseLockToken(target);
      }
      const acquiredToken = record.nativeLockToken ? null : await acquireNativeLeaseLock(target, worktreePath);
      if (acquiredToken) record.nativeLockToken = acquiredToken;
      try {
        await writeRecord(target, withSessions(record, aggregate));
      } catch (error) {
        // Do not strand a native lock if its matching lease record could not be published.
        if (acquiredToken) await releaseNativeLeaseLock(target, worktreePath, acquiredToken);
        throw error;
      }
      return {
        ok: true,
        action: current.state === 'active' ? 'renewed' : (['expired', 'invalid'].includes(current.state) ? 'taken-over' : 'claimed'),
        ownership: publicLease('active', withSessions(record, aggregate), null, now),
        nativeGitLock: !!record.nativeLockToken,
      };
    }
    if (operation === 'heartbeat') {
      if (current.state !== 'active' || current.owner !== owner || !current.claimedAt) {
        return { ok: false, code: current.state === 'expired' ? 'expired-needs-takeover' : 'not-owner', ownership: current };
      }
      const record = {
        version: OWNERSHIP_VERSION,
        worktreeKey: target.key,
        owner,
        claimedAt: current.claimedAt,
        heartbeatAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttlSeconds * 1000).toISOString(),
        nativeLockToken: current._record?.nativeLockToken ?? null,
      };
      await writeRecord(target, withSessions(record, aggregate));
      return { ok: true, action: 'renewed', ownership: publicLease('active', withSessions(record, aggregate), null, now) };
    }
    if (operation === 'release') {
      if (!['active', 'expired'].includes(current.state) || current.owner !== owner) {
        return { ok: false, code: 'not-owner', ownership: current };
      }
      if (aggregate._record?.managed?.sessions.length) {
        const retained = withSessions(null, aggregate);
        await writeRecord(target, retained);
        return { ok: true, action: 'released', ownership: await readLeaseAt(target, now), nativeGitLockReleased: false };
      }
      const hadMatchingNativeLock = await leaseNativeLockMatches(target, current._record?.nativeLockToken);
      if (hadMatchingNativeLock && !await releaseNativeLeaseLock(target, worktreePath, current._record?.nativeLockToken)) {
        return { ok: false, code: 'native-lock-release-failed', ownership: current };
      }
      await fs.unlink(recordPath(target));
      return { ok: true, action: 'released', ownership: publicLease('unclaimed'), nativeGitLockReleased: hadMatchingNativeLock };
    }
    if (current.state !== 'active' || current.owner !== owner) {
      return { ok: false, code: current.state === 'expired' ? 'expired-needs-takeover' : 'not-owner', ownership: current };
    }
    const record = newRecord(target, toOwner, ttlSeconds, now);
    record.nativeLockToken = current._record?.nativeLockToken ?? null;
    await writeRecord(target, withSessions(record, aggregate));
    return { ok: true, action: 'handed-off', ownership: publicLease('active', withSessions(record, aggregate), null, now), previousOwner: owner };
  });
  if (!guarded.ok) return { ok: false, code: guarded.code, ownership: guarded.ownership };
  return journalLifecycle(worktreePath, guarded.value, { owner, toOwner, reason });
}

/**
 * Attach before a host grants workspace access. The private credential is non-enumerable:
 * report serialization cannot accidentally turn a session id into a release capability.
 * @param {string} worktreePath
 * @param {Parameters<typeof createSession>[0] & {commonDir?:string|null,exclusive?:boolean}} [options]
 */
export async function openWorktreeSession(worktreePath, options = {}) {
  const created = createSession(options);
  if (!created) return { ok: false, code: 'invalid-session' };
  const now = options.now ?? Date.now();
  const target = await ownershipTarget(worktreePath, options);
  if (!target.ok) return { ok: false, code: 'unavailable', ownership: target.ownership };
  const guarded = await withLeaseLock(target, async () => {
    const current = await readLeaseAt(target, now);
    if (['invalid', 'unavailable'].includes(current.state)) return { ok: false, code: current.state, ownership: current };
    if (options.exclusive === true && current.state !== 'unclaimed') return { ok: false, code: 'workspace-in-use', ownership: current };
    const sessions = current._record?.managed?.sessions ?? [];
    if (sessions.length >= SESSION_LIMIT) return { ok: false, code: 'session-limit', ownership: current };
    const record = current._record ?? newRecord(target, 'automatic sessions', options.ttlSeconds ?? DEFAULT_LEASE_SECONDS, now);
    const acquiredToken = record.nativeLockToken ? null : await acquireNativeLeaseLock(target, worktreePath);
    if (acquiredToken) record.nativeLockToken = acquiredToken;
    record.managed = { manual: current._record?.managed?.manual ?? !!current._record, sessions: [...sessions, created.session] };
    record.version = SESSION_RECORD_VERSION;
    try {
      // Persist recovery authority before publishing the attachment. An interrupted client must
      // not strand work merely because its only copy of a random credential was in memory.
      await writePrivateFileAtomic(path.join(target.root, 'credentials', `${created.session.id}-${created.session.generation}.json`),
        Buffer.from(JSON.stringify({ version: 1, worktreeKey: target.key, credential: created.credential }) + '\n'));
      await writeRecord(target, record);
    } catch (error) {
      if (acquiredToken) await releaseNativeLeaseLock(target, worktreePath, acquiredToken);
      throw error;
    }
    return { ok: true, action: 'session-attached', session: publicSession(created.session, now), ownership: await readLeaseAt(target, now) };
  });
  if (!guarded.ok) return { ok: false, code: guarded.code, ownership: guarded.ownership };
  const result = guarded.value;
  if (result.ok) await appendEvent(worktreePath, { action: 'session-attached', sessionId: created.session.id, sessionKind: created.session.kind });
  if (result.ok) Object.defineProperty(result, 'credential', { value: created.credential, enumerable: false });
  return /** @type {typeof result & {credential?:import('./sessions.mjs').SessionCredential}} */ (result);
}

/** Transfer this attachment under the cleanup mutex; old generation events lose authority. */
export async function handoffWorktreeSession(worktreePath, credential, expectedSequence) {
  const target = await ownershipTarget(worktreePath);
  if (!target.ok) return { ok: false, code: 'unavailable' };
  const guarded = await withLeaseLock(target, async () => {
    const current = await readLeaseAt(target, Date.now());
    const record = current._record;
    const session = record?.managed?.sessions.find((item) => item.id === credential?.id);
    if (!record?.managed || !session || !authenticSession(session, credential)) return { ok: false, code: 'session-credential-mismatch' };
    if (session.sequence !== expectedSequence) return { ok: false, code: 'sequence-mismatch', expectedSequence: session.sequence };
    const rotated = rotateSession(session);
    // Keep the previous generation's recovery credential until the successor is published.
    await writePrivateFileAtomic(path.join(target.root, 'credentials', `${rotated.session.id}-${rotated.session.generation}.json`),
      Buffer.from(JSON.stringify({ version: 1, worktreeKey: target.key, credential: rotated.credential }) + '\n'));
    record.managed.sessions = record.managed.sessions.map((item) => item.id === session.id ? rotated.session : item);
    await writeRecord(target, record);
    const result = { ok: true, session: publicSession(rotated.session), ownership: await readLeaseAt(target, Date.now()) };
    Object.defineProperty(result, 'credential', { value: rotated.credential, enumerable: false });
    return result;
  });
  if (!guarded.ok) return { ok: false, code: guarded.code };
  if (guarded.value.ok) await appendEvent(worktreePath, { action: 'session-handed-off', sessionId: credential.id, previousGeneration: credential.generation, generation: guarded.value.session.generation });
  return /** @type {typeof guarded.value & {credential?:import('./sessions.mjs').SessionCredential}} */ (guarded.value);
}

const closedSessionPath = (target, credential) => path.join(target.root, 'closed-sessions', `${credential.id}-${credential.generation}.json`);

/**
 * Commit a host event under the exact mutex used by cleanup. Pending work is published before
 * its start acknowledgement. Only the credential for this generation can drain or retire it.
 * @param {string} worktreePath
 * @param {import('./sessions.mjs').SessionCredential} credential
 * @param {Parameters<typeof applySessionEvent>[1]} event
 * @param {{commonDir?:string|null,now?:number,ttlSeconds?:number}} [options]
 */
export async function updateWorktreeSession(worktreePath, credential, event, options = {}) {
  const target = await ownershipTarget(worktreePath, options);
  if (!target.ok) return { ok: false, code: 'unavailable', ownership: target.ownership };
  const now = options.now ?? Date.now();
  const guarded = await withLeaseLock(target, async () => {
    const current = await readLeaseAt(target, now);
    const record = current._record;
    const session = record?.managed?.sessions.find((item) => item.id === credential?.id);
    if (!record?.managed || !session || !authenticSession(session, credential)) {
      // A lost final acknowledgement must not strand a successfully retired host. Authenticate
      // the same exact finish against its private receipt; it cannot affect a successor.
      if (event?.type === 'finish' && /^[0-9a-f-]{36}$/.test(credential?.id) && /^[0-9a-f-]{36}$/.test(credential?.generation)) {
        const closed = await readStableRegularFile(closedSessionPath(target, credential), { maxBytes: SESSION_MAX_BYTES, requireOwner: true, requireSingleLink: true });
        if (closed.ok) {
          try {
            const receipt = JSON.parse(closed.bytes.toString('utf8'));
            if (receipt.version === 1 && receipt.worktreeKey === target.key && validSession(receipt.session)
              && authenticSession(receipt.session, credential) && receipt.session.sequence === event.sequence
              && receipt.session.lastEventHash === sessionEventHash(event) && receipt.session.phase === 'draining'
              && !receipt.session.pending.length && !receipt.session.buffers.length) {
              return { ok: true, repeated: true, closed: true, session: publicSession(receipt.session, now), ownership: current };
            }
          } catch { /* Invalid receipts grant no authority. */ }
        }
      }
      return { ok: false, code: 'session-credential-mismatch', ownership: current };
    }
    if (event.type === 'buffer' && event.buffer?.recoveryRef) {
      const recovery = await readBufferSnapshot(target.root, event.buffer.recoveryRef);
      if (!recovery.ok || recovery.digest !== event.buffer.digest || recovery.snapshot?.bufferPath !== event.buffer.path) {
        return { ok: false, code: 'buffer-recovery-unverified' };
      }
    }
    const updated = applySessionEvent(session, event, options);
    if (!updated.ok || !updated.session) return updated;
    if (updated.repeated) return { ok: true, repeated: true, session: publicSession(session, now), ownership: current };
    if (event.type === 'buffer-close') {
      const buffer = session.buffers.find((item) => item.path === event.path);
      if (buffer?.dirty) {
        if (!buffer.recoveryRef) return { ok: false, code: 'buffer-recovery-unverified' };
        const recovery = await readBufferSnapshot(target.root, buffer.recoveryRef);
        if (!recovery.ok || recovery.digest !== buffer.digest || recovery.snapshot?.bufferPath !== buffer.path) {
          return { ok: false, code: 'buffer-recovery-unverified' };
        }
        // Closing an editor buffer need not block the task when its exact text is captured.
        // The recovery receipt outlives the writable attachment and keeps the copy discoverable.
        const bufferKey = createHash('sha256').update(buffer.path).digest('hex');
        await writePrivateFileAtomic(path.join(target.root, 'buffer-recoveries', `${session.id}-${bufferKey}-${buffer.version}.json`),
          Buffer.from(JSON.stringify({ version: 1, worktreeKey: target.key, sessionId: session.id,
            generation: session.generation, closedAt: new Date(now).toISOString(), buffer }) + '\n'));
      }
    }
    const remaining = record.managed.sessions.filter((item) => item.id !== session.id);
    if (updated.closed) {
      await writePrivateFileAtomic(closedSessionPath(target, credential), Buffer.from(JSON.stringify({
        version: 1, worktreeKey: target.key, session: updated.session,
      }) + '\n'));
    }
    if (!updated.closed) remaining.push(updated.session);
    if (remaining.length) {
      record.managed.sessions = remaining;
      await writeRecord(target, record);
    } else if (record.managed.manual) {
      const { managed, ...manual } = record;
      manual.version = OWNERSHIP_VERSION;
      await writeRecord(target, manual);
    } else {
      if (await leaseNativeLockMatches(target, record.nativeLockToken)
        && !await releaseNativeLeaseLock(target, worktreePath, record.nativeLockToken)) {
        return { ok: false, code: 'native-lock-release-failed', ownership: current };
      }
      await fs.unlink(recordPath(target));
      await syncPrivateDirectory(path.dirname(recordPath(target)));
    }
    if (updated.closed) {
      await fs.unlink(path.join(target.root, 'credentials', `${session.id}-${session.generation}.json`)).catch(() => {});
    }
    return { ok: true, closed: updated.closed, session: publicSession(updated.session, now), ownership: await readLeaseAt(target, now) };
  });
  if (!guarded.ok) return { ok: false, code: guarded.code, ownership: guarded.ownership };
  if (guarded.value.ok && guarded.value.closed && !guarded.value.repeated) {
    await appendEvent(worktreePath, { action: 'session-finished', sessionId: credential.id, generation: credential.generation });
  }
  return guarded.value;
}

/**
 * Hold the per-worktree lease mutex across clean's final re-check and directory move.  A claim
 * that arrives while this is held receives `busy`; a clean that finds any lease state other than
 * unclaimed refuses.  This closes the claim-vs-clean interval without pretending Holt can stop
 * a non-participating process from writing bytes.
 * @param {string} worktreePath
 * @param {Function} fn
 * @param {{commonDir?:string|null,now?:number}} [options]
 */
export async function withUnclaimedWorktreeOwnership(worktreePath, fn, { commonDir = null, now = Date.now() } = {}) {
  const target = await ownershipTarget(worktreePath, { commonDir });
  if (!target.ok) return { ok: false, code: 'unavailable', ownership: target.ownership };
  const guarded = await withLeaseLock(target, async () => {
    const ownership = await readLeaseAt(target, now);
    if (ownership.state !== 'unclaimed') return { kind: 'ownership-refusal', ownership };
    return { kind: 'callback-result', result: await fn() };
  });
  if (!guarded.ok) return { ok: false, code: guarded.code, ownership: guarded.ownership };
  if (guarded.value.kind === 'ownership-refusal') {
    return { ok: false, code: guarded.value.ownership.state, ownership: guarded.value.ownership };
  }
  return guarded.value.result;
}
