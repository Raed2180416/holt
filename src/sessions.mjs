// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * The bounded, provider-neutral session ledger. Persistence and the cleanup mutex are owned by
 * ownership.mjs. A deadline is evidence that contact was lost, never permission to delete work.
 * Credentials are private capabilities; reported session ids are not authority to end a session.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export const SESSION_RECORD_VERSION = 2;
export const SESSION_LIMIT = 128;
export const SESSION_ITEM_LIMIT = 256;
export const SESSION_MAX_BYTES = 2 * 1024 * 1024;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KINDS = ['runner', 'agent', 'editor', 'job'];

/** @typedef {{id:string,kind:string,paths:string[],startedAt:string}} PendingOperation */
/** @typedef {{path:string,version:number,digest:string,dirty:boolean,recoveryRef:string|null}} SessionBuffer */
/**
 * @typedef {object} SessionRecord
 * @property {string} id
 * @property {string} generation
 * @property {string} capabilityHash
 * @property {string} kind
 * @property {string} label
 * @property {string|null} host
 * @property {string|null} externalSessionId
 * @property {string} startedAt
 * @property {string} heartbeatAt
 * @property {string} expiresAt
 * @property {number} sequence
 * @property {string|null} lastEventHash
 * @property {'active'|'draining'} phase
 * @property {PendingOperation[]} pending
 * @property {SessionBuffer[]} buffers
 */
/** @typedef {{id:string,generation:string,capability:string}} SessionCredential */

/** @param {unknown} value @param {number} [limit] @returns {value is string} */
export function sessionText(value, limit = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && !CONTROL.test(value);
}

/** Store portable workspace-relative paths, never host-dependent path traversal. */
export function sessionPath(value) {
  return sessionText(value, 4096) && !value.startsWith('/') && !value.includes('\\')
    && !value.includes(':') && value.split('/').every((part) => part && part !== '.' && part !== '..');
}

const instant = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

/** Strict validation prevents partial or future records from silently dropping a holder. */
export function validSession(session) {
  if (!exactKeys(session, ['id', 'generation', 'capabilityHash', 'kind', 'label', 'host',
    'externalSessionId', 'startedAt', 'heartbeatAt', 'expiresAt', 'sequence', 'lastEventHash',
    'phase', 'pending', 'buffers'])) return false;
  if (!UUID.test(session.id) || !UUID.test(session.generation) || !SHA256.test(session.capabilityHash)
    || !KINDS.includes(session.kind) || !sessionText(session.label)
    || !(session.host === null || sessionText(session.host))
    || !(session.externalSessionId === null || sessionText(session.externalSessionId))
    || !instant(session.startedAt) || !instant(session.heartbeatAt) || !instant(session.expiresAt)
    || Date.parse(session.heartbeatAt) < Date.parse(session.startedAt)
    || Date.parse(session.expiresAt) <= Date.parse(session.heartbeatAt)
    || Date.parse(session.expiresAt) - Date.parse(session.heartbeatAt) > 86400000
    || !Number.isSafeInteger(session.sequence) || session.sequence < 0
    || !(session.lastEventHash === null || SHA256.test(session.lastEventHash))
    || !['active', 'draining'].includes(session.phase)
    || !Array.isArray(session.pending) || session.pending.length > SESSION_ITEM_LIMIT
    || !Array.isArray(session.buffers) || session.buffers.length > SESSION_ITEM_LIMIT) return false;
  const pendingIds = new Set();
  for (const operation of session.pending) {
    if (!exactKeys(operation, ['id', 'kind', 'paths', 'startedAt']) || !sessionText(operation.id)
      || !sessionText(operation.kind) || !instant(operation.startedAt)
      || !Array.isArray(operation.paths) || operation.paths.length > SESSION_ITEM_LIMIT
      || !operation.paths.every(sessionPath) || pendingIds.has(operation.id)) return false;
    pendingIds.add(operation.id);
  }
  const bufferPaths = new Set();
  for (const buffer of session.buffers) {
    if (!exactKeys(buffer, ['path', 'version', 'digest', 'dirty', 'recoveryRef'])
      || !sessionPath(buffer.path) || !Number.isSafeInteger(buffer.version) || buffer.version < 0
      || !SHA256.test(buffer.digest) || typeof buffer.dirty !== 'boolean'
      || !(buffer.recoveryRef === null || SHA256.test(buffer.recoveryRef))
      || bufferPaths.has(buffer.path)) return false;
    bufferPaths.add(buffer.path);
  }
  return true;
}

/**
 * @param {{kind?:string,label?:string,host?:string|null,externalSessionId?:string|null,ttlSeconds?:number,now?:number}} [options]
 * @returns {{session:SessionRecord,credential:SessionCredential}|null}
 */
export function createSession({ kind = 'runner', label = 'running task', host = null,
  externalSessionId = null, ttlSeconds = 900, now = Date.now() } = {}) {
  if (!KINDS.includes(kind) || !sessionText(label) || !(host === null || sessionText(host))
    || !(externalSessionId === null || sessionText(externalSessionId))
    || !Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 86400
    || !Number.isFinite(now)) return null;
  const capability = randomBytes(32).toString('hex');
  const at = new Date(now).toISOString();
  const session = {
    id: randomUUID(), generation: randomUUID(), capabilityHash: digest(capability),
    kind, label, host, externalSessionId, startedAt: at, heartbeatAt: at,
    expiresAt: new Date(now + ttlSeconds * 1000).toISOString(), sequence: 0,
    lastEventHash: null, phase: /** @type {'active'} */ ('active'), pending: [], buffers: [],
  };
  return { session, credential: { id: session.id, generation: session.generation, capability } };
}

function digest(value) { return createHash('sha256').update(value).digest('hex'); }

