// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * content-identity.mjs — the primitive `safeToDelete` relies on to prove "a living sibling holds
 * this exact work", independent of path, line endings or indentation style.
 *
 * Mirrors the two-directional shape bench50's own oracle normalisation is proven against: every
 * "these are the same" assertion is paired with an "and these, which merely LOOK similar, are
 * NOT" assertion, because a normaliser that returns a constant would pass half of any one-sided
 * test suite.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeForIdentity, contentFingerprint, fingerprintKey } from '../../src/content-identity.mjs';

const buf = (s) => Buffer.from(s, 'utf8');

test('IDENTITY: 4-space and tab indent of the same code normalise to the same text', () => {
  const spaces = buf(
    'class PyThing_dup:\n'
    + '    def py_method_dup(self):\n'
    + '        return 1\n'
    + '\n'
    + 'def py_free_dup(): pass\n',
  );
  const tabs = buf(
    'class PyThing_dup:\n'
    + '\tdef py_method_dup(self):\n'
    + '\t\treturn 1\n'
    + '\n'
    + 'def py_free_dup(): pass\n',
  );
  assert.equal(normalizeForIdentity(spaces), normalizeForIdentity(tabs));
  assert.equal(fingerprintKey(contentFingerprint(spaces)), fingerprintKey(contentFingerprint(tabs)));
});

test('IDENTITY: CRLF, a BOM, and trailing whitespace do not change identity', () => {
  const lf = buf('def f():\n    return 1\n');
  const crlf = buf('def f():\r\n    return 1\r\n');
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), lf]);
  const trailingWs = buf('def f():   \n    return 1\t\n');
  assert.equal(normalizeForIdentity(lf), normalizeForIdentity(crlf), 'CRLF must not matter');
  assert.equal(normalizeForIdentity(lf), normalizeForIdentity(bom), 'a BOM must not matter');
  assert.equal(normalizeForIdentity(lf), normalizeForIdentity(trailingWs), 'trailing whitespace must not matter');
});

test('IDENTITY: blank lines (including whitespace-only ones) do not change identity', () => {
  const tight = buf('a\nb\n');
  const spaced = buf('a\n\n   \n\t\nb\n');
  assert.equal(normalizeForIdentity(tight), normalizeForIdentity(spaced));
});

test('OVER-FIRE GUARD: different code at the SAME indentation shape must NOT collide', () => {
  // Two functions, identical nesting depth, different actual logic. If normalisation were
  // shape-only (ignoring the real text) these would wrongly collide -- the exact "two unrelated
  // handle()s" danger named for this fix. Content, not shape, must decide.
  const a = buf('def handle():\n    return compute_alpha(x)\n');
  const b = buf('def handle():\n    return compute_beta(y)\n');
  assert.notEqual(normalizeForIdentity(a), normalizeForIdentity(b));
  assert.notEqual(fingerprintKey(contentFingerprint(a)), fingerprintKey(contentFingerprint(b)));
});

test('OVER-FIRE GUARD: moving a line to a different nesting depth is a different program', () => {
  // Stripping indentation entirely (rather than ranking it) would equate these. Rank must not.
  const nested = buf('if x:\n    if y:\n        do_thing()\n');
  const flattened = buf('if x:\n    do_thing()\n');
  assert.notEqual(normalizeForIdentity(nested), normalizeForIdentity(flattened));
});

test('OVER-FIRE GUARD: reordered lines are a different program', () => {
  const a = buf('first()\nsecond()\n');
  const b = buf('second()\nfirst()\n');
  assert.notEqual(normalizeForIdentity(a), normalizeForIdentity(b));
});

test('BINARY: a NUL-containing buffer skips normalisation and falls back to raw identity', () => {
  const withNul = Buffer.from([0x00, 0x01, 0x02, 0xff]);
  assert.equal(normalizeForIdentity(withNul), null);
  const fp = contentFingerprint(withNul);
  assert.equal(fp.normalized, null, 'normalised digest must be absent for binary content');
  assert.ok(fp.raw, 'raw digest must still be computed for binary content');
  assert.equal(fingerprintKey(fp), `r:${fp.raw}`, 'the key must fall back to the raw namespace');
});

test('BINARY: two DIFFERENT binaries must not collide via the raw fallback', () => {
  const a = contentFingerprint(Buffer.from([0x00, 0x01]));
  const b = contentFingerprint(Buffer.from([0x00, 0x02]));
  assert.notEqual(fingerprintKey(a), fingerprintKey(b));
});

test('KEY NAMESPACING: a raw digest can never collide with a normalised digest string', () => {
  // Not a cryptographic claim -- a structural one: the two families use different prefixes, so
  // even a contrived matching hex string cannot cross the raw/normalised boundary.
  const fp = { raw: 'deadbeef', normalized: null };
  const fp2 = { raw: 'unused', normalized: 'deadbeef' };
  assert.notEqual(fingerprintKey(fp), fingerprintKey(fp2));
});

test('SIZE CAP: an oversized buffer yields no fingerprint at all, not a false match', () => {
  const huge = Buffer.alloc(17 * 1024 * 1024, 0x61); // 17 MiB of 'a', over the 16 MiB cap
  assert.equal(contentFingerprint(huge), null);
});
