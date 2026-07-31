/**
 * grove — the safety contract, proven rather than asserted.
 *
 * grove's headline promise is that it never modifies the repository it inspects. That promise
 * is worth nothing as prose. These tests exercise the classifier directly AND run a full scan
 * against a real repository, then verify byte-for-byte that nothing in the repo changed.
 *
 * The scan runs against a repo containing UNCOMMITTED work specifically, because that is the
 * state a user is most afraid of losing and the state a careless tool would clobber.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { classify, git, GitRefused } from '../../src/git.mjs';
import { standardFixture } from '../fixtures.mjs';
import { discover } from '../../src/discover.mjs';
import { scan } from '../../src/scan.mjs';
import { analyze } from '../../src/analyze.mjs';

/* ------------------------------------------------------------- classifier ---- */

test('classifier: refuses every destructive git command', () => {
  const mustRefuse = [
    ['reset', '--hard'],
    ['checkout', '--', '.'],
    ['stash'],
    ['stash', 'push'],
    ['push', 'origin', 'main'],
    ['clean', '-fd'],
    ['commit', '-m', 'x'],
    ['merge', 'other'],
    ['rebase', 'main'],
    ['cherry-pick', 'abc'],
    ['revert', 'abc'],
    ['am', 'patch'],
    ['apply', 'patch'],
    ['rm', '-r', 'src'],
    ['mv', 'a', 'b'],
    ['gc', '--prune=now'],
    ['fetch'],
    ['pull'],
    ['remote', 'add', 'x', 'y'],
    ['update-ref', 'refs/heads/main', 'abc'],
  ];
  for (const argv of mustRefuse) {
    const v = classify(argv);
    assert.equal(v.allowed, false, `git ${argv.join(' ')} MUST be refused, got ${JSON.stringify(v)}`);
  }
});

test('classifier: refuses WRITE forms that differ from reads only by positional count', () => {
  // Found by this test against an earlier flag-only allowlist, which let all three through.
  const mustRefuse = [
    ['symbolic-ref', 'HEAD', 'refs/heads/other'], // repoints HEAD
    ['config', 'user.name', 'mallory'],           // writes config
    ['config', 'core.hooksPath', '/tmp/evil'],    // writes config
    ['branch', 'newbranch'],                      // creates a branch
    ['branch', 'newbranch', 'main'],
  ];
  for (const argv of mustRefuse) {
    const v = classify(argv);
    assert.equal(v.allowed, false, `git ${argv.join(' ')} MUST be refused, got ${JSON.stringify(v)}`);
  }

  // …while the read forms grove actually uses stay allowed.
  for (const argv of [
    ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
    ['config', '--get', 'user.name'],
    ['config', '--list'],
    ['branch', '--list'],
  ]) {
    assert.equal(classify(argv).allowed, true, `git ${argv.join(' ')} should be allowed`);
  }
});

test('classifier: refuses mutating subverbs of otherwise-safe commands', () => {
  const mustRefuse = [
    ['worktree', 'add', 'path'],
    ['worktree', 'remove', 'path'],
    ['worktree', 'prune'],
    ['worktree', 'move', 'a', 'b'],
    ['worktree', 'lock', 'x'],
    ['branch', '-D', 'feature'],
    ['branch', '--delete', 'feature'],
    ['branch', '-m', 'a', 'b'],
    ['config', '--unset', 'user.name'],
    ['config', '--add', 'k', 'v'],
    ['hash-object', '-w', 'file'],
  ];
  for (const argv of mustRefuse) {
    const v = classify(argv);
    assert.equal(v.allowed, false, `git ${argv.join(' ')} MUST be refused, got ${JSON.stringify(v)}`);
  }
});

test('classifier: refuses repo-redirecting and escalating global flags', () => {
  for (const argv of [
    ['--git-dir', '/elsewhere/.git', 'status'],
    ['--work-tree', '/elsewhere', 'status'],
    ['-c', 'core.hooksPath=/tmp/evil', 'status'],
    ['--exec-path=/tmp/evil', 'status'],
    ['--namespace', 'x', 'status'],
  ]) {
    assert.equal(classify(argv).allowed, false, `global flag escape not blocked: ${argv.join(' ')}`);
  }
});

