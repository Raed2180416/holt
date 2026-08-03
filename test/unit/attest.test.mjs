/**
 * holt — the tamper-evidence primitives, attacked.
 *
 * These are cryptographic constructions with published definitions, so the tests are written to
 * a RULE, not to "whatever the implementation printed". Two things matter more than anything
 * else here and both have a dedicated attack below:
 *
 *   1. RFC 6962 DOMAIN SEPARATION. Its entire purpose is the second-preimage attack: without the
 *      0x00/0x01 prefixes an attacker can present an INTERNAL NODE as a leaf and produce a
 *      smaller tree with the same root. A generic Merkle library (merkletreejs and friends) does
 *      not do this by default, which is the concrete reason holt does not depend on one. The
 *      test constructs that exact forgery and asserts it fails.
 *   2. CANONICALISATION. Two different byte strings that hash the same is the hole that makes a
 *      signature meaningless, and the mirror hole — the same object hashing differently because
 *      a key moved — makes verification a coin flip.
 *
 * Independent second implementation: `naiveRoot` below is a LITERAL transcription of the RFC
 * 6962 recursive definition. The shipped merkleRoot is an iterative fold, and the property test
 * asserts they agree on every size from 0 to 64. If they ever disagree, the fold is wrong — a
 * test that only checked the fold against itself would have proven nothing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, createPublicKey } from 'node:crypto';
import {
  leafHash, nodeHash, emptyRoot, merkleRoot, splitPoint, inclusionProof, verifyInclusion,
  canonicalJson, entryLeaf, formatCheckpoint, parseCheckpoint, signNote, verifyNote,
  noteKeyId, rawEd25519Public, LEAF_PREFIX, NODE_PREFIX,
} from '../../src/attest.mjs';

const sha256 = (b) => createHash('sha256').update(b).digest();
const leavesOf = (n) => Array.from({ length: n }, (_, i) => leafHash(`entry-${i}`));

/** RFC 6962 §2.1, transcribed literally. Deliberately NOT the shipped algorithm. */
function naiveRoot(leaves) {
  if (leaves.length === 0) return sha256(Buffer.alloc(0));
  if (leaves.length === 1) return leaves[0];
  const k = splitPoint(leaves.length);
  return nodeHash(naiveRoot(leaves.slice(0, k)), naiveRoot(leaves.slice(k)));
}

/* ------------------------------------------------------------- definitions ---- */

