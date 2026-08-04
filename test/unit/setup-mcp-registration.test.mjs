/**
 * holt — `holt setup` MCP auto-registration.
 *
 * `holt setup` now offers to write the MCP server config for every host it detects, showing
 * the config file path and key for each. These tests cover the detection-to-target mapping
 * that drives that step: detectHosts() returns host IDs, mcpTargets() returns config file
 * locations, and the setup step filters the latter by the former so it only offers to write
 * config a host here will actually read.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { detectHosts, mcpTargets } from '../../src/integrate/adapters.mjs';

/** A throwaway repo root with optional host marker directories. */
async function tmpRepo(markers = []) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-setup-mcp-'));
  for (const m of markers) {
    const p = path.join(tmp, m);
    await fs.mkdir(path.dirname(p), { recursive: true }).catch(() => {});
    await fs.writeFile(p, '{}').catch(() => {});
  }
  return tmp;
}

test('setup-mcp: detectHosts returns {all, project, user} with host IDs', async () => {
  const tmp = await tmpRepo(['.cursor/mcp.json']);
  try {
    const detected = await detectHosts(tmp, tmp);
    assert.ok(Array.isArray(detected.all));
    assert.ok(Array.isArray(detected.project));
    assert.ok(Array.isArray(detected.user));
    assert.ok(detected.all.includes('cursor'), 'cursor must be detected from .cursor/mcp.json');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('setup-mcp: mcpTargets filtered by detected hosts yields only relevant config files', async () => {
  // Detection markers (from hosts.mjs): cursor -> .cursor, claude-code -> .claude.
  // The MCP config FILES are different (.cursor/mcp.json, .mcp.json) — the setup step maps
  // detected host IDs to their config file locations via mcpTargets().
  const tmp = await tmpRepo(['.cursor/mcp.json', '.claude/settings.json']);
  try {
    const detected = await detectHosts(tmp, tmp);
    assert.ok(detected.all.includes('cursor'));
    assert.ok(detected.all.includes('claude-code'));
    const targets = mcpTargets(tmp).filter((t) => detected.all.includes(t.host));
    const hosts = targets.map((t) => t.host);
    assert.ok(hosts.includes('cursor'), 'cursor target must be present');
    assert.ok(hosts.includes('claude-code'), 'claude-code target must be present');
    // Each target has the fields the setup step displays.
    for (const t of targets) {
      assert.ok(t.file, 'every target must have a config file path');
      assert.ok(t.key, 'every target must have a config key');
      assert.ok(t.host, 'every target must have a host name');
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('setup-mcp: a repo with no host markers detects nothing', async () => {
  const tmp = await tmpRepo([]);
  try {
    const detected = await detectHosts(tmp, tmp);
    assert.equal(detected.all.length, 0);
    const targets = mcpTargets(tmp).filter((t) => detected.all.includes(t.host));
    assert.equal(targets.length, 0, 'no detected hosts means no MCP targets to offer');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('setup-mcp: mcpTargets covers the hosts the manifest advertises', async () => {
  // The project-scope target list must include every host that has a project MCP config file.
  // This is the list the setup step iterates; a host missing here would never be offered.
  const tmp = await tmpRepo();
  try {
    const targets = mcpTargets(tmp);
    const hosts = new Set(targets.map((t) => t.host));
    // A representative sample — the hosts holt advertises MCP support for.
    for (const h of ['claude-code', 'cursor', 'vscode', 'opencode', 'codex', 'zed']) {
      assert.ok(hosts.has(h), `mcpTargets must cover ${h}`);
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
