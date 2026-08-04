// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — tamper-evident log primitives.
 *
 * NOTHING HERE IS INVENTED. Every construction is a published, frozen wire format, because a
 * compliance artefact whose integrity scheme is bespoke is worth exactly as much as the vendor's
 * word — which is the problem it exists to solve. An auditor can hand the checkpoint this module
 * emits to any RFC 6962 / C2SP verifier and get the same answer holt gives.
 *
 *   - RFC 6962 §2.1 Merkle Tree Hash — the Certificate Transparency construction (Crosby–Wallach
 *     2009). DOMAIN SEPARATION is the whole point: leaves hash with a 0x00 prefix and internal
 *     nodes with 0x01, so no interior node can ever be presented as a leaf. A generic Merkle
 *     helper (merkletreejs and friends) does NOT do this by default and produces a tree no
 *     external verifier recognises — hence a ~60-line implementation here rather than a
 *     dependency, and a test that FAILS if the domain separation is removed.
 *   - RFC 6962 §2.1.1 inclusion proof + verification — self-contained, offline, no log server.
 *   - C2SP `tlog-checkpoint` — the checkpoint body: origin line, tree size in ASCII decimal,
 *     base64 root hash, optional extension lines. Explicitly offline-verifiable by design.
 *   - `golang.org/x/mod/sumdb/note` signed notes — the signature envelope C2SP checkpoints use:
 *     body, blank line, then `— <name> <base64(keyID‖sig)>` lines. The 4-byte key ID is
 *     SHA-256(name ‖ "\n" ‖ 0x01 ‖ rawEd25519PublicKey)[0:4].
 *
 * WHAT THIS PROVES, STATED HONESTLY. A hash chain plus a checkpoint makes any edit, insertion,
 * deletion, reorder or truncation of the journal DETECTABLE. It does not make it IMPOSSIBLE:
 * whoever can write the journal can usually write the checkpoint beside it, recompute both, and
 * present a consistent forgery. Tamper-EVIDENT, not tamper-proof — the same line src/license.mjs
 * draws. What closes that gap is a signature from a key the writer does not hold, which is why
 * signed checkpoints belong on the aggregation host (see src/team/audit-sink.mjs), not on every
 * developer laptop where the key would have to live next to the log it protects.
 */

import { createHash, createPublicKey, sign as edSign, verify as edVerify } from 'node:crypto';

/** RFC 6962 §2.1 domain-separation prefixes. Changing either one forks the tree. */
export const LEAF_PREFIX = 0x00;
export const NODE_PREFIX = 0x01;

const sha256 = (buf) => createHash('sha256').update(buf).digest();
const buf = (d) => (Buffer.isBuffer(d) ? d : Buffer.from(d, 'utf8'));

/** MTH({d}) = SHA-256(0x00 ‖ d) */
export function leafHash(data) {
  return sha256(Buffer.concat([Buffer.from([LEAF_PREFIX]), buf(data)]));
}

/** MTH(D) = SHA-256(0x01 ‖ MTH(left) ‖ MTH(right)) */
export function nodeHash(left, right) {
  return sha256(Buffer.concat([Buffer.from([NODE_PREFIX]), buf(left), buf(right)]));
}

/** MTH({}) = SHA-256() — the empty tree hashes the empty string, per RFC 6962. */
export function emptyRoot() {
  return sha256(Buffer.alloc(0));
}

