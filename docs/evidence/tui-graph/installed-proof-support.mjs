// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * Independent evidence primitives for the installed TUI/graph proof.
 *
 * This module deliberately imports no Holt production code. Product observations must cross the
 * installed executable boundary, while hashes use the exact installation-tree semantics recorded
 * by eval/freeze-installed-runtime.mjs. No helper in this file installs a command timeout.
 */

import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

export const EVIDENCE_SCHEMA = 'holt-installed-tui-graph-proof-v1';
export const FREEZE_SCHEMA = 'holt-eval-evidence-v2';

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const portable = (value) => String(value).split(path.sep).join('/');

export async function exists(target) {
  return fs.lstat(target).then(() => true, (error) => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
}

export function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`)
    && relative !== '..' && !path.isAbsolute(relative));
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function exactSet(actual, expected, label) {
  const observed = [...new Set(actual)].sort();
  const wanted = [...new Set(expected)].sort();
  const missing = wanted.filter((value) => !observed.includes(value));
  const extra = observed.filter((value) => !wanted.includes(value));
  if (missing.length || extra.length || actual.length !== expected.length) {
    throw new Error(`${label} mismatch: observed ${actual.length}/${expected.length}; `
      + `missing [${missing.join(', ')}], extra [${extra.join(', ')}]`);
  }
}

export async function captureFile(file) {
  const bytes = await fs.readFile(file);
  return { path: file, bytes: bytes.length, sha256: sha256(bytes) };
}

export function captureBytes(value) {
  const bytes = Buffer.from(value);
  return {
    bytes: bytes.length,
    sha256: sha256(bytes),
    base64: bytes.toString('base64'),
  };
}

/** Exact algorithm used by freeze-installed-runtime.mjs. */
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
    if (stat.isFile()) {
      entries.push({ relative, kind: 'file', mode, content: await fs.readFile(absolute) });
    }
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

export function semanticEvidenceIdentity(parsed) {
  const { artifact: _artifact, summary: _summary, ...raw } = parsed;
  return `sha256:${sha256(JSON.stringify(raw))}`;
}

/**
 * Verify exact file bytes, semantic evidence identity, installed executable identity, package
 * declaration, and both the package and complete dependency-closure trees.
 */
export async function verifyFreezeEvidence({ runtime, holtBin, freezeEvidence, allowSynthetic = false }) {
  const [runtimeReal, binReal, evidenceReal] = await Promise.all([
    fs.realpath(runtime), fs.realpath(holtBin), fs.realpath(freezeEvidence),
  ]);
  assert(inside(runtimeReal, binReal), `HOLT_BIN is outside HOLT_RUNTIME: ${binReal}`);

  const evidenceBytes = await fs.readFile(evidenceReal);
  const evidenceSha256 = sha256(evidenceBytes);
  const sidecarPath = `${evidenceReal}.sha256`;
  const sidecar = await fs.readFile(sidecarPath, 'utf8');
  assert(sidecar === `${evidenceSha256}  ${path.basename(evidenceReal)}\n`,
    `freeze evidence sidecar mismatch: ${sidecarPath}`);

  const parsed = JSON.parse(evidenceBytes.toString('utf8'));
  assert(parsed.kind === 'holt-frozen-installed-runtime' && parsed.valid === true,
    'FREEZE_EVIDENCE is not a valid holt-frozen-installed-runtime artifact');
  assert(parsed.artifact?.schema === FREEZE_SCHEMA,
    `FREEZE_EVIDENCE schema must be ${FREEZE_SCHEMA}`);
  const semanticIdentity = semanticEvidenceIdentity(parsed);
  assert(parsed.artifact?.identity === semanticIdentity,
    'FREEZE_EVIDENCE semantic identity mismatch');

  const synthetic = parsed.synthetic === true;
  assert(!synthetic || allowSynthetic,
    'synthetic frozen runtime refused; --allow-synthetic-runtime is harness self-test only');
  if (!synthetic) {
    assert(parsed.preflight?.valid === true && parsed.preflight?.shutdown?.clean === true,
      'freeze MCP preflight is not valid with a clean shutdown');
  }
  assert(parsed.runtime?.immutableAcrossPreflight === true,
    'freeze preflight did not prove runtime immutability');

  const recordedRuntime = await fs.realpath(path.resolve(parsed.runtime?.root ?? ''));
  const packageRoot = await fs.realpath(path.resolve(parsed.runtime?.packageRoot ?? ''));
  const executable = await fs.realpath(path.resolve(parsed.runtime?.before?.executable?.path ?? ''));
  assert(recordedRuntime === runtimeReal, 'FREEZE_EVIDENCE names a different runtime root');
  assert(executable === binReal, 'FREEZE_EVIDENCE names a different executable');
  assert(inside(runtimeReal, packageRoot), 'freeze package root is outside HOLT_RUNTIME');

  const [runtimeTree, packageTree, executableIdentity] = await Promise.all([
    installationTreeIdentity(runtimeReal),
    installationTreeIdentity(packageRoot),
    captureFile(binReal),
  ]);
  for (const [label, actual, expected] of [
    ['runtime tree', runtimeTree.sha256, parsed.runtime?.before?.installTree?.sha256],
    ['runtime after-tree', runtimeTree.sha256, parsed.runtime?.afterTree?.sha256],
    ['package tree', packageTree.sha256, parsed.runtime?.before?.packageTree?.sha256],
    ['executable sha256', executableIdentity.sha256, parsed.runtime?.before?.executable?.sha256],
    ['executable bytes', executableIdentity.bytes, parsed.runtime?.before?.executable?.bytes],
  ]) {
    assert(expected !== undefined && actual === expected, `${label} does not match FREEZE_EVIDENCE`);
  }

  const packageJsonPath = path.join(packageRoot, 'package.json');
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
  assert(packageJson.name === 'holt', `frozen package name is ${packageJson.name}, not holt`);
  const declaredBin = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.holt;
  assert(typeof declaredBin === 'string' && declaredBin.length > 0,
    'frozen package does not declare bin.holt');
  assert(await fs.realpath(path.join(packageRoot, declaredBin)) === binReal,
    'HOLT_BIN is not the installed package declared executable');
  if (parsed.runtime?.package?.version !== undefined) {
    assert(packageJson.version === parsed.runtime.package.version,
      'installed package version differs from FREEZE_EVIDENCE');
  }

  let tarball = null;
  if (!synthetic) {
    const tarballPath = await fs.realpath(path.resolve(parsed.tarball?.path ?? ''));
    tarball = await captureFile(tarballPath);
    assert(tarball.sha256 === parsed.tarball?.sha256 && tarball.bytes === parsed.tarball?.bytes,
      'referenced npm tarball bytes differ from FREEZE_EVIDENCE');
  }

  return {
    valid: true,
    synthetic,
    evidence: { path: evidenceReal, bytes: evidenceBytes.length, sha256: evidenceSha256 },
    sidecar: await captureFile(sidecarPath),
    semanticIdentity,
    runtime: runtimeTree,
    package: packageTree,
    packageRoot,
    executable: executableIdentity,
    packageJson: { path: packageJsonPath, name: packageJson.name, version: packageJson.version },
    tarball,
  };
}

export function isolatedEnv(home, runtime, holtBin, additions = {}) {
  return {
    // Synthetic proof executables intentionally use `#!/usr/bin/env node`, so the isolated
    // environment must carry the exact Node runtime that launched the harness. CI's setup-node
    // path is not necessarily /usr/bin, and omitting it turns a valid proof into exit 127 before
    // Holt is ever exercised.
    PATH: [path.join(runtime, 'node_modules', '.bin'), path.dirname(holtBin),
      path.dirname(process.execPath), '/usr/bin', '/bin']
      .filter((entry, index, rows) => rows.indexOf(entry) === index).join(path.delimiter),
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    HOLT_HOME: path.join(home, '.holt-home'),
    HOLT_TMPDIR: path.join(home, '.tmp'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'Holt TUI graph proof',
    GIT_AUTHOR_EMAIL: 'tui-graph-proof@holt.invalid',
    GIT_COMMITTER_NAME: 'Holt TUI graph proof',
    GIT_COMMITTER_EMAIL: 'tui-graph-proof@holt.invalid',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C.UTF-8',
    LANG: 'C.UTF-8',
    TERM: 'xterm-256color',
    ...additions,
  };
}

