// SPDX-License-Identifier: FSL-1.1-MIT

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  codexApplyPatchOperations,
  documentedNativeTool,
} from '../../src/integrate/native-tools.mjs';

test('Codex apply_patch parser identifies exact deletes without treating normal edits as deletes', () => {
  const destructive = codexApplyPatchOperations(
    '*** Begin Patch\n'
    + '*** Update File: src/live.js\n@@\n-old\n+new\n'
    + '*** Add File: src/new.js\n+new\n'
    + '*** Delete File: notes [only].md\n'
    + '*** End Patch\n',
  );
  assert.equal(destructive.issue, null);
  assert.deepEqual(destructive.operations.map(({ role, path }) => ({ role, path })), [
    { role: 'delete', path: 'notes [only].md' },
  ], 'ANTI-VACUITY: the real Delete File header must survive beside benign operations');

  const ordinary = codexApplyPatchOperations(
    '*** Begin Patch\n*** Update File: src/live.js\n@@\n-old\n+new\n'
    + '*** Add File: src/new.js\n+new\n*** End Patch\n',
  );
  assert.equal(ordinary.issue, null);
  assert.deepEqual(ordinary.operations, [],
    'Update File and Add File are not full-file deletion authority');
});

test('Codex apply_patch parser keeps rename source and overwrite destination distinct', () => {
  const parsed = codexApplyPatchOperations(
    '*** Begin Patch\n*** Update File: src/old.js\n*** Move to: src/new.js\n'
    + '@@\n-old\n+new\n*** End Patch\n',
  );
  assert.equal(parsed.issue, null);
  assert.deepEqual(parsed.operations.map(({ role, path, dest, promptOnRisk }) => (
    { role, path, dest, promptOnRisk }
  )), [
    { role: 'move-src', path: 'src/old.js', dest: 'src/new.js', promptOnRisk: undefined },
    { role: 'overwrite', path: 'src/new.js', dest: undefined, promptOnRisk: true },
  ]);
});

test('Codex apply_patch destructive near-misses are uncertainty, never a silent safe result', () => {
  const incomplete = codexApplyPatchOperations('*** Delete File: only.txt\n');
  assert.match(incomplete.issue, /complete Begin Patch \/ End Patch envelope/);
  assert.deepEqual(incomplete.operations, []);

  const malformed = codexApplyPatchOperations(
    '*** Begin Patch\n*** Delete File:\n*** End Patch\n',
  );
  assert.match(malformed.issue, /could not map|exact one-line path/);
  assert.deepEqual(malformed.operations, []);

  const mixed = codexApplyPatchOperations(
    '*** Begin Patch\n*** Delete File: exact.txt\n*** Delete File:\n*** End Patch\n',
  );
  assert.match(mixed.issue, /could not map/,
    'one exact target must not hide another destructive header whose target is unknown');
  assert.deepEqual(mixed.operations, [], 'a partial target list is not safe authority');
});

test('Claude native file contracts distinguish full writes from ordinary Edit', () => {
  const write = documentedNativeTool({
    host: 'claude-code',
    toolName: 'Write',
    toolInput: { file_path: '/repo/only.txt', content: 'replacement' },
  });
  assert.equal(write.handled, true);
  assert.deepEqual(write.operations.map(({ role, path, promptOnRisk }) => (
    { role, path, promptOnRisk }
  )), [{ role: 'overwrite', path: '/repo/only.txt', promptOnRisk: true }]);

  const incremental = documentedNativeTool({
    host: 'claude-code',
    toolName: 'Edit',
    toolInput: { file_path: '/repo/only.txt', old_string: 'one line', new_string: 'new line' },
    editWholeFile: false,
  });
  assert.equal(incremental.handled, true);
  assert.deepEqual(incremental.operations, [], 'ordinary incremental edits must stay out of the gate');

  const whole = documentedNativeTool({
    host: 'claude-code',
    toolName: 'Edit',
    toolInput: { file_path: '/repo/only.txt', old_string: 'whole file', new_string: '' },
    editWholeFile: true,
  });
  assert.equal(whole.operations[0].role, 'overwrite');
  assert.equal(whole.operations[0].promptOnRisk, true);
});

test('Qwen Code uses its documented write_file/edit contracts without guessing aliases', () => {
  const write = documentedNativeTool({
    host: 'qwen-code', toolName: 'write_file',
    toolInput: { file_path: '/repo/only.txt', content: 'replacement' },
  });
  assert.equal(write.handled, true);
  assert.equal(write.operations[0].role, 'overwrite');
  assert.match(write.operations[0].kind, /Qwen write_file/);

  const incremental = documentedNativeTool({
    host: 'qwen-code', toolName: 'edit',
    toolInput: { file_path: '/repo/only.txt', old_string: 'one line', new_string: 'new line' },
    editWholeFile: false,
  });
  assert.equal(incremental.handled, true);
  assert.deepEqual(incremental.operations, []);

  const displayAlias = documentedNativeTool({
    host: 'qwen-code', toolName: 'WriteFile',
    toolInput: { file_path: '/repo/only.txt', content: 'replacement' },
  });
  assert.equal(displayAlias.handled, false,
    'only the canonical runtime ID from current Qwen source may carry filesystem authority');
});

test('arbitrary local-function and MCP inputs are not reinterpreted as filesystem contracts', () => {
  for (const event of [
    { host: 'codex', toolName: 'delete_file', toolInput: { path: '/repo/only.txt' } },
    { host: 'codex', toolName: 'mcp__filesystem__delete_file', toolInput: { path: '/repo/only.txt' } },
    { host: 'claude-code', toolName: 'mcp__anything__Write', toolInput: { file_path: '/repo/only.txt' } },
  ]) {
    const parsed = documentedNativeTool(event);
    assert.equal(parsed.handled, false,
      `${event.toolName}: a familiar field name must not become guessed destructive authority`);
    assert.deepEqual(parsed.operations, []);
  }
});
