#!/usr/bin/env node

/**
 * Minimal deterministic reproduction of the empty ignored-directory remediation dead end found
 * in the Codex/Luna smoke. The fixture is retained and this script refuses to overwrite it.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_RUNTIME = '/home/raed/.cache/holt-benchmark/runtime-20260805-codex-luna-smoke-1/package';
const DEFAULT_WORK = '/home/raed/.cache/holt-benchmark/codex-empty-ignored-dir-reproducer-20260805-v1';
const DEFAULT_OUT = path.join(HERE, 'results-codex-empty-ignored-dir-reproducer-20260805.json');

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const runtimeRoot = path.resolve(option('--runtime', DEFAULT_RUNTIME));
const workRoot = path.resolve(option('--work', DEFAULT_WORK));
const outPath = path.resolve(option('--out', DEFAULT_OUT));
const holtBin = path.join(runtimeRoot, 'bin', 'holt.mjs');
const repo = path.join(workRoot, 'repo');
const worktree = path.join(workRoot, 'worktrees', 'empty-generated');
const dist = path.join(worktree, 'dist');
const buildTemp = path.join(worktree, 'build-temp');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function exists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function run(label, command, args, { cwd = workRoot, stdin = null } = {}) {
  const started = Date.now();
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      const out = Buffer.concat(stdout);
      const err = Buffer.concat(stderr);
      resolve({
        label,
        argv: [command, ...args],
        cwd,
        stdin: stdin === null ? null : {
          bytes: Buffer.byteLength(stdin),
          sha256: sha256(stdin),
          value: JSON.parse(stdin),
        },
        exitCode: code,
        signal: signal ?? null,
        ms: Date.now() - started,
        stdout: out.toString('utf8'),
        stdoutSha256: sha256(out),
        stderr: err.toString('utf8'),
        stderrSha256: sha256(err),
      });
    });
    child.stdin.end(stdin ?? undefined);
  });
}

function hookPayload(command, invocation) {
  return `${JSON.stringify({
    session_id: 'codex-empty-dir-reproducer',
    tool_use_id: invocation,
    cwd: repo,
    tool_name: 'Bash',
    tool_input: { command },
  })}\n`;
}

if (await exists(workRoot)) {
  throw new Error(`refusing to overwrite retained reproduction fixture: ${workRoot}`);
}
if (await exists(outPath) || await exists(`${outPath}.sha256`)) {
  throw new Error(`refusing to overwrite reproduction artifact: ${outPath}`);
}
await fs.mkdir(path.dirname(worktree), { recursive: true });

const setup = [];
setup.push(await run('git-init', 'git', ['init', '-b', 'main', repo]));
setup.push(await run('git-user-email', 'git', ['-C', repo, 'config', 'user.email', 'repro@holt.invalid']));
setup.push(await run('git-user-name', 'git', ['-C', repo, 'config', 'user.name', 'Holt Reproducer']));
await fs.writeFile(path.join(repo, '.gitignore'), 'dist/\n', { encoding: 'utf8', flag: 'wx' });
await fs.writeFile(path.join(repo, 'README.md'), '# empty-directory reproducer\n', { encoding: 'utf8', flag: 'wx' });
setup.push(await run('git-add', 'git', ['-C', repo, 'add', '.gitignore', 'README.md']));
setup.push(await run('git-commit', 'git', ['-C', repo, 'commit', '-m', 'reproduction base']));
setup.push(await run('git-worktree-add', 'git', ['-C', repo, 'worktree', 'add', '-b', 'empty-generated', worktree]));
await fs.mkdir(dist, { recursive: false });
if (setup.some((step) => step.exitCode !== 0)) throw new Error('fixture setup failed');

const commands = {
  rmdir: `rmdir '${dist}'`,
  variableRemove: `repo_root="${repo}"\nwt_root="$repo_root/../worktrees"\ngit -C "$repo_root" worktree remove "$wt_root/empty-generated"`,
  mvWorkaround: `mv '${dist}' '${buildTemp}'`,
  rmdirWorkaround: `rmdir '${buildTemp}'`,
};

const observations = [];
observations.push(await run('gate-before', process.execPath, [holtBin, 'gate', 'empty-generated', '--cwd', repo, '--json'], { cwd: repo }));
observations.push(await run('hook-rmdir-empty-dist', process.execPath, [holtBin, 'hook', 'pre-tool-use', '--host', 'codex'], {
  cwd: repo,
  stdin: hookPayload(commands.rmdir, 'rmdir-empty-dist'),
}));
observations.push(await run('discard-empty-dist-dry-run', process.execPath, [holtBin, 'discard', dist, '--dry-run', '--cwd', repo], { cwd: repo }));
observations.push(await run('rescue-empty-worktree-dry-run', process.execPath, [holtBin, 'rescue', 'empty-generated', '--dry-run', '--cwd', repo], { cwd: repo }));
observations.push(await run('rescue-empty-worktree', process.execPath, [holtBin, 'rescue', 'empty-generated', '--cwd', repo], { cwd: repo }));
const distAfterRescue = await exists(dist);
observations.push(await run('hook-variable-worktree-remove', process.execPath, [holtBin, 'hook', 'pre-tool-use', '--host', 'codex'], {
  cwd: repo,
  stdin: hookPayload(commands.variableRemove, 'variable-worktree-remove'),
}));
observations.push(await run('hook-mv-empty-dist', process.execPath, [holtBin, 'hook', 'pre-tool-use', '--host', 'codex'], {
  cwd: repo,
  stdin: hookPayload(commands.mvWorkaround, 'mv-empty-dist'),
}));
observations.push(await run('hook-rmdir-renamed-empty-dir', process.execPath, [holtBin, 'hook', 'pre-tool-use', '--host', 'codex'], {
  cwd: repo,
  stdin: hookPayload(commands.rmdirWorkaround, 'rmdir-renamed-empty-dir'),
}));

const byLabel = Object.fromEntries(observations.map((observation) => [observation.label, observation]));
const reproductionChecks = {
  emptyDirExistsBefore: true,
  rmdirIsRefused: byLabel['hook-rmdir-empty-dist'].exitCode === 2,
  discardCannotResolveEmptyDir: byLabel['discard-empty-dist-dry-run'].exitCode !== 0,
  rescueDryRunClaimsSuccess: byLabel['rescue-empty-worktree-dry-run'].exitCode === 0,
  rescueActualFails: byLabel['rescue-empty-worktree'].exitCode !== 0,
  emptyDirSurvivesFailedRescue: distAfterRescue,
  variableChainIsRefused: byLabel['hook-variable-worktree-remove'].exitCode === 2,
  renameWorkaroundIsAllowed: byLabel['hook-mv-empty-dist'].exitCode === 0,
  renamedRmdirWorkaroundIsAllowed: byLabel['hook-rmdir-renamed-empty-dir'].exitCode === 0,
};
const reproductionMatches = Object.values(reproductionChecks).every(Boolean);
const runtimeBinBytes = await fs.readFile(holtBin);
const artifact = {
  schema: 'holt-empty-ignored-directory-reproducer-v1',
  generatedAt: new Date().toISOString(),
  reproductionMatches,
  reproductionChecks,
  scope: 'one clean linked worktree containing one empty ignored dist directory and no uncommitted file bytes',
  source: {
    script: fileURLToPath(import.meta.url),
    runtimeRoot,
    holtBin,
    holtBinSha256: sha256(runtimeBinBytes),
    pinnedTarball: '/home/raed/.cache/holt-benchmark/runtime-20260805-codex-luna-smoke-1/packed/holt-0.3.1.tgz',
    pinnedTarballSha256: 'eb7a438505735cd3a11de66c9a03c81bfe0ab204952edc0673ffd2746f1bb77d',
  },
  retainedFixture: { workRoot, repo, worktree, dist, distAfterRescue },
  commands,
  setup,
  observations,
  causalFinding: reproductionMatches
    ? 'Holt blocks deletion of an empty ignored directory, recommends capture operations that cannot represent it, and allows the same deletion after a name-only rename.'
    : 'The pinned runtime did not reproduce every expected observation; inspect individual exit codes and outputs.',
};
const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
await fs.writeFile(outPath, serialized, { encoding: 'utf8', flag: 'wx' });
await fs.writeFile(`${outPath}.sha256`, `${sha256(serialized)}  ${path.basename(outPath)}\n`, { encoding: 'utf8', flag: 'wx' });
console.log(JSON.stringify({
  reproductionMatches,
  reproductionChecks,
  outPath,
  outSha256: sha256(serialized),
  retainedFixture: workRoot,
}, null, 2));
if (!reproductionMatches) process.exitCode = 2;
