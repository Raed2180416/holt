/**
 * grove — MCP over the REAL protocol.
 *
 * test/e2e/mcp.test.mjs calls the tool handlers directly, which proves the ANSWERS are right and
 * nothing else. It would pass with a server that never initialises, advertises no tools, or
 * crashes the moment a client speaks JSON-RPC to it — and "directly integratable" is a product
 * claim, so it has to be tested the way a client actually uses it.
 *
 * This spawns `grove mcp` as a subprocess and speaks the wire protocol to it over stdio:
 * initialize -> initialized -> tools/list -> tools/call. No SDK client, no shortcuts — if the
 * framing or the schema were wrong, this is what would catch it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { standardFixture } from '../fixtures.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'grove.mjs');

/** Minimal stdio JSON-RPC client. Content-Length framing is NOT used by MCP stdio: it is
 *  newline-delimited JSON, one message per line. Getting this wrong is a real failure mode. */
class StdioClient {
  constructor(child) {
    this.child = child;
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      let idx;
      while ((idx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          resolve(msg);
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { this.stderr += c; });
  }

  send(method, params) {
    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', id, method, params };
    this.child.stdin.write(`${JSON.stringify(msg)}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout waiting for ${method}; stderr: ${this.stderr.slice(0, 400)}`)),
        90_000,
      );
      this.pending.set(id, { resolve: (m) => { clearTimeout(timer); resolve(m); } });
    });
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  close() {
    this.child.stdin.end();
    this.child.kill('SIGTERM');
  }
}

async function startServer(cwd) {
  const child = spawn(process.execPath, [BIN, 'mcp'], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GROVE_TMPDIR: process.env.GROVE_TMPDIR ?? undefined },
  });
  const client = new StdioClient(child);

  const init = await client.send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'grove-test-client', version: '0' },
  });
  client.notify('notifications/initialized', {});
  return { client, init };
}

test('MCP PROTOCOL: server initialises and identifies itself', async (t) => {
  const { fx } = await standardFixture();
  const { client, init } = await startServer(fx.root);
  t.after(() => { client.close(); return fx.cleanup(); });

  assert.equal(init.jsonrpc, '2.0');
  assert.ok(init.result, `initialize failed: ${JSON.stringify(init.error ?? init)}`);
  assert.equal(init.result.serverInfo.name, 'grove');
  assert.ok(init.result.capabilities.tools, 'server must advertise tool capability');
});

test('MCP PROTOCOL: tools/list returns the full, well-formed tool set', async (t) => {
  const { fx } = await standardFixture();
  const { client } = await startServer(fx.root);
  t.after(() => { client.close(); return fx.cleanup(); });

  const res = await client.send('tools/list', {});
  assert.ok(res.result, `tools/list failed: ${JSON.stringify(res.error)}`);

  const tools = res.result.tools;
  assert.ok(tools.length >= 7, `expected the full tool set, got ${tools.length}`);

  const names = tools.map((t2) => t2.name);
  for (const expected of [
    'grove_status', 'grove_at_risk', 'grove_check_workstream',
    'grove_collisions', 'grove_duplicates', 'grove_context', 'grove_landing_plan', 'grove_impact',
  ]) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }

  // The ACTING tools must be present too. An agent that can only diagnose freezes holding the
  // right answer — measured: two trials chose `grove clean` correctly and were then blocked by
  // the host's Bash permission classifier, because MCP had no way to act.
  for (const expected of ['grove_clean', 'grove_rescue', 'grove_protect']) {
    assert.ok(names.includes(expected), `missing acting tool ${expected}`);
  }

  const MUTATING = new Set(['grove_clean', 'grove_rescue', 'grove_protect']);
  const DESTRUCTIVE = new Set(['grove_clean']);

  for (const tool of tools) {
    assert.ok(tool.description?.length > 40, `${tool.name}: description too thin`);
    assert.equal(tool.inputSchema.type, 'object', `${tool.name}: schema must be an object`);

    // The annotation is a SAFETY CONTRACT: a host may auto-approve anything marked read-only.
    // Claiming readOnlyHint on a tool that deletes worktrees would turn that convenience into a
    // silent destruction, so each tool's annotation must match what it actually does.
    const ro = tool.annotations?.readOnlyHint;
    const destructive = tool.annotations?.destructiveHint;

    if (MUTATING.has(tool.name)) {
      assert.equal(ro, false, `${tool.name} MUTATES and must not claim readOnlyHint`);
      assert.equal(destructive, DESTRUCTIVE.has(tool.name),
        `${tool.name}: destructiveHint must reflect whether it can remove work`);
    } else {
      assert.equal(ro, true, `${tool.name} is diagnostic and must be annotated read-only`);
      assert.equal(destructive, false, `${tool.name} must be non-destructive`);
    }
  }
});

test('MCP PROTOCOL: tools/call returns the right answer over the wire', async (t) => {
  const { fx } = await standardFixture();
  const { client } = await startServer(fx.root);
  t.after(() => { client.close(); return fx.cleanup(); });

  const res = await client.send('tools/call', {
    name: 'grove_status',
    arguments: { repo: fx.root },
  });
  assert.ok(res.result, `tools/call failed: ${JSON.stringify(res.error)}`);
  assert.equal(res.result.isError, undefined, 'grove_status should not be an error');

  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.workstreams, 8);
  assert.equal(payload.atRisk, 1);
  assert.equal(payload.collisions, 1);
});

