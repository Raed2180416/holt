// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * Destructive authority must be exact. Similarity, filenames and ignore rules are useful review
 * hints; none of them may become permission to erase bytes.
 */

import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { newRepo } from '../fixtures.mjs';
import { discover } from '../../src/discover.mjs';
import { scan } from '../../src/scan.mjs';
import { safeToDelete } from '../../src/analyze.mjs';
import { clean, discard } from '../../src/actions.mjs';
import { assessCommand } from '../../src/agent.mjs';
import { git } from '../../src/git.mjs';

async function state(fx, { includePrimary = false, gitRunner = git } = {}) {
  const scanned = await scan(await discover(fx.root), { includePrimary, gitRunner });
  const safe = safeToDelete(scanned);
  const byId = (id) => safe.find((v) => v.id === id);
  const ws = (id) => scanned.workstreams.find((w) => w.id === id);
  return { scanned, safe, byId, ws };
}

test('AUTHORITY: identical bytes at different paths are different work', async (t) => {
  const fx = await newRepo('authority-path');
  t.after(() => fx.cleanup());
  const workflow = await fx.worktree('ci-policy');
  const docs = await fx.worktree('docs-example');
  const bytes = 'name: deploy\non: push\njobs: {}\n';
  await fx.write('.github/workflows/deploy.yml', bytes, workflow);
  await fx.commit('add operative workflow', workflow);
  await fx.write('docs/examples/deploy.yml', bytes, docs);
  await fx.commit('add documentation example', docs);

  const { byId } = await state(fx);
  assert.equal(byId('ci-policy').safe, false, JSON.stringify(byId('ci-policy')));
  assert.equal(byId('docs-example').safe, false, JSON.stringify(byId('docs-example')));
  assert.equal(byId('ci-policy').redundantWith, undefined);
  assert.equal(byId('docs-example').redundantWith, undefined);
});

test('AUTHORITY: same path and bytes with different Git modes are different work', async (t) => {
  const fx = await newRepo('authority-mode');
  t.after(() => fx.cleanup());
  const executable = await fx.worktree('executable');
  const plain = await fx.worktree('plain');
  const file = 'bin/deploy.sh';
  const bytes = '#!/bin/sh\necho deploy\n';

  await fx.write(file, bytes, executable);
  await fx.git(['add', '--', file], executable);
  await fx.git(['update-index', '--chmod=+x', '--', file], executable);
  await fx.git(['commit', '-m', 'add executable deploy', '--no-verify'], executable);
  // `update-index --chmod` changes the committed entry, not necessarily the checkout's mode.
  // Keep the working tree clean so an uncommitted mode delta cannot protect this fixture for a
  // second reason and let a blob-only authority mutant survive.
  await fs.chmod(path.join(executable, file), 0o755);
  await fx.write(file, bytes, plain);
  await fx.commit('add non-executable deploy', plain);

  const execTree = await fx.git(['ls-tree', 'HEAD', '--', file], executable);
  const plainTree = await fx.git(['ls-tree', 'HEAD', '--', file], plain);
  assert.match(execTree, /^100755 /, `premise: ${execTree}`);
  assert.match(plainTree, /^100644 /, `premise: ${plainTree}`);
  assert.equal(await fx.git(['status', '--porcelain'], executable), '',
    'premise: the executable worktree must be clean; only committed mode may decide this test');
  assert.equal(await fx.git(['status', '--porcelain'], plain), '',
    'premise: the plain worktree must be clean; only committed mode may decide this test');

  const { byId } = await state(fx);
  assert.equal(byId('executable').safe, false, JSON.stringify(byId('executable')));
  assert.equal(byId('plain').safe, false, JSON.stringify(byId('plain')));
});

test('AUTHORITY: exact same path, mode and Git object remain reclaimable', async (t) => {
  const fx = await newRepo('authority-exact');
  t.after(() => fx.cleanup());
  for (const id of ['exact-a', 'exact-b']) {
    const wt = await fx.worktree(id);
    await fx.write('src/exact.js', 'export const exact = 1;\n', wt);
    await fx.commit(`add exact copy ${id}`, wt);
  }
  const { byId } = await state(fx);
  assert.equal(byId('exact-a').safe, true, JSON.stringify(byId('exact-a')));
  assert.equal(byId('exact-b').safe, true, JSON.stringify(byId('exact-b')));
  assert.deepEqual(byId('exact-a').redundantWith, ['exact-b']);
  assert.deepEqual(byId('exact-b').redundantWith, ['exact-a']);
});

