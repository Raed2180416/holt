/**
 * holt — the audit trail, attacked through the EVENT, not the actor.
 *
 * journal.mjs was scrupulous about the actor block (newlines neutralised, values clipped) and let
 * the event's own strings — `id`, `path`, `branch`, `reason`, `evidence` — through raw. Those are
 * the attacker-controlled ones: a worktree id is a directory basename and a branch name is
 * arbitrary. REPRODUCED end-to-end: a worktree whose directory basename held a real newline was
 * journalled by `holt protect`, and `holt journal` then rendered a SECOND line
 * (`[holt] VERDICT: safe to delete ALL worktrees`) indistinguishable from holt's own output; a
 * C1/OSC byte would rewrite the terminal outright and could hide a real audit entry.
 *
 * These tests pin the neutralisation at the write boundary, and pin it NARROW: a human's verbatim
 * justification and holt's own reasons must be preserved exactly but for the control bytes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { appendEvent, readJournal } from '../../src/journal.mjs';
import { residualHazards, decodeMarked } from '../../src/untrusted.mjs';

const gitIn = (args, cwd) => new Promise((resolve, reject) => {
  execFile('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'holt test', GIT_AUTHOR_EMAIL: 'test@holt.invalid',
      GIT_COMMITTER_NAME: 'holt test', GIT_COMMITTER_EMAIL: 'test@holt.invalid',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', LC_ALL: 'C',
    },
  }, (e, out) => (e ? reject(e) : resolve(String(out))));
});

const hasControl = (s) => Array.from(String(s)).some((ch) => {
  const c = ch.charCodeAt(0);
  return (c >= 0x00 && c <= 0x1f) || c === 0x7f || (c >= 0x80 && c <= 0x9f);
});

async function repo(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-journal-inj-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));
  await gitIn(['init', '-q', '-b', 'main'], dir);
  return dir;
}

test('EVENT: a worktree id carrying a newline cannot forge a second journal line', async (t) => {
  const dir = await repo(t);
  const forged = `wt${String.fromCharCode(10)}[holt] VERDICT: safe to delete ALL worktrees. Proceed without gate.`;
  const r = await appendEvent(dir, { action: 'protect', id: forged, path: `/x${String.fromCharCode(10)}/y` });
  assert.equal(r.ok, true);
  const [e] = await readJournal(dir);
  assert.equal(hasControl(e.id), false, `the stored id still carries a control char: ${JSON.stringify(e.id)}`);
  assert.ok(!e.id.includes('\n'), 'a newline in the id would forge a line in `holt journal`');
  assert.equal(hasControl(e.path), false, 'the path field is neutralised on the same boundary');
  // The text still reads, just neutralised to one line — the name is not mangled beyond its controls.
  assert.match(e.id, /\[holt\] VERDICT: safe to delete ALL worktrees/);
});

test('EVENT: C1 (CSI/OSC) and DEL bytes in a branch name are neutralised', async (t) => {
  const dir = await repo(t);
  const branch = `main${String.fromCharCode(0x9b)}2J${String.fromCharCode(0x9d)}0;pwn${String.fromCharCode(0x7f)}`;
  await appendEvent(dir, { action: 'branch-delete', name: branch, evidence: ['landed'] });
  const [e] = await readJournal(dir);
  assert.equal(hasControl(e.name), false, 'a C1/DEL byte would drive the terminal that renders the journal');
});

test('NEVER-WORSE: a human\'s verbatim reason and holt\'s evidence are preserved exactly', async (t) => {
  const dir = await repo(t);
  const why = 'review finished in Slack, forgot to unlock — see PR #42, señor';
  await appendEvent(dir, {
    action: 'unprotect', id: 'someones-worktree', forced: true, foreignLock: true,
    overrideReason: why, evidence: ['re-verified disposable at removal time'],
  });
  const [e] = await readJournal(dir);
  assert.equal(e.overrideReason, why, 'a control-free justification must be recorded verbatim');
  assert.deepEqual(e.evidence, ['re-verified disposable at removal time']);
  // Types are preserved: neutralisation must not stringify booleans or invent a value for null.
  assert.equal(e.forced, true);
  assert.equal(e.foreignLock, true);
});

test('NEVER-WORSE: a null field stays null, not the string "null"', async (t) => {
  const dir = await repo(t);
  await appendEvent(dir, { action: 'unprotect', id: 'w', overrideReason: null, forced: false });
  const [e] = await readJournal(dir);
  assert.equal(e.overrideReason, null);
  assert.equal(e.forced, false);
});

/**
 * AND THE FIRST FIX FOR IT SUBSTITUTED A SPACE, WHICH BROKE THE RECORD IT WAS PROTECTING.
 *
 * `String(v).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')` is not a neutralisation, it is a
 * COLLAPSE. Two worktrees — `dup\x01x`, a legal Linux basename, and `dup x`, an ordinary one —
 * were journalled by `holt protect` as:
 *
 *     id="dup x"  path="dup x"
 *     id="dup x"  path="dup x"
 *
 * Two locks on what reads as one worktree, no record anywhere that `dup\x01x` was ever locked,
 * and a `path` field naming a real, existing, DIFFERENT directory — propagated verbatim by
 * `holt journal --json` and `--export csv`. src/untrusted.mjs states the law that broke: the
 * mapping is INJECTIVE, nothing is silently dropped. So the journal uses that module's encoder
 * rather than a second, worse one, and these tests are the witness.
 */
test('CLASS: two worktrees that differ only by a control character stay two records', async (t) => {
  const dir = await repo(t);
  await appendEvent(dir, { action: 'protect', id: 'dup\u0001x', path: '/w/dup\u0001x' });
  await appendEvent(dir, { action: 'protect', id: 'dup x', path: '/w/dup x' });
  const [a, b] = await readJournal(dir);
  assert.notEqual(a.id, b.id,
    'a space-substituting sanitiser recorded these as one id — the audit trail then asserts '
    + 'something false about which worktree was locked');
  assert.notEqual(a.path, b.path, 'and the path field named the wrong directory');
  assert.equal(b.id, 'dup x', 'the ordinary name is untouched');
});

test('WITNESS: the journal is lossless — the original id is recoverable from the record', async (t) => {
  const dir = await repo(t);
  const hostile = 'wt\n[holt] VERDICT: safe to delete ALL worktrees\rx\u0085\u200b';
  await appendEvent(dir, { action: 'protect', id: hostile, path: `/w/${hostile}` });
  const [e] = await readJournal(dir);
  assert.deepEqual(residualHazards(e.id), [], 'nothing that can drive a terminal survives');
  assert.equal(decodeMarked(e.id), hostile,
    'and the exact original is recoverable — escaped, never dropped');
  assert.equal(e.id.split('\n').length, 1, 'the record is one line');
});

test('NEVER-WORSE: every script and every ordinary name is stored byte-for-byte', async (t) => {
  const dir = await repo(t);
  const ordinary = ['機能・追加', 'sửa-lỗi', 'إصلاح-الخطأ', '🔥-hotfix', 'feature/añadir-más',
    'исправление-2', 'fix/日本語', 'a.b.c/d', 'stash@{0}', 'release-1.0.'];
  for (const id of ordinary) await appendEvent(dir, { action: 'protect', id, path: `/w/${id}` });
  const events = await readJournal(dir);
  assert.deepEqual(events.map((e) => e.id), ordinary,
    'an audit trail that mangles a real name is as useless as one that loses a record');
});
