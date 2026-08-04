// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — hash-chained, actor-attributed action journal.
 *
 * Every mutating action (protect, UNPROTECT, rescue, clean-remove, branch-delete, blocked)
 * appends one JSONL line under the repository's COMMON git dir, so the record survives worktree
 * deletion, is shared by every worktree, and never appears in `git status`.
 *
 * WHAT CHANGED AND WHY. The plain JSONL version recorded what and when. A compliance reviewer
 * needs three more things, and their absence is not a polish item — it is the difference between
 * an audit trail and a text file:
 *
 *   1. WHO. Every entry carries an actor (user, host, agent, session), or the literal 'unknown'.
 *      See src/actor.mjs: never a guess. "who deleted that worktree" was in the header comment of
 *      this file as a thing the journal answered, and it did not: an event was
 *      `{at, action, id, path}` with no agent, no session, nothing. Identity is stamped here, in
 *      ONE place, so no future call site can forget it — and it is stamped as `unknown` when
 *      unknown, which is a recorded answer rather than a missing field.
 *   2. INTEGRITY. Each entry carries `seq` and `prev` — the RFC 6962 leaf hash of the entry
 *      before it — and a C2SP `tlog-checkpoint` sidecar pins the whole log by Merkle root and
 *      size. Editing one entry breaks that entry's successor; deleting entries breaks the seq
 *      run; TRUNCATING the tail leaves a perfectly valid chain and is caught only by the
 *      checkpoint, which is precisely why the checkpoint exists and why its ABSENCE is a
 *      verification FAILURE rather than a shrug.
 *   3. UNPROTECT. The one action that REMOVES protection from irreplaceable work was invisible
 *      in the trail — a hole exactly where the risk is. It is journalled in src/actions.mjs now.
 *
 * WHAT THE CHAIN COVERS. Verification canonicalises each PARSED entry (src/attest.mjs), so
 * reformatting the file — pretty-printing, reordering keys within a line — is deliberately not
 * an alarm. What is chained is the semantic content of each record. Changing any VALUE, adding
 * or removing a field, or moving a record is detected and named.
 *
 * BEST-EFFORT, WITH ONE EXCEPTION. Failing to record must never abort the action itself (the
 * action's own verification already ran and the state change is real either way), but the
 * failure must be LOUD on stderr — a silent audit gap is worse than a crash. The exception: if
 * the chain head cannot be established under lock, holt REFUSES to append rather than writing an
 * unchained entry. An audit gap that says "a record is missing" is recoverable; a chain that
 * reads as tampering when nobody tampered destroys the trust the whole artefact runs on.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git } from './git.mjs';
import { mark } from './untrusted.mjs';
import { currentActor, UNKNOWN, resolveActor } from './actor.mjs';
import {
  entryLeaf, merkleRoot, formatCheckpoint, parseCheckpoint, verifyNote,
  inclusionProof, verifyInclusion,
} from './attest.mjs';

/** 64 zeros: the `prev` of the first entry. A real SHA-256 can never be this. */
export const GENESIS = '0'.repeat(64);

/** The mutating actions this journal is expected to carry. Documentation, never a filter. */
export const JOURNALLED_ACTIONS = [
  'protect', 'unprotect', 'rescue', 'clean-remove', 'branch-delete', 'blocked',
];

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
async function holtDir(cwd) {
  const common = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd })
    .catch(() => null);
  const dir = common?.stdout?.trim();
  if (!dir || !path.isAbsolute(dir)) return null;
  return path.join(dir, 'holt');
}

async function journalPath(cwd) {
  const dir = await holtDir(cwd);
  if (!dir) return null;
  return path.join(dir, 'journal.jsonl');
}

