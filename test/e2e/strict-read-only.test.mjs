/**
 * holt — `--strict-read-only`, proven rather than asserted.
 *
 * USAGE says the flag means "never write objects; committed deltas become APPROXIMATE". Two
 * separate claims are bundled in that sentence, and each gets its own proof here:
 *
 *   1. NO OBJECTS WRITTEN. Measured with `git count-objects -v`, before and after, on the exact
 *      fixture that (in normal mode) forces holt to write merge-tree's unreferenced trees. A test
 *      that only checks strict mode writes nothing, without ever showing the same measurement
 *      CAN detect a write, would not be evidence — so the non-strict run on the identical fixture
 *      is the positive control: it MUST show new objects, or this test is blind.
 *
 *   2. THE DEGRADED ANSWERS SAY SO. Every verdict whose truth depends on the committed-delta
 *      instrument is labelled 'approximate', never presented as a plain 'measured' fact — a
 *      degraded answer that looks identical to a solid one is worse than an error.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { standardFixture } from '../fixtures.mjs';
import { inspect } from '../../src/index.mjs';

/** `git count-objects -v` parsed to a plain object: { count, size, 'in-pack', packs, ... }. */
function countObjects(cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', ['count-objects', '-v'], { cwd }, (err, stdout) => {
      if (err) return reject(err);
      const out = {};
      for (const line of stdout.trim().split('\n')) {
        const [k, v] = line.split(':').map((s) => s.trim());
        if (k) out[k] = Number(v);
      }
      resolve(out);
    });
  });
}

test('STRICT-READ-ONLY: writes zero objects, on a fixture proven to write objects otherwise', async (t) => {
  // TWO INDEPENDENT REPOSITORIES, deliberately — not one fixture scanned twice.
  //
  // git objects are content-addressed: a tree of identical file contents hashes to the identical
  // oid every time. Scanning ONE fixture in normal mode first (to populate the positive control)
  // and then in strict mode second would let a BROKEN strict-read-only silently reuse the objects
  // the earlier normal-mode run already wrote — same base, same heads, same resulting trees,
  // `git count-objects` sees no new objects either way, and this test would pass while the flag
  // was completely defeated. (This is not hypothetical: an earlier draft of this exact test made
  // that mistake and could not tell a working strict-read-only from a broken one — the fixture
  // for the actual contract check must never have had merge-tree run against it by anyone.)
  const control = await standardFixture();
  t.after(() => control.fx.cleanup());
  const subject = await standardFixture();
  t.after(() => subject.fx.cleanup());

  // --- POSITIVE CONTROL: normal mode, on a fixture never before scanned, must write objects. -
  // If this assertion ever fails, the contract check below is not proving anything — it would
  // be "strict mode wrote nothing" on a fixture that writes nothing either way.
  const beforeControl = await countObjects(control.fx.root);
  await inspect(control.fx.root, { strictReadOnly: false });
  const afterControl = await countObjects(control.fx.root);
  assert.ok(
    afterControl.count > beforeControl.count,
    `expected the non-strict scan to write loose objects (merge-tree --write-tree) as its ` +
    `positive control; count went ${beforeControl.count} -> ${afterControl.count}. If merge-tree ` +
    `no longer writes unreferenced objects on this fixture, this test can no longer detect a ` +
    `strict-read-only regression and must be re-based on a fixture that does.`,
  );

  // --- THE ACTUAL CONTRACT: strict-read-only writes none, on the UNTOUCHED subject repo. -----
  const beforeStrict = await countObjects(subject.fx.root);
  const report = await inspect(subject.fx.root, { strictReadOnly: true });
  const afterStrict = await countObjects(subject.fx.root);

  assert.equal(
    afterStrict.count, beforeStrict.count,
    `--strict-read-only must write zero objects; count went ${beforeStrict.count} -> ${afterStrict.count}`,
  );
  assert.equal(afterStrict['in-pack'] ?? 0, beforeStrict['in-pack'] ?? 0);
  assert.equal(report.strictReadOnly, true);
});

test('STRICT-READ-ONLY: degraded verdicts are labelled approximate, never presented as measured', async (t) => {
  const { fx, truth } = await standardFixture();
  t.after(() => fx.cleanup());

  const report = await inspect(fx.root, { strictReadOnly: true });

  // Every workstream whose committed-delta answer strict mode can only approximate must say so.
  // (An 'unknown' — instrument failure, unrelated to strictReadOnly — is a different, allowed
  // confidence value and is excluded here; only 'measured' would be the false-precision bug.)
  for (const s of report.safe) {
    assert.notEqual(s.confidence, 'measured',
      `${s.id}: strict-read-only must never present a committed-delta verdict as measured`);
    if (s.confidence !== 'unknown') assert.equal(s.confidence, 'approximate');
  }

  // Specifically: the worktree the standard fixture engineered to prove the merge-tree/three-dot
  // gap (`alreadyLanded` — base independently reacquired identical content) is disposable under
  // the real merge-tree instrument. Under the three-dot approximation strict mode falls back to,
  // that same worktree over-reports a committed delta base does NOT lack — the exact caveat
  // documented in USAGE ("committed deltas become APPROXIMATE (over-report)"). Confirm it is
  // still findable in the report and still labelled, rather than silently dropped or silently
  // upgraded to a confident answer.
  const landed = report.safe.find((s) => s.id === 'alreadyLanded');
  assert.ok(landed, 'alreadyLanded must still appear in strict-read-only output');
  assert.notEqual(landed.confidence, 'measured');

  // The non-strict run (positive control for the ANSWER, mirroring the object-write control
  // above) gets this one right, by construction of the fixture: merge-tree sees base already
  // holds the identical content, so alreadyLanded is correctly 'measured' and safe.
  const normalReport = await inspect(fx.root, { strictReadOnly: false });
  const landedNormal = normalReport.safe.find((s) => s.id === 'alreadyLanded');
  assert.ok(landedNormal);
  assert.equal(landedNormal.confidence, 'measured');
  assert.equal(landedNormal.safe, true);
  assert.ok(truth.disposable.includes('alreadyLanded')); // ground truth, restated for the reader
});
