// SPDX-License-Identifier: LicenseRef-holt-Commercial
// Commercial license — see src/team/LICENSE. NOT covered by the repository FSL-1.1-MIT grant.
/**
 * Strict, bounded schemas for customer-controlled managed policy.
 *
 * This module validates documents; it does not authenticate them. In particular, a TUF metadata
 * envelope being well-formed is not evidence that its signatures verify. The future TUF adapter
 * owns that boundary and hands the store an already-verified, byte-bound staging receipt.
 */

import { validatePolicyObject } from './policy.mjs';

export const MANAGED_POLICY_VERSION = 1;
export const MAX_MANAGED_POLICY_BYTES = 1024 * 1024;
export const MAX_BOOTSTRAP_ROOT_BYTES = 2 * 1024 * 1024;
export const MAX_METADATA_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_METADATA_TOTAL_BYTES = 16 * 1024 * 1024;
export const MAX_METADATA_FILES = 128;
export const MAX_JSON_DEPTH = 24;
export const MAX_JSON_NODES = 20_000;

const SHA256_RE = /^[a-f0-9]{64}$/;
const PROFILE_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const POLICY_ID_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const REPOSITORY_ID_RE = /^[a-z][a-z0-9.-]{0,31}:[A-Za-z0-9][A-Za-z0-9._~:/@+-]{0,479}$/;
const METADATA_COMPONENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/u;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const lexicalCompare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

export class ManagedPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ManagedPolicyError';
    this.code = code;
  }
}

/** @returns {never} */
export function managedPolicyRefuse(code, message) {
  throw new ManagedPolicyError(code, message);
}

/** @type {any} */
let _jsonc = null;
async function loadJsonParser() {
  if (_jsonc !== null) return _jsonc;
  try { _jsonc = await import('jsonc-parser'); } catch { _jsonc = false; }
  return _jsonc;
}
await loadJsonParser();

function parser() {
  if (!_jsonc) {
    managedPolicyRefuse(
      'MANAGED_POLICY_DEPENDENCY',
      "managed policy requires its exact 'jsonc-parser' runtime dependency; reinstall holt from an intact release",
    );
  }
  return _jsonc;
}

function assertPlainObject(value, label) {
  const prototype = value && typeof value === 'object' ? Object.getPrototypeOf(value) : null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (prototype !== Object.prototype && prototype !== null)) {
    managedPolicyRefuse('MANAGED_POLICY_SCHEMA', `${label} must be a JSON object`);
  }
}

function assertExactKeys(value, allowed, label) {
  assertPlainObject(value, label);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      managedPolicyRefuse(
        'MANAGED_POLICY_SCHEMA',
        `${label} has unknown key '${key}' (known: ${[...allowed].sort().join(', ')})`,
      );
    }
  }
}

function assertSafeString(value, label, { max = 4096, nonempty = true, ascii = false } = {}) {
  if (typeof value !== 'string' || (nonempty && value.length === 0)) {
    managedPolicyRefuse('MANAGED_POLICY_SCHEMA', `${label} must be ${nonempty ? 'a non-empty' : 'a'} string`);
  }
  if (value.length > max) {
    managedPolicyRefuse('MANAGED_POLICY_LIMIT', `${label} exceeds the ${max}-character limit`);
  }
  if (CONTROL_RE.test(value)) {
    managedPolicyRefuse('MANAGED_POLICY_CONTROL', `${label} contains a control character`);
  }
  if (value !== value.normalize('NFC')) {
    managedPolicyRefuse('MANAGED_POLICY_UNICODE', `${label} is not Unicode NFC-normalized`);
  }
  if (ascii && /[^\x20-\x7e]/u.test(value)) {
    managedPolicyRefuse('MANAGED_POLICY_UNICODE', `${label} must use printable ASCII`);
  }
  return value;
}

/**
 * @param {any} node
 * @param {string} label
 * @param {{allowEscapedNewlinesAt?: ((pointer: string) => boolean)|null}} [options]
 */
