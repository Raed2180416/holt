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
import path from 'node:path';
import { git } from './git.mjs';
import { currentActor, UNKNOWN } from './actor.mjs';

/**
 * REFUSES rather than guessing. `git()` reports failure as a non-zero code, not an exception, so
 * an unresolvable common dir used to leave `stdout` empty and `path.join('', 'holt', …)` produced
 * the RELATIVE path `holt/journal.jsonl` — which `appendEvent` then happily created inside
 * whatever directory the process was started in. Two failures at once: the audit line went
 * somewhere nobody would look for it, and holt wrote a file into the repository it inspects,
 * which is the one thing it promises never to do.
 *
 * Found by the test asserting holt is LOUD when it cannot record an attempt: the stderr warning
 * never fired, because the write had silently "succeeded" into the wrong place.
 */
async function journalPath(cwd) {
  const common = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd });
  const dir = common.stdout.trim();
  if (common.code !== 0 || !dir || !path.isAbsolute(dir)) {
    throw new Error(
      `cannot locate the git directory for ${cwd} (${(common.stderr || '').trim() || `exit ${common.code}`})`,
    );
  }
  return path.join(dir, 'holt', 'journal.jsonl');
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
    await fs.mkdir(path.dirname(p), { recursive: true });
    // The actor is written LAST so an event that (wrongly) carried its own `actor` key cannot
    // overwrite the resolved one — attribution is not something a caller gets to spoof by
    // shape collision.
    const line = { at: new Date().toISOString(), ...event, actor: actor ?? currentActor() };
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
  let raw;
  try {
    raw = await fs.readFile(await journalPath(cwd), 'utf8');
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
