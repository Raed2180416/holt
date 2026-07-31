// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * Which command destroys uncommitted work in this repository?
 *
 * Uncommitted edits to the live tree were lost twice during development, both times noticed
 * shortly after a test run. "Shortly after" is a correlation, and the first diagnosis acted on it
 * as though it were a cause: the mutation harness was isolated and given a tripwire, and the loss
 * happened again anyway. So this does not reason about which command is guilty — it plants a
 * canary, runs each suspect ALONE, and reads the survivor.
 *
 * The canary covers both loss shapes, because they are destroyed by different commands:
 *   - a modified TRACKED file      → destroyed by reset --hard, checkout -- ., restore
 *   - an added UNTRACKED file      → destroyed by clean -fd
 *
 *   node test/canary-rollback.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRACKED = path.join(ROOT, 'README.md');
const UNTRACKED = path.join(ROOT, '.canary-untracked');
const MARK = `<!-- canary ${process.pid} -->`;

const run = (cmd, args) => new Promise((res) => {
  const p = spawn(cmd, args, { cwd: ROOT, stdio: 'ignore', env: process.env });
  p.on('close', (code) => res(code));
  p.on('error', () => res(-1));
});

async function plant() {
  const base = await fs.readFile(TRACKED, 'utf8');
  await fs.writeFile(TRACKED, base + '\n' + MARK + '\n');
  await fs.writeFile(UNTRACKED, MARK + '\n');
  return base;
}

async function check() {
  const tracked = (await fs.readFile(TRACKED, 'utf8').catch(() => '')).includes(MARK);
  const untracked = await fs.readFile(UNTRACKED, 'utf8').then((s) => s.includes(MARK)).catch(() => false);
  return { tracked, untracked };
}

const SUSPECTS = [
  { name: 'npm test (full suite)', cmd: process.execPath, args: ['--test', '--test-concurrency=1', 'test/unit', 'test/e2e'] },
  { name: 'npm run test:mutation', cmd: process.execPath, args: ['test/mutation.mjs'] },
];

const results = [];
for (const s of SUSPECTS) {
  const base = await plant();
  process.stdout.write(`running ${s.name} ... `);
  const code = await run(s.cmd, s.args);
  const after = await check();
  const survived = after.tracked && after.untracked;
  results.push({ suspect: s.name, exit: code, ...after, survived });
  console.log(survived ? 'canary INTACT' : `CANARY DESTROYED (tracked=${after.tracked} untracked=${after.untracked})`);
  // Restore regardless, so a guilty suspect cannot poison the next measurement.
  await fs.writeFile(TRACKED, base);
  await fs.rm(UNTRACKED, { force: true });
}

console.log('\n' + JSON.stringify(results, null, 2));
const guilty = results.filter((r) => !r.survived);
console.log(guilty.length
  ? `\nGUILTY: ${guilty.map((g) => g.suspect).join(', ')}`
  : '\nNo suspect destroyed the canary. The cause is OUTSIDE these commands.');
process.exit(guilty.length ? 1 : 0);
