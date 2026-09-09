// SPDX-License-Identifier: FSL-1.1-MIT
/** Base-bound integration with a recoverable index and an independently supervised writer. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { git, repoRoot, resolveRef, withGitLandingRefTransaction } from './git.mjs';
import { ownershipTarget, inspectWorktreeOwnership, openWorktreeSession, updateWorktreeSession, withLeaseLock } from './ownership.mjs';
import { verifyCheckpointValidation } from './checkpoint-validation.mjs';
import { runWorkspaceCommand } from './session-runner.mjs';
import { recoverCompletedRunners, verifyRunnerCompletion } from './session-recovery.mjs';
import { readStableRegularFile, writePrivateFileAtomic, ensurePrivateDirectory, syncPrivateDirectory } from './stable-file.mjs';
import { sessionPath, authenticSession } from './sessions.mjs';
import { canonicalPath, samePathAsync, relativeLinkAwareAsync, foldCase } from './paths.mjs';
import { indexFlagDelta } from './scan.mjs';

const ID = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f-]{36}$/;
const sha = (value) => createHash('sha256').update(value).digest('hex');
const worker = fileURLToPath(new URL('./checkpoint-landing-worker.mjs', import.meta.url));
const rootAt = (target, id) => path.join(target.commonDir, 'holt-checkpoints-v1', 'landings', id);
const save = (root, name, value) => writePrivateFileAtomic(path.join(root, `${name}.json`), Buffer.from(JSON.stringify(value) + '\n'));
const overlap = (a, b) => {
  a = foldCase(a); b = foldCase(b);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
};

async function readJson(file, maxBytes = 1024 * 1024) {
  const read = await readStableRegularFile(file, { maxBytes, requireOwner: true, requireSingleLink: true });
  if (!read.ok) return null;
  try { return JSON.parse(read.bytes.toString('utf8')); } catch { return null; }
}

/** Capture only paths the candidate changes, including raw bytes Git's filters do not preserve. */
async function pathSnapshot(cwd, paths) {
  const entries = [];
  let bytes = 0;
  if (paths.length > 10000 || paths.some((item) => !sessionPath(item))) return { ok: false, code: 'landing-path-limit' };
  for (const relative of paths) {
    const file = path.join(cwd, relative);
    if (foldCase(await relativeLinkAwareAsync(cwd, file)) !== foldCase(relative)) return { ok: false, code: 'landing-path-boundary', path: relative };
    let stat;
    try { stat = await fs.lstat(file); }
    catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error?.code)) { entries.push({ path: relative, kind: 'absent' }); continue; }
      return { ok: false, code: 'landing-path-unavailable', path: relative };
    }
    if (stat.isDirectory()) { entries.push({ path: relative, kind: 'directory' }); continue; }
    if (stat.isSymbolicLink()) {
      const link = await fs.readlink(file, { encoding: 'buffer' });
      const after = await fs.lstat(file);
      if (stat.ino !== after.ino || stat.ctimeMs !== after.ctimeMs) return { ok: false, code: 'landing-path-changed', path: relative };
      bytes += link.length;
      entries.push({ path: relative, kind: 'link', data: link.toString('base64') });
    } else {
      const read = await readStableRegularFile(file, { maxBytes: 64 * 1024 * 1024, requireSingleLink: true });
      if (!read.ok) return { ok: false, code: 'landing-path-unavailable', path: relative };
      bytes += read.bytes.length;
      entries.push({ path: relative, kind: 'file', mode: read.stat.mode & 0o777, data: read.bytes.toString('base64') });
    }
    if (bytes > 64 * 1024 * 1024) return { ok: false, code: 'landing-byte-limit' };
  }
  return { ok: true, entries, digest: sha(JSON.stringify(entries)) };
}

async function changedPaths(cwd, expected, candidate) {
  const diff = await git(['diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', expected, candidate, '--'], { cwd });
  return diff.code === 0 ? [...new Set(diff.stdout.split('\0').filter(Boolean))].sort() : null;
}

