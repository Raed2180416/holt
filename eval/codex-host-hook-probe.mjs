#!/usr/bin/env node

// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * Byte-preserving witness for the real-Codex host conformance run.
 *
 * This file is copied into each disposable containment root. In `holt` mode it forwards the exact
 * hook stdin bytes to the frozen Holt CLI, forwards Holt's stdout/stderr/exit status back to Codex,
 * and records both sides. In `fail` mode it records the invocation and deliberately exits 1 so the
 * harness can measure Codex's hook-runner failure behavior instead of assuming it.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function option(argv, name, fallback = null) {
  const index = argv.indexOf(`--${name}`);
  return index < 0 ? fallback : argv[index + 1];
}

function required(argv, name) {
  const value = option(argv, name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function appendRecord(file, record) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`evidence path is not a regular non-symlink file: ${file}`);
  }
  await fs.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
}

async function run(command, args, { cwd, stdin }) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
  child.stdin.end(stdin);
  const completion = await new Promise((resolve) => {
    let spawnError = null;
    child.once('error', (error) => { spawnError = error.message; });
    child.once('close', (exitCode, signal) => resolve({
      exitCode,
      signal: signal ?? null,
      spawnError,
    }));
  });
  return {
    ...completion,
    stdout: Buffer.concat(stdout),
    stderr: Buffer.concat(stderr),
  };
}

export async function probeMain(argv = process.argv.slice(2)) {
  const evidencePath = path.resolve(required(argv, 'evidence'));
  const mode = required(argv, 'mode');
  const failureSentinel = option(
    argv,
    'failure-sentinel',
    'HOLT_CODEX_CONFORMANCE_INJECTED_HOOK_FAILURE_V1',
  );
  if (!['holt', 'fail'].includes(mode)) throw new Error(`unknown --mode ${mode}`);

  const input = await readStdin();
  const invocationId = randomUUID();
  let payload = null;
  let parseError = null;
  try { payload = JSON.parse(input.toString('utf8')); } catch (error) { parseError = error.message; }
  const startedAt = new Date().toISOString();
  await appendRecord(evidencePath, {
    phase: 'start',
    invocationId,
    at: startedAt,
    mode,
    inputBytes: input.length,
    inputSha256: sha256(input),
    inputBase64: input.toString('base64'),
    parseError,
    hookEventName: payload?.hook_event_name ?? null,
    toolName: payload?.tool_name ?? null,
    cwd: payload?.cwd ?? null,
    command: payload?.tool_input?.command ?? null,
  });

  if (mode === 'fail') {
    const stderr = Buffer.from(`${failureSentinel}\n`);
    await appendRecord(evidencePath, {
      phase: 'complete',
      invocationId,
      at: new Date().toISOString(),
      mode,
      exitCode: 1,
      signal: null,
      spawnError: null,
      stdoutBytes: 0,
      stdoutSha256: sha256(Buffer.alloc(0)),
      stdoutBase64: '',
      stderrBytes: stderr.length,
      stderrSha256: sha256(stderr),
      stderrBase64: stderr.toString('base64'),
    });
    process.stderr.write(stderr);
    process.exitCode = 1;
    return;
  }

  const nodeBin = path.resolve(required(argv, 'node-bin'));
  const holtBin = path.resolve(required(argv, 'holt-bin'));
  const cwd = typeof payload?.cwd === 'string' && path.isAbsolute(payload.cwd)
    ? payload.cwd
    : process.cwd();
  const result = await run(
    nodeBin,
    [holtBin, 'hook', 'pre-tool-use', '--host', 'codex', '--cwd', cwd],
    { cwd, stdin: input },
  );
  await appendRecord(evidencePath, {
    phase: 'complete',
    invocationId,
    at: new Date().toISOString(),
    mode,
    exitCode: result.exitCode,
    signal: result.signal,
    spawnError: result.spawnError,
    stdoutBytes: result.stdout.length,
    stdoutSha256: sha256(result.stdout),
    stdoutBase64: result.stdout.toString('base64'),
    stderrBytes: result.stderr.length,
    stderrSha256: sha256(result.stderr),
    stderrBase64: result.stderr.toString('base64'),
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = Number.isSafeInteger(result.exitCode) ? result.exitCode : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  probeMain().catch((error) => {
    process.stderr.write(`codex host hook probe failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
