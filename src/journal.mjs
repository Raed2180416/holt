// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — append-only action journal.
 *
 * Every mutating action (protect, unprotect, rescue, clean-remove, branch-delete) appends one
 * JSONL line under the repository's COMMON git dir, so the record survives worktree deletion,
 * is shared by every worktree, and never appears in `git status`. Months later, "who deleted
 * that worktree, and what was the evidence" has an answer; agents get an audit trail for free.
 *
 * The journal is best-effort BY DESIGN: failing to record must never abort the action itself
 * (the action's own verification already ran and the state change is real either way), but the
 * failure must be LOUD on stderr — a silent audit gap is worse than a crash.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git } from './git.mjs';

/**
 * Where the audit trail lives, or `null` when git cannot say.
 *
 * AN EMPTY ANSWER IS NOT A PATH PREFIX. When `rev-parse --git-common-dir` failed or returned
 * nothing — outside a repository, a broken symlink, a git too old for the flag — `path.join('',
 * 'holt', 'journal.jsonl')` produced the RELATIVE path `holt/journal.jsonl`, and holt appended its
 * audit journal into whatever directory the process happened to be standing in.
 *
 * FOUND IN THIS REPOSITORY: an untracked `holt/journal.jsonl` appeared at the root of holt's own
 * working tree, holding a real `blocked` event, written by an agent that had run holt somewhere
 * git could not resolve. It shows up in `git status`, invites being committed, and is the same
 * defect this project keeps finding — a failed read treated as a usable value rather than as the
 * absence of one.
 *
 * So: resolve, verify the result is ABSOLUTE, and otherwise return null. A caller that cannot
 * locate the journal must say so, not invent a location.
 */
async function journalPath(cwd) {
  const common = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd })
    .catch(() => null);
  const dir = common?.stdout?.trim();
  if (!dir || !path.isAbsolute(dir)) return null;
  return path.join(dir, 'holt', 'journal.jsonl');
}

/**
 * WHO — the third of the three facts an audit trail owes a reviewer, next to WHAT and WHEN.
 *
 * The journal recorded what happened and when, and never who. In a repository where a human and
 * several agents all act, "a protection was released at 03:12" is not an audit record, it is a
 * timestamp. So every event carries an actor, stamped centrally HERE rather than at each call
 * site: an attribution that depends on every new action remembering to add it is an attribution
 * with a hole in it — the same defect as journalling four actions out of five.
 *
 * NOTHING IS INVENTED. Each field is a measurement or the literal string 'unknown'. A fabricated
 * identity in an audit log is worse than an admitted gap, because a reviewer cannot tell the two
 * apart.
 *
 * The agent identity is read from environment variable NAMES, never by scanning environment
 * VALUES for something that looks like a session id. That distinction is deliberate: an audit
 * file must not become the place secrets land. A name qualifies when it ENDS in `_SESSION_ID` or
 * `_AGENT_ID` — the convention every agent host that publishes an identity already follows — so
 * a host holt has never heard of is attributed with no code change, and the agent NAME is
 * derived from the variable's own prefix rather than from a list holt has to maintain.
 * `HOLT_ACTOR` overrides everything, because a CI system knows its own identity better than any
 * heuristic can.
 */
const AGENT_ID_VAR = /^([A-Z0-9]+(?:_[A-Z0-9]+)*?)_(?:SESSION_ID|AGENT_ID)$/;
const MAX_FIELD = 200;

/**
 * Namespaces the OPERATING SYSTEM and desktop own. They follow the very same naming convention
 * and are NOT actors: `XDG_SESSION_ID` is systemd-logind's login session, `DBUS_SESSION_*` the
 * message bus. Recording "agent: xdg" would be precisely the invented identity this whole block
 * exists to refuse. Note what the list contains — OS-owned namespaces, never agent names. A new
 * agent host needs no entry here, which is the property that stops it rotting.
 */
const OS_SESSION_NAMESPACES = new Set([
  'XDG', 'DBUS', 'DESKTOP', 'GNOME', 'KDE', 'SSH', 'TERM', 'WINDOW', 'LOGIN', 'SYSTEMD', 'X11',
]);

/** One line, bounded. Control characters would break the JSONL record they are written into. */
const clip = (v) => {
  const s = String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return s.length > MAX_FIELD ? `${s.slice(0, MAX_FIELD)}…` : s;
};

/** The automation identity the environment declares, or null when it declares none. */
function agentFrom(env) {
  const candidates = [];
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const m = AGENT_ID_VAR.exec(name);
    if (!m) continue;
    if (OS_SESSION_NAMESPACES.has(m[1].split('_')[0])) continue;
    candidates.push({ name, prefix: m[1], value: value.trim() });
  }
  if (!candidates.length) return null;
  // When one namespace publishes several, the LEAST-QUALIFIED name is its primary identifier
  // (CLAUDE_CODE_SESSION_ID over CLAUDE_CODE_HOST_SESSION_ID); ties break lexicographically, so
  // the recorded actor never depends on the order the environment happened to be built in.
  candidates.sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));
  const best = candidates[0];
  return {
    name: best.prefix.toLowerCase().replace(/_/g, '-'),
    session: clip(best.value),
    source: best.name,
  };
}

/** {user, host, agent, session, source} — every field measured, or the string 'unknown'. */
export function actorOf({ env = process.env } = {}) {
  const override = env.HOLT_ACTOR?.trim();

  let user = '';
  try { user = os.userInfo().username || ''; } catch { /* no passwd entry (container) */ }
  if (!user) user = env.USER || env.USERNAME || env.LOGNAME || '';

  let host = '';
  try { host = os.hostname() || ''; } catch { /* unavailable in a locked-down sandbox */ }

  const agent = override ? null : agentFrom(env);

  return {
    user: user ? clip(user) : 'unknown',
    host: host ? clip(host) : 'unknown',
    agent: override ? clip(override) : (agent?.name ?? 'unknown'),
    session: agent?.session ?? 'unknown',
    // HOW the agent was identified, so a reviewer can audit the attribution itself instead of
    // taking holt's word for it.
    source: override ? 'HOLT_ACTOR' : (agent?.source ?? 'unknown'),
  };
}

/** Append one event. Returns {ok} and never throws. */
export async function appendEvent(cwd, event, { env = process.env } = {}) {
  try {
    const p = await journalPath(cwd);
    // No resolvable journal means no journal. Writing to a relative fallback would put an audit
    // trail in the user's working tree — which is how `holt/journal.jsonl` ended up untracked at
    // the root of this very repository.
    if (!p) {
      process.stderr.write(
        `holt journal: no git common dir here, so '${event?.action ?? '?'}' was not recorded `
        + '— the action itself was NOT affected\n');
      return { ok: false, error: 'no git common dir' };
    }
    await fs.mkdir(path.dirname(p), { recursive: true });
    const line = { at: new Date().toISOString(), actor: actorOf({ env }), ...event };
    await fs.appendFile(p, `${JSON.stringify(line)}\n`, 'utf8');
    return { ok: true };
  } catch (e) {
    process.stderr.write(
      `holt journal: could not record '${event?.action ?? '?'}' (${e.message}) — the action itself was NOT affected\n`);
    return { ok: false, error: e.message };
  }
}

/** Read the whole journal, oldest first. A corrupt line is surfaced, not swallowed. */
export async function readJournal(cwd) {
  const p = await journalPath(cwd);
  if (!p) return [];   // nowhere to keep a journal means there are no events, not an error
  let raw;
  try {
    raw = await fs.readFile(p, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  return raw.split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return { corrupt: line }; }
  });
}
