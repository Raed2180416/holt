// SPDX-License-Identifier: FSL-1.1-MIT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  CI_LIGHT_PATHS,
  classifierSelfTest,
  classifyRequiredCiPaths,
  matchesRequiredCiPath,
} from '../../scripts/check-ci-hardening.mjs';

const execFileAsync = promisify(execFile);
const CHECKER = fileURLToPath(new URL('../../scripts/check-ci-hardening.mjs', import.meta.url));
const WORKFLOW = fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url));

/** @param {string} pattern */
function representative(pattern) {
  if (pattern.endsWith('/**')) return `${pattern.slice(0, -3)}/changed.mjs`;
  return pattern.replace('*', 'candidate');
}

test('required-CI classifier skips only the exact reviewed light surface', () => {
  for (const pattern of CI_LIGHT_PATHS) {
    const candidate = representative(pattern);
    assert.equal(matchesRequiredCiPath(candidate, pattern), true, `${pattern} did not match ${candidate}`);
    assert.equal(classifyRequiredCiPaths([candidate]).heavy, false, `${candidate} unexpectedly spent heavy CI`);
  }

  for (const candidate of [
    'src/changed.mjs',
    'Formula/holt.rb',
    'bucket/holt.json',
    '.github/workflows/pages.yml',
    '.github/actions/upload-pages-artifact/action.yml',
    'new-runtime/entry.mjs',
    '.gitignore',
    '.github/workflows/release-not-a-workflow.txt',
  ]) {
    assert.equal(classifyRequiredCiPaths([candidate]).heavy, true, `${candidate} bypassed heavy CI`);
  }
  assert.equal(classifyRequiredCiPaths(['README.md', 'src/changed.mjs']).heavy, true);
});

test('required-CI classifier fails closed on unknown, malformed, and forced change sets', () => {
  for (const paths of [
    [],
    ['/absolute.md'],
    ['docs/../src/changed.mjs'],
    ['docs\\changed.md'],
    ['docs//changed.md'],
    ['docs/changed\nname.md'],
    [null],
  ]) {
    assert.equal(classifyRequiredCiPaths(paths).heavy, true, JSON.stringify(paths));
  }
  assert.equal(classifyRequiredCiPaths(['README.md'], { forceHeavyReason: 'diff-unavailable' }).heavy, true);
});

test('classifier positive control goes red if the allowlist is narrowed or broadened', () => {
  const narrowed = CI_LIGHT_PATHS.filter((pattern) => pattern !== 'site/**');
  const broadened = [...CI_LIGHT_PATHS, '*.mjs'];
  assert.equal(classifierSelfTest().ok, true);
  assert.equal(classifierSelfTest(narrowed).ok, false, 'removing site/** escaped the positive control');
  assert.equal(classifierSelfTest(broadened).ok, false, 'adding root JavaScript escaped the positive control');
});

test('classifier CLI consumes NUL paths and writes only fail-closed GitHub outputs', async (t) => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-ci-scope-test-'));
  t.after(async () => { await fs.rm(scratch, { recursive: true, force: true }); });
  const input = path.join(scratch, 'changed.nul');
  const output = path.join(scratch, 'github-output');

  await fs.writeFile(input, Buffer.from('README.md\0site/index.html\0'));
  const light = await execFileAsync(process.execPath, [
    CHECKER, '--classify-paths-nul', input, '--github-output', output,
  ]);
  assert.equal(JSON.parse(light.stdout).heavy, false);
  assert.match(await fs.readFile(output, 'utf8'), /^heavy=false\nreason=reviewed-non-runtime-change-only\n/);

  await fs.writeFile(input, Buffer.from('README.md\0src/changed.mjs\0'));
  const heavy = await execFileAsync(process.execPath, [CHECKER, '--classify-paths-nul', input]);
  assert.equal(JSON.parse(heavy.stdout).heavy, true);

  await fs.writeFile(input, 'README.md\n');
  const malformed = await execFileAsync(process.execPath, [CHECKER, '--classify-paths-nul', input]);
  assert.equal(JSON.parse(malformed.stdout).heavy, true);
  assert.match(malformed.stderr, /forcing full CI/);
});

test('required aggregate accepts exactly heavy-success or proven-light-skipped job states', async () => {
  const workflow = await fs.readFile(WORKFLOW, 'utf8');
  const script = /node <<'NODE'\n([\s\S]*?)\n\s+NODE/.exec(workflow)?.[1];
  assert.ok(script, 'required aggregate Node program was not found');
  const jobIds = ['matrix', 'bare', 'full', 'crossplat', 'static', 'package', 'supply-chain', 'business'];

  /** @param {string} heavy @param {string} result */
  const state = (heavy, result) => Object.fromEntries([
    ['scope', { result: 'success', outputs: { heavy } }],
    ...jobIds.map((id) => [id, { result }]),
  ]);
  const run = (needs) => execFileAsync(process.execPath, ['-e', script], {
    env: { ...process.env, NEEDS_JSON: JSON.stringify(needs) },
  });

  await assert.doesNotReject(run(state('true', 'success')));
  await assert.doesNotReject(run(state('false', 'skipped')));
  await assert.rejects(run(state('true', 'skipped')));
  await assert.rejects(run(state('false', 'success')));
  await assert.rejects(run(state('invalid', 'skipped')));
  const failedScope = state('false', 'skipped');
  failedScope.scope.result = 'failure';
  await assert.rejects(run(failedScope));
});
