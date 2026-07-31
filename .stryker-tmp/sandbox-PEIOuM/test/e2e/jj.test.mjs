/**
 * grove — the Jujutsu backend.
 *
 * grove claims to be VCS-agnostic. That claim was FALSE for its first several revisions and
 * nothing caught it, because jj was not installed and the code path never executed once. When it
 * finally ran, every jj workspace came back "working directory missing" — a total, silent
 * failure of an advertised feature. These tests exist so that cannot recur.
 *
 * They SKIP when jj is absent, and the final test says loudly that a skipped run proved nothing.
 */
// @ts-nocheck


import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { detectJj, discoverJjWorkspaces, parseWorkspaceIndex } from '../../src/jj.mjs';
import { discover } from '../../src/discover.mjs';
import { scan } from '../../src/scan.mjs';
import { analyze } from '../../src/analyze.mjs';

function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      cwd, timeout: 90_000, maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'grove test', GIT_AUTHOR_EMAIL: 't@grove.invalid',
        GIT_COMMITTER_NAME: 'grove test', GIT_COMMITTER_EMAIL: 't@grove.invalid',
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', LC_ALL: 'C',
      },
    }, (err, stdout, stderr) => resolve({
      code: err ? (err.code ?? -1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''),
    }));
  });
}

/** A colocated git+jj repo with one extra workspace holding a distinctive symbol. */
async function jjFixture() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'grove-jj-'));
  const repo = path.join(tmp, 'repo');
  await fs.mkdir(repo, { recursive: true });

  await run('git', ['init', '-q', '--initial-branch=main'], repo);
  await run('git', ['config', 'user.name', 'grove test'], repo);
  await run('git', ['config', 'user.email', 't@grove.invalid'], repo);
  await fs.writeFile(path.join(repo, 'base.js'), 'export function baseThing() {}\n');
  await run('git', ['add', '-A'], repo);
  await run('git', ['commit', '-q', '-m', 'base'], repo);

  const init = await run('jj', ['git', 'init', '--colocate'], repo);
  if (init.code !== 0) return { ok: false, tmp, reason: init.stderr.slice(0, 200) };

  const added = await run('jj', ['workspace', 'add', '../ws-alpha'], repo);
  if (added.code !== 0) return { ok: false, tmp, reason: added.stderr.slice(0, 200) };

  const alpha = path.join(tmp, 'ws-alpha');
  await fs.writeFile(path.join(alpha, 'alpha.js'), 'export function JJ_UNIQUE_SYMBOL() { return 1; }\n');
  // Any jj command snapshots the working copy into `@`.
  await run('jj', ['describe', '-m', 'alpha work'], alpha);

  return { ok: true, tmp, repo, alpha };
}

test('jj: the workspace index protobuf parses to name -> path', () => {
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
});

test('jj: a corrupt index yields null, never a wrong path', () => {
  assert.equal(parseWorkspaceIndex(Buffer.from([0xff, 0xff, 0xff])), null);
  assert.equal(parseWorkspaceIndex(Buffer.alloc(0)), null);
  // Truncated mid-string: must not return a half-read path.
  assert.equal(parseWorkspaceIndex(Buffer.from('0a110a0764656661', 'hex')), null);
});

test('jj: workspaces are discovered WITH RESOLVED PATHS', async (t) => {
  const probe = await detectJj(process.cwd());
  if (!probe.available) return t.skip('jj not installed');

  const fx = await jjFixture();
  t.after(() => fs.rm(fx.tmp, { recursive: true, force: true }));
  if (!fx.ok) return t.skip(`jj fixture unavailable: ${fx.reason}`);

  const found = await discoverJjWorkspaces(fx.repo);
  assert.equal(found.available, true);
  assert.deepEqual(found.unresolved, [], `every workspace must resolve: ${JSON.stringify(found.unresolved)}`);

  const alpha = found.workstreams.find((w) => w.id === 'ws-alpha');
  assert.ok(alpha, `ws-alpha not discovered (got ${found.workstreams.map((w) => w.id).join(', ')})`);

  // The regression that shipped: path was a change-id, not a directory.
  assert.ok(path.isAbsolute(alpha.path), `path must be absolute, got ${alpha.path}`);
  const st = await fs.stat(alpha.path);
  assert.ok(st.isDirectory(), 'the resolved path must be a real directory');
  assert.ok(/^[0-9a-f]{40,64}$/.test(alpha.head ?? ''), `head must be a git commit id, got ${alpha.head}`);
});

