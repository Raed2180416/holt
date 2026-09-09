// SPDX-License-Identifier: FSL-1.1-MIT
/** Local/remote workspace extension. Content goes only to the local private Holt bridge. */
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { pathToFileURL } = require('node:url');

let manager;
let relativeWithinAsync;
class EditorBridge {
  constructor(folder, launcher, changed) {
    this.folder = folder;
    this.pending = new Map();
    this.buffers = new Map();
    this.waiters = new Map();
    this.queue = Promise.resolve();
    this.counter = 0;
    this.issue = null;
    this.ending = false;
    this.changed = changed;
    this.child = spawn(launcher.node, [launcher.holt, 'session', 'bridge', '--cwd', folder.uri.fsPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.ready = new Promise((resolve, reject) => { this.attached = resolve; this.failed = reject; });
    this.ready.catch(() => {});
    this.child.on('error', (error) => this.fail(error));
    this.child.on('close', () => { if (!this.ending) this.fail(new Error('The editor bridge disconnected; captures already acknowledged remain recoverable.')); });
    this.child.stdin.on('error', (error) => this.fail(error));
    this.child.stderr.on('data', () => {}); // no unbounded child log or accidental content disclosure
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', (line) => {
      try {
        const result = JSON.parse(line);
        if (result.type === 'ready' && result.protocol === 1) { this.sessionId = result.sessionId; this.pathPrefix = result.pathPrefix ?? ''; this.attached(); this.changed(); return; }
        const waiter = this.waiters.get(result.id);
        if (!waiter) throw new Error('Unexpected editor bridge acknowledgement.');
        this.waiters.delete(result.id);
        if (!result.ok) waiter.reject(new Error(result.code));
        else waiter.resolve(result);
      } catch (error) { this.fail(error); }
    });
  }
  fail(error) {
    if (!this.issue) this.issue = error.message;
    this.failed(error);
    for (const waiter of this.waiters.values()) waiter.reject(error);
    this.waiters.clear();
    this.changed();
  }
  request(event) {
    const operation = this.queue.then(async () => {
      await this.ready;
      if (this.issue) throw new Error(this.issue);
      if (typeof event === 'function') event = await event();
      const id = ++this.counter;
      return new Promise((resolve, reject) => {
        this.waiters.set(id, { resolve, reject });
        this.child.stdin.write(JSON.stringify({ id, ...event }) + '\n', (error) => { if (error) this.fail(error); });
      });
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }
  snapshot(document) {
    if (document.uri.scheme !== 'file' || document.isClosed) return;
    if (vscode.workspace.getWorkspaceFolder(document.uri)?.uri.toString() !== this.folder.uri.toString()) return;
    const resource = document.uri.toString();
    // Capture synchronously in the editor callback, before awaiting I/O or the next edit.
    this.pending.set(resource, { resource, filePath: document.uri.fsPath, text: document.getText(), version: document.version,
      dirty: document.isDirty, encoding: document.encoding ?? null });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush().catch((error) => this.fail(error)), 150);
  }
  flush() {
    clearTimeout(this.timer);
    const pending = [...this.pending.values()];
    this.pending.clear();
    // Enqueue the entire batch synchronously. A language-change close/open pair must preserve
    // its event order even while the previous capture waits for disk acknowledgements.
    const requests = pending.map((buffer) => this.request(async () => {
      const relative = await relativeWithinAsync(this.folder.uri.fsPath, buffer.filePath);
      if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('Editor resource is outside its canonical workspace.');
      buffer.path = `${this.pathPrefix}${relative}`;
      return { type: 'buffer', buffer: { path: buffer.path, text: buffer.text, version: buffer.version, dirty: buffer.dirty, encoding: buffer.encoding } };
    })
      .then(() => {
        this.buffers.set(buffer.resource, { path: buffer.path, version: buffer.version, dirty: buffer.dirty });
      }, (error) => {
        // A failed capture stays pending for this host. Never claim a later version was saved.
        if (!this.pending.has(buffer.resource)) this.pending.set(buffer.resource, buffer);
        throw error;
      }));
    return Promise.all([...requests, this.queue]).then(() => this.changed());
  }
  close(document) {
    const resource = document.uri.toString();
    const captured = this.pending.get(resource) ?? this.buffers.get(resource);
    const flushed = this.flush();
    if (!captured) return flushed;
    const closed = this.request(() => ({ type: 'buffer-close', path: captured.path, version: captured.version }));
    return Promise.all([flushed, closed]).then(() => { this.buffers.delete(resource); this.changed(); });
  }
  async finish() {
    await this.flush();
    for (const buffer of this.buffers.values()) await this.request({ type: 'buffer-close', path: buffer.path, version: buffer.version });
    this.buffers.clear();
    this.ending = true;
    await this.request({ type: 'finish' });
    this.child.stdin.end();
  }
}

async function activate(context) {
  ({ relativeWithinAsync } = await import(pathToFileURL(path.join(__dirname, 'paths.mjs')).href));
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 15);
  status.name = 'Holt workspace recovery';
  status.command = 'holt.sessions.showStatus';
  context.subscriptions.push(status);
  const bridges = new Map();
  let stopping = false;
  const update = () => {
    const issue = [...bridges.values()].find((bridge) => bridge.issue)?.issue;
    const versions = [...bridges.values()].reduce((total, bridge) => total + bridge.buffers.size, 0);
    status.text = issue ? '$(warning) Holt: recovery needs attention' : `$(shield) Holt${versions ? ` · ${versions} buffers` : ''}`;
    status.tooltip = issue ?? 'Open workspace protected; editor text is captured privately on this machine.';
    if (bridges.size) status.show(); else status.hide();
  };
  let launcher;
  try {
    launcher = JSON.parse(fs.readFileSync(path.join(__dirname, 'launcher.json'), 'utf8'));
    if (launcher.version !== 1 || !path.isAbsolute(launcher.node) || !path.isAbsolute(launcher.holt)) throw new Error('Invalid Holt launcher.');
  } catch {
    status.text = '$(warning) Holt: connect installation';
    status.tooltip = 'Run holt editor install on this machine to connect the installed Holt runtime.';
    status.show();
    return { connected: false };
  }
  const add = (folder) => {
    if (folder.uri.scheme !== 'file' || bridges.has(folder.uri.toString())) return;
    const bridge = new EditorBridge(folder, launcher, update);
    bridges.set(folder.uri.toString(), bridge);
    for (const document of vscode.workspace.textDocuments) bridge.snapshot(document);
    update();
  };
  const bridgeFor = (document) => {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    return folder && bridges.get(folder.uri.toString());
  };
  const snapshot = (document) => { if (!stopping) bridgeFor(document)?.snapshot(document); };
  // Subscribe first, then take the initial snapshot; an edit during activation is not missed.
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(snapshot),
    vscode.workspace.onDidChangeTextDocument((event) => snapshot(event.document)),
    vscode.workspace.onDidSaveTextDocument((document) => { snapshot(document); bridgeFor(document)?.flush().catch((error) => bridgeFor(document)?.fail(error)); }),
    vscode.workspace.onDidCloseTextDocument((document) => { if (!stopping) bridgeFor(document)?.close(document).catch((error) => bridgeFor(document)?.fail(error)); }),
    vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      for (const folder of event.added) add(folder);
      for (const folder of event.removed) {
        const bridge = bridges.get(folder.uri.toString());
        if (bridge) bridge.finish().then(() => { bridges.delete(folder.uri.toString()); update(); }, (error) => bridge.fail(error));
      }
    }),
    vscode.commands.registerCommand('holt.sessions.showStatus', () => {
      const issues = [...bridges.values()].filter((bridge) => bridge.issue).map((bridge) => bridge.issue);
      return vscode.window.showInformationMessage(issues.join('\n') || 'Holt keeps private copies of acknowledged editor versions. Use holt session buffers to recover them.');
    }),
  );
  for (const folder of vscode.workspace.workspaceFolders ?? []) add(folder);
  const flush = async () => { await Promise.all([...bridges.values()].map((bridge) => bridge.flush())); };
  manager = {
    finish: async () => {
      stopping = true;
      // Capture each last observable buffer before retiring this extension's attachment.
      for (const document of vscode.workspace.textDocuments) bridgeFor(document)?.snapshot(document);
      await Promise.all([...bridges.values()].map((bridge) => bridge.finish()));
    },
  };
  await Promise.allSettled([...bridges.values()].map((bridge) => bridge.ready));
  await flush();
  return { connected: true, flush, status: () => [...bridges.values()].map((bridge) => ({ sessionId: bridge.sessionId, issue: bridge.issue,
    buffers: [...bridge.buffers.values()] })) };
}

async function deactivate() { await manager?.finish(); }
module.exports = { activate, deactivate };
