// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — WHO is acting.
 *
 * Every other module in holt answers "what happened to this work". This one answers "who did
 * it", which is the question actually asked after an incident and the one holt could not
 * answer at all: the journal recorded `{at, action, id, path}` and nothing about the agent.
 *
 * THE ONE LAW HERE: NEVER INVENT IDENTITY.
 *
 * There is a strong pull toward filling the blank — `$USER`, the hostname, `git config
 * user.email`, a generated uuid. Every one of those is a LIE in the only situation that
 * matters. `$USER` is the human who launched the terminal, not the agent that ran the command;
 * a generated id is unique per process and correlates nothing; git's identity is whoever the
 * repo is configured as. An incident review that reads "raed deleted it" when a Cursor session
 * deleted it is worse than one that reads "unknown", because the first one gets believed.
 *
 * So: `unknown` is a first-class, recorded value, every field is nullable, and every claim
 * carries the EVIDENCE it came from. A reviewer can always ask "how do you know that".
 *
 * ------------------------------------------------------------------------------------------
 * WHAT EACH HOST ACTUALLY PASSES — measured against real binaries, not assumed.
 *
 * The temptation was to write a probe table from documentation. Documentation for this is
 * thin and drifts; what follows was read out of the shipping artifacts on 2026-08-01, and the
 * measurement is recorded next to each entry so the next reader can re-run it rather than
 * trust this comment (a comment with a fact in it starts rotting the moment it is written).
 *
 *   CLAUDE CODE — hook event on stdin.  Verified in the claude 2.1.219 binary: the PreToolUse
 *     payload is built as `{...base, hook_event_name:"PreToolUse", tool_name, tool_input,
 *     tool_use_id}`, and the base carries `session_id`, `transcript_path`, `cwd`,
 *     `permission_mode` (plus `agent_transcript_path` for subagent events).
 *       re-derive:  grep -ao '"session_id"' "$(command -v claude)" | head
 *     Environment, observed live in a Claude Code session: `CLAUDECODE=1`,
 *     `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_HOST_SESSION_ID`, `AI_AGENT=claude-code_<ver>_agent`.
 *
 *   OPENCODE — plugin hook argument.  Verified in the opencode binary: the runtime fires
 *     `trigger("tool.execute.before", {tool, sessionID, callID}, {args})`. So the plugin is
 *     HANDED a session id and a per-call id and holt's generated plugin was throwing both away.
 *       re-derive:  strings "$(...)/opencode" | grep -o 'tool.execute.before.\{0,80\}'
 *
 *   MCP — `initialize` carries `clientInfo {name, version}`, readable from the server as
 *     `getClientVersion()`. `RequestHandlerExtra.sessionId` exists in SDK 1.30.0 but is
 *     TRANSPORT-supplied and is undefined over stdio, which is how holt runs. Recording it as
 *     a session would therefore be recording a blank as if it were an answer — so MCP identity
 *     is `inferred` (the client named itself) and never `reported`.
 *
 *   EVERYTHING ELSE — no verified per-session channel today. The generic `AI_AGENT` variable is
 *     read for all of them because it costs nothing and is absent-safe; when it is absent the
 *     answer is `unknown`, which is the correct answer and not a gap to be papered over.
 * ------------------------------------------------------------------------------------------
 */

import os from 'node:os';
import { getHost } from './integrate/hosts.mjs';

/** The value recorded when holt does not know. A real value, never an empty string. */
export const UNKNOWN = 'unknown';

/**
 * How strongly holt believes the identity it recorded.
 *
 *   reported — the host handed holt a session id in its own event payload. Strongest: it ties
 *              the action to one conversation, and holt did not derive it.
 *   inferred — holt only has ambient evidence (environment variables, an MCP client name). The
 *              agent is named but the SESSION is not, so two runs cannot be told apart.
 *   unknown  — nothing identified the caller. Recorded, never guessed.
 */
export const CONFIDENCE = ['reported', 'inferred', 'unknown'];

/**
 * A key that is present-but-empty is NOT evidence. Hosts pass `""` and `null` for fields they
 * have not populated, and treating those as identity produced an actor whose session was the
 * empty string — indistinguishable in a timeline from a real one, and wrong.
 */
