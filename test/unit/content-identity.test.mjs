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
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeForIdentity, contentFingerprint, fingerprintKey, symlinkKey, pathContentKey,
} from '../../src/content-identity.mjs';

const buf = (s) => Buffer.from(s, 'utf8');

/** A scratch directory, removed when the test ends. */
async function scratch(t, label) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `holt-ci-${label}-`));
  t.after(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));
  return dir;
}

/** Make a symlink, or skip the test on a platform that refuses to create one. */
async function link(t, target, at) {
  try {
    await fs.symlink(target, at);
    return true;
  } catch {
    t.skip('this platform will not create a symlink here');
    return false;
  }
}

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

/* ---------------------------------------------------------------- symlinks ---- */
/*
 * REPRODUCED DATA LOSS, discover -> scan -> analyze -> actions.clean. The fingerprint reader was
 * a bare `fs.readFile`, which SILENTLY FOLLOWS SYMLINKS and hashes the RESOLVED TARGET's bytes.
 * What git tracks at a symlink path is the TARGET STRING — `git cat-file -p HEAD:link` prints the
 * path and nothing else — so two worktrees committing links to two DIFFERENT external files that
 * happened to hold identical bytes at scan time fingerprinted identically, `safeToDelete` called
 * each `redundantWith` the other, and `clean --apply` would have removed the only copy.
 *
 * Both directions are pinned below, because only fixing the false-positive would have been just
 * as wrong in the other direction: the pre-fix code gave two IDENTICAL committed symlinks a `null`
 * key (readFile throws on a dangling link), so genuinely mutually-redundant worktrees could never
 * be reclaimed at all.
 */

test('SYMLINK IDENTITY: two links to DIFFERENT targets holding identical bytes are NOT the same work', async (t) => {
  const dir = await scratch(t, 'symdiff');
  // Two external targets whose bytes are identical RIGHT NOW. Their tracked content — the two
  // target paths — is provably different, and that is what identity must answer over.
  const same = 'export function shared() { return 42; }\n';
  await fs.writeFile(path.join(dir, 'alpha-target.js'), same);
  await fs.writeFile(path.join(dir, 'beta-target.js'), same);
  if (!await link(t, path.join(dir, 'alpha-target.js'), path.join(dir, 'a-link.js'))) return;
  if (!await link(t, path.join(dir, 'beta-target.js'), path.join(dir, 'b-link.js'))) return;

  const ka = await pathContentKey(path.join(dir, 'a-link.js'));
  const kb = await pathContentKey(path.join(dir, 'b-link.js'));

  // PRESENCE BEFORE SILENCE: the keys must be real keys, not two nulls agreeing by accident.
  assert.ok(ka, 'a symlink must still get a key — a null here would be under-reporting, not a fix');
  assert.ok(kb, 'a symlink must still get a key');
  assert.notEqual(ka, kb,
    'two links to different targets must not fingerprint alike just because the targets currently match');

  // And the reason they differ is the TARGET STRING, not the bytes beyond it: prove the key is
  // exactly what git stores for the link.
  assert.equal(ka, symlinkKey(path.join(dir, 'alpha-target.js')));
  assert.equal(kb, symlinkKey(path.join(dir, 'beta-target.js')));

  // NEVER-WORSE CONTROL: the targets themselves, read as ordinary files, DO match — so the
  // difference above comes from not following the links, not from the fingerprinter going blind.
  assert.equal(
    await pathContentKey(path.join(dir, 'alpha-target.js')),
    await pathContentKey(path.join(dir, 'beta-target.js')),
    'two regular files with identical bytes must still match',
  );
});

test('SYMLINK IDENTITY: two links to the SAME target ARE the same work, even dangling', async (t) => {
  const dir = await scratch(t, 'symsame');
  await fs.mkdir(path.join(dir, 'x'), { recursive: true });
  await fs.mkdir(path.join(dir, 'y'), { recursive: true });
  // Deliberately DANGLING: `../shared/thing.js` exists nowhere. The pre-fix reader threw here and
  // returned null, so two worktrees holding provably identical tracked content were never
  // recognised as redundant. Refusing more is not correctness.
  if (!await link(t, '../shared/thing.js', path.join(dir, 'x', 'same.js'))) return;
  if (!await link(t, '../shared/thing.js', path.join(dir, 'y', 'same.js'))) return;

  const kx = await pathContentKey(path.join(dir, 'x', 'same.js'));
  const ky = await pathContentKey(path.join(dir, 'y', 'same.js'));
  assert.ok(kx, 'a dangling symlink still has tracked content: its target string');
  assert.equal(kx, ky, 'identical committed symlinks hold identical work and must match');

  // ...and a link to a DIFFERENT target in the same shape does not.
  if (!await link(t, '../shared/other.js', path.join(dir, 'x', 'other.js'))) return;
  assert.notEqual(await pathContentKey(path.join(dir, 'x', 'other.js')), kx);
});

test('SYMLINK NAMESPACE: a link to a path is not the same work as a file containing that path', async (t) => {
  const dir = await scratch(t, 'symns');
  const target = '../lib/util.js';
  if (!await link(t, target, path.join(dir, 'as-link'))) return;
  // A regular file whose only line is the same string. Same bytes, different work: deleting the
  // worktree holding the LINK because a sibling holds the FILE destroys the link.
  await fs.writeFile(path.join(dir, 'as-file'), `${target}\n`);

  const kLink = await pathContentKey(path.join(dir, 'as-link'));
  const kFile = await pathContentKey(path.join(dir, 'as-file'));
  assert.ok(kLink && kFile, 'both must produce keys');
  assert.notEqual(kLink, kFile, 'a symlink and a file with the same bytes are not the same work');
  assert.match(kLink, /^l:/, 'a symlink key lives in its own namespace');
  assert.doesNotMatch(kFile, /^l:/, 'a regular file must never land in the symlink namespace');
});

test('SYMLINK IDENTITY: the target string is compared RAW, never whitespace-normalised', () => {
  // A path is bytes. normalizeForIdentity strips trailing whitespace and re-ranks indentation,
  // which would fuse `a/b ` with `a/b` — two different targets — so it must not be applied here.
  assert.notEqual(symlinkKey('a/b'), symlinkKey('a/b '));
  assert.notEqual(symlinkKey('a/b'), symlinkKey(' a/b'));
  assert.equal(symlinkKey('a/b'), symlinkKey('a/b'));
  assert.equal(symlinkKey(null), null);
});

test('UNKEYABLE ENTRIES: a directory or a missing path yields null, never a match', async (t) => {
  const dir = await scratch(t, 'symnull');
  await fs.mkdir(path.join(dir, 'adir'), { recursive: true });
  assert.equal(await pathContentKey(path.join(dir, 'adir')), null, 'a directory has no tracked content');
  assert.equal(await pathContentKey(path.join(dir, 'gone')), null, 'a vanished path is unknown, not empty');
  // Two nulls must never be treated as equal by a caller — that is the consumers' contract
  // (`if (!key) continue`), asserted here so this file states the whole rule in one place.
  assert.equal(await pathContentKey(path.join(dir, 'also-gone')), null);
});
