/**
 * holt — `catFileBatch()` framing when a repository names a file with a raw newline.
 *
 * MEASURED DEFECT (reproduced against production before the fix, verbatim red in the commit):
 * `catFileBatch()` framed its `git cat-file --batch` stdin as `specs.join('\n') + '\n'` and matched
 * replies back BY POSITION, counting exactly `specs.length` records. A newline inside one path —
 * legal in every git repository on POSIX — becomes TWO physical lines on the wire. git answers each
 * half separately, so the batch produces MORE records than there were specs and every record after
 * the weird one is attributed to the wrong spec. Nothing errors. A file silently receives its
 * NEIGHBOUR's bytes.
 *
 * Why that is data loss and not cosmetics: `symbolsAtBase()` materialises each returned buffer to
 * `tmp/<rel>` and runs ctags over it, so a file's BASE symbols get computed from a different file's
 * content. `diffSymbols()` is `head − base` keyed by file, so a symbol the workstream genuinely
 * introduced looks pre-existing and is OMITTED from `added`. `uniqueSymbolCount` is one of the few
 * reasons `safeToDelete` refuses — an undercount authorises deleting real work.
 *
 * The fix is NUL-delimited batch input (`git cat-file --batch -z`, git >= 2.32) plus a spec-aware
 * read of the `missing` reply, because `-z` alone fixes only HALF of this: git echoes the spec back
 * in `<spec> missing\n`, so a newline-named path that is ABSENT at that oid still splits its own
 * reply across two lines on the OUTPUT side. Both halves are asserted below.
 *
 * PROVE PRESENCE BEFORE TRUSTING SILENCE: every file's bytes are compared against `git cat-file -p`
 * ground truth taken one spec at a time, so "the batch returned something" can never pass for
 * "the batch returned the right thing".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { catFileBatch, batchNulInputSupported, _resetBatchNulProbe, GitRefused } from '../../src/git.mjs';
import { resolveBackend, symbolsOnDisk, symbolsAtBase, diffSymbols } from '../../src/symbols.mjs';
import { newRepo } from '../fixtures.mjs';

/**
 * A raw newline is legal in a POSIX filename and UNREPRESENTABLE on Windows (the Win32 path layer
 * rejects it outright). Following the fixture doctrine in test/fixtures.mjs: nothing is skipped —
 * on Windows the test asserts the byte genuinely cannot reach the filesystem, which is exactly why
 * holt never has to survive it there.
 */
const WEIRD = 'weird\nfile.js';

