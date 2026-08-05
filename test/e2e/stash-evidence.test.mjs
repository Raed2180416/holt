/**
 * holt — THE STASH AS A STORE OF WORK.
 *
 * THE REFUTATION THIS FILE PINS, in the refuter's own words:
 *
 *   "Nothing in src/scan.mjs, src/discover.mjs, src/analyze.mjs ever inspects refs/stash when
 *    computing safe/at-risk. The moment a stash sweep succeeds the working tree is clean,
 *    report.safe marks the workstream safe:true, and every subsequent stash rule evaluates
 *    holding.length === 0 and returns a flat silent allow. Live proof: staged-only content swept
 *    with git stash push -u; tree and index verified clean; the content's ONLY copy is the stash.
 *    Then: git stash pop -> allow. drop -> allow. clear -> allow."
 *
 * Measured before the fix, on this exact fixture: three allows, and the stash commit went
 * unreachable the instant `drop` ran.
 *
 * EVERY TEST HERE PROVES ITS OWN PREMISE WITH REAL GIT BEFORE ASSERTING A VERDICT — the file
 * verifies that the tree is clean, that the index is clean, that the file is off disk, that
 * `git stash list` really holds the entry, and (with `git fsck`) that the reachability story holt
 * tells about the stash commit is the one git itself tells. An assertion about a fixture nobody
 * checked is a claim about nothing.
 *
 * AND THE NEVER-WORSE HALF IS ASSERTED IN THE SAME BREATH, because the failure mode of a fix like
 * this is a guard that refuses every `drop` forever and gets switched off. An entry whose content
 * is reachable from a ref holds nothing unique, and dropping it must go back to a silent allow.
 */

import { execFile, execFileSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { newRepo, standardFixture } from '../fixtures.mjs';
import { assessCommand, cachedReport } from '../../src/agent.mjs';
import { stashState, describeStash, MAX_ENTRIES } from '../../src/stash.mjs';
import { renderRisk } from '../../src/render.mjs';

/** Real git, for establishing premises. Tests must never assume what the command does. */
const gitIn = (args, cwd) => new Promise((res) => {
  execFile('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'holt test', GIT_AUTHOR_EMAIL: 'test@holt.invalid',
      GIT_COMMITTER_NAME: 'holt test', GIT_COMMITTER_EMAIL: 'test@holt.invalid',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', LC_ALL: 'C',
    },
  }, (e, so, se) => res({ code: e?.code ?? 0, out: String(so ?? ''), err: String(se ?? '') }));
});

async function withGitSubcommandFailure(t, subcommand, run) {
  const resolver = process.platform === 'win32' ? 'where' : 'which';
  const realGit = execFileSync(resolver, ['git'], { encoding: 'utf8' })
    .split(/\r?\n/).find(Boolean);
  assert.ok(realGit, 'premise: real git must be resolvable before interposition');
  const shimDir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-stash-git-shim-'));
  const shimScript = path.join(shimDir, 'git-wrapper.mjs');
  await fs.writeFile(shimScript, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args[0] === ${JSON.stringify(subcommand)}) {
  process.stderr.write('planted ${subcommand} failure\\n');
  process.exit(73);
}
const r = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit', env: process.env });
process.exit(r.status ?? 74);
`);
  if (process.platform === 'win32') {
    await fs.writeFile(path.join(shimDir, 'git.cmd'),
      `@echo off\r\n"${process.execPath}" "${shimScript}" %*\r\n`);
  } else {
    await fs.chmod(shimScript, 0o755);
    await fs.symlink('git-wrapper.mjs', path.join(shimDir, 'git'));
  }
  t.after(() => fs.rm(shimDir, { recursive: true, force: true }));

  const prior = process.env.PATH;
  process.env.PATH = `${shimDir}${path.delimiter}${prior ?? ''}`;
  try { return await run(); } finally {
    if (prior === undefined) delete process.env.PATH;
    else process.env.PATH = prior;
  }
}

async function withGitCommandLog(t, run) {
  const resolver = process.platform === 'win32' ? 'where' : 'which';
  const realGit = execFileSync(resolver, ['git'], { encoding: 'utf8' })
    .split(/\r?\n/).find(Boolean);
  assert.ok(realGit, 'premise: real git must be resolvable before interposition');
  const shimDir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-stash-git-log-'));
  const logPath = path.join(shimDir, 'commands.jsonl');
  const shimScript = path.join(shimDir, 'git-wrapper.mjs');
  await fs.writeFile(shimScript, `#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + '\\n');
const r = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit', env: process.env });
process.exit(r.status ?? 74);
`);
  if (process.platform === 'win32') {
    await fs.writeFile(path.join(shimDir, 'git.cmd'),
      `@echo off\r\n"${process.execPath}" "${shimScript}" %*\r\n`);
  } else {
    await fs.chmod(shimScript, 0o755);
    await fs.symlink('git-wrapper.mjs', path.join(shimDir, 'git'));
  }
  t.after(() => fs.rm(shimDir, { recursive: true, force: true }));

  const prior = process.env.PATH;
  process.env.PATH = `${shimDir}${path.delimiter}${prior ?? ''}`;
  try { return await run(logPath); } finally {
    if (prior === undefined) delete process.env.PATH;
    else process.env.PATH = prior;
  }
}

/** The word that must appear in the stash and nowhere else. */
const ONLY_HERE = 'RESCUE_ME_ONLY_IN_THE_STASH';

/**
 * Which commits reachable from a REAL ref introduce this content?
 *
 * `--all` cannot be used, and the reason is the whole subject of this file: `--all` INCLUDES
 * refs/stash, so it reports the stash's own commit and answers "yes, a ref holds it" about
 * content whose only holder is the thing about to be destroyed. Written with `--all` first, this
 * helper asserted its premise successfully against a fixture where the premise was false.
 */
const inReachableHistory = async (cwd) =>
  (await gitIn(['log', '--exclude=refs/stash', '--all', '-S', ONLY_HERE, '--format=%H'], cwd)).out.trim();

/**
 * THE REFUTER'S EXACT FIXTURE: staged-only content, swept with `git stash push -u`, with every
 * part of the premise verified rather than assumed.
 */
async function sweptFixture(t) {
  const fx = await newRepo('stash-swept');
  t.after(() => fx.cleanup());

  await fx.write('src/rescue_me.js', `export function ${ONLY_HERE}() { return "one copy"; }\n`);
  await gitIn(['add', 'src/rescue_me.js'], fx.root);

  const sweep = await gitIn(['stash', 'push', '-u', '-m', 'wip: the only copy'], fx.root);
  assert.equal(sweep.code, 0, `premise: the sweep must succeed: ${sweep.err}`);

  const st = await gitIn(['status', '--porcelain=v1', '--untracked-files=all'], fx.root);
  assert.equal(st.out, '', `premise: the working tree must be byte-clean after the sweep: ${JSON.stringify(st)}`);
  const idx = await gitIn(['diff', '--cached', '--name-only'], fx.root);
  assert.equal(idx.out, '', `premise: the index must be clean too: ${JSON.stringify(idx)}`);
  assert.equal(
    await fs.stat(path.join(fx.root, 'src/rescue_me.js')).then(() => true, () => false),
    false, 'premise: the file must be off disk — the stash is its only copy',
  );
  assert.match((await gitIn(['stash', 'list'], fx.root)).out, /stash@\{0\}/,
    'premise: the entry must exist');

  // AND THE CONTENT REALLY IS NOWHERE ELSE: grep every commit reachable from every ref.
  const inHistory = await gitIn(['grep', '-a', ONLY_HERE, '--', '.'], fx.root);
  assert.notEqual(inHistory.code, 0, 'premise: the content must not be in the working tree');
  assert.equal(await inReachableHistory(fx.root), '',
    'premise: no commit reachable from a real ref may hold this content');

  return fx;
}

/* ------------------------------------------------- THE REFUTATION ITSELF ---- */

test('REFUTATION: drop/clear DENY while pop safely restores the only copy', async (t) => {
  const fx = await sweptFixture(t);

  for (const cmd of ['git stash drop', 'git stash clear', 'git stash drop stash@{0}']) {
    const v = await assessCommand(cmd, fx.root);
    assert.equal(v.decision, 'deny',
      `${cmd} destroys the only copy of real content and must be DENIED: ${JSON.stringify(v)}`);
    assert.match(v.reason, /stash@\{0\}/, `it must NAME the entry it would destroy: ${v.reason}`);
    assert.match(v.reason, /src\/rescue_me\.js/,
      `and sample the content that dies with it: ${v.reason}`);
    assert.match(v.reason, /git stash apply/,
      `and name the way to make this safe: ${v.reason}`);
    assert.match(v.reason, /holt rescue/, `and holt's own escape hatch: ${v.reason}`);
  }

  const pop = await assessCommand('git stash pop', fx.root);
  assert.equal(pop.decision, 'allow',
    `pop applies the bytes before dropping and keeps the entry on conflict: ${JSON.stringify(pop)}`);
  const restored = await gitIn(['stash', 'pop'], fx.root);
  assert.equal(restored.code, 0, `the real recovery must succeed: ${restored.err}`);
  assert.match(await fs.readFile(path.join(fx.root, 'src/rescue_me.js'), 'utf8'), new RegExp(ONLY_HERE),
    'the only copy must be back in the worktree before the stash entry disappears');
  assert.equal((await gitIn(['stash', 'list'], fx.root)).out, '',
    'a successful pop removes the entry only after restoring its content');
});

