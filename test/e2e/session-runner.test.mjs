/** Real command trees, including a detached grandchild after its original parent exits. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { newRepo } from '../fixtures.mjs';
import { runWorkspaceCommand, sessionRunnerCapability } from '../../src/session-runner.mjs';
import { inspectWorktreeOwnership, ownershipTarget } from '../../src/ownership.mjs';
import { recoverCompletedRunners } from '../../src/session-recovery.mjs';
import { clean } from '../../src/actions.mjs';

const runFile = promisify(execFile);
const BIN = fileURLToPath(new URL('../../bin/holt.mjs', import.meta.url));

test('RUNNER: command success, command failure and launch failure all retire fully drained sessions', { skip: process.platform !== 'linux', timeout: 15000 }, async (t) => {
  const fx = await newRepo('runner-success');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('task');
  assert.equal((await sessionRunnerCapability()).available, true);
  for (const [argv, expected] of [
    [[process.execPath, '-e', 'process.exit(0)'], 0],
    [[process.execPath, '-e', 'process.exit(17)'], 17],
    [['holt-fixture-command-that-does-not-exist'], 127],
  ]) {
    const result = await runWorkspaceCommand(wt, argv, { stdio: 'ignore' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.exitCode, expected);
    assert.equal((await inspectWorktreeOwnership(wt)).state, 'unclaimed');
  }
  const cleaned = await clean(fx.root, { apply: true });
  assert.equal(cleaned.quarantined, 1, JSON.stringify(cleaned));
});

test('RUNNER: a detached grandchild keeps a clean-looking workspace attached after the command parent exits', { skip: process.platform !== 'linux', timeout: 15000 }, async (t) => {
  const fx = await newRepo('runner-detached');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('task');
  const release = path.join(fx.root, 'release-detached-fixture');
  const completed = path.join(wt, 'late-work.txt');
  const grandchild = `
    const fs = require('node:fs');
    let remaining = 1000;
    const timer = setInterval(() => {
      if (!remaining--) { clearInterval(timer); process.exitCode = 23; return; }
      if (fs.existsSync(${JSON.stringify(release)})) {
        fs.writeFileSync(${JSON.stringify(completed)}, 'work completed after the parent exited\\n');
        clearInterval(timer);
      }
    }, 10);
  `;
  const leader = `require('node:child_process').spawn(process.execPath,
    ['-e', ${JSON.stringify(grandchild)}], { detached: true, stdio: 'ignore' }).unref();`;
  let parentExited;
  const waitForParent = new Promise((resolve) => { parentExited = resolve; });
  const running = runWorkspaceCommand(wt, [process.execPath, '-e', leader], {
    stdio: 'ignore', onState: (state) => { if (state.phase === 'waiting-for-descendants') parentExited(); },
  });
  try {
    await waitForParent;
    const ownership = await inspectWorktreeOwnership(wt);
    assert.equal(ownership.state, 'active');
    assert.equal(ownership.sessions[0].pending[0].kind, 'command-tree');
    const premature = await clean(fx.root, { apply: true });
    assert.equal(premature.quarantined, 0, JSON.stringify(premature));
    await fs.writeFile(release, 'complete now\n');
    const result = await running;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.exitCode, 0);
    assert.equal(await fs.readFile(completed, 'utf8'), 'work completed after the parent exited\n');
    assert.equal((await inspectWorktreeOwnership(wt)).state, 'unclaimed');
    // Normal exact-content authority remains in charge of the newly produced file.
    assert.equal((await clean(fx.root, { apply: true })).quarantined, 0);
  } finally {
    await fs.writeFile(release, 'complete now\n');
    await running;
  }
});

test('RUNNER CLI: exact arguments and command output survive the automatic lifecycle', { skip: process.platform !== 'linux', timeout: 15000 }, async (t) => {
  const fx = await newRepo('runner-cli');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('task');
  const argument = 'spaces ; literal $(not-a-command) `also-literal`';
  const result = await runFile(process.execPath, [BIN, 'run', '--cwd', wt, '--json', '--', process.execPath,
    '-e', 'process.stdout.write(process.argv[1])', argument], { cwd: wt, timeout: 10000 });
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.exitCode, 0);
  assert.equal(result.stderr, argument);
  assert.equal((await inspectWorktreeOwnership(wt)).state, 'unclaimed');
});

test('RUNNER RECOVERY: a killed wrapper cannot retire a live descendant; its durable supervisor proof later recovers automatically', { skip: process.platform !== 'linux', timeout: 15000 }, async (t) => {
  const fx = await newRepo('runner-wrapper-crash');
  const wt = await fx.worktree('task');
  const release = path.join(fx.root, 'release');
  const ready = path.join(fx.root, 'ready');
  const program = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},'ready');
    const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){fs.writeFileSync('recovered.txt','late durable work');clearInterval(t)}},10);`;
  const child = spawn(process.execPath, [BIN, 'run', '--cwd', wt, '--', process.execPath, '-e', program], { stdio: 'ignore' });
  t.after(async () => { await fs.writeFile(release, 'release'); await fx.cleanup(); });
  const waitUntil = async (fn) => {
    for (let i = 0; i < 200; i++) { if (await fn()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
    assert.fail('fixture barrier did not complete');
  };
  await waitUntil(() => fs.stat(ready).then(() => true, () => false));
  const id = (await inspectWorktreeOwnership(wt)).sessions[0].id;
  child.kill('SIGKILL');
  await once(child, 'close');
  const pending = await recoverCompletedRunners(wt);
  assert.equal(pending.recovered.length, 0);
  assert.equal(pending.retained[0].code, 'command-tree-not-drained');
  assert.equal((await inspectWorktreeOwnership(wt)).sessions[0].id, id);
  assert.equal((await clean(fx.root, { apply: true })).quarantined, 0);
  await fs.writeFile(release, 'release');
  const target = await ownershipTarget(wt);
  await waitUntil(() => fs.readFile(path.join(target.root, 'runner-completions', `${id}.jsonl`), 'utf8').then((s) => s.includes('"drained"')));
  const next = await runWorkspaceCommand(wt, [process.execPath, '-e', 'process.exit(0)'], { stdio: 'ignore' });
  assert.equal(next.ok, true, JSON.stringify(next));
  assert.equal((await inspectWorktreeOwnership(wt)).state, 'unclaimed', 'the next normal command recovers the previous completed task');
  assert.equal(await fs.readFile(path.join(wt, 'recovered.txt'), 'utf8'), 'late durable work');
  assert.equal((await recoverCompletedRunners(wt)).recovered.length, 0, 'recovery is not repeatedly reported');
});