/** Spawn and await natural completion. There is intentionally no timeout or kill path. */
export async function runProcess(command, args, { cwd, env, stdin = null } = {}) {
  const startedAt = new Date().toISOString();
  const started = process.hrtime.bigint();
  const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
  if (stdin === null) child.stdin.end(); else child.stdin.end(stdin);
  const completion = await new Promise((resolve) => {
    let spawnError = null;
    child.once('error', (error) => { spawnError = error.message; });
    child.once('close', (exitCode, signal) => resolve({
      exitCode, signal: signal ?? null, spawnError,
    }));
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
    stdout: out.toString('utf8'),
    stderr: err.toString('utf8'),
    stdoutRaw: out,
    stderrRaw: err,
    stdoutEvidence: captureBytes(out),
    stderrEvidence: captureBytes(err),
  };
}

export async function writeRaw(file, bytes, mode = 0o600) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes, { flag: 'wx', mode });
  return captureFile(file);
}

export async function writeJson(file, value) {
  return writeRaw(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function evidenceIdentity(rawEvidence) {
  return `sha256:${sha256(JSON.stringify(rawEvidence))}`;
}

/** Write a semantic identity plus an exact-byte sidecar, refusing either pre-existing path. */
export async function writeEvidenceArtifact(file, rawEvidence, summary = []) {
  const identity = evidenceIdentity(rawEvidence);
  const artifact = {
    ...rawEvidence,
    artifact: {
      schema: EVIDENCE_SCHEMA,
      identity,
      identityScope: 'raw evidence excluding derived summary',
    },
    summary: summary.map((row) => ({ ...row, artifactIdentity: identity })),
  };
  const encoded = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
  const sidecar = Buffer.from(`${sha256(encoded)}  ${path.basename(file)}\n`);
  if (await exists(file) || await exists(`${file}.sha256`)) {
    throw new Error(`refusing to overwrite evidence artifact or sidecar: ${file}`);
  }
  await writeRaw(file, encoded);
  await writeRaw(`${file}.sha256`, sidecar);
  return { artifact, identity, fileSha256: sha256(encoded) };
}

export async function assertExecutable(file) {
  await fs.access(file, fsConstants.X_OK);
  const stat = await fs.stat(file);
  assert(stat.isFile(), `not an executable file: ${file}`);
}

export const ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
export const stripAnsi = (value) => String(value).replace(ANSI_CSI, '');

function cellWidth(character) {
  const point = character.codePointAt(0) ?? 0;
  if (point === 0 || point < 0x20 || (point >= 0x7f && point < 0xa0)
    || /[\p{Mark}\p{Cf}]/u.test(character)) return 0;
  return point >= 0x1100 && (
    point <= 0x115f || point === 0x2329 || point === 0x232a
    || (point >= 0x2e80 && point <= 0xa4cf && point !== 0x303f)
    || (point >= 0xac00 && point <= 0xd7a3)
    || (point >= 0xf900 && point <= 0xfaff)
    || (point >= 0xfe10 && point <= 0xfe19)
    || (point >= 0xfe30 && point <= 0xfe6f)
    || (point >= 0xff00 && point <= 0xff60)
    || (point >= 0xffe0 && point <= 0xffe6)
    || (point >= 0x1f000 && point <= 0x1faff)
    || (point >= 0x20000 && point <= 0x3fffd)
  ) ? 2 : 1;
}

export const visibleWidth = (value) => [...stripAnsi(value)]
  .reduce((total, character) => total + cellWidth(character), 0);

export function frameMeasurements(raw, rows, columns, label) {
  const visible = stripAnsi(raw).replace(/\r/g, '');
  const lines = visible.endsWith('\n') ? visible.slice(0, -1).split('\n') : visible.split('\n');
  const widths = lines.map(visibleWidth);
  assert(lines.length === rows, `${label} has ${lines.length} logical rows, expected ${rows}`);
  assert(Math.max(...widths) <= columns,
    `${label} wraps: maximum visible width ${Math.max(...widths)} exceeds ${columns}`);
  return { rows: lines.length, columns, maxWidth: Math.max(...widths), lines, text: visible };
}

export async function directoryChecksums(root, { exclude = [] } = {}) {
  const omitted = new Set(exclude.map(portable));
  const rows = [];
  const visit = async (absolute, relative) => {
    const stat = await fs.lstat(absolute);
    if (stat.isDirectory()) {
      const children = await fs.readdir(absolute, { withFileTypes: true });
      children.sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) {
        await visit(path.join(absolute, child.name), path.join(relative, child.name));
      }
      return;
    }
    if (!stat.isFile() || omitted.has(portable(relative))) return;
    const bytes = await fs.readFile(absolute);
    rows.push({ path: portable(relative), bytes: bytes.length, sha256: sha256(bytes) });
  };
  await visit(root, '');
  return rows;
}

export async function writeChecksumManifest(root, fileName = 'ARTIFACT-SHA256SUMS') {
  const rows = await directoryChecksums(root, { exclude: [fileName] });
  const contents = `${rows.map((row) => `${row.sha256}  ${row.path}`).join('\n')}\n`;
  const file = path.join(root, fileName);
  const identity = await writeRaw(file, contents);
  return { file: identity, entries: rows.length, rows };
}

export function parseDataLiteral(html) {
  const scriptOpen = html.indexOf('<script>');
  assert(scriptOpen >= 0, 'graph HTML has no inline script');
  const body = html.slice(scriptOpen + '<script>'.length);
  const marker = 'const DATA = ';
  const start = body.indexOf(marker);
  assert(start >= 0, 'graph HTML has no DATA literal');
  const from = start + marker.length;
  const end = body.indexOf(';\n', from);
  assert(end > from, 'graph HTML DATA literal terminator not found');
  const literal = body.slice(from, end);
  return { literal, data: JSON.parse(literal) };
}

export function publicRunRecord(run) {
  const {
    stdoutRaw: _stdoutRaw,
    stderrRaw: _stderrRaw,
    ...record
  } = run;
  return record;
}