test('MCP PROTOCOL: the delete gate answers correctly over the wire', async (t) => {
  const { fx } = await standardFixture();
  const { client } = await startServer(fx.root);
  t.after(() => { client.close(); return fx.cleanup(); });

  const risky = await client.send('tools/call', {
    name: 'grove_check_workstream',
    arguments: { repo: fx.root, id: 'uniqueUncommitted' },
  });
  const riskyPayload = JSON.parse(risky.result.content[0].text);
  assert.equal(riskyPayload.safeToDelete, false);
  assert.match(riskyPayload.recommendation, /DO NOT DELETE/);

  const spent = await client.send('tools/call', {
    name: 'grove_check_workstream',
    arguments: { repo: fx.root, id: 'empty' },
  });
  const spentPayload = JSON.parse(spent.result.content[0].text);
  assert.equal(spentPayload.safeToDelete, true);
});

test('MCP PROTOCOL: an unknown tool is an error result, not a dead server', async (t) => {
  const { fx } = await standardFixture();
  const { client } = await startServer(fx.root);
  t.after(() => { client.close(); return fx.cleanup(); });

  const bad = await client.send('tools/call', { name: 'grove_nonexistent', arguments: {} });
  // Either a JSON-RPC error or an isError result is acceptable; a hang or crash is not.
  assert.ok(bad.error || bad.result, 'server must answer for an unknown tool');

  // And the server must still be alive and correct afterwards.
  const after = await client.send('tools/call', {
    name: 'grove_status', arguments: { repo: fx.root },
  });
  assert.ok(after.result, 'server died after an unknown-tool call');
});

test('MCP PROTOCOL: a bad repo path returns isError, and the server survives', async (t) => {
  const { fx } = await standardFixture();
  const { client } = await startServer(fx.root);
  t.after(() => { client.close(); return fx.cleanup(); });

  const bad = await client.send('tools/call', {
    name: 'grove_status', arguments: { repo: '/nonexistent/definitely/not/a/repo' },
  });
  assert.equal(bad.result.isError, true, 'a non-repo must surface as isError for the model to read');
  assert.match(bad.result.content[0].text, /not a git repository/);

  const after = await client.send('tools/call', {
    name: 'grove_status', arguments: { repo: fx.root },
  });
  assert.ok(after.result && !after.result.isError, 'server must recover');
});

test('MCP PROTOCOL: the acting tools ACT — the full loop an agent needs, over the wire', async (t) => {
  const { fx } = await standardFixture();
  const { client } = await startServer(fx.root);
  t.after(() => { client.close(); return fx.cleanup(); });

  // 1. protect: locks the workstreams holding unique work.
  const prot = await client.send('tools/call', { name: 'grove_protect', arguments: { repo: fx.root } });
  const protPayload = JSON.parse(prot.result.content[0].text);
  assert.ok(protPayload.protected >= 1, `protect should lock something: ${prot.result.content[0].text.slice(0, 200)}`);

  // 2. clean without apply: a DRY RUN, nothing removed.
  const dry = await client.send('tools/call', { name: 'grove_clean', arguments: { repo: fx.root } });
  const dryPayload = JSON.parse(dry.result.content[0].text);
  assert.equal(dryPayload.dryRun, true, 'clean must be dry-run unless apply:true — over MCP too');
  assert.ok(dryPayload.wouldRemove.length >= 1, 'the fixture has disposable worktrees');

  // 3. clean with apply: actually removes the disposable ones, and ONLY those.
  const applied = await client.send('tools/call', {
    name: 'grove_clean', arguments: { repo: fx.root, apply: true },
  });
  const appliedPayload = JSON.parse(applied.result.content[0].text);
  assert.ok(appliedPayload.removed >= 1, `apply:true must actually remove: ${applied.result.content[0].text.slice(0, 300)}`);

  // The valuable workstream must have survived the applied clean.
  const check = await client.send('tools/call', {
    name: 'grove_check_workstream', arguments: { repo: fx.root, id: 'uniqueUncommitted' },
  });
  const checkPayload = JSON.parse(check.result.content[0].text);
  assert.equal(checkPayload.safeToDelete, false, 'the work-holding worktree must survive grove_clean');

  // 4. rescue --release: capture the survivor's work, verified, then unlock it.
  const resc = await client.send('tools/call', {
    name: 'grove_rescue', arguments: { repo: fx.root, id: 'uniqueUncommitted', release: true },
  });
  const rescPayload = JSON.parse(resc.result.content[0].text);
  assert.equal(rescPayload.ok, true, `rescue failed over MCP: ${resc.result.content[0].text.slice(0, 300)}`);
  assert.equal(rescPayload.verified, true, 'an unverified rescue must never report ok');
  assert.match(rescPayload.ref, /^refs\/grove\/rescue\//);
});

test('MCP PROTOCOL: responses stay small enough to be worth calling', async (t) => {
  const { fx } = await standardFixture();
  const { client } = await startServer(fx.root);
  t.after(() => { client.close(); return fx.cleanup(); });

  // The whole design argument for aggregate tools is token cost. Assert it on the wire.
  const listRes = await client.send('tools/list', {});
  const schemaBytes = JSON.stringify(listRes.result.tools).length;
  assert.ok(schemaBytes < 12_000,
    `tool schemas are ${schemaBytes} chars — the entire point is not to burn context on schemas`);

  const status = await client.send('tools/call', { name: 'grove_status', arguments: { repo: fx.root } });
  const bytes = status.result.content[0].text.length;
  assert.ok(bytes < 3000, `grove_status returned ${bytes} chars — should be a decision, not a dump`);
});
