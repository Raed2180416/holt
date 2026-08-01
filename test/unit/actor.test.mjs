/**
 * holt — actor attribution, attacked.
 *
 * The governing rule is asymmetric and the tests are written to that asymmetry: a MISSING
 * identity is acceptable, a WRONG one is not. A blank in an audit trail is visibly a blank; a
 * plausible-looking name that nobody actually verified gets believed, and believing it is how a
 * reviewer signs off on an action the named person never took.
 *
 * So the hard test here is not "does it find Claude Code" — it is "given an environment with
 * NOTHING identifying in it, does it invent anything". It must not.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { resolveActor, formatActor, UNKNOWN, AGENT_SIGNALS, SESSION_SIGNALS } from '../../src/actor.mjs';

/** A deliberately hostile environment: plenty of variables, none of them an identity. */
const BLIND = {
  PATH: '/usr/bin', HOME: '/home/x', TERM: 'xterm', LANG: 'C', PWD: '/tmp',
  EDITOR: 'vim', SHELL: '/bin/zsh', TMPDIR: '/tmp',
};

test('an environment with no identity in it yields unknown for agent and session — never a guess', () => {
  const a = resolveActor({ env: BLIND });
  assert.equal(a.agent, UNKNOWN, `an agent was invented from nothing: ${a.agent}`);
  assert.equal(a.session, UNKNOWN, `a session id was invented from nothing: ${a.session}`);
  // user/host DO have a knowing source (the OS), so they are allowed to be populated — but only
  // from the OS, and the value must be what the OS actually said.
  assert.equal(a.user, os.userInfo().username);
  assert.equal(a.host, os.hostname());
  assert.equal(a.source.user, 'os.userInfo');
  assert.equal(a.source.host, 'os.hostname');
});

test('nothing in the environment is treated as a NAME unless it is a declared identity source', () => {
  // The failure this pins: reaching for HOME, PWD, SHELL, LOGNAME-lookalikes or a hostname that
  // "looks like" someone's laptop and calling the result an identity.
  const a = resolveActor({
    env: { ...BLIND, HOME: '/home/alice', PWD: '/home/alice/work', SUDO_USER: 'bob', MAIL: '/var/mail/carol' },
  });
  assert.notEqual(a.agent, 'alice');
  assert.notEqual(a.user, 'bob', 'SUDO_USER was treated as the actor');
  assert.notEqual(a.user, 'carol');
  assert.equal(a.agent, UNKNOWN);
});

test('every declared agent signal is detected, and detection names the variable it fired on', () => {
  // PROVE THE INSTRUMENT CAN DETECT PRESENCE BEFORE TRUSTING ITS SILENCE: the test above asserts
  // absence, so this one must prove the detector is not simply blind.
  for (const [name, vars] of AGENT_SIGNALS) {
    for (const v of vars) {
      const a = resolveActor({ env: { ...BLIND, [v]: '1' } });
      assert.equal(a.agent, name, `${v} did not resolve to '${name}'`);
      assert.equal(a.source.agent, v);
    }
  }
});

test('a bare CI=true says "a machine", not "which machine" — and is distinct from a named agent', () => {
  const a = resolveActor({ env: { ...BLIND, CI: 'true' } });
  assert.equal(a.agent, 'ci');
  assert.equal(a.source.agent, 'CI');
  // A named agent must WIN over the generic CI marker, which is the more specific truth.
  const b = resolveActor({ env: { ...BLIND, CI: 'true', GITHUB_ACTIONS: 'true' } });
  assert.equal(b.agent, 'github-actions');
});

test('the explicit override wins over every sniff, in all four fields', () => {
  const a = resolveActor({
    env: {
      ...BLIND, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'sniffed',
      HOLT_ACTOR_USER: 'svc-audit', HOLT_ACTOR_HOST: 'build-07',
      HOLT_ACTOR_AGENT: 'internal-runner', HOLT_ACTOR_SESSION: 'run-42',
    },
  });
  assert.deepEqual(
    { user: a.user, host: a.host, agent: a.agent, session: a.session },
    { user: 'svc-audit', host: 'build-07', agent: 'internal-runner', session: 'run-42' });
  assert.equal(a.source.agent, 'HOLT_ACTOR_AGENT');
});

