/**
 * holt — the monster round, pinned.
 *
 * eval/monster.mjs builds the worst repository we know how to build — 40+ worktrees here
 * (80–150 in the full runs, all survived), four languages, junk heaps, buried gold, lying names,
 * unicode, nested repos, foreign locks, broken registrations, gitignored-only trees — then runs
 * the COMPLETE loop (scan → verdicts → protect → clean --apply → rescue) and grades every
 * planted item by bytes. The script exits non-zero on any wrong verdict, so this wrapper only
 * has to run it.
 *
 * Round 1 at 80 trees found a real bug within minutes of existing: ls-tree C-quotes non-ASCII
 * paths, so rescue's verification refused correct unicode captures. That is exactly why this is
 * pinned rather than run once and admired.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'eval', 'monster.mjs');

test('MONSTER: 40 worktrees of every trap at once — full loop, every byte graded', async (t) => {
  const work = path.join(os.tmpdir(), `holt-monster-ci-${process.pid}`);
  const out = path.join(os.tmpdir(), `holt-monster-ci-${process.pid}.json`);
  t.after(async () => {
    await fs.rm(out, { force: true });
    await fs.rm(`${out}.sha256`, { force: true });
  });
  const r = await new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, '40', '--work', work, '--out', out], {
      timeout: 600_000, maxBuffer: 64 * 1024 * 1024,
      env: process.env,
    }, (err, stdout, stderr) => resolve({
      code: err ? (err.code ?? 1) : 0, out: `${stdout}\n${stderr}`,
    }));
  });

  assert.equal(r.code, 0, `monster round failed:\n${r.out.slice(-1500)}`);
  assert.match(r.out, /MONSTER SURVIVED/, 'the survival line must be printed, not implied');
  assert.match(r.out, /diagnostic verdicts: ALL CORRECT/);

  const [encoded, sidecar] = await Promise.all([
    fs.readFile(out, 'utf8'),
    fs.readFile(`${out}.sha256`, 'utf8'),
  ]);
  const artifact = JSON.parse(encoded);
  assert.equal(artifact.kind, 'holt-monster-evaluation');
  assert.equal(artifact.schemaVersion, 2);
  assert.equal(artifact.protocol.requestedWorktrees, 40);
  assert.equal(artifact.protocol.sourceBound, true);
  assert.equal(artifact.protocol.installedArtifactBound, false);
  assert.equal(artifact.fixture.builtWorktrees >= 40, true);
  assert.equal(artifact.fixture.denominators.reportWorkstreams, artifact.fixture.builtWorktrees);
  assert.equal(artifact.oracle.diagnosticCorrect, true);
  assert.equal(artifact.oracle.finalErrors.length, 0);
  const lifecycle = artifact.oracle.lifecycle;
  assert.equal(artifact.fixture.denominators.plantedLifecycleRecords, lifecycle.records.length);
  assert.equal(lifecycle.records.length, artifact.fixture.builtWorktrees,
    'every built secondary worktree needs one lifecycle record');
  assert.equal(artifact.fixture.denominators.expectedQuarantines, lifecycle.summary.expectedQuarantine);
  assert.equal(lifecycle.summary.planted, lifecycle.records.length);
  assert.equal(lifecycle.summary.quarantined, lifecycle.summary.expectedQuarantine,
    'every independently expected disposable worktree must really enter quarantine');
  assert.equal(lifecycle.summary.exactAfterClean, lifecycle.summary.planted,
    'every planted worktree must retain exact filesystem/Git identity through clean');
  assert.equal(lifecycle.summary.exactTerminal, lifecycle.summary.planted,
    'every planted worktree needs an exact terminal recovery identity');
  assert.equal(lifecycle.summary.cleanFailures, 0);
  assert.equal(lifecycle.summary.cleanSkips, 0);
  assert.equal(lifecycle.summary.remainingQuarantines, 0);
  assert.equal(lifecycle.summary.remainingTransitions, 0);
  assert.equal(lifecycle.summary.noOpRedControl, false);
  assert.equal(lifecycle.finalInventory.count, 0);
  assert.equal(lifecycle.finalInventory.transitions.length, 0);

  for (const record of lifecycle.records) {
    assert.equal(record.exactAfterClean, true, `${record.id}: after-clean identity`);
    assert.equal(record.terminal.exactDurable, true, `${record.id}: terminal identity`);
    assert.equal(record.afterAllActions.exactDurable, true, `${record.id}: after all lifecycle/rescue actions`);
    if (record.expectedDisposition === 'quarantine') {
      assert.equal(record.cleanAction.action, 'quarantined', `${record.id}: real clean action`);
      assert.notEqual(record.cleanAction.quarantinePath, record.originalPath);
      assert.equal(record.afterClean.identity.manifest.sha256, record.before.manifest.sha256);
      assert.equal(record.afterClean.identity.head, record.before.head);
      assert.equal(record.afterClean.identity.branch, record.before.branch);
      assert.equal(record.afterClean.registration.locked, true);
      assert.match(record.afterClean.registration.lockReason, /^holt: clean quarantine/);
      assert.deepEqual(record.cleanAction.restoreArgv[0], [
        'git', 'worktree', 'move', '-f', '-f', record.cleanAction.quarantinePath, record.originalPath,
      ]);
      assert.deepEqual(record.cleanAction.restoreArgv[1], [
        'git', 'worktree', 'unlock', record.originalPath,
      ]);
    } else {
      assert.equal(record.cleanAction, null, `${record.id}: held state must not receive a clean action`);
    }
  }

  assert.equal(lifecycle.operations.restore.exactDurable, true);
  assert.equal(lifecycle.operations.purge.exactDurable, true);
  assert.equal(lifecycle.operations.purge.preview.dryRun, true);
  assert.equal(lifecycle.operations.purge.result.purged, true);
  assert.match(lifecycle.operations.purge.result.recoveryRef, /^refs\/holt\/purge\//);
  assert.equal(lifecycle.operations.dirtyPurgeRefusal.correct, true);
  assert.equal(lifecycle.operations.dirtyPurgeRefusal.result.blocked, true);
  assert.equal(lifecycle.operations.dirtyPurgeRefusal.restored.exactDurable, true);
  assert.equal(lifecycle.operations.purgeRace.correct, true);
  assert.equal(lifecycle.operations.purgeRace.seamRan, true);
  assert.equal(lifecycle.operations.purgeRace.result.relocked, true);
  assert.match(lifecycle.operations.purgeRace.result.recoveryRef, /^refs\/holt\/purge\//);
  assert.equal(lifecycle.operations.purgeRace.restored.exactDurable, true);

  const foreignLocks = lifecycle.records.filter((record) => record.categories.includes('foreign-locked'));
  assert.ok(foreignLocks.length > 0, 'the fixture must plant at least one foreign lock');
  for (const record of foreignLocks) {
    assert.equal(record.registrationBefore.locked, true);
    assert.equal(record.afterClean.registration.locked, true);
    assert.equal(record.afterClean.registration.path, record.registrationBefore.path);
    assert.equal(record.afterClean.registration.lockReason, record.registrationBefore.lockReason);
  }

  assert.equal(artifact.oracle.rescueVerified, artifact.oracle.rescueRequested);
  for (const rescued of artifact.oracle.rescueSample) {
    assert.equal(rescued.bytesVerified, true, `${rescued.id}: exact rescue bytes`);
    assert.equal(rescued.rescued.sha256, rescued.expected.sha256);
    assert.equal(rescued.rescued.bytes, rescued.expected.bytes);
    assert.equal(rescued.rescued.gitMode, (rescued.expected.mode & 0o111) ? '100755' : '100644');
  }
  assert.equal(artifact.outcome.correct, true);
  assert.equal(artifact.outcome.valid, artifact.source.stable,
    'product correctness and evidence-source stability are separate gates');
  assert.equal(artifact.outcome.publicationEligible, false, 'source-bound evidence cannot prove the installed package');

  const raw = { ...artifact };
  delete raw.artifact;
  delete raw.summary;
  const semantic = `sha256:${createHash('sha256').update(JSON.stringify(raw)).digest('hex')}`;
  assert.equal(artifact.artifact.identity, semantic);
  const fileSha = createHash('sha256').update(encoded).digest('hex');
  assert.equal(sidecar, `${fileSha}  ${path.basename(out)}\n`);
  assert.equal(await fs.stat(work).then(() => true, () => false), false, 'owned scratch is cleaned after evidence is written');
});

test('MONSTER RED CONTROL: a no-op clean can never survive the lifecycle oracle', async () => {
  const work = path.join(os.tmpdir(), `holt-monster-noop-${process.pid}`);
  const r = await new Promise((resolve) => {
    execFile(process.execPath, [
      SCRIPT, '20', '--work', work, '--test-mutate-noop-clean',
    ], {
      timeout: 600_000, maxBuffer: 64 * 1024 * 1024,
      env: process.env,
    }, (err, stdout, stderr) => resolve({
      code: err ? (err.code ?? 1) : 0, out: `${stdout}\n${stderr}`,
    }));
  });

  assert.notEqual(r.code, 0, `a no-op cleaner produced a false green:\n${r.out.slice(-2000)}`);
  assert.match(r.out, /diagnostic verdicts: ALL CORRECT/,
    'the red result must come from lifecycle execution, not an unrelated verdict failure');
  assert.match(r.out, /NO-OP RED CONTROL/);
  assert.match(r.out, /clean quarantined 0\/4 expected worktrees/);
  assert.doesNotMatch(r.out, /MONSTER SURVIVED/);
  assert.equal(await fs.stat(work).then(() => true, () => false), false,
    'the red-control fixture still cleans its exact marker-owned scratch');
});

test('MONSTER evidence is write-once and refuses before creating destructive scratch', async (t) => {
  const work = path.join(os.tmpdir(), `holt-monster-refusal-${process.pid}`);
  const out = path.join(os.tmpdir(), `holt-monster-refusal-${process.pid}.json`);
  const sentinel = 'existing evidence must survive\n';
  await fs.writeFile(out, sentinel, 'utf8');
  t.after(async () => {
    await fs.rm(out, { force: true });
    await fs.rm(work, { recursive: true, force: true });
  });

  const r = await new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, '20', '--work', work, '--out', out], {
      timeout: 30_000, maxBuffer: 4 * 1024 * 1024, env: process.env,
    }, (err, stdout, stderr) => resolve({
      code: err ? (err.code ?? 1) : 0, out: `${stdout}\n${stderr}`,
    }));
  });

  assert.notEqual(r.code, 0);
  assert.match(r.out, /refusing to overwrite existing monster evidence/);
  assert.equal(await fs.readFile(out, 'utf8'), sentinel);
  assert.equal(await fs.stat(work).then(() => true, () => false), false,
    'evidence refusal happens before the scratch root is created');
});
