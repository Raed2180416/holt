// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — WHO did it.
 *
 * The journal recorded what and when and never who, which for a compliance reviewer is the
 * difference between an audit trail and a changelog. This resolves an actor from the process
 * environment, and its governing rule is the one that makes the field admissible:
 *
 *   **RECORD 'unknown' WHEN IT IS GENUINELY UNKNOWN. NEVER GUESS AN IDENTITY.**
 *
 * A wrong name in an audit trail is worse than a missing one, because the missing one is
 * visibly missing while the wrong one gets believed. So every field here is either read from a
 * source that actually knows (the OS, an explicit override, a host-supplied hook payload) or is
 * the literal string 'unknown'. There is no inference, no "probably", no derivation from a
 * hostname that looks like a person's laptop.
 *
 * ATTRIBUTION IS NOT AUTHENTICATION, and this is stated rather than implied: every value below
 * is set by the process doing the writing, so a determined actor can set them to anything. What
 * this defends against is the ordinary case — four agents and two humans in ten worktrees, and
 * nobody able to say afterwards which one removed the protection. Cryptographic identity would
 * need a key the writer does not hold; see src/team/audit-sink.mjs for where that belongs.
 */

import os from 'node:os';

export const UNKNOWN = 'unknown';

/**
 * Agent/host signals, verified by measurement rather than recall — the two Claude Code entries
 * below were confirmed live in a running session, not remembered from documentation.
 *
 * A WRONG OR STALE VAR NAME HERE FAILS SAFE: the sniff simply does not fire and the field
 * records 'unknown'. It can never attribute an action to the wrong agent. That asymmetry is why
 * this list is allowed to be best-effort at all, and why HOLT_ACTOR_AGENT exists as the exact,
 * always-correct path for anyone who needs certainty (CI, a wrapper script, an unlisted host).
 */
export const AGENT_SIGNALS = [
  ['claude-code', ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID']],
  ['cursor', ['CURSOR_TRACE_ID', 'CURSOR_AGENT']],
  ['opencode', ['OPENCODE_SESSION_ID', 'OPENCODE']],
  ['crush', ['CRUSH_SESSION_ID', 'CRUSH']],
  ['aider', ['AIDER_CHAT_HISTORY_FILE', 'AIDER_MODEL']],
  ['codex', ['CODEX_SANDBOX', 'CODEX_HOME']],
  ['gemini-cli', ['GEMINI_CLI', 'GEMINI_SESSION_ID']],
  ['github-copilot', ['COPILOT_AGENT_ID', 'GITHUB_COPILOT_AGENT']],
  ['github-actions', ['GITHUB_ACTIONS']],
  ['gitlab-ci', ['GITLAB_CI']],
  ['buildkite', ['BUILDKITE']],
  ['circleci', ['CIRCLECI']],
  ['jenkins', ['JENKINS_URL']],
];

/** Session identifiers, most specific first. Same fail-safe rule: unmatched means 'unknown'. */
export const SESSION_SIGNALS = [
  'HOLT_ACTOR_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'OPENCODE_SESSION_ID',
  'CRUSH_SESSION_ID',
  'GEMINI_SESSION_ID',
  'CURSOR_TRACE_ID',
  'GITHUB_RUN_ID',
  'CI_PIPELINE_ID',
  'BUILDKITE_BUILD_ID',
  'CIRCLE_WORKFLOW_ID',
  'BUILD_TAG',
];

const clean = (v) => {
  if (typeof v !== 'string') return null;
  // One line, bounded. An actor field is printed in a terminal and shipped to a SIEM as a
  // line-oriented record; a control character in it would forge a SECOND audit record — log
  // injection by any other name. Written as a code-point test rather than a regex range on
  // purpose: the range spelled literally puts a NUL byte in this file, and grep silently skips
  // files containing a NUL, so every later search through this module would read as "absent".
  let out = ""; // eslint-disable-line quotes
  for (const ch of v) {
    const c = ch.codePointAt(0);
    out += (c < 0x20 || c === 0x7f) ? ' ' : ch;
  }
  const s = out.trim().slice(0, 200);
  return s || null;
};

/**
 * Resolve the actor.
 *
 * @param {object}  opts
 * @param {object}  opts.env      environment to read (injectable: the tests must not depend on
 *                                the machine they run on, and neither must a fleet report)
 * @param {object}  opts.payload  a host-supplied hook event, when there is one. This is the ONLY
 *                                source of a session id that the agent host itself vouches for,
 *                                so it outranks every environment sniff.
 * @returns {{user:string, host:string, agent:string, session:string, source:object}}
 */
export function resolveActor({ env = process.env, payload = null } = {}) {
  const source = {};

  // ---- user -------------------------------------------------------------------------------
  // The OS is the one component here that actually knows. os.userInfo() throws on a system with
  // no passwd entry for the uid (some containers), which is exactly a case where the honest
  // answer is 'unknown' rather than a fallback that looks like a name.
  let user = clean(env.HOLT_ACTOR_USER);
  if (user) source.user = 'HOLT_ACTOR_USER';
  if (!user) {
    try {
      user = clean(os.userInfo().username);
      if (user) source.user = 'os.userInfo';
    } catch { /* no passwd entry — genuinely unknown */ }
  }
  if (!user) {
    for (const k of ['USER', 'USERNAME', 'LOGNAME']) {
      user = clean(env[k]);
      if (user) { source.user = k; break; }
    }
  }

  // ---- host -------------------------------------------------------------------------------
  let host = clean(env.HOLT_ACTOR_HOST);
  if (host) source.host = 'HOLT_ACTOR_HOST';
  if (!host) {
    try {
      host = clean(os.hostname());
      if (host) source.host = 'os.hostname';
    } catch { /* genuinely unknown */ }
  }

  // ---- agent ------------------------------------------------------------------------------
  let agent = clean(env.HOLT_ACTOR_AGENT);
  if (agent) source.agent = 'HOLT_ACTOR_AGENT';
  if (!agent) {
    for (const [name, vars] of AGENT_SIGNALS) {
      const hit = vars.find((v) => clean(env[v]) !== null);
      if (hit) { agent = name; source.agent = hit; break; }
    }
  }
  // A bare `CI=true` says a machine ran this and nothing about which one. That is a real,
  // useful, honest distinction from a named agent — and from a human at a keyboard.
  if (!agent && clean(env.CI)) { agent = 'ci'; source.agent = 'CI'; }

  // ---- session ----------------------------------------------------------------------------
  // The host's own event payload outranks every environment sniff: when a hook hands holt a
  // session id, that id is the host's, not a guess assembled from variables.
  let session = clean(payload?.session_id ?? payload?.sessionId ?? payload?.session?.id);
  if (session) source.session = 'hook-payload';
  if (!session) {
    for (const k of SESSION_SIGNALS) {
      session = clean(env[k]);
      if (session) { source.session = k; break; }
    }
  }

  return {
    user: user ?? UNKNOWN,
    host: host ?? UNKNOWN,
    agent: agent ?? UNKNOWN,
    session: session ?? UNKNOWN,
    source,
  };
}

/** One-line human rendering: `raed@thinkpad via claude-code (sess abc123)`. */
export function formatActor(actor) {
  if (!actor) return UNKNOWN;
  const who = `${actor.user ?? UNKNOWN}@${actor.host ?? UNKNOWN}`;
  const via = actor.agent && actor.agent !== UNKNOWN ? ` via ${actor.agent}` : '';
  const sess = actor.session && actor.session !== UNKNOWN ? ` (sess ${String(actor.session).slice(0, 12)})` : '';
  return `${who}${via}${sess}`;
}