test('AUTHORITY: a dirty checkout does not erase its exact committed recovery object', async (t) => {
  const fx = await newRepo('authority-dirty-holder');
  t.after(() => fx.cleanup());
  const target = await fx.worktree('target');
  const holder = await fx.worktree('holder');

  await fx.write('src/exact.js', 'export const exact = 1;\n', target);
  await fx.commit('target exact recovery object', target);
  await fx.write('src/exact.js', 'export const exact = 1;\n', holder);
  await fx.write('src/holder-only.js', 'export const holderOnly = true;\n', holder);
  await fx.commit('holder independently commits the same exact object', holder);
  await fx.write('src/exact.js', 'export const exact = 2;\n', holder);

  const measured = await state(fx);
  const targetId = measured.ws('target').committed.identities['src/exact.js'];
  const holderId = measured.ws('holder').committed.identities['src/exact.js'];
  assert.equal(targetId, holderId, 'premise: both refs durably hold the exact Git entry');
  assert.ok(measured.ws('holder').uncommitted.files.includes('src/exact.js'),
    'premise: the holder checkout is dirty at that path');
  assert.equal(measured.byId('target').safe, true, JSON.stringify(measured.byId('target')));
  assert.deepEqual(measured.byId('target').redundantWith, ['holder']);
});

test('AUTHORITY: an exact committed deletion is preserved by a sibling even when its tree has extra work', async (t) => {
  const fx = await newRepo('authority-deletion');
  t.after(() => fx.cleanup());
  await fx.write('src/obsolete.js', 'export const obsolete = true;\n');
  await fx.commit('base obsolete module');

  const deletionOnly = await fx.worktree('delete-only');
  await fs.rm(path.join(deletionOnly, 'src/obsolete.js'));
  await fx.commit('remove obsolete module', deletionOnly);

  const superset = await fx.worktree('delete-plus');
  await fs.rm(path.join(superset, 'src/obsolete.js'));
  await fx.write('src/replacement.js', 'export const replacement = true;\n', superset);
  await fx.commit('remove obsolete module and add replacement', superset);

  const { byId, ws } = await state(fx);
  assert.match(ws('delete-only').committed.identities['src/obsolete.js'], /^delete:100644:blob:/,
    `premise: deletion must be represented as an exact tombstone: ${JSON.stringify(ws('delete-only').committed)}`);
  assert.equal(byId('delete-only').safe, true,
    `the sibling durably retains the exact deletion, so refusing would be a false positive: ${JSON.stringify(byId('delete-only'))}`);
  assert.deepEqual(byId('delete-only').redundantWith, ['delete-plus']);
  assert.equal(byId('delete-plus').safe, false,
    'the superset still holds its unique replacement and must not be called disposable');
});

test('AUTHORITY: failure to enumerate a nonempty merged delta is unknown, never an empty all-clear', async (t) => {
  const fx = await newRepo('authority-name-instrument');
  t.after(() => fx.cleanup());
  const ahead = await fx.worktree('ahead');
  await fx.write('src/only-here.js', 'export const onlyHere = true;\n', ahead);
  await fx.commit('committed work that base lacks', ahead);

  // Interpose only the second committed-delta instrument. `merge-tree` still succeeds and proves
  // the head differs; the subsequent path enumerator fails. Returning [] from that failure is
  // observationally identical to a clean delta unless the failure state is carried explicitly.
  const failingGit = async (args, options = {}) => (
    args[0] === 'diff' && args.includes('--name-status')
      ? { code: 73, stdout: '', stderr: 'planted name-status failure' }
      : git(args, options)
  );
  const measured = await state(fx, { gitRunner: failingGit });

  const scanned = measured.ws('ahead');
  assert.equal(scanned.ok, false,
    `a failed path instrument must withdraw classification: ${JSON.stringify(scanned)}`);
  assert.match(scanned.reason, /merge-tree-names-failed.*planted name-status failure/,
    `the exact failed instrument must remain visible: ${scanned.reason}`);
  assert.equal(measured.byId('ahead').safe, false);
  assert.equal(measured.byId('ahead').confidence, 'unknown');
});

test('AUTHORITY: a failed discard HEAD probe is not reclassified as an unborn repository', async (t) => {
  const fx = await newRepo('authority-discard-head-probe');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('edited');
  const file = path.join(wt, 'src/base.js');
  await fs.writeFile(file, 'valuable tracked edit\n');

  const failingGit = async (args, options = {}) => (
    args[0] === 'rev-parse' && args.includes('HEAD^{commit}')
      ? { code: 73, stdout: '', stderr: 'planted HEAD instrument failure' }
      : git(args, options)
  );
  const result = await discard(fx.root, [file], { gitRunner: failingGit });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(result.error, /could not resolve worktree HEAD exactly.*planted HEAD instrument failure/);
  assert.equal(await fs.readFile(file, 'utf8'), 'valuable tracked edit\n');
  assert.equal(await fx.git(['for-each-ref', '--format=%(refname)', 'refs/holt/discard']), '',
    'a failed identity probe must refuse before quarantine or ref allocation');
});

