/**
 * Holt's Git process boundary, against REAL repositories and hostile process state.
 *
 * An argv allowlist is not enough: Git also accepts repository/config/ODB/program authority from
 * its environment and repository config. These tests prove the actual child processes see Holt's
 * controls, not merely that a helper returns a plausible object.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildGitEnv,
  catFileBatch,
  classify,
  _resetGitCapabilityProbe,
  git,
  hardenGitArgv,
  noLazyFetchSupported,
  worktreeSnapshot,
} from '../../src/git.mjs';
import { committedDelta, indexFlagDelta, scan } from '../../src/scan.mjs';
import { rescue } from '../../src/actions.mjs';
import { discover } from '../../src/discover.mjs';
import { findByPath } from '../../src/paths.mjs';

const BASE_ENV = {
  GIT_AUTHOR_NAME: 'holt boundary test', GIT_AUTHOR_EMAIL: 'boundary@holt.invalid',
  GIT_COMMITTER_NAME: 'holt boundary test', GIT_COMMITTER_EMAIL: 'boundary@holt.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C',
};

function raw(cmd, args, cwd, env = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      cwd, timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, ...BASE_ENV, ...env },
    }, (error, stdout, stderr) => resolve({
      code: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
      stdout: String(stdout ?? ''), stderr: String(stderr ?? ''),
    }));
  });
}

async function rawGit(args, cwd, env) {
  return raw('git', args, cwd, env);
}

async function mustGit(args, cwd, env) {
  const r = await rawGit(args, cwd, env);
  assert.equal(r.code, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

async function repo(t, label) {
  const parent = process.env.HOLT_TMPDIR ?? os.tmpdir();
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, `holt-git-boundary-${label}-`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await mustGit(['init', '-q', '-b', 'main'], root);
  await fs.writeFile(path.join(root, 'tracked.txt'), 'base\n');
  await mustGit(['add', '--', 'tracked.txt'], root);
  await mustGit(['commit', '-q', '-m', 'base'], root);
  return root;
}

async function executableNode(file, body) {
  await fs.writeFile(file, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  await fs.chmod(file, 0o755);
}

function gitShellArg(value) {
  const native = String(value);
  if (process.platform === 'win32') {
    // Git for Windows runs configured drivers through its POSIX shell. A single-quoted
    // drive-qualified path is re-tokenised as `C:Users...` by that boundary, so the anti-vacuity
    // program never starts. Double quotes plus forward slashes survive both cmd's argv handoff
    // and the Git-for-Windows shell without changing the path's identity.
    const shellPath = native.replaceAll('\\', '/').replaceAll('"', '\\"');
    return `"${shellPath}"`;
  }
  const shellPath = native;
  return `'${shellPath.replaceAll("'", "'\\''")}'`;
}

async function ambient(values, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function envConfigPairs(env) {
  const out = new Map();
  const count = Number(env.GIT_CONFIG_COUNT);
  for (let i = 0; i < count; i++) out.set(env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]);
  return out;
}

test('GIT BOUNDARY: environment is deny-by-default and argv hardening is explicit', async () => {
  const poison = '/definitely/not/authority';
  const hostile = {
    GIT_CONFIG_GLOBAL: poison,
    GIT_CONFIG_SYSTEM: poison,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.fsmonitor',
    GIT_CONFIG_VALUE_0: poison,
    GIT_OBJECT_DIRECTORY: poison,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: poison,
    GIT_QUARANTINE_PATH: poison,
    GIT_DIR: poison,
    GIT_COMMON_DIR: poison,
    GIT_NAMESPACE: 'other',
    GIT_EXEC_PATH: poison,
    GIT_EXTERNAL_DIFF: poison,
    GIT_ASKPASS: poison,
    GIT_TRACE: poison,
    GIT_TRACE2_EVENT: poison,
    GIT_REDIRECT_STDIN: poison,
    GIT_REDIRECT_STDOUT: poison,
    GIT_REDIRECT_STDERR: poison,
    PAGER: poison,
    EDITOR: poison,
    SSH_ASKPASS: poison,
    AWS_SECRET_ACCESS_KEY: 'must-not-cross',
    HOLT_UNRELATED_SECRET: 'must-not-cross',
    NODE_OPTIONS: '--require=/definitely/not/authority',
    LD_PRELOAD: poison,
  };

  await ambient(hostile, async () => {
    const env = buildGitEnv({
      ...hostile,
      GIT_INDEX_FILE: '/intentional/index',
      GIT_WORK_TREE: '/intentional/tree',
      GIT_AUTHOR_NAME: 'intentional author',
      GIT_AUTHOR_EMAIL: 'author@holt.invalid',
    });

    for (const key of Object.keys(hostile)) {
      if (key === 'GIT_CONFIG_COUNT' || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) continue;
      if (key === 'PAGER' || key === 'EDITOR' || key === 'SSH_ASKPASS') {
        assert.equal(env[key], undefined, `${key} program fallback crossed the boundary`);
        continue;
      }
      if (key === 'GIT_CONFIG_NOSYSTEM') {
        assert.equal(env[key], '1', 'system Git configuration must be disabled explicitly');
      } else {
        assert.equal(env[key], undefined, `${key} ambient Git control crossed the boundary`);
      }
    }
    assert.equal(env.GIT_INDEX_FILE, '/intentional/index');
    assert.equal(env.GIT_WORK_TREE, '/intentional/tree');
    assert.equal(env.GIT_AUTHOR_NAME, 'intentional author');
    assert.equal(env.GIT_AUTHOR_EMAIL, 'author@holt.invalid');
    assert.equal(env.PATH, process.env.PATH, 'the executable search path must remain available');
    assert.equal(env.HOME, process.env.HOME, 'the supported user-config root must remain available');
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(env.GIT_OPTIONAL_LOCKS, '0');
    assert.equal(env.GIT_NO_LAZY_FETCH, '1');
    assert.equal(env.GIT_NO_REPLACE_OBJECTS, '1');
    assert.equal(env.GIT_PROTOCOL_FROM_USER, '0');
    assert.equal(env.GIT_ALLOW_PROTOCOL, '');
    assert.equal(env.GIT_REF_PARANOIA, '1');
    assert.equal(env.GIT_COMMIT_GRAPH_PARANOIA, '1');
    const forcedConfig = envConfigPairs(env);
    assert.equal(forcedConfig.get('core.fsmonitor'), 'false');
    assert.equal(forcedConfig.get('core.hooksPath'), '/dev/null');
    assert.equal(forcedConfig.get('log.showSignature'), 'false');
    assert.equal(forcedConfig.get('commit.gpgSign'), 'false');
    assert.equal(forcedConfig.get('core.pager'), 'cat');
    assert.equal(forcedConfig.get('protocol.allow'), 'never');
    assert.equal(forcedConfig.get('protocol.ext.allow'), 'never');
    assert.ok(![...forcedConfig.values()].includes(poison),
      'ambient command-scope config survived under Holt\'s forced GIT_CONFIG_* keys');
  });

  for (const version of ['git version 2.45.0', 'git version 2.55.0', 'git version 3.0.0']) {
    assert.equal(noLazyFetchSupported(version), true, version);
  }
  for (const version of ['git version 2.44.4', 'git version 2.38.0', '', 'vendor unknown']) {
    assert.equal(noLazyFetchSupported(version), false, version);
  }

  const statusArgv = hardenGitArgv(['status', '--porcelain=v1']);
  assert.deepEqual(statusArgv, ['status', '--porcelain=v1'],
    'hardening must preserve argv[0] so Git wrappers can identify the subcommand');

  for (const sub of ['diff', 'diff-tree', 'diff-index', 'log', 'show']) {
    const argv = hardenGitArgv([sub, '--stat']);
    assert.ok(argv.includes('--no-ext-diff'), `${sub} did not disable external diff`);
    assert.ok(argv.includes('--no-textconv'), `${sub} did not disable textconv`);
    assert.equal(classify([sub, '--ext-diff']).allowed, false, `${sub} let a caller re-enable ext-diff`);
    assert.equal(classify([sub, '--textconv']).allowed, false, `${sub} let a caller re-enable textconv`);
  }
  assert.deepEqual(hardenGitArgv(['version']), ['version'], 'old Git must remain probeable');
});

test('GIT BOUNDARY: a lying fsmonitor cannot hide a tracked edit from Holt', async (t) => {
  const root = await repo(t, 'fsmonitor');
  const marker = path.join(root, 'fsmonitor-called.log');
  const hook = path.join(root, 'lying-fsmonitor.cjs');
  await executableNode(hook,
    `const fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(marker)}, 'called\\n');\nprocess.stdout.write(Buffer.from('holt-token\\0'));`);

  await mustGit(['config', 'core.fsmonitor', hook], root);
  await mustGit(['config', 'core.fsmonitorHookVersion', '2'], root);
  await mustGit(['status', '--porcelain=v1', '--untracked-files=no'], root);
  const seededCalls = (await fs.readFile(marker, 'utf8')).trim().split('\n').length;
  assert.ok(seededCalls > 0, 'anti-vacuity: raw Git never invoked the configured fsmonitor');

  await fs.writeFile(path.join(root, 'tracked.txt'), 'EDIT THAT THE MONITOR DENIES EXISTS\n');
  const lied = await rawGit(['status', '--porcelain=v1', '--untracked-files=no'], root);
  assert.equal(lied.code, 0, lied.stderr);
  assert.equal(lied.stdout, '',
    'anti-vacuity: the configured monitor did not actually hide the edit from ordinary Git');
  const beforeHolt = (await fs.readFile(marker, 'utf8')).trim().split('\n').length;

  const seen = await git(['status', '--porcelain=v1', '--untracked-files=no', '-z'], { cwd: root });
  assert.equal(seen.code, 0, seen.stderr);
  assert.match(seen.stdout, /tracked\.txt\0/, 'Holt trusted the lying fsmonitor and omitted the edit');
  const afterHolt = (await fs.readFile(marker, 'utf8')).trim().split('\n').length;
  assert.equal(afterHolt, beforeHolt, 'Holt executed the fsmonitor instead of forcing it off');
});

test('GIT BOUNDARY: repository clean/process filters never execute during status or index-flag inspection', async (t) => {
  const root = await repo(t, 'external-filter-scan');
  await fs.writeFile(path.join(root, '.gitattributes'), 'tracked.txt filter=attacker\n');
  await mustGit(['add', '--', '.gitattributes'], root);
  await mustGit(['commit', '-q', '-m', 'attributes before attacker config'], root);

  const marker = path.join(root, 'attacker-filter-ran.log');
  const clean = path.join(root, 'attacker-clean.cjs');
  await executableNode(clean,
    `const fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(marker)}, 'clean\\n');\nconst chunks = [];\nprocess.stdin.on('data', (chunk) => chunks.push(chunk));\nprocess.stdin.on('end', () => process.stdout.write(Buffer.concat([Buffer.from('FILTERED:'), ...chunks])));`);
  await mustGit(['config', 'filter.attacker.clean', `${gitShellArg(process.execPath)} ${gitShellArg(clean)}`], root);
  await mustGit(['config', 'filter.attacker.required', 'false'], root);

  const ordinaryStatus = await rawGit(
    ['status', '--porcelain=v1', '--untracked-files=no'], root);
  assert.equal(ordinaryStatus.code, 0, ordinaryStatus.stderr);
  assert.match(ordinaryStatus.stdout, /tracked\.txt/,
    'anti-vacuity: the filter must be able to make raw-index-equal bytes appear modified');
  assert.match(await fs.readFile(marker, 'utf8'), /clean/);
  await fs.rm(marker, { force: true });

  // Holt's disabled-filter status sees the raw file as equal to the index and therefore says
  // nothing. The scan must enumerate ALL tracked filter-attributed files, not merely the paths
  // that that deliberately altered status stream happened to return.
  const cleanScan = await scan(await discover(root), { includePrimary: true, symbols: false });
  const scannedRoot = await findByPath(cleanScan.workstreams, root);
  assert.equal(scannedRoot?.ok, true, JSON.stringify(scannedRoot));
  assert.ok(scannedRoot.uncommitted.unmeasured.includes('tracked.txt'), JSON.stringify(scannedRoot));
  assert.match(scannedRoot.uncommitted.error ?? '', /external filter attribute/i,
    'the clean-looking but semantically unknowable path must be named');
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });

  const head = (await mustGit(['rev-parse', 'HEAD'], root)).trim();
  assert.equal(await worktreeSnapshot(root, head), null,
    'a synthetic tree must not be authored under suppressed, unknowable clean semantics');
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });

  const unknownWorktree = path.join(path.dirname(root), `${path.basename(root)}-filter-unknown`);
  t.after(() => fs.rm(unknownWorktree, { recursive: true, force: true }));
  await mustGit(['worktree', 'add', '-q', '-b', 'filter-unknown', unknownWorktree, 'main'], root);
  // The fixture-creation command is deliberately raw Git and may run the repository's clean
  // driver on some Git versions.  Start the rescue boundary with a fresh marker so this assertion
  // measures only Holt-owned processes, not checkout work performed while building the fixture.
  await fs.rm(marker, { force: true });
  const rescuedUnknown = await rescue(root, path.basename(unknownWorktree));
  assert.equal(rescuedUnknown.ok, true, JSON.stringify(rescuedUnknown));
  assert.equal(rescuedUnknown.nothingToRescue, undefined,
    'named filter uncertainty must be exactly capturable, not mistaken for an empty worktree');
  assert.equal(rescuedUnknown.verified, true, JSON.stringify(rescuedUnknown));
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  await mustGit(['worktree', 'remove', '--force', unknownWorktree], root);

  await fs.writeFile(path.join(root, 'tracked.txt'), 'changed while ordinary status inspects it\n');
  const rawFilteredHash = await rawGit(
    ['hash-object', '--path=tracked.txt', '--', 'tracked.txt'], root);
  assert.equal(rawFilteredHash.code, 0, rawFilteredHash.stderr);
  assert.match(await fs.readFile(marker, 'utf8'), /clean/,
    'anti-vacuity: ordinary Git did not execute the configured clean filter while inspecting bytes');
  await fs.rm(marker, { force: true });

  // A long-running process driver takes precedence over clean. It need not complete the protocol
  // to prove the execution boundary: starting attacker-controlled code is already the defect.
  const processFilter = path.join(root, 'attacker-process.cjs');
  await executableNode(processFilter,
    `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'process\\n');\nprocess.exit(1);`);
  await mustGit(['config', 'filter.attacker.process', `${gitShellArg(process.execPath)} ${gitShellArg(processFilter)}`], root);
  await rawGit(['hash-object', '--path=tracked.txt', '--', 'tracked.txt'], root);
  assert.match(await fs.readFile(marker, 'utf8'), /process/,
    'anti-vacuity: ordinary Git did not start the configured process filter');
  await fs.rm(marker, { force: true });

  const hardenedStatus = await git(['status', '--porcelain=v1', '--untracked-files=no'], { cwd: root });
  assert.equal(hardenedStatus.code, 0, hardenedStatus.stderr);
  assert.match(hardenedStatus.stdout, /tracked\.txt/,
    'disabling the attacker program must not turn changed bytes into a clean answer');
  const unexpectedFilterRun = await fs.readFile(marker, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  assert.equal(unexpectedFilterRun, null, `Holt started the configured filter: ${unexpectedFilterRun}`);

  // The exact blind spot that prompted this follow-up: an assume-unchanged file is omitted from
  // status, so indexFlagDelta hashes it. That hash used to launch the same clean command.
  await mustGit(['update-index', '--assume-unchanged', '--', 'tracked.txt'], root);
  const flagged = await indexFlagDelta(root);
  assert.ok(flagged.unknown.includes('tracked.txt'), JSON.stringify(flagged));
  assert.ok(!flagged.atRisk.includes('tracked.txt'),
    'filter-dependent equivalence is unknown, not an invented exact answer');
  assert.match(flagged.error ?? '', /external filter|filter attribute/i,
    'the unmeasured evidence must be named for the operator');
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});

test('GIT BOUNDARY: rescue captures pre-filter bytes exactly without starting the configured program', async (t) => {
  const root = await repo(t, 'external-filter-rescue');
  await fs.writeFile(path.join(root, '.gitattributes'), 'secret.txt filter=redact text eol=lf\n');
  await fs.writeFile(path.join(root, 'secret.txt'), 'PUBLIC BASE\n');
  await mustGit(['add', '--', '.gitattributes', 'secret.txt'], root);
  await mustGit(['commit', '-q', '-m', 'capture attributes'], root);
  const worktree = path.join(path.dirname(root), `${path.basename(root)}-victim`);
  t.after(() => fs.rm(worktree, { recursive: true, force: true }));
  await mustGit(['worktree', 'add', '-q', '-b', 'victim', worktree, 'main'], root);

  const marker = path.join(root, 'capture-filter-ran.log');
  const clean = path.join(root, 'capture-clean.cjs');
  await executableNode(clean,
    `const fs = require('node:fs');\nlet parent = String(process.ppid);\ntry { parent = fs.readFileSync('/proc/' + process.ppid + '/cmdline', 'utf8').replaceAll('\\0', ' '); } catch {}\nfs.appendFileSync(${JSON.stringify(marker)}, 'clean parent=' + parent + '\\n');\nprocess.stdin.resume();\nprocess.stdin.on('end', () => process.stdout.write('ATTACKER REPLACED THE BYTES\\n'));`);
  await mustGit(['config', 'filter.redact.clean', `${gitShellArg(process.execPath)} ${gitShellArg(clean)}`], root);
  await mustGit(['config', 'filter.redact.smudge', `${gitShellArg(process.execPath)} ${gitShellArg(clean)}`], root);
  await mustGit(['config', 'filter.redact.required', 'true'], root);

  const secret = Buffer.from('TOP SECRET\r\nSOLE COPY\r\n');
  await fs.writeFile(path.join(worktree, 'secret.txt'), secret);
  const rawHash = await rawGit(['hash-object', '--path=secret.txt', '--', 'secret.txt'], worktree);
  assert.equal(rawHash.code, 0, rawHash.stderr);
  assert.match(await fs.readFile(marker, 'utf8'), /clean/,
    'anti-vacuity: ordinary Git did not execute the lossy filter');
  await fs.rm(marker, { force: true });

  const captured = await rescue(root, path.basename(worktree));
  assert.equal(captured.ok, true, JSON.stringify(captured));
  assert.equal(captured.verified, true, JSON.stringify(captured));
  const unexpectedCaptureFilterRun = await fs.readFile(marker, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  assert.equal(unexpectedCaptureFilterRun, null,
    `Holt started the configured filter while capturing: ${unexpectedCaptureFilterRun}`);
  const bytes = await new Promise((resolve, reject) => {
    execFile('git', ['show', `${captured.commit}:secret.txt`],
      { cwd: root, encoding: 'buffer' }, (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr || error.message)));
        else resolve(Buffer.from(stdout));
      });
  });
  assert.ok(bytes.equals(secret),
    'rescue must retain the exact CRLF sole-copy bytes, not clean-filter or EOL-normalised output');
});

test('GIT BOUNDARY: a configured smudge filter cannot execute during Holt worktree materialisation', async (t) => {
  const root = await repo(t, 'external-smudge');
  await fs.writeFile(path.join(root, '.gitattributes'), 'tracked.txt filter=checkout-attack\n');
  await mustGit(['add', '--', '.gitattributes'], root);
  await mustGit(['commit', '-q', '-m', 'smudge attributes'], root);

  const marker = path.join(root, 'smudge-filter-ran.log');
  const smudge = path.join(root, 'attacker-smudge.cjs');
  await executableNode(smudge,
    `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'smudge\\n');\nprocess.stdin.pipe(process.stdout);`);
  await mustGit(['config', 'filter.checkout-attack.smudge', `${gitShellArg(process.execPath)} ${gitShellArg(smudge)}`], root);
  await mustGit(['config', 'filter.checkout-attack.required', 'true'], root);

  const rawCatFile = await rawGit(['cat-file', '--filters', 'HEAD:tracked.txt'], root);
  assert.equal(rawCatFile.code, 0, rawCatFile.stderr);
  assert.match(await fs.readFile(marker, 'utf8'), /smudge/,
    'anti-vacuity: ordinary cat-file --filters did not execute the configured program');
  await fs.rm(marker, { force: true });
  await assert.rejects(
    () => git(['cat-file', '--filters', 'HEAD:tracked.txt'], { cwd: root }),
    (error) => error?.name === 'GitRefused' && /cat-file --filters/.test(error.message),
  );
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });

  const rawPath = path.join(path.dirname(root), `${path.basename(root)}-raw-smudge`);
  const holtPath = path.join(path.dirname(root), `${path.basename(root)}-holt-smudge`);
  t.after(() => fs.rm(rawPath, { recursive: true, force: true }));
  t.after(() => fs.rm(holtPath, { recursive: true, force: true }));
  await mustGit(['worktree', 'add', '-q', '--detach', rawPath, 'main'], root);
  assert.match(await fs.readFile(marker, 'utf8'), /smudge/,
    'anti-vacuity: ordinary worktree checkout did not execute the configured smudge filter');
  await mustGit(['worktree', 'remove', '--force', rawPath], root);
  await fs.rm(marker, { force: true });

  await assert.rejects(
    () => git(['worktree', 'add', '--detach', holtPath, 'main'], {
      cwd: root, allowMutation: true,
    }),
    (error) => {
      assert.equal(error?.name, 'GitRefused');
      assert.equal(error?.unmeasured, true);
      assert.match(error?.message ?? '', /filter\.checkout-attack\.smudge/);
      assert.match(error?.message ?? '', /not executed|unmeasured/);
      return true;
    },
  );
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  await assert.rejects(fs.stat(holtPath), { code: 'ENOENT' });
});

test('GIT BOUNDARY: custom merge programs are refused and reported as unmeasured', async (t) => {
  const root = await repo(t, 'external-merge-driver');
  await fs.writeFile(path.join(root, '.gitattributes'), 'tracked.txt merge=attacker\n');
  await mustGit(['add', '--', '.gitattributes'], root);
  await mustGit(['commit', '-q', '-m', 'merge attributes'], root);

  await mustGit(['checkout', '-q', '-b', 'left'], root);
  await fs.writeFile(path.join(root, 'tracked.txt'), 'left side\n');
  await mustGit(['add', '--', 'tracked.txt'], root);
  await mustGit(['commit', '-q', '-m', 'left'], root);
  const left = (await mustGit(['rev-parse', 'HEAD'], root)).trim();

  await mustGit(['checkout', '-q', '-b', 'right', 'main'], root);
  await fs.writeFile(path.join(root, 'tracked.txt'), 'right side\n');
  await mustGit(['add', '--', 'tracked.txt'], root);
  await mustGit(['commit', '-q', '-m', 'right'], root);
  const right = (await mustGit(['rev-parse', 'HEAD'], root)).trim();

  const marker = path.join(root, 'merge-driver-ran.log');
  const driver = path.join(root, 'attacker-merge.cjs');
  await executableNode(driver,
    `const fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(marker)}, 'merge\\n');\nfs.copyFileSync(process.argv[4], process.argv[3]);`);
  await mustGit(
    ['config', 'merge.attacker.driver', `${gitShellArg(process.execPath)} ${gitShellArg(driver)} %O %A %B`], root);

  const ordinary = await rawGit(['merge-tree', '--write-tree', left, right], root);
  assert.ok(ordinary.code === 0 || ordinary.code === 1, ordinary.stderr);
  assert.match(await fs.readFile(marker, 'utf8'), /merge/,
    'anti-vacuity: ordinary merge-tree did not execute the configured merge driver');
  await fs.rm(marker, { force: true });

  await assert.rejects(
    () => git(['merge-tree', '--write-tree', left, right], { cwd: root }),
    (error) => {
      assert.equal(error?.name, 'GitRefused');
      assert.equal(error?.unmeasured, true);
      assert.match(error?.message ?? '', /merge\.attacker\.driver/);
      assert.match(error?.message ?? '', /not executed|unmeasured/);
      return true;
    },
  );
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });

  const measured = await committedDelta(root, left, right, {});
  assert.equal(measured.how, 'merge-tree-external-driver-refused', JSON.stringify(measured));
  assert.deepEqual(measured.files, []);
  assert.match(measured.error ?? '', /merge\.attacker\.driver/,
    'the fail-closed result must name the program-bearing config key');
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });

  const scanned = await scan(await discover(root), { includePrimary: true, symbols: false });
  const scannedRoot = await findByPath(scanned.workstreams, root);
  assert.equal(scannedRoot?.ok, false, JSON.stringify(scannedRoot));
  assert.match(scannedRoot.reason ?? '', /merge-tree-external-driver-refused.*merge\.attacker\.driver/,
    'the user-facing scan must retain both the failed instrument and the untrusted config key');
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});

test('GIT BOUNDARY: a modern-looking vendor Git without no-lazy-fetch fails closed', async (t) => {
  const root = await repo(t, 'no-lazy-capability');
  const resolver = process.platform === 'win32' ? 'where' : 'which';
  const resolved = await raw(resolver, ['git']);
  assert.equal(resolved.code, 0, resolved.stderr);
  const realGit = resolved.stdout.split(/\r?\n/).find(Boolean)?.trim();
  assert.ok(realGit);

  const shim = await fs.mkdtemp(path.join(path.dirname(root), 'holt-git-no-lazy-shim-'));
  t.after(() => fs.rm(shim, { recursive: true, force: true }));
  const wrapper = path.join(shim, 'git-wrapper.mjs');
  await fs.writeFile(wrapper, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === 'version') {
  process.stdout.write('git version 2.45.0-vendor\\n');
  process.exit(0);
}
if (args[0] === '--no-lazy-fetch') {
  process.stderr.write('unknown option: --no-lazy-fetch\\n');
  process.exit(129);
}
const r = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit', env: process.env });
process.exit(r.status ?? 74);
`);
  const vendorGit = { executable: process.execPath, executableArgs: [wrapper] };
  _resetGitCapabilityProbe();
  try {
    await assert.rejects(
      () => git(['status', '--porcelain=v1'], { cwd: root, ...vendorGit }),
      (error) => {
        assert.match(error?.message ?? '', /implements --no-lazy-fetch/);
        assert.match(error?.message ?? '', /Git 2\.45 or newer/);
        return true;
      },
    );
  } finally {
    _resetGitCapabilityProbe();
  }
});

test('GIT BOUNDARY: mutating Git plumbing cannot execute repository hooks', async (t) => {
  const root = await repo(t, 'hooks');
  const marker = path.join(root, 'reference-hook-ran.log');
  const hook = path.join(root, '.git', 'hooks', 'reference-transaction');
  await executableNode(hook,
    `require('node:fs').appendFileSync(${JSON.stringify(marker)}, process.argv[2] + '\\n');`);
  const head = (await mustGit(['rev-parse', 'HEAD'], root)).trim();

  // Prove this Git and hook are live before asserting Holt suppresses them.
  await mustGit(['update-ref', 'refs/heads/raw-hook-proof', head], root);
  assert.match(await fs.readFile(marker, 'utf8'), /prepared|committed/,
    'anti-vacuity: raw Git never executed reference-transaction');
  await fs.rm(marker, { force: true });

  const updated = await git(['update-ref', 'refs/holt/boundary-hook-proof', head], {
    cwd: root, allowMutation: true,
  });
  assert.equal(updated.code, 0, updated.stderr);
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  const ref = await git(['show-ref', '--verify', 'refs/holt/boundary-hook-proof'], { cwd: root });
  assert.equal(ref.code, 0, ref.stderr);
  assert.match(ref.stdout, new RegExp(`^${head} `));
});

test('GIT BOUNDARY: ambient config, external programs, trace, and redirection cannot alter execFile evidence', async (t) => {
  const root = await repo(t, 'ambient');
  await fs.writeFile(path.join(root, 'tracked.txt'), 'changed\n');

  const externalMarker = path.join(root, 'external-diff-ran.log');
  const external = path.join(root, 'external-diff.cjs');
  await executableNode(external,
    `require('node:fs').appendFileSync(${JSON.stringify(externalMarker)}, 'ran\\n');`);

  // Prove the program is executable and Git would run it absent Holt's controls.
  const rawExternal = await rawGit(['--no-pager', 'diff', '--ext-diff', '--', 'tracked.txt'], root, {
    GIT_EXTERNAL_DIFF: external,
  });
  assert.equal(rawExternal.code, 0, rawExternal.stderr);
  assert.match(await fs.readFile(externalMarker, 'utf8'), /ran/,
    'anti-vacuity: raw Git did not execute the external diff');
  await fs.rm(externalMarker, { force: true });

  const poisonConfig = path.join(root, 'ambient-gitconfig');
  await fs.writeFile(poisonConfig,
    `[holt]\n\tboundaryPoison = visible\n[diff]\n\texternal = ${external.replaceAll('\\', '\\\\')}\n`);
  const trace = path.join(root, 'git-trace.log');
  const trace2 = path.join(root, 'git-trace2.json');
  const redirected = path.join(root, 'git-redirected.out');
  const hostileEnv = {
    GIT_CONFIG_GLOBAL: poisonConfig,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'diff.external',
    GIT_CONFIG_VALUE_0: external,
    GIT_EXTERNAL_DIFF: external,
    GIT_TRACE: trace,
    GIT_TRACE2_EVENT: trace2,
    GIT_REDIRECT_STDOUT: redirected,
    GIT_DIR: path.join(root, 'not-the-repository'),
  };

  const diff = await git(['diff', '--', 'tracked.txt'], { cwd: root, env: hostileEnv });
  assert.equal(diff.code, 0, diff.stderr);
  assert.match(diff.stdout, /-base/);
  assert.match(diff.stdout, /\+changed/);
  const poisonedConfig = await git(['config', '--get', 'holt.boundaryPoison'], {
    cwd: root, env: hostileEnv,
  });
  assert.equal(poisonedConfig.code, 1, 'ambient GIT_CONFIG_GLOBAL changed Holt\'s config stack');
  assert.equal(poisonedConfig.stdout, '');
  for (const file of [externalMarker, trace, trace2, redirected]) {
    await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  }
});

test('GIT BOUNDARY: real global config remains visible while ambient config redirection is scrubbed', async (t) => {
  const root = await repo(t, 'global-config');
  const xdg = await fs.mkdtemp(path.join(path.dirname(root), 'holt-git-xdg-'));
  t.after(() => fs.rm(xdg, { recursive: true, force: true }));
  await fs.mkdir(path.join(xdg, 'git'), { recursive: true });
  await fs.writeFile(path.join(xdg, 'git', 'config'), '[holt]\n\tboundaryPreserved = real-global\n');
  const poison = path.join(root, 'redirected-config');
  await fs.writeFile(poison, '[holt]\n\tboundaryPreserved = ambient-redirect\n');

  await ambient({ XDG_CONFIG_HOME: xdg, GIT_CONFIG_GLOBAL: poison, GIT_CONFIG_NOSYSTEM: '1' }, async () => {
    const r = await git(['config', '--get', 'holt.boundaryPreserved'], { cwd: root });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'real-global');
  });
});

test('GIT BOUNDARY: ambient ODB and trace controls are scrubbed from catFileBatch; repo alternates survive', async (t) => {
  const target = await repo(t, 'odb-target');
  const donor = await repo(t, 'odb-donor');
  await fs.writeFile(path.join(donor, 'donor-object.txt'), 'ONLY IN THE DONOR OBJECT DATABASE\n');
  const oid = (await mustGit(['hash-object', '-w', '--', 'donor-object.txt'], donor)).trim();
  const donorObjects = path.join(donor, '.git', 'objects');
  const trace = path.join(target, 'cat-file-trace.log');
  const trace2 = path.join(target, 'cat-file-trace2.json');

  await ambient({
    GIT_OBJECT_DIRECTORY: donorObjects,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: donorObjects,
    GIT_TRACE: trace,
    GIT_TRACE2_EVENT: trace2,
  }, async () => {
    const got = [];
    await catFileBatch([oid], { cwd: target }, (_spec, content) => got.push(content));
    assert.deepEqual(got, [null], 'ambient object storage redirected the batch reader');
  });
  await assert.rejects(fs.stat(trace), { code: 'ENOENT' });
  await assert.rejects(fs.stat(trace2), { code: 'ENOENT' });

  // Alternates declared by the repository are legitimate object storage, not ambient authority.
  const info = path.join(target, '.git', 'objects', 'info');
  await fs.mkdir(info, { recursive: true });
  await fs.writeFile(path.join(info, 'alternates'), `${donorObjects}\n`);
  const got = [];
  await catFileBatch([oid], { cwd: target }, (_spec, content) => got.push(content?.toString('utf8')));
  assert.deepEqual(got, ['ONLY IN THE DONOR OBJECT DATABASE\n']);
});
