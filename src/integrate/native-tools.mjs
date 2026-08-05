// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * Documented structured-tool operations that Holt can interpret without guessing a host or MCP
 * server's private schema.
 *
 * This module is intentionally pure. It recognizes only:
 *   - Codex's canonical `apply_patch` hook input (`tool_input.command`) and the open-source patch
 *     grammar's Delete File / Update File + Move to operations; and
 *   - Claude Code's documented Write and Edit input objects; and
 *   - Qwen Code's documented write_file and edit input objects.
 *
 * MCP and arbitrary local-function arguments are tool-specific in both hosts' hook contracts.
 * A field called `path` is not proof that a server removes a local repository path, so those calls
 * stay outside this parser until their exact tool contract is wired explicitly.
 */

/** @typedef {{path:string, role:'delete'|'overwrite'|'move-src', kind:string,
 *   promptOnRisk?:boolean, dest?:string}} ExplicitFileOperation */

/** A path supplied by a documented file tool: non-empty, one line, and no NUL. */
function documentedPath(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0')
    && !value.includes('\n') && !value.includes('\r');
}

/**
 * Parse Codex's open-source `*** Begin Patch` grammar just far enough to identify operations that
 * remove a path or can overwrite a rename destination. Add File and ordinary Update File hunks
 * are intentionally absent from the result: they are creation and incremental editing, not a
 * reason to put Holt's expensive repository scan in every edit's critical path.
 *
 * @param {unknown} command
 * @returns {{operations:ExplicitFileOperation[], issue:string|null}}
 */
export function codexApplyPatchOperations(command) {
  if (typeof command !== 'string') {
    return { operations: [], issue: 'Codex apply_patch did not provide its documented string command field.' };
  }

  const lines = command.split(/\r?\n/);
  const hasBegin = lines.includes('*** Begin Patch');
  const hasEnd = lines.includes('*** End Patch');
  /** @type {ExplicitFileOperation[]} */
  const operations = [];
  /** @type {string|null} */
  let currentUpdate = null;
  let destructiveHeaderSeen = false;
  let unmappedDestructiveHeader = false;

  for (const line of lines) {
    if (line.startsWith('*** Delete File: ')) {
      destructiveHeaderSeen = true;
      currentUpdate = null;
      const file = line.slice('*** Delete File: '.length);
      if (!documentedPath(file)) {
        return { operations: [], issue: 'Codex apply_patch named a Delete File operation without an exact one-line path.' };
      }
      operations.push({
        path: file,
        role: 'delete',
        kind: 'Codex apply_patch file deletion',
      });
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const file = line.slice('*** Update File: '.length);
      currentUpdate = documentedPath(file) ? file : null;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      currentUpdate = null;
      continue;
    }
    if (line.startsWith('*** Move to: ')) {
      destructiveHeaderSeen = true;
      const destination = line.slice('*** Move to: '.length);
      if (!currentUpdate || !documentedPath(destination)) {
        return {
          operations: [],
          issue: 'Codex apply_patch Move to did not identify both its documented source and destination paths.',
        };
      }
      // Moving within one worktree preserves the source bytes. The agent-neutral assessor knows
      // that distinction. A pre-existing destination is a full replacement, so it is assessed
      // separately and calibrated as an ask rather than a blanket refusal of normal renames.
      operations.push({
        path: currentUpdate,
        dest: destination,
        role: 'move-src',
        kind: 'Codex apply_patch file move',
      });
      operations.push({
        path: destination,
        role: 'overwrite',
        kind: 'Codex apply_patch move destination overwrite',
        promptOnRisk: true,
      });
      continue;
    }

    // A near-miss destructive header is not a harmless patch. Do not invent how Codex will parse
    // a future or malformed spelling; surface the uncertainty through the host's decision channel.
    if (/^\*\*\*\s+(?:Delete File|Move to)\b/.test(line)) {
      destructiveHeaderSeen = true;
      unmappedDestructiveHeader = true;
    }
  }

  if (destructiveHeaderSeen && (!hasBegin || !hasEnd)) {
    return {
      operations: [],
      issue: 'Codex apply_patch contained a destructive file operation outside a complete Begin Patch / End Patch envelope.',
    };
  }
  if (unmappedDestructiveHeader || (destructiveHeaderSeen && operations.length === 0)) {
    return {
      operations: [],
      issue: 'Codex apply_patch contained a destructive operation Holt could not map to an exact target.',
    };
  }
  return { operations, issue: null };
}

/**
 * Translate only the structured tools whose field-level contracts the hosts document.
 * `editWholeFile` is measured by the caller from the current file bytes; false means an ordinary
 * incremental Edit and therefore deliberately produces no operation.
 *
 * @param {{host:string, toolName:unknown, toolInput:unknown, editWholeFile?:boolean|'unknown'}} event
 * @returns {{handled:boolean, operations:ExplicitFileOperation[], issue:string|null}}
 */
export function documentedNativeTool(event) {
  /** @type {Record<string, any>|null} */
  const input = event.toolInput && typeof event.toolInput === 'object' && !Array.isArray(event.toolInput)
    ? /** @type {Record<string, any>} */ (event.toolInput)
    : null;

  if (event.host === 'codex' && event.toolName === 'apply_patch') {
    const parsed = codexApplyPatchOperations(input?.command);
    return { handled: true, ...parsed };
  }

  const fullWrite = (event.host === 'claude-code' && event.toolName === 'Write')
    || (event.host === 'qwen-code' && event.toolName === 'write_file');
  if (fullWrite) {
    const label = event.host === 'qwen-code' ? 'Qwen write_file' : 'Claude Write';
    if (!input || !documentedPath(input.file_path) || typeof input.content !== 'string') {
      return {
        handled: true,
        operations: [],
        issue: `${label} did not provide its documented file_path and content fields, so Holt cannot verify the overwrite target.`,
      };
    }
    return {
      handled: true,
      operations: [{
        path: input.file_path,
        role: 'overwrite',
        kind: `${label} full-file overwrite`,
        promptOnRisk: true,
      }],
      issue: null,
    };
  }

  const edit = (event.host === 'claude-code' && event.toolName === 'Edit')
    || (event.host === 'qwen-code' && event.toolName === 'edit');
  if (edit) {
    const label = event.host === 'qwen-code' ? 'Qwen edit' : 'Claude Edit';
    if (!input || !documentedPath(input.file_path)
      || typeof input.old_string !== 'string' || typeof input.new_string !== 'string') {
      return {
        handled: true,
        operations: [],
        issue: `${label} did not provide its documented file_path, old_string, and new_string fields.`,
      };
    }
    if (event.editWholeFile === 'unknown') {
      return {
        handled: true,
        operations: [],
        issue: `${label} may replace the complete file, but Holt could not compare the documented old_string with the current bytes.`,
      };
    }
    if (event.editWholeFile !== true) {
      return { handled: true, operations: [], issue: null };
    }
    return {
      handled: true,
      operations: [{
        path: input.file_path,
        role: 'overwrite',
        kind: `${label} full-file replacement`,
        promptOnRisk: true,
      }],
      issue: null,
    };
  }

  return { handled: false, operations: [], issue: null };
}
