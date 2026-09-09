// SPDX-License-Identifier: FSL-1.1-MIT
/** Immutable review candidates remain useful while a producer continues in its live workspace. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { git, repoIdentity, resolveRef, authorEnv, historyCompleteness, pmap } from './git.mjs';
import { ownershipTarget, inspectWorktreeOwnership, withLeaseLock } from './ownership.mjs';
import { readStableRegularFile, writePrivateFileAtomic } from './stable-file.mjs';

const ID = /^[0-9a-f]{64}$/;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_RECORDS = 1024;
const rootAt = (common) => path.join(common, 'holt-checkpoints-v1');
const recordAt = (root, id) => path.join(root, 'records', `${id}.json`);
const refFor = (id) => `refs/holt/checkpoint/${id}`;

function validRecord(record) {
  return record && record.version === 1 && ID.test(record.id) && ID.test(record.sourceWorktreeKey)
    && OID.test(record.commit) && OID.test(record.tree) && record.ref === refFor(record.id)
    && record.kind === 'committed-tree' && typeof record.sourcePath === 'string'
    && typeof record.sourceLabel === 'string' && Number.isFinite(Date.parse(record.capturedAt))
    && record.base && typeof record.base.ref === 'string' && OID.test(record.base.oid);
}

async function readRecord(root, id) {
  const stored = await readStableRegularFile(recordAt(root, id), { maxBytes: 16384, requireOwner: true, requireSingleLink: true });
  if (!stored.ok) return { ok: false, code: stored.code === 'ENOENT' ? 'checkpoint-not-found' : 'checkpoint-unavailable' };
  try {
    const record = JSON.parse(stored.bytes.toString('utf8'));
    return validRecord(record) && record.id === id
      ? { ok: true, record } : { ok: false, code: 'checkpoint-invalid' };
  } catch { return { ok: false, code: 'checkpoint-invalid' }; }
}

/** A saved commit is an atomic version even if disk files and the producer's HEAD move next. */
export async function createCheckpoint(cwd, { ref = 'HEAD', base = null } = {}) {
  const target = await ownershipTarget(cwd);
  if (!target.ok) return { ok: false, code: 'workspace-unavailable' };
  const { resolveBase } = await import('./scan.mjs');
  const integration = await resolveBase(cwd, base);
  const guarded = await withLeaseLock(target, async () => {
    const commit = await resolveRef(cwd, ref);
    if (!commit || !OID.test(commit)) return { ok: false, code: 'checkpoint-ref-unavailable' };
    const type = await git(['cat-file', '-t', commit], { cwd });
    if (type.code !== 0 || type.stdout.trim() !== 'commit') return { ok: false, code: 'checkpoint-needs-commit' };
    const treeResult = await git(['rev-parse', '--verify', `${commit}^{tree}`], { cwd });
    const tree = treeResult.stdout.trim();
    if (treeResult.code !== 0 || !OID.test(tree)) return { ok: false, code: 'checkpoint-tree-unavailable' };
    const id = createHash('sha256').update(target.key).update('\0').update(commit).digest('hex');
    const root = rootAt(target.commonDir);
    const previous = await readRecord(root, id);
    if (previous.ok && previous.record) {
      const verified = await verifyCheckpoint(cwd, id);
      return verified.ok ? { ok: true, checkpoint: previous.record, reused: true } : verified;
    }
    if (previous.code !== 'checkpoint-not-found') return previous;
    const pin = refFor(id);
    const held = await resolveRef(cwd, pin);
    if (held && held !== commit) return { ok: false, code: 'checkpoint-pin-changed' };
    if (!held) {
      const pinned = await git(['update-ref', '--create-reflog', pin, commit, ''], { cwd, allowMutation: true });
      if (pinned.code !== 0) return { ok: false, code: 'checkpoint-pin-failed', commit };
    }
    const ownership = await inspectWorktreeOwnership(cwd, { commonDir: target.commonDir });
    const record = {
      version: 1, id, sourceWorktreeKey: target.key, sourcePath: path.resolve(cwd), sourceLabel: path.basename(cwd),
      kind: 'committed-tree', commit, tree, ref: pin, capturedAt: new Date().toISOString(),
      base: { ref: integration.ref, oid: integration.oid },
      sourceSessionIds: ownership.sessions?.map((session) => session.id) ?? [],
    };
    await writePrivateFileAtomic(recordAt(root, id), Buffer.from(JSON.stringify(record) + '\n'));
    return { ok: true, checkpoint: record, reused: false };
  });
  return guarded.ok ? guarded.value : { ok: false, code: guarded.code };
}

/** Read and verify immutable object/ref bindings without inspecting or interrupting live files. */
export async function verifyCheckpoint(cwd, id) {
  if (!ID.test(id)) return { ok: false, code: 'invalid-checkpoint-id' };
  const common = await repoIdentity(cwd);
  if (!common) return { ok: false, code: 'not-a-repository' };
  const read = await readRecord(rootAt(common), id);
  if (!read.ok || !read.record) return read;
  const record = read.record;
  const pinned = await resolveRef(cwd, record.ref);
  if (pinned !== record.commit) return { ok: false, code: 'checkpoint-pin-changed', checkpoint: record };
  const tree = await git(['rev-parse', '--verify', `${record.commit}^{tree}`], { cwd });
  if (tree.code !== 0 || tree.stdout.trim() !== record.tree) return { ok: false, code: 'checkpoint-object-changed', checkpoint: record };
  return { ok: true, checkpoint: record };
}

