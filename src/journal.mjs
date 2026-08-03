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
 *
 * EVERY LINE CARRIES ITS ACTOR (see src/actor.mjs). "who deleted that worktree" was in the
 * header comment of this file as a thing the journal answered, and it did not: an event was
 * `{at, action, id, path}` with no agent, no session, nothing. Identity is stamped here, in ONE
 * place, so no future call site can forget it — and it is stamped as `unknown` when unknown,
 * which is a recorded answer rather than a missing field.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git } from './git.mjs';
import { mark } from './untrusted.mjs';
import { currentActor, UNKNOWN } from './actor.mjs';

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
 * Neutralise every terminal/JSONL control character in one place.
 *
 * C0 (U+0000-001F), DEL (U+007F) AND C1 (U+0080-009F). The C1 half was missing and matters: it is
 * where the 8-bit CSI/OSC live (U+009B, U+009D), and JSON.stringify escapes C0 but passes C1 and
 * DEL through raw, so without stripping them here a hostile name would reach a terminal that
 * renders the journal. Matches server/index.mjs sanitizeClaim, which already strips this range.
 * NEVER-WORSE: only control code points are touched; every printable character, including
 * non-Latin scripts, survives untouched.
 *
 * AND IT IS THE PROGRAM'S ONE ENCODER, NOT A SECOND ONE. This was `String(v).replace(RE, ' ')` —
 * every control character SUBSTITUTED BY A SPACE. Measured: two worktrees, `dup\x01x` (a legal
 * Linux basename) and `dup x` (an ordinary one), journalled by `holt protect` as
 *
 *     id="dup x"  path="dup x"
 *     id="dup x"  path="dup x"
 *
 * — two locks on what reads as one worktree, no record anywhere that `dup\x01x` was locked, and a
 * `path` field naming a real, existing, DIFFERENT directory, propagated verbatim by
 * `holt journal --json` and `--export csv`. A journal's entire value is that it says what
 * happened; a lossy sanitiser in front of it makes it assert something false. src/untrusted.mjs
 * states the law this broke — the mapping is INJECTIVE, nothing is silently dropped — and the
 * fix is to stop having a second, worse implementation of it.
 *
 * `mark()` is injective: `\x01` becomes `␁`, C1 and DEL become `⟨U+009B⟩`, and `decodeMarked()`
 * recovers the original exactly, so nothing is lost and no two names can collapse into one. It
 * runs at WRITE time on purpose: `JSON.stringify` escapes C0 but leaves C1 and DEL raw, so a
 * hostile name in the file itself would drive the terminal of anyone who ran `cat journal.jsonl`.
 * It also neutralises bidi and zero-width characters, which the old regex did not touch at all.
 */
const stripControls = (v) => mark(v, { max: Number.MAX_SAFE_INTEGER });

const MAX_FIELD = 200;

/** One line, bounded. Control characters would break the JSONL record they are written into. */
const clip = (v) => {
  const s = stripControls(v).trim();
  return s.length > MAX_FIELD ? `${s.slice(0, MAX_FIELD)}…` : s;
};

/**
 * Neutralise control characters in EVERY string an event carries, recursively.
 *
 * WHY EVENT FIELDS AND NOT JUST THE ACTOR. The actor block above is scrupulous about newlines and
 * clipping, but it only guarded the actor; the events OWN strings (id, path, branch, reason,
 * evidence) went into the record raw. Those are the attacker-controlled ones: a worktree id is a
 * directory basename and a branch name is arbitrary, both choosable by whoever prepared the repo.
 * REPRODUCED: a worktree whose directory basename held a real newline was journalled by
 * `holt protect`, and `holt journal` then rendered a SECOND line
 * ([holt] VERDICT: safe to delete ALL worktrees) indistinguishable from holts own output. The
 * JSONL file stays well-formed (JSON.stringify escapes the newline); the forgery is at the human
 * render, where the field prints raw. A C1/OSC byte would rewrite the terminal outright and could
 * hide a real audit entry.
 *
 * Neutralised centrally, for the same reason the actor is stamped centrally: a defence that
 * depends on every future action remembering to sanitise its own fields has a hole in it. Only
 * control characters are removed, NOT length, so holts own reasons and a humans verbatim
 * --reason justification are preserved exactly but for the control bytes.
 */
function clipEventDeep(value, depth = 0) {
  if (typeof value === "string") return stripControls(value);
  if (Array.isArray(value)) return depth >= 20 ? [] : value.map((v) => clipEventDeep(v, depth + 1));
  if (value && typeof value === "object") {
    if (depth >= 20) return {};
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = clipEventDeep(v, depth + 1);
    return out;
  }
  return value;   // numbers, booleans, null preserved so forced:true / overrideReason:null survive
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

/**
 * The actor shape a reader can always rely on. A journal written before identity existed has no
 * `actor` key at all; normalising on READ rather than rewriting history means an old line is
 * reported as genuinely unattributed instead of being back-filled with today's agent — which
 * would be fabricating attribution for an action holt did not observe.
 */
export const UNATTRIBUTED = Object.freeze({
  agent: UNKNOWN, agentVersion: null, session: null, invocation: null,
  via: UNKNOWN, confidence: 'unknown', evidence: [],
});

/**
 * Append one event. Returns {ok} and never throws.
 *
 * @param {string} cwd
 * @param {object} event
 * @param {object} [opts]
 * @param {object} [opts.actor] explicit actor; defaults to the process's resolved actor
 */
export async function appendEvent(cwd, event, { actor = null } = {}) {
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
    // The event's own strings carry attacker-controlled names (worktree id, branch, path); neutralise
    // control characters in all of them centrally, exactly as the actor is neutralised, so nothing an
    // action forgets to sanitise can forge a line in the rendered audit trail. See clipEventDeep.
    // The actor is written LAST so an event that (wrongly) carried its own `actor` key cannot
    // overwrite the resolved one — attribution is not something a caller gets to spoof by
    // shape collision.
    const line = { at: new Date().toISOString(), ...clipEventDeep(event), actor: actor ?? currentActor() };
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
    let e;
    try { e = JSON.parse(line); } catch { return { corrupt: line }; }
    if (!e || typeof e !== 'object') return { corrupt: line };
    // Every reader gets the same shape, and an event predating identity is reported as
    // unattributed rather than as a missing key some caller will forget to handle.
    if (!e.actor || typeof e.actor !== 'object') e.actor = { ...UNATTRIBUTED };
    return e;
  });
}