test('REFUTATION: a conflicted pop keeps the stash entry and both versions on disk', async (t) => {
  const fx = await newRepo('stash-pop-conflict');
  t.after(() => fx.cleanup());
  await fx.write('conflict.txt', 'base\n');
  await fx.commit('tracked conflict base');
  await fx.write('conflict.txt', 'stashed-only-version\n');
  assert.equal((await gitIn(['stash', 'push', '-m', 'conflicting recovery'], fx.root)).code, 0);
  await fx.write('conflict.txt', 'working-only-version\n');
  await fx.commit('divergent current version');

  assert.equal((await assessCommand('git stash pop', fx.root)).decision, 'allow');
  const popped = await gitIn(['stash', 'pop'], fx.root);
  assert.notEqual(popped.code, 0, 'the premise requires a real merge conflict');
  assert.match(`${popped.out}\n${popped.err}`, /stash entry is kept/i,
    'Git must state that the failed pop retained the recovery entry');
  assert.match((await gitIn(['stash', 'list'], fx.root)).out, /stash@\{0\}/,
    'the entry remains reachable after a conflict');
  const conflicted = await fs.readFile(path.join(fx.root, 'conflict.txt'), 'utf8');
  assert.match(conflicted, /stashed-only-version/);
  assert.match(conflicted, /working-only-version/);
});

test('FAIL CLOSED: a stash reflog probe failure is unknown, never an empty all-clear', async (t) => {
  const fx = await sweptFixture(t);
  await withGitSubcommandFailure(t, 'log', async () => {
    const state = await stashState(fx.root);
    assert.equal(state.checked, false, JSON.stringify(state));
    assert.equal(state.total, 0, 'the failed probe did not invent entries');
    const verdict = await assessCommand('git stash drop', fx.root);
    assert.equal(verdict.decision, 'ask', JSON.stringify(verdict));
    assert.match(verdict.reason, /could not read.*stash|cannot say/i);
  });
});

test('FAIL CLOSED: an entry diff failure cannot turn an existing stash into a safe drop', async (t) => {
  const fx = await sweptFixture(t);
  await withGitSubcommandFailure(t, 'diff', async () => {
    const state = await stashState(fx.root);
    assert.equal(state.total, 1, JSON.stringify(state));
    assert.equal(state.checked, false, JSON.stringify(state));
    assert.equal(state.entries[0].checked, false, JSON.stringify(state.entries[0]));
    const verdict = await assessCommand('git stash drop', fx.root);
    assert.equal(verdict.decision, 'ask', JSON.stringify(verdict));
    assert.match(verdict.reason, /could not complete|cannot say/i);
  });
});

test('REFUTATION: `git fsck` agrees with holt about what dropping the entry makes unreachable', async (t) => {
  const fx = await sweptFixture(t);

  // holt's claim, and the object it rests on.
  const state = await stashState(fx.root);
  assert.equal(state.total, 1, `holt must see exactly one entry: ${JSON.stringify(state)}`);
  assert.equal(state.atRisk.length, 1, 'and must call it at risk');
  assert.equal(state.checked, true, 'having actually completed the check');
  const oid = state.entries[0].oid;
  const blob = state.entries[0].unique[0].sha;

  // GIT'S OWN STORY, BEFORE: refs/stash names the commit, so nothing is unreachable.
  const before = await gitIn(['fsck', '--unreachable', '--no-reflogs'], fx.root);
  assert.doesNotMatch(before.out, new RegExp(oid),
    `premise: while refs/stash exists the entry is reachable: ${JSON.stringify(before)}`);
  assert.doesNotMatch(before.out, new RegExp(blob),
    'premise: and so is the blob it carries');

  // …AND AFTER. `drop` is the act holt refuses; run it for real and watch git confirm the loss.
  const dropped = await gitIn(['stash', 'drop'], fx.root);
  assert.equal(dropped.code, 0, `the real drop must succeed: ${dropped.err}`);
  const after = await gitIn(['fsck', '--unreachable', '--no-reflogs'], fx.root);
  assert.match(after.out, new RegExp(`unreachable commit ${oid}`),
    `git itself must now call the stash commit unreachable — this is the loss holt named: ${JSON.stringify(after)}`);

  // And the content is gone from every ref, which is what "no ref holds this" meant.
  assert.equal(await inReachableHistory(fx.root), '', 'the content is reachable from no ref at all');
});

