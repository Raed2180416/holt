// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * GIT'S SILENCE IS NOT CLEANLINESS.
 *
 * `git status` does not measure the working tree. It measures the working tree AS FILTERED BY
 * THE INDEX'S PER-PATH REPORTING BITS — `--skip-worktree` and `--assume-unchanged` — and holt
 * derived every "does this hold content found nowhere else" answer from the status stream alone
 * without ever reading the filter. A path git was TOLD NOT TO REPORT was byte-for-byte
 * indistinguishable from a path with nothing to report, and four surfaces agreed on the wrong
 * answer at once: `gate` said disposable, `rescue` said nothingToRescue, `clean --json` said
 * wouldRemove, and the PreToolUse guard said allow.
 *
 * This matters because `git update-index --skip-worktree <config>` is the canonical advice for
 * keeping local credentials out of a shared repository — so the file the blindness covers is
 * exactly the file whose only copy is on disk.
 *
 * EVERY ASSERTION HERE GOES THROUGH A PUBLIC SURFACE (assessCommand, scan, safeToDelete,
 * contentAtRisk) AND NOT THROUGH THE NEW INSTRUMENT, deliberately: a test that imports the
 * function the fix adds cannot be run against the code without the fix, so it can only ever fail
 * to LOAD there — and a load error pins nothing. Written this way, every test below fails on the
 * unfixed tree for the reason it exists.
 *
 * BOTH DIRECTIONS ARE PINNED, IN ONE FILE, because the fix is only correct if it holds both:
 *
 *   PROTECTION  a flagged file whose bytes differ from the index is at risk, and every surface
 *               must say so.
 *   NEVER-WORSE a flagged file that is ABSENT (this is how `git sparse-checkout` implements
 *               itself — every excluded path in every sparse checkout carries an `S`), or that
 *               is present and identical to the index, is NOT at risk, and a clean worktree must
 *               keep reporting as clean. A rule keyed on the flag alone would report every sparse
 *               checkout as unknown, which is the false-positive profile of a guard that gets
 *               switched off.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { newRepo } from '../fixtures.mjs';
import { assessCommand } from '../../src/agent.mjs';
import { discover } from '../../src/discover.mjs';
import { scan } from '../../src/scan.mjs';
import { contentAtRisk, safeToDelete } from '../../src/analyze.mjs';

/** Scan the fixture and return the workstream + disposability verdict for worktree `name`. */
async function verdictFor(fx, name = 'w') {
  const scanned = await scan(await discover(fx.root), { includePrimary: true });
  const ws = scanned.workstreams.find((w) => path.basename(w.path) === name);
  assert.ok(ws, `fixture worktree '${name}' missing from scan`);
  const verdict = safeToDelete(scanned, []).find((v) => v.id === ws.id);
  assert.ok(verdict, `no safeToDelete verdict for '${name}'`);
  return { ws, verdict };
}

/** The credentials case, built the way the git documentation tells people to build it. */
async function flaggedFixture(flag, { modify = true } = {}) {
  const fx = await newRepo('idxflag');
  await fx.write('config/local.json', '{"token":"PLACEHOLDER"}\n');
  await fx.commit('add config');
  const wt = await fx.worktree('w');
  if (modify) {
    await fx.write('config/local.json', '{"token":"REAL-LIVE-SECRET","db":"postgres://prod"}\n', wt);
  }
  await fx.git(['update-index', flag, 'config/local.json'], wt);
  return { fx, wt };
}

const statusOf = async (fx, wt) =>
  (await fx.git(['status', '--porcelain', '--untracked-files=all'], wt)).trim();

for (const flag of ['--skip-worktree', '--assume-unchanged']) {
  test(`index flags: ${flag} hides real work from git status, and holt no longer reads that as clean`, async () => {
    const { fx, wt } = await flaggedFixture(flag);
    try {
      // THE PREMISE. If git ever starts reporting these, this test measures nothing and must
      // fail loudly rather than pass vacuously.
      assert.equal(await statusOf(fx, wt), '',
        `premise broken: git status is meant to be EMPTY under ${flag}`);
      assert.match(await fx.git(['ls-files', '-v'], wt), /^[Sh] config\/local\.json$/m,
        `premise broken: ls-files -v should show the flag for ${flag}`);

      // SURFACE 1 — the scan's uncommitted layer, which risk / gate / clean all read.
      const { ws, verdict } = await verdictFor(fx);
      assert.ok(ws.uncommitted.files.includes('config/local.json'),
        'the flagged modification must appear in the uncommitted layer');

      // SURFACE 2 — the disposable verdict (`holt gate`, `holt clean`).
      assert.equal(verdict.safe, false, 'a worktree holding hidden work is not disposable');

      // SURFACE 3 — contentAtRisk, which `holt rescue` consults for nothingToRescue.
      const car = contentAtRisk(ws);
      assert.equal(car.empty, false, 'contentAtRisk must not report empty');
      assert.ok(car.files.includes('config/local.json'));

      // SURFACE 4 — the PreToolUse guard, on the exact command that destroys the only copy.
      const v = await assessCommand('rm config/local.json', wt);
      assert.equal(v.decision, 'deny', `guard must deny; got ${v.decision}: ${v.reason}`);
      assert.match(v.reason, /config\/local\.json/);
    } finally { await fx.cleanup(); }
  });
}

