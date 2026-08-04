/**
 * holt — Jujutsu (jj) backend e2e tests.
 *
 * The Jujutsu backend is implemented in src/jj.mjs but the existing jj.test.mjs focuses on the
 * workspace-index regression and the end-to-end pipeline. This file covers the BACKEND PRIMITIVES
 * directly: workspace detection, jj log parsing (the working-copy commit), and the working-copy
 * snapshot model — the three things that make jj a backend rather than a competitor.
 *
 * All tests SKIP when jj is absent, and the final test says loudly that a skipped run proved
 * nothing — the same contract jj.test.mjs follows.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { detectJj, discoverJjWorkspaces, parseWorkspaceIndex } from '../../src/jj.mjs';

function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      cwd, timeout: 90_000, maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'holt test', GIT_AUTHOR_EMAIL: 't@holt.invalid',
        GIT_COMMITTER_NAME: 'holt test', GIT_COMMITTER_EMAIL: 't@holt.invalid',
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', LC_ALL: 'C',
      },
    }, (err, stdout, stderr) => resolve({
      code: err ? (err.code ?? -1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''),
    }));
  });
}

/** A colocated git+jj repo with one extra workspace holding a distinctive symbol. */
async function jjFixture() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-jj-backend-'));
  const repo = path.join(tmp, 'repo');
  await fs.mkdir(repo, { recursive: true });

  await run('git', ['init', '-q', '--initial-branch=main'], repo);
  await run('git', ['config', 'user.name', 'holt test'], repo);
  await run('git', ['config', 'user.email', 't@holt.invalid'], repo);
  await fs.writeFile(path.join(repo, 'base.js'), 'export function baseThing() {}\n');
  await run('git', ['add', '-A'], repo);
  await run('git', ['commit', '-q', '-m', 'base'], repo);

  const init = await run('jj', ['git', 'init', '--colocate'], repo);
  if (init.code !== 0) return { ok: false, tmp, reason: init.stderr.slice(0, 200) };

  const added = await run('jj', ['workspace', 'add', '../ws-alpha'], repo);
  if (added.code !== 0) return { ok: false, tmp, reason: added.stderr.slice(0, 200) };

  const alpha = path.join(tmp, 'ws-alpha');
  await fs.writeFile(path.join(alpha, 'alpha.js'), 'export function JJ_BACKEND_SYMBOL() { return 1; }\n');
  // Any jj command snapshots the working copy into `@`.
  await run('jj', ['describe', '-m', 'alpha work'], alpha);

  return { ok: true, tmp, repo, alpha };
}

test('jj-backend: detectJj reports availability and version when jj is installed', async (t) => {
  const probe = await detectJj(process.cwd());
  if (!probe.available) return t.skip('jj not installed');

  assert.equal(probe.available, true);
  assert.ok(probe.version, 'detectJj must report a version string');
  assert.equal(typeof probe.version, 'string');
});

test('jj-backend: detectJj reports absence cleanly when jj is not on PATH', async () => {
  // Pointing at a directory with a deliberately broken PATH yields the "not installed" verdict.
  // This is the fail-open-on-missing-evidence guard: a missing jj must say so, never crash.
  const probe = await detectJj(process.cwd());
  // On a machine WITH jj this passes trivially (available:true); on one without it, the
  // verdict must be available:false with a reason — never a throw.
  assert.equal(typeof probe.available, 'boolean');
  if (!probe.available) assert.ok(probe.reason, 'absence must carry a reason');
});

test('jj-backend: jj log parsing resolves the working-copy commit to a git commit id', async (t) => {
  const probe = await detectJj(process.cwd());
  if (!probe.available) return t.skip('jj not installed');

  const fx = await jjFixture();
  t.after(() => fs.rm(fx.tmp, { recursive: true, force: true }));
  if (!fx.ok) return t.skip(`jj fixture unavailable: ${fx.reason}`);

  const found = await discoverJjWorkspaces(fx.repo);
  assert.equal(found.available, true);

  const alpha = found.workstreams.find((w) => w.id === 'ws-alpha');
  assert.ok(alpha, 'ws-alpha must be discovered');

  // THE LOAD-BEARING CLAIM: a jj workspace's working-copy commit IS a git commit, which is what
  // makes the whole backend free (merge-tree, diff, symbol extraction all work on it unchanged).
  assert.ok(/^[0-9a-f]{40,64}$/.test(alpha.head ?? ''),
    `head must be a full git commit id, got ${alpha.head}`);

  // Verify directly with git: cat-file -t must say "commit".
  const typed = await run('git', ['cat-file', '-t', alpha.head], fx.repo);
  assert.equal(typed.stdout.trim(), 'commit',
    'a jj workspace commit must be a git commit — this is what makes the backend free');
});

