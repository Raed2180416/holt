// SPDX-License-Identifier: FSL-1.1-MIT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GIT_RUNTIME_REQUIREMENT,
  inspectGitRuntime,
  verifyInertHooksPath,
} from '../../scripts/check-git-runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(ROOT, 'bin', 'holt.mjs');

function runHolt(args, cwd, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], {
      cwd,
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1', ...env },
    }, (error, stdout, stderr) => resolve({
      code: error ? (error.code ?? 1) : 0,
      stdout: String(stdout ?? ''),
      stderr: String(stderr ?? ''),
    }));
  });
}

test('runtime contract: selected Git is >=2.45 and implements --no-lazy-fetch', async () => {
  const runtime = await inspectGitRuntime();
  assert.equal(runtime.required, GIT_RUNTIME_REQUIREMENT);
  assert.equal(runtime.required, '>=2.45.0');
  assert.equal(runtime.ok, true, runtime.reason ?? JSON.stringify(runtime));
  assert.equal(runtime.noLazyFetch, true);
  assert.match(runtime.version ?? '', /^git version /);
});

test('runtime contract: the exact inert hooks path passes a non-vacuous live proof', async () => {
  const proof = await verifyInertHooksPath();
  assert.deepEqual(proof, { ok: true, path: '/dev/null', positiveControl: true });
});

test('doctor reports the selected Git version, minimum, and capability in JSON', async () => {
  const result = await runHolt(['doctor', '--json'], ROOT);
  assert.equal(result.code, 0, result.stderr);
  const doctor = JSON.parse(result.stdout);
  assert.equal(doctor.ok, true);
  assert.equal(doctor.git.required, '>=2.45.0');
  assert.equal(doctor.git.supported, true);
  assert.equal(doctor.git.noLazyFetch, true);
  assert.match(doctor.git.version, /^git version /);
});

test('doctor turns an old Git into an actionable prerequisite diagnostic, not a stack trace', async (t) => {
  if (process.platform === 'win32') {
    return t.skip('PATH interposition needs a native git.exe on Windows; Git-for-Windows is covered by the live inert-hook proof');
  }
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-old-git-doctor-'));
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));
  const fakeBin = path.join(scratch, 'bin');
  await fs.mkdir(fakeBin);
  const shim = path.join(fakeBin, 'git');
  await fs.writeFile(shim, '#!/bin/sh\nprintf "git version 2.44.4\\n"\n', { mode: 0o755 });
  await fs.chmod(shim, 0o755);
  const env = { PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}` };

  const json = await runHolt(['doctor', '--json'], scratch, env);
  assert.equal(json.code, 2, `${json.stdout}\n${json.stderr}`);
  const diagnosis = JSON.parse(json.stdout);
  assert.equal(diagnosis.ok, false);
  assert.equal(diagnosis.git.version, 'git version 2.44.4');
  assert.equal(diagnosis.git.required, '>=2.45.0');
  assert.equal(diagnosis.git.supported, false);
  assert.match(diagnosis.fix, /git-scm\.com\/downloads/);
  assert.doesNotMatch(json.stderr, /node:internal|\bat async\b/);

  const human = await runHolt(['doctor'], scratch, env);
  assert.equal(human.code, 2);
  assert.match(human.stdout, /Git >=2\.45\.0 with --no-lazy-fetch/);
  assert.match(human.stdout, /git-scm\.com\/downloads/);
});
