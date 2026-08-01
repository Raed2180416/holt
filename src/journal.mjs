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
 *      See src/actor.mjs: never a guess.
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
 * failure must be LOUD on stderr. The exception: if the chain head cannot be established under
 * lock, holt REFUSES to append rather than writing an unchained entry. An audit gap that says
 * "a record is missing" is recoverable; a chain that reads as tampering when nobody tampered
 * destroys the trust the whole artefact runs on.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { git } from './git.mjs';
import { resolveActor } from './actor.mjs';
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

async function holtDir(cwd) {
  const common = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd });
  const dir = common.stdout.trim();
  if (!dir) throw new Error('could not locate the repository git dir');
  return path.join(dir, 'holt');
}

export async function journalPaths(cwd) {
  const dir = await holtDir(cwd);
  return {
    dir,
    journal: path.join(dir, 'journal.jsonl'),
    checkpoint: path.join(dir, 'checkpoint'),
    lock: path.join(dir, 'journal.lock'),
  };
}

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
  let raw = null;
  try {
    raw = await fs.readFile(journal, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
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

/** Read the whole journal, oldest first. A corrupt line is surfaced, not swallowed. */
export async function readJournal(cwd) {
  const { entries } = await readJournalRaw(cwd);
  return entries;
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
 * @param {string} cwd    any path inside the repository
 * @param {object} event  the caller's payload (action, id, path, …)
 * @param {object} opts   {env, payload, now} — `payload` is a host hook event, when there is one
 */
export async function appendEvent(cwd, event, { env = process.env, payload = null, now = null } = {}) {
  try {
    const { dir, journal, checkpoint, lock } = await journalPaths(cwd);
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
        actor: resolveActor({ env, payload }),
        ...event,
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
 * @returns {{ok:boolean, code:string, broken:object|null, ...}}
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

  let cp = null;
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
  if (cp.size !== chained.length) {
    const at = Math.min(cp.size, chained.length);
    return {
      ...common, ok: false, code: 'checkpoint-size-mismatch',
      reason: cp.size > chained.length
        ? `the checkpoint pins ${cp.size} entries but only ${chained.length} remain — ${cp.size - chained.length} record(s) were REMOVED from the end of the log`
        : `the checkpoint pins ${cp.size} entries but ${chained.length} are present — ${chained.length - cp.size} record(s) were appended without updating the checkpoint`,
      broken: {
        index: legacy + at, line: legacy + at + 1,
        seq: cp.size, at: chained[at]?.at ?? null, action: chained[at]?.action ?? null,
        actor: chained[at]?.actor ?? null,
        reason: 'first entry outside what the checkpoint pins',
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
