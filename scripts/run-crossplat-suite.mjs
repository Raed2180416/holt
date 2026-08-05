#!/usr/bin/env node
// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * Run the cross-platform suite with one explicit, owned exclusion.
 *
 * test/e2e/real-repos.test.mjs is an all-or-nothing 4/4 pinned network corpus. The dedicated
 * Linux `full` job clones those exact commits and owns that proof. Cloning and mutating four
 * upstream repositories independently on every OS would make the portable suite slower and more
 * network-fragile without changing the corpus denominator. This runner excludes exactly that one
 * file, prints the denominator, and refuses to run if either the suite or exclusion drifts.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_ROOT = path.join(ROOT, 'test');
const OWNED_BY_PINNED_LINUX_JOB = 'test/e2e/real-repos.test.mjs';

async function walk(dir, out = []) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(abs, out);
    else if (entry.isFile() && entry.name.endsWith('.test.mjs')) out.push(abs);
  }
  return out;
}

const all = (await walk(TEST_ROOT)).map((abs) => path.relative(ROOT, abs).split(path.sep).join('/')).sort();
if (all.length < 10) throw new Error(`cross-platform suite enumerated only ${all.length} test files`);
const exclusions = all.filter((file) => file === OWNED_BY_PINNED_LINUX_JOB);
if (exclusions.length !== 1) {
  throw new Error(`expected exactly one owned exclusion (${OWNED_BY_PINNED_LINUX_JOB}), found ${exclusions.length}`);
}
const selected = all.filter((file) => file !== OWNED_BY_PINNED_LINUX_JOB);
if (selected.length !== all.length - 1) throw new Error('cross-platform denominator is not N-1');

console.log(`cross-platform suite: ${selected.length}/${all.length} test files; excluded exactly `
  + `${OWNED_BY_PINNED_LINUX_JOB} (owned by the required pinned 4/4 Linux job)`);

if (process.argv.includes('--check')) process.exit(0);

const child = spawn(process.execPath, ['--test', ...selected], {
  cwd: ROOT,
  stdio: 'inherit',
  env: process.env,
});
child.once('error', (error) => { throw error; });
const [code, signal] = await new Promise((resolve) => child.once('exit', (...args) => resolve(args)));
if (signal) throw new Error(`cross-platform test runner terminated by ${signal}`);
process.exit(code ?? 1);
