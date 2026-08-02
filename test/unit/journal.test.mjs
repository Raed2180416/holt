/**
 * WHO, in the audit trail.
 *
 * The rule under test is not "find an identity" — it is "never invent one". A fabricated actor
 * in an audit log is strictly worse than an admitted gap, because a reviewer cannot tell the two
 * apart, and the whole value of the record is that a reviewer can trust what it says.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { actorOf, appendEvent, readJournal } from '../../src/journal.mjs';

/** Real git. '/dev/null' NOT os.devNull — git-for-windows is MSYS and rejects '\\.\nul'. */
const gitIn = (args, cwd) => new Promise((resolve, reject) => {
  execFile('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'holt test', GIT_AUTHOR_EMAIL: 'test@holt.invalid',
      GIT_COMMITTER_NAME: 'holt test', GIT_COMMITTER_EMAIL: 'test@holt.invalid',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', LC_ALL: 'C',
    },
  }, (e, out, err) => (e ? reject(new Error(String(err || e.message))) : resolve(String(out))));
});

const KEYS = ['user', 'host', 'agent', 'session', 'source'];

test('actor: every field is always present and never empty', () => {
  for (const env of [{}, { USER: 'ci' }, { HOLT_ACTOR: 'deploy-bot' }]) {
    const a = actorOf({ env });
    for (const k of KEYS) {
      assert.equal(typeof a[k], 'string', `${k} must be a string`);
      assert.ok(a[k].length > 0, `${k} must never be empty`);
    }
  }
});

test('actor: an environment that declares no agent yields UNKNOWN, never a guess', () => {
  const a = actorOf({ env: {} });
  assert.equal(a.agent, 'unknown');
  assert.equal(a.session, 'unknown');
  assert.equal(a.source, 'unknown');
  // user/host are still measured — they come from the OS, not from a heuristic.
  assert.equal(a.host, os.hostname());
});

test('actor: an agent that publishes a session id is attributed WITHOUT holt knowing the host', () => {
  // The point of reading the variable NAME rather than consulting a list: a host holt has never
  // heard of is attributed with no code change. If this ever needs a new entry somewhere, the
  // rule has degenerated into an allowlist.
  const a = actorOf({ env: { NEVERHEARDOF_SESSION_ID: 'abc-123' } });
  assert.equal(a.agent, 'neverheardof');
  assert.equal(a.session, 'abc-123');
  assert.equal(a.source, 'NEVERHEARDOF_SESSION_ID');
  assert.equal(actorOf({ env: { SOME_TOOL_AGENT_ID: 'x1' } }).agent, 'some-tool');
});

test('actor: an OS login session is NOT an agent', () => {
  // XDG_SESSION_ID and friends follow the same naming convention and are systemd/desktop state.
  // Recording "agent: xdg" would be exactly the invented identity this module refuses.
  const a = actorOf({ env: { XDG_SESSION_ID: '3', DBUS_SESSION_BUS_ADDRESS: 'unix:x', DESKTOP_SESSION: 'wm' } });
  assert.equal(a.agent, 'unknown');
  assert.equal(a.source, 'unknown');
});

test('actor: attribution is deterministic when several identifiers are present', () => {
  const env = {
    CLAUDE_CODE_HOST_SESSION_ID: 'outer',
    CLAUDE_CODE_SESSION_ID: 'inner',
    AAA_SESSION_ID: 'zzz',
  };
  const first = actorOf({ env });
  const second = actorOf({ env: { ...env } });
  assert.deepEqual(first, second, 'the same environment must always produce the same actor');
  assert.equal(first.source, 'AAA_SESSION_ID', 'shortest (least-qualified) name wins, then lexicographic');
});

test('actor: HOLT_ACTOR overrides every heuristic, because CI knows its own identity', () => {
  const a = actorOf({ env: { HOLT_ACTOR: 'github-actions/run/42', SOME_SESSION_ID: 'ignored' } });
  assert.equal(a.agent, 'github-actions/run/42');
  assert.equal(a.source, 'HOLT_ACTOR');
});

test('actor: a hostile value cannot corrupt the JSONL record it is written into', () => {
  const a = actorOf({ env: { HOLT_ACTOR: `evil\n{"action":"forged"}`, USER: 'x' } });
  assert.ok(!a.agent.includes('\n'), 'a newline would forge a second journal line');
  const long = actorOf({ env: { EVIL_SESSION_ID: 'q'.repeat(5000) } });
  assert.ok(long.session.length < 300, 'an unbounded value must be clipped');
});

/* ------------------------- an empty answer is not a path prefix ---------------------- */
//
// `path.join('', 'holt', 'journal.jsonl')` is the RELATIVE path `holt/journal.jsonl`. When
// `rev-parse --git-common-dir` failed or returned nothing — outside a repository, a broken
// symlink, a git too old for the flag — holt appended its audit journal into whatever directory
// the process was standing in.
//
// FOUND IN THIS REPOSITORY: an untracked `holt/journal.jsonl` at the root of holt's own working
// tree, holding a real `blocked` event, written by an agent that had run holt somewhere git could
// not resolve. It shows in `git status` and invites being committed. Same defect this project
// keeps finding: a failed read used as a value instead of recognised as the absence of one.

test('JOURNAL: outside a git repository, nothing is written to the current directory', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-journal-nogit-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));
  const before = await fs.readdir(dir);
  assert.deepEqual(before, [], 'premise: the directory starts empty and is not a git repo');

  const r = await appendEvent(dir, { action: 'blocked', command: 'rm x' });
  assert.equal(r.ok, false, 'holt must report that it could not record, not pretend it did');

  const after = await fs.readdir(dir);
  assert.deepEqual(after, [],
    `holt must not create a journal in the working directory; found: ${after.join(', ')}`);
});

test('JOURNAL: inside a repository it still writes, and under the COMMON git dir', async (t) => {
  // NEVER-WORSE: the guard above must not have turned the journal off everywhere.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-journal-git-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));
  await gitIn(['init', '-q', '-b', 'main'], dir);

  const r = await appendEvent(dir, { action: 'protect', id: 'wt1' });
  assert.equal(r.ok, true, 'a real repository must still get a journal');

  const inTree = await fs.readdir(dir);
  assert.ok(!inTree.includes('holt'),
    'the journal belongs under the git common dir, never in the working tree');
  const events = await readJournal(dir);
  assert.equal(events.length, 1);
  assert.equal(events[0].action, 'protect');
});
