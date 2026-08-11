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
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { createHash, createPrivateKey, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkEntitlement } from '../license.mjs';
import { verifyJournal, readJournalRaw, journalPaths, journalOrigin } from '../journal.mjs';
import { exportJournal, SIEM_FORMATS } from '../siem.mjs';
import { formatCheckpoint, signNote, merkleRoot, entryLeaf } from '../attest.mjs';
import { readStableRegularFile } from '../stable-file.mjs';

const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const NONBLOCK = fsConstants.O_NONBLOCK ?? 0;
const MODULE_FILE = fileURLToPath(import.meta.url);
const ANCHORED_WRITER_FLAG = '--holt-anchored-audit-writer-v1';
const SAME_OBJECT = (left, right) => left && right
  && String(left.dev) === String(right.dev)
  && String(left.ino) === String(right.ino);

function sinkRefuse(code, message) {
  throw Object.assign(new Error(`audit sink REFUSED: ${message}`), { code });
}

async function observedSinkPathKind(target) {
  let handle;
  try {
    // Open first. The descriptor is the authority; the later lstat only proves the name still
    // points at that descriptor. This avoids turning a check-then-open race into a write target.
    handle = await fs.open(target, fsConstants.O_RDONLY | NOFOLLOW | NONBLOCK);
    const opened = await handle.stat();
    const named = await fs.lstat(target);
    if (named.isSymbolicLink() || !SAME_OBJECT(opened, named)) {
      sinkRefuse('EDESTINATION', `destination changed while it was being resolved: ${target}`);
    }
    if (opened.isDirectory()) return 'directory';
    if (opened.isFile() || opened.isFIFO()) return 'stream';
    sinkRefuse('EDESTINATION', `destination must be a regular file, FIFO, or directory: ${target}`);
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing';
    // Node cannot open directories as file descriptors on Windows. Keep the fallback narrow and
    // still reject reparse-point/symlink names before using the directory only as a parent.
    if (process.platform === 'win32' && ['EISDIR', 'EPERM', 'EACCES'].includes(error?.code)) {
      const named = await fs.lstat(target);
      if (named.isDirectory() && !named.isSymbolicLink()) return 'directory';
    }
    if (error?.code === 'ELOOP') sinkRefuse('EDESTINATION', `destination must not be a symlink: ${target}`);
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function directoryIdentity(directory) {
  const named = await fs.lstat(directory);
  if (!named.isDirectory() || named.isSymbolicLink()) {
    sinkRefuse('EDESTINATION', `destination parent is not one real directory: ${directory}`);
  }
  return {
    path: directory,
    canonical: await fs.realpath(directory),
    dev: String(named.dev),
    ino: String(named.ino),
  };
}

async function sameDirectoryIdentity(expected) {
  try {
    const current = await directoryIdentity(expected.path);
    return current.canonical === expected.canonical
      && current.dev === expected.dev && current.ino === expected.ino;
  } catch {
    return false;
  }
}

function relativeLeaf(value) {
  const leaf = String(value);
  if (!leaf || leaf === '.' || leaf === '..' || leaf.includes('/') || leaf.includes('\\')
    || leaf.includes('\0') || path.basename(leaf) !== leaf) {
    sinkRefuse('EDESTINATION', `anchored writer received an invalid leaf name: ${JSON.stringify(leaf)}`);
  }
  return leaf;
}

async function appendSinkBytesRelative(leafInput, body) {
  const leaf = relativeLeaf(leafInput);
  let handle;
  try {
    handle = await fs.open(
      leaf,
      fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | NOFOLLOW | NONBLOCK,
      0o600,
    );
    const opened = await handle.stat();
    const named = await fs.lstat(leaf);
    if (named.isSymbolicLink() || !SAME_OBJECT(opened, named)
      || !(opened.isFile() || opened.isFIFO())) {
      sinkRefuse('EDESTINATION', `destination is not one stable regular file or FIFO: ${leaf}`);
    }
    if (opened.isFile() && opened.nlink !== 1) {
      sinkRefuse('EDESTINATION', `destination has ${opened.nlink} hard links: ${leaf}`);
    }
    await handle.writeFile(body);
    if (opened.isFile()) await handle.sync();
    const after = await handle.stat();
    const namedAfter = await fs.lstat(leaf);
    if (namedAfter.isSymbolicLink() || !SAME_OBJECT(opened, after) || !SAME_OBJECT(after, namedAfter)) {
      sinkRefuse('EDESTINATION', `destination changed while records were being written: ${leaf}`);
    }
  } catch (error) {
    if (error?.code === 'ELOOP') sinkRefuse('EDESTINATION', `destination must not be a symlink: ${leaf}`);
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function atomicReplaceFileRelative(leafInput, bytes) {
  const leaf = relativeLeaf(leafInput);
  const temporary = `.${leaf}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW,
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, leaf);
    const observed = await readStableRegularFile(leaf, {
      maxBytes: Buffer.byteLength(bytes), requireSingleLink: true, requireOwner: true,
    });
    if (!observed.ok || !observed.bytes.equals(Buffer.from(bytes))) {
      sinkRefuse('EDESTINATION', `published state did not verify at ${leaf}`);
    }
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function anchoredWriterMain(encodedIdentity) {
  const expected = JSON.parse(Buffer.from(String(encodedIdentity), 'base64url').toString('utf8'));
  const observed = await directoryIdentity('.');
  if (observed.canonical !== expected.canonical
    || observed.dev !== expected.dev || observed.ino !== expected.ino) {
    sinkRefuse('EDESTINATION', 'destination parent changed before the anchored writer started');
  }
  // The process cwd is now the directory handle: if the pathname is renamed or replaced after
  // READY, every relative operation below remains attached to this exact directory inode.
  process.stdout.write('READY\n');
  process.stdin.setEncoding('utf8');
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const request = JSON.parse(raw);
  if (!request || !Array.isArray(request.operations)) {
    sinkRefuse('EDESTINATION', 'anchored writer request is malformed');
  }
  for (const operation of request.operations) {
    const bytes = Buffer.from(String(operation?.bytesB64 ?? ''), 'base64');
    if (operation?.kind === 'append') await appendSinkBytesRelative(operation.leaf, bytes);
    else if (operation?.kind === 'replace') await atomicReplaceFileRelative(operation.leaf, bytes);
    else sinkRefuse('EDESTINATION', `anchored writer operation is unsupported: ${operation?.kind}`);
  }
  process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
}

/**
 * @param {string} directory
 * @param {Array<{kind:string,leaf:string,bytesB64:string}>} operations
 * @param {{onReady?: ((detail:any)=>any)|null, timeoutMs?:number}} [options]
 */
async function runAnchoredWriter(directory, operations, { onReady = null, timeoutMs = 30_000 } = {}) {
  const expected = await directoryIdentity(directory);
  const encoded = Buffer.from(JSON.stringify(expected), 'utf8').toString('base64url');
  const child = spawn(process.execPath, [MODULE_FILE, ANCHORED_WRITER_FLAG, encoded], {
    cwd: directory,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HOLT_AUDIT_ANCHORED_WRITER: '1' },
  });
  let stdout = '';
  let stderr = '';
  let ready = false;
  let readyResolve;
  let readyReject;
  const readyPromise = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (!ready && stdout.startsWith('READY\n')) {
      ready = true;
      readyResolve();
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('error', (error) => readyReject(error));
  const exitPromise = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      if (!ready) readyReject(new Error(stderr || `anchored writer exited before ready (${code ?? signal})`));
      resolve({ code, signal });
    });
  });
  const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
  timer.unref?.();
  try {
    await readyPromise;
    if (onReady) await onReady({ directory, identity: expected });
    child.stdin.end(JSON.stringify({ operations }));
    const exited = await exitPromise;
    if (exited.code !== 0) {
      sinkRefuse('EDESTINATION', `anchored writer failed: ${stderr.trim() || exited.signal || exited.code}`);
    }
    if (!stdout.includes('{"ok":true}')) {
      sinkRefuse('EDESTINATION', 'anchored writer returned no completion attestation');
    }
    if (!(await sameDirectoryIdentity(expected))) {
      sinkRefuse('EDESTINATION', `destination parent directory changed during the write: ${directory}`);
    }
  } catch (error) {
    child.stdin.destroy();
    child.kill('SIGTERM');
    await exitPromise.catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

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
  const file = await cursorPath(cwd, destination);
  const observed = await readStableRegularFile(file, { maxBytes: 64 * 1024, requireSingleLink: true });
  if (!observed.ok) {
    if (observed.code === 'ENOENT') return null;
    // A cursor that exists but cannot be read is NOT "start from zero": that would silently
    // re-ship the entire history into a SIEM with a retention budget. Refuse and say why.
    throw new Error(`sink cursor is unreadable (${observed.reason}) — refusing to guess how much has already been exported`);
  }
  try {
    return JSON.parse(observed.bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`sink cursor is unreadable (${error.message}) — refusing to guess how much has already been exported`);
  }
}

/**
 * Load an Ed25519 signing key from a PEM path, or return null. Never throws on absence.
 * @param {{signingKey?: string|null, signingKeyPath?: string|null, env?: Record<string, string|undefined>}} [opts]
 */
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
 * @param {{to?: string|null, format?: string, dryRun?: boolean, env?: Record<string, string|undefined>, now?: number|null,
 *          signerName?: string|null, signingKey?: string|null, signingKeyPath?: string|null,
 *          publicKeyB64?: string|null, onDestinationWriterReady?: ((detail:any)=>any)|null}} [opts]
 * @returns {Promise<any>}
 */
export async function sinkExport(cwd, {
  to = null, format = 'ocsf', dryRun = false, env = process.env, now = null,
  signerName = null, signingKey = null, signingKeyPath = null, publicKeyB64 = null,
  onDestinationWriterReady = null,
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
    const err = Object.assign(new Error(
      `audit sink REFUSED: this journal does not verify (${verification.code}) — ${verification.reason}. `
      + 'Nothing was exported: shipping records from a log that may have been rewritten launders the tampering.'),
      { code: 'EINTEGRITY', verification });
    throw err;
  }

  const { entries } = await readJournalRaw(cwd);
  const chained = entries.filter((e) => e && e.corrupt === undefined && typeof e.seq === 'number');
  const leaves = chained.map((e) => entryLeaf(e));

  // 2. DETECT A REWRITE BEHIND THE CURSOR.
  const cursor = await readCursor(cwd, to);
  if (cursor) {
    if (cursor.seq > chained.length) {
      const err = Object.assign(new Error(
        `audit sink REFUSED: the cursor has already exported ${cursor.seq} record(s) but the journal now holds ${chained.length} — the log SHRANK behind the sink.`),
        { code: 'EREWRITE' });
      throw err;
    }
    if (cursor.seq > 0) {
      const seen = leaves[cursor.seq - 1]?.toString('hex') ?? null;
      if (seen !== cursor.leaf) {
        const err = Object.assign(new Error(
          `audit sink REFUSED: record ${cursor.seq - 1}, already exported, no longer hashes to what was exported — history was REWRITTEN behind the sink.`),
          { code: 'EREWRITE' });
        throw err;
      }
    }
  }

  const fromSeq = cursor?.seq ?? 0;
  const pending = chained.slice(fromSeq);
  const repo = path.basename(path.dirname(path.dirname((await journalPaths(cwd)).dir)));

  // 3. Where the bytes land. A directory gets one file per UTC day, which is what a log shipper
  //    and a retention policy both expect; a file is appended to.
  const destinationKind = await observedSinkPathKind(to);
  const destination = destinationKind === 'directory'
    ? path.join(to, `holt-audit-${new Date(now ?? Date.now()).toISOString().slice(0, 10)}.ndjson`)
    : to;

  const body = pending.length
    ? exportJournal(pending, fmt, { verification, repo, ndjson: true })
    : '';

  // 4. The batch checkpoint, signed on THIS host.
  const root = merkleRoot(leaves);
  const checkpointBody = formatCheckpoint({
    origin: verification.checkpoint?.origin ?? journalOrigin(repo),
    size: chained.length,
    root,
  });
  let checkpointText = checkpointBody;
  /** @type {string|null} */
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
    const destinationDirectory = path.dirname(destination);
    const destinationOperations = [];
    if (body) {
      destinationOperations.push({
        kind: 'append', leaf: path.basename(destination), bytesB64: Buffer.from(body).toString('base64'),
      });
    }
    destinationOperations.push({
      kind: 'replace', leaf: path.basename(`${destination}.checkpoint`),
      bytesB64: Buffer.from(checkpointText, 'utf8').toString('base64'),
    });
    await runAnchoredWriter(destinationDirectory, destinationOperations, {
      onReady: onDestinationWriterReady,
    });
    const cp = await cursorPath(cwd, to);
    await fs.mkdir(path.dirname(cp), { recursive: true });
    await runAnchoredWriter(path.dirname(cp), [{
      kind: 'replace', leaf: path.basename(cp),
      bytesB64: Buffer.from(`${JSON.stringify(nextCursor, null, 2)}\n`, 'utf8').toString('base64'),
    }]);
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

if (process.argv[2] === ANCHORED_WRITER_FLAG) {
  anchoredWriterMain(process.argv[3]).catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
