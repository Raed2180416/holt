/**
 * holt — the OpenCode plugin, driven exactly as OpenCode drives it.
 *
 * VERIFIED AGAINST THE REAL HOST, not a doc summary. `opencode debug config` on a repo where
 * `holt integrate` had run shows:
 *
 *   "plugin": ["file:///…/.opencode/plugins/holt.js"],
 *   "plugin_origins": [{ "spec": "…", "source": "…/.opencode", "scope": "local" }]
 *
 * so the file is genuinely discovered and loaded. An earlier revision wrote to
 * `.opencode/plugin/` (singular) — silently ignored: the file exists, looks installed, and never
 * runs. That is the worst possible failure for a safety gate, so the plural path is asserted here.
 *
 * These tests import the generated plugin the same way OpenCode does (dynamic import of a file
 * URL), call the factory with the real context shape `{project, client, $, directory, worktree}`,
 * and drive `tool.execute.before` with real tool-call payloads. Deterministic on purpose: a live
 * model run cannot be made to reliably attempt a destructive command, and cannot reach the
 * failure branches at all.
 */

import os from 'node:os';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { standardFixture } from '../fixtures.mjs';
import { opencodePlugin, installOpenCode } from '../../src/integrate/adapters.mjs';

const HOLT_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'holt.mjs');
const BIN_CMD = `${process.execPath} ${HOLT_BIN}`;

/** Load the generated plugin the way OpenCode does, and instantiate its hooks. */
async function loadPlugin(repoRoot, { bin = BIN_CMD } = {}) {
  const { path: file } = await installOpenCode(repoRoot, { bin });
  assert.ok(file.includes(`${path.sep}plugins${path.sep}`),
    `plugin must be written to .opencode/plugins/ (plural); got ${file}`);

  // Cache-bust so each test gets a fresh module instance.
  const mod = await import(`file://${file}?t=${Math.random().toString(36).slice(2)}`);
  assert.equal(typeof mod.holt, 'function', 'plugin must export an async factory named holt');

  const ctx = {
    project: { id: 'test-project' },
    client: {},
    $: () => { throw new Error('the plugin must not use the shell directly'); },
    directory: repoRoot,
    worktree: repoRoot,
  };
  const hooks = await mod.holt(ctx);
  return { hooks, file };
}

/** Drive tool.execute.before the way OpenCode does. Returns the thrown error, or null. */
async function callBefore(hooks, tool, args) {
  try {
    await hooks['tool.execute.before']({ tool }, { args });
    return null;
  } catch (err) {
    return err;
  }
}

test('OPENCODE: the plugin is written where OpenCode actually looks', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const { file } = await loadPlugin(fx.root);
  const rel = path.relative(fx.root, file);
  assert.equal(rel, path.join('.opencode', 'plugins', 'holt.js'),
    'OpenCode loads .opencode/plugins/ — the singular form is silently ignored');
  await fs.access(file);
});

test('OPENCODE: the plugin exposes the hooks OpenCode calls', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const { hooks } = await loadPlugin(fx.root);
  assert.equal(typeof hooks['tool.execute.before'], 'function', 'missing tool.execute.before');
  assert.equal(typeof hooks.event, 'function', 'missing event hook');
});

test('OPENCODE: a destructive command THROWS, naming what would be lost', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const { hooks } = await loadPlugin(fx.root);
  const err = await callBefore(hooks, 'bash', {
    command: `git worktree remove ${fx.wt('uniqueUncommitted')}`,
  });

  // OpenCode has no permissionDecision channel — throwing IS the deny mechanism.
  assert.ok(err, 'the plugin must throw to block the tool call');
  assert.match(err.message, /UNCOMMITTED_ONLY_SYMBOL/,
    `the thrown message must name the symbol at risk, got: ${err.message}`);
});

test('OPENCODE: a harmless command does NOT throw', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const { hooks } = await loadPlugin(fx.root);
  for (const command of ['npm test', 'git status', 'ls -la', 'git worktree list']) {
    const err = await callBefore(hooks, 'bash', { command });
    assert.equal(err, null, `'${command}' must not be blocked, got: ${err?.message}`);
  }
});

test('OPENCODE: deleting a genuinely empty worktree is allowed', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const { hooks } = await loadPlugin(fx.root);
  const err = await callBefore(hooks, 'bash', { command: `git worktree remove ${fx.wt('empty')}` });
  assert.equal(err, null, `an empty worktree must be removable, got: ${err?.message}`);
});

test('OPENCODE: alternate arg shapes are handled, not silently ignored', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const { hooks } = await loadPlugin(fx.root);
  const target = fx.wt('uniqueUncommitted');

  // OpenCode's shell tool arg has been `command` and `cmd`; an array form also occurs.
  // A gate that only understood one shape would fail OPEN on the others.
  for (const args of [
    { command: `git worktree remove ${target}` },
    { cmd: `git worktree remove ${target}` },
    { command: ['git', 'worktree', 'remove', target] },
  ]) {
    const err = await callBefore(hooks, 'bash', args);
    assert.ok(err, `arg shape ${JSON.stringify(Object.keys(args))} was not inspected — gate failed open`);
  }
});

test('OPENCODE: a tool call with no command is ignored without error', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const { hooks } = await loadPlugin(fx.root);
  assert.equal(await callBefore(hooks, 'read', { filePath: 'README.md' }), null);
  assert.equal(await callBefore(hooks, 'bash', {}), null);
  assert.equal(await callBefore(hooks, 'edit', { filePath: 'x', old: 'a', new: 'b' }), null);
});

