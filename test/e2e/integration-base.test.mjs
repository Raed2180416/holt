// SPDX-License-Identifier: FSL-1.1-MIT

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newRepo } from '../fixtures.mjs';
import { resolveBase } from '../../src/scan.mjs';
import {
  readIntegrationBase, setIntegrationBase, clearIntegrationBase,
} from '../../src/integration-base.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'holt.mjs');

function holt(args, cwd) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], {
      cwd, timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1' },
    }, (error, stdout, stderr) => resolve({
      code: error ? (error.code ?? 1) : 0,
      stdout: String(stdout ?? ''),
      stderr: String(stderr ?? ''),
    }));
  });
}

test('integration base: explicit repository-local authority beats a stale conventional branch', async (t) => {
  const fx = await newRepo('configured-integration-base');
  t.after(() => fx.cleanup());
  await fx.git(['checkout', '-q', '-b', 'integration']);
  await fx.write('integration.txt', 'landed here\n');
  const integrationOid = await fx.commit('advance actual integration branch');

  const automatic = await resolveBase(fx.root, null);
  assert.equal(automatic.ref, 'main', 'premise: the conventional heuristic is stale in this shape');
  assert.notEqual(automatic.oid, integrationOid);

  const written = await setIntegrationBase(fx.root, 'integration');
  assert.equal(written.oid, integrationOid);
  const configured = await resolveBase(fx.root, null);
  assert.deepEqual(
    { ref: configured.ref, oid: configured.oid, how: configured.how },
    { ref: 'integration', oid: integrationOid, how: 'configured-integration' },
  );
  assert.equal((await readIntegrationBase(fx.root)).ref, 'integration');

  const oneShot = await resolveBase(fx.root, 'main');
  assert.equal(oneShot.how, 'explicit', 'one-invocation --base remains the highest authority');
  assert.equal(oneShot.ref, 'main');

  await clearIntegrationBase(fx.root);
  assert.equal(await readIntegrationBase(fx.root), null);
  assert.equal((await resolveBase(fx.root, null)).ref, 'main');
});

test('integration base CLI: set/status/unset is reachable and rejects an unresolved ref', async (t) => {
  const fx = await newRepo('configured-integration-base-cli');
  t.after(() => fx.cleanup());
  await fx.git(['branch', 'landing']);

  const missing = await holt(['base', 'set', 'does-not-exist', '--json', '--cwd', fx.root], fx.root);
  assert.equal(missing.code, 1);
  assert.equal(JSON.parse(missing.stdout).ok, false);
  assert.equal(await readIntegrationBase(fx.root), null, 'a failed set must publish no authority');

  const set = await holt(['base', 'set', 'landing', '--json', '--cwd', fx.root], fx.root);
  assert.equal(set.code, 0, `${set.stdout}${set.stderr}`);
  assert.equal(JSON.parse(set.stdout).configured.ref, 'landing');

  const status = await holt(['base', '--json', '--cwd', fx.root], fx.root);
  assert.equal(status.code, 0, `${status.stdout}${status.stderr}`);
  assert.equal(JSON.parse(status.stdout).resolved.how, 'configured-integration');

  const unset = await holt(['base', 'unset', '--json', '--cwd', fx.root], fx.root);
  assert.equal(unset.code, 0, `${unset.stdout}${unset.stderr}`);
  assert.equal(JSON.parse(unset.stdout).configured, null);
});
