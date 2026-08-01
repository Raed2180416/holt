/**
 * holt — `.holtrc.json` driven through the real CLI binary.
 *
 * test/unit/config.test.mjs pins the loader in isolation. This file proves the wiring: a
 * config file dropped in a real repository actually changes what the CLI reports, and an
 * invalid one fails LOUDLY — as a subprocess exit code and message, not just a thrown JS error
 * nobody catches.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newRepo } from '../fixtures.mjs';
import { CONFIG_FILENAME } from '../../src/config.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'holt.mjs');

function holt(args, cwd) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], {
      cwd, timeout: 60_000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1' },
    }, (err, stdout, stderr) => resolve({
      code: err ? (err.code ?? 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''),
    }));
  });
}

test('config: familyOverrides in .holtrc.json actually changes grouping, end to end', async (t) => {
  const fx = await newRepo('config-e2e-family');
  t.after(() => fx.cleanup());
  await fx.worktree('shard-01-alpha');
  await fx.worktree('shard-01-beta');

  // BASELINE: without a config file, family comes from git provenance (fork point + creation
  // time — see assignFamilies in src/discover.mjs) or, failing that, the built-in name patterns.
  // Neither mechanism can ever produce the literal label "shard-01": provenance labels are
  // `fork:<oid prefix>`, and the name-fallback singleton case is the workstream's own full id.
  // So whatever the baseline says, it is provably NOT the user-override outcome.
  const before = await holt(['context', 'shard-01-alpha', '--cwd', fx.root, '--json'], fx.root);
  assert.equal(before.code, 0, before.stderr);
  const beforeDigest = JSON.parse(before.stdout);
  assert.notEqual(beforeDigest.familyRule, 'user-override');
  assert.notEqual(beforeDigest.family, 'shard-01');

  // A user-declared regex groups them: capture group 1 is the shared family, and it now WINS
  // over provenance (assignFamilies checks familyOverrides before fork+creation-time for every
  // workstream) — the exact behaviour `inferFamily`'s 'user-override' rule always had, now
  // reachable from a file instead of only from a caller passing it in code.
  await fx.write(CONFIG_FILENAME, JSON.stringify({ familyOverrides: ['^(shard-\\d+)-.*$'] }));

  const after = await holt(['context', 'shard-01-alpha', '--cwd', fx.root, '--json'], fx.root);
  assert.equal(after.code, 0, after.stderr);
  const afterDigest = JSON.parse(after.stdout);
  assert.equal(afterDigest.familyRule, 'user-override');
  assert.equal(afterDigest.family, 'shard-01');
  assert.deepEqual(afterDigest.siblings, ['shard-01-beta']);
});

test('config: an unparseable .holtrc.json fails LOUDLY — exit 2, never a silent default', async (t) => {
  const fx = await newRepo('config-e2e-bad-json');
  t.after(() => fx.cleanup());
  await fx.write(CONFIG_FILENAME, '{ this is not json');

  const r = await holt(['status', '--cwd', fx.root], fx.root);
  assert.equal(r.code, 2, `expected exit 2, got ${r.code}. stderr: ${r.stderr}`);
  assert.match(r.stderr, /\.holtrc\.json/);
  assert.match(r.stderr, /invalid JSON/i);
});

test('config: an invalid .holtrc.json fails loudly even under --json (structured, not a stack trace)', async (t) => {
  const fx = await newRepo('config-e2e-bad-json-flag');
  t.after(() => fx.cleanup());
  await fx.write(CONFIG_FILENAME, JSON.stringify({ maintenanceFloor: -5 }));

  const r = await holt(['status', '--cwd', fx.root, '--json'], fx.root);
  assert.equal(r.code, 2, `expected exit 2, got ${r.code}. stdout: ${r.stdout} stderr: ${r.stderr}`);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'bad-config');
  assert.match(payload.reason, /maintenanceFloor/);
});

test('config: absent .holtrc.json changes nothing — status still exits 0', async (t) => {
  const fx = await newRepo('config-e2e-absent');
  t.after(() => fx.cleanup());

  const r = await holt(['status', '--cwd', fx.root, '--json'], fx.root);
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotThrow(() => JSON.parse(r.stdout));
});

test('config: maintenanceFloor/Ratio in .holtrc.json changes when `holt brief` nags', async (t) => {
  const fx = await newRepo('config-e2e-maintenance');
  t.after(() => fx.cleanup());
  // Two disposable worktrees, nothing unique — default floor (5) never fires here.
  await fx.worktree('spent-1');
  await fx.worktree('spent-2');

  const before = await holt(['brief', '--cwd', fx.root], fx.root);
  assert.equal(before.code, 0, before.stderr);
  assert.ok(!/MAINTENANCE/.test(before.stdout), `expected no nag below the default floor, got: ${before.stdout}`);

  await fx.write(CONFIG_FILENAME, JSON.stringify({ maintenanceFloor: 2, maintenanceRatio: 0.1 }));

  const after = await holt(['brief', '--cwd', fx.root], fx.root);
  assert.equal(after.code, 0, after.stderr);
  assert.match(after.stdout, /MAINTENANCE/, `expected the nag once the config lowers the floor to 2, got: ${after.stdout}`);
});
