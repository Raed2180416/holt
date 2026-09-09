// SPDX-License-Identifier: FSL-1.1-MIT
/** Private stdio bridge for editor hosts. EOF means lost contact, never successful completion. */
import { WorkspaceSession } from './session-host.mjs';
import { BUFFER_MAX_CODE_UNITS } from './session-buffers.mjs';
import { StringDecoder } from 'node:string_decoder';
import { git } from './git.mjs';

const MAX_LINE = BUFFER_MAX_CODE_UNITS * 6 + 8192;

/**
 * Each request has an id and a type: buffer, buffer-close, checkpoint, or finish. Replies carry
 * the same id. Credentials stay inside this process; no server port or model tool exposes them.
 * @param {string} cwd
 * @param {{input?:NodeJS.ReadableStream,output?:NodeJS.WritableStream,label?:string}} [options]
 */
export async function runSessionBridge(cwd, { input = process.stdin, output = process.stdout, label = 'editor workspace' } = {}) {
  const prefix = await git(['rev-parse', '--show-prefix'], { cwd });
  if (prefix.code !== 0) throw new Error('The editor workspace is not inside a Git worktree.');
  const session = await WorkspaceSession.open(cwd, { kind: 'editor', label, host: 'editor-bridge' });
  const reply = (value) => new Promise((resolve, reject) => output.write(JSON.stringify(value) + '\n', (error) => error ? reject(error) : resolve(undefined)));
  let pending = '';
  const decoder = new StringDecoder('utf8');
  let finished = false;
  const handle = async (line) => {
    let request;
    try { request = JSON.parse(line); } catch { await reply({ ok: false, code: 'invalid-json' }); return; }
    const id = request?.id;
    if (!(typeof id === 'string' && id.length <= 256) && !Number.isSafeInteger(id)) {
      await reply({ ok: false, code: 'request-id-required' }); return;
    }
    let result;
    if (request.type === 'buffer') result = await session.updateBufferFromText(request.buffer ?? {});
    else if (request.type === 'buffer-close') result = await session.closeBuffer(request.path, request.version);
    else if (request.type === 'checkpoint') result = await session.checkpoint();
    else if (request.type === 'finish') { result = await session.finish(); finished = result.ok; }
    else result = { ok: false, code: 'unknown-editor-event' };
    await reply({ id, ...result });
  };
  try {
    await reply({ ok: true, type: 'ready', sessionId: session.id, protocol: 1, pathPrefix: prefix.stdout.replace(/\r?\n$/, '') });
    // Async iteration applies backpressure while each ordered capture reaches stable storage.
    for await (const chunk of input) {
      pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      while (pending.includes('\n')) {
        const end = pending.indexOf('\n');
        if (end > MAX_LINE) throw new Error('Editor event exceeds its storage bound.');
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        await handle(line);
        if (finished) return { ok: true, closed: true };
      }
      if (pending.length > MAX_LINE) throw new Error('Editor event exceeds its storage bound.');
    }
    pending += decoder.end();
    return { ok: false, code: pending.trim() ? 'editor-event-incomplete' : 'editor-disconnected', sessionId: session.id };
  } finally { session.disconnect(); }
}
