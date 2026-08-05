#!/usr/bin/env node
// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * Dependency-free GitHub Action entry point.
 *
 * GitHub downloads the caller-pinned action commit and executes dist/holt-action.mjs with its
 * embedded Node runtime. Inputs arrive as environment data; none is interpolated into a shell.
 * This entry point fixes the command to `holt ci`, validates the action-only input grammar, then
 * hands the ordinary CLI exactly the argv a local user would have supplied.
 */

import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalPath, underOrEqualAsync } from './paths.mjs';

function actionInput(name, fallback = '') {
  const canonical = `INPUT_${name.toUpperCase()}`;
  const underscored = canonical.replaceAll('-', '_');
  const value = process.env[canonical] ?? process.env[underscored];
  return value === undefined ? fallback : value;
}

function fail(message) {
  process.stderr.write(`holt action: ${message}\n`);
  process.exitCode = 2;
}

async function workspacePath(raw) {
  const workspace = await canonicalPath(process.env.GITHUB_WORKSPACE || process.cwd());
  const target = await canonicalPath(path.resolve(workspace, raw || '.'));
  if (!await underOrEqualAsync(target, workspace)) {
    throw new Error('working-directory must stay inside GITHUB_WORKSPACE');
  }
  return target;
}

async function main() {
  const args = ['ci', '--json'];

  const failOnUnlanded = actionInput('FAIL-ON-UNLANDED', 'true').trim().toLowerCase();
  if (failOnUnlanded !== 'true' && failOnUnlanded !== 'false') {
    throw new Error("fail-on-unlanded must be exactly 'true' or 'false'");
  }
  if (failOnUnlanded === 'true') args.push('--fail-on-unlanded');

  const maxAgeDays = actionInput('MAX-AGE-DAYS').trim();
  if (maxAgeDays) args.push('--max-age-days', maxAgeDays);

  const base = actionInput('BASE').trim();
  if (base) args.push('--base', base);

  const ignore = actionInput('IGNORE').split(',').map((value) => value.trim()).filter(Boolean);
  for (const branch of ignore) args.push('--ignore', branch);

  args.push('--cwd', await workspacePath(actionInput('WORKING-DIRECTORY', '.').trim()));
  process.argv = [process.execPath, fileURLToPath(import.meta.url), ...args];

  // Dynamic only so argv is final before bin/holt.mjs dispatches its top-level CLI main.
  await import('../bin/holt.mjs');
}

main().catch((error) => fail(error?.message ?? String(error)));
