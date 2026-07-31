/**
 * Zero-touch protection: `holt integrate` wires session-start hooks with --autoprotect, so a
 * repository where nobody ever runs the CLI still gets its at-risk worktrees locked the moment
 * any integrated agent session begins. This is the set-and-forget contract, so it is pinned
 * against the real binary and the real hook path, and the lock is verified via git itself.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { standardFixture } from '../fixtures.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'holt.mjs');

function sh(cmd, args, cwd) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, {
      cwd, timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', LC_ALL: 'C' },
    }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? -1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }));
    child.stdin?.end();
  });
}

test('AUTOPROTECT: session-start with --autoprotect locks at-risk worktrees before the agent moves', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const before = await sh('git', ['worktree', 'list', '--porcelain'], fx.root);
  assert.ok(!before.stdout.includes('locked'), 'fixture must start unlocked');

  const r = await sh(process.execPath, [BIN, 'hook', 'session-start', '--autoprotect', '--host', 'claude-code', '--cwd', fx.root], fx.root);
  assert.equal(r.code, 0, `hook must exit 0: ${r.stderr}`);
  assert.match(r.stdout, /auto-protect: locked \d+ workstream/, 'the brief must state what was locked');

  const after = await sh('git', ['worktree', 'list', '--porcelain'], fx.root);
  assert.ok(after.stdout.includes('locked'), 'at-risk worktrees must now carry git locks');

  // And the lock must actually refuse a forced removal — the whole point.
  const wt = after.stdout.split('\n\n').find((b) => b.includes('locked'));
  const wtPath = wt.split('\n')[0].replace('worktree ', '');
  const rm = await sh('git', ['worktree', 'remove', '--force', wtPath], fx.root);
  assert.notEqual(rm.code, 0, 'git must refuse to remove the locked worktree');
  assert.match(rm.stderr, /locked/i);
});

test('AUTOPROTECT: without the flag, session-start locks nothing (opt-in stays explicit)', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const r = await sh(process.execPath, [BIN, 'hook', 'session-start', '--host', 'claude-code', '--cwd', fx.root], fx.root);
  assert.equal(r.code, 0);
  const after = await sh('git', ['worktree', 'list', '--porcelain'], fx.root);
  assert.ok(!after.stdout.includes('locked'), 'no flag, no mutation — the read-only default holds');
});
