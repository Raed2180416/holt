// SPDX-License-Identifier: FSL-1.1-MIT
/** Automatic command lifetime, including detached descendants observed by an OS supervisor. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { git, resolveRef } from './git.mjs';
import { openWorktreeSession, updateWorktreeSession, ownershipTarget } from './ownership.mjs';
import { writePrivateFileAtomic, ensurePrivateDirectory, syncPrivateDirectory } from './stable-file.mjs';

const runFile = promisify(execFile);
const SUPERVISOR = fileURLToPath(new URL('../bin/holt-supervisor.py', import.meta.url));

/** Probe without creating a session, changing Git state, or launching a user command. */
export async function sessionRunnerCapability() {
  const candidates = process.platform === 'win32' ? ['python', 'python3'] : ['python3'];
  for (const python of candidates) {
    try {
      const { stdout } = await runFile(python, ['-I', '-B', SUPERVISOR, '--probe'], { timeout: 5000, maxBuffer: 8192 });
      const result = JSON.parse(stdout);
      if (result.available === true && result.descendants === true) return { ...result, python };
    } catch { /* An unavailable optional interpreter does not change ordinary Holt commands. */ }
  }
  return { available: false, reason: 'Automatic command supervision needs Python 3 and a supported OS process-tree backend. Run holt ownership for existing explicit leases.' };
}

async function retryBusy(fn) {
  for (let attempt = 0; ; attempt++) {
    const result = await fn();
    if (result.code !== 'busy' || attempt >= 10) return result;
    await new Promise((resolve) => setTimeout(resolve, Math.min(10 * (attempt + 1), 100)));
  }
}

/**
 * Run argv with unchanged standard input/output and preserve the command's exit status. A
 * supervisor crash leaves the pending operation recorded. The command cannot write its own
 * completion acknowledgement because the supervisor's control channel is not inherited.
 * @param {string} cwd
 * @param {string[]} argv
 * @param {{onState?:(state:object)=>void,beforeLaunch?:(state:{sessionId:string,backend:string})=>Promise<void>,exclusive?:boolean,stdio?:'inherit'|'ignore'|'json'|'capture',env?:Record<string,string|undefined>}} [options]
 */
