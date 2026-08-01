/**
 * The identity layer, and its one law: NEVER INVENT IDENTITY.
 *
 * Most of these tests are about what holt must REFUSE to claim. That asymmetry is deliberate —
 * a forensics feature that fills a blank with a plausible name is worse than one that leaves it
 * blank, because the plausible name is the one that gets believed in an incident review.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveActor, actorLabel, actorKey, parseAiAgent, UNKNOWN,
  setAmbientActor, currentActor, __resetAmbientActor,
} from '../../src/actor.mjs';

/** An environment with nothing in it. `{}` and not process.env — the point is total absence. */
const BARE = {};

test('actor: with no evidence at all, everything is unknown and nothing is fabricated', () => {
  const a = resolveActor({ payload: null, env: BARE, host: null });
  assert.equal(a.agent, UNKNOWN);
  assert.equal(a.session, null, 'a session must never be generated');
  assert.equal(a.invocation, null);
  assert.equal(a.confidence, 'unknown');
  assert.deepEqual(a.evidence, [], 'no evidence must be cited when there is none');
});

test('actor: NEVER falls back to the human — not $USER, not the hostname, not git identity', () => {
  // This is the exact temptation: the environment is FULL of plausible names, and every one of
  // them identifies the person who opened the terminal rather than the agent that ran the
  // command. In a fleet where five agents share one login they are all the same string.
  const env = {
    USER: 'raed', USERNAME: 'raed', LOGNAME: 'raed', HOSTNAME: 'workstation',
    HOME: '/home/raed', SHELL: '/bin/zsh', GIT_AUTHOR_NAME: 'Raed', GIT_AUTHOR_EMAIL: 'r@x.dev',
    EMAIL: 'r@x.dev', SUDO_USER: 'raed',
  };
  const a = resolveActor({ env, host: null });
  assert.equal(a.agent, UNKNOWN, `a human identity leaked into the agent field: ${JSON.stringify(a)}`);
  assert.equal(a.session, null);
  assert.equal(a.confidence, 'unknown');
  const blob = JSON.stringify(a);
  for (const leak of ['raed', 'workstation', 'r@x.dev', 'Raed']) {
    assert.ok(!blob.includes(leak), `'${leak}' leaked into the actor record: ${blob}`);
  }
});

test('actor: a Claude Code hook payload yields a REPORTED session, cited', () => {
  // The field names are the ones the shipping claude binary actually emits; see src/actor.mjs.
  const a = resolveActor({
    payload: {
      session_id: 'e5f6a7b8-1111-2222-3333-444455556666',
      transcript_path: '/home/x/.claude/t.jsonl',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_use_id: 'toolu_01ABC',
      cwd: '/repo',
    },
    env: { CLAUDECODE: '1' },
    host: 'claude-code',
  });
  assert.equal(a.agent, 'claude-code');
  assert.equal(a.session, 'e5f6a7b8-1111-2222-3333-444455556666');
  assert.equal(a.invocation, 'toolu_01ABC');
  assert.equal(a.confidence, 'reported', 'a session the host itself sent is the strongest evidence there is');
  assert.ok(a.evidence.includes('payload.session_id'));
});

test('actor: an OpenCode plugin argument yields a reported session too (sessionID / callID)', () => {
  // Verified in the opencode binary: trigger("tool.execute.before", {tool, sessionID, callID}).
  const a = resolveActor({ payload: { sessionID: 'ses_7Kq', callID: 'call_99' }, env: BARE, host: 'opencode' });
  assert.equal(a.agent, 'opencode');
  assert.equal(a.session, 'ses_7Kq');
  assert.equal(a.invocation, 'call_99');
  assert.equal(a.confidence, 'reported');
});

test('actor: an empty-string session is NOT identity', () => {
  // Hosts pass "" for fields they have not populated. An empty session renders in a timeline
  // exactly like a real one and correlates everything to everything.
  for (const empty of ['', '   ', null, undefined, 0, false]) {
    const a = resolveActor({ payload: { session_id: empty, sessionID: empty }, env: BARE });
    assert.equal(a.session, null, `${JSON.stringify(empty)} was accepted as a session`);
    assert.equal(a.confidence, 'unknown');
  }
});

test('actor: environment-only evidence is INFERRED, never reported', () => {
  // AI_AGENT is real and observed live: `claude-code_2-1-219_agent`.
  const a = resolveActor({ env: { AI_AGENT: 'claude-code_2-1-219_agent' }, host: null });
  assert.equal(a.agent, 'claude-code');
  assert.equal(a.agentVersion, '2.1.219');
  assert.equal(a.session, null, 'AI_AGENT names the agent, not the session');
  assert.equal(a.confidence, 'inferred',
    'naming the agent from the environment must never be reported as a per-session fact');
});

