// SPDX-License-Identifier: FSL-1.1-MIT

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  antigravityHooks,
  detectHosts,
  formatContext,
  formatVerdict,
  installAntigravityHooks,
  installMcp,
  uninstall,
} from '../../src/integrate/adapters.mjs';
import { inspectWorktreeActivation } from '../../src/integrate/activation-integrity.mjs';
import { newRepo } from '../fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = path.join(ROOT, 'bin', 'holt.mjs');

async function scratch(t, label) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `holt-antigravity-${label}-`));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('Antigravity installs proactive context without an authority-granting PreToolUse hook', () => {
  const hooks = antigravityHooks('holt');
  const names = Object.keys(hooks);
  assert.deepEqual(names, ['holt-workstream-context-v1']);
  const ours = hooks[names[0]];
  assert.ok(Array.isArray(ours.PreInvocation));
  assert.match(ours.PreInvocation[0].command,
    /^holt hook pre-invocation --autoprotect --host antigravity$/);
  assert.ok(!('PreToolUse' in ours),
    'an unproved allow response could bypass native permissions and must not be installed');

  assert.deepEqual(formatContext('fresh sibling evidence', {
    host: 'antigravity', eventName: 'PreInvocation',
  }), { injectSteps: [{ ephemeralMessage: 'fresh sibling evidence' }] });
  assert.deepEqual(formatContext(null, { host: 'antigravity', eventName: 'PreInvocation' }), {});
  assert.equal(formatVerdict({ decision: 'deny', reason: 'stop' }, { host: 'antigravity' }).decision, 'deny');
  assert.equal(formatVerdict({ decision: 'allow' }, { host: 'antigravity' }).decision, 'ask',
    'Holt must not translate its narrow allow into Antigravity auto-approval');
});

test('Antigravity project install preserves JSONC and refuses a foreign occupied namespace', async (t) => {
  const root = await scratch(t, 'merge');
  const file = path.join(root, '.agents', 'hooks.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '{\n  // team lifecycle policy\n  "company-lint": {"PreInvocation": [{"command": "acme check"}]}\n}\n');

  const installed = await installAntigravityHooks(root, { bin: 'holt' });
  assert.match(installed.action, /reconciled/);
  const text = await fs.readFile(file, 'utf8');
  assert.match(text, /team lifecycle policy/);
  const parsed = (await import('jsonc-parser')).parse(text);
  assert.equal(parsed['company-lint'].PreInvocation[0].command, 'acme check');
  assert.match(parsed['holt-workstream-context-v1'].PreInvocation[0].command, /pre-invocation/);

  parsed['holt-workstream-context-v1'] = {
    PreInvocation: [{ command: 'corp-guard hook pre-invocation --host production' }],
  };
  await fs.writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`);
  const refused = await installAntigravityHooks(root, { bin: 'holt' });
  assert.match(refused.action, /skipped.*cannot prove it owns/i);
  assert.match(await fs.readFile(file, 'utf8'), /corp-guard/);
});

test('Antigravity MCP, hook detection, activation diagnostics and uninstall are symmetric', async (t) => {
  const root = await scratch(t, 'roundtrip');
  const home = await scratch(t, 'home');
  await fs.mkdir(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
  await installMcp(root, { bin: 'holt', hosts: ['antigravity'] });
  await installAntigravityHooks(root, { bin: 'holt' });

  const mcp = JSON.parse(await fs.readFile(path.join(root, '.agents', 'mcp_config.json'), 'utf8'));
  assert.deepEqual(mcp.mcpServers.holt, { command: 'holt', args: ['mcp'], env: {} });
  const detected = await detectHosts(root, home);
  assert.ok(detected.project.includes('antigravity'));
  assert.ok(detected.user.includes('antigravity'));

  const activation = await inspectWorktreeActivation(root, { home });
  const row = activation.hosts.find((host) => host.id === 'antigravity');
  assert.equal(row?.projectHook.state, 'configured-on-disk');
  assert.equal(row?.projectMcp.state, 'configured-on-disk');
  assert.equal(row?.loadedState, 'unknown');
  assert.equal(row?.liveProof, false);

  const hookFile = path.join(root, '.agents', 'hooks.json');
  const cfg = JSON.parse(await fs.readFile(hookFile, 'utf8'));
  cfg['team-context'] = { PreInvocation: [{ command: 'acme context' }] };
  await fs.writeFile(hookFile, `${JSON.stringify(cfg, null, 2)}\n`);
  const removed = await uninstall(root, { home });
  assert.ok(removed.some((entry) => entry.adapter === 'antigravity'));
  const remaining = JSON.parse(await fs.readFile(hookFile, 'utf8'));
  assert.ok(!remaining['holt-workstream-context-v1'],
    `uninstall results: ${JSON.stringify(removed)}\nremaining: ${JSON.stringify(remaining)}`);
  assert.equal(remaining['team-context'].PreInvocation[0].command, 'acme context');
  const mcpAfter = await fs.readFile(path.join(root, '.agents', 'mcp_config.json'), 'utf8')
    .catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (mcpAfter != null) assert.doesNotMatch(mcpAfter, /"holt"/);
});

function runHook(root, payload) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [
      BIN, 'hook', 'pre-invocation', '--host', 'antigravity', '--autoprotect', '--cwd', root,
    ], {
      cwd: root,
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1' },
    }, (error, stdout, stderr) => resolve({
      code: error?.code ?? 0, stdout: String(stdout), stderr: String(stderr),
    }));
    child.stdin.end(JSON.stringify(payload));
  });
}

test('Antigravity PreInvocation enters model context and unchanged later invocations stay quiet', async (t) => {
  const fx = await newRepo('antigravity-live-contract');
  t.after(() => fx.cleanup());
  const sibling = await fx.worktree('unique-sibling');
  await fx.write('only-here.txt', 'the only copy\n', sibling);

  const first = await runHook(fx.root, {
    invocationNum: 0,
    initialNumSteps: 0,
    conversationId: 'anti-vacuity-session',
    workspacePaths: [fx.root],
  });
  assert.equal(first.code, 0, first.stderr);
  const body = JSON.parse(first.stdout);
  assert.ok(body.injectSteps?.[0]?.ephemeralMessage,
    `the first invocation must carry real model context: ${first.stdout}`);
  assert.match(body.injectSteps[0].ephemeralMessage, /workstream|unique|only copy|locked/i);

  const later = await runHook(fx.root, {
    invocationNum: 1,
    initialNumSteps: 2,
    conversationId: 'anti-vacuity-session',
    workspacePaths: [fx.root],
  });
  assert.equal(later.code, 0, later.stderr);
  assert.deepEqual(JSON.parse(later.stdout), {},
    'unchanged state must not spend context or annoy the user on every invocation');
});
