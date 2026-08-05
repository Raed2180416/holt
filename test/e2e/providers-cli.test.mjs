// SPDX-License-Identifier: FSL-1.1-MIT

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../../bin/holt.mjs', import.meta.url));

function holt(args, cwd) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], {
      cwd,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1' },
    }, (error, stdout, stderr) => resolve({
      code: error ? (error.code ?? 1) : 0,
      stdout: String(stdout ?? ''),
      stderr: String(stderr ?? ''),
    }));
  });
}

test('PROVIDERS CLI: human output separates implemented, contract-verified, live-verified, and framework-only', async () => {
  const result = await holt(['providers'], process.cwd());
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Antigravity 2 2\.5\.0/);
  assert.match(result.stdout, /Qwen Code CLI 0\.21\.5/);
  assert.match(result.stdout, /IMPLEMENTED/);
  assert.match(result.stdout, /CONTRACT-VERIFIED/);
  assert.match(result.stdout, /NOT LIVE-VERIFIED/);
  assert.match(result.stdout, /FRAMEWORK ONLY/);
  assert.match(result.stdout, /reactive model-pull/);
  assert.match(result.stdout, /proactive host-push/);
  assert.match(result.stdout, /holt integrate --all-hosts/);
  assert.match(result.stdout, /none — profile \+ conformance plan only/);
  assert.match(result.stdout, /MCP is reactive even when installed/);
});

test('PROVIDERS CLI: JSON exposes install scope and reactive versus proactive capability contracts', async () => {
  const result = await holt(['providers', '--json'], process.cwd());
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);

  assert.deepEqual(report.counts, {
    profiles: 7,
    families: 4,
    implementedAdapters: 2,
    implementedProfiles: 4,
    contractVerifiedProfiles: 4,
    liveVerifiedProfiles: 0,
    frameworkOnlyProfiles: 3,
  });
  assert.ok(report.providers.every((provider) => provider.liveVerified === false));

  const qwen = report.providers.find((provider) => provider.id === 'qwen-code');
  assert.equal(qwen.implementation, 'implemented');
  assert.equal(qwen.verification, 'contract-verified');
  assert.deepEqual(qwen.install.scopes, ['project', 'user']);
  assert.equal(qwen.capabilities.mcp.initiation, 'model-pull');
  assert.equal(qwen.capabilities.mcp.proactive, false);
  assert.deepEqual(qwen.capabilities.mcp.installedScopes, ['project', 'user']);
  assert.equal(qwen.capabilities.lifecycle.initiation, 'host-push');
  assert.equal(qwen.capabilities.lifecycle.proactive, true);
  assert.deepEqual(qwen.capabilities.lifecycle.installedScopes, ['project']);
  assert.deepEqual(qwen.capabilities.preTool.installedScopes, ['project']);

  const antigravity = report.providers.find((provider) => provider.id === 'antigravity-cli');
  assert.equal(antigravity.implementation, 'implemented');
  assert.deepEqual(antigravity.install.scopes, ['project', 'user']);
  assert.deepEqual(antigravity.capabilities.lifecycle.installedScopes, ['project']);
  assert.equal(antigravity.capabilities.preTool.state, 'unsupported');
  assert.deepEqual(antigravity.capabilities.preTool.installedScopes, []);

  for (const id of ['auggie-cli', 'kiro-ide', 'kiro-cli-v3']) {
    const provider = report.providers.find((row) => row.id === id);
    assert.equal(provider.implementation, 'framework-only', id);
    assert.equal(provider.hostId, null, id);
    assert.equal(provider.install.explicitProject, null, id);
    assert.deepEqual(provider.install.scopes, [], id);
    assert.ok(Object.values(provider.capabilities)
      .every((capability) => capability.installedScopes.length === 0), id);
  }
});

test('PROVIDERS CLI: read-only command works outside a Git repository', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-providers-read-only-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const before = await fs.readdir(directory);

  const result = await holt(['providers', '--json'], directory);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).counts.implementedAdapters, 2);
  assert.deepEqual(await fs.readdir(directory), before,
    'provider inventory must not initialize Git or write configuration');
});
