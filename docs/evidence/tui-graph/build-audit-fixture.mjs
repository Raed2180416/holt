#!/usr/bin/env node
// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * Build the retained, ground-truth Git repositories for the installed TUI/graph proof.
 *
 * This builder never invokes a source-checkout Holt binary and never captures screenshots. It
 * creates only independent Git facts plus a cryptographically identified oracle. The installed
 * proof runner imports buildAuditFixture() and makes every product observation through the exact
 * HOLT_BIN bound by FREEZE_EVIDENCE.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  assert,
  captureFile,
  exists,
  publicRunRecord,
  runProcess,
  writeEvidenceArtifact,
} from './installed-proof-support.mjs';

export const IDS = Object.freeze({
  atRisk: '01-unique-uncommitted-critical',
  holding: '02-unique-committed-feature',
  collisionA: '03-collision-payments-a',
  collisionB: '04-collision-payments-b',
  twinA: '05-redundant-twin-a',
  twinB: '06-redundant-twin-b',
  duplicateA: '07-duplicate-implementation-a',
  duplicateB: '08-duplicate-implementation-b',
  empty: '09-genuinely-empty',
  long: '10-extremely-long-agent-workstream-name-that-must-clip-cleanly-雪',
  hostile: `11-hostile-<img-src=x-onerror=HOLT_XSS()>&"quote'`,
});

export const EXPECTED = Object.freeze({
  atRisk: [IDS.atRisk, IDS.long, IDS.hostile],
  holds: [IDS.holding, IDS.collisionA, IDS.collisionB, IDS.duplicateA, IDS.duplicateB],
  unknown: [],
  disposable: [IDS.twinA, IDS.twinB, IDS.empty],
  provenCollision: [IDS.collisionA, IDS.collisionB],
  redundantPair: [IDS.twinA, IDS.twinB],
  duplicatePair: [IDS.duplicateA, IDS.duplicateB],
  all: Object.values(IDS),
});

const HERE = path.dirname(fileURLToPath(import.meta.url));

function fixtureEnv(home) {
  return {
    PATH: '/usr/bin:/bin',
    HOME: home,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_SYSTEM: os.devNull,
    GIT_AUTHOR_NAME: 'Holt TUI graph fixture',
    GIT_AUTHOR_EMAIL: 'fixture@holt.invalid',
    GIT_COMMITTER_NAME: 'Holt TUI graph fixture',
    GIT_COMMITTER_EMAIL: 'fixture@holt.invalid',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C.UTF-8',
    LANG: 'C.UTF-8',
  };
}

async function write(root, relative, contents) {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents, { encoding: 'utf8', flag: 'wx' });
  return target;
}

async function checked(command, args, cwd, env, { allowFailure = false } = {}) {
  const result = await runProcess(command, args, { cwd, env });
  if (!allowFailure && (result.exitCode !== 0 || result.signal || result.spawnError)) {
    throw new Error(`${command} ${args.join(' ')} failed in ${cwd}: ${result.stderr || result.spawnError}`);
  }
  return result;
}

async function initializeRepo(root, env, title) {
  await fs.mkdir(root, { recursive: false });
  await checked('git', ['init', '-q', '--initial-branch=main'], root, env);
  await checked('git', ['config', 'user.name', 'Holt TUI graph fixture'], root, env);
  await checked('git', ['config', 'user.email', 'fixture@holt.invalid'], root, env);
  await checked('git', ['config', 'commit.gpgsign', 'false'], root, env);
  await checked('git', ['config', 'core.autocrlf', 'false'], root, env);
  await write(root, 'README.md', `# ${title}\n`);
  await checked('git', ['add', '-A'], root, env);
  await checked('git', ['commit', '-q', '--no-verify', '-m', 'fixture baseline'], root, env);
}

async function commit(root, env, message) {
  await checked('git', ['add', '-A'], root, env);
  await checked('git', ['commit', '-q', '--no-verify', '-m', message], root, env);
}

/**
 * The fixture path must not exist. Nothing is removed or reused, so a failed run remains available
 * for diagnosis and a retry requires a new explicit path.
 */
