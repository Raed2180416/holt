// SPDX-License-Identifier: FSL-1.1-MIT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectOmittedInstall, ROOT } from '../../scripts/check-omit-optional-install.mjs';

const SCRIPT = fileURLToPath(new URL('../../scripts/check-omit-optional-install.mjs', import.meta.url));

function runCli(prefix) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, '--prefix', prefix], { cwd: ROOT }, (error, stdout, stderr) => {
      resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function fixture(t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-omit-proof-'));
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));
  const source = path.join(scratch, 'source');
  const prefix = path.join(scratch, 'isolated-prefix');
  const installed = path.join(prefix, 'node_modules', 'holt');
  await fs.mkdir(source, { recursive: true });
  await fs.mkdir(installed, { recursive: true });
  const pkg = {
    name: 'holt',
    version: '9.8.7-test',
    dependencies: {
      '@example/required-runtime': '2.3.4',
    },
    optionalDependencies: {
      '@example/scoped-optional': '1.0.0',
      'plain-optional': '1.0.0',
    },
  };
  await fs.writeFile(path.join(source, 'package.json'), `${JSON.stringify(pkg)}\n`);
  await fs.writeFile(path.join(installed, 'package.json'), `${JSON.stringify(pkg)}\n`);
  const required = path.join(prefix, 'node_modules', '@example', 'required-runtime');
  await fs.mkdir(required, { recursive: true });
  await fs.writeFile(path.join(required, 'package.json'), `${JSON.stringify({ name: '@example/required-runtime', version: '2.3.4' })}\n`);
  return { source, prefix, installed };
}

test('OMIT OPTIONAL PROOF: a separate prefix with every optional root absent passes', async (t) => {
  const { source, prefix } = await fixture(t);
  const result = await inspectOmittedInstall(prefix, { root: source });
  assert.equal(result.ok, true, result.problems.join('\n'));
  assert.equal(result.package, 'holt@9.8.7-test');
  assert.deepEqual(result.presentRequired, ['@example/required-runtime']);
  assert.deepEqual(result.absent, ['@example/scoped-optional', 'plain-optional']);
});

test('OMIT OPTIONAL PROOF: a missing or wrong required runtime surface makes the proof fail', async (t) => {
  const { source, prefix } = await fixture(t);
  const required = path.join(prefix, 'node_modules', '@example', 'required-runtime');
  await fs.rm(required, { recursive: true });
  let result = await inspectOmittedInstall(prefix, { root: source });
  assert.equal(result.ok, false);
  assert.match(result.problems.join('\n'), /required-runtime.*0 independent package root/);

  await fs.mkdir(required, { recursive: true });
  await fs.writeFile(path.join(required, 'package.json'), '{"name":"@example/required-runtime","version":"9.9.9"}\n');
  result = await inspectOmittedInstall(prefix, { root: source });
  assert.equal(result.ok, false);
  assert.match(result.problems.join('\n'), /required-runtime.*required at 2\.3\.4 is.*9\.9\.9/);
});

test('OMIT OPTIONAL PROOF: a physically present optional package makes the proof fail', async (t) => {
  const { source, prefix } = await fixture(t);
  const leaked = path.join(prefix, 'node_modules', '@example', 'scoped-optional');
  await fs.mkdir(leaked, { recursive: true });
  await fs.writeFile(path.join(leaked, 'package.json'), '{"name":"@example/scoped-optional","version":"1.0.0"}\n');
  const result = await inspectOmittedInstall(prefix, { root: source });
  assert.equal(result.ok, false);
  assert.match(result.problems.join('\n'), /@example\/scoped-optional was not omitted/);
});

test('OMIT OPTIONAL PROOF: a prefix inside the checkout is rejected as non-isolated', async (t) => {
  const { source } = await fixture(t);
  const prefix = path.join(source, 'pretend-prefix');
  const installed = path.join(prefix, 'node_modules', 'holt');
  await fs.mkdir(installed, { recursive: true });
  await fs.copyFile(path.join(source, 'package.json'), path.join(installed, 'package.json'));
  const result = await inspectOmittedInstall(prefix, { root: source });
  assert.equal(result.ok, false);
  assert.match(result.problems.join('\n'), /inside the source checkout/);
});

test('OMIT OPTIONAL PROOF CLI: absence exits zero and a planted optional root exits nonzero', async (t) => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-omit-proof-cli-'));
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));
  const sourcePackage = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const installed = path.join(scratch, 'node_modules', 'holt');
  await fs.mkdir(installed, { recursive: true });
  await fs.writeFile(path.join(installed, 'package.json'), `${JSON.stringify(sourcePackage)}\n`);
  for (const [name, version] of Object.entries(sourcePackage.dependencies ?? {})) {
    const dependency = path.join(scratch, 'node_modules', ...name.split('/'));
    await fs.mkdir(dependency, { recursive: true });
    await fs.writeFile(path.join(dependency, 'package.json'), `${JSON.stringify({ name, version })}\n`);
  }

  const clean = await runCli(scratch);
  const count = Object.keys(sourcePackage.optionalDependencies ?? {}).length;
  assert.equal(clean.code, 0, clean.stderr);
  assert.match(clean.stdout, new RegExp(`${count}/${count} optional roots absent`));
  const requiredCount = Object.keys(sourcePackage.dependencies ?? {}).length;
  assert.match(clean.stdout, new RegExp(`${requiredCount}/${requiredCount} required roots exact`));

  const plantedName = Object.keys(sourcePackage.optionalDependencies ?? {})[0];
  assert.ok(plantedName, 'the CLI positive control needs a real optional dependency to plant');
  const planted = path.join(scratch, 'node_modules', ...plantedName.split('/'));
  await fs.mkdir(planted, { recursive: true });
  await fs.writeFile(path.join(planted, 'package.json'), `${JSON.stringify({ name: plantedName, version: '0.0.0-plant' })}\n`);
  const red = await runCli(scratch);
  assert.equal(red.code, 1);
  assert.match(red.stderr, new RegExp(`${plantedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} was not omitted`));
});