/** k = the largest power of two STRICTLY less than n. The tree is left-heavy, never balanced. */
export function splitPoint(n) {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/**
 * Merkle Tree Hash over an ordered list of ALREADY-HASHED leaves (each from leafHash).
 * Iterative rather than recursive: a journal is unbounded and blowing the stack on a large
 * audit log would be a denial of the exact artefact an auditor came for.
 */
export function merkleRoot(leaves) {
  if (!leaves.length) return emptyRoot();
  // Fold the left-heavy RFC 6962 tree with an explicit stack of perfect-subtree roots. Each
  // entry is [level, hash]; two equal levels combine. This yields the identical shape as the
  // recursive definition — the test asserts that against a literal recursive implementation.
  const stack = [];
  for (const leaf of leaves) {
    let node = buf(leaf);
    let level = 0;
    while (stack.length && stack[stack.length - 1][0] === level) {
      node = nodeHash(stack.pop()[1], node);
      level += 1;
    }
    stack.push([level, node]);
  }
  // Fold the remaining (strictly increasing-level) partial subtrees right-to-left.
  let root = stack.pop()[1];
  while (stack.length) root = nodeHash(stack.pop()[1], root);
  return root;
}

/**
 * RFC 6962 §2.1.1 audit path for leaf `m` in a tree of `leaves`.
 * Ordered leaf-to-root, exactly as a CT verifier expects.
 */
export function inclusionProof(leaves, m) {
  if (!Number.isInteger(m) || m < 0 || m >= leaves.length) {
    throw new RangeError(`inclusionProof: leaf index ${m} is outside a tree of ${leaves.length}`);
  }
  const path = [];
  const walk = (lo, hi, i) => {
    const n = hi - lo;
    if (n === 1) return;
    const k = splitPoint(n);
    if (i - lo < k) { walk(lo, lo + k, i); path.push(merkleRoot(leaves.slice(lo + k, hi))); }
    else { walk(lo + k, hi, i); path.push(merkleRoot(leaves.slice(lo, lo + k))); }
  };
  walk(0, leaves.length, m);
  return path;
}

/**
 * RFC 6962 §2.1.1 inclusion verification. Takes only the leaf hash, its index, the tree size,
 * the proof and the claimed root — it never sees the log. That is the property that makes a
 * proof "fit the abstraction of a detached digital signature" (C2SP tlog-proof).
 */
export function verifyInclusion(leaf, m, n, proof, root) {
  if (!Number.isInteger(m) || !Number.isInteger(n) || m < 0 || n <= 0 || m >= n) return false;
  let fn = m;
  let sn = n - 1;
  let r = buf(leaf);
  for (const p of proof) {
    if (sn === 0) return false; // proof longer than the tree can justify
    if ((fn & 1) === 1 || fn === sn) {
      r = nodeHash(buf(p), r);
      while (fn !== 0 && (fn & 1) === 0) { fn >>= 1; sn >>= 1; }
    } else {
      r = nodeHash(r, buf(p));
    }
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 && r.equals(buf(root));
}

/* ============================================================ CANONICAL JSON ==== */

/**
 * Deterministic serialisation: object keys sorted, no insignificant whitespace, `undefined`
 * dropped. The hash must not depend on the order a caller happened to build the object in —
 * two byte strings that parse to the same object sharing one hash is the canonicalisation hole
 * src/license.mjs already refuses for signatures, and it is the same hole here.
 */
export function canonicalJson(v) {
  if (v === undefined) return undefined;
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isFinite(v)) {
      throw new TypeError('canonicalJson: non-finite numbers have no canonical form');
    }
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x) ?? 'null').join(',')}]`;
  const parts = [];
  for (const k of Object.keys(v).sort()) {
    const s = canonicalJson(v[k]);
    if (s !== undefined) parts.push(`${JSON.stringify(k)}:${s}`);
  }
  return `{${parts.join(',')}}`;
}

/** The leaf hash of one journal entry, as written. */
export function entryLeaf(entry) {
  return leafHash(canonicalJson(entry));
}

/* ========================================================= C2SP CHECKPOINT ==== */

/**
 * C2SP `tlog-checkpoint` body:
 *
 *     <origin>\n<size>\n<base64 root hash>\n[<extension line>\n...]
 *
 * Size is ASCII decimal with no leading zeros; the root hash is standard base64 (padded), not
 * base64url — that is what the format specifies and what other verifiers expect.
 */
export function formatCheckpoint({ origin, size, root, extensions = [] }) {
  if (typeof origin !== 'string' || !origin || origin.includes('\n')) {
    throw new TypeError('checkpoint origin must be a single non-empty line');
  }
  if (!Number.isInteger(size) || size < 0) throw new TypeError('checkpoint size must be a non-negative integer');
  const lines = [origin, String(size), buf(root).toString('base64'), ...extensions];
  return `${lines.join('\n')}\n`;
}

/** Parse a checkpoint body (or a signed note — the body is taken up to the first blank line). */
export function parseCheckpoint(text) {
  if (typeof text !== 'string' || !text) throw new TypeError('checkpoint is empty');
  const body = text.split('\n\n')[0];
  const lines = body.split('\n').filter((l, i, a) => !(i === a.length - 1 && l === ''));
  if (lines.length < 3) throw new TypeError('checkpoint has fewer than the three required lines');
  const [origin, sizeLine, rootLine, ...extensions] = lines;
  if (!/^(0|[1-9][0-9]*)$/.test(sizeLine)) throw new TypeError(`checkpoint size '${sizeLine}' is not ASCII decimal`);
  const root = Buffer.from(rootLine, 'base64');
  if (root.length !== 32 || root.toString('base64') !== rootLine) {
    throw new TypeError('checkpoint root hash is not a base64 SHA-256 digest');
  }
  return { origin, size: Number(sizeLine), root, extensions };
}

/* ======================================================= SIGNED NOTES (x/mod) ==== */

/**
 * The raw 32-byte Ed25519 public key, via JWK so no DER offsets are hand-parsed.
 *
 * Accepts a private key, a public key, a PEM or a KeyObject. `createPublicKey` REFUSES a
 * KeyObject that is already public (`ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE`), which is a sharp
 * edge worth absorbing here rather than at every call site.
 */
export function rawEd25519Public(key) {
  const pub = (key && typeof key === 'object' && key.type === 'public') ? key : createPublicKey(key);
  const jwk = pub.export({ format: 'jwk' });
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !jwk.x) {
    throw new TypeError('not an Ed25519 public key');
  }
  return Buffer.from(jwk.x, 'base64url');
}

/** note key ID = SHA-256(name ‖ "\n" ‖ 0x01 ‖ rawPublicKey)[0:4]  (0x01 = Ed25519 algorithm). */
export function noteKeyId(name, publicKey) {
  return sha256(Buffer.concat([
    Buffer.from(`${name}\n`, 'utf8'), Buffer.from([0x01]), rawEd25519Public(publicKey),
  ])).subarray(0, 4);
}

/** Sign a checkpoint body into a signed note. `body` must already end with a newline. */
export function signNote(body, { name, privateKey }) {
  if (!body.endsWith('\n')) throw new TypeError('a note body must end with a newline');
  if (!name || /[\s\n]/.test(name)) throw new TypeError('a note signer name must be non-empty and contain no whitespace');
  const sig = edSign(null, Buffer.from(body, 'utf8'), privateKey);
  const id = noteKeyId(name, privateKey);
  return `${body}\n— ${name} ${Buffer.concat([id, sig]).toString('base64')}\n`;
}

/**
 * Verify a signed note against a set of trusted public keys.
 * Returns {valid, body, signatures:[{name, keyId, verified}]}. An unsigned note is `valid:false`
 * with `reason` — absence of a signature is never silently treated as a pass.
 *
 * @param {string} text
 * @param {{keys?: any[]}} [opts]
 */
export function verifyNote(text, { keys = [] } = {}) {
  const sep = text.indexOf('\n\n');
  if (sep < 0) return { valid: false, reason: 'note has no signature block', body: text, signatures: [] };
  const body = text.slice(0, sep + 1);
  const sigLines = text.slice(sep + 2).split('\n').filter(Boolean);
  if (!sigLines.length) return { valid: false, reason: 'note has an empty signature block', body, signatures: [] };

  const signatures = [];
  for (const line of sigLines) {
    const m = /^— (\S+) (\S+)$/.exec(line);
    if (!m) { signatures.push({ line, verified: false, reason: 'malformed signature line' }); continue; }
    const [, name, b64] = m;
    const raw = Buffer.from(b64, 'base64');
    if (raw.length !== 4 + 64) { signatures.push({ name, verified: false, reason: 'signature is not keyID‖ed25519' }); continue; }
    const keyId = raw.subarray(0, 4);
    const sig = raw.subarray(4);
    let verified = false;
    for (const k of keys) {
      try {
        if (!noteKeyId(name, k).equals(keyId)) continue;
        const pub = (k && typeof k === 'object' && k.type === 'public') ? k : createPublicKey(k);
        if (edVerify(null, Buffer.from(body, 'utf8'), pub, sig)) { verified = true; break; }
      } catch { /* a key that cannot be loaded simply does not verify */ }
    }
    signatures.push({ name, keyId: keyId.toString('hex'), verified });
  }
  const valid = signatures.some((s) => s.verified);
  return {
    valid, body, signatures,
    reason: valid ? null : (keys.length
      ? 'no trusted key verified any signature on this note'
      : 'no trusted keys were supplied, so no signature could be verified'),
  };
}
