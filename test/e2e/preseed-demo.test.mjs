import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('PRESEED DEMO: names cannot override content and quarantine restores exact bytes', async () => {
  const packet = await new Promise((resolve, reject) => {
    execFile(process.execPath, ['scripts/run-preseed-demo.mjs', '--json'], {
      cwd: root,
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(`demo failed: ${stderr || stdout || error.message}`));
      else resolve(JSON.parse(stdout));
    });
  });

  assert.equal(packet.passed, true, JSON.stringify(packet.checks));
  assert.equal(packet.observations.alarmingName.exitCode, 1);
  assert.equal(packet.observations.alarmingName.decision, 'holds_work');
  assert.deepEqual(packet.observations.alarmingName.pathsByLayer.ignored, ['.env']);
  assert.equal(packet.observations.reassuringName.exitCode, 0);
  assert.equal(packet.observations.reassuringName.decision, 'removable_now');
  assert.deepEqual(packet.observations.cleanPreview.keeping, ['DELETEME-old-experiment']);
  assert.deepEqual(packet.observations.cleanPreview.wouldQuarantine, ['IMPORTANT-do-not-delete']);
  assert.equal(packet.observations.cleanPreview.dryRun, true);
  assert.equal(packet.observations.transaction.quarantined, 1);
  assert.equal(packet.observations.transaction.id, 'IMPORTANT-do-not-delete');
  assert.ok(Array.isArray(packet.observations.transaction.restoreArgv));
  assert.equal(packet.observations.transaction.restored, true);
  assert.equal(packet.observations.transaction.beforeDigest, packet.observations.transaction.quarantineDigest);
  assert.equal(packet.observations.transaction.beforeDigest, packet.observations.transaction.afterDigest);
  assert.equal(packet.observations.transaction.beforeHead, packet.observations.transaction.afterHead);
  assert.equal(packet.observations.transaction.worktreeCleanAfterRestore, true);
  assert.equal(packet.fixture.retained, false);
  assert.equal(packet.fixture.root, null);
});