test('NEVER-WORSE: `git stash apply` + commit RELAXES the same verbs to a silent allow', async (t) => {
  const fx = await sweptFixture(t);

  // Before: denied, because the stash is the only copy.
  assert.equal((await assessCommand('git stash drop', fx.root)).decision, 'deny',
    'premise: it is denied while the stash is the only copy');

  // Do the right thing — exactly what the refusal told the user to do.
  const applied = await gitIn(['stash', 'apply'], fx.root);
  assert.equal(applied.code, 0, `apply must succeed: ${applied.err}`);
  await gitIn(['add', '-A'], fx.root);
  const committed = await gitIn(['commit', '-m', 'rescued the stashed work', '--no-verify'], fx.root);
  assert.equal(committed.code, 0, `commit must succeed: ${committed.err}`);

  // PREMISE, PROVEN: the content is now reachable from a ref.
  assert.notEqual(await inReachableHistory(fx.root), '', 'premise: a commit now holds the content');
  assert.match((await gitIn(['stash', 'list'], fx.root)).out, /stash@\{0\}/,
    'premise: and the entry is still there — apply does not drop it');

  // NOTHING ABOUT THE STASH COMMIT CHANGED. Only the content's reachability did — and that is the
  // whole difference between a guard that relaxes and one that nags.
  for (const cmd of ['git stash drop', 'git stash clear', 'git stash pop']) {
    const v = await assessCommand(cmd, fx.root);
    assert.equal(v.decision, 'allow',
      `${cmd} now destroys nothing unique and must be a SILENT allow: ${JSON.stringify(v)}`);
    assert.equal(v.reason, null, `with no message at all: ${JSON.stringify(v)}`);
  }
});

/* ------------------------------------------ EXACT GIT TREE-ENTRY AUTHORITY ---- */

const parseTreeEntry = (raw, expectedPath) => {
  const line = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  const m = /^(\d+)\s+(\w+)\s+([0-9a-f]+)\t([\s\S]+)$/.exec(line);
  assert.ok(m, `premise: git ls-tree must return one parseable entry, got ${JSON.stringify(raw)}`);
  assert.equal(m[4], expectedPath, `premise: git returned the wrong path: ${JSON.stringify(raw)}`);
  return { mode: m[1], type: m[2], sha: m[3], path: m[4] };
};

async function modeOnlyStash(t, name) {
  const fx = await newRepo(name);
  t.after(() => fx.cleanup());
  const file = 'bin/deploy.sh';
  await fx.write(file, '#!/bin/sh\necho deploy\n');
  await fx.commit('plain deploy script');

  const base = parseTreeEntry((await gitIn(['ls-tree', 'HEAD', '--', file], fx.root)).out, file);
  assert.equal(base.mode, '100644', `premise: base must be non-executable: ${JSON.stringify(base)}`);
  assert.equal(base.type, 'blob');

  assert.equal((await gitIn(['update-index', '--chmod=+x', '--', file], fx.root)).code, 0,
    'premise: Git must accept the index-only executable-bit change');
  const staged = (await gitIn(['ls-files', '--stage', '--', file], fx.root)).out;
  assert.match(staged, new RegExp(`^100755 ${base.sha} 0\\t${file.replace('.', '\\.')}`),
    `premise: the index must hold the same blob under mode 100755: ${JSON.stringify(staged)}`);

  const pushed = await gitIn(['stash', 'push', '-m', 'mode-only authority'], fx.root);
  assert.equal(pushed.code, 0, `premise: mode-only stash must succeed: ${pushed.err}`);
  const stashed = parseTreeEntry(
    (await gitIn(['ls-tree', 'stash@{0}^2', '--', file], fx.root)).out,
    file,
  );
  assert.deepEqual(stashed, { ...base, mode: '100755' },
    `premise: stash index parent must carry only the mode change: ${JSON.stringify({ base, stashed })}`);
  return { fx, file, base, stashed };
}

test('TREE ENTRY AUTHORITY: identical bytes at a different path do not authorise a stash drop', async (t) => {
  const fx = await newRepo('stash-path-identity');
  t.after(() => fx.cleanup());
  const durablePath = 'docs/deploy.sh';
  const stashedPath = 'bin/deploy.sh';
  const bytes = '#!/bin/sh\necho deploy\n';
  await fx.write(durablePath, bytes);
  await fx.commit('keep documentation example');
  const durable = parseTreeEntry(
    (await gitIn(['ls-tree', 'HEAD', '--', durablePath], fx.root)).out,
    durablePath,
  );

  await fx.write(stashedPath, bytes);
  const pushed = await gitIn(['stash', 'push', '-u', '-m', 'same bytes, operative path'], fx.root);
  assert.equal(pushed.code, 0, `premise: untracked stash must succeed: ${pushed.err}`);
  const stashed = parseTreeEntry(
    (await gitIn(['ls-tree', 'stash@{0}^3', '--', stashedPath], fx.root)).out,
    stashedPath,
  );
  assert.equal(stashed.sha, durable.sha, 'premise: both paths must use the exact same Git object');
  assert.equal(stashed.mode, durable.mode);
  assert.equal(stashed.type, durable.type);
  assert.notEqual(stashed.path, durable.path, 'premise: path must be the only identity difference');

  const state = await stashState(fx.root);
  assert.ok(state.entries[0]?.unique.some((u) => u.path === stashedPath),
    `the documentation path cannot preserve the operative path: ${JSON.stringify(state)}`);
  assert.equal((await assessCommand('git stash drop', fx.root)).decision, 'deny');
});