function inspectJsonTree(node, label, { allowEscapedNewlinesAt = null } = {}) {
  let nodes = 0;
  const walk = (current, pointer, depth) => {
    nodes++;
    if (nodes > MAX_JSON_NODES) {
      managedPolicyRefuse('MANAGED_POLICY_LIMIT', `${label} exceeds the ${MAX_JSON_NODES}-node JSON limit`);
    }
    if (depth > MAX_JSON_DEPTH) {
      managedPolicyRefuse('MANAGED_POLICY_LIMIT', `${label} exceeds the maximum JSON depth of ${MAX_JSON_DEPTH}`);
    }

    if (current.type === 'object') {
      const seen = new Set();
      for (const property of current.children ?? []) {
        const keyNode = property.children?.[0];
        const valueNode = property.children?.[1];
        const key = keyNode?.value;
        if (typeof key !== 'string' || !valueNode) {
          managedPolicyRefuse('MANAGED_POLICY_PARSE', `${label} contains an unreadable object member at ${pointer}`);
        }
        assertSafeString(key, `${label} key at ${pointer}`, { max: 128 });
        if (DANGEROUS_KEYS.has(key)) {
          managedPolicyRefuse('MANAGED_POLICY_SCHEMA', `${label} uses forbidden key '${key}' at ${pointer}`);
        }
        if (seen.has(key)) {
          managedPolicyRefuse('MANAGED_POLICY_DUPLICATE_KEY', `${label} repeats key '${key}' at ${pointer}`);
        }
        seen.add(key);
        walk(valueNode, `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`, depth + 1);
      }
      return;
    }
    if (current.type === 'array') {
      for (let i = 0; i < (current.children ?? []).length; i++) {
        walk(current.children[i], `${pointer}/${i}`, depth + 1);
      }
      return;
    }
    if (current.type === 'string') {
      if (allowEscapedNewlinesAt?.(pointer)) {
        // Standard TUF RSA/ECDSA keys may be PEM strings. JSON's parser still rejects literal raw
        // newlines; this narrowly permits decoded \\n / \\r\\n only in keyval.public, while all other
        // controls and every managed-policy string retain the normal refusal.
        const withoutLineBreaks = current.value.replaceAll('\r\n', '').replaceAll('\n', '');
        assertSafeString(withoutLineBreaks, `${label} string at ${pointer}`, { max: 16_384, nonempty: false });
        if (current.value.length > 16_384) {
          managedPolicyRefuse('MANAGED_POLICY_LIMIT', `${label} string at ${pointer} exceeds the 16384-character limit`);
        }
      } else {
        assertSafeString(current.value, `${label} string at ${pointer}`, { max: 16_384, nonempty: false });
      }
    }
    if (current.type === 'number' && !Number.isFinite(current.value)) {
      managedPolicyRefuse('MANAGED_POLICY_SCHEMA', `${label} has a non-finite number at ${pointer}`);
    }
  };
  walk(node, '', 0);
}

/** Parse JSON without comments, trailing commas, duplicate keys, control text, or unbounded depth. */
export function parseStrictJson(raw, label = 'managed policy JSON', { maxBytes = MAX_MANAGED_POLICY_BYTES } = {}) {
  let text;
  try {
    text = Buffer.isBuffer(raw)
      ? new TextDecoder('utf-8', { fatal: true }).decode(raw)
      : String(raw);
  } catch {
    managedPolicyRefuse('MANAGED_POLICY_ENCODING', `${label} is not valid UTF-8`);
  }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    managedPolicyRefuse('MANAGED_POLICY_LIMIT', `${label} exceeds the ${maxBytes}-byte limit`);
  }
  const errors = [];
  const tree = parser().parseTree(text, errors, { allowTrailingComma: false, disallowComments: true });
  if (!tree || errors.length) {
    managedPolicyRefuse(
      'MANAGED_POLICY_PARSE',
      `${label} is not strict JSON (${errors.length || 1} parse error(s)); comments and trailing commas are not accepted`,
    );
  }
  inspectJsonTree(tree, label);
  return parser().getNodeValue(tree);
}