export async function runWorkspaceCommand(cwd, argv, { onState = () => {}, beforeLaunch = undefined, exclusive = false, stdio = 'inherit', env = undefined } = {}) {
  if (!Array.isArray(argv) || !argv.length || argv.some((arg) => typeof arg !== 'string' || arg.includes('\0')) || !argv[0]) {
    return { ok: false, code: 'missing-command', exitCode: 2, reason: 'Use holt run -- followed by the command and its arguments.' };
  }
  const capability = await sessionRunnerCapability();
  if (!capability.available) return { ok: false, code: 'supervisor-unavailable', exitCode: 2, reason: capability.reason };
  const rootResult = await git(['rev-parse', '--show-toplevel'], { cwd });
  if (rootResult.code !== 0) return { ok: false, code: 'not-a-repository', exitCode: 2, reason: 'Run the command inside a Git worktree.' };
  const root = rootResult.stdout.trim();
  const { recoverCompletedRunners } = await import('./session-recovery.mjs');
  await recoverCompletedRunners(root, { onlyDisconnected: true });
  const initialHead = await resolveRef(root, 'HEAD');
  const opened = await retryBusy(() => openWorktreeSession(root, {
    kind: 'runner', label: path.basename(argv[0]).slice(0, 256), host: 'holt-run', exclusive,
  }));
  if (!opened.ok || !opened.credential) return { ok: false, code: opened.code, exitCode: 2, reason: 'Could not attach the command before granting workspace access.', ownership: opened.ownership };
  const credential = opened.credential;
  const target = await ownershipTarget(root);
  if (!target.ok) return { ok: false, code: 'identity-unavailable', exitCode: 2, sessionId: credential.id };
  // The local recovery receipt survives a crashed wrapper. Never print the credential or put it
  // in the launched command's argv/environment. Only the private host/recovery layer reads it.
  const receiptPath = path.join(target.root, 'runners', `${credential.id}.json`);
  const proofDirectory = await ensurePrivateDirectory(path.join(target.root, 'runner-completions'));
  const proof = await fs.open(path.join(proofDirectory, `${credential.id}.jsonl`), 'wx', 0o600);
  await proof.sync();
  await syncPrivateDirectory(proofDirectory);
  await writePrivateFileAtomic(receiptPath, Buffer.from(JSON.stringify({
    version: 2, worktreeKey: target.key, credential, backend: capability.backend, wrapperPid: process.pid,
  }) + '\n'));
  let sequence = 0;
  let queue = Promise.resolve();
  const send = (event) => {
    const result = queue.then(async () => {
      const update = await retryBusy(() => updateWorktreeSession(root, credential, { sequence: sequence + 1, ...event }));
      if (update.ok) sequence++;
      return update;
    });
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  const started = await send({ type: 'operation-start', operationId: 'command', kind: 'command-tree', paths: [] });
  if (!started.ok) { await proof.close(); return { ok: false, code: started.code, exitCode: 2, sessionId: credential.id }; }
  try {
    await beforeLaunch?.({ sessionId: credential.id, backend: capability.backend });
  } catch (error) {
    // No process has received workspace access. A failed durable launch receipt can retire its
    // empty intention; retain it if any acknowledgement itself cannot be recorded.
    await proof.close();
    for (const event of [{ type: 'operation-finish', operationId: 'command' }, { type: 'drain' }, { type: 'finish' }]) {
      const ended = await send(event);
      if (!ended.ok) return { ok: false, code: ended.code, exitCode: 125, sessionId: credential.id };
    }
    await fs.unlink(receiptPath);
    return { ok: false, code: 'launch-preparation-failed', exitCode: 2, reason: error.message };
  }
  const notify = (state) => { try { onState(state); } catch { /* Observers cannot interrupt supervision. */ } };
  notify({ phase: 'attached', sessionId: credential.id, backend: capability.backend });
  const child = spawn(capability.python, ['-I', '-B', SUPERVISOR, '--', ...argv], {
    cwd, env,
    stdio: stdio === 'json' ? ['inherit', 2, 2, 'pipe', proof.fd]
      : stdio === 'capture' ? ['ignore', 'pipe', 'pipe', 'pipe', proof.fd] : [stdio, stdio, stdio, 'pipe', proof.fd],
  });
  const proofClosed = proof.close();
  let stdout = '';
  let stderr = '';
  let outputTruncated = false;
  if (stdio === 'capture') {
    const capture = (value, chunk) => {
      const next = value + chunk.toString('utf8');
      if (next.length > 1024 * 1024) outputTruncated = true;
      return next.slice(0, 1024 * 1024);
    };
    child.stdout?.on('data', (chunk) => { stdout = capture(stdout, chunk); });
    child.stderr?.on('data', (chunk) => { stderr = capture(stderr, chunk); });
  }
  let control = '';
  /** @type {string|null} */
  let controlError = null;
  let ready = false;
  let drained = null;
  /** @type {number|null} */
  let failedDescendants = null;
  const channel = child.stdio[3];
  if (!channel || !('on' in channel)) throw new Error('supervisor control channel was not created');
  channel.on('data', (chunk) => {
    if (controlError) return;
    control += chunk.toString('utf8');
    if (control.length > 8192) { controlError = 'supervisor control record exceeded its bound'; return; }
    while (control.includes('\n')) {
      const end = control.indexOf('\n');
      const line = control.slice(0, end);
      control = control.slice(end + 1);
      try {
        const event = JSON.parse(line);
        if (event.type === 'ready' && !ready && !drained && event.backend === capability.backend) ready = true;
        else if (event.type === 'started' && ready && !drained && Number.isSafeInteger(event.pid)) {
          notify({ phase: 'running', sessionId: credential.id, pid: event.pid });
        } else if (event.type === 'leader-exited' && ready && !drained) {
          notify({ phase: 'waiting-for-descendants', sessionId: credential.id });
        } else if (event.type === 'drained' && ready && !drained && Number.isSafeInteger(event.exitCode)
          && Number.isSafeInteger(event.reaped) && event.reaped >= 0
          && Number.isSafeInteger(event.failedDescendants) && event.failedDescendants >= 0) {
          drained = event;
          failedDescendants = event.failedDescendants;
        }
        else controlError = 'supervisor protocol did not match its lifecycle';
      } catch { controlError = 'supervisor control record was not valid JSON'; }
    }
  });
  const handlers = new Map();
  for (const signal of /** @type {NodeJS.Signals[]} */ (['SIGINT', 'SIGTERM', 'SIGHUP'])) {
    const handler = () => { if (child.exitCode === null && child.signalCode === null) child.kill(signal); };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  let heartbeatFailure = null;
  let heartbeatPending = false;
  const heartbeat = setInterval(() => {
    if (heartbeatPending) return;
    heartbeatPending = true;
    send({ type: 'heartbeat' }).then((result) => {
      if (!result.ok) heartbeatFailure = result.code;
    }, (error) => { heartbeatFailure = error.message; }).finally(() => { heartbeatPending = false; });
  }, 30000);
  let exitCode;
  let exitSignal;
  try {
    [exitCode, exitSignal] = await once(child, 'close');
  } catch (error) {
    controlError = error.message;
  } finally {
    clearInterval(heartbeat);
    for (const [signal, handler] of handlers) process.off(signal, handler);
    await queue;
    await proofClosed;
  }
  if (control.trim()) controlError = 'supervisor acknowledgement was incomplete';
  if (!drained || !ready || controlError || exitSignal) {
    return { ok: false, code: 'supervisor-interrupted', exitCode: 125,
      sessionId: credential.id, reason: controlError ?? 'The command tree was not confirmed drained; its session remains available for recovery.' };
  }
  let checkpoint = null;
  let checkpointIssue = null;
  const finalHead = await resolveRef(root, 'HEAD');
  if (finalHead && finalHead !== initialHead) {
    try {
      const { createCheckpoint } = await import('./checkpoints.mjs');
      const captured = await createCheckpoint(root, { ref: finalHead });
      if (captured.ok) checkpoint = captured.checkpoint;
      else checkpointIssue = captured.code;
    } catch (error) { checkpointIssue = error.message; }
  }
  for (const event of [{ type: 'operation-finish', operationId: 'command' }, { type: 'drain' }, { type: 'finish' }]) {
    const result = await send(event);
    if (!result.ok) return { ok: false, code: result.code, exitCode: 125, sessionId: credential.id,
      reason: 'The command finished, but its session could not be retired. Its recorded work remains available for recovery.' };
  }
  await fs.unlink(receiptPath);
  notify({ phase: 'finished', sessionId: credential.id });
  return { ok: true, exitCode: exitCode ?? 125, sessionId: credential.id, backend: capability.backend,
    failedDescendants,
    ...(stdio === 'capture' ? { stdout, stderr, outputTruncated } : {}),
    ...(checkpoint ? { checkpoint } : {}), ...(checkpointIssue ? { checkpointIssue } : {}),
    ...(heartbeatFailure ? { recoveredContactIssue: heartbeatFailure } : {}) };
}
