// SPDX-License-Identifier: FSL-1.1-MIT
/** Install the local editor bridge with exact ownership receipts and recoverable removal. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { readStableRegularFile, writePrivateFileAtomic, ensurePrivateDirectory, syncPrivateDirectory } from '../stable-file.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const sha = (value) => createHash('sha256').update(value).digest('hex');
const PREFIX = 'contrare.holt-workspace-';
const receiptName = '.holt-install.json';
const defaultDirectory = () => path.join(os.homedir(), '.vscode', 'extensions');

async function ownedInstallation(directory) {
  const receipt = await readStableRegularFile(path.join(directory, receiptName), { maxBytes: 16384, requireOwner: true, requireSingleLink: true });
  if (!receipt.ok) return { ok: false, code: 'unowned-extension' };
  let record;
  try { record = JSON.parse(receipt.bytes.toString('utf8')); } catch { return { ok: false, code: 'invalid-editor-receipt' }; }
  if (record.version !== 1 || record.extension !== 'contrare.holt-workspace' || !record.files || typeof record.files !== 'object') return { ok: false, code: 'invalid-editor-receipt' };
  const names = Object.keys(record.files).sort();
  if (!['LICENSE-NOTICE.md,LICENSE.md,extension.cjs,launcher.json,package.json',
    'LICENSE-NOTICE.md,LICENSE.md,extension.cjs,launcher.json,package.json,paths.mjs'].includes(names.join(','))) return { ok: false, code: 'invalid-editor-receipt' };
  const actual = (await fs.readdir(directory)).filter((name) => name !== receiptName).sort();
  if (actual.join('\0') !== names.join('\0')) return { ok: false, code: 'editor-files-changed' };
  for (const name of names) {
    const file = await readStableRegularFile(path.join(directory, name), { maxBytes: 1024 * 1024, requireOwner: true, requireSingleLink: true });
    if (!file.ok || sha(file.bytes) !== record.files[name]) return { ok: false, code: 'editor-files-changed', file: name };
  }
  return { ok: true, record };
}

export async function editorInstallations({ directory = defaultDirectory() } = {}) {
  if (!path.isAbsolute(directory)) return { ok: false, code: 'absolute-extensions-directory-required', installations: [] };
  let names;
  try { names = await fs.readdir(directory); } catch (error) {
    return { ok: error?.code === 'ENOENT', directory, installations: [], ...(error?.code === 'ENOENT' ? {} : { code: 'extensions-directory-unavailable' }) };
  }
  const matches = names.filter((name) => name.startsWith(PREFIX)).sort();
  const installations = [];
  for (const name of matches.slice(0, 128)) {
    const target = path.join(directory, name);
    const checked = await ownedInstallation(target);
    installations.push({ path: target, verified: checked.ok, ...(checked.ok ? {} : { code: checked.code }) });
  }
  return { ok: true, directory, installations, omitted: matches.length > 128 };
}

export async function installEditorExtension({ directory = defaultDirectory() } = {}) {
  if (!path.isAbsolute(directory)) return { ok: false, code: 'absolute-extensions-directory-required' };
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'src/integrate/editor/manifest.json'), 'utf8'));
  manifest.version = pkg.version;
  const files = {
    'package.json': Buffer.from(JSON.stringify(manifest, null, 2) + '\n'),
    'extension.cjs': await fs.readFile(path.join(ROOT, 'src/integrate/editor/extension.cjs')),
    'paths.mjs': await fs.readFile(path.join(ROOT, 'src/paths.mjs')),
    'launcher.json': Buffer.from(JSON.stringify({ version: 1, node: process.execPath, holt: path.join(ROOT, 'bin/holt.mjs') }) + '\n'),
    'LICENSE.md': await fs.readFile(path.join(ROOT, 'LICENSE.md')),
    'LICENSE-NOTICE.md': await fs.readFile(path.join(ROOT, 'LICENSE-NOTICE.md')),
  };
  const target = path.join(directory, `${PREFIX}${pkg.version}`);
  const expected = Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, sha(bytes)]));
  try {
    await fs.lstat(target);
    const existing = await ownedInstallation(target);
    if (existing.ok && JSON.stringify(existing.record.files) === JSON.stringify(expected)) return { ok: true, unchanged: true, directory: target };
    return { ok: false, code: 'existing-editor-installation-differs', directory: target,
      reason: 'The existing extension is retained. Use holt editor uninstall to move verified owned installations into recovery storage, then install again.' };
  } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  await fs.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.holt-editor-install-${randomUUID()}`);
  await fs.mkdir(temporary, { mode: 0o700 });
  for (const [name, bytes] of Object.entries(files)) await writePrivateFileAtomic(path.join(temporary, name), bytes);
  await writePrivateFileAtomic(path.join(temporary, receiptName), Buffer.from(JSON.stringify({ version: 1, extension: 'contrare.holt-workspace', files: expected }) + '\n'));
  // Git-style atomic publication: a complete extension is visible at once. Never overwrite an
  // existing populated target; concurrent identical installs leave their full temporary copy.
  await fs.rename(temporary, target);
  await syncPrivateDirectory(directory);
  return { ok: true, directory: target, extension: 'contrare.holt-workspace',
    next: 'Restart the editor to activate private workspace recovery. Install on the remote machine for remote workspaces.' };
}

export async function uninstallEditorExtensions(options = {}) {
  const inventory = await editorInstallations(options);
  if (!inventory.ok || !inventory.directory) return inventory;
  const actions = [];
  for (const installation of inventory.installations) {
    const checked = await ownedInstallation(installation.path);
    if (!checked.ok) { actions.push({ path: installation.path, action: 'retained', code: checked.code }); continue; }
    const recovery = await ensurePrivateDirectory(path.join(path.dirname(inventory.directory), 'holt-editor-recovery'));
    const destination = path.join(recovery, `${path.basename(installation.path)}-${randomUUID()}`);
    await fs.rename(installation.path, destination);
    await syncPrivateDirectory(recovery);
    await syncPrivateDirectory(inventory.directory);
    actions.push({ path: installation.path, action: 'quarantined', destination });
  }
  return { ok: actions.every((item) => item.action === 'quarantined'), actions, omitted: inventory.omitted,
    next: 'Restart the editor. Existing session records and captured editor text remain in their repositories.' };
}
