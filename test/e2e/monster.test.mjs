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
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'eval', 'monster.mjs');

test('MONSTER: 40 worktrees of every trap at once — full loop, every byte graded', async () => {
  const work = path.join(os.tmpdir(), `holt-monster-ci-${process.pid}`);
  const r = await new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, '40'], {
      timeout: 600_000, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, HOLT_MONSTER_WORK: work },
    }, (err, stdout, stderr) => resolve({
      code: err ? (err.code ?? 1) : 0, out: `${stdout}\n${stderr}`,
    }));
  });

  assert.equal(r.code, 0, `monster round failed:\n${r.out.slice(-1500)}`);
  assert.match(r.out, /MONSTER SURVIVED/, 'the survival line must be printed, not implied');
  assert.match(r.out, /diagnostic verdicts: ALL CORRECT/);
});
