/**
 * grove — agent integration.
 *
 * The claim being tested is the product's core selling point: grove does not merely REPORT that
 * work is at risk, it PREVENTS an agent from destroying it, and it arrives with sibling context
 * rather than waiting to be asked.
 *
 * Both directions are asserted for every case. A gate that denies everything would satisfy
 * "blocks destruction" while being useless, so each deny test has an allow twin.
 */
// @ts-nocheck


import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { standardFixture, emptyFixture } from '../fixtures.mjs';
import { assessCommand, buildBrief, classifyCommand } from '../../src/agent.mjs';
import {
  formatVerdict, formatContext, agentsMdBlock, installAgentsMd,
  detectHosts, integrate, mcpTargets, claudeCodeHooks, opencodePlugin,
} from '../../src/integrate/adapters.mjs';

/* ------------------------------------------------- destructive detection ---- */

test('command classifier: catches the ways worktrees actually get destroyed', () => {
  const mustCatch = [
    'git worktree remove /path/to/wt',
    'git worktree remove --force /path/to/wt',
    'git worktree remove -f wt/thing',
    'git -C /repo worktree remove wt/thing',
    'git worktree prune',
    'rm -rf .worktrees/agent-1',
    'rm -rf /home/u/project/.claude/worktrees/wf_abc',
  ];
  for (const c of mustCatch) {
    assert.ok(classifyCommand(c), `must classify as destructive: ${c}`);
  }

  const mustIgnore = [
    'git worktree list',
    'git worktree add ../new feature',
    'ls -la',
    'npm test',
    'rm -rf node_modules',
    'rm -rf dist',
    'git status',
    '',
  ];
  for (const c of mustIgnore) {
    assert.equal(classifyCommand(c), null, `must NOT classify as destructive: ${c}`);
  }
});

/* --------------------------------------------------------- the deny gate ---- */

test('GATE DENY: destroying a worktree with uncommitted-only work is blocked, with evidence', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const target = fx.wt('uniqueUncommitted');
  const verdict = await assessCommand(`git worktree remove ${target}`, fx.root);

  assert.equal(verdict.decision, 'deny');
  assert.ok(verdict.targets.includes('uniqueUncommitted'));
  // The reason must NAME what would be lost. "Blocked by policy" would be useless to an agent.
  assert.match(verdict.reason, /UNCOMMITTED_ONLY_SYMBOL/,
    `the reason must name the symbol at risk, got: ${verdict.reason}`);
  assert.match(verdict.reason, /grove gate/, 'the reason must say how to inspect');
});

test('GATE ALLOW: destroying a genuinely empty worktree is permitted', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const verdict = await assessCommand(`git worktree remove ${fx.wt('empty')}`, fx.root);
  assert.equal(verdict.decision, 'allow', `empty worktree should be removable: ${verdict.reason}`);
});

test('GATE ALLOW: content base already has is removable (the instrument check, via the gate)', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const verdict = await assessCommand(`git worktree remove ${fx.wt('alreadyLanded')}`, fx.root);
  assert.equal(verdict.decision, 'allow',
    `alreadyLanded holds nothing base lacks and must be removable: ${verdict.reason}`);
});

test('GATE ALLOW: non-destructive commands never trigger a scan', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  for (const cmd of ['npm test', 'git status', 'git worktree list', 'rm -rf node_modules']) {
    const v = await assessCommand(cmd, fx.root);
    assert.equal(v.decision, 'allow', `${cmd} must be allowed`);
    assert.equal(v.kind, null, `${cmd} must not be classified as destructive`);
  }
});

test('GATE ASK: an unverifiable repository produces ask, never allow', async () => {
  const verdict = await assessCommand(
    'git worktree remove /nope/wt', '/nonexistent/definitely/not/a/repo',
  );
  assert.equal(verdict.decision, 'ask',
    'when grove cannot measure, it must not silently allow destruction');
  assert.match(verdict.reason, /could not verify/i);
});

test('GATE: `worktree prune` is evaluated against EVERY workstream, not one', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const verdict = await assessCommand('git worktree prune', fx.root);
  assert.equal(verdict.decision, 'deny');
  assert.ok(verdict.targets.length > 1,
    `prune affects all worktrees; expected several targets, got ${verdict.targets.join(', ')}`);
});

/* ------------------------------------------------------------- the brief ---- */

test('BRIEF: arrives with sibling context an agent did not ask for', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const text = await buildBrief(fx.wt('collideA'));
  assert.ok(text, 'a repo with collisions must produce a brief');
  assert.match(text, /collideA/, 'the brief must say which workstream you are in');
  assert.match(text, /collideB/, 'and name the contending sibling');
  assert.match(text, /grove gate/, 'and tell the agent how to check before deleting');
});

