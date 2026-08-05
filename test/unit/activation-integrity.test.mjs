// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * Activation integrity: on-disk capability is never promoted into runtime proof.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { inspectWorktreeActivation } from '../../src/integrate/activation-integrity.mjs';
import { newRepo } from '../fixtures.mjs';

const BIN = fileURLToPath(new URL('../../bin/holt.mjs', import.meta.url));

async function scratch(t, label) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `holt-activation-${label}-`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function write(root, relative, content) {
  const target = path.join(root, ...relative.split('/'));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

async function isolatedHome(t, label, marker = null) {
  const home = await scratch(t, `${label}-home`);
  if (marker) await fs.mkdir(path.join(home, ...marker.split('/')), { recursive: true });
  return home;
}

async function oneHost(root, host, home) {
  const report = await inspectWorktreeActivation(root, { home });
  const row = report.hosts.find((candidate) => candidate.id === host);
  assert.ok(row, `${host} must be detected in fixture: ${JSON.stringify(report.detectedHosts)}`);
  return row;
}

test('activation: .mcp.json alone is MCP-on-disk, not advisory, hook, trust, load, or live proof', async (t) => {
  const root = await scratch(t, 'mcp-only');
  await write(root, '.mcp.json', JSON.stringify({
    mcpServers: { holt: { command: 'holt', args: ['mcp'] } },
  }));
  const home = await isolatedHome(t, 'mcp-only', '.claude');

  const host = await oneHost(root, 'claude-code', home);
  assert.equal(host.staticAdvisory.state, 'absent');
  assert.equal(host.projectHook.state, 'absent');
  assert.equal(host.projectMcp.state, 'configured-on-disk');
  assert.equal(host.configurationState, 'partial');
  assert.equal(host.loadedState, 'unknown');
  assert.equal(host.trust.state, 'unknown');
  assert.equal(host.liveProof, false);
  assert.equal(host.liveProofState, 'unknown');
});

test('activation: AGENTS.md alone is static advice for a host that reads it, not a hook or MCP server', async (t) => {
  const root = await scratch(t, 'agents-only');
  await write(root, 'AGENTS.md', '# Agent rules\n\nBefore deletion, run `holt gate feature-work`.\n');
  const home = await isolatedHome(t, 'agents-only', '.codex');

  const host = await oneHost(root, 'codex', home);
  assert.equal(host.staticAdvisory.state, 'configured-on-disk');
  assert.equal(host.projectHook.state, 'absent');
  assert.equal(host.projectMcp.state, 'absent');
  assert.equal(host.configurationState, 'partial');
  assert.equal(host.configuredOnDisk, false);
  assert.equal(host.runtimeState, 'unknown');
});

test('activation: another host\'s config does not wire the detected host', async (t) => {
  const root = await scratch(t, 'other-host');
  await write(root, '.cursor/hooks.json', JSON.stringify({
    version: 1,
    hooks: { beforeShellExecution: [{ command: 'holt hook pre-tool-use --host cursor' }] },
  }));
  const home = await isolatedHome(t, 'other-host', '.codex');

  const report = await inspectWorktreeActivation(root, { home });
  const host = report.hosts.find((candidate) => candidate.id === 'codex');
  assert.ok(host, `Codex must be detected from the isolated home: ${JSON.stringify(report.detectedHosts)}`);
  assert.equal(host.staticAdvisory.state, 'absent');
  assert.equal(host.projectHook.state, 'absent', 'Cursor hook must not count as a Codex hook');
  assert.equal(host.projectMcp.state, 'absent');
  assert.equal(host.configurationState, 'absent');
  const cursor = report.hosts.find((candidate) => candidate.id === 'cursor');
  assert.equal(cursor?.projectHook.state, 'configured-on-disk', 'the same file belongs only to Cursor');
});

test('activation: a full current Codex config is configured on disk while trust/runtime/live remain unknown', async (t) => {
  const root = await scratch(t, 'codex-full');
  await write(root, 'AGENTS.md', '# Agent rules\n\n```bash\nholt context current\n```\n');
  await write(root, '.codex/hooks.json', JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'holt hook pre-tool-use --host codex' }] }],
    },
  }));
  await write(root, '.codex/config.toml', '[mcp_servers.holt]\ncommand = "holt"\nargs = ["mcp"]\n');
  const home = await isolatedHome(t, 'codex-full');

  const host = await oneHost(root, 'codex', home);
  assert.equal(host.staticAdvisory.state, 'configured-on-disk');
  assert.equal(host.projectHook.state, 'configured-on-disk');
  assert.equal(host.projectMcp.state, 'configured-on-disk');
  assert.equal(host.configurationState, 'configured-on-disk');
  assert.equal(host.configuredOnDisk, true);
  assert.equal(host.trust.required, true);
  assert.equal(host.trust.state, 'unknown', 'file presence must never infer that Codex trust was granted');
  assert.equal(host.loadedState, 'unknown');
  assert.equal(host.runtimeState, 'unknown');
  assert.equal(host.liveProof, false);
  assert.deepEqual(host.liveProofEvidence, []);
});

