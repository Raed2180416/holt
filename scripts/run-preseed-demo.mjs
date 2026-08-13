#!/usr/bin/env node
// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * Reproducible pre-seed demo: prove content-grounded refusal plus quarantine and restoration.
 *
 * The fixture is created outside this repository. Holt mutates only that synthetic fixture: one
 * measured-empty worktree is moved into recoverable quarantine and restored byte-for-byte. Pass
 * --keep to retain the restored fixture, --json for the evidence packet, and --cli=/absolute/path
 * to exercise another checkout or an unpacked release's bin/holt.mjs.
 */

import process from 'node:process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newRepo } from '../test/fixtures.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliOption = process.argv.find((arg) => arg.startsWith('--cli='));
const cli = cliOption
  ? path.resolve(process.cwd(), cliOption.slice('--cli='.length))
  : path.join(projectRoot, 'bin', 'holt.mjs');
const keep = process.argv.includes('--keep');
const json = process.argv.includes('--json');

const proofFiles = ['README.md', 'config/registry.mjs', 'src/base.js'];

async function exists(abs) {
  return fs.lstat(abs).then(() => true, () => false);
}

async function worktreeDigest(root) {
  const hash = createHash('sha256');
  for (const rel of proofFiles) {
    hash.update(rel);
    hash.update('\0');
    hash.update(await fs.readFile(path.join(root, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function run(file, args, cwd) {
  return new Promise((resolve) => {
    execFile(file, args, {
      cwd,
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        LC_ALL: 'C',
      },
    }, (error, stdout, stderr) => resolve({
      code: error ? (Number.isInteger(error.code) ? error.code : -1) : 0,
      stdout: String(stdout ?? ''),
      stderr: String(stderr ?? ''),
    }));
  });
}

async function holt(args, cwd) {
  const result = await run(process.execPath, [cli, ...args], cwd);
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    // The caller's assertions below turn malformed output into a failed proof packet while
    // preserving the actual bytes for diagnosis.
  }
  return { ...result, parsed };
}

function byId(rows, id) {
  return (rows ?? []).find((row) => row.id === id);
}

// The recovery ledger is serialized by different Git/path layers on Windows: one may retain
// forward slashes while another returns the native separator (and case is not identity on the
// default filesystem). Compare the same physical path, not its presentation spelling.
function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32'
      ? resolved.replace(/[\\/]+/g, '\\').toLowerCase()
      : path.normalize(resolved);
  };
  return normalize(left) === normalize(right);
}

const alarming = 'DELETEME-old-experiment';
const reassuring = 'IMPORTANT-do-not-delete';
const fixture = await newRepo('preseed-name-independence');
let packet;

try {
  await fixture.write('.gitignore', '.env\n');
  await fixture.commit('declare ignored local material');

  const alarmingPath = await fixture.worktree(alarming);
  await fixture.worktree(reassuring);

  // Three recovery classes ordinary branch inspection misses: a modified tracked file, an
  // untracked note, and an ignored local artifact. The values are synthetic and contain no secret.
  await fixture.write('src/base.js', 'export function baseline() { return 2; }\n', alarmingPath);
  await fixture.write('notes/only-copy.md', '# only copy of the incident finding\n', alarmingPath);
  await fixture.write('.env', 'DEMO_RECOVERY_TOKEN=synthetic-not-a-secret\n', alarmingPath);

  const [status, alarmingGate, reassuringGate, cleanPreview, revision, sourceStatus, targetVersion] = await Promise.all([
    holt(['status', '--json'], fixture.root),
    holt(['gate', alarming, '--json'], fixture.root),
    holt(['gate', reassuring, '--json'], fixture.root),
    holt(['clean', '--json'], fixture.root),
    run('git', ['rev-parse', 'HEAD'], projectRoot),
    run('git', ['status', '--porcelain=v1', '--untracked-files=no'], projectRoot),
    run(process.execPath, [cli, '--version'], fixture.root),
  ]);

  const alarmingUnique = byId(status.parsed?.unique, alarming);
  const alarmingVerdict = alarmingGate.parsed;
  const reassuringVerdict = reassuringGate.parsed;
  const preview = cleanPreview.parsed;
  const reassuringPath = fixture.wt(reassuring);
  const beforeHead = (await run('git', ['rev-parse', 'HEAD'], reassuringPath)).stdout.trim();
  const beforeDigest = await worktreeDigest(reassuringPath);

  const cleanApply = await holt(['clean', '--apply', '--json'], fixture.root);
  const applied = byId(cleanApply.parsed?.quarantines, reassuring);
  const quarantinePath = applied?.quarantinePath ?? null;
  const originalAbsentDuringQuarantine = !(await exists(reassuringPath));
  const quarantinePresent = typeof quarantinePath === 'string' && await exists(quarantinePath);
  const quarantineDigest = quarantinePresent ? await worktreeDigest(quarantinePath) : null;
  const quarantineInventory = await holt(['quarantines', '--json'], fixture.root);
  const inventoried = byId(quarantineInventory.parsed?.quarantines, reassuring);

  const restore = await holt(['restore', reassuring, '--json'], fixture.root);
  const originalPresentAfterRestore = await exists(reassuringPath);
  const quarantineAbsentAfterRestore = typeof quarantinePath === 'string'
    ? !(await exists(quarantinePath))
    : false;
  const afterDigest = originalPresentAfterRestore ? await worktreeDigest(reassuringPath) : null;
  const afterHead = originalPresentAfterRestore
    ? (await run('git', ['rev-parse', 'HEAD'], reassuringPath)).stdout.trim()
    : null;
  const afterStatus = originalPresentAfterRestore
    ? await run('git', ['status', '--porcelain=v1'], reassuringPath)
    : { code: -1, stdout: '', stderr: 'restored path absent' };
  const postRestoreGate = await holt(['gate', reassuring, '--json'], fixture.root);
  const checks = {
    statusWasMachineReadable: status.code === 0 && status.parsed !== null,
    alarmingNameWasRefused: alarmingGate.code === 1
      && alarmingVerdict?.decision === 'holds_work'
      && alarmingVerdict?.safeToDelete === false,
    trackedEditWasObserved: alarmingUnique?.pathsByLayer?.uncommitted?.includes('src/base.js') === true,
    untrackedFileWasObserved: alarmingUnique?.pathsByLayer?.untracked?.includes('notes/only-copy.md') === true,
    ignoredFileWasObserved: alarmingUnique?.pathsByLayer?.ignored?.includes('.env') === true,
    reassuringNameWasAccepted: reassuringGate.code === 0
      && reassuringVerdict?.decision === 'removable_now'
      && reassuringVerdict?.safeToDelete === true,
    cleanStayedDryRun: cleanPreview.code === 0 && preview?.dryRun === true,
    cleanKeptUniqueWork: byId(preview?.keeping, alarming) !== undefined,
    cleanSelectedOnlyMeasuredEmptyWorktree: byId(preview?.wouldQuarantine, reassuring) !== undefined
      && byId(preview?.wouldQuarantine, alarming) === undefined,
    cleanAppliedOnlyMeasuredEmptyWorktree: cleanApply.code === 0
      && cleanApply.parsed?.quarantined === 1
      && applied !== undefined
      && byId(cleanApply.parsed?.quarantines, alarming) === undefined,
    restoreRecipeReturned: Array.isArray(applied?.restoreArgv) && applied.restoreArgv.length > 0,
    quarantineMoveObserved: originalAbsentDuringQuarantine && quarantinePresent,
    quarantineInventoryObserved: quarantineInventory.code === 0
      && samePath(inventoried?.quarantinePath, quarantinePath),
    quarantineBytesMatchBefore: quarantineDigest === beforeDigest,
    restoreSucceeded: restore.code === 0 && restore.parsed?.ok === true
      && restore.parsed?.restored === true,
    restoredPathObserved: originalPresentAfterRestore && quarantineAbsentAfterRestore,
    restoredBytesMatchBefore: afterDigest === beforeDigest,
    restoredHeadMatchesBefore: afterHead === beforeHead,
    restoredWorktreeIsClean: afterStatus.code === 0 && afterStatus.stdout === '',
    restoredVerdictMatchesBefore: postRestoreGate.code === 0
      && postRestoreGate.parsed?.decision === 'removable_now',
  };

  packet = {
    schemaVersion: 1,
    scenario: 'content verdict overrides names and a recoverable cleanup round-trip preserves bytes',
    passed: Object.values(checks).every(Boolean),
    checks,
    source: {
      revision: revision.code === 0 ? revision.stdout.trim() : null,
      trackedTreeDirty: sourceStatus.code === 0 ? sourceStatus.stdout.trim().length > 0 : null,
      targetCli: cli,
      targetVersion: targetVersion.code === 0 ? targetVersion.stdout.trim() : null,
    },
    fixture: {
      retained: keep,
      root: keep ? fixture.root : null,
      alarmingName: alarming,
      reassuringName: reassuring,
      plantedLayers: ['modified tracked', 'untracked', 'ignored'],
    },
    commands: [
      `holt status --json`,
      `holt gate ${alarming} --json`,
      `holt gate ${reassuring} --json`,
      'holt clean --json',
      'holt clean --apply --json',
      'holt quarantines --json',
      `holt restore ${reassuring} --json`,
      `holt gate ${reassuring} --json`,
    ],
    observations: {
      alarmingName: {
        exitCode: alarmingGate.code,
        decision: alarmingVerdict?.decision ?? null,
        safeToDelete: alarmingVerdict?.safeToDelete ?? null,
        reasons: alarmingVerdict?.reasons ?? [],
        pathsByLayer: alarmingUnique?.pathsByLayer ?? null,
      },
      reassuringName: {
        exitCode: reassuringGate.code,
        decision: reassuringVerdict?.decision ?? null,
        safeToDelete: reassuringVerdict?.safeToDelete ?? null,
        reasons: reassuringVerdict?.reasons ?? [],
      },
      cleanPreview: {
        dryRun: preview?.dryRun ?? null,
        wouldQuarantine: (preview?.wouldQuarantine ?? []).map((row) => row.id),
        keeping: (preview?.keeping ?? []).map((row) => row.id),
        note: preview?.note ?? null,
      },
      transaction: {
        cleanExitCode: cleanApply.code,
        quarantined: cleanApply.parsed?.quarantined ?? null,
        id: applied?.id ?? null,
        originalPath: keep ? reassuringPath : null,
        quarantinePath: keep ? quarantinePath : null,
        restoreArgv: applied?.restoreArgv ?? null,
        inventoryCount: quarantineInventory.parsed?.count ?? null,
        restoreExitCode: restore.code,
        restored: restore.parsed?.restored ?? false,
        beforeHead,
        afterHead,
        beforeDigest,
        quarantineDigest,
        afterDigest,
        worktreeCleanAfterRestore: afterStatus.code === 0 && afterStatus.stdout === '',
      },
    },
  };
} finally {
  if (!keep) await fixture.cleanup();
}

if (json) {
  process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`);
} else {
  const mark = packet.passed ? 'PASS' : 'FAIL';
  process.stdout.write(`${mark}: Holt followed the bytes, not the labels.\n\n`);
  process.stdout.write(`${alarming}\n`);
  process.stdout.write(`  gate exit ${packet.observations.alarmingName.exitCode}: ${packet.observations.alarmingName.decision}\n`);
  process.stdout.write(`  observed: tracked edit, untracked note, ignored .env\n\n`);
  process.stdout.write(`${reassuring}\n`);
  process.stdout.write(`  gate exit ${packet.observations.reassuringName.exitCode}: ${packet.observations.reassuringName.decision}\n\n`);
  process.stdout.write('clean preview\n');
  process.stdout.write(`  keep: ${packet.observations.cleanPreview.keeping.join(', ')}\n`);
  process.stdout.write(`  quarantine: ${packet.observations.cleanPreview.wouldQuarantine.join(', ')}\n`);
  process.stdout.write('  no worktree was moved by the preview\n\n');
  process.stdout.write('recoverable transaction\n');
  process.stdout.write(`  quarantined: ${packet.observations.transaction.id}\n`);
  process.stdout.write(`  restore argv: ${JSON.stringify(packet.observations.transaction.restoreArgv)}\n`);
  process.stdout.write(`  restored: ${packet.observations.transaction.restored}\n`);
  process.stdout.write(`  byte digest before/after: ${packet.observations.transaction.beforeDigest}\n`);
  process.stdout.write('  no files or branches were deleted\n');
  if (keep) process.stdout.write(`\nfixture retained at ${packet.fixture.root}\n`);
  process.stdout.write('\nRun with --json for the assertion-level evidence packet.\n');
}

if (!packet.passed) process.exitCode = 1;
