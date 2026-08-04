/**
 * holt — `holt mcp --print-config` command.
 *
 * Outputs the MCP server config as JSON (or TOML for codex) for easy copy-paste into a host's
 * config file. These tests cover every supported host format and the default (generic) shape.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { printMcpConfig } from '../../src/mcp/server.mjs';

test('mcp-print-config: generic (default) produces the standard mcpServers shape', async () => {
  const r = await printMcpConfig();
  assert.equal(r.format, 'generic');
  const cfg = JSON.parse(r.content);
  assert.ok(cfg.mcpServers?.holt, 'must have mcpServers.holt');
  assert.equal(cfg.mcpServers.holt.command, 'holt');
  assert.deepEqual(cfg.mcpServers.holt.args, ['mcp']);
});

test('mcp-print-config: claude alias produces the same standard shape', async () => {
  const r = await printMcpConfig({ host: 'claude' });
  assert.equal(r.format, 'claude');
  const cfg = JSON.parse(r.content);
  assert.ok(cfg.mcpServers?.holt, 'claude uses mcpServers');
});

test('mcp-print-config: cursor alias produces the same standard shape', async () => {
  const r = await printMcpConfig({ host: 'cursor' });
  const cfg = JSON.parse(r.content);
  assert.ok(cfg.mcpServers?.holt, 'cursor uses mcpServers');
});

test('mcp-print-config: vscode uses the servers key (not mcpServers)', async () => {
  const r = await printMcpConfig({ host: 'vscode' });
  assert.equal(r.format, 'vscode');
  const cfg = JSON.parse(r.content);
  assert.ok(cfg.servers?.holt, 'vscode uses servers, not mcpServers');
  assert.equal(cfg.mcpServers, undefined, 'must NOT have mcpServers');
});

test('mcp-print-config: opencode uses the mcp key with type/command/enabled shape', async () => {
  const r = await printMcpConfig({ host: 'opencode' });
  assert.equal(r.format, 'opencode');
  const cfg = JSON.parse(r.content);
  assert.ok(cfg.mcp?.holt, 'opencode uses mcp');
  assert.equal(cfg.mcp.holt.type, 'local');
  assert.deepEqual(cfg.mcp.holt.command, ['holt', 'mcp']);
  assert.equal(cfg.mcp.holt.enabled, true);
});

test('mcp-print-config: zed uses context_servers with source:custom', async () => {
  const r = await printMcpConfig({ host: 'zed' });
  assert.equal(r.format, 'zed');
  const cfg = JSON.parse(r.content);
  assert.ok(cfg.context_servers?.holt, 'zed uses context_servers');
  assert.equal(cfg.context_servers.holt.source, 'custom', 'zed requires source:custom');
});

test('mcp-print-config: codex produces a TOML block (not JSON)', async () => {
  const r = await printMcpConfig({ host: 'codex' });
  assert.equal(r.format, 'codex');
  assert.match(r.content, /\[mcp_servers\.holt\]/);
  assert.match(r.content, /command = "holt"/);
  assert.match(r.content, /args = \["mcp"\]/);
  // Must NOT be valid JSON (it is TOML).
  assert.throws(() => JSON.parse(r.content));
});

test('mcp-print-config: crush uses the mcp key with type/command/args shape', async () => {
  const r = await printMcpConfig({ host: 'crush' });
  const cfg = JSON.parse(r.content);
  assert.ok(cfg.mcp?.holt, 'crush uses mcp');
  assert.equal(cfg.mcp.holt.type, 'stdio');
  assert.equal(cfg.mcp.holt.command, 'holt');
  assert.deepEqual(cfg.mcp.holt.args, ['mcp']);
});

test('mcp-print-config: a custom bin is honoured in the entry', async () => {
  const r = await printMcpConfig({ bin: '/usr/local/bin/holt' });
  const cfg = JSON.parse(r.content);
  assert.equal(cfg.mcpServers.holt.command, '/usr/local/bin/holt');
});

test('mcp-print-config: the output is always valid JSON for non-codex hosts', async () => {
  for (const host of ['generic', 'claude', 'cursor', 'vscode', 'opencode', 'zed', 'crush', 'amp']) {
    const r = await printMcpConfig({ host });
    // Must not throw — every non-codex format is JSON.
    JSON.parse(r.content);
  }
});