/** Strict JSON for one TUF root envelope, with PEM line breaks allowed only at keyval.public. */
export function parseStrictTufRoot(raw, label = 'TUF root.json', { maxBytes = MAX_BOOTSTRAP_ROOT_BYTES } = {}) {
  let text;
  try {
    text = Buffer.isBuffer(raw)
      ? new TextDecoder('utf-8', { fatal: true }).decode(raw)
      : String(raw);
  } catch {
    managedPolicyRefuse('MANAGED_POLICY_ENCODING', `${label} is not valid UTF-8`);
  }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    managedPolicyRefuse('MANAGED_POLICY_LIMIT', `${label} exceeds the ${maxBytes}-byte limit`);
  }
  const errors = [];
  const tree = parser().parseTree(text, errors, { allowTrailingComma: false, disallowComments: true });
  if (!tree || errors.length) {
    managedPolicyRefuse(
      'MANAGED_POLICY_PARSE',
      `${label} is not strict JSON (${errors.length || 1} parse error(s)); comments and trailing commas are not accepted`,
    );
  }
  inspectJsonTree(tree, label, {
    allowEscapedNewlinesAt: (pointer) => /^\/signed\/keys\/[^/]+\/keyval\/public$/u.test(pointer),
  });
  return parser().getNodeValue(tree);
}

export function assertProfileName(profile, label = 'profile') {
  assertSafeString(profile, label, { max: 64, ascii: true });
  if (!PROFILE_RE.test(profile) || profile === '.' || profile === '..') {
    managedPolicyRefuse(
      'MANAGED_POLICY_PATH',
      `${label} must be a 1-64 character lowercase ASCII identifier without path separators`,
    );
  }
  return profile;
}

export function assertSha256(value, label = 'sha256') {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    managedPolicyRefuse('MANAGED_POLICY_HASH', `${label} must be a lowercase 64-character SHA-256 hex digest`);
  }
  return value;
}

export function assertRepositoryIdentity(identity, label = 'repository identity') {
  assertSafeString(identity, label, { max: 512, ascii: true });
  if (!REPOSITORY_ID_RE.test(identity) || identity.includes('\\') || /(?:^|\/)\.\.?($|\/)/u.test(identity)) {
    managedPolicyRefuse(
      'MANAGED_POLICY_REPOSITORY',
      `${label} must be an exact authority-qualified identity such as 'github-repository-id:123456'`,
    );
  }
  return identity;
}

export function assertMetadataPath(relative, label = 'metadata path') {
  assertSafeString(relative, label, { max: 512, ascii: true });
  if (pathLikeAbsolute(relative) || relative.includes('\\')) {
    managedPolicyRefuse('MANAGED_POLICY_PATH', `${label} must be a relative POSIX path`);
  }
  const parts = relative.split('/');
  if (!parts.length || parts.length > 8 || parts.some((part) => !METADATA_COMPONENT_RE.test(part) || part === '.' || part === '..')) {
    managedPolicyRefuse('MANAGED_POLICY_PATH', `${label} contains an unsafe component`);
  }
  return relative;
}

function pathLikeAbsolute(value) {
  return value.startsWith('/') || /^[A-Za-z]:/u.test(value) || value.startsWith('//');
}

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    managedPolicyRefuse('MANAGED_POLICY_SCHEMA', `${label} must be a positive safe integer`);
  }
  return value;
}

function validateVersions(value, label) {
  assertExactKeys(value, new Set(['root', 'timestamp', 'snapshot', 'targets']), label);
  for (const key of ['root', 'timestamp', 'snapshot', 'targets']) positiveSafeInteger(value[key], `${label}.${key}`);
  return value;
}

