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
import os from 'node:os';
import path from 'node:path';
import { newRepo } from '../fixtures.mjs';
import { loadConfig, ConfigError, CONFIG_FILENAME } from '../../src/config.mjs';
import { samePathAsync } from '../../src/paths.mjs';

/**
 * Path assertions go through samePathAsync, never strict string equality: loadConfig resolves the
 * main worktree root through git, which returns the CANONICAL path, while the fixture holds the
 * path it was created with. On macOS those differ for every tmpdir fixture (/var/... is a symlink
 * to /private/var/...), and on Windows case and 8.3 short names differ the same way. Raw
 * comparison failed on both CI OSes while testing a loader that was working perfectly — the
 * path-comparison class this repo has now hit on five different surfaces.
 */
const assertSamePath = async (actual, expected, msg) => {
  assert.ok(await samePathAsync(actual, expected),
    `${msg ?? 'paths differ'}: ${actual} vs ${expected}`);
};

test('config: no file present -> found:false, empty config, does not throw', async (t) => {
  const fx = await newRepo('config-absent');
  t.after(() => fx.cleanup());

  const r = await loadConfig(fx.root);
  assert.equal(r.found, false);
  assert.equal(r.path, null);
  assert.deepEqual(r.config, {});
});

test('config: not a git repository -> found:false, never throws', async (t) => {
  // os.tmpdir(), not `TMPDIR ?? '/tmp'`: Windows sets TEMP/TMP and never TMPDIR, so the fallback
  // resolved to a `\tmp` that does not exist and this test died with ENOENT on every Windows run
  // — a portability defect in the fixture reported as a failure of the code under test.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-config-'));
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
  await assertSamePath(r.path, path.join(fx.root, CONFIG_FILENAME), 'config path');
  assert.deepEqual(r.config.familyOverrides, ['^(shard-\\d+)-.*$']);
});

test('config: valid guardAllow patterns are parsed and returned', async (t) => {
  const fx = await newRepo('config-valid-guard-allow');
  t.after(() => fx.cleanup());
  await fx.write(CONFIG_FILENAME, JSON.stringify({ guardAllow: ['^git status$', '^rm -rf /tmp/'] }));

  const r = await loadConfig(fx.root);
  assert.deepEqual(r.config.guardAllow, ['^git status$', '^rm -rf /tmp/']);
});

test('config: guardAllow must be an array of valid regex strings', async (t) => {
  const fx = await newRepo('config-bad-guard-allow');
  t.after(() => fx.cleanup());
  await fx.write(CONFIG_FILENAME, JSON.stringify({ guardAllow: [123] }));
  await assert.rejects(() => loadConfig(fx.root), ConfigError);

  await fx.write(CONFIG_FILENAME, JSON.stringify({ guardAllow: ['['] }));
  await assert.rejects(() => loadConfig(fx.root), ConfigError);
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
  await assertSamePath(r.path, path.join(fx.root, CONFIG_FILENAME), 'config path from linked worktree');
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

test('config: unknown key -> warns (does not throw), config still loads', async (t) => {
  const fx = await newRepo('config-unknown-key');
  t.after(() => fx.cleanup());
  await fx.write(CONFIG_FILENAME, JSON.stringify({ totallyMadeUp: true }));

  // Unknown keys produce a WARNING, not an error. The guard must not die on a typo or a
  // future key holt doesn't know about yet. The config still loads (with defaults for the
  // unknown key, which is ignored).
  const result = await loadConfig(fx.root);
  assert.equal(result.found, true);
  assert.ok(result.warnings.length > 0, 'unknown key must produce a warning');
  assert.match(result.warnings[0].message, /totallyMadeUp/);
  assert.match(result.warnings[0].message, /ignored/);
});

test('config: $schema key is silently ignored (no warning, no error)', async (t) => {
  const fx = await newRepo('config-schema-key');
  t.after(() => fx.cleanup());
  await fx.write(CONFIG_FILENAME, JSON.stringify({
    $schema: 'https://example.com/holtrc.schema.json',
    familyOverrides: ['test-.*'],
  }));

  const result = await loadConfig(fx.root);
  assert.equal(result.found, true);
  assert.equal(result.warnings.length, 0, '$schema must not produce a warning');
  assert.deepEqual(result.config.familyOverrides, ['test-.*']);
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

/**
 * A CONFIG FILE A TEAMMATE COMMITS MUST NOT BE ABLE TO FREEZE THE GUARD.
 *
 * REPRODUCED: `.holtrc.json` containing `{"familyOverrides": ["^(a+)+$"]}`, plus a worktree named
 * `aaaa…aaaX`, made `holt status` hang indefinitely — and every command that reads config hangs
 * the same way, INCLUDING the blocking PreToolUse hook. An agent frozen forever.
 *
 * `inferFamily` already wraps the match in try/catch and that does not help: catastrophic
 * backtracking is not an exception, it is an unbounded loop inside a single atomic `String.match`
 * that nothing in JavaScript can interrupt. There is no way to time-bound a native RegExp, so the
 * pattern has to be refused BEFORE it is ever run.
 */
test('CONFIG: a pattern that can hang is declined, and the rest still apply', async (t) => {
  const fx = await newRepo('config-redos');
  t.after(() => fx.cleanup());
  await fx.write(CONFIG_FILENAME, JSON.stringify({
    familyOverrides: ['^(a+)+$', '^(shard-\\d+)-.*$'],
  }));

  const errs = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { errs.push(String(s)); return true; };
  let r;
  try { r = await loadConfig(fx.root); } finally { process.stderr.write = realWrite; }

  assert.deepEqual(r.config.familyOverrides, ['^(shard-\\d+)-.*$'],
    'the dangerous entry is dropped and the safe one survives');
  assert.match(errs.join(''), /nested quantifier/i,
    `and holt says which pattern it declined and why: ${errs.join('')}`);
  assert.match(errs.join(''), /\^\(a\+\)\+\$/, 'naming the exact pattern');
});

test('CONFIG: ANTI-VACUITY — the detector flags the dangerous shapes and no ordinary ones', async () => {
  const { hasNestedQuantifier } = await import('../../src/config.mjs');
  // A group that is itself quantified AND whose body already contains a quantifier.
  for (const bad of ['^(a+)+$', '(x*)*', '([a-z]+)*', '(\\d{2,}){3,}', '^(?:a+)+$']) {
    assert.equal(hasNestedQuantifier(bad), true, `must be declined: ${bad}`);
  }
  // Ordinary grouping has exactly one of the two halves, and must be untouched — a detector that
  // rejected these would break the feature it is protecting.
  for (const ok of [
    '^(feat)-(\\d+)$', '(abc)+', '(a|b)+', '(\\d+)',
    '^wf_([0-9a-f]+)-\\d+$', '^(shard-\\d+)-.*$', '^agent-([a-z]+)$',
  ]) {
    assert.equal(hasNestedQuantifier(ok), false, `must be allowed: ${ok}`);
  }
});