test('a host-supplied hook payload outranks every environment sniff for the session id', () => {
  // The host knows its own session id. An environment variable is a guess about it.
  const a = resolveActor({
    env: { ...BLIND, CLAUDE_CODE_SESSION_ID: 'from-env', GITHUB_RUN_ID: '999' },
    payload: { session_id: 'from-the-host' },
  });
  assert.equal(a.session, 'from-the-host');
  assert.equal(a.source.session, 'hook-payload');
  // camelCase and nested shapes are accepted, because hosts disagree about spelling.
  assert.equal(resolveActor({ env: BLIND, payload: { sessionId: 'x' } }).session, 'x');
  assert.equal(resolveActor({ env: BLIND, payload: { session: { id: 'y' } } }).session, 'y');
  // A payload with no session must NOT poison the result into something wrong.
  assert.equal(resolveActor({ env: BLIND, payload: { tool_name: 'Bash' } }).session, UNKNOWN);
});

test('every declared session signal is read, in the declared precedence order', () => {
  for (const v of SESSION_SIGNALS) {
    assert.equal(resolveActor({ env: { ...BLIND, [v]: 'sess-value' } }).session, 'sess-value', `${v} was ignored`);
  }
  // Precedence: the first declared signal must win over a later one.
  const a = resolveActor({ env: { ...BLIND, [SESSION_SIGNALS[0]]: 'first', [SESSION_SIGNALS[3]]: 'later' } });
  assert.equal(a.session, 'first');
});

test('ATTACK: log injection — a newline in an identity cannot forge a second record', () => {
  // Actor fields are printed in a terminal and shipped to a SIEM as line-oriented records. A
  // newline here would create a second, attacker-authored audit line out of thin air.
  const a = resolveActor({
    env: {
      ...BLIND,
      HOLT_ACTOR_USER: 'alice\nCEF:0|x|y|z|forged|forged|10|',
      HOLT_ACTOR_AGENT: 'agent\r\ninjected',
      HOLT_ACTOR_SESSION: 'sess\x00nul',
    },
  });
  for (const [field, v] of Object.entries({ user: a.user, agent: a.agent, session: a.session })) {
    assert.ok(!/[\r\n\x00]/.test(v), `${field} carried a control character into the record: ${JSON.stringify(v)}`);
  }
  assert.equal(formatActor(a).split('\n').length, 1, 'the rendered actor spans more than one line');
});

test('an over-long identity is bounded rather than allowed to bloat every record', () => {
  const a = resolveActor({ env: { ...BLIND, HOLT_ACTOR_USER: 'x'.repeat(10_000) } });
  assert.ok(a.user.length <= 200, `user field is ${a.user.length} characters`);
});

test('an empty or whitespace-only value is unknown, not an empty name', () => {
  const a = resolveActor({ env: { ...BLIND, HOLT_ACTOR_AGENT: '   ', HOLT_ACTOR_SESSION: '' } });
  assert.equal(a.agent, UNKNOWN);
  assert.equal(a.session, UNKNOWN);
});

test('formatActor renders unknowns visibly rather than hiding them', () => {
  const s = formatActor({ user: UNKNOWN, host: UNKNOWN, agent: UNKNOWN, session: UNKNOWN });
  assert.equal(s, 'unknown@unknown');
  // The session is truncated to 12 characters for display only — the full value stays in the
  // record, because an audit trail that shortens an identifier is an audit trail that cannot
  // be joined against the host's own logs.
  assert.equal(formatActor({ user: 'a', host: 'b', agent: 'claude-code', session: 'sess-1234567890abc' }),
    'a@b via claude-code (sess sess-1234567)');
});