test('TREE ENTRY AUTHORITY: mode-only stash stays unique and drop/clear are denied', async (t) => {
  const { fx, file, stashed } = await modeOnlyStash(t, 'stash-mode-only');

  const state = await stashState(fx.root);
  const candidate = state.entries[0]?.unique.find((u) => u.path === file);
  assert.deepEqual(candidate && {
    path: candidate.path, mode: candidate.mode, type: candidate.type, sha: candidate.sha,
  }, stashed,
  `the reachable 100644 entry has the same path/blob but cannot authorise deleting 100755: ${JSON.stringify(state)}`);

  for (const cmd of ['git stash drop', 'git stash clear']) {
    const verdict = await assessCommand(cmd, fx.root);
    assert.equal(verdict.decision, 'deny',
      `${cmd} would erase the only executable entry and must be denied: ${JSON.stringify(verdict)}`);
    assert.match(verdict.reason, /stash@\{0\}/);
    assert.match(verdict.reason, new RegExp(file.replace('.', '\\.')));
  }
});

test('TREE ENTRY AUTHORITY: regular-file to symlink change stays unique even with the same blob OID', async (t) => {
  const fx = await newRepo('stash-symlink-type');
  t.after(() => fx.cleanup());
  const file = 'config/active';
  await fx.write(file, 'deploy-v2');
  await fx.commit('regular file whose bytes are a link target');
  const base = parseTreeEntry((await gitIn(['ls-tree', 'HEAD', '--', file], fx.root)).out, file);
  assert.equal(base.mode, '100644');

  const stagedLink = await gitIn([
    'update-index', '--cacheinfo', `120000,${base.sha},${file}`,
  ], fx.root);
  assert.equal(stagedLink.code, 0, `premise: Git must accept the staged symlink entry: ${stagedLink.err}`);
  assert.match((await gitIn(['ls-files', '--stage', '--', file], fx.root)).out,
    new RegExp(`^120000 ${base.sha} 0\\t${file}`),
    'premise: mode changed to symlink while the object ID stayed byte-identical');

  const pushed = await gitIn(['stash', 'push', '-m', 'same oid, different entry type'], fx.root);
  assert.equal(pushed.code, 0, `premise: type-only stash must succeed: ${pushed.err}`);
  const stashed = parseTreeEntry(
    (await gitIn(['ls-tree', 'stash@{0}^2', '--', file], fx.root)).out,
    file,
  );
  assert.deepEqual(stashed, { ...base, mode: '120000' });

  const state = await stashState(fx.root);
  const candidate = state.entries[0]?.unique.find((u) => u.path === file);
  assert.deepEqual(candidate && {
    path: candidate.path, mode: candidate.mode, type: candidate.type, sha: candidate.sha,
  }, stashed,
  `a regular file with this blob cannot authorise deleting the symlink entry: ${JSON.stringify(state)}`);
  assert.equal((await assessCommand('git stash drop', fx.root)).decision, 'deny');
});

test('TREE ENTRY AUTHORITY: an exact reachable path/mode/type/object relaxes drop and clear', async (t) => {
  const { fx, file, stashed } = await modeOnlyStash(t, 'stash-mode-exact-control');

  assert.equal((await gitIn(['update-index', '--chmod=+x', '--', file], fx.root)).code, 0,
    'premise: recreate the exact executable entry outside the stash');
  const committed = await gitIn(['commit', '-m', 'durably keep exact executable entry', '--no-verify'], fx.root);
  assert.equal(committed.code, 0, `premise: exact entry must become reachable from HEAD: ${committed.err}`);
  const reachable = parseTreeEntry((await gitIn(['ls-tree', 'HEAD', '--', file], fx.root)).out, file);
  assert.deepEqual(reachable, stashed,
    `premise: path, mode, type and object must all match: ${JSON.stringify({ reachable, stashed })}`);

  const state = await stashState(fx.root);
  assert.equal(state.entries[0]?.uniqueCount, 0,
    `the exact entry is durably reachable, so the stash holds nothing unique: ${JSON.stringify(state)}`);
  for (const cmd of ['git stash drop', 'git stash clear']) {
    const verdict = await assessCommand(cmd, fx.root);
    assert.equal(verdict.decision, 'allow',
      `${cmd} must relax only after the exact entry is reachable: ${JSON.stringify(verdict)}`);
    assert.equal(verdict.reason, null);
  }
});

test('TREE CHANGE AUTHORITY: a deletion-only stash is work and relaxes only after that deletion is committed', async (t) => {
  const fx = await newRepo('stash-deletion-intent');
  t.after(() => fx.cleanup());
  const file = 'src/obsolete.js';
  await fx.write(file, 'export const obsolete = true;\n');
  await fx.commit('add the file that will be removed');
  const original = parseTreeEntry((await gitIn(['ls-tree', 'HEAD', '--', file], fx.root)).out, file);

  await fs.rm(path.join(fx.root, file));
  const pushed = await gitIn(['stash', 'push', '-m', 'remove obsolete module'], fx.root);
  assert.equal(pushed.code, 0, `premise: deletion-only stash must succeed: ${pushed.err}`);
  assert.equal(await fs.readFile(path.join(fx.root, file), 'utf8'), 'export const obsolete = true;\n',
    'premise: stash push restored the base file, so only the stash remembers its deletion');

  const before = await stashState(fx.root);
  const tombstone = before.entries[0]?.unique.find((u) => u.path === file && u.operation === 'delete');
  assert.deepEqual(tombstone && {
    operation: tombstone.operation, path: tombstone.path, mode: tombstone.mode,
    type: tombstone.type, sha: tombstone.sha,
  }, { operation: 'delete', ...original },
  `the stash must retain an exact tombstone rather than treating "no destination blob" as no work: ${JSON.stringify(before)}`);
  assert.equal((await assessCommand('git stash drop', fx.root)).decision, 'deny',
    'dropping the only durable record of the deletion must be denied');

  const applied = await gitIn(['stash', 'apply'], fx.root);
  assert.equal(applied.code, 0, `premise: applying the deletion must succeed: ${applied.err}`);
  assert.equal(await fs.stat(path.join(fx.root, file)).then(() => true, () => false), false,
    'premise: the applied work is absence at the operative path');
  await gitIn(['add', '-A'], fx.root);
  const committed = await gitIn(['commit', '-m', 'remove obsolete module', '--no-verify'], fx.root);
  assert.equal(committed.code, 0, `premise: the deletion must become durable: ${committed.err}`);

  const after = await stashState(fx.root);
  assert.equal(after.entries[0]?.uniqueCount, 0,
    `the exact deletion is now reachable and must relax: ${JSON.stringify(after)}`);
  assert.equal((await assessCommand('git stash drop', fx.root)).decision, 'allow');
});