test('BRIEF: a quiet repo produces NOTHING rather than noise', async (t) => {
  const fx = await emptyFixture();
  t.after(() => fx.cleanup());

  const text = await buildBrief(fx.root);
  assert.equal(text, null, 'no findings must mean no injected context');
});

test('BRIEF: a non-repository is silent, not an exception', async () => {
  assert.equal(await buildBrief('/nonexistent/not/a/repo'), null);
});

/* ------------------------------------------------------ host translation ---- */

test('ADAPTER: the same verdict renders correctly for each host', () => {
  const deny = { decision: 'deny', reason: 'because', kind: 'git worktree remove', targets: ['x'] };

  const cc = formatVerdict(deny, { host: 'claude-code' });
  assert.equal(cc.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(cc.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(cc.hookSpecificOutput.permissionDecisionReason, 'because');

  const generic = formatVerdict(deny, { host: 'generic' });
  assert.equal(generic.decision, 'deny');
  assert.equal(generic.reason, 'because');

  // Context, both hosts.
  const ccCtx = formatContext('hello', { host: 'claude-code', eventName: 'SessionStart' });
  assert.equal(ccCtx.hookSpecificOutput.additionalContext, 'hello');
  assert.equal(formatContext('hello', { host: 'generic' }).context, 'hello');

  // Empty context must not fabricate a payload.
  assert.deepEqual(formatContext(null, { host: 'claude-code' }), {});
});

/* -------------------------------------------------------- installation ---- */

test('INSTALL: AGENTS.md block is created, then updated idempotently', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grove-agentsmd-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const first = await installAgentsMd(dir);
  assert.equal(first.created, true);
  let text = await fs.readFile(first.path, 'utf8');
  assert.match(text, /grove gate/, 'the block must tell agents to gate before deleting');

  // Re-running must not duplicate the block.
  await installAgentsMd(dir);
  text = await fs.readFile(first.path, 'utf8');
  assert.equal(text.split('BEGIN grove').length - 1, 1, 'block must appear exactly once');
});

test('INSTALL: existing AGENTS.md content is preserved', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grove-agentsmd2-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  await fs.writeFile(path.join(dir, 'AGENTS.md'), '# My Project\n\nRun `make test`.\n');
  await installAgentsMd(dir);

  const text = await fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8');
  assert.match(text, /Run `make test`/, 'pre-existing instructions must survive');
  assert.match(text, /BEGIN grove/);
});

test('INSTALL: MCP targets cover the major hosts, split by scope', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grove-mcp-'));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'grove-home-'));
  t.after(() => Promise.all([
    fs.rm(dir, { recursive: true, force: true }),
    fs.rm(home, { recursive: true, force: true }),
  ]));

  const all = mcpTargets(dir, home, { scope: 'all' }).map((x) => x.host).join(' ');
  for (const expected of ['claude-code', 'cursor', 'vscode', 'windsurf', 'gemini-cli', 'zed', 'continue']) {
    assert.match(all, new RegExp(expected), `MCP target list should include ${expected}`);
  }

  // Default scope must be PROJECT ONLY — no path may point outside the repo.
  for (const t2 of mcpTargets(dir, home)) {
    assert.equal(t2.scope, 'project');
    assert.ok(t2.file.startsWith(dir), `default scope leaked outside the repo: ${t2.file}`);
  }
});

test('INSTALL: each host gets the entry SHAPE it actually reads', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grove-shapes-'));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'grove-shapeshome-'));
  t.after(() => Promise.all([
    fs.rm(dir, { recursive: true, force: true }),
    fs.rm(home, { recursive: true, force: true }),
  ]));

  const { installMcp, mcpServerEntry } = await import('../../src/integrate/adapters.mjs');

  // Verified against a live `opencode debug config`: opencode reads
  //   mcp: { name: { type: "local", command: [...] } }
  // NOT the mcpServers/{command,args} shape everyone else uses. Writing the wrong shape
  // produces a config the host silently ignores — installed, and inert.
  const oc = mcpServerEntry('grove', 'opencode');
  assert.equal(oc.type, 'local');
  assert.deepEqual(oc.command, ['grove', 'mcp']);

  const std = mcpServerEntry('grove');
  assert.equal(std.command, 'grove');
  assert.deepEqual(std.args, ['mcp']);

  // A bin carrying arguments must be split, not passed whole — same defect class that made the
  // OpenCode plugin gate fail open.
  const withArgs = mcpServerEntry('node /path/to/grove.mjs', 'opencode');
  assert.deepEqual(withArgs.command, ['node', '/path/to/grove.mjs', 'mcp']);
  const stdWithArgs = mcpServerEntry('npx grovekit');
  assert.equal(stdWithArgs.command, 'npx');
  assert.deepEqual(stdWithArgs.args, ['grovekit', 'mcp']);

  // And end-to-end: the file opencode reads must contain the opencode shape.
  await installMcp(dir, { home, scope: 'project' });
  const written = JSON.parse(await fs.readFile(path.join(dir, 'opencode.json'), 'utf8'));
  assert.equal(written.mcp.grove.type, 'local');
  assert.ok(Array.isArray(written.mcp.grove.command));
});

