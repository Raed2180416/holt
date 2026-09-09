/** Actual private editor transport: split Unicode, recovery, ordered finish and crash. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { newRepo } from '../fixtures.mjs';
import { inspectWorktreeOwnership } from '../../src/ownership.mjs';
import { listSessionBuffers, recoverSessionBuffer } from '../../src/session-recovery.mjs';
import { WorkspaceSession } from '../../src/session-host.mjs';
import { __test as mcp } from '../../src/mcp/server.mjs';

const cli = fileURLToPath(new URL('../../bin/holt.mjs', import.meta.url));
async function editor(t, cwd) {
  const process = spawn(globalThis.process.execPath, [cli, 'session', 'bridge', '--cwd', cwd], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => process.kill());
  const lines = createInterface({ input: process.stdout })[Symbol.asyncIterator]();
  assert.equal(JSON.parse((await lines.next()).value).type, 'ready');
  let id = 0;
  const send = async (event, split = false) => {
    const bytes = Buffer.from(JSON.stringify({ id: ++id, ...event }) + '\n');
    if (split) {
      const index = bytes.indexOf(Buffer.from('🦉')) + 1;
      process.stdin.write(bytes.subarray(0, index));
      // Independent writes cross a process boundary; the bridge must preserve UTF-8 state.
      await new Promise((resolve) => setImmediate(resolve));
      process.stdin.write(bytes.subarray(index));
    } else process.stdin.write(bytes);
    const result = JSON.parse((await lines.next()).value);
    assert.equal(result.id, id);
    return result;
  };
  return { process, send };
}

test('EDITOR BRIDGE: private capture, MCP/CLI recovery and clean finish share the same version', async (t) => {
  const fx = await newRepo('editor-bridge');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('editor');
  const bridge = await editor(t, wt);
  const text = 'draft 🦉\r\nnot saved\ud800';
  assert.equal((await bridge.send({ type: 'buffer', buffer: { path: 'draft.txt', text, version: 1 } }, true)).ok, true);
  assert.equal((await bridge.send({ type: 'finish' })).code, 'work-pending');
  assert.equal((await bridge.send({ type: 'buffer-close', path: 'draft.txt', version: 1 })).ok, true);
  const finished = once(bridge.process, 'close');
  assert.equal((await bridge.send({ type: 'finish' })).ok, true);
  assert.equal((await finished)[0], 0);
  assert.equal((await inspectWorktreeOwnership(wt)).state, 'unclaimed');
  const inventory = await mcp.handle('holt_session_buffers', { repo: fx.root });
  assert.equal(inventory.buffers.length, 1);
  assert.equal(inventory.buffers[0].state, 'retained');
  assert.ok(!JSON.stringify(inventory).includes('recoveryRef'));
  assert.ok(!JSON.stringify(inventory).includes('capability'));
  const destination = path.join(fx.root, 'recovered.json');
  const restored = await mcp.handle('holt_session_buffers', { repo: fx.root, operation: 'recover', id: inventory.buffers[0].id, destination });
  assert.equal(restored.ok, true, JSON.stringify(restored));
  assert.equal(JSON.parse(await fs.readFile(destination, 'utf8')).text, text);
  assert.equal((await recoverSessionBuffer(fx.root, inventory.buffers[0].id, destination)).code, 'destination-exists');
});

test('EDITOR BRIDGE: a crashed editor retains its attachment and makes the last acknowledged text discoverable', async (t) => {
  const fx = await newRepo('editor-crash');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('editor');
  const bridge = await editor(t, wt);
  assert.equal((await bridge.send({ type: 'buffer', buffer: { path: 'draft.txt', text: 'recover me', version: 9 } })).ok, true);
  const exited = once(bridge.process, 'close');
  bridge.process.kill('SIGKILL');
  await exited;
  const state = await inspectWorktreeOwnership(wt);
  assert.equal(state.sessions[0].buffers[0].version, 9);
  assert.notEqual(state.state, 'unclaimed');
  const inventory = await listSessionBuffers(fx.root);
  assert.equal(inventory.buffers[0].state, 'open');
  assert.equal(inventory.buffers[0].version, 9);
});

test('HOST HANDOFF: old host drains its work and buffers remain writable through the successor', async (t) => {
  const fx = await newRepo('host-transfer');
  t.after(() => fx.cleanup());
  const host = await WorkspaceSession.open(fx.root, { kind: 'editor' });
  t.after(() => host.disconnect());
  assert.equal((await host.updateBufferFromText({ path: 'a.txt', text: 'one', version: 1 })).ok, true);
  const next = await host.handoff();
  t.after(() => next.disconnect());
  assert.equal(host.closed, true);
  assert.equal(next.closed, false);
  assert.equal((await host.closeBuffer('a.txt', 1)).code, 'session-closed');
  assert.equal((await next.updateBufferFromText({ path: 'a.txt', text: 'two', version: 2 })).ok, true);
  assert.equal((await next.closeBuffer('a.txt', 2)).ok, true);
  assert.equal((await next.finish()).ok, true);
});