test('RFC 6962: the empty tree is SHA-256 of the empty string', () => {
  assert.equal(emptyRoot().toString('hex'),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('RFC 6962: a leaf is SHA-256(0x00 ‖ data) and a node is SHA-256(0x01 ‖ l ‖ r)', () => {
  assert.equal(LEAF_PREFIX, 0x00);
  assert.equal(NODE_PREFIX, 0x01);
  const d = Buffer.from('hello');
  assert.deepEqual(leafHash(d), sha256(Buffer.concat([Buffer.from([0]), d])));
  const l = leafHash('a');
  const r = leafHash('b');
  assert.deepEqual(nodeHash(l, r), sha256(Buffer.concat([Buffer.from([1]), l, r])));
  // A one-leaf tree's root IS the leaf hash — no extra node hashing.
  assert.deepEqual(merkleRoot([l]), l);
  assert.deepEqual(merkleRoot([l, r]), nodeHash(l, r));
});

test('RFC 6962: the split point is the largest power of two STRICTLY below n (a left-heavy tree)', () => {
  assert.equal(splitPoint(2), 1);
  assert.equal(splitPoint(3), 2);
  assert.equal(splitPoint(4), 2);
  assert.equal(splitPoint(5), 4);
  assert.equal(splitPoint(8), 4);
  assert.equal(splitPoint(9), 8);
});

test('the shipped iterative root agrees with a literal transcription of the RFC for every size 0..64', () => {
  for (let n = 0; n <= 64; n++) {
    const l = leavesOf(n);
    assert.deepEqual(merkleRoot(l), naiveRoot(l), `tree of ${n} leaves disagrees with the RFC definition`);
  }
});

/* ------------------------------------------------------------------ attacks ---- */

test('ATTACK: second preimage — an internal node presented as a leaf must NOT reproduce the root', () => {
  // This is exactly what domain separation exists to prevent, and it is the single reason a
  // generic (undomained) Merkle helper would be a false-crown vector here. Take a 2-leaf tree.
  // Its root is nodeHash(l0, l1) = SHA256(0x01 ‖ l0 ‖ l1). An attacker offers a ONE-leaf tree
  // whose leaf data is the concatenation 0x01‖l0‖l1 and claims the same root. With the 0x00
  // leaf prefix in place the leaf hashes to SHA256(0x00 ‖ 0x01 ‖ l0 ‖ l1) — a different value.
  const l0 = leafHash('first');
  const l1 = leafHash('second');
  const real = merkleRoot([l0, l1]);
  const forgedLeafData = Buffer.concat([Buffer.from([NODE_PREFIX]), l0, l1]);
  const forged = merkleRoot([leafHash(forgedLeafData)]);
  assert.notDeepEqual(forged, real,
    'an interior node was accepted as a leaf — domain separation is broken and the tree is forgeable');
  // And prove the attack WOULD have worked without the prefix: the instrument can detect presence.
  assert.deepEqual(sha256(forgedLeafData), real,
    'the undomained hash of the same bytes should equal the root — if not, this test is not testing the attack it claims');
});

test('ATTACK: changing one leaf changes the root, for every position in the tree', () => {
  const base = leavesOf(7);
  const root = merkleRoot(base);
  for (let i = 0; i < base.length; i++) {
    const tampered = [...base];
    tampered[i] = leafHash(`entry-${i}-EDITED`);
    assert.notDeepEqual(merkleRoot(tampered), root, `editing leaf ${i} did not move the root`);
  }
});

test('ATTACK: removing, adding or reordering leaves all move the root', () => {
  const base = leavesOf(9);
  const root = merkleRoot(base);
  assert.notDeepEqual(merkleRoot(base.slice(0, 8)), root, 'truncation did not move the root');
  assert.notDeepEqual(merkleRoot(base.slice(1)), root, 'dropping the head did not move the root');
  assert.notDeepEqual(merkleRoot([...base, leafHash('extra')]), root, 'appending did not move the root');
  const swapped = [...base];
  [swapped[2], swapped[5]] = [swapped[5], swapped[2]];
  assert.notDeepEqual(merkleRoot(swapped), root, 'reordering did not move the root');
});

/* --------------------------------------------------------- inclusion proofs ---- */

test('RFC 6962: every leaf of every tree size 1..40 has a proof that verifies', () => {
  for (let n = 1; n <= 40; n++) {
    const l = leavesOf(n);
    const root = merkleRoot(l);
    for (let m = 0; m < n; m++) {
      const proof = inclusionProof(l, m);
      assert.equal(verifyInclusion(l[m], m, n, proof, root), true,
        `leaf ${m} of ${n} did not verify (proof length ${proof.length})`);
    }
  }
});

test('ATTACK: a proof for the wrong leaf, wrong index, wrong root or wrong length is refused', () => {
  const l = leavesOf(11);
  const root = merkleRoot(l);
  const proof = inclusionProof(l, 4);
  assert.equal(verifyInclusion(l[4], 4, 11, proof, root), true, 'control: the honest proof must verify');
  assert.equal(verifyInclusion(leafHash('not-in-the-log'), 4, 11, proof, root), false, 'a foreign leaf verified');
  assert.equal(verifyInclusion(l[4], 5, 11, proof, root), false, 'the wrong index verified');
  assert.equal(verifyInclusion(l[4], 4, 11, proof, leafHash('other')), false, 'the wrong root verified');
  assert.equal(verifyInclusion(l[4], 4, 11, [...proof, leafHash('pad')], root), false, 'an over-long proof verified');
  assert.equal(verifyInclusion(l[4], 4, 11, proof.slice(0, -1), root), false, 'a truncated proof verified');
  assert.equal(verifyInclusion(l[4], 4, 11, [leafHash('x'), ...proof.slice(1)], root), false, 'a substituted path element verified');
});

test('MEASURED LIMIT: an inclusion proof does NOT authenticate the tree size — the checkpoint does', () => {
  // Found by attacking this module, and it is a property of RFC 6962 rather than a defect. The
  // verification algorithm's branch decisions depend only on the BITS of (index, size-1), so a
  // proof for leaf 4 of an 11-leaf tree also verifies against a claimed size of 9..16 — every
  // size whose proof shape for that leaf is identical. MEASURED, not assumed.
  //
  // This is exactly why holt takes the tree size from the C2SP checkpoint (which is what gets
  // signed) and never from the proof, and why journal verification compares checkpoint size to
  // the number of entries as a SEPARATE check. A design that inferred "the log had N entries"
  // from an inclusion proof would be trusting something the proof never claimed.
  const l = leavesOf(11);
  const root = merkleRoot(l);
  const proof = inclusionProof(l, 4);
  const accepted = [];
  for (let n = 1; n <= 24; n++) if (verifyInclusion(l[4], 4, n, proof, root)) accepted.push(n);
  assert.deepEqual(accepted, [9, 10, 11, 12, 13, 14, 15, 16],
    'the set of sizes an inclusion proof accepts changed — re-derive the claim above before trusting it');
  // The last leaf is the one case where the proof DOES pin the size exactly.
  const pLast = inclusionProof(l, 10);
  const acceptedLast = [];
  for (let n = 1; n <= 24; n++) if (verifyInclusion(l[10], 10, n, pLast, root)) acceptedLast.push(n);
  assert.deepEqual(acceptedLast, [11]);
});

test('inclusionProof refuses an index outside the tree rather than returning something plausible', () => {
  assert.throws(() => inclusionProof(leavesOf(4), 4), RangeError);
  assert.throws(() => inclusionProof(leavesOf(4), -1), RangeError);
});

/* ------------------------------------------------------------- canonical JSON ---- */

test('canonical JSON: key order cannot change the hash, and a value change always does', () => {
  const a = { z: 1, a: { n: [1, 2], m: 'x' }, k: null };
  const b = { k: null, a: { m: 'x', n: [1, 2] }, z: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.deepEqual(entryLeaf(a), entryLeaf(b));
  assert.notDeepEqual(entryLeaf(a), entryLeaf({ ...a, z: 2 }));
  // Adding or removing a field must move the hash — otherwise a record could gain or lose
  // meaning silently, which is the whole class this guards.
  assert.notDeepEqual(entryLeaf(a), entryLeaf({ ...a, extra: 1 }));
  const { k, ...withoutK } = a;
  assert.notDeepEqual(entryLeaf(a), entryLeaf(withoutK));
});

test('canonical JSON: a string that LOOKS like structure cannot collide with the structure', () => {
  // The classic canonicalisation hole: {"a":"1,\"b\":2"} vs {"a":"1","b":2}. Both must differ.
  assert.notEqual(canonicalJson({ a: '1","b":2' }), canonicalJson({ a: '1', b: 2 }));
});

test('canonical JSON refuses non-finite numbers rather than emitting null for them', () => {
  assert.throws(() => canonicalJson({ n: Infinity }), TypeError);
  assert.throws(() => canonicalJson({ n: NaN }), TypeError);
});

/* -------------------------------------------------------- C2SP tlog-checkpoint ---- */

test('C2SP tlog-checkpoint: origin, ASCII-decimal size, base64 root — round-trips exactly', () => {
  const root = merkleRoot(leavesOf(5));
  const text = formatCheckpoint({ origin: 'holt.dev/journal/demo', size: 5, root });
  assert.equal(text, `holt.dev/journal/demo\n5\n${root.toString('base64')}\n`);
  const p = parseCheckpoint(text);
  assert.equal(p.origin, 'holt.dev/journal/demo');
  assert.equal(p.size, 5);
  assert.deepEqual(p.root, root);
});

test('C2SP tlog-checkpoint: malformed sizes and non-digest roots are REFUSED, never coerced', () => {
  const root = merkleRoot(leavesOf(3)).toString('base64');
  assert.throws(() => parseCheckpoint(`origin\n007\n${root}\n`), /ASCII decimal/, 'leading zeros accepted');
  assert.throws(() => parseCheckpoint(`origin\n-1\n${root}\n`), /ASCII decimal/, 'a negative size accepted');
  assert.throws(() => parseCheckpoint(`origin\n5\n${root}`.replace(root, 'not-base64!')), TypeError);
  assert.throws(() => parseCheckpoint('origin\n5\n'), TypeError, 'a two-line checkpoint accepted');
  assert.throws(() => parseCheckpoint(''), TypeError);
  assert.throws(() => formatCheckpoint({ origin: 'a\nb', size: 1, root: emptyRoot() }), TypeError);
});

/* ------------------------------------------------------------- signed notes ---- */

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const { privateKey: otherKey, publicKey: otherPub } = generateKeyPairSync('ed25519');

test('signed note: the x/mod key ID is SHA-256(name ‖ 0x0a ‖ 0x01 ‖ rawPublicKey)[0:4]', () => {
  const raw = rawEd25519Public(publicKey);
  assert.equal(raw.length, 32);
  const expected = sha256(Buffer.concat([Buffer.from('sig.test\n'), Buffer.from([0x01]), raw])).subarray(0, 4);
  assert.deepEqual(noteKeyId('sig.test', publicKey), expected);
});

test('signed note: a checkpoint signed here verifies with the matching public key', () => {
  const body = formatCheckpoint({ origin: 'holt.dev/journal/x', size: 2, root: merkleRoot(leavesOf(2)) });
  const note = signNote(body, { name: 'holt-audit', privateKey });
  assert.ok(note.startsWith(body), 'the body must survive verbatim');
  assert.match(note, /\n\n— holt-audit \S+\n$/);
  const v = verifyNote(note, { keys: [publicKey] });
  assert.equal(v.valid, true, JSON.stringify(v));
  assert.equal(v.body, body);
  // And the checkpoint inside a SIGNED note still parses as a checkpoint.
  assert.equal(parseCheckpoint(note).size, 2);
});

test('ATTACK: an edited body, a foreign key, and an UNSIGNED note are all refused', () => {
  const body = formatCheckpoint({ origin: 'holt.dev/journal/x', size: 2, root: merkleRoot(leavesOf(2)) });
  const note = signNote(body, { name: 'holt-audit', privateKey });

  const editedBody = note.replace('\n2\n', '\n3\n');
  assert.equal(verifyNote(editedBody, { keys: [publicKey] }).valid, false,
    'the size was changed and the signature still verified');

  assert.equal(verifyNote(note, { keys: [otherPub] }).valid, false, 'a foreign key verified the note');

  // Signed by the attacker under the SAME signer name: the key ID must not match.
  const forged = signNote(body, { name: 'holt-audit', privateKey: otherKey });
  assert.equal(verifyNote(forged, { keys: [publicKey] }).valid, false, 'a note signed by another key verified');

  // The most important one: absence of a signature is NEVER a pass.
  const v = verifyNote(body, { keys: [publicKey] });
  assert.equal(v.valid, false);
  assert.match(v.reason, /no signature block/);
  // And "I have no keys to check with" is also not a pass.
  assert.equal(verifyNote(note, { keys: [] }).valid, false);
});

test('signed note: key rotation — any trusted key may verify', () => {
  const body = formatCheckpoint({ origin: 'o', size: 1, root: leafHash('x') });
  const note = signNote(body, { name: 'holt-audit', privateKey: otherKey });
  // A PEM string and a KeyObject are both accepted, and an already-public KeyObject must not
  // trip `createPublicKey`'s refusal to re-derive one (ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE).
  assert.equal(verifyNote(note, { keys: [publicKey, otherPub] }).valid, true);
  const pem = otherPub.export({ type: 'spki', format: 'pem' });
  assert.equal(verifyNote(note, { keys: [publicKey, pem] }).valid, true);
});
