/** Runs INSIDE the actual VS Code extension host against a dedicated temporary workspace. */
const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function run() {
  const config = JSON.parse(await fs.readFile(process.env.HOLT_EDITOR_TEST_CONFIG, 'utf8'));
  const extension = vscode.extensions.getExtension('contrare.holt-workspace');
  assert.ok(extension, 'installed Holt extension is discoverable');
  const api = await extension.activate();
  assert.equal(api.connected, true);
  const { listSessionBuffers, recoverSessionBuffer } = await import(pathToFileURL(path.join(config.packageRoot, 'src/session-recovery.mjs')).href);
  const file = path.join(config.worktree, 'draft.txt');
  const document = await vscode.workspace.openTextDocument(file);
  const editor = await vscode.window.showTextDocument(document);
  const text = 'typed in the real editor 🦉\nsecond line\n';
  assert.equal(await editor.edit((edit) => edit.replace(new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text)), true);
  assert.equal(document.isDirty, true);
  await api.flush();
  let inventory = await listSessionBuffers(config.worktree);
  const captured = inventory.buffers.find((buffer) => buffer.path === 'draft.txt' && buffer.version === document.version);
  assert.ok(captured, JSON.stringify(inventory));
  assert.equal(captured.dirty, true);
  assert.equal(await fs.readFile(file, 'utf8'), 'saved on disk\n');
  const destination = path.join(config.root, 'editor-recovered.json');
  assert.equal((await recoverSessionBuffer(config.worktree, captured.id, destination)).ok, true);
  assert.equal(JSON.parse(await fs.readFile(destination, 'utf8')).text, text);
  assert.equal(await document.save(), true);
  await api.flush();
  inventory = await listSessionBuffers(config.worktree);
  assert.equal(inventory.buffers.find((buffer) => buffer.path === 'draft.txt' && buffer.state === 'open').dirty, false);
  assert.equal(await fs.readFile(file, 'utf8'), text);
  await vscode.languages.setTextDocumentLanguage(document, 'javascript');
  await api.flush();
  assert.equal(api.status().every((item) => item.issue === null), true, JSON.stringify(api.status()));
  await fs.writeFile(config.proof, JSON.stringify({ passed: true, editorVersion: vscode.version,
    actualTyping: true, unsavedPrivateRecovery: true, actualSave: true, languageReopen: true, sessionIds: api.status().map((item) => item.sessionId) }, null, 2));
}
module.exports = { run };
