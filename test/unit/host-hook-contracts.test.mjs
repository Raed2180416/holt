// SPDX-License-Identifier: FSL-1.1-MIT

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  cascadeHooks,
  claudeCodeHooks,
  clineHookScript,
  codexHooks,
  copilotHooks,
  cursorHooks,
  devinCliHooks,
  formatVerdict,
  goosePlugin,
  installCascadeHooks,
  installClineHooks,
  installCodexHooks,
  installCopilotHooks,
  installDevinCliHooks,
  installGooseHooks,
  installQwenCodeHooks,
  qwenCodeHooks,
  formatContext,
  uninstall,
} from '../../src/integrate/adapters.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = path.join(ROOT, 'bin', 'holt.mjs');

test('current host hook schemas use each product\'s documented project contract', () => {
  const claude = claudeCodeHooks('holt');
  assert.ok(Array.isArray(claude.SessionStart));
  assert.ok(Array.isArray(claude.UserPromptSubmit));
  assert.ok(!('Stop' in claude),
    'Claude Stop additionalContext continues the conversation; do not force that continuation');

  const cursor = cursorHooks('holt');
  assert.equal(cursor.version, 1);
  assert.match(cursor.hooks.stop[0].command, /hook stop --host cursor$/);

  const codex = codexHooks('holt');
  assert.equal(codex.hooks.PreToolUse[0].matcher, 'Bash|apply_patch');
  assert.match(codex.hooks.PreToolUse[0].hooks[0].command, /--host codex$/);
  assert.equal(codex.hooks.SessionStart[0].matcher, 'startup|resume|clear|compact');
  assert.match(codex.hooks.SessionStart[0].hooks[0].command,
    /hook session-start --autoprotect --host codex$/);
  assert.ok(Number.isInteger(codex.hooks.SessionStart[0].hooks[0].additionalContextLimit)
    && codex.hooks.SessionStart[0].hooks[0].additionalContextLimit > 0,
  'Codex context hooks need a positive spill threshold, never an unbounded zero');
  assert.ok(!('matcher' in codex.hooks.UserPromptSubmit[0]),
    'Codex currently ignores UserPromptSubmit matchers; the generated contract must omit one');
  assert.match(codex.hooks.UserPromptSubmit[0].hooks[0].command,
    /hook user-prompt-submit --host codex$/);
  assert.ok(codex.hooks.UserPromptSubmit[0].hooks[0].additionalContextLimit > 0);
  assert.ok(!('Stop' in codex.hooks), 'do not invent an unsupported Codex continuation shape');

  const qwen = qwenCodeHooks('holt');
  assert.equal(qwen.hooks.PreToolUse[0].matcher, '^(run_shell_command|write_file|edit)$');
  assert.match(qwen.hooks.PreToolUse[0].hooks[0].command, /--host qwen-code$/);
  assert.match(qwen.hooks.SessionStart[0].hooks[0].command,
    /hook session-start --autoprotect --host qwen-code$/);
  assert.match(qwen.hooks.UserPromptSubmit[0].hooks[0].command,
    /hook user-prompt-submit --host qwen-code$/);
  assert.ok(!('Stop' in qwen.hooks), 'Qwen context uses lifecycle events, not a continuation loop');

  assert.equal(claude.PreToolUse[0].matcher, 'Bash|Write|Edit',
    'Claude exact Write/Edit payloads must reach the same evidence gate as Bash');

  const copilot = copilotHooks('holt');
  assert.equal(copilot.version, 1);
  assert.equal(copilot.hooks.PreToolUse[0].type, 'command');
  assert.equal(copilot.hooks.PreToolUse[0].matcher, 'Bash');
  assert.match(copilot.hooks.PreToolUse[0].bash, /command -v holt/,
    'the shared cloud file must fail open when the ephemeral image does not contain holt');
  assert.match(copilot.hooks.PreToolUse[0].powershell, /Get-Command holt/);

  const devin = devinCliHooks('holt');
  assert.ok(!('hooks' in devin), '.devin/hooks.v1.json is the bare event map');
  assert.equal(devin.PreToolUse[0].matcher, 'exec');
  assert.match(devin.PreToolUse[0].hooks[0].command, /--host devin-cli$/);

  const cascade = cascadeHooks('holt');
  assert.match(cascade.hooks.pre_run_command[0].command, /--host cascade$/);
  assert.equal(cascade.hooks.pre_run_command[0].show_output, true);

  const goose = goosePlugin('holt');
  assert.equal(goose.manifest.name, 'holt');
  assert.equal(goose.hooks.hooks.PreToolUse[0].matcher, '^developer__shell$');
  assert.match(goose.hooks.hooks.PreToolUse[0].hooks[0].command, /--host goose$/);

  const cline = clineHookScript('holt');
  assert.match(cline, /^#!\/bin\/sh/);
  assert.match(cline, /--host cline/);
});

test('host verdict dialects block in the fields the current hosts consume', () => {
  const verdict = { decision: 'deny', reason: 'holt: destructive command' };
  assert.deepEqual(formatVerdict(verdict, { host: 'copilot' }), {
    permissionDecision: 'deny', permissionDecisionReason: verdict.reason,
  });
  assert.equal(formatVerdict(verdict, { host: 'codex' }).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(formatVerdict(verdict, { host: 'qwen-code' }).hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(formatVerdict(verdict, { host: 'goose' }), { decision: 'block', reason: verdict.reason });
  assert.deepEqual(formatVerdict(verdict, { host: 'devin-cli' }), { decision: 'block', reason: verdict.reason });
  assert.equal(formatVerdict(verdict, { host: 'cline' }).cancel, true);
  assert.deepEqual(formatVerdict(verdict, { host: 'cascade' }), {},
    'Cascade blocks on exit 2/stderr; it has no decision JSON schema to invent');
  assert.deepEqual(formatVerdict({ decision: 'allow' }, { host: 'copilot' }), {},
    'holt allow must fall through to normal Copilot permission handling, not grant permission');

  const start = formatContext('sibling context', { host: 'codex', eventName: 'SessionStart' });
  assert.deepEqual(start, {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: 'sibling context',
    },
  });
  const prompt = formatContext('changed sibling context', {
    host: 'codex', eventName: 'UserPromptSubmit',
  });
  assert.equal(prompt.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.equal(prompt.hookSpecificOutput.additionalContext, 'changed sibling context');
  assert.deepEqual(formatContext(null, { host: 'codex' }), {},
    'silence must be real silence, not additionalContext:"null" or a foreign context field');
  assert.deepEqual(formatContext('changed sibling context', { host: 'cursor', eventName: 'Stop' }), {
    followup_message: 'changed sibling context',
  }, 'Cursor Stop continues through its documented followup_message field');
  assert.deepEqual(formatContext('sibling context', { host: 'claude-code', eventName: 'Stop' }), {},
    'a stale/manual Claude Stop invocation must not emit continuation feedback as passive context');
  const qwenPrompt = formatContext('changed sibling context', {
    host: 'qwen-code', eventName: 'UserPromptSubmit',
  });
  assert.equal(qwenPrompt.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.equal(qwenPrompt.hookSpecificOutput.additionalContext, 'changed sibling context');
});

test('project installers write loadable files and preserve a foreign Codex hook', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-host-hooks-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, '.codex'), { recursive: true });
  await fs.writeFile(path.join(dir, '.codex', 'hooks.json'), `${JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'acme-policy check' }] }] },
  }, null, 2)}\n`);

  await installCodexHooks(dir, { bin: 'holt' });
  await installQwenCodeHooks(dir, { bin: 'holt' });
  await installCopilotHooks(dir, { bin: 'holt' });
  await installDevinCliHooks(dir, { bin: 'holt' });
  await installCascadeHooks(dir, { bin: 'holt' });
  await installGooseHooks(dir, { bin: 'holt' });
  await installClineHooks(dir, { bin: 'holt' });

  const json = async (...segments) => JSON.parse(await fs.readFile(path.join(dir, ...segments), 'utf8'));
  const codex = await json('.codex', 'hooks.json');
  assert.ok(codex.hooks.PreToolUse.some((entry) => entry.hooks?.some((hook) => hook.command === 'acme-policy check')),
    'installing holt must preserve the repository\'s existing policy hook');
  assert.ok(codex.hooks.PreToolUse.some((entry) => entry.hooks?.some((hook) => /--host codex$/.test(hook.command))));
  assert.ok(Array.isArray(codex.hooks.SessionStart));
  assert.ok(Array.isArray(codex.hooks.UserPromptSubmit));
  const qwen = await json('.qwen', 'settings.json');
  assert.ok(Array.isArray(qwen.hooks.PreToolUse));
  assert.ok(Array.isArray(qwen.hooks.SessionStart));
  assert.ok(Array.isArray(qwen.hooks.UserPromptSubmit));
  assert.equal((await json('.github', 'hooks', 'holt.json')).version, 1);
  assert.ok(Array.isArray((await json('.devin', 'hooks.v1.json')).PreToolUse));
  assert.ok(Array.isArray((await json('.windsurf', 'hooks.json')).hooks.pre_run_command));
  assert.equal((await json('.agents', 'plugins', 'holt', 'plugin.json')).name, 'holt');

  const clineFile = path.join(dir, '.clinerules', 'hooks', 'PreToolUse');
  assert.ok((await fs.stat(clineFile)).mode & 0o100, 'Cline discovers only executable POSIX hooks');
});

test('Codex upgrades reconcile all three lifecycle subcommands without duplicating or taking user hooks',
  async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-codex-hook-upgrade-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, '.codex', 'hooks.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify({
      hooks: {
        PreToolUse: [{
          matcher: 'Bash',
          hooks: [{ type: 'command', command: 'node /old/holt.mjs hook pre-tool-use --host codex' }],
        }],
        SessionStart: [{
          matcher: 'startup|resume',
          hooks: [
            { type: 'command', command: 'node /old/holt.mjs hook session-start --host codex' },
            { type: 'command', command: 'acme-session-note' },
          ],
        }],
        UserPromptSubmit: [{
          matcher: 'ignored-by-codex',
          hooks: [
            { type: 'command', command: 'node /old/holt.mjs hook user-prompt-submit --host codex' },
            { type: 'command', command: 'acme-prompt-audit' },
          ],
        }],
      },
    }, null, 2)}\n`);

    await installCodexHooks(dir, { bin: 'holt' });
    await installCodexHooks(dir, { bin: 'holt' });
    const cfg = JSON.parse(await fs.readFile(file, 'utf8'));
    const commands = (event) => cfg.hooks[event]
      .flatMap((entry) => entry.hooks ?? []).map((hook) => hook.command);

    assert.equal(commands('PreToolUse').filter((c) => c === 'holt hook pre-tool-use --host codex').length, 1);
    assert.equal(commands('SessionStart')
      .filter((c) => c === 'holt hook session-start --autoprotect --host codex').length, 1);
    assert.equal(commands('UserPromptSubmit')
      .filter((c) => c === 'holt hook user-prompt-submit --host codex').length, 1);
    assert.ok(commands('SessionStart').includes('acme-session-note'));
    assert.ok(commands('UserPromptSubmit').includes('acme-prompt-audit'));

    const canonicalStart = cfg.hooks.SessionStart.find((entry) => entry.hooks?.some(
      (hook) => hook.command === 'holt hook session-start --autoprotect --host codex',
    ));
    const canonicalPrompt = cfg.hooks.UserPromptSubmit.find((entry) => entry.hooks?.some(
      (hook) => hook.command === 'holt hook user-prompt-submit --host codex',
    ));
    assert.equal(canonicalStart.matcher, 'startup|resume|clear|compact');
    assert.ok(canonicalStart.hooks[0].additionalContextLimit > 0);
    assert.ok(!('matcher' in canonicalPrompt));
    assert.ok(canonicalPrompt.hooks[0].additionalContextLimit > 0);
  });

test('shared hook upgrades and uninstall preserve sibling user commands', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-host-hook-ownership-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, '.codex'), { recursive: true });
  await fs.mkdir(path.join(dir, '.windsurf'), { recursive: true });
  await fs.writeFile(path.join(dir, '.codex', 'hooks.json'), `${JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [
      { type: 'command', command: 'node /old/holt.mjs hook pre-tool-use --host codex' },
      { type: 'command', command: 'acme-policy check' },
    ] }] },
  }, null, 2)}\n`);
  await fs.writeFile(path.join(dir, '.windsurf', 'hooks.json'), `${JSON.stringify({
    hooks: { pre_run_command: [{
      command: 'holt hook pre-tool-use --host cascade',
      powershell: 'acme-policy check-windows',
      show_output: true,
    }] },
  }, null, 2)}\n`);

  await installCodexHooks(dir, { bin: 'holt' });
  await installCascadeHooks(dir, { bin: 'holt' });
  let codex = JSON.parse(await fs.readFile(path.join(dir, '.codex', 'hooks.json'), 'utf8'));
  let cascade = JSON.parse(await fs.readFile(path.join(dir, '.windsurf', 'hooks.json'), 'utf8'));
  assert.ok(codex.hooks.PreToolUse.some((entry) => entry.hooks?.some((hook) => hook.command === 'acme-policy check')));
  assert.equal(cascade.hooks.pre_run_command[0].powershell, 'acme-policy check-windows');
  assert.ok(cascade.hooks.pre_run_command.some((entry) => /--host cascade$/.test(entry.command ?? '')
    && /--host cascade$/.test(entry.powershell ?? '')),
  'a POSIX Holt command sharing an entry with a foreign PowerShell command does not cover Windows; append a complete canonical entry');

  await uninstall(dir);
  codex = JSON.parse(await fs.readFile(path.join(dir, '.codex', 'hooks.json'), 'utf8'));
  cascade = JSON.parse(await fs.readFile(path.join(dir, '.windsurf', 'hooks.json'), 'utf8'));
  assert.deepEqual(codex.hooks.PreToolUse[0].hooks.map((hook) => hook.command), ['acme-policy check']);
  assert.equal(cascade.hooks.pre_run_command[0].powershell, 'acme-policy check-windows');
  assert.ok(!('command' in cascade.hooks.pre_run_command[0]), 'uninstall removes only holt\'s command field');
});

test('shared hook upgrades repair the full matcher/action contract, not command text alone', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-host-hook-shape-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.codex', 'hooks.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify({
    hooks: {
      PreToolUse: [{
        matcher: 'Write',
        hooks: [
          { type: 'command', command: 'holt hook pre-tool-use --host codex', timeout: 120 },
          { type: 'command', command: 'acme-policy check-write' },
        ],
      }],
    },
  }, null, 2)}\n`);

  await installCodexHooks(dir, { bin: 'holt' });
  const cfg = JSON.parse(await fs.readFile(file, 'utf8'));
  const entries = cfg.hooks.PreToolUse;
  assert.ok(entries.some((entry) => entry.matcher === 'Bash|apply_patch'
    && entry.hooks?.some((hook) => hook.command === 'holt hook pre-tool-use --host codex')),
  'the canonical Bash + apply_patch matcher must be installed even when the same command text existed elsewhere');
  assert.ok(entries.some((entry) => entry.matcher === 'Write'
    && entry.hooks?.some((hook) => hook.command === 'acme-policy check-write')),
  'repair must preserve the user command and its matcher');
  assert.ok(!entries.some((entry) => entry.matcher === 'Write'
    && entry.hooks?.some((hook) => /--host codex$/.test(hook.command ?? ''))),
  'the ineffective Holt action must be removed from the wrong matcher');
});