function assertRfc3339(value, label) {
  assertSafeString(value, label, { max: 64, ascii: true });
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/u.exec(value);
  const timestamp = Date.parse(value);
  const date = Number.isFinite(timestamp) ? new Date(timestamp) : null;
  // Date.parse normalizes some impossible calendar dates instead of rejecting them (for example,
  // 2026-02-30 becomes March 2). Round-trip every calendar/time field so a verifier cannot sign
  // one spelling while freshness is enforced against a different instant. Fractional precision is
  // intentionally allowed through nanoseconds; Date only truncates that sub-millisecond tail and
  // does not alter any field compared here.
  if (!match || date === null
    || date.getUTCFullYear() !== Number(match[1])
    || date.getUTCMonth() + 1 !== Number(match[2])
    || date.getUTCDate() !== Number(match[3])
    || date.getUTCHours() !== Number(match[4])
    || date.getUTCMinutes() !== Number(match[5])
    || date.getUTCSeconds() !== Number(match[6])) {
    managedPolicyRefuse('MANAGED_POLICY_SCHEMA', `${label} must be an RFC 3339 UTC timestamp`);
  }
  return value;
}

function validateExpiry(value, label) {
  assertExactKeys(value, new Set(['timestamp', 'snapshot', 'targets']), label);
  for (const role of ['timestamp', 'snapshot', 'targets']) assertRfc3339(value[role], `${label}.${role}`);
  return value;
}

function validateFreshnessWindow(verifiedAt, expires, label) {
  const verifiedMs = Date.parse(verifiedAt);
  for (const role of ['timestamp', 'snapshot', 'targets']) {
    if (Date.parse(expires[role]) <= verifiedMs) {
      managedPolicyRefuse(
        'MANAGED_POLICY_EXPIRED',
        `${label}.${role} was already expired when the verifier issued the receipt`,
      );
    }
  }
}

function validateMetadataManifest(value, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_METADATA_FILES) {
    managedPolicyRefuse(
      'MANAGED_POLICY_SCHEMA',
      `${label} must contain 1-${MAX_METADATA_FILES} verified metadata file entries`,
    );
  }
  const seen = new Set();
  let total = 0;
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    assertExactKeys(item, new Set(['path', 'sha256', 'length']), `${label}[${i}]`);
    assertMetadataPath(item.path, `${label}[${i}].path`);
    assertSha256(item.sha256, `${label}[${i}].sha256`);
    positiveSafeInteger(item.length, `${label}[${i}].length`);
    if (item.length > MAX_METADATA_FILE_BYTES) {
      managedPolicyRefuse('MANAGED_POLICY_LIMIT', `${label}[${i}] exceeds the metadata file limit`);
    }
    total += item.length;
    if (total > MAX_METADATA_TOTAL_BYTES) {
      managedPolicyRefuse('MANAGED_POLICY_LIMIT', `${label} exceeds the metadata byte limit`);
    }
    if (seen.has(item.path)) {
      managedPolicyRefuse('MANAGED_POLICY_SCHEMA', `${label} repeats metadata path '${item.path}'`);
    }
    seen.add(item.path);
    if (i > 0 && lexicalCompare(value[i - 1].path, item.path) >= 0) {
      managedPolicyRefuse('MANAGED_POLICY_SCHEMA', `${label} must be strictly sorted by path`);
    }
  }
  return value;
}