test('jj: the workspace commit IS a git commit, so the whole pipeline works on it', async (t) => {
  const probe = await detectJj(process.cwd());
  if (!probe.available) return t.skip('jj not installed');

  const fx = await jjFixture();
  t.after(() => fs.rm(fx.tmp, { recursive: true, force: true }));
  if (!fx.ok) return t.skip(`jj fixture unavailable: ${fx.reason}`);

  const found = await discoverJjWorkspaces(fx.repo);
  const alpha = found.workstreams.find((w) => w.id === 'ws-alpha');
  const typed = await run('git', ['cat-file', '-t', alpha.head], fx.repo);
  assert.equal(typed.stdout.trim(), 'commit',
    'a jj workspace commit must be a git commit — this is what makes the backend free');
});

test('jj: end-to-end, grove finds the work in a jj workspace', async (t) => {
  const probe = await detectJj(process.cwd());
  if (!probe.available) return t.skip('jj not installed');

  const fx = await jjFixture();
  t.after(() => fs.rm(fx.tmp, { recursive: true, force: true }));
  if (!fx.ok) return t.skip(`jj fixture unavailable: ${fx.reason}`);

  const disc = await discover(fx.repo);
  const report = await analyze(await scan(disc, {}), {});

  assert.equal(report.skipped.length, 0,
    `no jj workspace may be skipped: ${JSON.stringify(report.skipped)}`);

  const alpha = report.unique.find((u) => u.id === 'ws-alpha');
  assert.ok(alpha, `ws-alpha missing from the report (got ${report.unique.map((u) => u.id).join(', ')})`);
  assert.ok(alpha.uniqueSymbols.some((s) => s.endsWith(':JJ_UNIQUE_SYMBOL')),
    `the jj workspace's symbol must be found: ${alpha.uniqueSymbols.join(', ')}`);

  // Under jj the working copy is snapshotted into @, so there is no uncommitted layer at all.
  // Reporting one would mean grove had misunderstood the backend.
  assert.equal(alpha.uncommittedOnlyCount, 0,
    'jj auto-snapshots, so nothing should be classified as uncommitted-only');
  assert.equal(alpha.verdict, 'unique-work-committed');
});

test('jj: reading a jj repo does not mutate it', async (t) => {
  const probe = await detectJj(process.cwd());
  if (!probe.available) return t.skip('jj not installed');

  const fx = await jjFixture();
  t.after(() => fs.rm(fx.tmp, { recursive: true, force: true }));
  if (!fx.ok) return t.skip(`jj fixture unavailable: ${fx.reason}`);

  // jj snapshots the working copy on almost any command, which WRITES. grove passes
  // --ignore-working-copy everywhere; this proves the operation log did not grow.
  const opsBefore = await run('jj', ['op', 'log', '--no-graph', '-T', 'id.short()', '--ignore-working-copy'], fx.repo);

  const disc = await discover(fx.repo);
  await analyze(await scan(disc, {}), {});

  const opsAfter = await run('jj', ['op', 'log', '--no-graph', '-T', 'id.short()', '--ignore-working-copy'], fx.repo);
  assert.equal(opsAfter.stdout, opsBefore.stdout,
    'grove must not append to the jj operation log — that would be a write');
});

test('jj: absence is reported as absence, never as "no workstreams"', async () => {
  // A git-only repo probed for jj must say so explicitly. Silently returning [] here is the
  // fail-open-on-missing-evidence defect grove exists to catch.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'grove-nojj-'));
  try {
    await run('git', ['init', '-q'], tmp);
    const found = await discoverJjWorkspaces(tmp);
    assert.ok(found.reason, 'a non-jj repo must carry a reason');
    assert.deepEqual(found.workstreams, []);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('jj: this suite actually ran (or says it did not)', async (t) => {
  const probe = await detectJj(process.cwd());
  if (!probe.available) {
    return t.skip('jj NOT INSTALLED — the jj backend was NOT exercised this run and is unproven');
  }
  assert.ok(probe.version, 'jj present');
});