for (const flag of ['--skip-worktree', '--assume-unchanged']) {
  test(`index flags: ${flag} cannot hide executable-mode or entry-type changes`, async (t) => {
    if (process.platform === 'win32') return t.skip('Windows worktrees do not expose Git executable/symlink mode reliably');
    const fx = await newRepo('idxflag-mode-type');
    await fx.write('tool.sh', '#!/bin/sh\necho baseline\n');
    await fx.write('active', 'ordinary file\n');
    await fx.write('target.txt', 'target remains\n');
    await fx.commit('plain file identities');
    const wt = await fx.worktree('w');
    try {
      await fx.git(['update-index', flag, 'tool.sh', 'active'], wt);
      await fs.chmod(path.join(wt, 'tool.sh'), 0o755);
      await fs.rm(path.join(wt, 'active'));
      await fs.symlink('target.txt', path.join(wt, 'active'));

      assert.equal(await statusOf(fx, wt), '', `premise: ${flag} must suppress both changes`);
      const { ws, verdict } = await verdictFor(fx);
      assert.ok(ws.uncommitted.files.includes('tool.sh'),
        `the executable-only delta must be work: ${JSON.stringify(ws.uncommitted)}`);
      assert.ok(ws.uncommitted.files.includes('active'),
        `the file-to-symlink type change must be work: ${JSON.stringify(ws.uncommitted)}`);
      assert.equal(verdict.safe, false);
      for (const rel of ['tool.sh', 'active']) {
        const guarded = await assessCommand(`rm ${rel}`, wt);
        assert.equal(guarded.decision, 'deny', `${flag} ${rel}: ${JSON.stringify(guarded)}`);
      }
    } finally { await fx.cleanup(); }
  });
}

test('index flags: a suppressed symlink-target edit is compared as link bytes, not followed content', async (t) => {
  if (process.platform === 'win32') return t.skip('symlink creation is privilege-dependent on Windows');
  const fx = await newRepo('idxflag-symlink-target');
  await fx.write('target-a', 'same target bytes\n');
  await fx.write('target-b', 'same target bytes\n');
  await fs.symlink('target-a', path.join(fx.root, 'active'));
  await fx.commit('tracked symlink');
  const wt = await fx.worktree('w');
  try {
    await fx.git(['update-index', '--assume-unchanged', 'active'], wt);
    await fs.rm(path.join(wt, 'active'));
    await fs.symlink('target-b', path.join(wt, 'active'));
    assert.equal(await statusOf(fx, wt), '', 'premise: assume-unchanged hides the target change');
    const { ws, verdict } = await verdictFor(fx);
    assert.ok(ws.uncommitted.files.includes('active'));
    assert.equal(verdict.safe, false,
      'identical referent bytes do not make two different symlink target strings the same entry');
  } finally { await fx.cleanup(); }
});

test('index flags: the flag ALONE is not the evidence — an absent path is not at risk (sparse checkout)', async () => {
  // `git sparse-checkout` sets the skip-worktree bit on every excluded path. If holt refused on
  // the bit rather than on the file, every sparse checkout in the world would report unknown.
  const fx = await newRepo('idxflag-sparse');
  await fx.write('config/local.json', '{"token":"PLACEHOLDER"}\n');
  await fx.commit('add config');
  const wt = await fx.worktree('w');
  await fx.git(['sparse-checkout', 'set', 'src'], wt);
  try {
    assert.match(await fx.git(['ls-files', '-v'], wt), /^S config\/local\.json$/m,
      'premise broken: sparse-checkout is supposed to use the skip-worktree bit');
    await assert.rejects(fs.stat(path.join(wt, 'config/local.json')),
      'premise broken: the excluded path should not be on disk');

    const { ws, verdict } = await verdictFor(fx);
    assert.equal(verdict.safe, true, 'a sparse checkout with no work in it is still disposable');
    assert.deepEqual(contentAtRisk(ws).blind, [], 'and nothing about it is unmeasurable');
  } finally { await fx.cleanup(); }
});