/** Validate the central policy target after its bytes have been parsed strictly. */
export function validateManagedPolicyObject(doc, label = 'managed policy') {
  assertExactKeys(doc, new Set(['version', 'profile', 'description', 'policies', 'assignments']), label);
  if (doc.version !== MANAGED_POLICY_VERSION) {
    managedPolicyRefuse('MANAGED_POLICY_VERSION', `${label} has unsupported version ${JSON.stringify(doc.version)}`);
  }
  assertProfileName(doc.profile, `${label}.profile`);
  if (doc.description !== undefined) assertSafeString(doc.description, `${label}.description`, { max: 2048 });

  if (!Array.isArray(doc.policies) || doc.policies.length < 1 || doc.policies.length > 64) {
    managedPolicyRefuse('MANAGED_POLICY_SCHEMA', `${label}.policies must contain 1-64 policy definitions`);
  }
  const policies = new Map();
  for (let i = 0; i < doc.policies.length; i++) {
    const entry = doc.policies[i];
    assertExactKeys(entry, new Set(['id', 'policy']), `${label}.policies[${i}]`);
    assertSafeString(entry.id, `${label}.policies[${i}].id`, { max: 64, ascii: true });
    if (!POLICY_ID_RE.test(entry.id)) {
      managedPolicyRefuse('MANAGED_POLICY_SCHEMA', `${label}.policies[${i}].id is not a canonical policy id`);
    }
    if (policies.has(entry.id)) {
      managedPolicyRefuse('MANAGED_POLICY_SCHEMA', `${label} repeats policy id '${entry.id}'`);
    }
    validatePolicyObject(entry.policy, `${label}.policies[${i}].policy`);
    if (entry.policy.rules.length > 256) {
      managedPolicyRefuse('MANAGED_POLICY_LIMIT', `${label} policy '${entry.id}' exceeds 256 rules`);
    }
    policies.set(entry.id, entry.policy);
  }

  if (!Array.isArray(doc.assignments) || doc.assignments.length < 1 || doc.assignments.length > 4096) {
    managedPolicyRefuse('MANAGED_POLICY_SCHEMA', `${label}.assignments must contain 1-4096 exact repository assignments`);
  }
  const repositories = new Set();
  const usedPolicies = new Set();
  for (let i = 0; i < doc.assignments.length; i++) {
    const assignment = doc.assignments[i];
    assertExactKeys(assignment, new Set(['repository', 'policies']), `${label}.assignments[${i}]`);
    assertRepositoryIdentity(assignment.repository, `${label}.assignments[${i}].repository`);
    if (repositories.has(assignment.repository)) {
      managedPolicyRefuse('MANAGED_POLICY_SCHEMA', `${label} assigns repository '${assignment.repository}' more than once`);
    }
    repositories.add(assignment.repository);
    if (!Array.isArray(assignment.policies) || assignment.policies.length < 1 || assignment.policies.length > 64) {
      managedPolicyRefuse('MANAGED_POLICY_SCHEMA', `${label}.assignments[${i}].policies must contain 1-64 policy ids`);
    }
    const local = new Set();
    for (let j = 0; j < assignment.policies.length; j++) {
      const id = assignment.policies[j];
      assertSafeString(id, `${label}.assignments[${i}].policies[${j}]`, { max: 64, ascii: true });
      if (!policies.has(id)) {
        managedPolicyRefuse('MANAGED_POLICY_SCHEMA', `${label} assignment for '${assignment.repository}' references unknown policy '${id}'`);
      }
      if (local.has(id)) {
        managedPolicyRefuse('MANAGED_POLICY_SCHEMA', `${label} assignment for '${assignment.repository}' repeats policy '${id}'`);
      }
      local.add(id);
      usedPolicies.add(id);
    }
  }
  const unused = [...policies.keys()].filter((id) => !usedPolicies.has(id));
  if (unused.length) {
    managedPolicyRefuse(
      'MANAGED_POLICY_VACUOUS',
      `${label} defines unassigned policy ${unused.map((id) => `'${id}'`).join(', ')}; remove it or assign it explicitly`,
    );
  }
  return doc;
}

export function parseManagedPolicy(raw, label = 'policy.json') {
  return validateManagedPolicyObject(parseStrictJson(raw, label), label);
}

export function validateManagedTrustObject(doc, label = 'trust.json') {
  assertExactKeys(doc, new Set(['version', 'profile', 'authority', 'rootSha256', 'repositoryBindings']), label);
  if (doc.version !== MANAGED_POLICY_VERSION) {
    managedPolicyRefuse('MANAGED_POLICY_VERSION', `${label} has unsupported version ${JSON.stringify(doc.version)}`);
  }
  assertProfileName(doc.profile, `${label}.profile`);
  if (doc.authority !== 'system' && doc.authority !== 'user') {
    managedPolicyRefuse('MANAGED_POLICY_AUTHORITY', `${label}.authority must be 'system' or 'user'`);
  }
  assertSha256(doc.rootSha256, `${label}.rootSha256`);
  if (!Array.isArray(doc.repositoryBindings) || doc.repositoryBindings.length > 4096) {
    managedPolicyRefuse('MANAGED_POLICY_SCHEMA', `${label}.repositoryBindings must be an array of at most 4096 entries`);
  }
  const roots = new Set();
  for (let i = 0; i < doc.repositoryBindings.length; i++) {
    const binding = doc.repositoryBindings[i];
    assertExactKeys(binding, new Set(['root', 'identity', 'device', 'inode']), `${label}.repositoryBindings[${i}]`);
    assertSafeString(binding.root, `${label}.repositoryBindings[${i}].root`, { max: 4096 });
    assertRepositoryIdentity(binding.identity, `${label}.repositoryBindings[${i}].identity`);
    if (typeof binding.device !== 'string' || !/^\d+$/u.test(binding.device)
      || typeof binding.inode !== 'string' || !/^\d+$/u.test(binding.inode)) {
      managedPolicyRefuse('MANAGED_POLICY_SCHEMA', `${label}.repositoryBindings[${i}] needs decimal device and inode strings`);
    }
    if (roots.has(binding.root)) {
      managedPolicyRefuse('MANAGED_POLICY_SCHEMA', `${label} repeats repository root '${binding.root}'`);
    }
    roots.add(binding.root);
  }
  return doc;
}

