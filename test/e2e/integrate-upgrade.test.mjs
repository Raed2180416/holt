/**
 * holt — upgrade-safe `integrate` / `uninstall`.
 *
 * v0.2.0 is published and real users have it wired into their agents already. `holt integrate`
 * must therefore be a RECONCILIATION, not a one-shot installer: re-running it after an upgrade
 * has to find what a PRIOR version wrote (however it wrote it), fix what is now known wrong, and
 * never duplicate or silently strand a config that points at something that no longer applies.
 *
 * Every fixture here reproduces something MEASURED against this repository's own history, not a
 * hypothetical:
 *   - test/fixtures/upgrade/prior-version-claude-settings.json is the shape a prior integrate run
 *     produces whenever the resolved `bin` differs from the current one (a dev checkout, `npx
 *     holt`, or simply a future flag change) — reproduced against the ACTUAL old dedupe check
 *     (`JSON.stringify(e).includes(\`${bin} hook\`)`) before this file's fix, which appended a
 *     second, live-but-duplicate hook next to the stale one on every single run.
 *   - test/fixtures/upgrade/v0.3.0-cline-mcp.json is byte-for-byte what commit a976ab4d — tagged
 *     "release(v0.3.0)" in this repo's own history — actually wrote to `.cline/mcp.json`. The very
 *     next commit (435a0979) discovered Cline CLI has no project-scope MCP file at all
 *     (cline/cline#11671) and removed the row from `mcpTargets` — but nothing ever cleaned up a
 *     copy already sitting on a real disk. That is a real, shipped instance of exactly the defect
 *     class this file exists to close.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  installClaudeCode, claudeCodeHooks, integrate, uninstall,
  legacyMcpTargets, retireLegacyMcp, mcpTargets, installMcp,
} from '../../src/integrate/adapters.mjs';

const FIXTURES = fileURLToPath(new URL('../fixtures/upgrade/', import.meta.url));

async function tmp(label) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `holt-${label}-`));
  return dir;
}

/* --------------------------------------------- claude-code hook reconciliation ---- */

test('UPGRADE: a stale hook entry from a prior version is RECONCILED, never duplicated', async (t) => {
  const dir = await tmp('reconcile');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
  const stale = await fs.readFile(path.join(FIXTURES, 'prior-version-claude-settings.json'), 'utf8');
  await fs.writeFile(path.join(dir, '.claude', 'settings.json'), stale);

  // PRECONDITION: the fixture really is a single, non-duplicated entry per event, and it really
  // uses a different bin than the one integrate will resolve to here.
  const before = JSON.parse(stale);
  assert.equal(before.hooks.PreToolUse.length, 1, 'PRECONDITION: fixture starts with exactly one entry');
  assert.match(before.hooks.PreToolUse[0].hooks[0].command, /\/Users\/dev\/projects\/holt\/bin\/holt\.mjs/,
    'PRECONDITION: the fixture uses a bin different from the resolved one');

  const r = await installClaudeCode(dir, { bin: 'holt' });
  assert.match(r.action, /reconciled/, `must report a reconciliation, got: ${r.action}`);

  const after = JSON.parse(await fs.readFile(path.join(dir, '.claude', 'settings.json'), 'utf8'));
  for (const event of ['PreToolUse', 'SessionStart', 'UserPromptSubmit']) {
    assert.equal(after.hooks[event].length, 1,
      `${event} must have exactly ONE holt entry after reconciliation, got ${after.hooks[event].length}: ` +
      JSON.stringify(after.hooks[event]));
  }
  assert.equal(after.hooks.PreToolUse[0].hooks[0].command, 'holt hook pre-tool-use --host claude-code',
    'the surviving entry must be the CURRENT correct command, not the stale one');
  assert.doesNotMatch(JSON.stringify(after), /\/Users\/dev\/projects\/holt/,
    'the stale absolute-path command must be gone entirely, not just supplemented');
});

