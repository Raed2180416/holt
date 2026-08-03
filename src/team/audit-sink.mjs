// SPDX-License-Identifier: LicenseRef-holt-Commercial
// Commercial license — see src/team/LICENSE. NOT covered by the repository FSL-1.1-MIT grant.
/**
 * holt Team — the audit sink.
 *
 * WHERE THE FREE/PAID LINE IS, AND WHY IT IS DEFENSIBLE. One repository's journal, its
 * verification, and a one-shot export of it in any SIEM format are FREE: that is the user's own
 * data, `holt journal --json` already prints all of it, and a gate there would be a gate in name
 * only. What a TEAM buys is the thing that only exists once you have many repos and a retention
 * obligation — CONTINUOUS, cursor-tracked delivery into the SIEM they already run, and
 * fleet-level aggregation across every repo at once. A solo developer with one repo gets no
 * value from either and is charged for neither.
 *
 * OFFLINE BY CONSTRUCTION, WHICH IS ALSO THE RIGHT DESIGN. This sink writes newline-delimited
 * records to a file or FIFO. It does not POST to an HTTP collector, and that is not a compromise
 * forced by holt's no-network promise — it is how every serious log pipeline already works.
 * Filebeat, Vector, Fluent Bit, Splunk's Universal Forwarder and rsyslog all tail files, handle
 * backpressure, retry, and TLS far better than a bespoke webhook ever would. holt's job is to
 * produce a correct, complete, ordered stream; shipping it is a solved problem and REBUILDING
 * THAT WOULD BE THE MISTAKE.
 *
 * THE THREE PROPERTIES A COMPLIANCE PIPELINE ACTUALLY NEEDS, each enforced here:
 *
 *   1. NEVER EXPORT AN UNVERIFIED LOG. The chain is verified before a single byte is emitted,
 *      and a broken chain REFUSES. Feeding a SIEM records from a log that may have been rewritten
 *      launders the tampering: downstream it is indistinguishable from a clean one.
 *   2. DETECT A REWRITE OF ALREADY-EXPORTED HISTORY. The cursor stores the leaf hash of the last
 *      record it shipped. If that record's hash no longer matches the log, history was edited
 *      BEHIND the sink — invisible to a naive tail-the-file exporter, and exactly the attack a
 *      retention obligation exists to catch.
 *   3. PROVENANCE THE WRITER CANNOT FORGE. Each batch's checkpoint is signed, on the aggregation
 *      host, with a key that developer machines do not hold — the one place in this design where
 *      a signature means something. A checkpoint signed on the same laptop that writes the log
 *      would prove nothing, which is why holt does not pretend to sign there.
 *
 * DELIVERY SEMANTICS, STATED PLAINLY: exactly-once in normal operation; at-least-once if the
 * process dies between writing records and committing the cursor. Every record carries the
 * RFC 6962 leaf hash as its id (`metadata.uid` in OCSF, `event.id` in ECS, `cs4` in CEF), so a
 * SIEM can de-duplicate on it. Claiming exactly-once across a crash without a distributed
 * transaction would be a lie.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, createPrivateKey } from 'node:crypto';
import { checkEntitlement } from '../license.mjs';
import { verifyJournal, readJournalRaw, journalPaths } from '../journal.mjs';
import { exportJournal, SIEM_FORMATS } from '../siem.mjs';
import { formatCheckpoint, signNote, merkleRoot, entryLeaf } from '../attest.mjs';

export class EntitlementError extends Error {
  constructor(entitlement) {
    super(entitlement.reason);
    this.name = 'EntitlementError';
    this.entitlement = entitlement;
  }
}

/** A sink is identified by its destination, so two destinations keep independent cursors. */
export function sinkId(destination) {
  return createHash('sha256').update(path.resolve(destination)).digest('hex').slice(0, 16);
}

export async function cursorPath(cwd, destination) {
  const { dir } = await journalPaths(cwd);
  return path.join(dir, 'sink', `${sinkId(destination)}.cursor`);
}

