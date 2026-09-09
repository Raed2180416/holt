// SPDX-License-Identifier: FSL-1.1-MIT
/** Host-side API. Callers own the actual task/operation promises; the model need not remember it. */
import { randomUUID } from 'node:crypto';
import { openWorktreeSession, updateWorktreeSession, handoffWorktreeSession, ownershipTarget } from './ownership.mjs';
import { storeBufferSnapshot } from './session-buffers.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function retryBusy(fn) {
  for (let attempt = 0; ; attempt++) {
    const result = await fn();
    if (result.code !== 'busy' || attempt >= 10) return result;
    await sleep(Math.min(10 * (attempt + 1), 100));
  }
}

export class WorkspaceSession {
  #cwd;
  #credential;
  #sequence = 0;
  #queue = Promise.resolve();
  #operations = new Set();
  #draining = false;
  #closed = false;
  #heartbeat;
  #heartbeatPending = false;
  #contactIssue = null;
  #transferring = false;
  /** @type {Promise<{ok:boolean,closed?:boolean,code?:string}>|null} */
  #finishing = null;

  /** @param {string} cwd @param {import('./sessions.mjs').SessionCredential} credential */
  constructor(cwd, credential, sequence = 0) {
    this.#cwd = cwd;
    this.#credential = credential;
    this.#sequence = sequence;
    this.#heartbeat = setInterval(() => {
      if (this.#closed || this.#heartbeatPending) return;
      this.#heartbeatPending = true;
      this.#send({ type: 'heartbeat' }).then((result) => {
        this.#contactIssue = result.ok ? null : result.code;
      }, (error) => { this.#contactIssue = error.message; }).finally(() => { this.#heartbeatPending = false; });
    }, 30000);
    this.#heartbeat.unref();
  }

  get id() { return this.#credential.id; }
  get contactIssue() { return this.#contactIssue; }
  get closed() { return this.#closed; }

  /** Pin the current committed version while this session remains free to produce the next. */
  async checkpoint(options = {}) {
    const { createCheckpoint } = await import('./checkpoints.mjs');
    return createCheckpoint(this.#cwd, options);
  }

  /** Attach before giving a worker/editor writable access to this workspace. */
  static async open(cwd, options = {}) {
    const opened = await retryBusy(() => openWorktreeSession(cwd, options));
    if (!opened.ok || !opened.credential) throw Object.assign(new Error(`Session could not attach: ${opened.code}`), { code: opened.code });
    return new WorkspaceSession(cwd, opened.credential);
  }

  /** Transfer after this host's granted work settles; buffers remain held by the successor. */
  async handoff() {
    if (this.#closed || this.#draining || this.#transferring) throw Object.assign(new Error('This session cannot be handed off now.'), { code: 'session-draining' });
    this.#transferring = true;
    try {
      await Promise.allSettled([...this.#operations]);
      const transfer = this.#queue.then(async () => {
        const result = await retryBusy(() => handoffWorktreeSession(this.#cwd, this.#credential, this.#sequence));
        if (!result.ok || !result.credential) throw Object.assign(new Error(`Session handoff failed: ${result.code}`), { code: result.code });
        this.#closed = true;
        clearInterval(this.#heartbeat);
        return new WorkspaceSession(this.#cwd, result.credential, this.#sequence);
      });
      this.#queue = transfer.then(() => undefined, () => undefined);
      return await transfer;
    } finally { this.#transferring = false; }
  }

  #send(event) {
    const operation = this.#queue.then(async () => {
      if (this.#closed) return { ok: event.type === 'heartbeat', code: 'session-closed', closed: true };
      if (typeof event === 'function') {
        const prepared = await event();
        if (!prepared.ok) return prepared;
        event = prepared.event;
      }
      const result = await retryBusy(() => updateWorktreeSession(this.#cwd, this.#credential, { ...event, sequence: this.#sequence + 1 }));
      if (result.ok) this.#sequence++;
      return result;
    });
    this.#queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  /**
   * Publish an intention before executing it; acknowledge it only after the host's promise
   * settles. A failed command is settled work too: exact-content analysis retains its output.
   * @template T
   * @param {{kind:string,paths?:string[],id?:string}} operation
   * @param {()=>Promise<T>} fn
   * @returns {Promise<T>}
   */
  withOperation({ kind, paths = [], id = randomUUID() }, fn) {
    if (this.#draining || this.#closed || this.#transferring) return Promise.reject(Object.assign(new Error('Session is draining; no new operation was started.'), { code: 'session-draining' }));
    const running = (async () => {
      const start = await this.#send({ type: 'operation-start', operationId: id, kind, paths });
      if (!start.ok) throw Object.assign(new Error(`Operation was not started: ${start.code}`), { code: start.code });
      let value;
      let failure;
      let failed = false;
      try { value = await fn(); } catch (error) { failed = true; failure = error; }
      const finished = await this.#send({ type: 'operation-finish', operationId: id }).catch((error) => ({ ok: false, code: error.message }));
      if (!finished.ok) {
        const issue = Object.assign(new Error(`Operation settled but its acknowledgement was not recorded: ${finished.code}`), { code: finished.code });
        if (failed) throw new AggregateError([failure, issue], 'The operation failed and its session acknowledgement needs recovery.', { cause: failure });
        throw issue;
      }
      if (failed) throw failure;
      return value;
    })();
    this.#operations.add(running);
    // Supply both handlers without creating an unobserved rejected cleanup promise.
    running.then(() => this.#operations.delete(running), () => this.#operations.delete(running));
    return running;
  }

  /** Buffer events come from the editor bridge, after it has durably stored a private copy. */
  async updateBuffer(buffer) {
    if (this.#closed) return { ok: false, code: 'session-closed' };
    return this.#send({ type: 'buffer', buffer });
  }

  /** Capture before acknowledging a changed buffer; editor events retain their arrival order. */
  updateBufferFromText({ path: bufferPath, text, version, dirty = true, encoding = null }) {
    return this.#send(async () => {
      const target = await ownershipTarget(this.#cwd);
      if (!target.ok) return { ok: false, code: 'workspace-unavailable' };
      const stored = await storeBufferSnapshot(target.root, { bufferPath, text, encoding });
      if (!stored.ok) return stored;
      return { ok: true, event: { type: 'buffer', buffer: {
        path: bufferPath, version, dirty, digest: stored.digest, recoveryRef: stored.recoveryRef,
      } } };
    });
  }

  async closeBuffer(bufferPath, version) {
    if (this.#closed) return { ok: false, code: 'session-closed' };
    return this.#send({ type: 'buffer-close', path: bufferPath, version });
  }

  /**
   * Stop granting new operations, drain those already granted, then retire this attachment.
   * Open buffers remain explicit holders, including clean buffers in a writable editor.
   */
  finish() {
    if (this.#transferring) return Promise.resolve({ ok: false, code: 'session-transferring' });
    if (this.#closed) return Promise.resolve({ ok: true, closed: true });
    if (this.#finishing) return this.#finishing;
    const finishing = this.#finish();
    this.#finishing = finishing;
    finishing.then(() => { this.#finishing = null; }, () => { this.#finishing = null; });
    return finishing;
  }

  async #finish() {
    this.#draining = true;
    const drained = await this.#send({ type: 'drain' });
    if (!drained.ok) return drained;
    await Promise.allSettled([...this.#operations]);
    const finished = await this.#send({ type: 'finish' });
    if (finished.ok) {
      this.#closed = true;
      clearInterval(this.#heartbeat);
    }
    return finished;
  }

  /** Loss of a host connection stops renewal, but never clears a pending operation or buffer. */
  disconnect() { clearInterval(this.#heartbeat); }
}
