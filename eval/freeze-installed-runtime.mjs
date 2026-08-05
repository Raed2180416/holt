#!/usr/bin/env node

/**
 * Build the immutable runtime used by paid agent evaluations from an exact npm tarball.
 *
 * One command performs the part that an unpacked tarball cannot: a normal npm install with its
 * dependency closure, under a masked HOME, followed by a real contained MCP initialize ->
 * tools/list -> clean-EOF preflight. The target and evidence paths must not already exist.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  installationTreeIdentity,
  mcpRuntimePreflight,
} from './run.mjs';
import { writeEvidenceArtifact } from './prep.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};
const requirePath = (name) => {
  const value = opt(name);
  if (!value) throw new Error(`--${name} is required`);
  return path.resolve(value);
};
const tarball = requirePath('tarball');
const runtime = requirePath('runtime');
const evidenceOut = requirePath('evidence');
const packageName = opt('package', 'holt');
const bwrapBin = path.resolve(opt('bwrap', '/usr/bin/bwrap'));
const npmBin = path.resolve(opt('npm', '/opt/codex-desktop/resources/node-runtime/bin/npm'));

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function refuseExisting(target, label) {
  const exists = await fs.lstat(target).then(() => true, (error) => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
  if (exists) throw new Error(`${label} already exists; refusing to replace it: ${target}`);
}

async function fileIdentity(file) {
  const bytes = await fs.readFile(file);
  return { path: file, bytes: bytes.length, sha256: sha256(bytes) };
}

async function runProcess(command, args, { cwd = process.cwd(), env = process.env } = {}) {
  const started = Date.now();
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
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
    ...completion,
    elapsedMs: Date.now() - started,
    stdoutBytes: out.length,
    stdoutSha256: sha256(out),
    stdout: out.toString('utf8'),
    stderrBytes: err.length,
    stderrSha256: sha256(err),
    stderr: err.toString('utf8'),
  };
}

async function makeReadOnly(absolute) {
  const stat = await fs.lstat(absolute);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    const children = await fs.readdir(absolute);
    for (const child of children) await makeReadOnly(path.join(absolute, child));
  }
  await fs.chmod(absolute, stat.mode & ~0o222);
}

async function main() {
  await Promise.all([
    fs.access(tarball),
    fs.access(npmBin),
    fs.access(bwrapBin),
    refuseExisting(runtime, 'runtime target'),
    refuseExisting(evidenceOut, 'evidence artifact'),
    refuseExisting(`${evidenceOut}.sha256`, 'evidence checksum'),
  ]);
  const tarballIdentity = await fileIdentity(tarball);
  const tarballDir = path.dirname(tarball);
  await fs.mkdir(runtime, { recursive: true });
  await fs.mkdir(path.dirname(evidenceOut), { recursive: true });

  const installArgv = [
    '--die-with-parent',
    '--new-session',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--cap-drop', 'ALL',
    '--ro-bind', '/', '/',
    '--tmpfs', os.homedir(),
    '--dir', tarballDir,
    '--ro-bind', tarballDir, tarballDir,
    '--dir', runtime,
    '--bind', runtime, runtime,
    '--tmpfs', '/tmp',
    '--proc', '/proc',
    '--dev', '/dev',
    '--setenv', 'HOME', os.homedir(),
    '--setenv', 'npm_config_cache', '/tmp/npm-cache',
    '--chdir', '/tmp',
    '--', npmBin,
    'install',
    '--prefix', runtime,
    '--include=optional',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    tarball,
  ];
  const install = await runProcess(bwrapBin, installArgv);
  if (install.exitCode !== 0 || install.signal !== null || install.spawnError) {
    const written = await writeEvidenceArtifact(evidenceOut, {
      kind: 'holt-frozen-installed-runtime',
      generatedAt: new Date().toISOString(),
      valid: false,
      failureStage: 'ambient-masked npm install',
      tarball: tarballIdentity,
      install: { command: bwrapBin, argv: installArgv, ...install },
    }, []);
    throw new Error(
      `isolated npm install failed; evidence ${written.fileSha256} written to ${evidenceOut}`,
    );
  }

  const packageRoot = path.join(runtime, 'node_modules', packageName);
  const executable = path.join(packageRoot, 'bin', 'holt.mjs');
  const lockPath = path.join(runtime, 'package-lock.json');
  const packageJsonPath = path.join(packageRoot, 'package.json');
  const shrinkwrapPath = path.join(packageRoot, 'npm-shrinkwrap.json');
  const sdkPackagePath = path.join(
    runtime, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json',
  );
  const [packageJsonRaw, sdkPackageRaw] = await Promise.all([
    fs.readFile(packageJsonPath, 'utf8'),
    fs.readFile(sdkPackagePath, 'utf8'),
  ]);
  const packageJson = JSON.parse(packageJsonRaw);
  const sdkPackage = JSON.parse(sdkPackageRaw);
  await makeReadOnly(runtime);

  const before = {
    installTree: await installationTreeIdentity(runtime),
    packageTree: await installationTreeIdentity(packageRoot),
    installLock: await fileIdentity(lockPath),
    packageJson: await fileIdentity(packageJsonPath),
    shrinkwrap: await fileIdentity(shrinkwrapPath),
    executable: await fileIdentity(executable),
    modelContextProtocolSdkPackageJson: await fileIdentity(sdkPackagePath),
  };
  const preflight = await mcpRuntimePreflight({
    executable,
    installRoot: runtime,
    expectedServerVersion: packageJson.version,
    contain: true,
    bwrapBin,
  });
  const afterTree = await installationTreeIdentity(runtime);
  const immutableAcrossPreflight = before.installTree.sha256 === afterTree.sha256;
  const valid = packageJson.name === packageName
    && packageJson.version
    && sdkPackage.name === '@modelcontextprotocol/sdk'
    && sdkPackage.version
    && preflight.valid
    && immutableAcrossPreflight;
  const raw = {
    kind: 'holt-frozen-installed-runtime',
    generatedAt: new Date().toISOString(),
    valid: Boolean(valid),
    construction: {
      oneCommand: `node ${path.join(HERE, 'freeze-installed-runtime.mjs')} --tarball ${tarball} --runtime ${runtime} --evidence ${evidenceOut}`,
      ambientParentResolutionMaskedDuringInstall: true,
      npmInstallScriptsDisabled: true,
      command: bwrapBin,
      argv: installArgv,
      install,
    },
    tarball: tarballIdentity,
    runtime: {
      root: runtime,
      readOnly: true,
      packageRoot,
      package: { name: packageJson.name, version: packageJson.version },
      modelContextProtocolSdk: { name: sdkPackage.name, version: sdkPackage.version },
      normalFullInstallIncludesSdk: true,
      before,
      afterTree,
      immutableAcrossPreflight,
    },
    preflight: {
      beforeAnyModelSpend: true,
      ...preflight,
    },
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  };
  const written = await writeEvidenceArtifact(evidenceOut, raw, []);
  if (!valid) {
    throw new Error(`frozen runtime failed validation; evidence written to ${evidenceOut}`);
  }
  console.log(JSON.stringify({
    ok: true,
    runtime,
    packageRoot,
    executable,
    tarballSha256: tarballIdentity.sha256,
    installTreeSha256: before.installTree.sha256,
    lockSha256: before.installLock.sha256,
    packageTreeSha256: before.packageTree.sha256,
    sdkVersion: sdkPackage.version,
    mcpTools: preflight.protocol.toolCount,
    mcpCleanShutdown: preflight.shutdown.clean,
    evidence: evidenceOut,
    evidenceIdentity: written.identity,
    evidenceFileSha256: written.fileSha256,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 2;
});