export function parseManagedTrust(raw, label = 'trust.json') {
  return validateManagedTrustObject(parseStrictJson(raw, label, { maxBytes: 16 * 1024 }), label);
}

export function validateStagedVerificationObject(doc, label = 'staged verification receipt') {
  assertExactKeys(doc, new Set(['version', 'profile', 'target', 'rootSha256', 'versions', 'metadata', 'verifiedAt', 'expires']), label);
  if (doc.version !== MANAGED_POLICY_VERSION) {
    managedPolicyRefuse('MANAGED_POLICY_VERSION', `${label} has unsupported version ${JSON.stringify(doc.version)}`);
  }
  assertProfileName(doc.profile, `${label}.profile`);
  assertExactKeys(doc.target, new Set(['path', 'sha256', 'length']), `${label}.target`);
  if (doc.target.path !== 'policy.json') {
    managedPolicyRefuse('MANAGED_POLICY_SCHEMA', `${label}.target.path must be exactly 'policy.json'`);
  }
  assertSha256(doc.target.sha256, `${label}.target.sha256`);
  positiveSafeInteger(doc.target.length, `${label}.target.length`);
  if (doc.target.length > MAX_MANAGED_POLICY_BYTES) {
    managedPolicyRefuse('MANAGED_POLICY_LIMIT', `${label}.target exceeds the managed-policy byte limit`);
  }
  assertSha256(doc.rootSha256, `${label}.rootSha256`);
  validateVersions(doc.versions, `${label}.versions`);
  validateMetadataManifest(doc.metadata, `${label}.metadata`);
  assertRfc3339(doc.verifiedAt, `${label}.verifiedAt`);
  validateExpiry(doc.expires, `${label}.expires`);
  validateFreshnessWindow(doc.verifiedAt, doc.expires, `${label}.expires`);
  return doc;
}

export function validateActivationReceiptObject(doc, label = 'activation.json') {
  assertExactKeys(
    doc,
    new Set(['version', 'profile', 'generation', 'targetSha256', 'policyLength', 'rootSha256', 'versions', 'metadata', 'metadataTreeSha256', 'verifiedAt', 'expires']),
    label,
  );
  if (doc.version !== MANAGED_POLICY_VERSION) {
    managedPolicyRefuse('MANAGED_POLICY_VERSION', `${label} has unsupported version ${JSON.stringify(doc.version)}`);
  }
  assertProfileName(doc.profile, `${label}.profile`);
  assertSha256(doc.generation, `${label}.generation`);
  assertSha256(doc.targetSha256, `${label}.targetSha256`);
  positiveSafeInteger(doc.policyLength, `${label}.policyLength`);
  if (doc.policyLength > MAX_MANAGED_POLICY_BYTES) {
    managedPolicyRefuse('MANAGED_POLICY_LIMIT', `${label}.policyLength exceeds the managed-policy byte limit`);
  }
  assertSha256(doc.rootSha256, `${label}.rootSha256`);
  validateVersions(doc.versions, `${label}.versions`);
  validateMetadataManifest(doc.metadata, `${label}.metadata`);
  assertSha256(doc.metadataTreeSha256, `${label}.metadataTreeSha256`);
  assertRfc3339(doc.verifiedAt, `${label}.verifiedAt`);
  validateExpiry(doc.expires, `${label}.expires`);
  validateFreshnessWindow(doc.verifiedAt, doc.expires, `${label}.expires`);
  return doc;
}