test('actor: AI_AGENT in an unexpected shape keeps the raw name and refuses to guess a version', () => {
  assert.deepEqual(parseAiAgent('some-tool'), { name: 'some-tool', version: null });
  assert.deepEqual(parseAiAgent(''), null);
  assert.deepEqual(parseAiAgent(undefined), null);
  const ok = parseAiAgent('opencode_1-18-3_agent');
  assert.deepEqual(ok, { name: 'opencode', version: '1.18.3' });
});

test('actor: the --host flag names the agent but can never manufacture a session', () => {
  // --host is a string written into a config file by `holt integrate` months ago. It is the
  // weakest evidence holt has and it must rank below everything live.
  const a = resolveActor({ env: BARE, host: 'cursor' });
  assert.equal(a.agent, 'cursor');
  assert.equal(a.session, null);
  assert.equal(a.confidence, 'inferred');

  // A host id holt does not know is not accepted on faith.
  assert.equal(resolveActor({ env: BARE, host: 'totally-made-up' }).agent, UNKNOWN);
  assert.equal(resolveActor({ env: BARE, host: 'generic' }).agent, UNKNOWN,
    "'generic' is the absence of a host, not a host");
});

test('actor: the host payload OUTRANKS the environment', () => {
  const a = resolveActor({
    payload: { session_id: 'from-the-host' },
    env: { CLAUDE_CODE_HOST_SESSION_ID: 'from-the-env' },
  });
  assert.equal(a.session, 'from-the-host');
  assert.equal(a.confidence, 'reported');
});

test('actor: a NESTED agent is attributed to the caller, not to the shell it was launched from', () => {
  // MEASURED, and it is the whole reason the precedence rule exists: an OpenCode plugin running
  // inside a Claude Code session forwards opencode's own sessionID, while `AI_AGENT` — inherited
  // by every child process — still says claude-code. Consulting the environment first produced
  // `claude-code` holding an OpenCode session id: specific, confident and wrong.
  const a = resolveActor({
    payload: { sessionID: 'ses_opencode_1', callID: 'call_1' },
    env: { AI_AGENT: 'claude-code_2-1-219_agent', CLAUDECODE: '1', CLAUDE_CODE_HOST_SESSION_ID: 'outer' },
    host: 'opencode',
  });
  assert.equal(a.agent, 'opencode', 'the channel that carried the session names the agent');
  assert.equal(a.session, 'ses_opencode_1', 'and it is opencode\'s session, not the outer one');
  assert.equal(a.confidence, 'reported');

  // With NO reported session there is no caller to prefer, so the ambient evidence stands and is
  // labelled as the weaker thing it is.
  const ambient = resolveActor({ env: { AI_AGENT: 'claude-code_2-1-219_agent' }, host: 'opencode' });
  assert.equal(ambient.agent, 'claude-code');
  assert.equal(ambient.confidence, 'inferred');
});

test('actor: an MCP client names itself, and that is recorded as self-reported inference', () => {
  const a = resolveActor({ mcpClient: { name: 'Cursor', version: '2.1.0' }, env: BARE, via: 'mcp' });
  assert.equal(a.agent, 'cursor');
  assert.equal(a.agentVersion, '2.1.0');
  assert.equal(a.session, null, 'MCP stdio carries no session id — recording one would be inventing it');
  assert.equal(a.confidence, 'inferred');
  assert.equal(a.via, 'mcp');
});

test('actorKey: an actor with no session correlates to NOTHING', () => {
  // The whole cross-repo join runs on this. If unattributed events collapsed to one key, the
  // fleet view would report "one agent session did all of this" — a fabricated incident.
  assert.equal(actorKey(resolveActor({ env: BARE })), null);
  assert.equal(actorKey(resolveActor({ env: { AI_AGENT: 'claude-code_2-1-219_agent' } })), null,
    'knowing the agent is not knowing the session');
  assert.equal(actorKey({ agent: 'claude-code', session: 'abc' }), 'claude-code:abc');
  assert.equal(actorKey(null), null);
});

test('actorLabel: an unknown actor never renders as something that looks like an id', () => {
  assert.equal(actorLabel(resolveActor({ env: BARE })), UNKNOWN);
  assert.match(actorLabel({ agent: 'claude-code', session: null }), /unknown-session/);
  assert.equal(actorLabel({ agent: 'claude-code', session: 'abcdefghijklmnop' }), 'claude-code/abcdefghijkl');
});

test('actor: the ambient actor is explicit and resettable, never sticky across callers', () => {
  __resetAmbientActor();
  const set = setAmbientActor({ agent: 'opencode', session: 'x1', confidence: 'reported' });
  assert.equal(currentActor(), set);
  __resetAmbientActor();
  const lazy = currentActor();
  assert.equal(typeof lazy.agent, 'string', 'a reset must resolve fresh rather than throw');
  __resetAmbientActor();
});