test('TREE CHANGE AUTHORITY: deleting different prior bytes at the same path is not the same work', async (t) => {
  const fx = await newRepo('stash-deletion-source-identity');
  t.after(() => fx.cleanup());
  const file = 'src/replaceable.js';

  await fx.write(file, 'export const generation = "A";\n');
  await fx.commit('generation A');
  await fs.rm(path.join(fx.root, file));
  await gitIn(['add', '-A'], fx.root);
  await fx.commit('delete generation A');
  await fx.write(file, 'export const generation = "B";\n');
  await fx.commit('generation B');
  const generationB = parseTreeEntry((await gitIn(['ls-tree', 'HEAD', '--', file], fx.root)).out, file);

  await fs.rm(path.join(fx.root, file));
  assert.equal((await gitIn(['stash', 'push', '-m', 'delete generation B'], fx.root)).code, 0);
  const state = await stashState(fx.root);
  const tombstone = state.entries[0]?.unique.find((u) => u.operation === 'delete' && u.path === file);
  assert.equal(tombstone?.sha, generationB.sha,
    `the reachable deletion of generation A cannot preserve the stashed deletion of B: ${JSON.stringify(state)}`);
  assert.equal((await assessCommand('git stash drop', fx.root)).decision, 'deny');
});

test('TREE CHANGE AUTHORITY: a reachable rename destination does not erase unique source-deletion intent', async (t) => {
  const fx = await newRepo('stash-rename-both-halves');
  t.after(() => fx.cleanup());
  const source = 'src/old-name.js';
  const destination = 'src/new-name.js';
  const bytes = 'export const renamed = true;\n';
  await fx.write(source, bytes);
  await fx.commit('old path');
  const sourceEntry = parseTreeEntry((await gitIn(['ls-tree', 'HEAD', '--', source], fx.root)).out, source);

  await fs.rename(path.join(fx.root, source), path.join(fx.root, destination));
  assert.equal((await gitIn(['stash', 'push', '-u', '-m', 'rename the module'], fx.root)).code, 0);

  // Preserve only the destination half in a ref. The old path deliberately remains, so no
  // reachable commit records the removal the stash would lose.
  await fx.write(destination, bytes);
  await gitIn(['add', destination], fx.root);
  assert.equal((await gitIn(['commit', '-m', 'copy at new path only', '--no-verify'], fx.root)).code, 0);
  const destinationEntry = parseTreeEntry(
    (await gitIn(['ls-tree', 'HEAD', '--', destination], fx.root)).out,
    destination,
  );
  assert.equal(destinationEntry.sha, sourceEntry.sha, 'premise: destination entry is exactly reachable');

  const state = await stashState(fx.root);
  assert.ok(state.entries[0]?.unique.some((u) => u.operation === 'delete'
    && u.path === source && u.sha === sourceEntry.sha),
  `a rename is destination presence PLUS source absence; the copy preserves only one half: ${JSON.stringify(state)}`);
  assert.equal((await assessCommand('git stash drop', fx.root)).decision, 'deny');
});

test('NEVER-WORSE: an empty stash makes every stash verb a silent allow', async (t) => {
  const fx = await newRepo('stash-empty');
  t.after(() => fx.cleanup());
  assert.equal((await gitIn(['stash', 'list'], fx.root)).out, '', 'premise: no entries');

  for (const cmd of ['git stash drop', 'git stash clear', 'git stash pop', 'git stash drop stash@{7}']) {
    const v = await assessCommand(cmd, fx.root);
    assert.equal(v.decision, 'allow',
      `${cmd} against an empty stash cannot lose anything: ${JSON.stringify(v)}`);
  }
});

test('PRECISION: a drop is judged on the entry IT destroys, not on the riskiest entry present', async (t) => {
  // THE DISCRIMINATING ARRANGEMENT, deliberately the awkward way round: the DANGEROUS entry is
  // the OLD one and the harmless entry is the one a bare `drop`/`pop` actually takes. Built the
  // other way round, every wrong implementation — "weigh the whole stash", "weigh stash@{0}",
  // "weigh whichever is worst" — passes. Here only the correct one does.
  const fx = await newRepo('stash-selector');
  t.after(() => fx.cleanup());

  // ---- the OLD entry (ends up stash@{1}): the only copy of real content --------------------
  await fx.write('src/only.js', `export function ${ONLY_HERE}() {}\n`);
  await gitIn(['add', '-A'], fx.root);
  assert.equal((await gitIn(['stash', 'push', '-u', '-m', 'unique-content'], fx.root)).code, 0, 'setup');

  // ---- the NEW entry (stash@{0}): content a commit already holds ---------------------------
  await fx.write('src/shared.js', 'export function SHARED_AND_COMMITTED() { return 1; }\n');
  await gitIn(['add', '-A'], fx.root);
  await gitIn(['commit', '-m', 'version one', '--no-verify'], fx.root);
  await fx.write('src/shared.js', 'export function SHARED_AND_COMMITTED() { return 2; }\n');
  await gitIn(['add', '-A'], fx.root);
  await gitIn(['commit', '-m', 'version two', '--no-verify'], fx.root);
  // Put version ONE back in the working tree. It is a real uncommitted modification, and its
  // content is reachable from HEAD~1 — so stashing it queues an entry that holds nothing unique.
  await gitIn(['checkout', 'HEAD~1', '--', 'src/shared.js'], fx.root);
  assert.equal((await gitIn(['stash', 'push', '-m', 'reachable-content'], fx.root)).code, 0, 'setup');

  const state = await stashState(fx.root);
  assert.equal(state.total, 2,
    `premise: two entries: ${JSON.stringify(state.entries.map((e) => e.selector))}`);
  assert.equal(state.entries[0].uniqueCount, 0,
    `premise: stash@{0}'s content IS reachable from a ref: ${JSON.stringify(state.entries[0])}`);
  assert.ok(state.entries[1].uniqueCount > 0,
    `premise: stash@{1} holds the only copy: ${JSON.stringify(state.entries[1])}`);

  // A bare drop/pop takes stash@{0} — which loses nothing. Refusing it because a DIFFERENT entry
  // is precious is a refusal about work the command cannot touch.
  for (const cmd of [
    'git stash drop',
    'git stash pop',
    'git stash drop stash@{0}',
    // Reflog date selectors are valid Git selectors too. Holt must resolve the selector to its
    // exact commit rather than treating every non-numeric spelling as "all entries" and denying
    // this harmless top entry because the older stash is precious.
    'git stash drop stash@{now}',
  ]) {
    const v = await assessCommand(cmd, fx.root);
    assert.equal(v.decision, 'allow',
      `${cmd} destroys stash@{0}, which holds nothing unique: ${JSON.stringify(v)}`);
  }

  // Naming the precious one is the act that loses work.
  const named = await assessCommand('git stash drop stash@{1}', fx.root);
  assert.equal(named.decision, 'deny', `dropping the only copy must be denied: ${JSON.stringify(named)}`);
  assert.match(named.reason, /stash@\{1\}/, `naming the right entry: ${named.reason}`);
  assert.doesNotMatch(named.reason, /stash@\{0\}/,
    `and not the innocent one: ${named.reason}`);

  // `clear` takes them ALL, so one at-risk entry anywhere is enough.
  const cleared = await assessCommand('git stash clear', fx.root);
  assert.equal(cleared.decision, 'deny',
    `clear destroys every entry, so it is judged on every entry: ${JSON.stringify(cleared)}`);
  assert.match(cleared.reason, /stash@\{1\}/, `naming the one that matters: ${cleared.reason}`);
});