async function newlineNamesAreRepresentable(dir) {
  const probe = path.join(dir, WEIRD);
  try {
    await fs.writeFile(probe, 'probe\n');
    await fs.rm(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** The five committed files. Index 2 is the newline-named one; 3 and 4 sit downstream of it. */
const FILES = [
  ['f1.js', 'export function F1_ONLY() { return 1; }\n'],
  ['f2.js', 'export function F2_ONLY() { return 2; }\n'],
  [WEIRD, 'export function WEIRD_ONLY() { return 3; }\n'],
  // f4 holds, AT BASE, the very symbol the workstream will introduce in f5. That is what makes the
  // mis-attribution silent rather than loud: f5's base symbols get read out of f4's bytes, and the
  // workstream's genuinely novel symbol then looks pre-existing.
  ['f4.js', 'export function WORKSTREAM_NOVEL_SYMBOL() { return "f4 base copy"; }\n'],
  ['f5.js', 'export function F5_BASELINE() { return 5; }\n'],
];

async function repoWithNewlineNamedFile(label) {
  const fx = await newRepo(label);
  if (!await newlineNamesAreRepresentable(fx.root)) {
    await fx.cleanup();
    return null;
  }
  for (const [rel, body] of FILES) await fx.write(rel, body);
  const head = await fx.commit('five files, one of them newline-named');
  return { fx, head };
}

test('catFileBatch: a newline in one path does not shift every LATER record onto the wrong spec', async (t) => {
  const built = await repoWithNewlineNamedFile('nlbatch1');
  if (!built) {
    assert.equal(process.platform, 'win32', 'a newline-named file must be creatable off Windows');
    return;
  }
  const { fx, head } = built;
  t.after(() => fx.cleanup());

  const rels = FILES.map(([rel]) => rel);
  const specs = rels.map((rel) => `${head}:${rel}`);

  // GROUND TRUTH, one spec per process — the form the batch replaced, asked independently of it.
  const truth = new Map();
  for (const rel of rels) truth.set(rel, await fx.git(['cat-file', '-p', `${head}:${rel}`]));

  const got = new Array(specs.length).fill(undefined);
  await catFileBatch(specs, { cwd: fx.root }, (_spec, content, idx) => {
    got[idx] = content === null ? null : content.toString('utf8');
  });

  for (let i = 0; i < rels.length; i++) {
    assert.equal(
      got[i], truth.get(rels[i]),
      `spec ${i} (${JSON.stringify(rels[i])}) must receive ITS OWN bytes, not a neighbour's`,
    );
  }
});

test('catFileBatch: a MISSING newline-named spec does not split its own reply across two records', async (t) => {
  const built = await repoWithNewlineNamedFile('nlbatch2');
  if (!built) {
    assert.equal(process.platform, 'win32', 'a newline-named file must be creatable off Windows');
    return;
  }
  const { fx, head } = built;
  t.after(() => fx.cleanup());

  // `git cat-file --batch` answers a missing object with `<spec> missing\n`, echoing the spec
  // VERBATIM — so an absent newline-named path puts a raw newline in the OUTPUT too. `-z` changes
  // only the input framing and does not help here; the reply must be matched against the spec holt
  // actually asked for.
  const specs = [
    `${head}:f1.js`,
    `${head}:absent\ndir/gone.js`,
    `${head}:f4.js`,
    `${head}:f5.js`,
  ];
  const expected = [
    await fx.git(['cat-file', '-p', `${head}:f1.js`]),
    null,
    await fx.git(['cat-file', '-p', `${head}:f4.js`]),
    await fx.git(['cat-file', '-p', `${head}:f5.js`]),
  ];

  const got = new Array(specs.length).fill(undefined);
  await catFileBatch(specs, { cwd: fx.root }, (_spec, content, idx) => {
    got[idx] = content === null ? null : content.toString('utf8');
  });

  assert.deepEqual(got, expected);
});

test('symbolsAtBase -> diffSymbols still reports the workstream novel symbol past a newline-named file', async (t) => {
  const built = await repoWithNewlineNamedFile('nlbatch3');
  if (!built) {
    assert.equal(process.platform, 'win32', 'a newline-named file must be creatable off Windows');
    return;
  }
  const { fx, head } = built;
  t.after(() => fx.cleanup());

  // The workstream adds a genuinely new symbol to f5.js — a file positioned AFTER the newline-named
  // one in the batch, which is where the record shift lands.
  const ws = await fx.worktree('novel');
  await fx.write('f5.js',
    'export function F5_BASELINE() { return 5; }\n'
    + 'export function WORKSTREAM_NOVEL_SYMBOL() { return "introduced by the workstream"; }\n',
    ws);

  const backend = await resolveBackend();
  const rels = FILES.map(([rel]) => rel);

  // Exactly production's shape (src/scan.mjs): base symbols from the batched object reader, head
  // symbols from the worktree on disk, added = head − base.
  const baseSyms = await symbolsAtBase(fx.root, head, rels, backend);
  const headSyms = await symbolsOnDisk(ws, ['f5.js'], backend);
  const added = diffSymbols(headSyms, baseSyms);

  const addedNames = new Set(added.map((s) => s.name));
  assert.ok(
    addedNames.has('WORKSTREAM_NOVEL_SYMBOL'),
    `the workstream's novel symbol must survive the batch; got ${JSON.stringify([...addedNames])}`,
  );
  // Negative control in the same assertion set: a symbol that really IS pre-existing in f5 at base
  // must NOT be reported as added, so the test cannot pass merely by reporting everything.
  assert.equal(
    addedNames.has('F5_BASELINE'), false,
    'F5_BASELINE exists at base in f5.js and must not be reported as newly added',
  );
  // And the base read that fed the diff must itself be right: f5's base symbols come from f5.
  assert.deepEqual(
    (baseSyms.get('f5.js') ?? []).map((s) => s.name), ['F5_BASELINE'],
    'f5.js base symbols must be read from f5.js, not from a neighbouring file',
  );
});

test('batchNulInputSupported: the 2.32 gate, on the version strings real gits actually print', () => {
  // `git cat-file --batch -z` landed in git 2.32 (2021-06). Below it there is no safe framing for a
  // newline-bearing spec, so this predicate decides between "read correctly" and "refuse loudly".
  for (const line of [
    'git version 2.32.0\n', 'git version 2.55.0\n', 'git version 3.0.0\n',
    'git version 2.45.1.windows.1\n', 'git version 2.39.5 (Apple Git-154)\n',
  ]) assert.equal(batchNulInputSupported(line), true, line.trim());

  for (const line of [
    'git version 2.31.1\n', 'git version 2.31.0\n', 'git version 2.0.0\n',
    'git version 1.8.3.1\n', '', 'not a version at all\n', null, undefined,
  ]) assert.equal(batchNulInputSupported(line), false, JSON.stringify(line));
});

test('catFileBatch: a git too old for `--batch -z` REFUSES a newline-bearing spec instead of corrupting it', async (t) => {
  const built = await repoWithNewlineNamedFile('nlbatch4');
  if (!built) {
    assert.equal(process.platform, 'win32', 'a newline-named file must be creatable off Windows');
    return;
  }
  const { fx, head } = built;
  t.after(() => fx.cleanup());
  if (process.platform === 'win32') return; // no `#!` shim; the newline path is unreachable there anyway

  // A REAL old git is not installable in CI, so stand one up: a shim first on PATH that reports
  // 2.31.1 and delegates everything else to the genuine binary. This exercises the actual probe
  // (`git version` -> batchNulInputSupported) rather than reaching past it.
  const realGit = await new Promise((res, rej) => execFile(
    process.platform === 'win32' ? 'where' : 'which', ['git'],
    (e, out) => (e ? rej(e) : res(String(out).split('\n')[0].trim())),
  ));
  const shimDir = path.join(fx.root, '..', 'oldgit-shim');
  await fs.mkdir(shimDir, { recursive: true });
  await fs.writeFile(
    path.join(shimDir, 'git'),
    `#!/bin/sh\nif [ "$1" = "version" ]; then echo "git version 2.31.1"; exit 0; fi\nexec ${JSON.stringify(realGit)} "$@"\n`,
    { mode: 0o755 },
  );

  const savedPath = process.env.PATH;
  process.env.PATH = `${shimDir}${path.delimiter}${savedPath}`;
  _resetBatchNulProbe();
  try {
    // The ordinary case is untouched by the fallback: no newline, so it still reads correctly.
    const plain = [];
    await catFileBatch([`${head}:f1.js`, `${head}:f5.js`], { cwd: fx.root }, (_s, c) => plain.push(c.toString('utf8')));
    assert.deepEqual(plain, [
      'export function F1_ONLY() { return 1; }\n',
      'export function F5_BASELINE() { return 5; }\n',
    ], 'an old git must still read ordinary specs correctly');

    // The newline case fails LOUDLY. Silence here — a resolved promise with shifted records — is
    // the exact data loss this whole file exists to prevent.
    const seen = [];
    await assert.rejects(
      () => catFileBatch(
        [`${head}:f1.js`, `${head}:${WEIRD}`, `${head}:f5.js`],
        { cwd: fx.root },
        (_s, c, i) => seen.push(i),
      ),
      (err) => {
        assert.ok(err instanceof GitRefused, `expected GitRefused, got ${err?.constructor?.name}`);
        assert.match(err.message, /contains a newline/);
        assert.match(err.message, /2\.32/);
        return true;
      },
    );
    assert.deepEqual(seen, [], 'a refused batch must deliver NO records, not a partial shifted set');
  } finally {
    process.env.PATH = savedPath;
    _resetBatchNulProbe();
  }
});

test('catFileBatch: a spec carrying a NUL byte is refused on every git — no framing can carry it', async (t) => {
  const fx = await newRepo('nlbatch5');
  t.after(() => fx.cleanup());
  const head = (await fx.git(['rev-parse', 'HEAD'])).trim();

  const seen = [];
  await assert.rejects(
    () => catFileBatch([`${head}:src/base.js`, `${head}:no\0pe.js`], { cwd: fx.root }, (_s, c, i) => seen.push(i)),
    (err) => {
      assert.ok(err instanceof GitRefused, `expected GitRefused, got ${err?.constructor?.name}`);
      assert.match(err.message, /NUL byte/);
      return true;
    },
  );
  assert.deepEqual(seen, []);
});