export async function readCursor(cwd, destination) {
  try {
    return JSON.parse(await fs.readFile(await cursorPath(cwd, destination), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    // A cursor that exists but cannot be read is NOT "start from zero": that would silently
    // re-ship the entire history into a SIEM with a retention budget. Refuse and say why.
    throw new Error(`sink cursor is unreadable (${e.message}) — refusing to guess how much has already been exported`);
  }
}

/** Load an Ed25519 signing key from a PEM path, or return null. Never throws on absence. */
async function loadSigningKey({ signingKey = null, signingKeyPath = null, env = process.env } = {}) {
  if (signingKey) return createPrivateKey(signingKey);
  const p = signingKeyPath ?? env.HOLT_AUDIT_SIGNING_KEY ?? null;
  if (!p) return null;
  const pem = await fs.readFile(p, 'utf8');
  return createPrivateKey(pem);
}

/**
 * Export everything the sink has not shipped yet.
 *
 * @param {string} cwd                any path inside the repository
 * @param {object} opts
 * @param {string} opts.to            destination file (appended), or a directory (daily files)
 * @param {string} opts.format        ocsf | ecs | cef | json | csv   (default ocsf)
 * @param {boolean} opts.dryRun       compute everything, write nothing
 * @param {string} opts.signerName    note signer name for the batch checkpoint
 * @param {string} opts.publicKeyB64  licence public key override. An ARGUMENT ONLY, never an env
 *   var — an env override would be a forgery hole (anyone could point holt at a key they mint
 *   licences with). A caller who can pass an argument can already edit this file, so it grants
 *   nothing new; it exists so the suite can drive the paid path with a throwaway keypair. Same
 *   rule, same reasoning, as src/license.mjs.
 * @returns {Promise<object>} {emitted, fromSeq, toSeq, destination, cursor, checkpoint, verification}
 */
export async function sinkExport(cwd, {
  to = null, format = 'ocsf', dryRun = false, env = process.env, now = null,
  signerName = null, signingKey = null, signingKeyPath = null, publicKeyB64 = null,
} = {}) {
  const ent = checkEntitlement('audit-sink', { env, publicKeyB64 });
  if (!ent.entitled) throw new EntitlementError(ent);

  if (!to) throw new Error('audit sink: a destination is required (--sink <file|dir>)');
  const fmt = String(format).toLowerCase();
  if (!SIEM_FORMATS.includes(fmt) || fmt === 'intoto') {
    throw new Error(`audit sink: unsupported format '${format}' (${SIEM_FORMATS.filter((f) => f !== 'intoto').join(' | ')})`);
  }

  // 1. VERIFY BEFORE EMITTING. A broken chain stops the sink dead.
  const verification = await verifyJournal(cwd);
  if (!verification.ok) {
    const err = new Error(
      `audit sink REFUSED: this journal does not verify (${verification.code}) — ${verification.reason}. `
      + 'Nothing was exported: shipping records from a log that may have been rewritten launders the tampering.');
    err.code = 'EINTEGRITY';
    err.verification = verification;
    throw err;
  }

  const { entries } = await readJournalRaw(cwd);
  const chained = entries.filter((e) => e && e.corrupt === undefined && typeof e.seq === 'number');
  const leaves = chained.map((e) => entryLeaf(e));

  // 2. DETECT A REWRITE BEHIND THE CURSOR.
  const cursor = await readCursor(cwd, to);
  if (cursor) {
    if (cursor.seq > chained.length) {
      const err = new Error(
        `audit sink REFUSED: the cursor has already exported ${cursor.seq} record(s) but the journal now holds ${chained.length} — the log SHRANK behind the sink.`);
      err.code = 'EREWRITE';
      throw err;
    }
    if (cursor.seq > 0) {
      const seen = leaves[cursor.seq - 1]?.toString('hex') ?? null;
      if (seen !== cursor.leaf) {
        const err = new Error(
          `audit sink REFUSED: record ${cursor.seq - 1}, already exported, no longer hashes to what was exported — history was REWRITTEN behind the sink.`);
        err.code = 'EREWRITE';
        throw err;
      }
    }
  }

  const fromSeq = cursor?.seq ?? 0;
  const pending = chained.slice(fromSeq);
  const repo = path.basename(path.dirname(path.dirname((await journalPaths(cwd)).dir)));

  // 3. Where the bytes land. A directory gets one file per UTC day, which is what a log shipper
  //    and a retention policy both expect; a file is appended to.
  const stat = await fs.stat(to).catch(() => null);
  const destination = stat?.isDirectory()
    ? path.join(to, `holt-audit-${new Date(now ?? Date.now()).toISOString().slice(0, 10)}.ndjson`)
    : to;

  const body = pending.length
    ? exportJournal(pending, fmt, { verification, repo, ndjson: true })
    : '';

  // 4. The batch checkpoint, signed on THIS host.
  const root = merkleRoot(leaves);
  const checkpointBody = formatCheckpoint({
    origin: verification.checkpoint?.origin ?? `holt.dev/journal/${repo}`,
    size: chained.length,
    root,
  });
  let checkpointText = checkpointBody;
  let signedBy = null;
  const key = await loadSigningKey({ signingKey, signingKeyPath, env });
  if (key) {
    const name = signerName ?? env.HOLT_AUDIT_SIGNER ?? 'holt-audit';
    checkpointText = signNote(checkpointBody, { name, privateKey: key });
    signedBy = name;
  }

  const nextCursor = {
    seq: chained.length,
    leaf: leaves.length ? leaves[leaves.length - 1].toString('hex') : null,
    root: root.toString('hex'),
    size: chained.length,
    at: new Date(now ?? Date.now()).toISOString(),
    format: fmt,
    destination,
  };

  if (!dryRun) {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    // Records first, cursor last. The other order would mark records shipped that never landed —
    // a silent audit gap, which is the one failure a retention obligation cannot tolerate.
    if (body) await fs.appendFile(destination, body, 'utf8');
    await fs.writeFile(`${destination}.checkpoint`, checkpointText, 'utf8');
    const cp = await cursorPath(cwd, to);
    await fs.mkdir(path.dirname(cp), { recursive: true });
    await fs.writeFile(cp, `${JSON.stringify(nextCursor, null, 2)}\n`, 'utf8');
  }

  return {
    ok: true,
    emitted: pending.length,
    fromSeq,
    toSeq: chained.length,
    destination,
    checkpointFile: `${destination}.checkpoint`,
    signedBy,
    signed: !!key,
    format: fmt,
    dryRun,
    cursor: nextCursor,
    verification: { ok: verification.ok, code: verification.code, root: verification.root, size: verification.size },
    note: pending.length
      ? `${pending.length} record(s) written as ${fmt.toUpperCase()}; point your log shipper at ${destination}`
      : 'nothing new since the last run — the sink is idempotent',
    signingNote: key
      ? `batch checkpoint signed as '${signedBy}' — verify it with the matching public key`
      : 'batch checkpoint is UNSIGNED. Set HOLT_AUDIT_SIGNING_KEY on the aggregation host to a key '
        + 'the developer machines do not hold; without it the checkpoint proves integrity, not origin.',
  };
}
