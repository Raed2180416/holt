// SPDX-License-Identifier: FSL-1.1-MIT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newRepo } from '../fixtures.mjs';
import { inspect } from '../../src/index.mjs';
import { assessCommand } from '../../src/agent.mjs';
import { rescue } from '../../src/actions.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'holt.mjs');

function holt(args, cwd) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], {
      cwd, timeout: 120_000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1' },
    }, (error, stdout, stderr) => resolve({
      code: error ? (error.code ?? 1) : 0,
      stdout: String(stdout ?? ''),
      stderr: String(stderr ?? ''),
    }));
  });
}

test('EMPTY IGNORED DIRECTORY: no surface invents sole-copy bytes that do not exist', async (t) => {
  const fx = await newRepo('empty-ignored-directory');
  t.after(() => fx.cleanup());
  await fx.write('.gitignore', 'dist/\n');
  await fx.write('package.json', '{"name":"empty-dir-fixture","private":true}\n');
  await fx.commit('ignore generated output');

  const wt = await fx.worktree('empty-output');
  await fs.mkdir(path.join(wt, 'dist', 'nested', 'deeper'), { recursive: true });

  const report = await inspect(fx.root, {});
  const safe = report.safe.find((row) => row.id === 'empty-output');
  assert.equal(safe?.safe, true,
    'a linked worktree containing only empty ignored directories has no bytes to lose');

  const gate = await holt(['gate', 'empty-output', '--cwd', fx.root], fx.root);
  assert.equal(gate.code, 0,
    'the public gate exit code must agree with the measured empty content: ' + gate.stdout + gate.stderr);

  for (const command of [
    'rmdir ' + JSON.stringify(path.join(wt, 'dist', 'nested', 'deeper')),
    'node -e "require(\'fs\').rmdirSync('
      + JSON.stringify(path.join(wt, 'dist', 'nested', 'deeper')) + ')"',
    'git worktree remove ' + JSON.stringify(wt),
  ]) {
    const verdict = await assessCommand(command, fx.root);
    assert.equal(verdict.decision, 'allow',
      'empty directory structure must not become a refusal: ' + command + '\n' + (verdict.reason ?? ''));
  }

  const captured = await rescue(fx.root, 'empty-output', { symbols: false });
  assert.equal(captured.ok, true);
  assert.equal(captured.nothingToRescue, true,
    'rescue and gate must agree there are no representable bytes to capture');

  // Negative control: the same ignored path with one real file is protected. The fix is a
  // filesystem measurement, never a generated-name allowlist.
  await fs.writeFile(path.join(wt, 'dist', 'nested', 'deeper', 'only.bin'), 'sole-copy bytes\n');
  const after = await inspect(fx.root, {});
  assert.equal(after.safe.find((row) => row.id === 'empty-output')?.safe, false);
  const removal = await assessCommand('rm -rf ' + JSON.stringify(path.join(wt, 'dist')), fx.root);
  assert.notEqual(removal.decision, 'allow',
    'a non-empty ignored directory must remain protected');
  assert.ok(removal.files?.some((f) => f === 'dist/' || f.startsWith('dist/')),
    'the verdict must name the ignored content it measured: ' + JSON.stringify(removal));
});
