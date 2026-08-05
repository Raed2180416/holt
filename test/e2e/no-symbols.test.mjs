// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * `--no-symbols` is a performance mode, not a different safety policy.
 *
 * The contract has two deliberately separate halves:
 *   - file/Git evidence that authorises or refuses destructive work must be identical;
 *   - symbol-derived duplicate and semantic evidence is intentionally absent and must not be
 *     smuggled into an apparent equivalence claim.
 *
 * The second test proves the performance mechanism without a flaky stopwatch assertion. A fresh
 * child is given a planted `ctags` executable. `--no-symbols` completes without resolving it;
 * the otherwise-identical positive control reaches that backend boundary (and, on POSIX, records
 * the exact process invocation). This is deterministic avoided work. It is not a claim about a
 * universal wall-clock speedup.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { inspect } from '../../src/index.mjs';
import { standardFixture } from '../fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(ROOT, 'bin', 'holt.mjs');

function byId(rows, project) {
  return rows.map(project).sort((a, b) => a.id.localeCompare(b.id));
}

function safetyProjection(report) {
  return {
    counts: Object.fromEntries([
      'workstreams', 'scanned', 'skipped', 'families', 'safeToDelete', 'atRisk', 'stashAtRisk',
    ].map((key) => [key, report.counts[key]])),
    safe: byId(report.safe, (row) => ({
      id: row.id, safe: row.safe, confidence: row.confidence, prunable: row.prunable,
    })),
    fileLayers: byId(report.unique, (row) => ({
      id: row.id,
      committedFiles: row.committedFiles,
      uncommittedFileCount: row.uncommittedFileCount,
      ignoredFileCount: row.ignoredFileCount,
      pathsByLayer: row.pathsByLayer,
    })),
    provenCollisions: report.collisionsAll
      .filter((row) => row.kind === 'proven')
      .map((row) => ({
        a: row.a, b: row.b, kind: row.kind, severity: row.severity,
        mergeTreeConflict: row.mergeTreeConflict, sharedFiles: row.sharedFiles,
      }))
      .sort((a, b) => `${a.a}\0${a.b}`.localeCompare(`${b.a}\0${b.b}`)),
  };
}

function runStatus(cwd, args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, 'status', '--json', ...args], {
      cwd, env, maxBuffer: 32 * 1024 * 1024,
    }, (error, stdout, stderr) => resolve({
      code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
      stdout: String(stdout ?? ''), stderr: String(stderr ?? ''),
    }));
  });
}

function executableOnPath(name) {
  const resolver = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((resolve, reject) => {
    execFile(resolver, [name], { timeout: 10_000 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`${resolver} ${name}: ${stderr || error.message}`));
      const first = String(stdout).split(/\r?\n/).find(Boolean);
      if (!first) return reject(new Error(`${resolver} ${name}: empty result`));
      resolve(first.trim());
    });
  });
}

test('--no-symbols: safety decisions and Git-proven conflicts equal a full scan while symbol findings are explicitly absent', async (t) => {
  const { fx, truth } = await standardFixture();
  t.after(() => fx.cleanup());

  const full = await inspect(fx.root);
  const withoutSymbols = await inspect(fx.root, { symbols: false });

  assert.notEqual(full.backend.kind, 'disabled', 'positive control must run a symbol backend');
  assert.deepEqual(withoutSymbols.backend, {
    kind: 'disabled', label: 'symbols disabled', degraded: false,
  });
  assert.deepEqual(safetyProjection(withoutSymbols), safetyProjection(full),
    'skipping symbols must never change file-level loss authority or a Git-proven conflict');

  const disposable = withoutSymbols.safe.filter((row) => row.safe).map((row) => row.id).sort();
  assert.deepEqual(disposable, [...truth.disposable].sort(),
    'equivalence must include both a genuinely empty worktree and content already landed by another route');
  assert.deepEqual(
    withoutSymbols.collisions.map((row) => [row.a, row.b].sort()),
    [[...truth.collisionPair].sort()],
    'the planted textual conflict is still found from Git/file evidence alone',
  );

  assert.ok(full.duplicates.some((row) => [row.a, row.b].sort().join('\0') === [...truth.duplicatePair].sort().join('\0')),
    'positive control must prove the symbol-derived duplicate detector was live');
  assert.equal(withoutSymbols.duplicates.length, 0,
    'the file-level mode must not pretend it measured symbol-derived duplicates');
  assert.ok(full.unique.some((row) => row.uniqueSymbolCount > 0),
    'positive control must contain independently planted unique symbols');
  assert.ok(withoutSymbols.unique.every((row) => row.uniqueSymbolCount === 0),
    'no-symbol mode must expose the symbol denominator as zero, not stale or inferred evidence');
});

test('--no-symbols: a fresh CLI scan bypasses the planted symbol backend; the positive control reaches it', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-no-symbols-backend-'));
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));
  const fakeBin = path.join(scratch, 'bin');
  const fakeHome = path.join(scratch, 'holt-home');
  const fastTrace = path.join(scratch, 'fast-git-trace.txt');
  const controlTrace = path.join(scratch, 'control-git-trace.txt');
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.mkdir(fakeHome, { recursive: true });

  // On POSIX, present Git under the name `ctags`: it accepts the probe's `--version`, writes that
  // invocation to GIT_TRACE, and deliberately fails the "Universal Ctags" output check. Windows
  // gets a valid native Node image instead of a text file pretending to be an `.exe`; the latter
  // fails in CreateProcess before Holt can observe the intended unavailable-tool result.
  const gitExecutable = await executableOnPath('git');
  const fakeCtags = path.join(fakeBin, process.platform === 'win32' ? 'ctags.exe' : 'ctags');
  if (process.platform === 'win32') await fs.copyFile(process.execPath, fakeCtags);
  else await fs.symlink(gitExecutable, fakeCtags);

  const delimiter = process.platform === 'win32' ? ';' : ':';
  const baseEnv = {
    ...process.env,
    PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
    HOLT_HOME: fakeHome,
    NO_COLOR: '1', FORCE_COLOR: '0', LC_ALL: 'C', LANG: 'C',
  };

  const fast = await runStatus(fx.root, ['--no-symbols'], {
    ...baseEnv, GIT_TRACE: fastTrace,
  });
  assert.equal(fast.code, 0, fast.stderr || fast.stdout);
  const fastReport = JSON.parse(fast.stdout);
  assert.equal(fastReport.backend.kind, 'disabled');
  const fastLog = await fs.readFile(fastTrace, 'utf8');
  if (process.platform !== 'win32') {
    assert.doesNotMatch(fastLog, /built-in: git version(?:\s|$)/,
      '`--no-symbols` must not even run the planted ctags --version probe');
  }

  const control = await runStatus(fx.root, [], {
    ...baseEnv, GIT_TRACE: controlTrace,
  });
  assert.equal(control.code, 0, control.stderr || control.stdout);
  const controlReport = JSON.parse(control.stdout);
  assert.notEqual(controlReport.backend.kind, 'disabled');
  const controlLog = await fs.readFile(controlTrace, 'utf8');
  if (process.platform === 'win32') {
    assert.match(controlReport.backend.label, /ctags-(?:not-found|not-universal-ctags)/,
      `the positive control must report the planted Windows backend: ${controlReport.backend.label}`);
  } else {
    assert.match(controlLog, /built-in: git version(?:\s|$)/,
      `the otherwise-identical positive control must start the planted backend: ${controlLog}`);
  }
});
