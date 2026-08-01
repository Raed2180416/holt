/**
 * holt — the project configuration file.
 *
 * `inferFamily` has always accepted `familyOverrides`, and `MAINTENANCE_FLOOR`/`MAINTENANCE_RATIO`
 * were exported "so a future config surface has one place to override" — with no file format and
 * no loader, that was a phantom feature: documented, reachable only from source, never from a
 * repository. These tests pin the loader's contract:
 *   - absent file -> defaults, silently
 *   - present + valid -> parsed and returned
 *   - present + invalid (bad JSON, wrong shape, unknown key, bad regex) -> throws LOUDLY, never
 *     silently ignored
 *   - every documented key is actually covered
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { newRepo } from '../fixtures.mjs';
import { loadConfig, ConfigError, CONFIG_FILENAME } from '../../src/config.mjs';

test('config: no file present -> found:false, empty config, does not throw', async (t) => {
  const fx = await newRepo('config-absent');
  t.after(() => fx.cleanup());

  const r = await loadConfig(fx.root);
  assert.equal(r.found, false);
  assert.equal(r.path, null);
  assert.deepEqual(r.config, {});
});

test('config: not a git repository -> found:false, never throws', async (t) => {
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'holt-config-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));
  const r = await loadConfig(dir);
  assert.equal(r.found, false);
  assert.deepEqual(r.config, {});
});

test('config: valid file -> familyOverrides parsed and returned', async (t) => {
  const fx = await newRepo('config-valid-family');
  t.after(() => fx.cleanup());
  await fx.write(CONFIG_FILENAME, JSON.stringify({ familyOverrides: ['^(shard-\\d+)-.*$'] }));

  const r = await loadConfig(fx.root);
  assert.equal(r.found, true);
  assert.equal(r.path, path.join(fx.root, CONFIG_FILENAME));
  assert.deepEqual(r.config.familyOverrides, ['^(shard-\\d+)-.*$']);
});

test('config: valid file -> maintenanceFloor / maintenanceRatio parsed and returned', async (t) => {
  const fx = await newRepo('config-valid-maintenance');
  t.after(() => fx.cleanup());
  await fx.write(CONFIG_FILENAME, JSON.stringify({ maintenanceFloor: 10, maintenanceRatio: 0.5 }));

  const r = await loadConfig(fx.root);
  assert.equal(r.found, true);
  assert.equal(r.config.maintenanceFloor, 10);
  assert.equal(r.config.maintenanceRatio, 0.5);
});

test('config: read from the MAIN worktree root even when invoked from a linked worktree', async (t) => {
  const fx = await newRepo('config-from-worktree');
  t.after(() => fx.cleanup());
  await fx.write(CONFIG_FILENAME, JSON.stringify({ maintenanceFloor: 3 }));
  const wt = await fx.worktree('child');

  const r = await loadConfig(wt);
  assert.equal(r.found, true);
  assert.equal(r.path, path.join(fx.root, CONFIG_FILENAME));
  assert.equal(r.config.maintenanceFloor, 3);
});

/* ------------------------------------------------ loud failure, never silent ---- */

test('config: invalid JSON -> throws ConfigError naming the file, never silently ignored', async (t) => {
  const fx = await newRepo('config-bad-json');
  t.after(() => fx.cleanup());
  await fx.write(CONFIG_FILENAME, '{ not valid json ,, ');

  await assert.rejects(() => loadConfig(fx.root), (e) => {
    assert.ok(e instanceof ConfigError);
    assert.match(e.message, /invalid JSON/);
    assert.match(e.message, new RegExp(CONFIG_FILENAME.replace('.', '\\.')));
    return true;
  });
});

test('config: top-level array instead of object -> throws', async (t) => {
  const fx = await newRepo('config-bad-shape-array');
  t.after(() => fx.cleanup());
  await fx.write(CONFIG_FILENAME, '[1, 2, 3]');

  await assert.rejects(() => loadConfig(fx.root), ConfigError);
});

test('config: unknown key -> throws naming the offending key', async (t) => {
  const fx = await newRepo('config-unknown-key');
  t.after(() => fx.cleanup());
  await fx.write(CONFIG_FILENAME, JSON.stringify({ totallyMadeUp: true }));

  await assert.rejects(() => loadConfig(fx.root), (e) => {
    assert.ok(e instanceof ConfigError);
    assert.match(e.message, /totallyMadeUp/);
    return true;
  });
});

test('config: familyOverrides not an array of strings -> throws', async (t) => {
  const fx = await newRepo('config-bad-family-type');
  t.after(() => fx.cleanup());
  await fx.write(CONFIG_FILENAME, JSON.stringify({ familyOverrides: [123] }));

  await assert.rejects(() => loadConfig(fx.root), ConfigError);
});

test('config: familyOverrides with an invalid regex -> throws naming the bad pattern', async (t) => {
  const fx = await newRepo('config-bad-regex');
  t.after(() => fx.cleanup());
  await fx.write(CONFIG_FILENAME, JSON.stringify({ familyOverrides: ['(unclosed'] }));

  await assert.rejects(() => loadConfig(fx.root), (e) => {
    assert.ok(e instanceof ConfigError);
    assert.match(e.message, /unclosed/);
    return true;
  });
});

test('config: maintenanceFloor not a non-negative integer -> throws', async (t) => {
  const fx = await newRepo('config-bad-floor');
  t.after(() => fx.cleanup());
  await fx.write(CONFIG_FILENAME, JSON.stringify({ maintenanceFloor: -1 }));
  await assert.rejects(() => loadConfig(fx.root), ConfigError);

  const fx2 = await newRepo('config-bad-floor-2');
  t.after(() => fx2.cleanup());
  await fx2.write(CONFIG_FILENAME, JSON.stringify({ maintenanceFloor: 1.5 }));
  await assert.rejects(() => loadConfig(fx2.root), ConfigError);
});

test('config: maintenanceRatio outside [0,1] -> throws', async (t) => {
  const fx = await newRepo('config-bad-ratio');
  t.after(() => fx.cleanup());
  await fx.write(CONFIG_FILENAME, JSON.stringify({ maintenanceRatio: 1.5 }));
  await assert.rejects(() => loadConfig(fx.root), ConfigError);
});