/* --------------------------------------- THE SWEEP MENTIONS WHAT IS QUEUED ---- */

test('MENTION: a bare `git stash` names the entries already queued, so a pile is not forgotten', async (t) => {
  const fx = await newRepo('stash-mention');
  t.after(() => fx.cleanup());

  // An older entry holding the only copy of something…
  await fx.write('src/old_work.js', `export function ${ONLY_HERE}() {}\n`);
  await gitIn(['add', '-A'], fx.root);
  assert.equal((await gitIn(['stash', 'push', '-u', '-m', 'older work'], fx.root)).code, 0, 'setup');

  // …and a fresh tracked modification about to be swept on top of it.
  await fx.write('src/base.js', 'export function baseline() { return 99; }\n');

  const v = await assessCommand('git stash', fx.root);
  assert.equal(v.decision, 'ask', `a real sweep asks: ${JSON.stringify(v)}`);
  assert.match(v.reason, /src\/base\.js/, `naming what it sweeps: ${v.reason}`);
  assert.match(v.reason, /stash@\{0\}/,
    `and naming the entry ALREADY queued — forgetting a pile is how the stash loses work `
    + `without anyone typing drop: ${v.reason}`);
  assert.match(v.reason, /src\/old_work\.js/, `with a sample of what that entry holds: ${v.reason}`);
});

/* ------------------------------------------------ CLOSING THE REPORT LOOP ---- */

test('REPORT: a stash holding the only copy is a repository-level at-risk row, not silence', async (t) => {
  const fx = await sweptFixture(t);

  const { report } = await cachedReport(fx.root, { includePrimary: true });

  // The workstream really is clean — that is the whole trap, and it stays true.
  assert.equal(report.counts.atRisk, 0,
    'the worktree genuinely holds nothing: this is the state that made holt say "safe"');

  // …and the repository is NOT therefore free of unrecoverable work.
  assert.ok(report.stash, 'the report must carry a stash section');
  assert.equal(report.stash.total, 1, `one entry: ${JSON.stringify(report.stash)}`);
  assert.equal(report.stash.atRisk.length, 1, 'holding content no ref holds');

  const rendered = renderRisk(report);
  assert.match(rendered, /stash@\{0\}/, `\`holt risk\` must show the entry: ${rendered}`);
  assert.match(rendered, /src\/rescue_me\.js/, `and what it holds: ${rendered}`);
  // A REPOSITORY-LEVEL LINE, NOT A FAKE WORKSTREAM. Inventing a workstream row would put a
  // non-existent id into every downstream consumer (gate, rescue, landing plan, the graph).
  assert.equal(report.unique.some((u) => /stash/i.test(u.id)), false,
    'the stash must never be smuggled in as a workstream');
  assert.equal(report.safe.some((s) => /stash/i.test(s.id)), false, 'nor into the safe list');
});

test('REPORT: a repository with no stash says nothing about one', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());
  assert.equal((await gitIn(['stash', 'list'], fx.root)).out, '', 'premise: no entries');

  const { report } = await cachedReport(fx.root, { includePrimary: true });
  assert.equal(report.stash.total, 0, `no entries: ${JSON.stringify(report.stash)}`);
  assert.equal(report.stash.checked, true, 'and holt looked, rather than failing to');
  assert.doesNotMatch(renderRisk(report), /STASH/,
    'so `holt risk` must not print a stash section at all');
});

test('REPORT: the cache notices a stash appearing and disappearing', async (t) => {
  // The report cache is keyed on a fingerprint of the worktree list plus every worktree's status.
  // A `git stash drop` changes NEITHER — so without refs/stash in the fingerprint the warning
  // would outlive the entry, and holt would keep naming a stash that no longer exists.
  const fx = await newRepo('stash-cache');
  t.after(() => fx.cleanup());

  const before = await cachedReport(fx.root, { includePrimary: true });
  assert.equal(before.report.stash.total, 0, 'premise: nothing queued yet');

  await fx.write('src/only.js', `export function ${ONLY_HERE}() {}\n`);
  await gitIn(['add', '-A'], fx.root);
  assert.equal((await gitIn(['stash', 'push', '-u'], fx.root)).code, 0, 'setup');
  const during = await cachedReport(fx.root, { includePrimary: true });
  assert.equal(during.report.stash.total, 1, 'the appearing entry must invalidate the cache');

  assert.equal((await gitIn(['stash', 'drop'], fx.root)).code, 0, 'setup');
  const after = await cachedReport(fx.root, { includePrimary: true });
  assert.equal(after.report.stash.total, 0,
    'and so must its disappearance — a warning about a dropped entry is a false alarm');
});

test('MCP: the channel agents actually read does not stay silent about the stash', async (t) => {
  // holt_status describes itself as "Start here". In the swept state it reports atRisk: 0 and
  // disposable: N — every number true about worktrees, and together an all-clear about a
  // repository whose only copy of real work is a stash commit. This product exists to prevent
  // AI-agent work loss, so the MCP surface is the one that must not go quiet.
  const fx = await sweptFixture(t);
  const { __test } = await import('../../src/mcp/server.mjs');

  __test.clearCache();
  const status = await __test.handle('holt_status', { repo: fx.root });
  assert.equal(status.atRisk, 0, 'premise: no WORKSTREAM is at risk — that is the whole trap');
  assert.equal(status.stashAtRisk, 1, `and the stash must be reported anyway: ${JSON.stringify(status)}`);

  __test.clearCache();
  const risk = await __test.handle('holt_at_risk', { repo: fx.root });
  assert.ok(risk.stash, `holt_at_risk must carry the stash: ${JSON.stringify(risk)}`);
  assert.equal(risk.stash.total, 1);
  assert.equal(risk.stash.entries[0].selector, 'stash@{0}');
  assert.equal(risk.stash.entries[0].sample[0].path, 'src/rescue_me.js');
  assert.match(risk.stash.note, /git stash drop/, 'and name the verb that destroys it');
  // NEVER A SYNTHETIC WORKSTREAM: an agent handed one would try to check, land or delete it.
  assert.equal(risk.workstreams.some((w) => /stash/i.test(w.id ?? '')), false,
    'the stash must not appear as a workstream row');
});