test('UPGRADE: reconciliation never touches a hook holt did not write', async (t) => {
  const dir = await tmp('reconcile-user-hook');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
  const mixed = {
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-linter --check', timeout: 30 }] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'node /old/path/holt.mjs hook pre-tool-use --host claude-code', timeout: 120 }] },
      ],
    },
  };
  await fs.writeFile(path.join(dir, '.claude', 'settings.json'), JSON.stringify(mixed, null, 2));

  await installClaudeCode(dir, { bin: 'holt' });
  const after = JSON.parse(await fs.readFile(path.join(dir, '.claude', 'settings.json'), 'utf8'));

  assert.equal(after.hooks.PreToolUse.length, 2, 'the user hook plus one reconciled holt hook — never more');
  assert.ok(after.hooks.PreToolUse.some((e) => e.hooks[0].command === 'my-own-linter --check'),
    "a hook holt did not write must survive untouched");
  assert.ok(after.hooks.PreToolUse.some((e) => e.hooks[0].command === 'holt hook pre-tool-use --host claude-code'),
    'the stale holt hook must be reconciled to the current command');
});

test('UPGRADE: re-running integrate over an already-current install changes nothing', async (t) => {
  const dir = await tmp('idempotent');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, '.claude'), { recursive: true });

  const first = await installClaudeCode(dir, { bin: 'holt' });
  assert.equal(first.action, 'installed');
  const text1 = await fs.readFile(path.join(dir, '.claude', 'settings.json'), 'utf8');

  const second = await installClaudeCode(dir, { bin: 'holt' });
  assert.equal(second.action, 'already present', `a no-op re-run must say so, got: ${second.action}`);
  const text2 = await fs.readFile(path.join(dir, '.claude', 'settings.json'), 'utf8');
  assert.equal(text1, text2, 'a no-op reconciliation must not rewrite the file to a different byte layout');
});

test('ADAPTER: Claude Code hook entries carry the exact structure isHoltHookCommand recognises', () => {
  // Sanity: claudeCodeHooks itself must produce commands the reconciler will find NEXT time,
  // regardless of what `bin` is passed — otherwise a future bin change reintroduces duplication.
  const h = claudeCodeHooks('anything goes/here.mjs');
  assert.match(h.PreToolUse[0].hooks[0].command, /\bhook\s+pre-tool-use\b/);
  assert.match(h.SessionStart[0].hooks[0].command, /\bhook\s+session-start\b/);
  assert.match(h.UserPromptSubmit[0].hooks[0].command, /\bhook\s+user-prompt-submit\b/);
});

/* --------------------------------------------------------- legacy MCP retirement ---- */

test('UPGRADE: a real prior-release stale MCP file (.cline/mcp.json, shipped in v0.3.0) is retired', async (t) => {
  const dir = await tmp('legacy-cline');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  await fs.mkdir(path.join(dir, '.cline'), { recursive: true });
  const shipped = await fs.readFile(path.join(FIXTURES, 'v0.3.0-cline-mcp.json'), 'utf8');
  await fs.writeFile(path.join(dir, '.cline', 'mcp.json'), shipped);

  // PRECONDITION: current holt no longer considers this a real target at all — if it did, this
  // test would not be exercising retirement, only ordinary reinstall.
  const current = mcpTargets(dir, os.homedir(), { scope: 'project' }).map((t2) => t2.file);
  assert.ok(!current.includes(path.join(dir, '.cline', 'mcp.json')),
    'PRECONDITION: .cline/mcp.json must not be a current mcpTargets entry');

  const results = await retireLegacyMcp(dir, { scope: 'project' });
  const mine = results.find((r) => r.host === 'cline' && r.scope === 'project');
  assert.ok(mine, `retireLegacyMcp must report the cline project file, got: ${JSON.stringify(results)}`);
  assert.match(mine.action, /removed/, `must report removal, got: ${mine.action}`);

  await assert.rejects(fs.access(path.join(dir, '.cline', 'mcp.json')),
    'the stale file must actually be gone from disk, not just reported as gone');
});