test('AUTHORITY: whitespace-normalised YAML and line-ending-only changes are not deletion proof', async (t) => {
  const fx = await newRepo('authority-bytes');
  t.after(() => fx.cleanup());
  await fx.write('config.yml', 'key: |\n  hello\n    world\n');
  await fx.write('script.py', 'def f():\n    return 1\n');
  await fx.commit('base semantic bytes');

  const yaml = await fx.worktree('yaml-indent');
  await fx.write('config.yml', 'key: |\n  hello\n      world\n', yaml);
  await fx.commit('change block scalar indentation', yaml);

  const crlf = await fx.worktree('crlf-only');
  await fs.writeFile(path.join(crlf, 'script.py'), Buffer.from('def f():\r\n    return 1\r\n'));
  await fx.commit('change line-ending bytes', crlf);

  const { byId, ws } = await state(fx);
  assert.equal(byId('yaml-indent').safe, false, JSON.stringify(byId('yaml-indent')));
  assert.equal(byId('crlf-only').safe, false, JSON.stringify(byId('crlf-only')));
  assert.equal(ws('crlf-only').committed.lineEndingOnlyVsBase, true,
    'similarity may still be reported as advisory evidence');
});

test('AUTHORITY: tracked lockfile edits and prose-only primary edits block reset', async (t) => {
  const fx = await newRepo('authority-dirty');
  t.after(() => fx.cleanup());
  await fx.write('package-lock.json', '{"lockfileVersion":3,"packages":{}}\n');
  await fx.commit('add lockfile');

  const wt = await fx.worktree('lock-hotfix');
  await fx.write('package-lock.json', '{"lockfileVersion":3,"packages":{"private-hotfix":{}}}\n', wt);
  let s = await state(fx);
  assert.ok(s.ws('lock-hotfix').uncommitted.files.includes('package-lock.json'));
  assert.equal(s.byId('lock-hotfix').safe, false);
  let verdict = await assessCommand('git reset --hard', wt);
  assert.equal(verdict.decision, 'deny', `${verdict.decision}: ${verdict.reason}`);

  await fx.write('README.md', '# fixture\n\nUnique incident note that has no symbol.\n');
  s = await state(fx, { includePrimary: true });
  const primary = s.safe.find((v) => v.isPrimary);
  assert.ok(primary, 'primary worktree must be present');
  assert.equal(primary.contentReproducible, false, JSON.stringify(primary));
  verdict = await assessCommand('git reset --hard', fx.root);
  assert.equal(verdict.decision, 'deny', `${verdict.decision}: ${verdict.reason}`);
});

test('AUTHORITY: ignored/generated-looking only copies survive clean and require confirmation', async (t) => {
  const fx = await newRepo('authority-generated');
  t.after(() => fx.cleanup());
  await fx.write('package.json', '{"name":"fixture"}\n');
  await fx.write('.gitignore', 'node_modules/\nlogs/\n');
  await fx.commit('declare ignored paths');

  const logs = await fx.worktree('incident-log');
  await fx.write('logs/incident-postmortem.md', 'only copy of the incident analysis\n', logs);
  const deps = await fx.worktree('patched-dep');
  await fx.write('node_modules/pkg/index.js', 'module.exports = "hand patch";\n', deps);

  const s = await state(fx);
  for (const id of ['incident-log', 'patched-dep']) {
    assert.equal(s.byId(id).safe, false, `${id}: ${JSON.stringify(s.byId(id))}`);
  }
  const dry = await clean(fx.root);
  const ids = dry.wouldQuarantine.map((entry) => entry.id);
  assert.ok(!ids.includes('incident-log'), JSON.stringify(dry));
  assert.ok(!ids.includes('patched-dep'), JSON.stringify(dry));

  const logDelete = await assessCommand('rm -rf logs', logs);
  assert.equal(logDelete.decision, 'deny', `${logDelete.decision}: ${logDelete.reason}`);
  const depDelete = await assessCommand('rm -rf node_modules', deps);
  assert.equal(depDelete.decision, 'ask', `${depDelete.decision}: ${depDelete.reason}`);
  assert.match(depDelete.reason, /cannot prove|Confirm/i);
});

test('AUTHORITY: POSIX double quotes retain a backslash before an ordinary character', async (t) => {
  if (process.platform === 'win32') return t.skip('this is a POSIX shell grammar regression');
  const fx = await newRepo('authority-double-quote-backslash');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('sole-copy');
  const name = 'odd\\q.txt';
  const file = path.join(wt, name);
  await fs.writeFile(file, 'the only copy\n');
  const command = 'rm "odd\\q.txt"';

  const verdict = await assessCommand(command, wt);
  assert.equal(verdict.decision, 'deny', JSON.stringify(verdict));
  assert.match(verdict.reason, /odd\\q\.txt|uncommitted file/i);

  // Prove what Bash itself targets; otherwise a parser test can pass against the wrong pathname.
  execFileSync('/bin/bash', ['-c', command], { cwd: wt, stdio: 'pipe' });
  assert.equal(await fs.stat(file).then(() => true, () => false), false,
    'Bash removed the literal backslash-q filename, which is the exact path holt had to guard');
});
