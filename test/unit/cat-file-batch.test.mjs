/**
 * holt — `catFileBatch()` (src/git.mjs).
 *
 * MEASURED DEFECT THIS REPLACES: `symbolsAtBase()` used to spawn one `git cat-file -p <spec>`
 * PROCESS PER FILE. Profiled with --cpu-prof against a synthetic 40k-file repository with a
 * 5,500-file uncommitted delta: 64.7% of the scan's wall-clock time (6,626 of 10,239 sampled
 * hits) was inside `spawn` alone. `catFileBatch()` answers the same question — object content by
 * `<oid>:<path>` spec — over ONE long-lived `git cat-file --batch` process, fed every spec on
 * stdin and parsed back as a stream of records, instead of one process per spec.
 *
 * PROVE PRESENCE BEFORE TRUSTING SILENCE: a batching rewrite that quietly returns nothing, or
 * returns content for the wrong spec, or drops the "this object does not exist" signal, would be
 * a correctness regression wearing a performance improvement's clothes. Every case below asserts
 * a SPECIFIC value, not merely "no error".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catFileBatch, classify } from '../../src/git.mjs';
import { newRepo } from '../fixtures.mjs';

test('catFileBatch: retrieves exact content for a real blob spec', async (t) => {
  const fx = await newRepo('cat1');
  t.after(() => fx.cleanup());
  const head = (await fx.git(['rev-parse', 'HEAD'])).trim(); // newRepo() already committed 'base'

  const out = new Map();
  await catFileBatch([`${head}:src/base.js`], { cwd: fx.root }, (spec, content) => { out.set(spec, content); });

  const content = out.get(`${head}:src/base.js`);
  assert.ok(Buffer.isBuffer(content), 'content must be a Buffer, not a decoded string');
  assert.equal(content.toString('utf8'), 'export function baseline() { return 1; }\n');
});

test('catFileBatch: a spec absent at that oid resolves to null, not an error and not empty content', async (t) => {
  const fx = await newRepo('cat2');
  t.after(() => fx.cleanup());
  const head = (await fx.git(['rev-parse', 'HEAD'])).trim();

  const results = [];
  await catFileBatch(
    [`${head}:this/path/does/not/exist.txt`],
    { cwd: fx.root },
    (spec, content) => results.push({ spec, content }),
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].content, null, 'a missing object must resolve to null, never to empty content');
});

test('catFileBatch: order is preserved and hits/misses do not bleed into neighboring specs', async (t) => {
  const fx = await newRepo('cat3');
  t.after(() => fx.cleanup());
  await fx.write('a.txt', 'AAA\n');
  await fx.write('b.txt', 'BBB\n');
  const head = await fx.commit('add a and b');

  // Interleave present/absent/present/absent so a mis-tracked byte offset would visibly corrupt
  // a NEIGHBOR's content rather than just its own — an off-by-one in record parsing tends to
  // shift everything after it, so this ordering is chosen to make that failure mode loud.
  const specs = [
    `${head}:a.txt`,
    `${head}:nope1.txt`,
    `${head}:b.txt`,
    `${head}:nope2.txt`,
    `${head}:a.txt`,
  ];
  const byIndex = new Array(specs.length);
  await catFileBatch(specs, { cwd: fx.root }, (spec, content, index) => {
    byIndex[index] = content === null ? null : content.toString('utf8');
  });

  assert.deepEqual(byIndex, ['AAA\n', null, 'BBB\n', null, 'AAA\n']);
});

test('catFileBatch: one process handles hundreds of specs correctly (the batching this exists for)', async (t) => {
  const fx = await newRepo('cat4');
  t.after(() => fx.cleanup());
  const N = 300;
  for (let i = 0; i < N; i++) await fx.write(`gen/f${i}.txt`, `file number ${i}\n`);
  const head = await fx.commit('generate many files');

  const specs = Array.from({ length: N }, (_, i) => `${head}:gen/f${i}.txt`);
  const got = new Map();
  await catFileBatch(specs, { cwd: fx.root }, (spec, content) => got.set(spec, content));

  assert.equal(got.size, N);
  for (let i = 0; i < N; i += 37) { // sample rather than assert all 300, for test speed
    const c = got.get(`${head}:gen/f${i}.txt`);
    assert.equal(c.toString('utf8'), `file number ${i}\n`);
  }
});

test('catFileBatch: byte-exact content, not UTF-8 round-tripped (binary-safe)', async (t) => {
  const fx = await newRepo('cat5');
  t.after(() => fx.cleanup());
  // Bytes that are NOT valid UTF-8 on their own (a lone continuation byte, 0xFF) — the historical
  // failure mode here is silent replacement-character corruption when content is decoded as text
  // before being written back out.
  const raw = Buffer.from([0x00, 0xff, 0xfe, 0x41, 0x0a, 0x80, 0x81]);
  const fs = await import('node:fs/promises');
  const abs = await fx.write('binary.bin', '');
  await fs.writeFile(abs, raw);
  const head = await fx.commit('add binary file');

  let got = null;
  await catFileBatch([`${head}:binary.bin`], { cwd: fx.root }, (_spec, content) => { got = content; });

  assert.ok(Buffer.isBuffer(got));
  assert.ok(got.equals(raw), 'content must match the exact bytes committed, byte for byte');
});

test('catFileBatch: an empty spec list resolves immediately without spawning anything', async () => {
  let called = false;
  await catFileBatch([], {}, () => { called = true; });
  assert.equal(called, false);
});

test('catFileBatch: git cat-file --batch is on the SAFE allowlist (defense in depth)', () => {
  const v = classify(['cat-file', '--batch']);
  assert.equal(v.allowed, true);
  assert.equal(v.tier, 'SAFE');
});