/** Bounded, read-only inventory. A checkpoint problem never disables legacy content analysis. */
export async function listCheckpoints(cwd, { commonDir = null, verify = true } = {}) {
  const common = commonDir ?? await repoIdentity(cwd);
  if (!common) return { ok: false, items: [], issues: [{ code: 'not-a-repository' }], omitted: 0 };
  const root = rootAt(common);
  let names;
  try { names = await fs.readdir(path.join(root, 'records')); } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, items: [], issues: [], omitted: 0 };
    return { ok: false, items: [], issues: [{ code: 'checkpoint-inventory-unavailable' }], omitted: 0 };
  }
  const ids = names.filter((name) => /^[0-9a-f]{64}\.json$/.test(name)).map((name) => name.slice(0, -5)).sort();
  const items = [];
  const issues = [];
  const pins = new Map();
  if (verify && ids.length) {
    const refs = await git(['for-each-ref', '--format=%(refname)%00%(objectname)%00%(tree)', 'refs/holt/checkpoint/'], { cwd });
    if (refs.code !== 0) return { ok: false, items: [], issues: [{ code: 'checkpoint-pins-unavailable' }], omitted: ids.length };
    for (const line of refs.stdout.split('\n').filter(Boolean)) {
      const [ref, commit, tree] = line.split('\0');
      pins.set(ref, { commit, tree });
    }
  }
  await pmap(ids.slice(0, MAX_RECORDS), async (id) => {
    const result = await readRecord(root, id);
    const checkpoint = result.record;
    const pin = checkpoint ? pins.get(checkpoint.ref) : null;
    if (result.ok && checkpoint && (!verify || (pin?.commit === checkpoint.commit && pin?.tree === checkpoint.tree))) {
      items.push({ ...checkpoint, verified: verify });
    } else issues.push({ id, code: result.ok ? 'checkpoint-pin-changed' : result.code });
  }, 8);
  items.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  return { ok: issues.length === 0, items, issues, omitted: Math.max(0, ids.length - MAX_RECORDS) };
}

/**
 * Prepare an object-only integration candidate against a recorded base. The live producer is
 * untouched. This does not advance a checked-out branch or claim that tests have passed.
 */
export async function prepareCheckpoint(cwd, id, { base = null } = {}) {
  const verified = await verifyCheckpoint(cwd, id);
  if (!verified.ok || !verified.checkpoint) return verified;
  const { resolveBase } = await import('./scan.mjs');
  const integration = await resolveBase(cwd, base);
  const history = await historyCompleteness(cwd);
  if (!history.complete) return { ok: false, code: 'incomplete-history', reason: history.reason };
  const merged = await git(['merge-tree', '--write-tree', integration.oid, verified.checkpoint.commit], { cwd });
  if (merged.code === 1) return { ok: false, code: 'checkpoint-conflicts-with-base', checkpoint: verified.checkpoint,
    base: integration, details: merged.stdout.slice(0, 8192) };
  if (merged.code !== 0) return { ok: false, code: 'checkpoint-merge-unavailable', reason: merged.stderr.trim() };
  const tree = merged.stdout.split('\n')[0].trim();
  if (!OID.test(tree)) return { ok: false, code: 'checkpoint-merge-tree-unavailable' };
  const parents = [...new Set([integration.oid, verified.checkpoint.commit])];
  const commit = await git(['commit-tree', tree, ...parents.flatMap((oid) => ['-p', oid]),
    '-m', `holt checkpoint ${id.slice(0, 12)} on ${integration.oid}`], { cwd, allowMutation: true, env: await authorEnv(cwd) });
  if (commit.code !== 0 || !OID.test(commit.stdout.trim())) return { ok: false, code: 'checkpoint-candidate-unavailable' };
  const candidate = commit.stdout.trim();
  const ref = `refs/holt/candidate/${id}/${integration.oid}`;
  const existing = await resolveRef(cwd, ref);
  let heldCandidate = candidate;
  if (existing) {
    const existingCommit = await git(['cat-file', '-p', existing], { cwd });
    const headers = existingCommit.stdout.split('\n\n')[0].split('\n');
    const existingParents = headers.filter((line) => line.startsWith('parent ')).map((line) => line.slice(7));
    if (existingCommit.code !== 0 || headers[0] !== `tree ${tree}`
      || existingParents.join('\0') !== parents.join('\0')) return { ok: false, code: 'checkpoint-candidate-changed' };
    heldCandidate = existing;
  } else {
    const written = await git(['update-ref', '--create-reflog', ref, candidate, ''], { cwd, allowMutation: true });
    if (written.code !== 0) return { ok: false, code: 'checkpoint-candidate-pin-failed', candidate };
  }
  const currentBase = await resolveRef(cwd, integration.ref);
  return { ok: true, checkpoint: verified.checkpoint, candidate: heldCandidate, tree, ref,
    base: { ref: integration.ref, expected: integration.oid, current: currentBase },
    baseChanged: currentBase !== integration.oid, validation: 'not-run',
    note: 'Review and validate this exact candidate in an isolated checkout. The producer can continue; its live files and branch were not changed.' };
}