export async function journalPaths(cwd) {
  const dir = await holtDir(cwd);
  if (!dir) throw new Error('could not locate the repository git dir');
  return {
    dir,
    journal: path.join(dir, 'journal.jsonl'),
    checkpoint: path.join(dir, 'checkpoint'),
    lock: path.join(dir, 'journal.lock'),
  };
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

/* ==================================================================== LOCK ==== */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A git-style `.lock` around read-modify-write.
 *
 * holt exists BECAUSE agents run in parallel, so two simultaneous appends are the normal case,
 * not the exotic one. Without this both would read the same head and write the same `prev` —
 * a forked chain that verify would report as tampering. O_EXCL creation is the atomic primitive
 * (the same one git itself uses for ref updates); a lock older than `staleMs` is broken open,
 * because a crashed process must not wedge the audit trail forever.
 */
export async function withLock(lockPath, fn, { timeoutMs = 5_000, staleMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  /** @type {import('node:fs/promises').FileHandle | null} */
  let handle = null;
  for (;;) {
    try {
      handle = await fs.open(lockPath, 'wx');
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const age = await fs.stat(lockPath).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > staleMs) { await fs.rm(lockPath, { force: true }); continue; }
      if (Date.now() > deadline) {
        throw new Error(`journal is locked by another holt process (waited ${timeoutMs}ms) — nothing was written`);
      }
      await sleep(5 + Math.floor(Math.random() * 25)); // jitter: two waiters must not resonate
    }
  }
  try {
    return await fn();
  } finally {
    await handle.close().catch(() => {});
    await fs.rm(lockPath, { force: true }).catch(() => {});
  }
}

/* ================================================================== READ ==== */

/** Raw read: the lines exactly as stored, plus the parse of each. Verification needs both. */
export async function readJournalRaw(cwd) {
  const { journal, checkpoint } = await journalPaths(cwd);
  /** @type {string | null} */
  let raw = null;
  try {
    raw = await fs.readFile(journal, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  /** @type {string | null} */
  let checkpointText = null;
  try {
    checkpointText = await fs.readFile(checkpoint, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const lines = raw === null ? [] : raw.split('\n').filter(Boolean);
  const entries = lines.map((line) => {
    try { return JSON.parse(line); } catch { return { corrupt: line }; }
  });
  return { lines, entries, checkpointText, journalExists: raw !== null };
}

/* ================================================================ APPEND ==== */

/**
 * Split the log into the LEGACY prefix (records written before chaining existed, which carry no
 * `seq` at all) and the CHAINED run that follows.
 *
 * The discriminator is "carries a seq field", NOT "carries seq 0" — and the difference is a real
 * defect found by attacking this file. Keying on seq 0 conflated two completely different
 * situations: a journal that predates chaining, and one whose FIRST RECORD WAS DELETED. Both
 * produced "0 chained entries, N legacy", so deleting the head of the log was reported as
 * "N records were removed from the END" — detected, but described as the opposite of what
 * happened. A verifier that misnames the tampering is only half an instrument.
 */
function chainHead(entries) {
  const start = entries.findIndex((e) => e && e.corrupt === undefined && typeof e.seq === 'number');
  if (start < 0) {
    return { start: entries.length, chained: [], leaves: [], prev: GENESIS, size: 0, headSeq: null };
  }
  const chained = entries.slice(start);
  const leaves = chained.map((e) => entryLeaf(e));
  return {
    start,
    chained,
    leaves,
    prev: leaves.length ? leaves[leaves.length - 1].toString('hex') : GENESIS,
    size: chained.length,
    headSeq: chained[0].seq,
  };
}

/**
 * Normalise an actor for journal storage: every identity field becomes a string, with null
 * replaced by UNKNOWN. The actor module keeps `session: null` as a first-class value (so
 * `actorKey` can return null and refuse to correlate unattributed events), but a journal entry
 * is a durable record — a missing field and a field that says 'unknown' are different things to
 * a reader months later, and the audit-chain test verifies that every entry carries all four
 * identity fields as non-empty strings.
 */
function normaliseActorForJournal(a) {
  if (!a || typeof a !== 'object') return { user: UNKNOWN, host: UNKNOWN, agent: UNKNOWN, session: UNKNOWN, source: UNKNOWN };
  return {
    user: a.user ?? UNKNOWN,
    host: a.host ?? UNKNOWN,
    agent: a.agent ?? UNKNOWN,
    agentVersion: a.agentVersion ?? null,
    session: a.session ?? UNKNOWN,
    invocation: a.invocation ?? null,
    via: a.via ?? 'cli',
    source: a.confidence ?? UNKNOWN,
    confidence: a.confidence ?? 'unknown',
    evidence: a.evidence ?? [],
  };
}

function defaultOrigin(dir) {
  // C2SP requires a unique origin line. It is set ONCE, on the first append, and then inherited
  // from the existing checkpoint forever — so moving or renaming the repository can never make
  // an existing log fail to verify. Swapping in a foreign checkpoint still fails, on the root.
  const repo = path.basename(path.dirname(path.dirname(dir))) || 'repo';
  return `holt.dev/journal/${repo.replace(/[^A-Za-z0-9._-]/g, '_') || 'repo'}`;
}

/**
 * Append one event, chained and attributed. Returns {ok, seq, leaf, root, size}; never throws.
 *
 * The event's own strings carry attacker-controlled names (worktree id, branch, path); neutralise
 * control characters in all of them centrally via clipEventDeep, exactly as the actor is
 * neutralised, so nothing an action forgets to sanitise can forge a line in the rendered audit
 * trail. The actor is resolved from the ambient context (currentActor) unless one is passed
 * explicitly. The chain fields (seq, prev) are written LAST, deliberately: a caller must not be
 * able to overwrite them by naming them in its payload.
 *
 * @param {string} cwd    any path inside the repository
 * @param {Record<string, any>} event  the caller's payload (action, id, path, …)
 * @param {{actor?: object|null, env?: object, payload?: any, now?: number|string|Date|null}} [opts]
 */
export async function appendEvent(cwd, event, { actor = null, env = process.env, payload = null, now = null } = {}) {
  try {
    const dir = await holtDir(cwd);
    // No resolvable journal means no journal. Writing to a relative fallback would put an audit
    // trail in the user's working tree — which is how `holt/journal.jsonl` ended up untracked at
    // the root of this very repository.
    if (!dir) {
      process.stderr.write(
        `holt journal: no git common dir here, so '${event?.action ?? '?'}' was not recorded `
        + '— the action itself was NOT affected\n');
      return { ok: false, error: 'no git common dir' };
    }
    const journal = path.join(dir, 'journal.jsonl');
    const checkpoint = path.join(dir, 'checkpoint');
    const lock = path.join(dir, 'journal.lock');
    await fs.mkdir(dir, { recursive: true });

    return await withLock(lock, async () => {
      const { entries, checkpointText } = await readJournalRaw(cwd);
      const head = chainHead(entries);

      let origin;
      try { origin = parseCheckpoint(checkpointText ?? '').origin; } catch { origin = defaultOrigin(dir); }

      // Continue from where the chain actually is, rather than from its length: if the head of
      // the log was removed, a length-derived seq would DUPLICATE an existing number and hide
      // the deletion behind a second, unrelated-looking symptom.
      const nextSeq = head.size ? head.headSeq + head.size : 0;

      const record = {
        at: new Date(now ?? Date.now()).toISOString(),
        actor: normaliseActorForJournal(actor ?? currentActor()),
        ...clipEventDeep(event),
        // LAST, deliberately: a caller must not be able to overwrite the chain fields by naming
        // them in its payload. That would be a self-service forgery primitive.
        seq: nextSeq,
        prev: head.prev,
      };

      const leaf = entryLeaf(record);
      const leaves = [...head.leaves, leaf];
      const root = merkleRoot(leaves);

      // Journal first, checkpoint second. If the process dies between the two, verify reports a
      // checkpoint that LAGS the log — an honest, recoverable state that names itself. The other
      // order would report a log that lags its checkpoint, which reads as DELETION.
      await fs.appendFile(journal, `${JSON.stringify(record)}\n`, 'utf8');
      await fs.writeFile(checkpoint, formatCheckpoint({ origin, size: leaves.length, root }), 'utf8');

      return {
        ok: true, seq: record.seq, leaf: leaf.toString('hex'),
        root: root.toString('hex'), size: leaves.length,
      };
    });
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

/* ================================================================ VERIFY ==== */

/**
 * Verify the chain and the checkpoint, and name EXACTLY which entry broke.
 *
 * FAIL-CLOSED ON MISSING EVIDENCE, which is the recurring defect class this codebase keeps
 * finding in itself: an absent checkpoint, a chain that does not start at seq 0, and a corrupt
 * line are all FAILURES with a named code — never a quiet pass. The only thing that is not a
 * failure is a journal written before chaining existed, which is reported as `legacy` with an
 * explicit count and an explicit statement that those entries cannot be verified.
 *
 * @returns {Promise<{ok:boolean, code:string, broken:{index:number, line:number, seq:number|null, at:string|null, action:string|null, actor:object|null, reason:string, missing?:number}|null, reason?:string, legacy?:number, chained?:number, entries?:number, root?:string|null, size?:number, checkpoint?:{origin:string, size:number, root:string, signed:boolean, signatureValid:boolean|null, signers:string[]}|null}>}
 * @param {string} cwd
 * @param {{trustedKeys?: any[]}} [opts]
 */
export async function verifyJournal(cwd, { trustedKeys = [] } = {}) {
  const { entries, checkpointText, journalExists } = await readJournalRaw(cwd);

  const empty = {
    entries: entries.length, legacy: 0, chained: 0, root: null, size: 0,
    checkpoint: null, broken: null,
  };

  if (!journalExists) {
    return { ...empty, ok: true, code: 'empty', reason: 'no journal in this repository yet — nothing to verify' };
  }

  // A line that does not parse is checked before anything else: every later check reads fields
  // off entries, and a half-written line is the single most likely real-world corruption.
  for (let i = 0; i < entries.length; i++) {
    if (entries[i]?.corrupt !== undefined) {
      return {
        ...empty, ok: false, code: 'corrupt-line',
        reason: `line ${i + 1} is not valid JSON — the journal was edited, or a write was interrupted`,
        broken: { index: i, line: i + 1, seq: null, at: null, action: null, actor: null, reason: 'not valid JSON' },
      };
    }
  }

  const head = chainHead(entries);
  const legacy = head.start;
  const chained = head.chained;

  const fail = (i, code, reason) => {
    const e = chained[i] ?? null;
    return {
      ...empty, ok: false, code, reason, legacy, chained: chained.length,
      broken: {
        index: legacy + i, line: legacy + i + 1,
        seq: e?.seq ?? null, at: e?.at ?? null, action: e?.action ?? null, actor: e?.actor ?? null,
        reason,
      },
    };
  };

  // Named before the per-entry walk, because it is the one break the walk cannot describe: with
  // the first record gone there is no seq-0 entry to anchor positions against.
  if (chained.length && chained[0].seq !== 0) {
    return fail(0, 'chain-head-removed',
      `the chain now starts at seq ${chained[0].seq}, not 0 — the first ${chained[0].seq} record(s) were DELETED from the head of the log`);
  }

  for (let i = 0; i < chained.length; i++) {
    const e = chained[i];
    if (typeof e.seq !== 'number' || typeof e.prev !== 'string') {
      return fail(i, 'unchained-entry',
        `entry ${legacy + i + 1} carries no hash-chain fields although the chain had already started — it was inserted by something that is not holt`);
    }
    if (e.seq !== i) {
      return fail(i, 'seq-gap',
        `entry ${legacy + i + 1} claims seq ${e.seq} but sits in position ${i} — ${e.seq > i ? 'earlier record(s) were DELETED' : 'records were duplicated or reordered'}`);
    }
    const expectedPrev = i === 0 ? GENESIS : head.leaves[i - 1].toString('hex');
    if (e.prev !== expectedPrev) {
      return fail(i, 'prev-mismatch', i === 0
        ? 'the first chained entry does not start from genesis — the head of the log was removed'
        : `entry ${legacy + i + 1} (seq ${e.seq}, ${e.action ?? 'unknown action'}) does not follow entry ${legacy + i}: the predecessor hash it recorded does not match. Entry ${legacy + i} was EDITED, or a record between them was removed.`);
    }
  }

  const root = chained.length ? merkleRoot(head.leaves) : null;

  /** @type {{origin:string, size:number, root:Buffer, extensions:string[]} | null} */
  let cp = null;
  /** @type {{valid:boolean, body:any, signatures:any[], reason:string|null} | null} */
  let note = null;
  if (checkpointText) {
    note = verifyNote(checkpointText, { keys: trustedKeys });
    try {
      cp = parseCheckpoint(checkpointText);
    } catch (e) {
      return {
        ...empty, ok: false, code: 'checkpoint-unreadable', legacy, chained: chained.length,
        root: root?.toString('hex') ?? null, size: chained.length,
        reason: `the checkpoint that pins this log is not a valid C2SP tlog-checkpoint (${e.message})`,
      };
    }
  }

  const checkpoint = cp && {
    origin: cp.origin,
    size: cp.size,
    root: cp.root.toString('hex'),
    signed: !!(note && note.signatures.length),
    signatureValid: note && note.signatures.length ? note.valid : null,
    signers: note ? note.signatures.map((s) => s.name).filter(Boolean) : [],
  };

  const common = {
    entries: entries.length, legacy, chained: chained.length,
    root: root?.toString('hex') ?? null, size: chained.length, checkpoint, broken: null,
  };

  if (!checkpointText) {
    if (!chained.length) {
      return {
        ...common, ok: false, code: 'no-chain',
        reason: `all ${entries.length} entry(ies) predate hash chaining and there is no checkpoint — this journal cannot be verified. Actions recorded from now on will be chained.`,
      };
    }
    return {
      ...common, ok: false, code: 'checkpoint-missing',
      reason: `the checkpoint that pins ${chained.length} entry(ies) is absent, so removal of the most recent records cannot be detected. It belongs beside journal.jsonl.`,
    };
  }
  // cp is guaranteed non-null here: checkpointText is truthy (we returned otherwise),
  // and parseCheckpoint either succeeded or returned early in its catch. This guard
  // is dead code that satisfies the type checker without changing behavior.
  if (!cp) return { ...common, ok: false, code: 'checkpoint-unreadable', reason: 'unreachable' };
  if (cp.size !== chained.length) {
    const removed = cp.size > chained.length;
    const at = Math.min(cp.size, chained.length);
    const e = chained[at] ?? null;
    return {
      ...common, ok: false, code: 'checkpoint-size-mismatch',
      reason: removed
        ? `the checkpoint pins ${cp.size} entries but only ${chained.length} remain — ${cp.size - chained.length} record(s) were REMOVED from the end of the log`
        : `the checkpoint pins ${cp.size} entries but ${chained.length} are present — ${chained.length - cp.size} record(s) were appended without updating the checkpoint`,
      // When the tail was REMOVED there is no entry left to describe, and printing a row of
      // nulls beside the words "first broken entry" reads as a parse failure rather than as a
      // deletion. FOUND IN A LIVE RUN. Say what is missing instead.
      broken: removed
        ? {
          index: legacy + at, line: legacy + at + 1, seq: chained.length, at: null,
          action: null, actor: null, missing: cp.size - chained.length,
          reason: `records ${chained.length}..${cp.size - 1} are GONE — the log ends where the checkpoint says it should continue`,
        }
        : {
          index: legacy + at, line: legacy + at + 1,
          seq: e?.seq ?? null, at: e?.at ?? null, action: e?.action ?? null, actor: e?.actor ?? null,
          reason: 'first entry the checkpoint does not cover',
        },
    };
  }
  if (!cp.root.equals(root ?? Buffer.alloc(0))) {
    return {
      ...common, ok: false, code: 'checkpoint-root-mismatch',
      reason: 'the log re-hashes to a different Merkle root than the checkpoint pins — the journal and its checkpoint disagree about history',
    };
  }
  if (note && note.signatures.length && !note.valid) {
    return {
      ...common, ok: false, code: 'bad-signature',
      reason: `the checkpoint carries a signature that no trusted key verifies: ${note.reason}`,
    };
  }

  return {
    ...common,
    ok: true,
    code: legacy ? 'ok-with-legacy' : 'ok',
    reason: legacy
      ? `${chained.length} entry(ies) verify against the checkpoint; ${legacy} earlier entry(ies) predate hash chaining and are NOT covered`
      : `all ${chained.length} entry(ies) verify against the checkpoint`,
  };
}

/**
 * A self-contained, offline inclusion proof for one entry — the artefact you hand a reviewer who
 * asks "prove THIS record was in the log at that size" without handing over the whole log.
 */
export async function proveEntry(cwd, seq) {
  const { entries } = await readJournalRaw(cwd);
  const head = chainHead(entries);
  if (!Number.isInteger(seq) || seq < 0 || seq >= head.size) {
    throw new RangeError(`no chained entry with seq ${seq} (this log has ${head.size})`);
  }
  const proof = inclusionProof(head.leaves, seq);
  const root = merkleRoot(head.leaves);
  return {
    seq,
    entry: head.chained[seq],
    leaf: head.leaves[seq].toString('hex'),
    size: head.size,
    root: root.toString('hex'),
    proof: proof.map((p) => p.toString('hex')),
    verifies: verifyInclusion(head.leaves[seq], seq, head.size, proof, root),
  };
}