test('MCP: a repository with no stash gets no stash keys at all', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());
  const { __test } = await import('../../src/mcp/server.mjs');

  __test.clearCache();
  const status = await __test.handle('holt_status', { repo: fx.root });
  assert.equal(status.stashAtRisk, undefined, 'no stash, no key — schemas are the token cost');
  __test.clearCache();
  const risk = await __test.handle('holt_at_risk', { repo: fx.root });
  assert.equal(risk.stash, undefined, 'same');
});

/* ----------------------------------------------------------- EFFICIENCY ---- */

test('EFFICIENCY: the hot path pays nothing, and a stash verb pays no full scan', async (t) => {
  // TWO SEPARATE CLAIMS, and the honest version of each matters.
  //
  // (1) A command holt resolves WITHOUT a repository scan must not touch refs/stash at all. The
  //     guard runs before every agent tool call, and `rm -rf dist` can never need stash evidence.
  //
  // (2) A stash verb must not trigger a full repository analysis. Its evidence is the reflog; the
  //     scan's expensive instrument (`merge-tree`, which is what makes a cold scan cost seconds)
  //     has nothing to say about a stash entry.
  //
  // What is NOT claimed: that a command which already pays for a full scan avoids the stash. It
  // does not, and it must not — the report now describes the stash, so the report's cache key has
  // to move when the stash moves, or holt would keep naming an entry that was already rescued.
  // One reflog read beside a repository scan is not a hot-path cost; asserting otherwise would be
  // pinning a property this design deliberately does not have.
  const fx = await newRepo('stash-cost');
  t.after(() => fx.cleanup());
  await fx.write('src/only.js', `export function ${ONLY_HERE}() {}\n`);
  await gitIn(['add', '-A'], fx.root);
  assert.equal((await gitIn(['stash', 'push', '-u'], fx.root)).code, 0, 'setup');

  await withGitCommandLog(t, async (trace) => {
    const runWithTrace = async (cmd) => {
      await fs.rm(trace, { force: true });
      await assessCommand(cmd, fx.root);
      const log = await fs.readFile(trace, 'utf8').catch(() => '');
      await fs.rm(trace, { force: true });
      return log;
    };

    const stashVerb = await runWithTrace('git stash drop');
    assert.match(stashVerb, /refs\/stash/,
      'premise: a stash verb DOES read refs/stash — otherwise this test proves nothing');
    assert.doesNotMatch(stashVerb, /merge-tree/,
      'a stash verb is answered from the reflog and must not pay for a repository scan');

    for (const cmd of ['rm -rf dist', 'npm test', 'ls -la']) {
      const log = await runWithTrace(cmd);
      assert.doesNotMatch(log, /refs\/stash/,
        `${cmd} resolves without a scan and must never pay for a stash read`);
    }
  });
});

/* ----------------------------------------------------- MAX_ENTRIES loud break ---- */
//
// holt caps stash scanning at MAX_ENTRIES (25). If a repo has more, holt stops scanning —
// and entries beyond the cap might hold the only copy of real work. Silently stopping is the
// exact "silence that loses work" this module exists to end. The `truncated` flag must be
// surfaced so the guard and the brief can warn.

test('STASH: more than MAX_ENTRIES entries → truncated flag is set and describeStash warns', async (t) => {
  const fx = await newRepo('stash-truncated');
  t.after(() => fx.cleanup());

  // Create MAX_ENTRIES + 5 stash entries, each holding a unique untracked file.
  for (let i = 0; i < MAX_ENTRIES + 5; i++) {
    await fs.writeFile(path.join(fx.root, `file-${i}.txt`), `unique content ${i}`);
    const r = await gitIn(['stash', 'push', '-u', '-m', `entry-${i}`], fx.root);
    assert.equal(r.code, 0, `stash push ${i} failed: ${r.err}`);
  }

  const state = await stashState(fx.root);
  assert.equal(state.truncated, true, 'truncated flag must be set when there are more than MAX_ENTRIES entries');
  assert.equal(state.total, MAX_ENTRIES, `total must be exactly MAX_ENTRIES (${MAX_ENTRIES}), got ${state.total}`);

  // describeStash must include a warning about the truncation
  const desc = describeStash(state);
  assert.match(desc, /scanned only the first.*stash entries/i, 'describeStash must warn about truncated entries');
  assert.match(desc, /review.*manually/i, 'describeStash must tell the user to review the rest manually');
});

/*
 * PAST THE CAP, "NOTHING FOUND" IS NOT "NOTHING THERE".
 *
 * The walk stops at MAX_ENTRIES. Put the only copy of real work OLDER than that many stashes and
 * it sits at stash@{30}, never examined — while every entry holt DID read is provably safe. The
 * guard then computes an empty at-risk set and, before this was fixed, reported it as `allow`:
 * holt watched the one command that destroys the content and waved it through.
 *
 * The entries stacked on top must be genuinely safe or the test proves nothing — it would deny on
 * evidence from the scanned entries and look like it had caught this. holt's reachability walk is
 * PATH-SCOPED, so "safe" means the SAME PATH committed with the SAME BLOB, which is what the loop
 * below builds. The control at the end is the other half: a drop holt CAN account for must still
 * be allowed, because refusing a provably safe command is its own bug.
 */
