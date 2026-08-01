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
import { standardFixture, newRepo } from '../fixtures.mjs';

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


test('MAINTENANCE: accumulation is surfaced before it becomes a hand-cleanup task', async (t) => {
  // THE HALF NOBODY WAS TOLD ABOUT. holt already auto-PROTECTS at session start, so the dangerous
  // direction was covered without anyone asking. Nothing ever said the opposite thing: that the
  // repository is silting up. Disposable worktrees accumulate quietly, and the moment anyone
  // notices is usually the moment someone starts deleting by hand - which is the exact behaviour
  // that loses work and the reason this product exists.
  //
  // Deliberately a SIGNAL, not an automatic deletion. `clean --apply` is destructive, and a tool
  // that silently deletes on a threshold nobody set is the opposite of this product's promise.
  const { buildBrief, MAINTENANCE_FLOOR } = await import('../../src/agent.mjs');

  const fx = await newRepo('maintenance');
  t.after(() => fx.cleanup());

  // Enough empty worktrees to clear both the floor AND the ratio.
  for (let i = 0; i < MAINTENANCE_FLOOR + 2; i++) await fx.worktree('spent-' + i);

  const brief = await buildBrief(fx.root);
  assert.ok(brief, 'a repository this messy must produce a brief at all');
  assert.match(brief, /MAINTENANCE:/,
    `accumulation must be surfaced: ${brief}`);
  assert.match(brief, /holt clean --apply/,
    'the signal is worthless without the command that resolves it');
});

test('MAINTENANCE: a tidy repository is NOT nagged (never-worse)', async (t) => {
  // The half that keeps the signal worth reading. A maintenance banner on every session, in every
  // repository, is noise that trains people to ignore the line above it - which is the at-risk
  // line. The threshold is a ratio plus a floor for exactly this reason: ten disposable out of ten
  // is a repository that needs sweeping, ten out of two hundred is a busy Tuesday, and one empty
  // tree in a three-worktree repo is nothing at all.
  const { buildBrief } = await import('../../src/agent.mjs');

  const fx = await newRepo('maintenance-tidy');
  t.after(() => fx.cleanup());

  // Two worktrees, both holding real work: nothing is disposable, so nothing to sweep.
  for (const name of ['busy-a', 'busy-b']) {
    await fx.worktree(name);
    await fx.write('src/' + name + '.js',
      'export function ' + name.replace('-', '_') + '() { return 1; }\n', fx.wt(name));
  }

  const brief = await buildBrief(fx.root);
  assert.ok(!brief || !/MAINTENANCE:/.test(brief),
    `a repository with nothing disposable must not be nagged: ${brief}`);
});