test('activation: a current-host file without a Holt command is reported as file-only', async (t) => {
  const root = await scratch(t, 'foreign-command');
  await write(root, '.codex/hooks.json', JSON.stringify({
    description: 'This replaces a retired holt hook pre-tool-use entry; prose is not executable.',
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'acme-guard check' }] }],
    },
  }));
  const home = await isolatedHome(t, 'foreign-command', '.codex');

  const host = await oneHost(root, 'codex', home);
  assert.equal(host.projectHook.present, true);
  assert.equal(host.projectHook.holtCommandPresent, false);
  assert.equal(host.projectHook.state, 'present-without-holt-command');
  assert.deepEqual(host.projectHook.holtCommandPaths, []);
});

function runDoctor(root, json = true) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, 'doctor', ...(json ? ['--json'] : []), '--cwd', root], {
      cwd: root,
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1' },
    }, (error, stdout, stderr) => resolve({
      code: error?.code ?? 0,
      stdout: String(stdout ?? ''),
      stderr: String(stderr ?? ''),
    }));
  });
}

test('doctor exposes per-host activation integrity and keeps unwiredWorktrees only as a compatibility field', async (t) => {
  const fx = await newRepo('activation-doctor');
  t.after(() => fx.cleanup());
  await fx.write('AGENTS.md', '# Agent rules\n\n```bash\nholt status\n```\n');
  await fx.write('.codex/hooks.json', JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'holt hook pre-tool-use --host codex' }] }],
    },
  }));
  await fx.write('.codex/config.toml', '[mcp_servers.holt]\ncommand = "holt"\nargs = ["mcp"]\n');

  const jsonResult = await runDoctor(fx.root);
  assert.equal(jsonResult.code, 0, jsonResult.stderr);
  const doctor = JSON.parse(jsonResult.stdout);
  assert.ok(Array.isArray(doctor.unwiredWorktrees), 'legacy callers keep the array field');
  assert.match(doctor.activationIntegrity.claimBoundary, /not evidence.*loaded.*trusted.*exercised/i);
  assert.match(doctor.activationIntegrity.compatibility.unwiredWorktrees, /not a runtime or enforcement verdict/i);
  const current = doctor.activationIntegrity.worktrees.find((row) => row.id === doctor.activationIntegrity.currentWorktreeId);
  const codex = current.hosts.find((host) => host.id === 'codex');
  assert.ok(codex, `Codex must be detected from .codex: ${JSON.stringify(current.detectedHosts)}`);
  assert.equal(codex.configurationState, 'configured-on-disk');
  assert.equal(codex.liveProof, false);
  assert.equal(codex.runtimeState, 'unknown');

  const human = await runDoctor(fx.root, false);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /AGENT ACTIVATION/);
  assert.match(human.stdout, /configured-on-disk/);
  assert.match(human.stdout, /live proof: no, runtime: unknown/);
  assert.match(human.stdout, /never means the host loaded, trusted, or exercised/);
});