test('classifier: allows the reads grove actually needs', () => {
  const mustAllow = [
    [['worktree', 'list', '--porcelain'], 'SAFE'],
    [['status', '--porcelain=v1', '-z'], 'SAFE'],
    [['diff', '--name-only', 'a', 'b'], 'SAFE'],
    [['rev-parse', 'HEAD'], 'SAFE'],
    [['cat-file', '-p', 'abc:file'], 'SAFE'],
    [['merge-base', 'a', 'b'], 'SAFE'],
    [['merge-tree', '--write-tree', 'a', 'b'], 'OBJECT_WRITE'],
  ];
  for (const [argv, tier] of mustAllow) {
    const v = classify(argv);
    assert.equal(v.allowed, true, `git ${argv.join(' ')} should be allowed: ${v.reason}`);
    assert.equal(v.tier, tier, `git ${argv.join(' ')} wrong tier`);
  }
});

test('classifier: rejects malformed argv rather than passing it through', () => {
  assert.equal(classify([]).allowed, false);
  assert.equal(classify(null).allowed, false);
  assert.equal(classify(['status', 42]).allowed, false);
  assert.equal(classify(['--json']).allowed, false); // flags only, no subcommand
});

test('git(): a refused command rejects and never spawns', async () => {
  await assert.rejects(
    () => git(['reset', '--hard'], { cwd: process.cwd() }),
    (err) => err instanceof GitRefused && /refused/.test(err.message),
  );
});

test('git(): merge-tree is refused when strictReadOnly forbids object writes', async () => {
  await assert.rejects(
    () => git(['merge-tree', '--write-tree', 'a', 'b'], { cwd: process.cwd(), allowObjectWrite: false }),
    (err) => err instanceof GitRefused,
  );
});

/* ------------------------------------------------- end-to-end: nothing changed ---- */

/** Recursive snapshot of every file's mtime+size+content-hash, excluding .git objects. */
async function snapshot(root) {
  const { createHash } = await import('node:crypto');
  const out = new Map();
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs);
      // Object database is excluded: merge-tree legitimately writes unreferenced objects.
      if (rel.startsWith('.git' + path.sep + 'objects')) continue;
      if (e.isDirectory()) { await walk(abs); continue; }
      if (!e.isFile()) continue;
      try {
        const buf = await fs.readFile(abs);
        const st = await fs.stat(abs);
        out.set(rel, `${st.size}:${createHash('sha1').update(buf).digest('hex')}`);
      } catch { /* unreadable is fine, it just isn't compared */ }
    }
  }
  await walk(root);
  return out;
}

function diffSnapshots(before, after) {
  const changes = [];
  for (const [k, v] of before) {
    if (!after.has(k)) changes.push(`DELETED ${k}`);
    else if (after.get(k) !== v) changes.push(`MODIFIED ${k}`);
  }
  for (const k of after.keys()) if (!before.has(k)) changes.push(`CREATED ${k}`);
  return changes;
}

test('e2e: a full scan modifies nothing in the repository or its worktrees', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const roots = [fx.root, ...fx.worktrees.values()];
  const before = new Map();
  for (const r of roots) before.set(r, await snapshot(r));

  const disc = await discover(fx.root);
  const scanned = await scan(disc, {});
  await analyze(scanned, {});

  for (const r of roots) {
    const changes = diffSnapshots(before.get(r), await snapshot(r));
    assert.deepEqual(changes, [], `grove modified files under ${r}:\n${changes.join('\n')}`);
  }
});

test('e2e: uncommitted work survives a scan byte-for-byte', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const wt = fx.wt('uniqueUncommitted');
  const target = path.join(wt, 'src/only_uncommitted.js');
  const before = await fs.readFile(target, 'utf8');

  const disc = await discover(fx.root);
  await analyze(await scan(disc, {}), {});

  assert.equal(await fs.readFile(target, 'utf8'), before, 'uncommitted file content changed');

  // And it is still reported as dirty — the scan must not have staged or stashed it.
  const status = await new Promise((resolve) => {
    execFile('git', ['status', '--porcelain'], { cwd: wt }, (e, out) => resolve(String(out ?? '')));
  });
  assert.match(status, /only_uncommitted\.js/, 'file no longer reported dirty after scan');
});

test('e2e: git refs and HEADs are untouched by a scan', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const refsBefore = await fx.git(['for-each-ref', '--format=%(refname) %(objectname)']);
  const headsBefore = {};
  for (const [name, p] of fx.worktrees) headsBefore[name] = await fx.git(['rev-parse', 'HEAD'], p);

  const disc = await discover(fx.root);
  await analyze(await scan(disc, {}), {});

  assert.equal(await fx.git(['for-each-ref', '--format=%(refname) %(objectname)']), refsBefore, 'refs changed');
  for (const [name, p] of fx.worktrees) {
    assert.equal(await fx.git(['rev-parse', 'HEAD'], p), headsBefore[name], `HEAD of ${name} changed`);
  }
});
