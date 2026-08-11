// SPDX-License-Identifier: FSL-1.1-MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

import {
  ensurePrivateDirectory, readStableRegularFile, writePrivateFileAtomic,
} from '../../src/stable-file.mjs';

test('stable file: planted symlinks are never read or followed by private publication', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-stable-file-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const privateDir = path.join(root, 'state');
  await ensurePrivateDirectory(privateDir);
  const external = path.join(root, 'external.txt');
  const leaf = path.join(privateDir, 'cache.json');
  await fs.writeFile(external, 'do-not-touch');
  await fs.symlink(external, leaf);

  const refused = await readStableRegularFile(leaf);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'not-regular-file');

  await writePrivateFileAtomic(leaf, 'private-state');
  assert.equal(await fs.readFile(external, 'utf8'), 'do-not-touch',
    'publishing private state must replace the symlink itself, never truncate its target');
  assert.equal(await fs.readFile(leaf, 'utf8'), 'private-state');
  assert.equal((await fs.lstat(leaf)).isSymbolicLink(), false);
});

test('stable file: hard-linked state and non-private directories are tightened or refused', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-stable-owner-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const privateDir = path.join(root, 'state');
  await fs.mkdir(privateDir, { mode: 0o777 });
  await ensurePrivateDirectory(privateDir);
  if (process.platform !== 'win32') assert.equal((await fs.lstat(privateDir)).mode & 0o077, 0);

  const first = path.join(privateDir, 'first');
  const second = path.join(privateDir, 'second');
  await fs.writeFile(first, 'same inode');
  await fs.link(first, second);
  const result = await readStableRegularFile(first, { requireSingleLink: true, requireOwner: true });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'multiple-hardlinks');
});

test('stable file: a hostile FIFO is classified without waiting for a writer', async (t) => {
  if (process.platform === 'win32') return t.skip('Windows has no mkfifo-compatible filesystem node');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-stable-fifo-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fifo = path.join(root, 'hostile-state');
  await new Promise((resolve, reject) => {
    execFile('mkfifo', [fifo], (error) => (error ? reject(error) : resolve()));
  });
  const moduleUrl = new URL('../../src/stable-file.mjs', import.meta.url).href;
  const source = `
    import { readStableRegularFile } from ${JSON.stringify(moduleUrl)};
    const result = await readStableRegularFile(${JSON.stringify(fifo)});
    if (result.ok || result.reason !== 'not-regular-file') {
      console.error(JSON.stringify(result));
      process.exitCode = 2;
    }
  `;
  const result = await new Promise((resolve) => {
    execFile(process.execPath, ['--input-type=module', '--eval', source], {
      timeout: 1_500,
    }, (error, stdout, stderr) => resolve({ error, stdout: String(stdout), stderr: String(stderr) }));
  });
  assert.equal(result.error, null,
    `reading a FIFO blocked instead of refusing it: ${result.error?.killed ? 'timed out' : result.stderr}`);
});