export async function buildAuditFixture(fixturePath) {
  const fixture = path.resolve(fixturePath);
  assert(!await exists(fixture), `refusing to overwrite or reuse fixture path: ${fixture}`);
  await fs.mkdir(path.dirname(fixture), { recursive: true });
  await fs.mkdir(fixture, { recursive: false, mode: 0o700 });

  const home = path.join(fixture, 'home');
  const repo = path.join(fixture, 'repo');
  const worktreeRoot = path.join(fixture, 'worktrees');
  const emptyRepo = path.join(fixture, 'empty-repo');
  const errorRoot = path.join(fixture, 'not-a-repository');
  await fs.mkdir(home, { recursive: false, mode: 0o700 });
  await fs.mkdir(worktreeRoot, { recursive: false, mode: 0o700 });
  await fs.mkdir(errorRoot, { recursive: false, mode: 0o700 });
  const env = fixtureEnv(home);

  await initializeRepo(repo, env, 'Holt installed TUI and graph proof fixture');
  await write(repo, '.gitignore', '.agent-private/\n');
  await write(repo, 'src/base.mjs', 'export function baseline() { return 1; }\n');
  await write(repo, 'config/policy.mjs',
    'export const POLICY = {\n  payments: { owner: "platform", gate: "two-reviewers" },\n};\n');
  await commit(repo, env, 'base facts for all workstreams');

  let branchNumber = 0;
  const addWorktree = async (id, branch = `audit/case-${String(++branchNumber).padStart(2, '0')}`) => {
    const target = path.join(worktreeRoot, id);
    await checked('git', ['worktree', 'add', '-q', '-b', branch, target, 'main'], repo, env);
    return target;
  };
  const backdate = async (target, minutes) => {
    const gitDirRun = await checked('git', ['rev-parse', '--git-dir'], target, env);
    const named = gitDirRun.stdout.trim();
    const gitDir = path.isAbsolute(named) ? named : path.join(target, named);
    const when = new Date(Date.now() - minutes * 60_000);
    await fs.utimes(path.join(gitDir, 'gitdir'), when, when);
  };

  const atRisk = await addWorktree(IDS.atRisk);
  await write(atRisk, 'src/uncommitted-critical.mjs', Array.from({ length: 24 }, (_, index) =>
    `export function ONLY_UNCOMMITTED_${index}() { return ${index}; }\n`).join(''));
  await write(atRisk, '.agent-private/only-copy.txt',
    'ignored and unique: deleting this worktree destroys these exact bytes\n');

  const holding = await addWorktree(IDS.holding);
  await write(holding, 'src/committed-feature.mjs',
    'export function COMMITTED_RELEASE_FEATURE() { return "held only here"; }\n');
  await commit(holding, env, 'committed feature held only by this worktree');

  const collisionA = await addWorktree(IDS.collisionA);
  await fs.writeFile(path.join(collisionA, 'config/policy.mjs'),
    'export const POLICY = {\n  payments: { owner: "team-a", gate: "allow-on-green" },\n};\n');
  await commit(collisionA, env, 'team A changes shared payments policy');

  const collisionB = await addWorktree(IDS.collisionB);
  await fs.writeFile(path.join(collisionB, 'config/policy.mjs'),
    'export const POLICY = {\n  payments: { owner: "team-b", gate: "manual-approval" },\n};\n');
  await commit(collisionB, env, 'team B changes shared payments policy differently');

  const twinA = await addWorktree(IDS.twinA);
  await write(twinA, 'src/redundant.mjs',
    'export function IDENTICAL_RELEASE_WORK() { return "same bytes and path"; }\n');
  await commit(twinA, env, 'first copy of identical release work');
  await backdate(twinA, 180);

  const twinB = await addWorktree(IDS.twinB);
  await write(twinB, 'src/redundant.mjs',
    'export function IDENTICAL_RELEASE_WORK() { return "same bytes and path"; }\n');
  await commit(twinB, env, 'second copy of identical release work');

  const duplicateA = await addWorktree(IDS.duplicateA);
  await write(duplicateA, 'src/retry-a.mjs',
    'export function SHARED_RETRY_IMPL(items) {\n  return items.map((item) => item * 2);\n}\n');
  await commit(duplicateA, env, 'first independent implementation');
  await backdate(duplicateA, 90);

  const duplicateB = await addWorktree(IDS.duplicateB);
  await write(duplicateB, 'src/retry-b.mjs',
    'export function SHARED_RETRY_IMPL(items) {\n  return items.map((item) => item * 2);\n}\n');
  await commit(duplicateB, env, 'second independent implementation');

  await addWorktree(IDS.empty);

  const long = await addWorktree(IDS.long);
  await write(long, 'src/long-name.mjs', 'export function LONG_NAME_ONLY_COPY() { return true; }\n');

  const hostileBranch = 'audit/hostile</script><svg-onload=HOLT_XSS()>';
  const hostile = await addWorktree(IDS.hostile, hostileBranch);
  await write(hostile, 'src/hostile.mjs',
    'export function HOSTILE_ONLY_COPY() { return "</script><img src=x onerror=HOLT_XSS()>"; }\n');

  await initializeRepo(emptyRepo, env, 'Empty linked-worktree state');
  await write(errorRoot, 'why.txt', 'This directory intentionally is not a Git repository.\n');

  const collisionOracle = await checked('git', [
    'merge-tree', '--write-tree',
    await checked('git', ['rev-parse', 'audit/case-03'], repo, env).then((run) => run.stdout.trim()),
    await checked('git', ['rev-parse', 'audit/case-04'], repo, env).then((run) => run.stdout.trim()),
  ], repo, env, { allowFailure: true });
  const redundantOracle = await checked('git', [
    'merge-tree', '--write-tree',
    await checked('git', ['rev-parse', 'audit/case-05'], repo, env).then((run) => run.stdout.trim()),
    await checked('git', ['rev-parse', 'audit/case-06'], repo, env).then((run) => run.stdout.trim()),
  ], repo, env, { allowFailure: true });
  const listed = await checked('git', ['worktree', 'list', '--porcelain'], repo, env);
  const observedIds = listed.stdout.split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => path.basename(line.slice('worktree '.length)))
    .filter((id) => id !== path.basename(repo));
  assert(observedIds.length === EXPECTED.all.length,
    `Git registered ${observedIds.length} linked worktrees, expected ${EXPECTED.all.length}`);
  assert([...observedIds].sort().join('\n') === [...EXPECTED.all].sort().join('\n'),
    'Git linked-worktree identities differ from the fixture oracle');
  assert(collisionOracle.exitCode !== 0,
    'independent git merge-tree unexpectedly says the planted collision merges cleanly');
  assert(redundantOracle.exitCode === 0,
    'independent git merge-tree unexpectedly says identical twin branches conflict');

  const rawOracle = {
    kind: 'holt-tui-graph-fixture-oracle',
    generatedAt: new Date().toISOString(),
    paths: { fixture, repo, worktreeRoot, emptyRepo, errorRoot, home },
    expected: {
      ...EXPECTED,
      counts: { atRisk: 3, holds: 5, unknown: 0, disposable: 3, workstreams: 11 },
      hostile: { id: IDS.hostile, branch: hostileBranch },
    },
    independentGit: {
      worktreeList: publicRunRecord(listed),
      collisionMergeTree: publicRunRecord(collisionOracle),
      redundantMergeTree: publicRunRecord(redundantOracle),
    },
  };
  const oraclePath = path.join(fixture, 'fixture-oracle.json');
  const oracle = await writeEvidenceArtifact(oraclePath, rawOracle);

  return {
    fixture,
    repo,
    worktreeRoot,
    emptyRepo,
    errorRoot,
    home,
    env,
    oracle: {
      path: oraclePath,
      identity: oracle.identity,
      file: await captureFile(oraclePath),
      sidecar: await captureFile(`${oraclePath}.sha256`),
      value: oracle.artifact,
    },
  };
}