async function checkLocalChanges(cwd, expected, paths) {
  const [changes, untracked, ignored, flags] = await Promise.all([
    git(['diff', '--name-only', '-z', expected, '--'], { cwd }),
    git(['ls-files', '--others', '--exclude-standard', '-z'], { cwd }),
    git(['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], { cwd }),
    indexFlagDelta(cwd),
  ]);
  if ([changes, untracked, ignored].some((item) => item.code !== 0) || flags.how === 'index-flags-failed') {
    return { ok: false, code: 'landing-local-state-unavailable' };
  }
  const dirty = [...changes.stdout.split('\0'), ...untracked.stdout.split('\0'), ...ignored.stdout.split('\0'), ...flags.atRisk, ...flags.unknown].filter(Boolean);
  const conflicts = dirty.filter((item) => paths.some((affected) => overlap(item, affected)));
  return conflicts.length ? { ok: false, code: 'landing-overlaps-local-work', paths: [...new Set(conflicts)].slice(0, 100) } : { ok: true };
}

async function closeLandingSession(cwd, target, record) {
  if (!record.sessionId) return { ok: true };
  const receipt = await readJson(path.join(target.root, 'credentials', `${record.sessionId}-${record.generation}.json`));
  for (let attempt = 0; attempt < 12; attempt++) {
    const current = await inspectWorktreeOwnership(cwd);
    const session = current._record?.managed?.sessions.find((item) => item.id === record.sessionId);
    if (!session) return current.state === 'unclaimed' || current._record ? { ok: true } : { ok: false, code: 'landing-session-unavailable' };
    if (receipt?.worktreeKey !== target.key || !authenticSession(session, receipt.credential)
      || session.kind !== 'job' || session.buffers.length || session.pending.some((item) => item.id !== record.id || item.kind !== 'checkpoint-landing')) {
      return { ok: false, code: 'landing-session-changed' };
    }
    const event = session.pending.length ? { type: 'operation-finish', operationId: record.id }
      : session.phase === 'active' ? { type: 'drain' } : { type: 'finish' };
    const result = await updateWorktreeSession(cwd, receipt.credential, { ...event, sequence: session.sequence + 1 });
    if (result.ok && result.closed) return { ok: true };
    if (!result.ok && !['busy', 'sequence-mismatch'].includes(result.code)) return result;
  }
  return { ok: false, code: 'landing-session-busy' };
}

async function readLanding(cwd, id) {
  if (!ID.test(id)) return { ok: false, code: 'invalid-landing-id' };
  const target = await ownershipTarget(cwd);
  if (!target.ok) return { ok: false, code: 'workspace-unavailable' };
  const root = rootAt(target, id);
  const record = await readJson(path.join(root, 'record.json'));
  if (!record || record.version !== 1 || record.id !== id || record.worktreeKey !== target.key
    || typeof record.cwd !== 'string' || !await samePathAsync(record.cwd, cwd) || !ID.test(record.validationId) || typeof record.ref !== 'string'
    || !record.ref.startsWith('refs/heads/') || (record.sessionId && !UUID.test(record.sessionId))) {
    return { ok: false, code: 'landing-record-unavailable' };
  }
  const validation = await verifyCheckpointValidation(cwd, record.validationId, { allowLandedCandidate: true });
  if (!validation.ok || !validation.validation) return validation;
  if (record.expected !== validation.validation.base.expected || record.candidate !== validation.validation.candidate) return { ok: false, code: 'landing-candidate-changed' };
  return { ok: true, target, root, record, validation: validation.validation };
}

/** Called only in the bundled, supervised worker; no repository program is evaluated here. */
export async function performCheckpointLanding(cwd, id, { recovery = false } = {}) {
  const read = await readLanding(cwd, id);
  if (!read.ok || !('record' in read) || !read.record) return read;
  const { target, root, record } = read;
  const currentRef = await git(['symbolic-ref', '-q', 'HEAD'], { cwd });
  if (currentRef.stdout.trim() !== record.ref) return { ok: false, code: 'landing-checkout-changed', landingId: id };
  const currentHead = await resolveRef(cwd, 'HEAD');
  if (currentHead !== record.expected && !(recovery && currentHead === record.candidate)) return { ok: false, code: 'landing-base-changed', landingId: id };
  if (!recovery) {
    const opened = await openWorktreeSession(cwd, { kind: 'job', label: `landing ${id.slice(0, 12)}`, host: 'checkpoint-landing' });
    if (!opened.ok || !opened.credential) return { ok: false, code: opened.code, landingId: id };
    record.sessionId = opened.credential.id;
    record.generation = opened.credential.generation;
    await save(root, 'record', record);
    const started = await updateWorktreeSession(cwd, opened.credential, { type: 'operation-start', sequence: 1, operationId: id, kind: 'checkpoint-landing', paths: [] });
    if (!started.ok) return { ok: false, code: started.code, landingId: id };
  }
  let mutationStarted = !!record.indexSha256;
  let succeeded = false;
  let indexHandle;
  let ownIndexLock = false;
  const ownedLockIdentity = { dev: -1, ino: -1 };
  const indexFile = path.join(target.gitDir, 'index');
  const indexLock = `${indexFile}.lock`;
  try {
    const guarded = await withLeaseLock(target, async () => {
      const ownership = await inspectWorktreeOwnership(cwd);
      const sessions = ownership.sessions ?? [];
      const allowed = [record.sessionId, record.runnerId];
      if (!ownership._record || ownership.manual || !sessions.some((item) => item.id === record.sessionId)
        || sessions.some((item) => !allowed.includes(item.id))) return { ok: false, code: 'workspace-in-use' };
      const transaction = await withGitLandingRefTransaction(cwd, {
        ref: record.ref, expected: currentHead, candidate: record.candidate,
      }, async (isPrepared) => {
        if (recovery) {
          if (!['checkout-complete', 'index-published', 'landed'].includes(record.phase)) return { ok: false, code: 'landing-checkout-needs-review' };
          const paths = await changedPaths(cwd, record.expected, record.candidate);
          if (!paths) return { ok: false, code: 'landing-diff-unavailable' };
          const after = await pathSnapshot(cwd, paths);
          if (!after.ok || after.digest !== record.afterDigest) return { ok: false, code: 'landing-workspace-changed' };
          const index = await readStableRegularFile(indexFile, { maxBytes: 64 * 1024 * 1024, requireSingleLink: true });
          if (!index.ok) return { ok: false, code: 'landing-index-unavailable' };
          if (sha(index.bytes) !== record.nextIndexSha256) {
            if (sha(index.bytes) !== record.indexSha256) return { ok: false, code: 'landing-index-changed' };
            const locked = await readStableRegularFile(indexLock, { maxBytes: 64 * 1024 * 1024, requireOwner: true, requireSingleLink: true });
            if (!locked.ok || String(locked.stat.dev) !== record.lockDev || String(locked.stat.ino) !== record.lockIno
              || sha(locked.bytes) !== record.nextIndexSha256) return { ok: false, code: 'landing-index-lock-changed' };
            if (!isPrepared()) return { ok: false, code: 'landing-reference-interrupted' };
            await fs.rename(indexLock, indexFile);
            await syncPrivateDirectory(target.gitDir);
          }
          return { ok: true };
        }
        const paths = await changedPaths(cwd, record.expected, record.candidate);
        if (!paths) return { ok: false, code: 'landing-diff-unavailable' };
        const local = await checkLocalChanges(cwd, record.expected, paths);
        if (!local.ok) return local;
        const original = await readStableRegularFile(indexFile, { maxBytes: 64 * 1024 * 1024, requireSingleLink: true });
        if (!original.ok) return { ok: false, code: 'landing-index-unavailable' };
        try { indexHandle = await fs.open(indexLock, 'wx', 0o600); }
        catch { return { ok: false, code: 'landing-index-busy' }; }
        ownIndexLock = true;
        const lockStat = await indexHandle.stat();
        Object.assign(ownedLockIdentity, { dev: lockStat.dev, ino: lockStat.ino });
        await indexHandle.writeFile(original.bytes);
        await indexHandle.sync();
        await syncPrivateDirectory(target.gitDir);
        const current = await readStableRegularFile(indexFile, { maxBytes: 64 * 1024 * 1024, requireSingleLink: true });
        if (!current.ok || sha(current.bytes) !== sha(original.bytes)) return { ok: false, code: 'landing-index-changed' };
        const tempIndex = path.join(root, 'working.index');
        await writePrivateFileAtomic(path.join(root, 'original.index'), original.bytes);
        await writePrivateFileAtomic(tempIndex, original.bytes);
        const env = { GIT_INDEX_FILE: tempIndex };
        const dryRun = await git(['read-tree', '-n', '-m', '-u', record.expected, record.candidate], { cwd, env, allowMutation: true });
        if (dryRun.code !== 0) return { ok: false, code: 'landing-checkout-refused', reason: dryRun.stderr.trim() };
        const before = await pathSnapshot(cwd, paths);
        if (!before.ok) return before;
        await save(root, 'before', before);
        Object.assign(record, { phase: 'checkout-started', indexSha256: sha(original.bytes), beforeDigest: before.digest,
          lockDev: String(lockStat.dev), lockIno: String(lockStat.ino) });
        await save(root, 'record', record);
        if (!isPrepared()) return { ok: false, code: 'landing-reference-interrupted' };
        mutationStarted = true;
        const checked = await git(['read-tree', '-m', '-u', record.expected, record.candidate], { cwd, env, allowMutation: true, timeout: 180000 });
        if (checked.code !== 0) return { ok: false, code: 'landing-checkout-incomplete', reason: checked.stderr.trim() };
        const after = await pathSnapshot(cwd, paths);
        const nextIndex = await readStableRegularFile(tempIndex, { maxBytes: 64 * 1024 * 1024, requireSingleLink: true });
        if (!after.ok || !nextIndex.ok) return { ok: false, code: 'landing-checkout-unavailable' };
        await save(root, 'after', after);
        await writePrivateFileAtomic(path.join(root, 'next.index'), nextIndex.bytes);
        // This descriptor is our exclusive Git index lock; its original bytes were captured
        // before checkout. A crash leaves both old/new indexes independently recoverable.
        await indexHandle.truncate(0);
        await indexHandle.write(nextIndex.bytes, 0, nextIndex.bytes.length, 0);
        await indexHandle.sync();
        await indexHandle.close(); indexHandle = null;
        Object.assign(record, { phase: 'checkout-complete', afterDigest: after.digest, nextIndexSha256: sha(nextIndex.bytes) });
        await save(root, 'record', record);
        if (!isPrepared()) return { ok: false, code: 'landing-reference-interrupted' };
        await fs.rename(indexLock, indexFile);
        ownIndexLock = false;
        await syncPrivateDirectory(target.gitDir);
        record.phase = 'index-published';
        await save(root, 'record', record);
        return { ok: true };
      });
      if (!transaction.ok) return { ...(transaction.value ?? {}), ok: false, code: transaction.value?.ok === false ? transaction.value.code : transaction.code };
      record.phase = 'landed';
      record.landedAt = new Date().toISOString();
      await save(root, 'record', record);
      succeeded = true;
      return { ok: true, landingId: id, candidate: record.candidate, ref: record.ref, validationId: record.validationId };
    });
    return guarded.ok ? { ...guarded.value, landingId: id } : { ok: false, code: guarded.code, landingId: id };
  } finally {
    await indexHandle?.close().catch(() => {});
    if (!mutationStarted && ownIndexLock) {
      const locked = await fs.lstat(indexLock).catch(() => null);
      // Only this invocation's exclusive, pre-mutation lock can be removed automatically.
      if (locked?.isFile() && locked.dev === ownedLockIdentity?.dev && locked.ino === ownedLockIdentity?.ino) await fs.unlink(indexLock);
    }
    if (succeeded || !mutationStarted) await closeLandingSession(cwd, target, record);
  }
}

/** Land into the selected checkout only; the live producer's branch, index and files stay live. */
export async function landCheckpoint(cwd, validationId) {
  const rootPath = await repoRoot(cwd);
  if (!rootPath) return { ok: false, code: 'workspace-unavailable' };
  cwd = await canonicalPath(rootPath);
  const validation = await verifyCheckpointValidation(cwd, validationId);
  if (!validation.ok || !validation.validation) return validation;
  const target = await ownershipTarget(cwd);
  if (!target.ok) return { ok: false, code: 'workspace-unavailable' };
  const branch = await git(['symbolic-ref', '-q', 'HEAD'], { cwd });
  const ref = branch.stdout.trim();
  if (!ref.startsWith('refs/heads/') || await resolveRef(cwd, 'HEAD') !== validation.validation.base.expected) {
    return { ok: false, code: 'landing-target-mismatch', reason: 'Run land in the integration checkout at the base used by this validation.' };
  }
  const alias = await git(['symbolic-ref', '-q', ref], { cwd });
  if (alias.code !== 1) return { ok: false, code: 'landing-target-is-symbolic' };
  const id = sha(`${validationId}\0${target.key}\0${randomUUID()}`);
  const root = await ensurePrivateDirectory(rootAt(target, id));
  const record = { version: 1, id, validationId, cwd, worktreeKey: target.key, ref,
    expected: validation.validation.base.expected, candidate: validation.validation.candidate,
    phase: 'preparing', createdAt: new Date().toISOString() };
  await save(root, 'record', record);
  const command = await runWorkspaceCommand(cwd, [process.execPath, worker, id], {
    exclusive: true, stdio: 'capture', beforeLaunch: async ({ sessionId, backend }) => {
      Object.assign(record, { runnerId: sessionId, backend });
      await save(root, 'record', record);
    },
  });
  if (!command.ok) return { ...command, landingId: id };
  const result = await readJson(path.join(root, 'result.json'));
  return result ?? { ok: false, code: 'landing-interrupted', landingId: id,
    reason: 'The writer finished without a result. The integration record and original index remain available for recovery.' };
}

/** Resume only after the original OS-supervised writer tree has positively finished. */
export async function recoverCheckpointLanding(cwd, id) {
  const rootPath = await repoRoot(cwd);
  if (!rootPath) return { ok: false, code: 'workspace-unavailable' };
  cwd = await canonicalPath(rootPath);
  const read = await readLanding(cwd, id);
  if (!read.ok || !('record' in read) || !read.record) return read;
  const { target, root, record } = read;
  const completed = await verifyRunnerCompletion(cwd, record.runnerId, record.backend);
  if (!completed.ok) return { ...completed, landingId: id };
  await recoverCompletedRunners(cwd);
  if (record.phase === 'landed' && await resolveRef(cwd, record.ref) === record.candidate) {
    const closed = await closeLandingSession(cwd, target, record);
    return { ...closed, landingId: id, candidate: record.candidate, alreadyLanded: true };
  }
  // Recovery itself performs only index/ref publication after exact byte comparisons; no
  // working-tree writer is launched, so the completed original proof remains the boundary.
  const result = await performCheckpointLanding(cwd, id, { recovery: true });
  await save(root, 'result', result);
  return result;
}

export async function writeLandingWorkerResult(cwd, id, result) {
  const target = await ownershipTarget(cwd);
  if (!target.ok || !ID.test(id)) throw new Error('Landing result identity is unavailable.');
  await save(rootAt(target, id), 'result', result);
}