test('UPGRADE: retiring a legacy MCP file keeps content holt did not write', async (t) => {
  const dir = await tmp('legacy-cline-mixed');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  await fs.mkdir(path.join(dir, '.cline'), { recursive: true });
  const mixed = {
    mcpServers: {
      holt: { command: 'holt', args: ['mcp'], env: {} },
      someOtherServer: { command: 'other-tool', args: ['serve'] },
    },
    unrelatedSetting: true,
  };
  await fs.writeFile(path.join(dir, '.cline', 'mcp.json'), JSON.stringify(mixed, null, 2));

  await retireLegacyMcp(dir, { scope: 'project' });

  const after = JSON.parse(await fs.readFile(path.join(dir, '.cline', 'mcp.json'), 'utf8'));
  assert.ok(!after.mcpServers.holt, "holt's own entry must be gone");
  assert.deepEqual(after.mcpServers.someOtherServer, { command: 'other-tool', args: ['serve'] },
    'an unrelated MCP server entry in the SAME file must survive untouched');
  assert.equal(after.unrelatedSetting, true, 'unrelated top-level settings must survive untouched');
});

test('UPGRADE: legacy retirement is silent and safe when there is nothing to retire', async (t) => {
  const dir = await tmp('legacy-none');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const results = await retireLegacyMcp(dir, { scope: 'project' });
  assert.deepEqual(results, [], 'no legacy file present => nothing reported, nothing written');
});

test('UPGRADE: legacy user-scope files are untouched at project scope', async (t) => {
  const dir = await tmp('legacy-scope-dir');
  const home = await tmp('legacy-scope-home');
  t.after(() => Promise.all([fs.rm(dir, { recursive: true, force: true }), fs.rm(home, { recursive: true, force: true })]));

  await fs.mkdir(path.join(home, '.cline'), { recursive: true });
  await fs.writeFile(path.join(home, '.cline', 'mcp.json'),
    JSON.stringify({ mcpServers: { holt: { command: 'holt', args: ['mcp'], env: {} } } }, null, 2));

  const results = await retireLegacyMcp(dir, { home, scope: 'project' });
  assert.deepEqual(results, [], 'project-scope integrate must never touch HOME');
  const stillThere = JSON.parse(await fs.readFile(path.join(home, '.cline', 'mcp.json'), 'utf8'));
  assert.ok(stillThere.mcpServers.holt, 'the user-scope legacy file must be untouched at project scope');
});

test('UPGRADE: integrate() itself retires legacy MCP files as part of one run', async (t) => {
  const dir = await tmp('integrate-retires');
  const home = await tmp('integrate-retires-home');
  t.after(() => Promise.all([fs.rm(dir, { recursive: true, force: true }), fs.rm(home, { recursive: true, force: true })]));
  await fs.mkdir(path.join(dir, '.git', 'hooks'), { recursive: true });
  await fs.mkdir(path.join(dir, '.cline'), { recursive: true });
  await fs.writeFile(path.join(dir, '.cline', 'mcp.json'),
    await fs.readFile(path.join(FIXTURES, 'v0.3.0-cline-mcp.json'), 'utf8'));

  const { results } = await integrate(dir, { home });
  assert.ok(results.some((r) => r.adapter === 'mcp-retire' && r.host === 'cline'),
    `integrate() must include legacy retirement in its results, got adapters: ${results.map((r) => r.adapter).join(', ')}`);
  await assert.rejects(fs.access(path.join(dir, '.cline', 'mcp.json')));
});

/* ------------------------------------------------------------------- uninstall ---- */