async function repoWithSoleCopyPastTheCap(t, name) {
  const fx = await newRepo(name);
  t.after(() => fx.cleanup());

  await fs.writeFile(path.join(fx.root, 'treasure.js'), `export function ${ONLY_HERE}(){ return 42; }\n`);
  assert.equal((await gitIn(['stash', 'push', '-u', '-m', 'THE ONLY COPY'], fx.root)).code, 0);

  for (let i = 0; i < MAX_ENTRIES + 5; i++) {
    const rel = `f${i}.js`;
    const abs = path.join(fx.root, rel);
    await fs.writeFile(abs, `export function f${i}(){ return 'A'; }\n`);
    await gitIn(['add', rel], fx.root);
    await gitIn(['commit', '-qm', `f${i} A`], fx.root);

    const bodyB = `export function f${i}(){ return 'B'; }\n`;
    await fs.writeFile(abs, bodyB);
    assert.equal((await gitIn(['stash', 'push', '-m', `safe ${i}`], fx.root)).code, 0);
    // Commit that identical blob at that identical path, so the entry holds nothing unique.
    await fs.writeFile(abs, bodyB);
    await gitIn(['add', rel], fx.root);
    await gitIn(['commit', '-qm', `f${i} B`], fx.root);
  }

  const list = (await gitIn(['stash', 'list'], fx.root)).out.trim().split('\n');
  const line = list.find((l) => l.includes('THE ONLY COPY'));
  assert.ok(line, 'premise: the sole-copy entry must still be in the stash');
  const selector = line.split(':')[0];
  assert.ok(Number(/\{(\d+)\}/.exec(selector)[1]) >= MAX_ENTRIES,
    `premise: the sole copy must sit PAST the cap, it is at ${selector}`);

  // Premise: it really is the only copy — no ref introduces this content.
  const inRefs = (await gitIn(['log', '--all', '-S', ONLY_HERE, '--oneline'], fx.root)).out.trim();
  assert.equal(inRefs, '', 'premise: no ref may hold the sole-copy content');

  // Premise: every entry holt actually scanned is safe, so an at-risk hit could only come from
  // the unscanned tail. Without this the test would pass against the unfixed code.
  const state = await stashState(fx.root);
  assert.equal(state.truncated, true, 'premise: the scan must be truncated');
  assert.equal(state.atRisk.length, 0,
    `premise: every SCANNED entry must be provably safe, ${state.atRisk.length} were not`);

  return { fx, selector };
}

test('STASH: dropping a sole-copy entry PAST the cap is not allowed', async (t) => {
  const { fx, selector } = await repoWithSoleCopyPastTheCap(t, 'stash-cap-drop');
  const v = await assessCommand(`git stash drop ${selector}`, fx.root);
  assert.notEqual(v.decision, 'allow',
    'holt scanned 25 of 31 entries, found nothing at risk among them, and allowed the drop of the one it never read');
  assert.match(v.reason, /scanned only the first/i, 'the reason must say holt did not read them all');
});

test('STASH: `git stash clear` past the cap is not allowed', async (t) => {
  const { fx } = await repoWithSoleCopyPastTheCap(t, 'stash-cap-clear');
  const v = await assessCommand('git stash clear', fx.root);
  assert.notEqual(v.decision, 'allow', 'clear takes every entry, including the ones holt never read');
  assert.match(v.reason, /scanned only the first/i);
});

test('STASH: past the cap, a drop holt CAN account for stays allowed', async (t) => {
  const { fx } = await repoWithSoleCopyPastTheCap(t, 'stash-cap-control');
  // stash@{0} was scanned and is provably safe. Truncation elsewhere is not a licence to refuse
  // a command holt has complete evidence about — over-refusal trains users to bypass the guard.
  for (const cmd of ['git stash drop stash@{0}', 'git stash drop']) {
    const v = await assessCommand(cmd, fx.root);
    assert.equal(v.decision, 'allow',
      `${cmd} targets a scanned, provably safe entry and must not be refused (got ${v.decision})`);
  }
});

test('STASH PRECISION: an unscanned selector is ASK, never DENY on a different risky entry', async (t) => {
  const fx = await newRepo('stash-cap-scoping');
  t.after(() => fx.cleanup());

  // Oldest entry: provably safe because its exact path/mode/blob remains in HEAD~1.
  await fx.write('safe.js', 'export const version = "A";\n');
  await fx.commit('safe version A');
  await fx.write('safe.js', 'export const version = "B";\n');
  await fx.commit('safe version B');
  assert.equal((await gitIn(['checkout', 'HEAD~1', '--', 'safe.js'], fx.root)).code, 0);
  assert.equal((await gitIn(['stash', 'push', '-m', 'safe beyond cap'], fx.root)).code, 0);

  // Newer entries: each holds unique content, so a broken implementation that falls back to
  // `state.entries` will DENY and falsely name one of these instead of admitting the target was
  // not scanned.
  for (let i = 0; i < MAX_ENTRIES; i++) {
    await fs.writeFile(path.join(fx.root, `unique-${i}.txt`), `only copy ${i}\n`);
    assert.equal((await gitIn(['stash', 'push', '-u', '-m', `unique ${i}`], fx.root)).code, 0);
  }
  const selector = `stash@{${MAX_ENTRIES}}`;
  const state = await stashState(fx.root);
  assert.equal(state.truncated, true);
  assert.ok(state.entries[0].uniqueCount > 0, 'premise: an unrelated scanned entry is risky');

  const verdict = await assessCommand(`git stash drop ${selector}`, fx.root);
  assert.equal(verdict.decision, 'ask', JSON.stringify(verdict));
  assert.deepEqual(verdict.targets, [selector], 'the answer must stay scoped to the selected entry');
  assert.match(verdict.reason, /beyond that evidence|scanned only the first/i);
  assert.doesNotMatch(verdict.reason, /stash@\{0\}/,
    'an unrelated scanned entry cannot become the reason to deny this selector');
});

test('STASH: exactly MAX_ENTRIES entries is a COMPLETE scan, not a truncated one', async (t) => {
  const fx = await newRepo('stash-exactly-cap');
  t.after(() => fx.cleanup());
  // Hitting the limit is not evidence that anything lies beyond it. Inferring "there must be
  // more" from "I stopped counting" made holt hedge about a stash it had in fact read in full.
  for (let i = 0; i < MAX_ENTRIES; i++) {
    await fs.writeFile(path.join(fx.root, `file-${i}.txt`), `unique content ${i}`);
    assert.equal((await gitIn(['stash', 'push', '-u', '-m', `entry-${i}`], fx.root)).code, 0);
  }
  const state = await stashState(fx.root);
  assert.equal(state.total, MAX_ENTRIES, 'all MAX_ENTRIES entries must be scanned');
  assert.equal(state.truncated, false,
    'exactly MAX_ENTRIES entries means holt read every one — truncated must be false');
  assert.doesNotMatch(describeStash(state), /scanned only the first/i,
    'holt must not warn about entries it did not skip');
});

test('STASH: fewer than MAX_ENTRIES entries → no truncation, no warning', async (t) => {
  const fx = await newRepo('stash-not-truncated');
  t.after(() => fx.cleanup());

  for (let i = 0; i < 3; i++) {
    await fs.writeFile(path.join(fx.root, `file-${i}.txt`), `unique content ${i}`);
    const r = await gitIn(['stash', 'push', '-u', '-m', `entry-${i}`], fx.root);
    assert.equal(r.code, 0, `stash push ${i} failed: ${r.err}`);
  }

  const state = await stashState(fx.root);
  assert.equal(state.truncated, false, 'truncated flag must not be set when under MAX_ENTRIES');
  assert.equal(state.total, 3);

  const desc = describeStash(state);
  assert.doesNotMatch(desc, /more stash entries/i, 'no truncation warning when under the cap');
});