export function parseActivationReceipt(raw, label = 'activation.json') {
  return validateActivationReceiptObject(parseStrictJson(raw, label, { maxBytes: 128 * 1024 }), label);
}

export function validateActivePointerObject(doc, label = 'active.json') {
  assertExactKeys(
    doc,
    new Set(['version', 'profile', 'generation', 'targetSha256', 'activationSha256', 'rootSha256', 'versions', 'verifiedAt', 'expires']),
    label,
  );
  if (doc.version !== MANAGED_POLICY_VERSION) {
    managedPolicyRefuse('MANAGED_POLICY_VERSION', `${label} has unsupported version ${JSON.stringify(doc.version)}`);
  }
  assertProfileName(doc.profile, `${label}.profile`);
  assertSha256(doc.generation, `${label}.generation`);
  assertSha256(doc.targetSha256, `${label}.targetSha256`);
  assertSha256(doc.activationSha256, `${label}.activationSha256`);
  assertSha256(doc.rootSha256, `${label}.rootSha256`);
  validateVersions(doc.versions, `${label}.versions`);
  assertRfc3339(doc.verifiedAt, `${label}.verifiedAt`);
  validateExpiry(doc.expires, `${label}.expires`);
  validateFreshnessWindow(doc.verifiedAt, doc.expires, `${label}.expires`);
  return doc;
}

export function parseActivePointer(raw, label = 'active.json') {
  return validateActivePointerObject(parseStrictJson(raw, label, { maxBytes: 16 * 1024 }), label);
}

export function validateManagedTransitionObject(doc, label = 'transition.json') {
  assertExactKeys(
    doc,
    new Set(['version', 'profile', 'transaction', 'incoming', 'nextActive', 'previousActive']),
    label,
  );
  if (doc.version !== MANAGED_POLICY_VERSION) {
    managedPolicyRefuse('MANAGED_POLICY_VERSION', `${label} has unsupported version ${JSON.stringify(doc.version)}`);
  }
  assertProfileName(doc.profile, `${label}.profile`);
  assertSafeString(doc.transaction, `${label}.transaction`, { max: 36, ascii: true });
  if (!/^[a-f0-9-]{36}$/u.test(doc.transaction)) {
    managedPolicyRefuse('MANAGED_POLICY_SCHEMA', `${label}.transaction must be a lowercase UUID`);
  }
  assertSafeString(doc.incoming, `${label}.incoming`, { max: 64, ascii: true });
  if (!/^\.incoming-[a-f0-9-]{36}$/u.test(doc.incoming)) {
    managedPolicyRefuse('MANAGED_POLICY_PATH', `${label}.incoming must be one generated incoming-directory name`);
  }
  validateActivePointerObject(doc.nextActive, `${label}.nextActive`);
  if (doc.nextActive.profile !== doc.profile) {
    managedPolicyRefuse('MANAGED_POLICY_PROFILE', `${label}.nextActive is not bound to profile '${doc.profile}'`);
  }
  if (doc.previousActive !== null) {
    validateActivePointerObject(doc.previousActive, `${label}.previousActive`);
    if (doc.previousActive.profile !== doc.profile) {
      managedPolicyRefuse('MANAGED_POLICY_PROFILE', `${label}.previousActive is not bound to profile '${doc.profile}'`);
    }
  }
  return doc;
}

export function parseManagedTransition(raw, label = 'transition.json') {
  return validateManagedTransitionObject(parseStrictJson(raw, label, { maxBytes: 32 * 1024 }), label);
}

/** Stable serialization for byte hashes and receipts. Objects are key-sorted recursively. */
export function canonicalJson(value) {
  const normalize = (item) => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, normalize(item[key])]));
    }
    return item;
  };
  return `${JSON.stringify(normalize(value), null, 2)}\n`;
}