function firstString(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * `AI_AGENT` is emitted as `<name>_<version>_agent` (observed: `claude-code_2-1-219_agent`).
 * Parsed defensively: an unrecognised shape yields the whole string as the name and a null
 * version rather than a wrong version.
 */
export function parseAiAgent(raw) {
  const s = firstString(raw);
  if (!s) return null;
  const m = /^([a-z0-9][a-z0-9.-]*)_([0-9][0-9a-z.-]*)_agent$/i.exec(s);
  if (!m) return { name: s, version: null };
  return { name: m[1].toLowerCase(), version: m[2].replace(/-/g, '.') };
}

/**
 * Resolve who is acting, from evidence only.
 *
 * @param {object}  o
 * @param {Record<string, any> | null}  [o.payload]  the host's own event object (hook stdin JSON, plugin hook arg)
 * @param {Record<string, string|undefined> | null}  [o.env]      process environment
 * @param {string | null}  [o.host]     the `--host` the integration declared it is (a HINT, never proof:
 *                               it is whatever was written into a config file and can be stale)
 * @param {{name?:string, version?:string} | null}  [o.mcpClient] `{name, version}` from an MCP initialize, when serving MCP
 * @param {string | null}  [o.via]      transport label when the caller knows it
 * @returns {{user:string, host:string, agent:string, agentVersion:string|null, session:string|null, invocation:string|null,
 *            via:string, confidence:string, evidence:string[]}}
 */
export function resolveActor({ payload = null, env = process.env, host = null, mcpClient = null, via = null } = {}) {
  /** @type {Record<string, any>} */
  const p = (payload && typeof payload === 'object') ? payload : {};
  /** @type {Record<string, string|undefined>} */
  const e = (env && typeof env === 'object') ? env : {};
  const evidence = [];

  /* ---- session: only ever a value the host itself produced -------------------------- */

  // Claude Code hook stdin, then OpenCode's plugin argument. Both verified above.
  const reportedSession = firstString(p.session_id, p.sessionID, p.sessionId);
  if (reportedSession) {
    evidence.push(p.session_id ? 'payload.session_id' : (p.sessionID ? 'payload.sessionID' : 'payload.sessionId'));
  }

  // Ambient session, when the host publishes one into the environment. Weaker: it identifies
  // the HOST session, and holt cannot see whether a subagent inside it is the real caller.
  const ambientSession = reportedSession
    ? null
    : firstString(e.CLAUDE_CODE_HOST_SESSION_ID, e.HOLT_ACTOR_SESSION);
  if (ambientSession) {
    evidence.push(e.CLAUDE_CODE_HOST_SESSION_ID ? 'env.CLAUDE_CODE_HOST_SESSION_ID' : 'env.HOLT_ACTOR_SESSION');
  }

  /* ---- the per-call id, where a host gives one ------------------------------------- */

  const invocation = firstString(p.tool_use_id, p.callID, p.callId, p.toolUseId);
  if (invocation) evidence.push(p.tool_use_id ? 'payload.tool_use_id' : 'payload.callID');

  /* ---- which agent ---------------------------------------------------------------- */

  /** @type {string | null} */
  let agent = null;
  /** @type {string | null} */
  let agentVersion = null;

  // 0. THE CHANNEL THAT CARRIED A REPORTED SESSION IS THE AUTHORITY ON WHOSE SESSION IT IS.
  //
  //    MEASURED: the OpenCode plugin, running inside a Claude Code shell, forwarded opencode's
  //    own `sessionID` — and the actor came out as `claude-code`, because the ambient
  //    `AI_AGENT` variable is inherited by every child process and was consulted first. Every
  //    OpenCode action in a nested session would have been attributed to the wrong agent while
  //    carrying the right session id: a confident, specific, wrong answer, which is the worst
  //    kind this module can produce.
  //
  //    Environment variables describe the PROCESS TREE. A reported session describes the CALLER.
  //    When both exist they answer different questions, and the caller wins.
  if (reportedSession) {
    const declared = firstString(host);
    if (declared && declared !== 'generic' && getHost(declared)) {
      agent = declared;
      evidence.push('flag.--host (carried the reported session)');
    }
  }

  // 1. The MCP client names itself in `initialize`. It is self-reported, and that is exactly
  //    what it is recorded as.
  if (!agent && mcpClient && firstString(mcpClient.name)) {
    agent = normaliseAgentName(mcpClient.name);
    agentVersion = firstString(mcpClient.version);
    evidence.push('mcp.clientInfo');
  }

  // 2. AI_AGENT: one variable, carries name AND version, present for at least one major host.
  if (!agent) {
    const ai = parseAiAgent(e.AI_AGENT);
    if (ai) {
      agent = normaliseAgentName(ai.name);
      agentVersion = ai.version;
      evidence.push('env.AI_AGENT');
    }
  }

  // 3. Host-specific presence markers. Only ones observed in a real session are listed; an
  //    unlisted host resolves to unknown, which is the honest answer and not a defect.
  if (!agent && firstString(e.CLAUDECODE, e.CLAUDE_CODE_ENTRYPOINT)) {
    agent = 'claude-code';
    evidence.push(e.CLAUDECODE ? 'env.CLAUDECODE' : 'env.CLAUDE_CODE_ENTRYPOINT');
  }
  if (!agent && firstString(e.CURSOR_TRACE_ID)) { agent = 'cursor'; evidence.push('env.CURSOR_TRACE_ID'); }
  if (!agent && firstString(e.OPENCODE_SESSION_ID, e.OPENCODE)) { agent = 'opencode'; evidence.push('env.OPENCODE'); }

  // 4. The `--host` the integration declared. LAST, and deliberately so: it is a string written
  //    into a config file months ago by `holt integrate`, not a live observation. It is enough
  //    to name the agent, never enough to claim a session.
  if (!agent) {
    const declared = firstString(host);
    if (declared && declared !== 'generic' && getHost(declared)) {
      agent = declared;
      evidence.push('flag.--host');
    }
  }

  /* ---- confidence ----------------------------------------------------------------- */

  const session = reportedSession ?? ambientSession ?? null;
  const confidence = reportedSession
    ? 'reported'
    : (agent || ambientSession ? 'inferred' : 'unknown');

  return {
    user: UNKNOWN,
    host: UNKNOWN,
    agent: agent ?? UNKNOWN,
    agentVersion: agentVersion ?? null,
    session,
    invocation: invocation ?? null,
    via: firstString(via, p.hook_event_name ? 'hook' : null) ?? 'cli',
    confidence,
    evidence,
  };
}

/** Map a self-reported client name onto a known host id where it plainly matches; else keep it. */
function normaliseAgentName(raw) {
  const s = String(raw).trim().toLowerCase().replace(/\s+/g, '-');
  if (getHost(s)) return s;
  // MCP clients name themselves things like "claude-ai", "cursor-vscode", "Visual Studio Code".
  for (const id of ['claude-code', 'opencode', 'cursor', 'codex', 'gemini-cli', 'copilot', 'cline', 'crush', 'zed', 'aider']) {
    if (s === id || s.startsWith(`${id}-`) || s.startsWith(`${id}_`)) return id;
  }
  return s;
}

/**
 * A stable, human-readable label for a resolved actor. This is what a timeline column shows,
 * and it must never look like a real id when it is not one.
 */
export function actorLabel(actor) {
  if (!actor || typeof actor !== 'object') return UNKNOWN;
  const agent = firstString(actor.agent) ?? UNKNOWN;
  if (!actor.session) return agent === UNKNOWN ? UNKNOWN : `${agent}/${UNKNOWN}-session`;
  return `${agent}/${String(actor.session).slice(0, 12)}`;
}

/**
 * The correlation key. Two journal lines belong to the same actor iff this matches.
 *
 * Returns null when there is nothing to correlate on — and that null is the point. Grouping
 * every unattributed event under one synthetic bucket would invent the claim that they came
 * from ONE agent, which is precisely the fabrication this module exists to refuse.
 */
export function actorKey(actor) {
  if (!actor || typeof actor !== 'object') return null;
  // UNKNOWN is the honest answer when no host identified itself, but it is NOT identity —
  // correlating two 'unknown' sessions would fabricate "one agent did all of this" from
  // events that carry no session at all. The journal normalises null → 'unknown' for
  // durable storage; actorKey must treat that normalisation as the null it was.
  if (!actor.session || actor.session === UNKNOWN) return null;
  const agent = firstString(actor.agent) ?? UNKNOWN;
  return `${agent}:${actor.session}`;
}

/* ------------------------------------------------------------------ ambient actor ---- */

/**
 * One process is one caller, so the actor is resolved once and read by whatever records an
 * event. The alternative — threading an actor argument through protect/rescue/clean/branches
 * and every MCP tool — is a wider blast radius for the same result, and a call site that
 * forgot to pass it would silently record `unknown` while looking correct.
 *
 * Explicit and overridable, never magic: `setAmbientActor` is called exactly twice (the CLI
 * entry point and the MCP server), and `appendEvent` takes an explicit actor that wins.
 */
/** @type {object | null} */
let ambient = null;

export function setAmbientActor(actor) {
  ambient = (actor && typeof actor === 'object') ? actor : null;
  return ambient;
}

/** The current actor, resolving lazily from the environment the first time it is asked. */
export function currentActor() {
  if (!ambient) ambient = resolveActor({});
  return ambient;
}

/** Test seam: forget everything resolved so far. */
export function __resetAmbientActor() { ambient = null; }