function parseBuilderArgs(argv) {
  if (argv.length !== 2 || argv[0] !== '--fixture' || !argv[1]) {
    throw new Error('usage: node build-audit-fixture.mjs --fixture <new-retained-path>');
  }
  return path.resolve(argv[1]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.includes('--out')) {
    // Publication-proof mode. Delegate through a second Node process because the runner imports
    // buildAuditFixture() from this module; importing it back while this top-level await is pending
    // would form an unsettled ESM cycle. The delegated process has no timeout or kill path.
    const runner = path.join(HERE, 'run-installed-proof.mjs');
    const delegated = await runProcess(process.execPath, [runner, ...argv], {
      cwd: process.cwd(), env: process.env,
    });
    process.stdout.write(delegated.stdoutRaw);
    process.stderr.write(delegated.stderrRaw);
    if (delegated.spawnError) throw new Error(`could not start installed proof runner: ${delegated.spawnError}`);
    if (delegated.signal) throw new Error(`installed proof runner terminated by ${delegated.signal}`);
    process.exitCode = delegated.exitCode ?? 1;
  } else {
    const fixture = await buildAuditFixture(parseBuilderArgs(argv));
    process.stdout.write(`${JSON.stringify({
      ok: true,
      fixture: fixture.fixture,
      repo: fixture.repo,
      oracle: fixture.oracle.file,
    }, null, 2)}\n`);
  }
}
