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
import { actorOf } from '../../src/journal.mjs';

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