test('hook installers never replace a valid JSON value that is not a config object', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-host-hook-invalid-shape-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.codex', 'hooks.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'null\n');
  const result = await installCodexHooks(dir, { bin: 'holt' });
  assert.match(result.action, /not a JSON object/);
  assert.equal(await fs.readFile(file, 'utf8'), 'null\n');
});

function driveHook(host, payload, cwd) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath,
      [BIN, 'hook', 'pre-tool-use', '--host', host, '--cwd', cwd],
      { cwd, timeout: 120_000, env: { ...process.env, NO_COLOR: '1' } },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout: String(stdout), stderr: String(stderr) }));
    child.stdin.end(JSON.stringify(payload));
  });
}

test('current payload envelopes reach a refusal instead of the missing-command allow path', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-hook-payload-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const destructive = ['rm', '-rf', '/'].join(' ');
  const cases = [
    ['codex', { tool_name: 'Bash', tool_input: { command: destructive }, cwd: dir }],
    ['copilot', { tool_name: 'Bash', tool_input: { command: destructive }, cwd: dir }],
    ['goose', { tool_name: 'developer__shell', tool_input: { command: destructive }, working_dir: dir }],
    ['devin-cli', { tool_name: 'exec', tool_input: { command: destructive }, cwd: dir }],
    ['cascade', { agent_action_name: 'pre_run_command', tool_info: { command_line: destructive, cwd: dir } }],
    ['cline', { preToolUse: { toolName: 'execute_command', parameters: { command: destructive } }, workspaceRoots: [dir] }],
  ];

  for (const [host, payload] of cases) {
    const result = await driveHook(host, payload, dir);
    if (host === 'cline') {
      assert.equal(result.code, 0, `Cline consumes cancel:true only from a successful hook: ${result.stderr}`);
      assert.equal(JSON.parse(result.stdout).cancel, true);
    } else {
      assert.equal(result.code, 2, `${host} must refuse via its documented exit channel: ${result.stdout}\n${result.stderr}`);
    }
    if (host === 'cascade') assert.deepEqual(JSON.parse(result.stdout), {});
  }
});

test('a recognised shell hook with a missing command fails closed while non-shell tools stay silent', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-hook-missing-command-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const codex = await driveHook('codex', { tool_name: 'Bash', tool_input: {}, cwd: dir }, dir);
  assert.equal(codex.code, 2, `a schema-drifted shell payload cannot become an allow: ${codex.stdout}`);
  assert.match(codex.stderr, /no command field|could not be verified/i);

  const cline = await driveHook('cline', {
    preToolUse: { toolName: 'execute_command', parameters: {} }, workspaceRoots: [dir],
  }, dir);
  assert.equal(cline.code, 0, 'Cline expresses denial in a successful hook response');
  assert.equal(JSON.parse(cline.stdout).cancel, true);

  const read = await driveHook('codex', { tool_name: 'Read', tool_input: {}, cwd: dir }, dir);
  assert.equal(read.code, 0, `non-shell tools need no command field: ${read.stderr}`);
  assert.deepEqual(JSON.parse(read.stdout), {});
});
