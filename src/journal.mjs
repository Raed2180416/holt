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
import path from 'node:path';
import { git } from './git.mjs';

async function journalPath(cwd) {
  const common = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd });
  return path.join(common.stdout.trim(), 'holt', 'journal.jsonl');
}

/** Append one event. Returns {ok} and never throws. */
export async function appendEvent(cwd, event) {
  try {
    const p = await journalPath(cwd);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.appendFile(p, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, 'utf8');
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
    try { return JSON.parse(line); } catch { return { corrupt: line }; }
  });
}
