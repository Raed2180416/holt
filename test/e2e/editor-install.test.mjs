import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installEditorExtension, editorInstallations, uninstallEditorExtensions } from '../../src/integrate/editor-install.mjs';

test('EDITOR INSTALL: repeat installation is unchanged and uninstall preserves the exact extension in recovery storage', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-editor-install-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'extensions');
  const installed = await installEditorExtension({ directory });
  assert.equal(installed.ok, true);
  assert.equal((await installEditorExtension({ directory })).unchanged, true);
  const inventory = await editorInstallations({ directory });
  assert.equal(inventory.installations[0].verified, true);
  const original = await fs.readFile(path.join(installed.directory, 'extension.cjs'));
  const removed = await uninstallEditorExtensions({ directory });
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.equal(removed.actions[0].action, 'quarantined');
  assert.deepEqual(await fs.readFile(path.join(removed.actions[0].destination, 'extension.cjs')), original);
  assert.equal((await editorInstallations({ directory })).installations.length, 0);
});

test('EDITOR INSTALL: user changes and unowned lookalikes are retained', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-editor-preserve-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'extensions');
  const installed = await installEditorExtension({ directory });
  await fs.writeFile(path.join(installed.directory, 'user-notes.txt'), 'only copy');
  const lookalike = path.join(directory, 'contrare.holt-workspace-user-owned');
  await fs.mkdir(lookalike);
  await fs.writeFile(path.join(lookalike, 'draft.txt'), 'also only copy');
  assert.equal((await installEditorExtension({ directory })).code, 'existing-editor-installation-differs');
  const removed = await uninstallEditorExtensions({ directory });
  assert.equal(removed.ok, false);
  assert.equal(removed.actions.filter((item) => item.action === 'retained').length, 2);
  assert.equal(await fs.readFile(path.join(installed.directory, 'user-notes.txt'), 'utf8'), 'only copy');
  assert.equal(await fs.readFile(path.join(lookalike, 'draft.txt'), 'utf8'), 'also only copy');
});
