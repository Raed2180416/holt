// SPDX-License-Identifier: FSL-1.1-MIT
/** Validate a pinned candidate in its own registered checkout while its producer keeps working. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { git, resolveRef, repoIdentity } from './git.mjs';
import { prepareCheckpoint, verifyCheckpoint } from './checkpoints.mjs';
import { runWorkspaceCommand, sessionRunnerCapability } from './session-runner.mjs';
import { WorkspaceSession } from './session-host.mjs';
import { ensurePrivateDirectory, readStableRegularFile, writePrivateFileAtomic } from './stable-file.mjs';
import { sessionPath } from './sessions.mjs';

const ID = /^[0-9a-f]{64}$/;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const sha = (value) => createHash('sha256').update(value).digest('hex');
const validationRoot = (common) => path.join(common, 'holt-checkpoints-v1', 'validations');

/**
 * The checkout's raw tracked input, independent of assume-unchanged/skip-worktree and Git
 * conversion settings. Compare before/after bytes, modes and links, not a cached git status.
 */
async function inputManifest(cwd, candidate) {
  const tree = await git(['ls-tree', '-r', '-z', '--full-tree', candidate], { cwd });
  if (tree.code !== 0) return { ok: false, code: 'validation-tree-unavailable' };
  const entries = tree.stdout.split('\0').filter(Boolean);
  if (entries.length > 100000) return { ok: false, code: 'validation-file-limit' };
  const digest = createHash('sha256');
  let bytes = 0;
  for (const entry of entries) {
    const separator = entry.indexOf('\t');
    const [mode, type] = entry.slice(0, separator).split(' ');
    const relative = entry.slice(separator + 1);
    if (separator < 0 || !sessionPath(relative) || type !== 'blob') return { ok: false, code: 'validation-input-unavailable', path: relative };
    const file = path.join(cwd, relative);
    let actual;
    if (mode === '120000') {
      const before = await fs.lstat(file).catch(() => null);
      if (!before?.isSymbolicLink()) return { ok: false, code: 'validation-input-changed', path: relative };
      const link = await fs.readlink(file, { encoding: 'buffer' });
      const after = await fs.lstat(file).catch(() => null);
      if (!after || before.ino !== after.ino || before.ctimeMs !== after.ctimeMs) return { ok: false, code: 'validation-input-changed', path: relative };
      actual = { content: link, executable: null };
    } else {
      const read = await readStableRegularFile(file, { maxBytes: 64 * 1024 * 1024 });
      if (!read.ok) return { ok: false, code: 'validation-input-unavailable', path: relative };
      actual = { content: read.bytes, executable: process.platform === 'win32' ? null : !!(read.stat.mode & 0o111) };
    }
    bytes += actual.content.length;
    if (bytes > 512 * 1024 * 1024) return { ok: false, code: 'validation-input-byte-limit' };
    digest.update(JSON.stringify([relative, mode, actual.executable, sha(actual.content)]) + '\n');
  }
  return { ok: true, digest: digest.digest('hex'), files: entries.length, bytes };
}