test('OPENCODE: when holt is broken the plugin fails open — but says so LOUDLY', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  // Point the plugin at a binary that does not exist. A safety tool that bricks the agent when
  // it breaks is worse than one that is absent — fail open on OUR failure, closed on real risk.
  const { hooks } = await loadPlugin(fx.root, { bin: '/nonexistent/holt-binary-that-is-not-there' });

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  let err;
  try {
    err = await callBefore(hooks, 'bash', {
      command: `git worktree remove ${fx.wt('uniqueUncommitted')}`,
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(err, null, 'a broken holt must not block the agent from working');
  // Silence here is the actual danger: the user believes deletions are gated when they are not.
  assert.ok(warnings.some((w) => /gate INACTIVE/.test(w)),
    `a failed-open gate MUST announce itself; warnings were: ${JSON.stringify(warnings)}`);
});

test('OPENCODE: the session hook emits a brief when there is something to say', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const { hooks } = await loadPlugin(fx.root);
  const logs = [];
  const original = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    await hooks.event({ event: { type: 'session.created' } });
  } finally {
    console.log = original;
  }

  assert.ok(logs.length > 0, 'a repo with at-risk work must produce a session brief');
  assert.match(logs.join('\n'), /holt/);
});

test('OPENCODE: unrelated events produce nothing', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const { hooks } = await loadPlugin(fx.root);
  const logs = [];
  const original = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    await hooks.event({ event: { type: 'message.updated' } });
    await hooks.event({ event: {} });
    await hooks.event({});
  } finally {
    console.log = original;
  }
  assert.equal(logs.length, 0, 'only session.created should emit');
});

test('OPENCODE: the generated plugin has no imports OpenCode cannot resolve', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const src = opencodePlugin('holt');
  // Anything beyond node builtins would have to be installed next to the plugin, which
  // `holt integrate` does not do — so it would fail at load time in a real session.
  const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
  for (const spec of imports) {
    assert.ok(spec.startsWith('node:'),
      `plugin imports '${spec}' — only node builtins are safe here`);
  }
});

test('OPENCODE: opencode itself loads the plugin (skips if opencode is absent)', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());
  await loadPlugin(fx.root);

  const probe = await new Promise((resolve) => {
    execFile('opencode', ['debug', 'config'], {
      cwd: fx.root, timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
    }, (err, stdout) => resolve({ ok: !err, stdout: String(stdout ?? '') }));
  });

  if (!probe.ok) return t.skip('opencode not installed or not runnable here');

  let cfg;
  try { cfg = JSON.parse(probe.stdout); } catch { return t.skip('opencode debug config was not JSON'); }

  const plugins = JSON.stringify(cfg.plugin ?? []) + JSON.stringify(cfg.plugin_origins ?? []);
  assert.match(plugins, /holt\.js/,
    `opencode did not discover the plugin. Resolved plugin config: ${plugins.slice(0, 400)}`);
});

test('OPENCODE DIALECT: the plugin loads in a repo that is NOT a type:module Node project', async (t) => {
  // MEASURED FAILURE. The plugin was always emitted as ESM. Node decides a `.js` file's dialect
  // from the NEAREST package.json, and anything other than `"type": "module"` — a package.json
  // without the field, or no package.json at all — makes it CommonJS. So in every Python, Go,
  // Rust and Java repository, and most JS ones, Node threw "Cannot use import statement outside a
  // module" and the plugin never loaded.
  //
  // opencode is one of only TWO hosts where holt blocks deterministically, so half the enforcement
  // coverage was silently absent while `holt integrate` reported success and the file sat there
  // looking installed. The worst kind of wrong.
  //
  // `.mjs` would be unambiguous and does load — but opencode does not DISCOVER `.mjs` plugins,
  // measured with a positive control (the same file as holt.js appears in `opencode debug config`
  // and as holt.mjs does not). So the dialect moves, never the filename.
  const { installOpenCode } = await import('../../src/integrate/adapters.mjs');
  const dir = await fs.mkdtemp(path.join(process.env.HOLT_TMPDIR || os.tmpdir(), 'holt-cjs-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await installOpenCode(dir, { bin: 'holt' });

  const file = path.join(dir, '.opencode', 'plugins', 'holt.js');
  const src = await fs.readFile(file, 'utf8');
  assert.doesNotMatch(src, /^import\s/m,
    'a repo with no package.json gets CommonJS — ESM syntax there is a load failure, not a style choice');
  assert.match(src, /module\.exports/, 'and it must export the way CommonJS does');

  // The assertion that matters is that NODE ITSELF loads it, not that the text looks right.
  const { createRequire } = await import('node:module');
  const loaded = createRequire(path.join(dir, 'noop.js'))(file);
  assert.equal(typeof loaded.holt, 'function', 'the plugin must actually load and export its hook');
});

test('OPENCODE DIALECT: a type:module repo still gets ESM, and still loads', async (t) => {
  // Never-worse. The repos that worked before must keep working, in the dialect they declare.
  const { installOpenCode } = await import('../../src/integrate/adapters.mjs');
  const { pathToFileURL } = await import('node:url');
  const dir = await fs.mkdtemp(path.join(process.env.HOLT_TMPDIR || os.tmpdir(), 'holt-esm-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'package.json'), '{"name":"x","type":"module"}\n');
  await installOpenCode(dir, { bin: 'holt' });

  const file = path.join(dir, '.opencode', 'plugins', 'holt.js');
  assert.match(await fs.readFile(file, 'utf8'), /^import\s/m, 'a type:module repo gets ESM');
  const loaded = await import(pathToFileURL(file).href);
  assert.equal(typeof loaded.holt, 'function', 'and it must actually load');
});