test('UNINSTALL: removes every holt-authored artifact, touches nothing else', async (t) => {
  const dir = await tmp('uninstall');
  const home = await tmp('uninstall-home');
  t.after(() => Promise.all([fs.rm(dir, { recursive: true, force: true }), fs.rm(home, { recursive: true, force: true })]));
  await fs.mkdir(path.join(dir, '.git', 'hooks'), { recursive: true });
  await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
  await fs.mkdir(path.join(dir, '.cursor'), { recursive: true });
  await fs.mkdir(path.join(dir, '.opencode'), { recursive: true });

  // A user's own content that must survive the round trip.
  await fs.writeFile(path.join(dir, 'AGENTS.md'), '# My rules\n\nDo not break the build.\n');
  await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
  // Written by hand rather than installClaudeCode so a genuinely independent user hook is present
  // BEFORE holt ever touches the file.
  await fs.writeFile(path.join(dir, '.claude', 'settings.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-linter', timeout: 10 }] }] },
  }, null, 2));

  await integrate(dir, { home });

  // Confirm the premise: holt actually wired something, or "uninstall removed nothing" would be
  // true for the wrong reason.
  const mcpBefore = JSON.parse(await fs.readFile(path.join(dir, '.mcp.json'), 'utf8'));
  assert.ok(mcpBefore.mcpServers.holt, 'PRECONDITION: integrate must have written the claude-code MCP config');
  const claudeBefore = JSON.parse(await fs.readFile(path.join(dir, '.claude', 'settings.json'), 'utf8'));
  assert.equal(claudeBefore.hooks.PreToolUse.length, 2, 'PRECONDITION: user hook + holt hook both present');

  const results = await uninstall(dir, {});
  assert.ok(results.length > 0, 'uninstall must report what it did');

  // holt-only files are gone entirely.
  for (const f of ['.mcp.json', '.opencode/plugins/holt.js', '.git/hooks/pre-commit']) {
    await assert.rejects(fs.access(path.join(dir, f)), `${f} must be removed by uninstall`);
  }

  // Mixed files survive, holt's slice gone, the user's kept.
  const agentsMd = await fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8');
  assert.match(agentsMd, /Do not break the build/, "the user's own AGENTS.md content must survive");
  assert.doesNotMatch(agentsMd, /BEGIN holt/, "holt's block must be gone");

  const claudeAfter = JSON.parse(await fs.readFile(path.join(dir, '.claude', 'settings.json'), 'utf8'));
  assert.equal(claudeAfter.hooks.PreToolUse.length, 1, 'only the holt hook must be removed');
  assert.equal(claudeAfter.hooks.PreToolUse[0].hooks[0].command, 'my-own-linter',
    "the user's own PreToolUse hook must survive uninstall");
  assert.equal(claudeAfter.hooks.SessionStart, undefined, 'an event with ONLY holt entries must be dropped entirely');
});

test('UNINSTALL: is a safe no-op on a repository holt never touched', async (t) => {
  const dir = await tmp('uninstall-noop');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'README.md'), 'hello\n');

  const results = await uninstall(dir, {});
  assert.deepEqual(results, [], 'nothing installed => nothing reported, nothing to break');
  assert.equal(await fs.readFile(path.join(dir, 'README.md'), 'utf8'), 'hello\n');
});

test('UNINSTALL: never deletes a git pre-commit hook it did not write', async (t) => {
  const dir = await tmp('uninstall-foreign-hook');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, '.git', 'hooks'), { recursive: true });
  await fs.writeFile(path.join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nnpm test\n', { mode: 0o755 });

  const results = await uninstall(dir, {});
  const row = results.find((r) => r.adapter === 'git-hooks');
  assert.ok(row, 'uninstall must report on the foreign pre-commit hook it found');
  assert.match(row.action, /left in place/, 'a foreign hook must be left in place, not deleted');
  assert.match(await fs.readFile(path.join(dir, '.git', 'hooks', 'pre-commit'), 'utf8'), /npm test/);
});

/* ----------------------------------------------------------------- full round trip ---- */

test('ROUND TRIP: integrate -> uninstall -> integrate leaves a clean, fully-wired repo', async (t) => {
  const dir = await tmp('roundtrip');
  const home = await tmp('roundtrip-home');
  t.after(() => Promise.all([fs.rm(dir, { recursive: true, force: true }), fs.rm(home, { recursive: true, force: true })]));
  await fs.mkdir(path.join(dir, '.git', 'hooks'), { recursive: true });
  await fs.mkdir(path.join(dir, '.claude'), { recursive: true });

  await integrate(dir, { home });
  await uninstall(dir, {});
  const { results } = await integrate(dir, { home });

  assert.ok(results.some((r) => r.adapter === 'claude-code' && r.action === 'installed'),
    'after a clean uninstall, the next integrate must install fresh, not "already present"');
  const settings = JSON.parse(await fs.readFile(path.join(dir, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.hooks.PreToolUse.length, 1, 'no leftover duplication across the round trip');
});