/** Executes only the explicitly supplied argv, never an inferred repository command. */
export async function validateCheckpoint(cwd, checkpointId, { base = null, argv = [] } = {}) {
  if (!Array.isArray(argv) || !argv.length || argv.length > 256
    || argv.some((arg) => typeof arg !== 'string' || arg.includes('\0') || arg.length > 16384) || !argv[0]) {
    return { ok: false, code: 'validation-command-required', reason: 'Provide the exact test command and arguments after --.' };
  }
  const capability = await sessionRunnerCapability();
  if (!capability.available) return { ok: false, code: 'supervisor-unavailable', reason: capability.reason };
  const prepared = await prepareCheckpoint(cwd, checkpointId, { base });
  if (!prepared.ok || !prepared.candidate || !prepared.base) return prepared;
  if (prepared.baseChanged) return { ...prepared, ok: false, code: 'validation-base-changed' };
  const common = await repoIdentity(cwd);
  if (!common) return { ok: false, code: 'repository-unavailable' };
  const id = sha(`${prepared.candidate}\0${randomUUID()}`);
  const directory = await ensurePrivateDirectory(path.join(common, 'holt-checkpoints-v1', 'validation-workspaces'));
  const worktree = path.join(directory, id);
  const root = validationRoot(common);
  const record = {
    version: 1, id, checkpointId, candidate: prepared.candidate, tree: prepared.tree, candidateRef: prepared.ref,
    base: { ref: prepared.base.ref, expected: prepared.base.expected }, worktree, argv,
    startedAt: new Date().toISOString(), state: 'preparing', platform: process.platform, node: process.version,
  };
  await writePrivateFileAtomic(path.join(root, `${id}.json`), Buffer.from(JSON.stringify(record) + '\n'));
  const add = await git(['worktree', 'add', '--detach', '--no-checkout', worktree, prepared.candidate], { cwd, allowMutation: true });
  if (add.code !== 0) return { ok: false, code: 'validation-workspace-unavailable', validationId: id, reason: add.stderr.trim() };
  const host = await WorkspaceSession.open(worktree, { kind: 'job', label: `validate ${checkpointId.slice(0, 12)}`, host: 'checkpoint-validator' });
  let settled = false;
  let commandStarted = false;
  try {
    const materialized = await git(['read-tree', '-m', '-u', prepared.tree], { cwd: worktree, allowMutation: true });
    if (materialized.code !== 0) return { ok: false, code: 'validation-checkout-unavailable', validationId: id, worktree };
    const before = await inputManifest(worktree, prepared.candidate);
    if (!before.ok) return { ...before, validationId: id, worktree };
    await writePrivateFileAtomic(path.join(root, `${id}.json`), Buffer.from(JSON.stringify({ ...record, state: 'running', input: before }) + '\n'));
    const env = { ...process.env, CI: '1', GIT_TERMINAL_PROMPT: '0' };
    for (const name of ['NODE_TEST_CONTEXT', 'NODE_TEST_PIPE', 'JEST_WORKER_ID', 'VITEST_POOL_ID']) delete env[name];
    commandStarted = true;
    const command = await runWorkspaceCommand(worktree, argv, { stdio: 'capture', env });
    settled = command.ok;
    const after = settled ? await inputManifest(worktree, prepared.candidate) : null;
    const finalHead = await resolveRef(worktree, 'HEAD');
    const index = await git(['diff-index', '--cached', '--quiet', prepared.candidate, '--'], { cwd: worktree });
    const currentBase = await resolveRef(cwd, prepared.base.ref);
    const pin = await resolveRef(cwd, prepared.ref);
    const sameInput = before.ok && after?.ok && before.digest === after.digest && finalHead === prepared.candidate && index.code === 0;
    const childrenPassed = 'failedDescendants' in command && command.failedDescendants === 0;
    const passed = command.ok && command.exitCode === 0 && childrenPassed && sameInput && pin === prepared.candidate;
    const validation = { ...record, state: passed ? 'passed' : 'failed', finishedAt: new Date().toISOString(),
      input: before, sameInput, backend: capability.backend, commandExitCode: command.exitCode,
      treeDrained: command.ok, childrenPassed, baseChanged: currentBase !== prepared.base.expected,
      outputTruncated: 'outputTruncated' in command ? command.outputTruncated : false,
      reason: !command.ok ? command.code : command.exitCode !== 0 ? 'test-command-failed' : !childrenPassed ? 'descendant-command-failed' : !sameInput ? 'tested-input-changed'
        : pin !== prepared.candidate ? 'checkpoint-candidate-changed' : null };
    const log = Buffer.from(JSON.stringify({ stdout: 'stdout' in command ? command.stdout : '', stderr: 'stderr' in command ? command.stderr : '' }) + '\n');
    await writePrivateFileAtomic(path.join(root, `${id}.output.json`), log);
    await writePrivateFileAtomic(path.join(root, `${id}.json`), Buffer.from(JSON.stringify({ ...validation, outputSha256: sha(log) }) + '\n'));
    return { ok: passed, validation, note: 'The supplied command tested this exact candidate. Its checkout and outputs are retained; the producer is unchanged.' };
  } finally {
    if (!commandStarted || settled) await host.finish();
    host.disconnect();
  }
}

/** Read a validation certificate and freshly compare both immutable inputs and integration base. */
export async function verifyCheckpointValidation(cwd, id, { allowLandedCandidate = false } = {}) {
  if (!ID.test(id)) return { ok: false, code: 'invalid-validation-id' };
  const common = await repoIdentity(cwd);
  if (!common) return { ok: false, code: 'repository-unavailable' };
  const read = await readStableRegularFile(path.join(validationRoot(common), `${id}.json`), { maxBytes: 1024 * 1024, requireOwner: true, requireSingleLink: true });
  if (!read.ok) return { ok: false, code: 'validation-unavailable' };
  let record;
  try { record = JSON.parse(read.bytes.toString('utf8')); } catch { return { ok: false, code: 'validation-invalid' }; }
  if (record.version !== 1 || record.id !== id || !ID.test(record.checkpointId) || !OID.test(record.candidate)
    || !OID.test(record.tree) || !OID.test(record.base?.expected) || typeof record.base?.ref !== 'string'
    || record.candidateRef !== `refs/holt/candidate/${record.checkpointId}/${record.base.expected}`) return { ok: false, code: 'validation-invalid' };
  if (record.state !== 'passed' || record.commandExitCode !== 0 || !record.childrenPassed || !record.sameInput || !record.treeDrained) return { ok: false, code: 'validation-not-passed', validation: record };
  const checkpoint = await verifyCheckpoint(cwd, record.checkpointId);
  if (!checkpoint.ok) return checkpoint;
  const currentCandidate = await resolveRef(cwd, record.candidateRef);
  const candidateTree = await git(['rev-parse', '--verify', `${record.candidate}^{tree}`], { cwd });
  if (currentCandidate !== record.candidate || candidateTree.stdout.trim() !== record.tree) return { ok: false, code: 'validated-candidate-changed', validation: record };
  const output = await readStableRegularFile(path.join(validationRoot(common), `${id}.output.json`), { maxBytes: 16 * 1024 * 1024, requireOwner: true, requireSingleLink: true });
  if (!output.ok || sha(output.bytes) !== record.outputSha256) return { ok: false, code: 'validation-output-unavailable', validation: record };
  const currentBase = await resolveRef(cwd, record.base.ref);
  if (currentBase !== record.base.expected && !(allowLandedCandidate && currentBase === record.candidate)) return { ok: false, code: 'validation-base-changed', validation: record, currentBase };
  return { ok: true, validation: record };
}