test('INSTALL: user-global config is NEVER created from nothing', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grove-mcp2-'));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'grove-home2-'));
  t.after(() => Promise.all([
    fs.rm(dir, { recursive: true, force: true }),
    fs.rm(home, { recursive: true, force: true }),
  ]));

  const { installMcp } = await import('../../src/integrate/adapters.mjs');
  // Even asking explicitly for user scope must not fabricate configs for editors the user
  // does not have. An earlier revision created ~/.cursor, ~/.codeium and ~/.config/zed on a
  // machine that had none of them — installing software the user never asked for.
  const results = await installMcp(dir, { home, scope: 'user' });
  assert.ok(results.every((r) => /skipped/.test(r.action)),
    `user-scope install must skip absent configs, got: ${JSON.stringify(results)}`);

  const leftovers = await fs.readdir(home);
  assert.deepEqual(leftovers, [], `nothing may be created in HOME, found: ${leftovers.join(', ')}`);
});

test('INSTALL: integrate() wires AGENTS.md + MCP + detected hosts only', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grove-int-'));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'grove-inthome-'));
  t.after(() => Promise.all([
    fs.rm(dir, { recursive: true, force: true }),
    fs.rm(home, { recursive: true, force: true }),
  ]));
  await fs.mkdir(path.join(dir, '.git', 'hooks'), { recursive: true });
  await fs.mkdir(path.join(dir, '.claude'), { recursive: true }); // pretend Claude Code is in use

  const { detected, results } = await integrate(dir, { home });

  assert.ok(detected.project.includes('claude-code'), 'should detect the host whose config dir exists');
  assert.ok(!detected.all.includes('windsurf'), 'must not claim hosts that are absent');

  // Default scope must not have touched HOME at all.
  const homeLeftovers = await fs.readdir(home);
  assert.deepEqual(homeLeftovers, [], `integrate touched HOME: ${homeLeftovers.join(', ')}`);

  const adapters = results.map((r) => r.adapter);
  assert.ok(adapters.includes('agents-md'), 'AGENTS.md is universal and always installed');
  assert.ok(adapters.includes('claude-code'), 'detected host hooks installed');

  const settings = JSON.parse(await fs.readFile(path.join(dir, '.claude', 'settings.json'), 'utf8'));
  assert.ok(settings.hooks.PreToolUse, 'PreToolUse hook wired');
  assert.match(JSON.stringify(settings.hooks), /grove hook/);
});

test('ADAPTER: the generated OpenCode plugin is syntactically valid JS', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grove-oc-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const file = path.join(dir, 'grove.mjs');
  await fs.writeFile(file, opencodePlugin('grove'), 'utf8');
  // Importing proves it parses; the plugin exports a factory and runs nothing on import.
  const mod = await import(`file://${file}`);
  assert.equal(typeof mod.grove, 'function', 'plugin must export a grove factory');
});

test('ADAPTER: Claude Code hook config targets Bash and all three events', () => {
  const h = claudeCodeHooks('grove');
  assert.equal(h.PreToolUse[0].matcher, 'Bash');
  for (const evt of ['PreToolUse', 'SessionStart', 'UserPromptSubmit']) {
    assert.ok(h[evt], `missing ${evt}`);
    assert.match(JSON.stringify(h[evt]), /grove hook/);
  }
});

test('ADAPTER: host detection reports only what exists', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grove-detect-'));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'grove-detecthome-'));
  t.after(() => Promise.all([
    fs.rm(dir, { recursive: true, force: true }),
    fs.rm(home, { recursive: true, force: true }),
  ]));

  const none = await detectHosts(dir, home);
  assert.deepEqual(none.all, [], 'nothing installed => nothing detected');

  await fs.mkdir(path.join(dir, '.cursor'), { recursive: true });
  await fs.mkdir(path.join(home, '.gemini'), { recursive: true });
  const found = await detectHosts(dir, home);

  assert.ok(found.project.includes('cursor'), 'repo-local host detected as project scope');
  assert.ok(found.user.includes('gemini-cli'), 'home-only host detected as user scope');
  assert.ok(!found.project.includes('gemini-cli'), 'a home-only host is NOT a project host');
  assert.ok(!found.all.includes('claude-code'));
});

test('AGENTS.md text tells an agent the exit-code contract', () => {
  const block = agentsMdBlock('grove');
  assert.match(block, /exit code/i);
  assert.match(block, /grove gate/);
  assert.match(block, /grove context/);
  assert.match(block, /--json/, 'agents need to know machine output exists');
});
