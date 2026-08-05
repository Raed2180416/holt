// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * Native structured-tool coverage through the real CLI hook entry point.
 *
 * Every protective assertion has an allow twin in the same repository. That is the anti-vacuity
 * condition: a hook that returns deny/ask for every Write, Edit, or patch would be safe-looking
 * and unusable.
 */

import { execFile } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newRepo } from '../fixtures.mjs';

const BIN = fileURLToPath(new URL('../../bin/holt.mjs', import.meta.url));

function driveHook(host, payload, cwd, launchCwd = cwd) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath,
      [BIN, 'hook', 'pre-tool-use', '--host', host, '--cwd', cwd],
      {
        cwd: launchCwd,
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, NO_COLOR: '1' },
      },
      (error, stdout, stderr) => resolve({
        code: typeof error?.code === 'number' ? error.code : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      }));
    child.stdin.end(JSON.stringify(payload));
  });
}

test('Codex apply_patch delete reaches fresh file evidence while Update File remains seamless',
  async (t) => {
    const fx = await newRepo('codex-native-hook');
    t.after(() => fx.cleanup());
    const only = await fx.write('only [draft].txt', 'the only copy of a long night of work\n');

    // Ground truth before trusting the hook: the target exists, is untracked, and Git has no copy.
    const status = await fx.git(['status', '--porcelain=v1', '--', 'only [draft].txt']);
    assert.match(status, /^\?\? /, `ANTI-VACUITY: target must really be untracked: ${status}`);

    const deletion = await driveHook('codex', {
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: {
        command: '*** Begin Patch\n*** Delete File: only [draft].txt\n*** End Patch\n',
      },
      cwd: fx.root,
    }, fx.root);
    assert.equal(deletion.code, 2, `${deletion.stdout}${deletion.stderr}`);
    const denied = JSON.parse(deletion.stdout);
    assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(denied.hookSpecificOutput.permissionDecisionReason, /only \[draft\]\.txt/,
      'the refusal must name the exact file, not a generic policy');
    assert.equal(await fs.readFile(only, 'utf8'), 'the only copy of a long night of work\n',
      'a PreToolUse check must not mutate the target itself');

    const update = await driveHook('codex', {
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: {
        command: '*** Begin Patch\n*** Update File: only [draft].txt\n'
          + '@@\n-the only copy of a long night of work\n+the revised copy\n*** End Patch\n',
      },
      cwd: fx.root,
    }, fx.root);
    assert.equal(update.code, 0, `${update.stdout}${update.stderr}`);
    assert.deepEqual(JSON.parse(update.stdout), {},
      'ordinary patch updates must preserve Codex native permission handling without a scan prompt');
  });

test('Claude Write and whole-file Edit ask with evidence; new writes and incremental Edit stay silent',
  async (t) => {
    const fx = await newRepo('claude-native-hook');
    t.after(() => fx.cleanup());
    const body = 'first irreplaceable line\nsecond irreplaceable line\n';
    const only = await fx.write('notes.md', body);

    const overwrite = await driveHook('claude-code', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: only, content: 'replacement\n' },
      cwd: fx.root,
    }, fx.root);
    assert.equal(overwrite.code, 2, `${overwrite.stdout}${overwrite.stderr}`);
    const writeDecision = JSON.parse(overwrite.stdout).hookSpecificOutput;
    assert.equal(writeDecision.permissionDecision, 'ask',
      'a normal full-file write should show evidence and let Claude request human approval, not blanket-deny');
    assert.match(writeDecision.permissionDecisionReason, /notes\.md/);
    assert.match(writeDecision.permissionDecisionReason, /No commit, index entry or stash/);

    const create = await driveHook('claude-code', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: path.join(fx.root, 'brand-new.md'), content: 'new\n' },
      cwd: fx.root,
    }, fx.root);
    assert.equal(create.code, 0, `${create.stdout}${create.stderr}`);
    assert.equal(create.stdout, '', 'creating a path with no prior bytes at risk must be silent');

    const incremental = await driveHook('claude-code', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: {
        file_path: only,
        old_string: 'second irreplaceable line',
        new_string: 'second carefully revised line',
        replace_all: false,
      },
      cwd: fx.root,
    }, fx.root);
    assert.equal(incremental.code, 0, `${incremental.stdout}${incremental.stderr}`);
    assert.equal(incremental.stdout, '',
      'an Edit that leaves untouched file content must not pay for or trip the destructive gate');

    const wholeFile = await driveHook('claude-code', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: 'notes.md', old_string: body, new_string: '', replace_all: false },
      cwd: fx.root,
    }, fx.root, path.dirname(fx.root));
    assert.equal(wholeFile.code, 2, `${wholeFile.stdout}${wholeFile.stderr}`);
    const editDecision = JSON.parse(wholeFile.stdout).hookSpecificOutput;
    assert.equal(editDecision.permissionDecision, 'ask');
    assert.match(editDecision.permissionDecisionReason, /full-file replacement|notes\.md/i);
    assert.equal(await fs.readFile(only, 'utf8'), body,
      'the hook measures current bytes but never performs the requested Edit');
  });

test('Qwen Code canonical shell/write/edit events reach evidence without widening to aliases',
  async (t) => {
    const fx = await newRepo('qwen-native-hook');
    t.after(() => fx.cleanup());
    const body = 'sole-copy Qwen draft\n';
    const only = await fx.write('qwen-draft.md', body);

    const shell = await driveHook('qwen-code', {
      hook_event_name: 'PreToolUse',
      tool_name: 'run_shell_command',
      tool_input: { command: `rm -f ${JSON.stringify(only)}` },
      cwd: fx.root,
    }, fx.root);
    assert.equal(shell.code, 2, `${shell.stdout}${shell.stderr}`);
    assert.equal(JSON.parse(shell.stdout).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(await fs.readFile(only, 'utf8'), body);

    const overwrite = await driveHook('qwen-code', {
      hook_event_name: 'PreToolUse',
      tool_name: 'write_file',
      tool_input: { file_path: only, content: 'replacement\n' },
      cwd: fx.root,
    }, fx.root);
    assert.equal(overwrite.code, 2, `${overwrite.stdout}${overwrite.stderr}`);
    const decision = JSON.parse(overwrite.stdout).hookSpecificOutput;
    assert.equal(decision.permissionDecision, 'ask');
    assert.match(decision.permissionDecisionReason, /qwen-draft\.md/);

    const incremental = await driveHook('qwen-code', {
      hook_event_name: 'PreToolUse',
      tool_name: 'edit',
      tool_input: {
        file_path: only, old_string: 'Qwen draft', new_string: 'careful Qwen draft',
      },
      cwd: fx.root,
    }, fx.root);
    assert.equal(incremental.code, 0, `${incremental.stdout}${incremental.stderr}`);
    assert.deepEqual(JSON.parse(incremental.stdout), {},
      'incremental edit must preserve Qwen native permission handling without a repository scan');

    const alias = await driveHook('qwen-code', {
      hook_event_name: 'PreToolUse',
      tool_name: 'WriteFile',
      tool_input: { file_path: only, content: 'replacement\n' },
      cwd: fx.root,
    }, fx.root);
    assert.equal(alias.code, 0, `${alias.stdout}${alias.stderr}`);
    assert.deepEqual(JSON.parse(alias.stdout), {},
      'an undocumented display alias must not inherit filesystem authority');
  });
