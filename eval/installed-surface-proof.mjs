#!/usr/bin/env node
// SPDX-License-Identifier: FSL-1.1-MIT

/**
 * Publication proof for one exact, frozen npm installation of Holt.
 *
 * This runner deliberately imports no Holt production module. Every product observation crosses
 * the same executable or stdio boundary a user/agent crosses. The only shared dependency is Node
 * itself. A run is write-once, has no skip/only switch and imposes no internal time limit; an
 * operator may cancel the process externally, but a partial run can never become valid evidence.
 */

import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH_MARKER = '.holt-installed-surface-proof';
const SCHEMA = 'holt-installed-surface-proof-v1';

export const CLI_COMMANDS = Object.freeze([
  'status', 'risk', 'collisions', 'hotspots', 'duplicates', 'context', 'plan', 'impact',
  'order', 'partition', 'branches', 'journal', 'forensics', 'fleet', 'license',
  'managed-policy', 'ci', 'graph', 'stash', 'gate', 'tui', 'setup', 'doctor', 'audit',
  'auto', 'protect', 'unprotect', 'rescue', 'rescued', 'clean', 'quarantines', 'restore',
  'purge', 'discard', 'verify', 'hosts', 'providers', 'integrate', 'uninstall', 'brief',
  'mcp', 'hook',
]);

export const MCP_TOOLS = Object.freeze([
  'holt_at_risk', 'holt_branches', 'holt_check_workstream', 'holt_clean',
  'holt_collisions', 'holt_context', 'holt_duplicates', 'holt_hotspots', 'holt_impact',
  'holt_landing_order', 'holt_landing_plan', 'holt_partition', 'holt_protect',
  'holt_purge', 'holt_rescue', 'holt_status',
]);

const CLI_TIER = Object.freeze({
  fleet: 'team',
  license: 'team-control',
  'managed-policy': 'enterprise',
});

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const portable = (value) => String(value).split(path.sep).join('/');
const foldCase = (value) => (
  process.platform === 'win32' || process.platform === 'darwin'
    ? String(value).toLowerCase()
    : String(value)
);
const canonicalPath = (value) => fs.realpath(value);
// This proof intentionally imports no Holt production module. Compare the two existing paths
// independently after the filesystem resolves symlinks, short names, and canonical spelling.
const sameExistingPath = async (left, right) => (
  foldCase(await canonicalPath(left)) === foldCase(await canonicalPath(right))
);
const exists = (value) => fs.lstat(value).then(() => true, (error) => {
  if (error?.code === 'ENOENT') return false;
  throw error;
});
const inside = (parent, child) => {
  const rel = path.relative(foldCase(parent), foldCase(child));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
};
// Git reports canonical paths on macOS (/private/var/...), while Node's temp helpers may return
// the display alias (/var/...). Resolve both sides before containment arithmetic; comparing the
// strings directly turns a worktree that is visibly inside the fixture into an apparent escape.
const insideExisting = async (parent, child) => inside(
  await canonicalPath(parent), await canonicalPath(child),
);

function requireExactSet(actual, expected, label) {
  const a = [...new Set(actual)].sort();
  const e = [...new Set(expected)].sort();
  const missing = e.filter((value) => !a.includes(value));
  const extra = a.filter((value) => !e.includes(value));
  if (missing.length || extra.length || actual.length !== expected.length) {
    throw new Error(
      `${label} denominator mismatch: observed ${actual.length}/${expected.length}; `
      + `missing [${missing.join(', ')}], extra [${extra.join(', ')}]`,
    );
  }
}

export function parseArgs(argv = process.argv.slice(2)) {
  const allowed = new Set(['runtime', 'holt-bin', 'freeze-evidence', 'out', 'work']);
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`unexpected positional argument: ${token}`);
    const key = token.slice(2);
    if (!allowed.has(key)) throw new Error(`unknown option --${key}; this runner has no skip/only mode`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`--${key} requires a value`);
    if (values[key] !== undefined) throw new Error(`--${key} may be supplied only once`);
    values[key] = path.resolve(value);
  }
  for (const key of ['runtime', 'holt-bin', 'freeze-evidence', 'out']) {
    if (!values[key]) throw new Error(`--${key} is required`);
  }
  values.work ??= `${values.out}.work`;
  return {
    runtime: values.runtime,
    holtBin: values['holt-bin'],
    freezeEvidence: values['freeze-evidence'],
    out: values.out,
    work: values.work,
  };
}

async function captureFile(file) {
  const bytes = await fs.readFile(file);
  return { path: file, bytes: bytes.length, sha256: sha256(bytes) };
}

function captureBytes(bytes) {
  const value = Buffer.from(bytes);
  return {
    bytes: value.length,
    sha256: sha256(value),
    base64: value.toString('base64'),
  };
}

/** Exact algorithm used by freeze-installed-runtime.mjs, duplicated here on purpose. */
export async function installationTreeIdentity(root) {
  const entries = [];
  const visit = async (absolute, relative) => {
    const stat = await fs.lstat(absolute);
    const mode = stat.mode & 0o777;
    if (stat.isSymbolicLink()) {
      entries.push({ relative, kind: 'symlink', mode, target: await fs.readlink(absolute) });
      return;
    }
    if (stat.isDirectory()) {
      if (relative) entries.push({ relative, kind: 'directory', mode });
      const children = await fs.readdir(absolute, { withFileTypes: true });
      children.sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) {
        await visit(path.join(absolute, child.name), path.join(relative, child.name));
      }
      return;
    }
    if (stat.isFile()) entries.push({ relative, kind: 'file', mode, content: await fs.readFile(absolute) });
  };
  await visit(root, '');
  const hash = createHash('sha256');
  let bytes = 0;
  let files = 0;
  let symlinks = 0;
  let directories = 0;
  for (const entry of entries.sort((a, b) => a.relative.localeCompare(b.relative))) {
    hash.update(portable(entry.relative)).update('\0').update(entry.kind).update('\0')
      .update(entry.mode.toString(8)).update('\0');
    if (entry.kind === 'file') {
      hash.update(entry.content);
      bytes += entry.content.length;
      files++;
    } else if (entry.kind === 'symlink') {
      hash.update(entry.target);
      symlinks++;
    } else {
      directories++;
    }
    hash.update('\0');
  }
  return {
    root,
    sha256: hash.digest('hex'),
    entries: entries.length,
    files,
    symlinks,
    directories,
    bytes,
    semantics: 'all files, symlink targets, directories, and permission modes under install root',
  };
}

/** A reviewable path/type/mode/size/hash inventory, used for every fixture tree. */
async function byteTreeManifest(root, { omitRootDirectory = null } = {}) {
  const rows = [];
  const visit = async (absolute, relative) => {
    if (relative === omitRootDirectory) return;
    const stat = await fs.lstat(absolute);
    const mode = stat.mode & 0o777;
    if (stat.isSymbolicLink()) {
      const target = await fs.readlink(absolute);
      rows.push({ path: portable(relative), type: 'symlink', mode, target, sha256: sha256(target) });
      return;
    }
    if (stat.isDirectory()) {
      if (relative) rows.push({ path: portable(relative), type: 'directory', mode });
      const children = await fs.readdir(absolute, { withFileTypes: true });
      children.sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) await visit(path.join(absolute, child.name), path.join(relative, child.name));
      return;
    }
    if (stat.isFile()) {
      const bytes = await fs.readFile(absolute);
      rows.push({ path: portable(relative), type: 'file', mode, bytes: bytes.length, sha256: sha256(bytes) });
      return;
    }
    rows.push({ path: portable(relative), type: 'other', mode, size: stat.size });
  };
  await visit(root, '');
  const identity = sha256(JSON.stringify(rows));
  return { root, entries: rows.length, identity, rows };
}

async function runProcess(command, args, { cwd, env, stdin = null } = {}) {
  const startedAt = new Date().toISOString();
  const started = process.hrtime.bigint();
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
  if (stdin === null) child.stdin.end();
  else child.stdin.end(stdin);
  const completion = await new Promise((resolve) => {
    let spawnError = null;
    child.once('error', (error) => { spawnError = error.message; });
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal: signal ?? null, spawnError }));
  });
  const out = Buffer.concat(stdout);
  const err = Buffer.concat(stderr);
  return {
    command,
    argv: args,
    cwd,
    startedAt,
    elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
    ...completion,
    stdin: stdin === null ? null : captureBytes(Buffer.from(stdin)),
    stdout: out.toString('utf8'),
    stdoutBytes: out.length,
    stdoutSha256: sha256(out),
    stdoutBase64: out.toString('base64'),
    stderr: err.toString('utf8'),
    stderrBytes: err.length,
    stderrSha256: sha256(err),
    stderrBase64: err.toString('base64'),
  };
}

function parseJsonOutput(run, label) {
  try { return JSON.parse(run.stdout); } catch (error) {
    throw new Error(`${label} did not emit one JSON value: ${error.message}; stdout=${run.stdout.slice(0, 300)}`);
  }
}

