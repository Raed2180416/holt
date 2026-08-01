#!/usr/bin/env node
// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — the static-analysis ratchet.
 *
 * WHY A RATCHET AND NOT A PASS/FAIL GATE. This repository shipped 20,749 lines of JavaScript with
 * no linter, no type checker and no gate of any kind. Turning on `tsc --checkJs` produces 1,220
 * diagnostics on the first run. A gate that fails from the moment it is added is a gate somebody
 * deletes within a week, and then the codebase is back where it started with an extra dead file.
 *
 * So the rule is the only one that works on an existing codebase: THE COUNT MAY NEVER GO UP.
 * Every commit is free to leave the debt alone, and no commit may add to it. The number in
 * .typecheck-baseline is the current ceiling and it only ever moves down — this script rewrites it
 * when the count improves, so paying debt down is automatic and regressing is loud.
 *
 * This is deliberately NOT a "warnings" mode. A warning nobody must act on is a warning nobody
 * reads, and this project has a written history of exactly that failure — a CI check that could
 * pass vacuously forever is the thing its own published-numbers gate was built to replace.
 *
 * Exit 0 = at or below the ceiling. Exit 1 = the debt grew, with the new diagnostics printed.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = path.join(ROOT, '.typecheck-baseline');

const tsc = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');

function run() {
  return new Promise((resolve) => {
    execFile(tsc, ['--noEmit'], {
      cwd: ROOT,
      timeout: 600_000,
      maxBuffer: 64 * 1024 * 1024,
      shell: process.platform === 'win32',
    }, (err, stdout, stderr) => resolve(`${stdout ?? ''}${stderr ?? ''}`));
  });
}

const out = await run();

if (/Cannot find module|is not recognized|ENOENT/.test(out) && !/error TS/.test(out)) {
  // The checker is not installed. Say so and pass — a missing dev tool must not fail a build for
  // a contributor who has not run `npm install`, but silence would be indistinguishable from clean.
  console.log('typecheck: typescript is not installed here — run `npm install` to enable it.');
  console.log('           (this is a devDependency; it is never shipped and never runs at runtime)');
  process.exit(0);
}

const lines = out.split('\n').filter((l) => /error TS\d+/.test(l));
const count = lines.length;

let ceiling = Number.POSITIVE_INFINITY;
try {
  ceiling = Number((await fs.readFile(BASELINE, 'utf8')).trim());
} catch { /* first run */ }

if (!Number.isFinite(ceiling)) {
  await fs.writeFile(BASELINE, `${count}\n`);
  console.log(`typecheck: baseline established at ${count} diagnostic(s).`);
  console.log('           From here the count may go DOWN but never UP.');
  process.exit(0);
}

if (count > ceiling) {
  console.error(`typecheck: FAILED — ${count} diagnostics, ceiling is ${ceiling}.`);
  console.error(`           This change added ${count - ceiling}. The debt may be left alone; it may not grow.`);
  console.error('');
  for (const l of lines.slice(0, 40)) console.error(`  ${l}`);
  if (lines.length > 40) console.error(`  … and ${lines.length - 40} more`);
  process.exit(1);
}

if (count < ceiling) {
  await fs.writeFile(BASELINE, `${count}\n`);
  console.log(`typecheck: ${count} diagnostics — down from ${ceiling}. Ceiling lowered.`);
  process.exit(0);
}

console.log(`typecheck: ${count} diagnostics, at the ceiling. No regression.`);
