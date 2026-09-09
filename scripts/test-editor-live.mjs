#!/usr/bin/env node
/** Exercise an installed editor through an isolated profile; never user's editor configuration. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { newRepo } from '../test/fixtures.mjs';
import { installEditorExtension } from '../src/integrate/editor-install.mjs';
import { inspectWorktreeOwnership } from '../src/ownership.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-editor-live-'));
const fixture = await newRepo('real-editor');
await fixture.write('draft.txt', 'saved on disk\n');
await fixture.commit('editor control');
const worktree = await fixture.worktree('editor-live');
const installation = await installEditorExtension({ directory: path.join(root, 'extensions') });
if (!installation.ok) throw new Error(JSON.stringify(installation));
const proof = path.join(root, 'proof.json');
const config = path.join(root, 'test-config.json');
await fs.writeFile(config, JSON.stringify({ root, packageRoot, worktree, proof }));
const executable = process.argv[2] ?? 'code';
const args = ['--new-window', '--wait', '--no-sandbox', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
  '--user-data-dir', path.join(root, 'profile'), '--extensions-dir', path.join(root, 'extensions'),
  '--extensionDevelopmentPath', installation.directory,
  '--extensionTestsPath', path.join(packageRoot, 'test/editor/live.cjs'), worktree];
const child = spawn(executable, args, { stdio: 'inherit', env: { ...process.env, HOLT_EDITOR_TEST_CONFIG: config } });
const timer = setTimeout(() => child.kill('SIGTERM'), 90000);
let code;
try { [code] = await once(child, 'close'); } finally { clearTimeout(timer); }
let result;
try { result = JSON.parse(await fs.readFile(proof, 'utf8')); } catch { result = { passed: false }; }
const ownership = await inspectWorktreeOwnership(worktree);
result = { ...result, code, workspaceRetired: ownership.state === 'unclaimed', retainedEvidence: root, fixture: fixture.root };
await fs.writeFile(path.join(root, 'wrapper-proof.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
process.exitCode = code === 0 && result.passed && result.workspaceRetired ? 0 : 1;
// Keep this bounded proof fixture for inspection; deletion is not part of a live host test.