test('index flags: a flagged file identical to its index blob stays CLEAN — a clean tree is a real answer', async () => {
  const { fx, wt } = await flaggedFixture('--skip-worktree', { modify: false });
  try {
    const { ws, verdict } = await verdictFor(fx);
    assert.equal(verdict.safe, true, 'unmodified means unmodified');
    assert.deepEqual(contentAtRisk(ws).blind, []);
    const v = await assessCommand('rm config/local.json', wt);
    assert.equal(v.decision, 'allow',
      `flagged-but-unmodified must not be refused; got ${v.decision}: ${v.reason}`);
  } finally { await fx.cleanup(); }
});

test('index flags: content is compared through git filters, so an eol-converted file is not called destroyed work', async () => {
  // A `text eol=crlf` file is CRLF on disk and LF in the index BY DESIGN. Comparing raw bytes —
  // what a hand-rolled sha1 does — makes every such file look modified. Measured: this file
  // hashes to the index oid under `git hash-object` and to a different oid under `--no-filters`.
  const fx = await newRepo('idxflag-eol');
  await fx.write('.gitattributes', '*.txt text eol=crlf\n');
  await fx.write('notes.txt', 'line one\nline two\n');
  await fx.commit('add notes');
  const wt = await fx.worktree('w');
  try {
    // Put the CRLF form on disk, which is exactly what git checks out for this attribute.
    await fs.writeFile(path.join(wt, 'notes.txt'), 'line one\r\nline two\r\n');
    await fx.git(['update-index', '--skip-worktree', 'notes.txt'], wt);
    assert.ok((await fs.readFile(path.join(wt, 'notes.txt'))).includes('\r\n'),
      'premise broken: the fixture file should be CRLF on disk');
    assert.equal(await statusOf(fx, wt), '', 'premise broken: git considers this file unchanged');

    const v = await assessCommand('rm notes.txt', wt);
    assert.equal(v.decision, 'allow', `got ${v.decision}: ${v.reason}`);
    assert.equal((await verdictFor(fx)).verdict.safe, true);
  } finally { await fx.cleanup(); }
});

test('index flags: a generated-looking flagged edit requires confirmation, never a silent allow', async () => {
  const fx = await newRepo('idxflag-nm');
  await fx.write('package.json', '{"name":"x"}\n');
  await fx.write('node_modules/pkg/index.js', 'module.exports = 1;\n');
  await fx.commit('add deps');
  const wt = await fx.worktree('w');
  try {
    await fx.git(['update-index', '--skip-worktree', 'node_modules/pkg/index.js'], wt);
    await fx.write('node_modules/pkg/index.js', 'module.exports = 2; // hand patch\n', wt);
    // A manifest and pathname make this LIKELY build output, but cannot prove the hand patch is
    // reproducible. Ask keeps cleanup usable without licensing irreversible loss.
    const v = await assessCommand('rm -rf node_modules', wt);
    assert.equal(v.decision, 'ask', `got ${v.decision}: ${v.reason}`);
    assert.match(v.reason, /cannot prove|Confirm/i);
  } finally { await fx.cleanup(); }
});

test('index flags: an unreadable flagged path is UNKNOWN — never silently clean, never a bare deny', async () => {
  const fx = await newRepo('idxflag-unknown');
  await fx.write('secretdir', 'placeholder\n');
  await fx.commit('add path');
  const wt = await fx.worktree('w');
  try {
    await fx.git(['update-index', '--skip-worktree', 'secretdir'], wt);
    // Replace the regular file with an EMPTY DIRECTORY at the same path: the index records a
    // blob, the filesystem holds something holt cannot hash, and — deliberately — there is no
    // untracked content inside, so nothing but the index flag can produce a verdict here.
    await fs.rm(path.join(wt, 'secretdir'));
    await fs.mkdir(path.join(wt, 'secretdir'));

    // The guard ASKS: not allow (the old behaviour), and not deny on evidence it does not have.
    const v = await assessCommand('rm -rf secretdir', wt);
    assert.equal(v.decision, 'ask', `got ${v.decision}: ${v.reason}`);
    assert.match(v.reason, /skip-worktree|assume-unchanged|index flag/i);

    // And the scan refuses to call it disposable, naming the blindness.
    const { ws, verdict } = await verdictFor(fx);
    assert.ok(contentAtRisk(ws).blind.length > 0,
      'an unresolvable flagged path must register as blindness');
    assert.equal(verdict.safe, false);
  } finally { await fx.cleanup(); }
});