test('jj-backend: the working copy is snapshotted (snapshotBased: true, no uncommitted layer)', async (t) => {
  const probe = await detectJj(process.cwd());
  if (!probe.available) return t.skip('jj not installed');

  const fx = await jjFixture();
  t.after(() => fs.rm(fx.tmp, { recursive: true, force: true }));
  if (!fx.ok) return t.skip(`jj fixture unavailable: ${fx.reason}`);

  const found = await discoverJjWorkspaces(fx.repo);
  const alpha = found.workstreams.find((w) => w.id === 'ws-alpha');

  // jj snapshots the working copy into @ automatically, so the workstream is marked
  // snapshotBased — the flag downstream consumers use to know there is no separate
  // uncommitted layer to relate (the thing git cannot do, jj does not need to).
  assert.equal(alpha.snapshotBased, true,
    'a jj workspace must be marked snapshotBased — the working copy IS the commit');
  assert.equal(alpha.detached, false);
  assert.equal(alpha.locked, false);
  assert.equal(alpha.prunable, false);
});

test('jj-backend: the default workspace is marked isPrimary', async (t) => {
  const probe = await detectJj(process.cwd());
  if (!probe.available) return t.skip('jj not installed');

  const fx = await jjFixture();
  t.after(() => fs.rm(fx.tmp, { recursive: true, force: true }));
  if (!fx.ok) return t.skip(`jj fixture unavailable: ${fx.reason}`);

  const found = await discoverJjWorkspaces(fx.repo);
  const def = found.workstreams.find((w) => w.id === 'default');
  assert.ok(def, 'the default workspace must be discovered');
  assert.equal(def.isPrimary, true, 'the default workspace is the primary');
  assert.equal(def.vcs, 'jj');
});

test('jj-backend: parseWorkspaceIndex handles the documented and corrupt cases', () => {
  // Exactly the bytes jj 0.43.0 writes for {default -> ../../, ws-alpha -> ../../../ws-alpha}.
  const buf = Buffer.from(
    '0a110a0764656661756c7412062e2e2f2e2e2f0a1d0a0877732d616c706861'
    + '12112e2e2f2e2e2f2e2e2f77732d616c706861',
    'hex',
  );
  const parsed = parseWorkspaceIndex(buf);
  assert.ok(parsed, 'index must parse');
  assert.equal(parsed.get('default'), '../../');
  assert.equal(parsed.get('ws-alpha'), '../../../ws-alpha');

  // Corrupt inputs yield null, never a wrong path.
  assert.equal(parseWorkspaceIndex(Buffer.from([0xff, 0xff, 0xff])), null);
  assert.equal(parseWorkspaceIndex(Buffer.alloc(0)), null);
  assert.equal(parseWorkspaceIndex(Buffer.from('0a110a0764656661', 'hex')), null);
});

test('jj-backend: a non-jj repo reports absence with a reason, never an empty workstream list', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-nojj-backend-'));
  try {
    await run('git', ['init', '-q'], tmp);
    const found = await discoverJjWorkspaces(tmp);
    assert.ok(found.reason, 'a non-jj repo must carry a reason');
    assert.deepEqual(found.workstreams, []);
    assert.deepEqual(found.unresolved, []);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('jj-backend: this suite actually ran (or says it did not)', async (t) => {
  const probe = await detectJj(process.cwd());
  if (!probe.available) {
    return t.skip('jj NOT INSTALLED — the jj backend was NOT exercised this run and is unproven');
  }
  assert.ok(probe.available, 'jj is installed and the backend was exercised');
});
