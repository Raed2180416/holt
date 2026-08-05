#!/usr/bin/env node
// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * Prove the Git runtime contract before Holt's tests or installed artifact run.
 *
 * Runner-image labels are not runtime evidence. This script asks the selected executable for its
 * version, checks the 2.45 floor, and then probes the exact `--no-lazy-fetch` capability Holt
 * relies on. `--verify-inert-hooks` additionally plants a hook, proves the hook can run, and then
 * proves Holt's `/dev/null` hooks path suppresses it. The latter is run on Git for Windows in CI;
 * without the positive control, a missing or non-executable hook would make that check vacuous.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  INERT_GIT_HOOKS_PATH,
  NO_LAZY_FETCH_MIN_GIT,
  noLazyFetchSupported,
} from '../src/git.mjs';

export const MINIMUM_GIT_VERSION = `${NO_LAZY_FETCH_MIN_GIT.major}.${NO_LAZY_FETCH_MIN_GIT.minor}.0`;
export const GIT_RUNTIME_REQUIREMENT = `>=${MINIMUM_GIT_VERSION}`;

function runGit(argv, { cwd, git = 'git' } = {}) {
  return new Promise((resolve) => {
    execFile(git, argv, {
      cwd,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      env: process.env,
    }, (error, stdout, stderr) => resolve({
      ok: !error,
      code: error ? (error.code ?? 1) : 0,
      stdout: String(stdout ?? ''),
      stderr: String(stderr ?? ''),
      error: error?.message ?? null,
    }));
  });
}

/**
 * @param {{git?: string}} [options]
 * @returns {Promise<{
 *   ok:boolean, required:string, version:string|null, noLazyFetch:boolean,
 *   reason:string|null, platform:string
 * }>}
 */
export async function inspectGitRuntime({ git = 'git' } = {}) {
  const versionProbe = await runGit(['version'], { git });
  const version = versionProbe.ok ? versionProbe.stdout.trim() : null;
  if (!versionProbe.ok) {
    return {
      ok: false,
      required: GIT_RUNTIME_REQUIREMENT,
      version,
      noLazyFetch: false,
      reason: `could not execute Git: ${versionProbe.error ?? (versionProbe.stderr.trim() || 'unknown error')}`,
      platform: process.platform,
    };
  }
  if (!noLazyFetchSupported(version)) {
    return {
      ok: false,
      required: GIT_RUNTIME_REQUIREMENT,
      version,
      noLazyFetch: false,
      reason: `Holt requires Git ${GIT_RUNTIME_REQUIREMENT}; this executable cannot provide the required non-lazy object-read boundary`,
      platform: process.platform,
    };
  }

  // Do not infer a vendor build's capability from its version label alone. The option itself is
  // the contract, and the official git(1) documentation defines it as equivalent to
  // GIT_NO_LAZY_FETCH=1.
  const capability = await runGit(['--no-lazy-fetch', 'version'], { git });
  if (!capability.ok) {
    return {
      ok: false,
      required: GIT_RUNTIME_REQUIREMENT,
      version,
      noLazyFetch: false,
      reason: `Git reports a qualifying version but rejected --no-lazy-fetch: ${capability.stderr.trim() || capability.error || 'unknown error'}`,
      platform: process.platform,
    };
  }
  return {
    ok: true,
    required: GIT_RUNTIME_REQUIREMENT,
    version,
    noLazyFetch: true,
    reason: null,
    platform: process.platform,
  };
}

async function exists(file) {
  return fs.stat(file).then(() => true).catch(() => false);
}

/**
 * Live proof for the exact `core.hooksPath=/dev/null` spelling used by Holt. This is deliberately
 * a disposable repository and deliberately calls Git directly: it validates the platform Git
 * implementation beneath Holt rather than merely re-testing Holt's JavaScript configuration.
 *
 * @param {{git?: string}} [options]
 */
export async function verifyInertHooksPath({ git = 'git' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-git-hooks-runtime-'));
  const marker = path.join(root, '.holt-hook-ran');
  const mustRun = async (argv, label) => {
    const result = await runGit(argv, { cwd: root, git });
    if (!result.ok) {
      throw new Error(`${label} failed: ${result.stderr.trim() || result.error || `exit ${result.code}`}`);
    }
  };

  try {
    await mustRun(['init', '-q', '-b', 'main'], 'git init');
    await fs.writeFile(path.join(root, 'one.txt'), 'one\n');
    await mustRun(['add', '--', 'one.txt'], 'git add (positive control)');

    const hook = path.join(root, '.git', 'hooks', 'pre-commit');
    await fs.writeFile(hook, '#!/bin/sh\nprintf "ran\\n" > .holt-hook-ran\n', { mode: 0o755 });
    await fs.chmod(hook, 0o755);
    const identity = ['-c', 'user.name=Holt runtime check', '-c', 'user.email=runtime@holt.invalid'];
    await mustRun([...identity, 'commit', '-qm', 'positive control'], 'positive-control commit');
    if (!await exists(marker)) {
      throw new Error('positive-control hook did not run; refusing to treat hook suppression as proven');
    }

    await fs.unlink(marker);
    await fs.writeFile(path.join(root, 'two.txt'), 'two\n');
    await mustRun(['add', '--', 'two.txt'], 'git add (inert path)');
    await mustRun([
      '-c', `core.hooksPath=${INERT_GIT_HOOKS_PATH}`,
      ...identity,
      'commit', '-qm', 'inert hooks path',
    ], 'commit with inert hooks path');
    if (await exists(marker)) {
      throw new Error(`Git executed a repository hook despite core.hooksPath=${INERT_GIT_HOOKS_PATH}`);
    }

    return { ok: true, path: INERT_GIT_HOOKS_PATH, positiveControl: true };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function main() {
  const json = process.argv.includes('--json');
  const runtime = await inspectGitRuntime();
  let hooks = null;
  if (runtime.ok && process.argv.includes('--verify-inert-hooks')) {
    try {
      hooks = await verifyInertHooksPath();
    } catch (error) {
      hooks = { ok: false, path: INERT_GIT_HOOKS_PATH, reason: error?.message ?? String(error) };
    }
  }
  const result = { ok: runtime.ok && (!hooks || hooks.ok), git: runtime, inertHooks: hooks };
  if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else if (result.ok) {
    process.stdout.write(`Git runtime: ${runtime.version} satisfies ${runtime.required}; --no-lazy-fetch works`
      + `${hooks ? `; core.hooksPath=${hooks.path} is inert (positive control passed)` : ''}.\n`);
  } else {
    process.stderr.write(`Git runtime check failed: ${runtime.reason ?? hooks?.reason ?? 'unknown failure'}\n`);
  }
  process.exitCode = result.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`Git runtime check failed: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