async function git(args, cwd, env, { allowFailure = false, stdin = null } = {}) {
  const result = await runProcess('git', args, { cwd, env, stdin });
  if (!allowFailure && (result.exitCode !== 0 || result.signal || result.spawnError)) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr || result.spawnError}`);
  }
  return result;
}

function isolatedEnv(home, runtime, holtBin) {
  const pathEntries = [
    path.join(runtime, 'node_modules', '.bin'),
    path.dirname(holtBin),
    '/usr/local/bin', '/usr/bin', '/bin',
  ];
  const env = {
    PATH: [...new Set(pathEntries)].join(path.delimiter),
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    HOLT_HOME: path.join(home, '.holt-home'),
    HOLT_TMPDIR: path.join(home, '.tmp'),
    // Git for Windows is an MSYS program: it accepts /dev/null and rejects Node's \\.\nul.
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'Holt publication proof',
    GIT_AUTHOR_EMAIL: 'proof@holt.invalid',
    GIT_COMMITTER_NAME: 'Holt publication proof',
    GIT_COMMITTER_EMAIL: 'proof@holt.invalid',
    GIT_TERMINAL_PROMPT: '0',
    NO_COLOR: '1',
    TERM: 'dumb',
    LC_ALL: 'C.UTF-8',
    LANG: 'C.UTF-8',
  };
  if (process.platform === 'win32') {
    for (const key of ['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
      if (process.env[key]) env[key] = process.env[key];
    }
  }
  return env;
}

async function executableOnPath(name, searchPath) {
  for (const directory of String(searchPath).split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      await fs.access(candidate, fsConstants.X_OK);
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return fs.realpath(candidate);
    } catch { /* keep looking */ }
  }
  throw new Error(`could not resolve executable ${name} on the isolated PATH`);
}

function shellSingleQuoted(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

/**
 * `holt_hotspots` is the fallback surface for merge evidence that Git cannot answer. MCP does not
 * expose the CLI's strict-read-only switch, so this fixture makes that dependency failure real and
 * bounded: every Git argv is delegated byte-for-byte except merge-tree for the two planted heads,
 * which exits 129. All single-workstream scans still use real Git. The exact shim, target OIDs and
 * real Git executable identities are retained in the evidence.
 */
async function installMergeTreeFailureFixture(fixture) {
  const realGit = await executableOnPath('git', fixture.env.PATH);
  const [hotspotA, hotspotB] = await Promise.all(fixture.truth.hotspot.map(async (id) => {
    const run = await git(['rev-parse', 'HEAD'], fixture.worktrees[id], fixture.env);
    return run.stdout.trim();
  }));
  const binDir = path.join(fixture.root, 'dependency-failure-bin');
  const wrapper = path.join(binDir, 'git');
  await fs.mkdir(binDir, { recursive: false, mode: 0o700 });
  const script = [
    '#!/bin/sh',
    `if [ "$1" = "merge-tree" ] && { { [ "$3" = "${hotspotA}" ] && [ "$4" = "${hotspotB}" ]; } || { [ "$3" = "${hotspotB}" ] && [ "$4" = "${hotspotA}" ]; }; }; then`,
    "  printf '%s\\n' 'publication proof: independently induced merge-tree unavailable' >&2",
    '  exit 129',
    'fi',
    `exec ${shellSingleQuoted(realGit)} "$@"`,
    '',
  ].join('\n');
  await fs.writeFile(wrapper, script, { encoding: 'utf8', flag: 'wx', mode: 0o700 });
  fixture.env.PATH = `${binDir}${path.delimiter}${fixture.env.PATH}`;
  return {
    purpose: 'force a real pair-level merge-tree dependency failure so MCP low-evidence hotspot fallback is observable',
    semantics: 'all git argv delegate unchanged except the exact planted hotspot head pair, whose merge-tree exits 129',
    targetHeads: [hotspotA, hotspotB],
    wrapper: await captureFile(wrapper),
    realGit: await captureFile(realGit),
    pathPrefix: binDir,
  };
}

export async function assertFreshScratch(work) {
  if (inside(SOURCE_ROOT, work)) throw new Error(`scratch must be outside the developer checkout: ${work}`);
  if (await exists(work)) {
    const marker = path.join(work, SCRATCH_MARKER);
    const marked = await exists(marker);
    throw new Error(
      `scratch already exists${marked ? ' and belongs to an earlier write-once run' : ' without this runner marker'}; `
      + `refusing to reuse or delete it: ${work}`,
    );
  }
  await fs.mkdir(work, { recursive: false, mode: 0o700 });
  const nonce = randomBytes(24).toString('hex');
  await fs.writeFile(path.join(work, SCRATCH_MARKER), `${SCHEMA}\n${nonce}\n`, { flag: 'wx', mode: 0o600 });
  return { path: work, marker: SCRATCH_MARKER, nonce, retained: true };
}

async function verifyOwnedScratch(work, nonce) {
  const raw = await fs.readFile(path.join(work, SCRATCH_MARKER), 'utf8');
  if (raw !== `${SCHEMA}\n${nonce}\n`) throw new Error(`scratch ownership marker drifted: ${work}`);
}

function semanticEvidenceIdentity(parsed) {
  const { artifact: _artifact, summary: _summary, ...raw } = parsed;
  return `sha256:${sha256(JSON.stringify(raw))}`;
}

export async function verifyFreezeEvidence({ runtime, holtBin, freezeEvidence }) {
  const [runtimeReal, binReal, evidenceReal] = await Promise.all([
    fs.realpath(runtime), fs.realpath(holtBin), fs.realpath(freezeEvidence),
  ]);
  if (!inside(runtimeReal, binReal)) throw new Error(`--holt-bin is outside --runtime: ${binReal}`);
  const rawBytes = await fs.readFile(evidenceReal);
  const exactSha = sha256(rawBytes);
  const sidecarPath = `${evidenceReal}.sha256`;
  const sidecar = await fs.readFile(sidecarPath, 'utf8');
  const expectedSidecar = `${exactSha}  ${path.basename(evidenceReal)}\n`;
  if (sidecar !== expectedSidecar) throw new Error(`freeze evidence sidecar mismatch: ${sidecarPath}`);
  const parsed = JSON.parse(rawBytes.toString('utf8'));
  if (parsed.kind !== 'holt-frozen-installed-runtime' || parsed.valid !== true) {
    throw new Error('freeze evidence is not a valid holt-frozen-installed-runtime artifact');
  }
  if (parsed.artifact?.schema !== 'holt-eval-evidence-v2') throw new Error('freeze evidence schema is not v2');
  const semantic = semanticEvidenceIdentity(parsed);
  if (parsed.artifact?.identity !== semantic) throw new Error('freeze evidence semantic identity mismatch');

  const packageRoot = path.resolve(parsed.runtime?.packageRoot ?? '');
  const executable = path.resolve(parsed.runtime?.before?.executable?.path ?? '');
  const recordedRuntime = path.resolve(parsed.runtime?.root ?? '');
  const [packageReal, executableReal, recordedRuntimeReal] = await Promise.all([
    fs.realpath(packageRoot), fs.realpath(executable), fs.realpath(recordedRuntime),
  ]);
  if (recordedRuntimeReal !== runtimeReal) throw new Error('freeze evidence names a different install root');
  if (executableReal !== binReal) throw new Error('freeze evidence names a different executable');
  if (!inside(runtimeReal, packageReal)) throw new Error('freeze evidence package root is outside the runtime');

  const [runtimeTree, packageTree, executableIdentity] = await Promise.all([
    installationTreeIdentity(runtimeReal),
    installationTreeIdentity(packageReal),
    captureFile(binReal),
  ]);
  for (const [label, actual, expected] of [
    ['runtime tree', runtimeTree.sha256, parsed.runtime?.before?.installTree?.sha256],
    ['runtime after-tree', runtimeTree.sha256, parsed.runtime?.afterTree?.sha256],
    ['package tree', packageTree.sha256, parsed.runtime?.before?.packageTree?.sha256],
    ['executable', executableIdentity.sha256, parsed.runtime?.before?.executable?.sha256],
  ]) {
    if (!expected || actual !== expected) throw new Error(`${label} does not match freeze evidence`);
  }
  if (parsed.runtime?.immutableAcrossPreflight !== true) throw new Error('freeze preflight did not prove immutability');
  if (parsed.preflight?.valid !== true || parsed.preflight?.shutdown?.clean !== true) {
    throw new Error('freeze MCP preflight was not valid with a clean shutdown');
  }

  const tarballPath = path.resolve(parsed.tarball?.path ?? '');
  const tarballReal = await fs.realpath(tarballPath);
  const tarball = await captureFile(tarballReal);
  if (tarball.sha256 !== parsed.tarball?.sha256 || tarball.bytes !== parsed.tarball?.bytes) {
    throw new Error('referenced npm tarball bytes do not match freeze evidence');
  }
  const packageJsonPath = path.join(packageReal, 'package.json');
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
  if (packageJson.name !== 'holt' || packageJson.version !== parsed.runtime?.package?.version) {
    throw new Error('installed package identity does not match freeze evidence');
  }
  const declaredBin = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.holt;
  if (!declaredBin) throw new Error('installed package does not declare bin.holt');
  if (!await sameExistingPath(path.join(packageReal, declaredBin), binReal)) {
    throw new Error('--holt-bin is not the installed package\'s declared holt executable');
  }
  return {
    valid: true,
    file: { path: evidenceReal, bytes: rawBytes.length, sha256: exactSha },
    sidecar: await captureFile(sidecarPath),
    semanticIdentity: semantic,
    runtime: runtimeTree,
    package: packageTree,
    packageRoot: packageReal,
    executable: executableIdentity,
    packageJson: { path: packageJsonPath, name: packageJson.name, version: packageJson.version },
    tarball,
  };
}

async function writeText(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, { encoding: 'utf8', flag: 'wx' });
}

async function commitAll(repo, env, message) {
  await git(['add', '-A'], repo, env);
  await git(['commit', '--no-verify', '-m', message], repo, env);
}

async function addWorktree(fixture, name, { branch = `wt/${name}`, detach = false } = {}) {
  const target = path.join(fixture.root, 'worktrees', name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const argv = detach
    ? ['worktree', 'add', '--detach', target, 'main']
    : ['worktree', 'add', '-b', branch, target, 'main'];
  await git(argv, fixture.repo, fixture.env);
  fixture.worktrees[name] = target;
  return target;
}

/** Fresh, independently planted ground truth for one CLI command or one MCP tool. */
export async function buildFixture(probeRoot, runtime, holtBin, { rich = false, stash = false } = {}) {
  await fs.mkdir(probeRoot, { recursive: false, mode: 0o700 });
  await fs.writeFile(path.join(probeRoot, SCRATCH_MARKER), `${SCHEMA}\nfixture\n`, { flag: 'wx' });
  const home = path.join(probeRoot, 'home');
  const repo = path.join(probeRoot, 'repo');
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(repo, { recursive: true });
  const env = isolatedEnv(home, runtime, holtBin);
  await fs.mkdir(env.HOLT_TMPDIR, { recursive: true });
  await git(['init', '--initial-branch=main', '-q'], repo, env);
  await git(['config', 'user.name', 'Holt publication proof'], repo, env);
  await git(['config', 'user.email', 'proof@holt.invalid'], repo, env);
  await git(['config', 'commit.gpgsign', 'false'], repo, env);
  await git(['config', 'core.autocrlf', 'false'], repo, env);
  await writeText(path.join(repo, 'README.md'), '# independently planted fixture\n');
  await writeText(path.join(repo, 'src', 'base.js'), 'export function BASELINE() { return 1; }\n');
  await writeText(path.join(repo, 'config', 'registry.mjs'), 'export const REGISTRY = { BASE: true };\n');
  await writeText(path.join(repo, 'config', 'hotspot.mjs'), 'export const HOTSPOT_BASE = true;\n');
  await commitAll(repo, env, 'base');

  // A branch checked out nowhere and carrying a known unique path, for branches/CI oracles.
  await git(['checkout', '-q', '-b', 'abandoned-proof'], repo, env);
  await writeText(path.join(repo, 'src', 'abandoned.js'), 'export const ABANDONED_PROOF = true;\n');
  await commitAll(repo, env, 'plant unlanded branch');
  await git(['checkout', '-q', 'main'], repo, env);

  const fixture = { root: probeRoot, repo, home, env, worktrees: {}, truth: {} };
  const unique = await addWorktree(fixture, 'unique-work');
  await writeText(path.join(unique, 'src', 'sole-copy.js'),
    'export function SOLE_COPY_PROOF() { return "exists nowhere else"; }\n');
  // JSON.stringify must escape both. Any raw occurrence on the MCP wire is a security failure.
  const hostileName = `hostile-${String.fromCodePoint(0x2028)}${String.fromCodePoint(0x202e)}.js`;
  await writeText(path.join(unique, 'src', hostileName), 'export const HOSTILE_PROOF = true;\n');
  const empty = await addWorktree(fixture, 'empty-work');
  fixture.truth = {
    unique: 'unique-work', empty: 'empty-work', hostileName,
    unlandedBranch: 'abandoned-proof', soleCopyPath: 'src/sole-copy.js',
  };

  if (rich) {
    const collisionA = await addWorktree(fixture, 'collision-a');
    await fs.writeFile(path.join(collisionA, 'config', 'registry.mjs'),
      'export const REGISTRY = { BASE: true, COLLISION_PROOF: "A" };\n');
    await commitAll(collisionA, env, 'collision A');
    const collisionB = await addWorktree(fixture, 'collision-b');
    await fs.writeFile(path.join(collisionB, 'config', 'registry.mjs'),
      'export const REGISTRY = { BASE: true, COLLISION_PROOF: "B" };\n');
    await commitAll(collisionB, env, 'collision B');

    const duplicateA = await addWorktree(fixture, 'duplicate-a');
    await writeText(path.join(duplicateA, 'src', 'dup-a.js'),
      'export function DUPLICATE_PROOF(items) { return items.map((item) => item * 17); }\n');
    await commitAll(duplicateA, env, 'duplicate A');
    const duplicateB = await addWorktree(fixture, 'duplicate-b');
    await writeText(path.join(duplicateB, 'src', 'dup-b.js'),
      'export function DUPLICATE_PROOF(items) { return items.map((item) => item * 17); }\n');
    await commitAll(duplicateB, env, 'duplicate B');

    // Strict-read-only deliberately leaves merge-tree unknown. Two committed workstreams touch
    // the same file but add different symbols, so the independently known ground truth is the
    // low-evidence/co-located pair that `hotspots` is specifically meant to aggregate.
    const hotspotA = await addWorktree(fixture, 'hotspot-a');
    await fs.writeFile(path.join(hotspotA, 'config', 'hotspot.mjs'), 'export const HOTSPOT_A = 1;\n');
    await commitAll(hotspotA, env, 'hotspot A');
    const hotspotB = await addWorktree(fixture, 'hotspot-b');
    await fs.writeFile(path.join(hotspotB, 'config', 'hotspot.mjs'), 'export const HOTSPOT_B = 2;\n');
    await commitAll(hotspotB, env, 'hotspot B');

    const producer = await addWorktree(fixture, 'producer');
    await writeText(path.join(producer, 'src', 'producer.js'),
      'export function CROSS_WORKTREE_API_PROOF(value) { return value + 1; }\n');
    await commitAll(producer, env, 'producer');
    const consumer = await addWorktree(fixture, 'consumer');
    await writeText(path.join(consumer, 'src', 'consumer.js'),
      'export function USE_CROSS_WORKTREE_API_PROOF() { return CROSS_WORKTREE_API_PROOF(3); }\n');
    await commitAll(consumer, env, 'consumer');
    Object.assign(fixture.truth, {
      collision: ['collision-a', 'collision-b'],
      collisionFile: 'config/registry.mjs',
      hotspot: ['hotspot-a', 'hotspot-b'],
      hotspotFile: 'config/hotspot.mjs',
      duplicate: ['duplicate-a', 'duplicate-b'],
      impact: { producer: 'producer', consumer: 'consumer', symbol: 'CROSS_WORKTREE_API_PROOF' },
    });
  }

  if (stash) {
    await fs.writeFile(path.join(repo, 'README.md'), '# unique stashed bytes\n');
    await git(['stash', 'push', '-m', 'publication-proof-stash'], repo, env);
    fixture.truth.stashMessage = 'publication-proof-stash';
  }
  return fixture;
}

function parseWorktreePorcelainZ(buffer) {
  const records = [];
  let record = null;
  for (const token of buffer.toString('utf8').split('\0')) {
    if (!token) {
      if (record) records.push(record);
      record = null;
      continue;
    }
    const space = token.indexOf(' ');
    const key = space === -1 ? token : token.slice(0, space);
    const value = space === -1 ? true : token.slice(space + 1);
    if (key === 'worktree') {
      if (record) records.push(record);
      record = { path: value };
    } else if (record) record[key] = value;
  }
  if (record) records.push(record);
  return records;
}

/**
 * Complete fixture identity: all registered sibling bytes plus raw refs/index/status/diffs and
 * the complete common Git directory. This prevents a clean primary checkout from hiding the
 * only copy of work in a linked worktree.
 */
export async function fixtureManifest(fixture) {
  const wtRun = await git(['worktree', 'list', '--porcelain', '-z'], fixture.repo, fixture.env);
  const wtRaw = Buffer.from(wtRun.stdoutBase64, 'base64');
  const records = parseWorktreePorcelainZ(wtRaw);
  if (!records.length) throw new Error(`fixture has no registered worktrees: ${fixture.repo}`);
  const commonRun = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], fixture.repo, fixture.env);
  const commonGitDir = commonRun.stdout.trim();
  const commonReal = await fs.realpath(commonGitDir);
  if (!await insideExisting(fixture.root, commonReal)) {
    throw new Error(`fixture common Git dir escaped scratch: ${commonReal}`);
  }
  const refsRun = await git(['show-ref', '--head', '-d'], fixture.repo, fixture.env, { allowFailure: true });
  const worktrees = [];
  for (const record of records) {
    const real = await fs.realpath(record.path);
    if (!await insideExisting(fixture.root, real)) {
      throw new Error(`registered worktree escaped fixture root: ${real}`);
    }
    const [status, indexListing, diff, diffCached, gitDirRun, head, branch] = await Promise.all([
      git(['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignored=matching'], real, fixture.env),
      git(['ls-files', '--stage', '-z'], real, fixture.env),
      git(['diff', '--binary', '--no-ext-diff', 'HEAD'], real, fixture.env, { allowFailure: true }),
      git(['diff', '--binary', '--no-ext-diff', '--cached', 'HEAD'], real, fixture.env, { allowFailure: true }),
      git(['rev-parse', '--path-format=absolute', '--git-dir'], real, fixture.env),
      git(['rev-parse', 'HEAD'], real, fixture.env, { allowFailure: true }),
      git(['symbolic-ref', '-q', 'HEAD'], real, fixture.env, { allowFailure: true }),
    ]);
    const gitDir = gitDirRun.stdout.trim();
    const indexPath = path.join(gitDir, 'index');
    worktrees.push({
      registered: record,
      path: real,
      head: head.stdout.trim() || null,
      branch: branch.stdout.trim() || null,
      files: await byteTreeManifest(real, { omitRootDirectory: '.git' }),
      gitPointer: (await fs.lstat(path.join(real, '.git'))).isFile()
        ? await captureFile(path.join(real, '.git')) : { directory: true },
      indexFile: await exists(indexPath) ? await captureFile(indexPath) : null,
      indexListing: captureBytes(Buffer.from(indexListing.stdoutBase64, 'base64')),
      status: captureBytes(Buffer.from(status.stdoutBase64, 'base64')),
      workingDiff: captureBytes(Buffer.from(diff.stdoutBase64, 'base64')),
      stagedDiff: captureBytes(Buffer.from(diffCached.stdoutBase64, 'base64')),
    });
  }
  worktrees.sort((a, b) => a.path.localeCompare(b.path));
  const raw = {
    repo: fixture.repo,
    worktreeList: captureBytes(wtRaw),
    refs: captureBytes(Buffer.from(refsRun.stdoutBase64, 'base64')),
    commonGitDir: await byteTreeManifest(commonReal),
    registeredCount: records.length,
    worktrees,
  };
  return { ...raw, identity: sha256(JSON.stringify(raw)) };
}

function pairMatches(row, expected) {
  const values = [row?.a, row?.b];
  return expected.every((id) => values.includes(id));
}

function assertProbe(probe, condition, message, evidence = null) {
  const row = { ok: Boolean(condition), message, evidence };
  probe.assertions.push(row);
  if (!row.ok) probe.failures.push(message);
}

async function runHolt(context, fixture, args, { stdin = null, role = 'subject' } = {}) {
  const result = await runProcess(process.execPath, [context.holtBin, ...args], {
    cwd: fixture.repo,
    env: fixture.env,
    stdin,
  });
  return { role, ...result };
}

function assertExit(probe, run, expected, label) {
  assertProbe(probe,
    run.exitCode === expected && run.signal === null && run.spawnError === null,
    `${label}: expected exit ${expected} with no signal/spawn error, got exit=${run.exitCode} signal=${run.signal} error=${run.spawnError}`,
    { exitCode: run.exitCode, signal: run.signal, spawnError: run.spawnError });
}

async function refExists(fixture, ref) {
  const result = await git(['show-ref', '--verify', '--quiet', ref], fixture.repo, fixture.env, { allowFailure: true });
  return result.exitCode === 0;
}

function registered(manifest, id) {
  return manifest.worktrees.find((row) => path.basename(row.path) === id || row.registered?.branch === `refs/heads/wt/${id}`);
}

const RICH_CLI = new Set(['collisions', 'hotspots', 'duplicates', 'impact', 'graph', 'verify']);

export async function runCliProbe(context, command, index) {
  if (command === 'mcp') throw new Error('cli:mcp is closed by the protocol tool matrix, not a second help-only probe');
  const probeRoot = path.join(context.work, 'cli', `${String(index + 1).padStart(2, '0')}-${command}`);
  await fs.mkdir(path.dirname(probeRoot), { recursive: true });
  const fixture = await buildFixture(probeRoot, context.runtime, context.holtBin, {
    rich: RICH_CLI.has(command),
    stash: command === 'stash',
  });
  const probe = {
    surface: `cli:${command}`,
    command,
    tier: CLI_TIER[command] ?? 'free-core',
    mode: ['fleet', 'managed-policy'].includes(command) ? 'bounded-unlicensed-refusal' : 'behavioral',
    skipped: false,
    fixtureRoot: fixture.root,
    truth: fixture.truth,
    plantedManifest: null,
    beforeSubjectManifest: null,
    afterSubjectManifest: null,
    arrangements: [],
    invocations: [],
    assertions: [],
    failures: [],
  };

  // Hostile pre-existing user content makes integrate/uninstall preservation observable.
  if (command === 'integrate' || command === 'uninstall') {
    await writeText(path.join(fixture.repo, 'AGENTS.md'), 'THIRD_PARTY_SENTINEL must survive Holt integration.\n');
  }
  // Discard needs real tracked + untracked bytes; both are planted before the evidence sample.
  if (command === 'discard') {
    await fs.writeFile(path.join(fixture.repo, 'README.md'), '# valuable local edit\n');
    await writeText(path.join(fixture.repo, 'untracked-discard-proof.txt'), 'untracked valuable bytes\n');
  }

  probe.plantedManifest = await fixtureManifest(fixture);
  assertProbe(probe,
    probe.plantedManifest.registeredCount === Object.keys(fixture.worktrees).length + 1,
    'fixture manifest covers the primary and every registered linked worktree', {
      registered: probe.plantedManifest.registeredCount,
      planted: Object.keys(fixture.worktrees).length + 1,
    });

  const arrange = async (args, { stdin = null } = {}) => {
    const run = await runHolt(context, fixture, args, { stdin, role: 'arrangement' });
    probe.arrangements.push(run);
    return run;
  };
  const invoke = async (args, { stdin = null } = {}) => {
    const run = await runHolt(context, fixture, args, { stdin, role: 'subject' });
    probe.invocations.push(run);
    return run;
  };
  let arrangementValue = null;
  const destructivePayload = JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command: `rm -rf ${fixture.worktrees[fixture.truth.unique]}` },
    cwd: fixture.repo,
  });

  if (command === 'journal' || command === 'forensics') {
    const run = await arrange([
      'hook', 'pre-tool-use', '--host', 'generic', '--cwd', fixture.repo,
    ], { stdin: destructivePayload });
    assertProbe(probe, run.exitCode === 2 && /deny/.test(run.stdout),
      `${command} arrangement planted a real blocked hook event`, { exitCode: run.exitCode });
  } else if (command === 'unprotect') {
    const run = await arrange(['protect', '--json', '--cwd', fixture.repo]);
    assertProbe(probe, run.exitCode === 0, 'unprotect arrangement successfully protected at-risk work');
  } else if (['rescued'].includes(command)) {
    const run = await arrange(['rescue', fixture.truth.unique, '--release', '--json', '--cwd', fixture.repo]);
    arrangementValue = run.exitCode === 0 ? parseJsonOutput(run, `${command} arrangement`) : null;
    assertProbe(probe, run.exitCode === 0 && arrangementValue?.verified === true,
      'rescued arrangement created a verified rescue ref');
  } else if (['quarantines', 'restore', 'purge'].includes(command)) {
    const run = await arrange(['clean', '--apply', '--json', '--cwd', fixture.repo]);
    arrangementValue = run.exitCode === 0 ? parseJsonOutput(run, `${command} arrangement`) : null;
    assertProbe(probe,
      run.exitCode === 0 && Array.isArray(arrangementValue?.quarantines) && arrangementValue.quarantines.length >= 1,
      `${command} arrangement created at least one recoverable quarantine`);
  } else if (command === 'uninstall') {
    const run = await arrange([
      'integrate', '--all-hosts', '--json', '--bin', context.holtBin, '--cwd', fixture.repo,
    ]);
    assertProbe(probe, run.exitCode === 0, 'uninstall arrangement installed the full project integration');
  }

  probe.beforeSubjectManifest = await fixtureManifest(fixture);

  try {
    if (command === 'status') {
      const run = await invoke(['status', '--json', '--cwd', fixture.repo]);
      assertExit(probe, run, 0, 'status');
      const value = parseJsonOutput(run, 'status');
      assertProbe(probe, value.counts?.workstreams >= 2, 'status reports the planted workstream denominator');
      assertProbe(probe, value.unique?.some((row) => row.id === fixture.truth.unique), 'status finds the planted sole-copy workstream');
    } else if (command === 'risk') {
      const run = await invoke(['risk', '--json', '--cwd', fixture.repo]);
      assertExit(probe, run, 0, 'risk');
      const value = parseJsonOutput(run, 'risk');
      assertProbe(probe, value.unique?.some((row) => row.id === fixture.truth.unique && row.uncommittedOnlyCount > 0),
        'risk identifies independently planted uncommitted-only work');
      assertProbe(probe, value.safe?.some((row) => row.id === fixture.truth.empty && row.safe === true),
        'risk retains a planted disposable negative control');
    } else if (command === 'collisions') {
      const run = await invoke(['collisions', '--json', '--all', '--cwd', fixture.repo]);
      assertExit(probe, run, 0, 'collisions');
      const value = parseJsonOutput(run, 'collisions');
      assertProbe(probe, Array.isArray(value) && value.some((row) => pairMatches(row, fixture.truth.collision)),
        'collisions finds the independently planted same-file conflict');
    } else if (command === 'hotspots') {
      const run = await invoke(['hotspots', '--json', '--strict-read-only', '--cwd', fixture.repo]);
      assertExit(probe, run, 0, 'hotspots');
      const value = parseJsonOutput(run, 'hotspots');
      assertProbe(probe, value.hotspots?.some((row) => row.file === fixture.truth.hotspotFile),
        'hotspots names the independently planted contested file');
    } else if (command === 'duplicates') {
      const run = await invoke(['duplicates', '--json', '--cwd', fixture.repo]);
      assertExit(probe, run, 0, 'duplicates');
      const value = parseJsonOutput(run, 'duplicates');
      assertProbe(probe, value.symbolIdentity?.some((row) => pairMatches(row, fixture.truth.duplicate)),
        'duplicates finds the independently planted identical implementation');
    } else if (command === 'context') {
      const run = await invoke(['context', fixture.truth.unique, '--json', '--cwd', fixture.repo]);
      assertExit(probe, run, 0, 'context');
      const value = parseJsonOutput(run, 'context');
      assertProbe(probe, value.ok !== false && value.workstream === fixture.truth.unique,
        'context resolves the exact planted workstream instead of an empty/unknown answer');
      assertProbe(probe, Array.isArray(value.siblings) && value.siblings.length >= 1,
        'context reports at least one real sibling');
    } else if (command === 'plan') {
      const run = await invoke(['plan', '--json', '--cwd', fixture.repo]);
      assertExit(probe, run, 0, 'plan');
      const value = parseJsonOutput(run, 'plan');
      assertProbe(probe, value.reviewReduction?.total >= 2 && Array.isArray(value.order),
        'plan reduces a non-empty planted review queue');
    } else if (command === 'impact') {
      const run = await invoke(['impact', '--json', '--cwd', fixture.repo]);
      assertExit(probe, run, 0, 'impact');
      const value = parseJsonOutput(run, 'impact');
      assertProbe(probe, value.pairs?.some((row) => row.producer === fixture.truth.impact.producer
        && row.consumer === fixture.truth.impact.consumer),
      'impact finds the independently planted cross-worktree definition/reference dependency');
    } else if (command === 'order') {
      const run = await invoke(['order', '--json', '--cwd', fixture.repo]);
      assertExit(probe, run, 0, 'order');
      const value = parseJsonOutput(run, 'order');
      const named = [...(value.parallel ?? []), ...(value.lanes ?? []).flatMap((lane) => lane.members ?? [])];
      assertProbe(probe, named.includes(fixture.truth.unique) && named.includes(fixture.truth.empty),
        'order covers both a held-work and disposable planted workstream');
    } else if (command === 'partition') {
      const run = await invoke(['partition', '--agents', '2', '--json', '--cwd', fixture.repo]);
      assertExit(probe, run, 0, 'partition');
      const value = parseJsonOutput(run, 'partition');
      const dirs = (value.buckets ?? []).flatMap((row) => row.dirs ?? []);
      assertProbe(probe, value.agents === 2 && value.buckets?.length === 2, 'partition creates the requested two real buckets');
      assertProbe(probe, dirs.length > 0 && new Set(dirs).size === dirs.length, 'partition buckets are non-empty in aggregate and disjoint');
    } else if (command === 'branches') {
      const run = await invoke(['branches', '--json', '--cwd', fixture.repo]);
      assertExit(probe, run, 0, 'branches');
      const value = parseJsonOutput(run, 'branches');
      assertProbe(probe, value.unlanded?.some((row) => row.name === fixture.truth.unlandedBranch),
        'branches finds the planted checked-out-nowhere unlanded branch');
    } else if (command === 'journal') {
      const run = await invoke(['journal', '--verify', '--json', '--cwd', fixture.repo]);
      assertExit(probe, run, 0, 'journal --verify');
      const value = parseJsonOutput(run, 'journal');
      assertProbe(probe, value.ok === true && value.chained >= 1, 'journal verifies a non-empty chain containing the planted blocked event');
    } else if (command === 'forensics') {
      const run = await invoke(['forensics', fixture.truth.unique, '--json', '--cwd', fixture.repo]);
      assertExit(probe, run, 0, 'forensics');
      const value = parseJsonOutput(run, 'forensics');
      assertProbe(probe, /blocked|refused/i.test(JSON.stringify(value)),
        'forensics reconstructs the planted destructive attempt rather than an empty timeline');
    } else if (command === 'fleet') {
      const run = await invoke(['fleet', fixture.repo, '--json', '--cwd', fixture.repo]);
      assertExit(probe, run, 3, 'fleet unlicensed boundary');
      const value = parseJsonOutput(run, 'fleet');
      assertProbe(probe, value.ok === false && value.entitlement?.entitled === false,
        'Team fleet explicitly refuses without pretending the paid scan ran');
    } else if (command === 'license') {
      const run = await invoke(['license', 'status', '--json', '--cwd', fixture.repo]);
      assertExit(probe, run, 0, 'license status');
      const value = parseJsonOutput(run, 'license');
      assertProbe(probe, value.licensed === false && Array.isArray(value.features),
        'license status honestly reports the isolated unlicensed state and feature boundaries');
    } else if (command === 'managed-policy') {
      const store = path.join(fixture.root, 'managed-policy-store');
      const run = await invoke([
        'managed-policy', 'status', '--authority', 'user', '--profile', 'proof', '--store', store,
        '--json', '--cwd', fixture.repo,
      ]);
      assertExit(probe, run, 3, 'managed-policy unlicensed boundary');
      const value = parseJsonOutput(run, 'managed-policy');
      assertProbe(probe, value.ok === false && value.code === 'MANAGED_POLICY_UNLICENSED'
        && value.entitlement?.entitled === false,
      'Enterprise managed policy explicitly refuses before claiming central policy ran');
    } else if (command === 'ci') {
      const run = await invoke(['ci', '--fail-on-unlanded', '--json', '--cwd', fixture.repo]);
      assertExit(probe, run, 1, 'ci gate planted failure');
      const value = parseJsonOutput(run, 'ci');
      assertProbe(probe, value.ok === false && value.unlanded?.some((row) => row.name === fixture.truth.unlandedBranch),
        'ci fails on the independently planted unlanded branch');
    } else if (command === 'graph') {
      const jsonRun = await invoke(['graph', '--json', '--cwd', fixture.repo]);
      assertExit(probe, jsonRun, 0, 'graph JSON');
      const value = parseJsonOutput(jsonRun, 'graph');
      assertProbe(probe, value.nodes?.length >= 2 && value.edges?.length >= 1,
        'graph contains real planted nodes and at least one evidence edge');
      const htmlPath = path.join(fixture.root, 'graph-proof.html');
      const htmlRun = await invoke(['graph', '--html', htmlPath, '--cwd', fixture.repo]);
      assertExit(probe, htmlRun, 0, 'graph HTML');
      const html = await fs.readFile(htmlPath, 'utf8');
      assertProbe(probe, html.length > 1000 && html.includes(fixture.truth.unique),
        'graph writes a substantive interactive artifact containing planted workstreams', {
          path: htmlPath, bytes: Buffer.byteLength(html), sha256: sha256(html),
        });
    } else if (command === 'stash') {
      const run = await invoke(['stash', '--json', '--cwd', fixture.repo]);
      assertExit(probe, run, 0, 'stash');
      const value = parseJsonOutput(run, 'stash');
      assertProbe(probe, value.entries?.some((row) => row.message?.includes(fixture.truth.stashMessage)),
        'stash audits the independently planted stash entry');
    } else if (command === 'gate') {
      const risky = await invoke(['gate', fixture.truth.unique, '--json', '--cwd', fixture.repo]);
      assertExit(probe, risky, 1, 'gate risky');
      const riskyValue = parseJsonOutput(risky, 'gate risky');
      assertProbe(probe, riskyValue.safe === false && riskyValue.id === fixture.truth.unique,
        'gate refuses the independently planted sole-copy workstream');
      const safe = await invoke(['gate', fixture.truth.empty, '--json', '--cwd', fixture.repo]);
      assertExit(probe, safe, 0, 'gate disposable');
      const safeValue = parseJsonOutput(safe, 'gate disposable');
      assertProbe(probe, safeValue.safe === true, 'gate accepts the independently planted empty negative control');
    } else if (command === 'tui') {
      const run = await invoke(['tui', '--snapshot', '--columns', '120', '--rows', '30', '--cwd', fixture.repo]);
      assertExit(probe, run, 0, 'tui snapshot');
      assertProbe(probe, run.stdout.length > 300 && run.stdout.includes(fixture.truth.unique),
        'TUI snapshot renders a substantive risk dashboard containing the planted sole-copy workstream');
    } else if (command === 'setup') {
      const run = await invoke(['setup', '--cwd', fixture.repo]);
      assertExit(probe, run, 0, 'setup non-interactive first run');
      assertProbe(probe, /analysis backends/i.test(run.stdout) && /agent wiring/i.test(run.stdout)
        && /done\./i.test(run.stdout),
      'setup completes all non-interactive first-run sections without assuming consent');
    } else if (command === 'doctor') {
      const run = await invoke(['doctor', '--json', '--cwd', fixture.repo]);
      assertExit(probe, run, 0, 'doctor');
      const value = parseJsonOutput(run, 'doctor');
      assertProbe(probe, value.ok === true && value.git?.noLazyFetch === true
        && Array.isArray(value.safetyContract),
      'doctor proves the selected Git runtime and live argv safety contract');
    } else if (command === 'audit') {
      const run = await invoke(['audit', '--json', '--cwd', fixture.repo]);
      assertExit(probe, run, 0, 'audit');
      const value = parseJsonOutput(run, 'audit');
      assertProbe(probe, value.ok === true && value.passed === value.total && value.total > 0,
        'installed package passes its own byte/capability audit');
    } else if (command === 'auto') {
      const run = await invoke(['auto', '--json', '--cwd', fixture.repo]);
      assertExit(probe, run, 0, 'auto');
      const value = parseJsonOutput(run, 'auto');
      assertProbe(probe, value && typeof value === 'object' && !Array.isArray(value),
        'auto returns a structured action result');
      assertProbe(probe, await exists(fixture.worktrees[fixture.truth.unique]),
        'auto preserves the sole-copy worktree');
    } else if (command === 'protect') {
      const preview = await invoke(['protect', '--dry-run', '--json', '--cwd', fixture.repo]);
      assertExit(probe, preview, 0, 'protect preview');
      const apply = await invoke(['protect', '--json', '--cwd', fixture.repo]);
      assertExit(probe, apply, 0, 'protect apply');
      const manifest = await fixtureManifest(fixture);
      assertProbe(probe, Boolean(registered(manifest, fixture.truth.unique)?.registered?.locked),
        'protect applies a real Git worktree lock to the sole-copy worktree');
    } else if (command === 'unprotect') {
      const run = await invoke(['unprotect', fixture.truth.unique, '--json', '--cwd', fixture.repo]);
      assertExit(probe, run, 0, 'unprotect');
      const manifest = await fixtureManifest(fixture);
      assertProbe(probe, !registered(manifest, fixture.truth.unique)?.registered?.locked,
        'unprotect removes Holt\'s real Git worktree lock');
    } else if (command === 'rescue') {
      const run = await invoke(['rescue', fixture.truth.unique, '--release', '--json', '--cwd', fixture.repo]);
      assertExit(probe, run, 0, 'rescue');
      const value = parseJsonOutput(run, 'rescue');
      assertProbe(probe, value.ok === true && value.verified === true && /^refs\/holt\/rescue\//.test(value.ref),
        'rescue reports a verified durable ref');
      assertProbe(probe, await refExists(fixture, value.ref), 'rescue ref exists independently in Git');
      const shown = await git(['show', `${value.ref}:${fixture.truth.soleCopyPath}`], fixture.repo, fixture.env);
      assertProbe(probe, shown.stdout.includes('SOLE_COPY_PROOF'), 'rescue ref independently contains the sole-copy bytes');
    } else if (command === 'rescued') {
      const run = await invoke(['rescued', '--json', '--cwd', fixture.repo]);
      assertExit(probe, run, 0, 'rescued');
      const value = parseJsonOutput(run, 'rescued');
      assertProbe(probe, Array.isArray(value) && value.some((row) => row.id === fixture.truth.unique
        && /^refs\/holt\/rescue\//.test(row.ref)),
      'rescued lists the independently verified rescue ref created in arrangement');
    } else if (command === 'clean') {
      const preview = await invoke(['clean', '--json', '--cwd', fixture.repo]);
      assertExit(probe, preview, 0, 'clean preview');
      const previewValue = parseJsonOutput(preview, 'clean preview');
      assertProbe(probe, previewValue.dryRun === true
        && previewValue.wouldQuarantine?.some((row) => row.id === fixture.truth.empty),
      'clean preview names the planted disposable worktree and changes nothing');
      assertProbe(probe, await exists(fixture.worktrees[fixture.truth.empty]), 'clean preview leaves the original path present');
      const apply = await invoke(['clean', '--apply', '--json', '--cwd', fixture.repo]);
      assertExit(probe, apply, 0, 'clean apply');
      const value = parseJsonOutput(apply, 'clean apply');
      assertProbe(probe, value.quarantined >= 1 && value.removed === 0 && value.branchesRemoved === 0,
        'clean apply moves into recoverable quarantine without deleting files or branches');
      assertProbe(probe, await exists(fixture.worktrees[fixture.truth.unique]), 'clean apply preserves the sole-copy worktree');
    } else if (command === 'quarantines') {
      const run = await invoke(['quarantines', '--json', '--cwd', fixture.repo]);
      assertExit(probe, run, 0, 'quarantines');
      const value = parseJsonOutput(run, 'quarantines');
      assertProbe(probe, value.count >= 1 && value.quarantines?.some((row) => row.id === arrangementValue.quarantines[0].id),
        'quarantines lists the recoverable copy created during arrangement');
    } else if (command === 'restore') {
      const quarantine = arrangementValue.quarantines[0];
      const run = await invoke(['restore', quarantine.id, '--json', '--cwd', fixture.repo]);
      assertExit(probe, run, 0, 'restore');
      const value = parseJsonOutput(run, 'restore');
      assertProbe(probe, value.ok === true && value.restored === true && await exists(value.originalPath),
        'restore recreates the exact original path from recoverable quarantine');
    } else if (command === 'purge') {
      const quarantine = arrangementValue.quarantines[0];
      const preview = await invoke(['purge', quarantine.id, '--json', '--cwd', fixture.repo]);
      assertExit(probe, preview, 0, 'purge preview');
      const previewValue = parseJsonOutput(preview, 'purge preview');
      assertProbe(probe, previewValue.dryRun === true && previewValue.removed === 0,
        'purge remains a no-removal preview by default');
      const apply = await invoke(['purge', quarantine.id, '--apply', '--json', '--cwd', fixture.repo]);
      assertExit(probe, apply, 0, 'purge apply');
      const value = parseJsonOutput(apply, 'purge apply');
      assertProbe(probe, value.ok === true && value.purged === true && value.removed === 1
        && value.branchesRemoved === 0 && /^refs\/holt\/purge\//.test(value.recoveryRef),
      'purge apply anchors recovery, removes one verified quarantine, and retains its branch');
      assertProbe(probe, await refExists(fixture, value.recoveryRef), 'purge recovery ref independently exists');
    } else if (command === 'discard') {
      const targets = ['README.md', 'untracked-discard-proof.txt'];
      const preview = await invoke(['discard', ...targets, '--dry-run', '--json', '--cwd', fixture.repo]);
      assertExit(probe, preview, 0, 'discard preview');
      assertProbe(probe, await exists(path.join(fixture.repo, targets[1])), 'discard preview preserves the untracked bytes');
      const apply = await invoke(['discard', ...targets, '--json', '--cwd', fixture.repo]);
      assertExit(probe, apply, 0, 'discard apply');
      const value = parseJsonOutput(apply, 'discard apply');
      assertProbe(probe, /^refs\/holt\/discard\//.test(value.ref) && await refExists(fixture, value.ref),
        'discard captures an independently existing recovery ref before removing/resetting bytes');
      const shown = await git(['show', `${value.ref}:untracked-discard-proof.txt`], fixture.repo, fixture.env);
      assertProbe(probe, shown.stdout.includes('untracked valuable bytes'), 'discard recovery ref contains the planted untracked bytes');
      assertProbe(probe, !(await exists(path.join(fixture.repo, targets[1]))), 'discard removes only the requested untracked path after capture');
    } else if (command === 'verify') {
      const testCommand = `${process.execPath} -e process.exit(0)`;
      const run = await invoke([
        'verify', fixture.truth.duplicate[0], fixture.truth.duplicate[1], '--run', testCommand,
        '--json', '--cwd', fixture.repo,
      ]);
      assertExit(probe, run, 0, 'verify');
      const value = parseJsonOutput(run, 'verify');
      assertProbe(probe, value.ok === true && value.interactionBreaks === false,
        'verify executes the real command on A, B, and the combined merge and reports no planted interaction break');
      assertProbe(probe, value.runs?.a?.passed === true && value.runs?.b?.passed === true
        && value.runs?.ab?.passed === true,
      'verify result carries three distinct passing observations: A, B, and A+B');
    } else if (command === 'hosts') {
      const run = await invoke(['hosts', '--json', '--cwd', fixture.repo]);
      assertExit(probe, run, 0, 'hosts');
      const value = parseJsonOutput(run, 'hosts');
      assertProbe(probe, value.counts?.known === 30 && value.hosts?.length === 30,
        'hosts reports all 30 declared compatibility profiles with exact denominator');
    } else if (command === 'providers') {
      const run = await invoke(['providers', '--json', '--cwd', fixture.repo]);
      assertExit(probe, run, 0, 'providers');
      const value = parseJsonOutput(run, 'providers');
      assertProbe(probe, value.counts?.profiles === 7 && value.providers?.length === 7,
        'providers exposes all seven provider profiles with explicit implementation/proof state');
      assertProbe(probe, value.providers.every((row) => row.liveVerified === false),
        'providers does not upgrade contract proof into live-provider proof');
    } else if (command === 'integrate') {
      const preview = await invoke([
        'integrate', '--all-hosts', '--dry-run', '--json', '--bin', context.holtBin, '--cwd', fixture.repo,
      ]);
      assertExit(probe, preview, 0, 'integrate preview');
      const previewValue = parseJsonOutput(preview, 'integrate preview');
      assertProbe(probe, previewValue.dryRun === true && previewValue.planned?.length >= 10,
        'integrate preview exposes the bounded multi-host write plan');
      const apply = await invoke([
        'integrate', '--all-hosts', '--json', '--bin', context.holtBin, '--cwd', fixture.repo,
      ]);
      assertExit(probe, apply, 0, 'integrate apply');
      const value = parseJsonOutput(apply, 'integrate apply');
      assertProbe(probe, Array.isArray(value.results) && value.results.length >= 10,
        'integrate applies a substantive all-host project configuration');
      const agents = await fs.readFile(path.join(fixture.repo, 'AGENTS.md'), 'utf8');
      assertProbe(probe, agents.includes('THIRD_PARTY_SENTINEL') && agents.includes('BEGIN holt'),
        'integrate preserves pre-existing instructions while adding its bounded block');
    } else if (command === 'uninstall') {
      const run = await invoke(['uninstall', '--json', '--cwd', fixture.repo]);
      assertExit(probe, run, 0, 'uninstall');
      const value = parseJsonOutput(run, 'uninstall');
      assertProbe(probe, value.results?.length >= 1, 'uninstall reports concrete integration removals');
      const agents = await fs.readFile(path.join(fixture.repo, 'AGENTS.md'), 'utf8');
      assertProbe(probe, agents.includes('THIRD_PARTY_SENTINEL') && !agents.includes('BEGIN holt'),
        'uninstall removes Holt-owned content and preserves third-party instructions');
    } else if (command === 'brief') {
      const run = await invoke(['brief', '--json', '--cwd', fixture.repo]);
      assertExit(probe, run, 0, 'brief');
      const value = parseJsonOutput(run, 'brief');
      assertProbe(probe, typeof value.context === 'string' && value.context.includes(fixture.truth.unique),
        'brief gives an agent actionable context naming the planted sole-copy workstream');
    } else if (command === 'hook') {
      const run = await invoke([
        'hook', 'pre-tool-use', '--host', 'generic', '--cwd', fixture.repo,
      ], { stdin: destructivePayload });
      assertExit(probe, run, 2, 'hook destructive refusal');
      const value = parseJsonOutput(run, 'hook');
      assertProbe(probe, value.decision === 'deny' || value.permissionDecision === 'deny',
        'hook emits an explicit deny for destruction of independently planted sole-copy work');
      assertProbe(probe, /unique-work|SOLE_COPY_PROOF/.test(run.stdout + run.stderr),
        'hook refusal points to actual evidence instead of a generic interruption');
    } else {
      throw new Error(`no behavioral CLI probe implemented for ${command}`);
    }
  } catch (error) {
    probe.failures.push(`probe exception: ${error.stack ?? error.message}`);
  }

  probe.afterSubjectManifest = await fixtureManifest(fixture).catch((error) => ({ error: error.message }));
  assertProbe(probe, !probe.afterSubjectManifest.error, 'post-command fixture manifest is complete');
  if (!probe.afterSubjectManifest.error) {
    assertProbe(probe,
      probe.afterSubjectManifest.worktrees.length === probe.afterSubjectManifest.registeredCount,
      'post-command manifest has one byte/index/status record per registered worktree');
  }
  probe.valid = probe.failures.length === 0
    && probe.invocations.length > 0
    && probe.invocations.every((run) => run.stdoutSha256 && run.stderrSha256);
  return probe;
}

class McpSession {
  constructor(context, fixture) {
    this.context = context;
    this.fixture = fixture;
    this.requests = [];
    this.responses = [];
    this.stderrChunks = [];
    this.stdoutChunks = [];
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.startedAt = new Date().toISOString();
    this.started = process.hrtime.bigint();
    this.child = spawn(process.execPath, [context.holtBin, 'mcp'], {
      cwd: fixture.repo,
      env: fixture.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child.stdout.on('data', (chunk) => {
      const bytes = Buffer.from(chunk);
      this.stdoutChunks.push(bytes);
      this.buffer += bytes.toString('utf8');
      let newline;
      while ((newline = this.buffer.indexOf('\n')) !== -1) {
        const raw = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (!raw.trim()) continue;
        let message;
        try { message = JSON.parse(raw); } catch (error) {
          this.responses.push({ raw, parseError: error.message });
          continue;
        }
        this.responses.push({ raw, message });
        if (message.id !== undefined && this.pending.has(message.id)) {
          const { resolve } = this.pending.get(message.id);
          this.pending.delete(message.id);
          resolve(message);
        }
      }
    });
    this.child.stderr.on('data', (chunk) => this.stderrChunks.push(Buffer.from(chunk)));
    this.exitPromise = new Promise((resolve) => {
      let spawnError = null;
      this.child.once('error', (error) => { spawnError = error.message; });
      this.child.once('close', (exitCode, signal) => {
        for (const { reject } of this.pending.values()) {
          reject(new Error(`MCP server closed before answering (exit=${exitCode}, signal=${signal}, error=${spawnError})`));
        }
        this.pending.clear();
        resolve({ exitCode, signal: signal ?? null, spawnError });
      });
    });
  }

  send(method, params) {
    const id = this.nextId++;
    const message = { jsonrpc: '2.0', id, method, params };
    this.requests.push(message);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  notify(method, params) {
    const message = { jsonrpc: '2.0', method, params };
    this.requests.push(message);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async close() {
    this.child.stdin.end();
    const completion = await this.exitPromise;
    const stdout = Buffer.concat(this.stdoutChunks);
    const stderr = Buffer.concat(this.stderrChunks);
    return {
      command: process.execPath,
      argv: [this.context.holtBin, 'mcp'],
      cwd: this.fixture.repo,
      startedAt: this.startedAt,
      elapsedMs: Number(process.hrtime.bigint() - this.started) / 1e6,
      ...completion,
      requests: this.requests,
      responses: this.responses,
      pendingResponses: this.pending.size,
      stdout: stdout.toString('utf8'),
      stdoutBytes: stdout.length,
      stdoutSha256: sha256(stdout),
      stderr: stderr.toString('utf8'),
      stderrBytes: stderr.length,
      stderrSha256: sha256(stderr),
      clean: completion.exitCode === 0 && completion.signal === null
        && completion.spawnError === null && this.pending.size === 0,
    };
  }
}

function toolPayload(response, label) {
  if (response?.error) throw new Error(`${label} JSON-RPC error: ${JSON.stringify(response.error)}`);
  if (!response?.result) throw new Error(`${label} omitted result`);
  if (response.result.isError) throw new Error(`${label} returned isError: ${response.result.content?.[0]?.text}`);
  const text = response.result.content?.[0]?.text;
  if (typeof text !== 'string') throw new Error(`${label} omitted text content`);
  try { return JSON.parse(text); } catch (error) {
    throw new Error(`${label} tool result is not JSON: ${error.message}; text=${text.slice(0, 300)}`);
  }
}

const RICH_MCP = new Set([
  'holt_collisions', 'holt_duplicates', 'holt_hotspots', 'holt_impact',
  'holt_landing_order', 'holt_landing_plan', 'holt_partition',
]);

export async function runMcpProbe(context, tool, index) {
  const probeRoot = path.join(context.work, 'mcp', `${String(index + 1).padStart(2, '0')}-${tool}`);
  await fs.mkdir(path.dirname(probeRoot), { recursive: true });
  const fixture = await buildFixture(probeRoot, context.runtime, context.holtBin, {
    rich: RICH_MCP.has(tool),
  });
  const dependencyFixture = tool === 'holt_hotspots'
    ? await installMergeTreeFailureFixture(fixture)
    : null;
  const probe = {
    surface: `mcp:${tool}`,
    tool,
    tier: 'free-core',
    mode: 'real-stdio-behavioral',
    skipped: false,
    fixtureRoot: fixture.root,
    truth: fixture.truth,
    dependencyFixture,
    plantedManifest: await fixtureManifest(fixture),
    beforeSubjectManifest: null,
    afterSubjectManifest: null,
    initialize: null,
    toolsList: null,
    arrangements: [],
    calls: [],
    transport: null,
    assertions: [],
    failures: [],
  };
  assertProbe(probe,
    probe.plantedManifest.worktrees.length === probe.plantedManifest.registeredCount,
    'MCP fixture manifest has one byte/index/status record per registered worktree');
  probe.beforeSubjectManifest = await fixtureManifest(fixture);
  let session = null;
  try {
    session = new McpSession(context, fixture);
    probe.initialize = await session.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'holt-installed-surface-proof', version: '1' },
    });
    assertProbe(probe, probe.initialize?.result?.serverInfo?.name === 'holt',
      'MCP initialize identifies the server as Holt');
    assertProbe(probe, probe.initialize?.result?.serverInfo?.version === context.packageVersion,
      'MCP server version matches the frozen installed package');
    assertProbe(probe, Boolean(probe.initialize?.result?.capabilities?.tools),
      'MCP initialize advertises tool capability');
    session.notify('notifications/initialized', {});
    probe.toolsList = await session.send('tools/list', {});
    const schemas = probe.toolsList?.result?.tools ?? [];
    const names = schemas.map((row) => row.name);
    try {
      requireExactSet(names, MCP_TOOLS, 'MCP tools/list');
      assertProbe(probe, true, 'tools/list returns the exact 16-tool denominator');
    } catch (error) {
      assertProbe(probe, false, error.message);
    }
    assertProbe(probe, schemas.every((row) => row.inputSchema?.type === 'object'
      && row.description?.length > 40),
    'every advertised tool has a substantive description and object input schema');

    const call = async (name, args, role = 'subject') => {
      const response = await session.send('tools/call', { name, arguments: args });
      const payload = toolPayload(response, `${tool}/${name}`);
      const row = { role, name, arguments: args, response, payload };
      if (role === 'subject') probe.calls.push(row); else probe.arrangements.push(row);
      return payload;
    };
    const repoArg = { repo: fixture.repo };
    let payload;
    if (tool === 'holt_at_risk') {
      payload = await call(tool, repoArg);
      assertProbe(probe, payload.workstreams?.some((row) => row.id === fixture.truth.unique
        && row.uncommittedOnly > 0),
      'holt_at_risk finds independently planted uncommitted-only work');
    } else if (tool === 'holt_branches') {
      payload = await call(tool, repoArg);
      assertProbe(probe, payload.unlanded?.some((row) => row.name === fixture.truth.unlandedBranch),
        'holt_branches finds the planted unlanded checked-out-nowhere branch');
    } else if (tool === 'holt_check_workstream') {
      payload = await call(tool, { ...repoArg, id: fixture.truth.unique });
      assertProbe(probe, payload.id === fixture.truth.unique && payload.safeToDelete === false
        && /DO NOT DELETE/.test(payload.recommendation),
      'holt_check_workstream refuses deletion of the sole-copy worktree');
    } else if (tool === 'holt_clean') {
      const preview = await call(tool, repoArg);
      assertProbe(probe, preview.dryRun === true
        && preview.wouldQuarantine?.some((row) => row.id === fixture.truth.empty),
      'holt_clean defaults to a real preview naming the disposable control');
      assertProbe(probe, await exists(fixture.worktrees[fixture.truth.empty]),
        'holt_clean preview leaves the original path present');
      payload = await call(tool, { ...repoArg, apply: true });
      assertProbe(probe, payload.quarantined >= 1 && payload.removed === 0
        && payload.branchesRemoved === 0,
      'holt_clean apply quarantines without physical deletion');
      assertProbe(probe, await exists(fixture.worktrees[fixture.truth.unique]),
        'holt_clean preserves the sole-copy worktree');
    } else if (tool === 'holt_collisions') {
      payload = await call(tool, repoArg);
      assertProbe(probe, payload.pairs?.some((row) => pairMatches(row, fixture.truth.collision)),
        'holt_collisions finds the independently planted same-file conflict');
    } else if (tool === 'holt_context') {
      payload = await call(tool, { ...repoArg, id: fixture.truth.unique });
      assertProbe(probe, payload.workstream === fixture.truth.unique && payload.siblings?.length >= 1,
        'holt_context resolves the exact planted workstream with real siblings');
    } else if (tool === 'holt_duplicates') {
      payload = await call(tool, repoArg);
      assertProbe(probe, payload.pairs?.some((row) => pairMatches(row, fixture.truth.duplicate)),
        'holt_duplicates finds the independently planted identical implementation');
    } else if (tool === 'holt_hotspots') {
      payload = await call(tool, repoArg);
      assertProbe(probe, payload.hotspots?.some((row) => row.file === fixture.truth.hotspotFile),
        'holt_hotspots names the independently planted contested file');
    } else if (tool === 'holt_impact') {
      payload = await call(tool, repoArg);
      assertProbe(probe, payload.pairs?.some((row) => row.producer === fixture.truth.impact.producer
        && row.consumer === fixture.truth.impact.consumer),
      'holt_impact finds the planted cross-worktree definition/reference dependency');
      assertProbe(probe, /DEPENDENCIES, not conflicts/.test(payload.important),
        'holt_impact retains the non-conflict semantic boundary in the result');
    } else if (tool === 'holt_landing_order') {
      payload = await call(tool, repoArg);
      const named = [...(payload.parallel ?? []), ...(payload.lanes ?? []).flatMap((lane) => lane.members ?? [])];
      assertProbe(probe, named.includes(fixture.truth.unique) && named.includes(fixture.truth.collision[0]),
        'holt_landing_order covers independent and entangled planted workstreams');
    } else if (tool === 'holt_landing_plan') {
      payload = await call(tool, repoArg);
      assertProbe(probe, payload.reviewReduction?.total >= 2 && payload.order?.length >= 1,
        'holt_landing_plan reduces a non-empty planted review queue');
    } else if (tool === 'holt_partition') {
      payload = await call(tool, { ...repoArg, agents: 2 });
      const dirs = (payload.buckets ?? []).flatMap((row) => row.dirs ?? []);
      assertProbe(probe, payload.agents === 2 && payload.buckets?.length === 2,
        'holt_partition returns the requested two buckets');
      assertProbe(probe, dirs.length > 0 && dirs.length === new Set(dirs).size,
        'holt_partition buckets are non-empty in aggregate and disjoint');
    } else if (tool === 'holt_protect') {
      const preview = await call(tool, { ...repoArg, dryRun: true });
      assertProbe(probe, preview.dryRun === true, 'holt_protect exposes a real dry run');
      payload = await call(tool, repoArg);
      const manifest = await fixtureManifest(fixture);
      assertProbe(probe, Boolean(registered(manifest, fixture.truth.unique)?.registered?.locked),
        'holt_protect applies a real Git worktree lock');
    } else if (tool === 'holt_purge') {
      const clean = await call('holt_clean', { ...repoArg, apply: true }, 'arrangement');
      const quarantine = clean.quarantines?.[0];
      assertProbe(probe, Boolean(quarantine?.id), 'holt_purge arrangement creates a recoverable quarantine');
      const preview = await call(tool, { ...repoArg, id: quarantine.id });
      assertProbe(probe, preview.dryRun === true && preview.removed === 0,
        'holt_purge defaults to a no-removal preview');
      payload = await call(tool, { ...repoArg, id: quarantine.id, apply: true });
      assertProbe(probe, payload.ok === true && payload.purged === true && payload.removed === 1
        && payload.branchesRemoved === 0 && /^refs\/holt\/purge\//.test(payload.recoveryRef),
      'holt_purge apply anchors recovery, removes exactly one quarantine and retains its branch');
      assertProbe(probe, await refExists(fixture, payload.recoveryRef),
        'holt_purge recovery ref exists independently in Git');
    } else if (tool === 'holt_rescue') {
      payload = await call(tool, { ...repoArg, id: fixture.truth.unique, release: true });
      assertProbe(probe, payload.ok === true && payload.verified === true
        && /^refs\/holt\/rescue\//.test(payload.ref),
      'holt_rescue captures and verifies a durable rescue ref');
      assertProbe(probe, await refExists(fixture, payload.ref), 'holt_rescue ref independently exists');
      const shown = await git(['show', `${payload.ref}:${fixture.truth.soleCopyPath}`], fixture.repo, fixture.env);
      assertProbe(probe, shown.stdout.includes('SOLE_COPY_PROOF'),
        'holt_rescue ref independently contains the sole-copy bytes');
    } else if (tool === 'holt_status') {
      payload = await call(tool, repoArg);
      assertProbe(probe, payload.workstreams >= 2 && payload.atRisk >= 1,
        'holt_status reports the planted workstream denominator and at-risk positive control');
      assertProbe(probe, payload.topRisks?.some((row) => row.id === fixture.truth.unique),
        'holt_status decision surface names the planted top risk');
    } else {
      throw new Error(`no behavioral MCP probe implemented for ${tool}`);
    }
  } catch (error) {
    probe.failures.push(`probe exception: ${error.stack ?? error.message}`);
  } finally {
    if (session) {
      probe.transport = await session.close().catch((error) => ({ clean: false, error: error.message }));
      assertProbe(probe, probe.transport.clean === true,
        'MCP server exits cleanly on stdin EOF without kill/timeout', probe.transport);
      assertProbe(probe,
        !probe.transport.stdout.includes(String.fromCodePoint(0x2028))
          && !probe.transport.stdout.includes(String.fromCodePoint(0x202e)),
        'hostile line-separator/bidi fixture bytes never reach the model raw');
      assertProbe(probe, !probe.transport.responses?.some((row) => row.parseError),
        'every non-empty MCP stdout line is valid JSON-RPC');
    }
  }
  probe.afterSubjectManifest = await fixtureManifest(fixture).catch((error) => ({ error: error.message }));
  assertProbe(probe, !probe.afterSubjectManifest.error, 'post-tool fixture manifest is complete');
  if (!probe.afterSubjectManifest.error) {
    assertProbe(probe,
      probe.afterSubjectManifest.worktrees.length === probe.afterSubjectManifest.registeredCount,
      'post-tool manifest has one byte/index/status record per registered worktree');
  }
  probe.valid = probe.failures.length === 0
    && probe.calls.length > 0
    && probe.transport?.clean === true;
  return probe;
}

export function helpCommandInventory(stdout) {
  const headings = new Set(['COMMANDS', 'ACTING  (these explicitly mutate local Git/repository state)', 'AGENT INTEGRATION']);
  const commands = [];
  let active = false;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trimEnd();
    if (headings.has(trimmed)) { active = true; continue; }
    if (active && /^[A-Z][A-Z ()/-]+$/.test(trimmed) && !headings.has(trimmed)) {
      active = false;
      continue;
    }
    if (!active) continue;
    const match = /^  ([a-z][a-z-]*)(?:\s|$)/.exec(line);
    if (match) commands.push(match[1]);
  }
  return commands;
}

export function validatePublicationArtifact(evidence) {
  const failures = [];
  const fail = (message) => failures.push(message);
  if (evidence.kind !== SCHEMA) fail(`wrong evidence kind ${evidence.kind}`);
  if (evidence.protocol?.noInternalTimeouts !== true) fail('runner did not declare no-internal-timeout protocol');
  if (evidence.freeze?.valid !== true) fail('freeze chain is not valid');
  if (evidence.runtime?.immutable !== true) fail('installed runtime changed during the proof');
  if (evidence.package?.immutable !== true) fail('installed package changed during the proof');
  const cli = evidence.cli?.probes ?? [];
  const mcp = evidence.mcp?.probes ?? [];
  try { requireExactSet(cli.map((row) => row.command), CLI_COMMANDS, 'CLI'); } catch (error) { fail(error.message); }
  try { requireExactSet(mcp.map((row) => row.tool), MCP_TOOLS, 'MCP'); } catch (error) { fail(error.message); }
  for (const probe of cli) {
    if (probe.skipped !== false) fail(`${probe.surface}: skipped/omitted`);
    if (probe.valid !== true) fail(`${probe.surface}: invalid (${(probe.failures ?? []).join('; ')})`);
    if (probe.command !== 'mcp' && !(probe.invocations?.length > 0)) fail(`${probe.surface}: no behavioral invocation`);
    if (probe.command !== 'mcp' && (!probe.plantedManifest || !probe.afterSubjectManifest)) {
      fail(`${probe.surface}: missing before/after fixture manifest`);
    }
  }
  for (const probe of mcp) {
    if (probe.skipped !== false) fail(`${probe.surface}: skipped/omitted`);
    if (probe.valid !== true) fail(`${probe.surface}: invalid (${(probe.failures ?? []).join('; ')})`);
    if (!(probe.calls?.length > 0)) fail(`${probe.surface}: no tools/call behavior`);
    if (probe.transport?.clean !== true) fail(`${probe.surface}: MCP did not cleanly exit on EOF`);
    if (!probe.plantedManifest || !probe.afterSubjectManifest) fail(`${probe.surface}: missing fixture manifest`);
  }
  const mcpCli = cli.find((row) => row.command === 'mcp');
  if (mcpCli?.protocolToolCalls !== MCP_TOOLS.length || mcpCli?.cleanShutdowns !== MCP_TOOLS.length) {
    fail('cli:mcp is not tied to all 16 behavioral calls and clean EOF shutdowns');
  }
  if (evidence.scratch?.markerVerified !== true) fail('scratch ownership marker was not reverified');
  return { valid: failures.length === 0, failures };
}

export async function writeEvidence(out, evidence) {
  for (const candidate of [out, `${out}.sha256`]) {
    if (await exists(candidate)) throw new Error(`refusing to overwrite evidence: ${candidate}`);
  }
  await fs.mkdir(path.dirname(out), { recursive: true });
  const raw = { ...evidence };
  delete raw.artifact;
  const identity = `sha256:${sha256(JSON.stringify(raw))}`;
  const artifact = { ...raw, artifact: { schema: SCHEMA, identity, identityScope: 'all preceding JSON fields' } };
  const encoded = `${JSON.stringify(artifact, null, 2)}\n`;
  const fileSha256 = sha256(encoded);
  await fs.writeFile(out, encoded, { flag: 'wx', mode: 0o600 });
  await fs.writeFile(`${out}.sha256`, `${fileSha256}  ${path.basename(out)}\n`, { flag: 'wx', mode: 0o600 });
  return { artifact, identity, fileSha256 };
}

export async function runPublicationProof(options) {
  const { runtime, holtBin, freezeEvidence, out, work } = options;
  const outParent = path.dirname(out);
  await fs.mkdir(outParent, { recursive: true });
  const outParentReal = await fs.realpath(outParent);
  const runtimeReal = await fs.realpath(runtime);
  if (inside(SOURCE_ROOT, outParentReal)) throw new Error(`evidence must be outside the developer checkout: ${out}`);
  if (inside(runtimeReal, outParentReal)) throw new Error(`evidence must be outside the frozen runtime: ${out}`);
  if (await exists(out) || await exists(`${out}.sha256`)) throw new Error(`evidence path is not write-once fresh: ${out}`);
  const scratch = await assertFreshScratch(work);
  const evidence = {
    kind: SCHEMA,
    generatedAt: new Date().toISOString(),
    valid: false,
    protocol: {
      publicationGate: true,
      noInternalTimeouts: true,
      externalCancellationOnly: true,
      noSkipOnlyMode: true,
      exactInstalledArtifactOnly: true,
      fixtureRule: 'fresh marker-owned repository per CLI command and per MCP tool',
      oracleRule: 'observable process/protocol result plus independently captured Git/filesystem state',
    },
    runner: await captureFile(fileURLToPath(import.meta.url)),
    freeze: null,
    runtime: null,
    package: null,
    identityChecks: {},
    cli: { expected: CLI_COMMANDS.length, probes: [] },
    mcp: { expected: MCP_TOOLS.length, probes: [] },
    tiers: {
      freeCore: { expectedCli: CLI_COMMANDS.filter((name) => !CLI_TIER[name]).length, note: 'includes MCP server' },
      team: { surfaces: ['cli:fleet', 'cli:license'], proofBoundary: 'unlicensed fleet refusal plus honest license status; paid success is not claimed' },
      enterprise: { surfaces: ['cli:managed-policy'], proofBoundary: 'unlicensed refusal only; managed-policy success needs the separate enterprise authority lane' },
    },
    scratch: { ...scratch, markerVerified: false },
    failures: [],
  };
  try {
    evidence.freeze = await verifyFreezeEvidence({ runtime, holtBin, freezeEvidence });
    const context = {
      runtime: runtimeReal,
      holtBin: await fs.realpath(holtBin),
      packageRoot: evidence.freeze.packageRoot,
      packageVersion: evidence.freeze.packageJson.version,
      work,
    };
    const [runtimeBefore, packageBefore] = await Promise.all([
      installationTreeIdentity(context.runtime),
      installationTreeIdentity(context.packageRoot),
    ]);
    evidence.runtime = { before: runtimeBefore, after: null, immutable: false };
    evidence.package = { before: packageBefore, after: null, immutable: false };

    const versionFixtureRoot = path.join(work, 'identity');
    await fs.mkdir(versionFixtureRoot, { recursive: false });
    const versionHome = path.join(versionFixtureRoot, 'home');
    await fs.mkdir(versionHome, { recursive: true });
    const identityEnv = isolatedEnv(versionHome, context.runtime, context.holtBin);
    const version = await runProcess(process.execPath, [context.holtBin, '--version'], {
      cwd: versionFixtureRoot, env: identityEnv,
    });
    const help = await runProcess(process.execPath, [context.holtBin, '--help'], {
      cwd: versionFixtureRoot, env: identityEnv,
    });
    const helpCommands = helpCommandInventory(help.stdout);
    evidence.identityChecks = { version, help, helpCommands };
    if (version.exitCode !== 0 || !new RegExp(`\\b${context.packageVersion.replace(/\./g, '\\.')}\\b`).test(version.stdout)) {
      throw new Error(`installed CLI version output does not match ${context.packageVersion}`);
    }
    requireExactSet(helpCommands, CLI_COMMANDS, 'documented help commands');

    let cliIndex = 0;
    for (const command of CLI_COMMANDS.filter((name) => name !== 'mcp')) {
      evidence.cli.probes.push(await runCliProbe(context, command, cliIndex++));
    }
    for (let i = 0; i < MCP_TOOLS.length; i++) {
      evidence.mcp.probes.push(await runMcpProbe(context, MCP_TOOLS[i], i));
    }
    const cleanShutdowns = evidence.mcp.probes.filter((row) => row.transport?.clean === true).length;
    const validToolCalls = evidence.mcp.probes.filter((row) => row.valid === true && row.calls?.length > 0).length;
    evidence.cli.probes.push({
      surface: 'cli:mcp',
      command: 'mcp',
      tier: 'free-core',
      mode: 'real-stdio-behavioral-matrix',
      skipped: false,
      protocolToolCalls: validToolCalls,
      cleanShutdowns,
      linkedMcpSurfaces: evidence.mcp.probes.map((row) => row.surface),
      invocations: evidence.mcp.probes.map((row) => ({
        argv: row.transport?.argv,
        cwd: row.transport?.cwd,
        stdoutSha256: row.transport?.stdoutSha256,
        stderrSha256: row.transport?.stderrSha256,
        clean: row.transport?.clean,
      })),
      failures: evidence.mcp.probes.flatMap((row) => row.failures.map((failure) => `${row.surface}: ${failure}`)),
      valid: validToolCalls === MCP_TOOLS.length && cleanShutdowns === MCP_TOOLS.length,
    });
    evidence.cli.probes.sort((a, b) => CLI_COMMANDS.indexOf(a.command) - CLI_COMMANDS.indexOf(b.command));

    [evidence.runtime.after, evidence.package.after] = await Promise.all([
      installationTreeIdentity(context.runtime),
      installationTreeIdentity(context.packageRoot),
    ]);
    evidence.runtime.immutable = evidence.runtime.before.sha256 === evidence.runtime.after.sha256;
    evidence.package.immutable = evidence.package.before.sha256 === evidence.package.after.sha256;
    await verifyOwnedScratch(work, scratch.nonce);
    evidence.scratch.markerVerified = true;
    const verdict = validatePublicationArtifact(evidence);
    evidence.valid = verdict.valid;
    evidence.failures = verdict.failures;
  } catch (error) {
    evidence.failures.push(error.stack ?? error.message);
    if (evidence.runtime?.before && !evidence.runtime.after) {
      evidence.runtime.after = await installationTreeIdentity(runtimeReal).catch((failure) => ({ error: failure.message }));
      evidence.runtime.immutable = evidence.runtime.after?.sha256 === evidence.runtime.before.sha256;
    }
    if (evidence.package?.before && !evidence.package.after && evidence.freeze?.packageRoot) {
      evidence.package.after = await installationTreeIdentity(evidence.freeze.packageRoot).catch((failure) => ({ error: failure.message }));
      evidence.package.immutable = evidence.package.after?.sha256 === evidence.package.before.sha256;
    }
    evidence.scratch.markerVerified = await verifyOwnedScratch(work, scratch.nonce).then(() => true, () => false);
  }
  const written = await writeEvidence(out, evidence);
  return { evidence: written.artifact, out, sidecar: `${out}.sha256`, fileSha256: written.fileSha256 };
}

async function main() {
  const result = await runPublicationProof(parseArgs());
  const summary = {
    ok: result.evidence.valid,
    evidence: result.out,
    sidecar: result.sidecar,
    fileSha256: result.fileSha256,
    cli: `${result.evidence.cli.probes.filter((row) => row.valid).length}/${CLI_COMMANDS.length}`,
    mcp: `${result.evidence.mcp.probes.filter((row) => row.valid).length}/${MCP_TOOLS.length}`,
    failures: result.evidence.failures,
    scratchRetained: result.evidence.scratch.path,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!result.evidence.valid) process.exitCode = 2;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 2;
  });
}