/** Stable nested JSON keys make transport retries independent of object property order. */
export function sessionEventHash(event) {
  const canonical = (value) => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
  return digest(JSON.stringify(canonical(event)));
}

/** Rotate authority without dropping a pending operation, buffer, or native workspace hold. */
export function rotateSession(session) {
  const capability = randomBytes(32).toString('hex');
  const next = { ...structuredClone(session), generation: randomUUID(), capabilityHash: digest(capability), lastEventHash: null };
  return { session: next, credential: { id: next.id, generation: next.generation, capability } };
}

/** @param {SessionRecord} session @param {SessionCredential} credential */
export function authenticSession(session, credential) {
  return credential?.id === session.id && credential?.generation === session.generation
    && typeof credential?.capability === 'string' && SHA256.test(credential.capability)
    && timingSafeEqual(Buffer.from(session.capabilityHash, 'hex'), Buffer.from(digest(credential.capability), 'hex'));
}

/** Public metadata intentionally excludes credentials and private recovery object references. */
export function publicSession(session, now = Date.now()) {
  return {
    id: session.id, generation: session.generation, kind: session.kind, label: session.label,
    host: session.host, externalSessionId: session.externalSessionId,
    state: Date.parse(session.expiresAt) > now ? session.phase : 'contact-lost',
    startedAt: session.startedAt, heartbeatAt: session.heartbeatAt, expiresAt: session.expiresAt,
    sequence: session.sequence, pending: session.pending.map((operation) => ({ ...operation, paths: [...operation.paths] })),
    buffers: session.buffers.map(({ recoveryRef, ...buffer }) => ({ ...buffer, recoverable: !!recoveryRef })),
  };
}

/**
 * Ordered operation events. A repeated event is idempotent; conflicting repeats and sequence
 * gaps cannot retire outstanding work. An authenticated host may resume contact after expiry.
 * @param {SessionRecord} session
 * @param {{sequence:number,type:string,operationId?:string,kind?:string,paths?:string[],buffer?:SessionBuffer,path?:string,version?:number}} event
 * @param {{now?:number,ttlSeconds?:number}} [options]
 */
export function applySessionEvent(session, event, { now = Date.now(), ttlSeconds = 900 } = {}) {
  if (!event || !Number.isSafeInteger(event.sequence) || event.sequence < 1
    || !Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 86400
    || !Number.isFinite(now)) {
    return { ok: false, code: 'invalid-event' };
  }
  // Wall-clock corrections must not strand a host. Sequence numbers, not wall time, order work.
  now = Math.max(now, Date.parse(session.heartbeatAt));
  const eventHash = sessionEventHash(event);
  if (event.sequence === session.sequence && eventHash === session.lastEventHash) {
    return { ok: true, session, repeated: true, closed: false };
  }
  if (event.sequence !== session.sequence + 1) return { ok: false, code: 'sequence-mismatch', expectedSequence: session.sequence + 1 };
  /** @type {SessionRecord} */
  const next = structuredClone(session);
  if (event.type === 'operation-start') {
    if (next.phase !== 'active') return { ok: false, code: 'session-draining' };
    if (!sessionText(event.operationId) || !sessionText(event.kind)
      || !Array.isArray(event.paths) || event.paths.length > SESSION_ITEM_LIMIT
      || !event.paths.every(sessionPath)) return { ok: false, code: 'invalid-operation' };
    if (next.pending.some((operation) => operation.id === event.operationId)) return { ok: false, code: 'operation-already-pending' };
    if (next.pending.length >= SESSION_ITEM_LIMIT) return { ok: false, code: 'pending-limit' };
    next.pending.push({ id: event.operationId, kind: event.kind, paths: [...new Set(event.paths)], startedAt: new Date(now).toISOString() });
  } else if (event.type === 'operation-finish') {
    const index = next.pending.findIndex((operation) => operation.id === event.operationId);
    if (index < 0) return { ok: false, code: 'operation-not-pending' };
    next.pending.splice(index, 1);
  } else if (event.type === 'buffer') {
    const buffer = event.buffer;
    if (!buffer) return { ok: false, code: 'invalid-buffer' };
    const old = next.buffers.find((item) => item.path === buffer.path);
    if (old && (buffer.version < old.version || (buffer.version === old.version && buffer.digest !== old.digest))) {
      return { ok: false, code: 'buffer-version-mismatch' };
    }
    if (!old && next.buffers.length >= SESSION_ITEM_LIMIT) return { ok: false, code: 'buffer-limit' };
    next.buffers = next.buffers.filter((item) => item.path !== buffer.path);
    next.buffers.push({ ...buffer });
  } else if (event.type === 'buffer-close') {
    const buffer = next.buffers.find((item) => item.path === event.path);
    if (!buffer || buffer.version !== event.version) return { ok: false, code: 'buffer-version-mismatch' };
    if (buffer.dirty && !buffer.recoveryRef) return { ok: false, code: 'unsaved-buffer' };
    next.buffers = next.buffers.filter((item) => item !== buffer);
  } else if (event.type === 'drain') {
    next.phase = 'draining';
  } else if (event.type === 'finish') {
    if (next.phase !== 'draining') return { ok: false, code: 'drain-required' };
    if (next.pending.length || next.buffers.length) return { ok: false, code: 'work-pending' };
  } else if (event.type !== 'heartbeat') {
    return { ok: false, code: 'invalid-event-type' };
  }
  next.sequence = event.sequence;
  next.lastEventHash = eventHash;
  next.heartbeatAt = new Date(now).toISOString();
  next.expiresAt = new Date(now + ttlSeconds * 1000).toISOString();
  if (!validSession(next)) return { ok: false, code: 'invalid-event-state' };
  return { ok: true, session: next, repeated: false, closed: event.type === 'finish' };
}
