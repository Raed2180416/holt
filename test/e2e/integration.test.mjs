/**
 * holt — agent integration.
 *
 * The claim being tested is the product's core selling point: holt does not merely REPORT that
 * work is at risk, it PREVENTS an agent from destroying it, and it arrives with sibling context
 * rather than waiting to be asked.
 *
 * Both directions are asserted for every case. A gate that denies everything would satisfy
 * "blocks destruction" while being useless, so each deny test has an allow twin.
 */

import { execFile } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const HOLT_BIN = fileURLToPath(new URL('../../bin/holt.mjs', import.meta.url));
import path from 'node:path';
import { standardFixture, emptyFixture, newRepo } from '../fixtures.mjs';
import * as agent from '../../src/agent.mjs';
import {
  assessCommand, buildBrief, classifyCommand, resolveFileTargets, cachedReport, inlineStrings, expandForLoops,
} from '../../src/agent.mjs';
import { atRiskFiles } from '../../src/scan.mjs';
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
    'git status',
    '',
  ];
  for (const c of mustIgnore) {
    assert.equal(classifyCommand(c), null, `must NOT classify as destructive: ${c}`);
  }

  // TWO-STAGE BY DESIGN: `rm` NOMINATES at the classifier and is resolved against the real
  // worktree list before any verdict. The old single-stage rule required 'worktree'/'wt' in the
  // path, so `rm -rf ../my-feature` — the natural way to delete a worktree — was never even
  // considered. The classifier therefore matches any rm target; the ALLOW for ordinary deletes
  // is asserted end-to-end in 'GATE ALLOW: non-destructive commands never trigger a scan'.
  for (const c of ['rm -rf node_modules', 'rm -rf dist']) {
    assert.ok(classifyCommand(c), `${c} is nominated at the classifier…`);
  }
});

test('command resolver: exposes layers, paths, and unresolved inputs without allowing ambiguity', () => {
  const resolved = agent.resolveCommand('git reset --hard');
  assert.match(resolved.verb, /reset/);
  assert.ok(resolved.reachableLayers.includes('uncommitted'));
  assert.ok(resolved.reachableLayers.includes('untracked'));
  assert.deepEqual(resolved.unresolved, []);

  const opaque = agent.resolveCommand('rm -rf $WORKTREE');
  assert.ok(opaque.unresolved.some((item) => /WORKTREE/.test(item)),
    `unresolved target must be named: ${JSON.stringify(opaque)}`);
  const brace = agent.resolveCommand('rm -rf worktree/file{1,2}');
  assert.ok(brace.unresolved.some((item) => /brace/i.test(item)),
    `brace expansion must be explicit: ${JSON.stringify(brace)}`);
  const directory = agent.resolveCommand('cd - && git reset --hard');
  assert.ok(directory.unresolved.some((item) => /working-directory|directory/i.test(item)),
    `ambiguous cd must be explicit: ${JSON.stringify(directory)}`);
});

test('command classifier: shell comments are data, but a later command is still assessed', () => {
  assert.equal(classifyCommand('echo note # rm -rf wt/task-03'), null,
    'a destroyer in a shell comment is not executable');
  const later = classifyCommand('echo note # harmless\nrm -rf wt/task-03');
  assert.ok(later, 'a destroyer after a comment newline remains executable');
});

test('FILE GATE: shell comments cannot nominate a file target', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());
  const verdict = await assessCommand(`echo note # rm -rf ${fx.wt('uniqueUncommitted')}`, fx.root);
  assert.equal(verdict.decision, 'allow', `comment text is not executable: ${JSON.stringify(verdict)}`);
});

test('command classifier: a BOM-prefixed command is unparseable, not trusted', () => {
  const hit = classifyCommand('\uFEFFrm -rf wt/task-03');
  assert.ok(hit?.unresolved?.some((item) => /BOM/i.test(item)),
    `BOM must be reported as unresolved: ${JSON.stringify(hit)}`);
});

test('command classifier: DISARMING the protection counts as destructive', () => {
  // MEASURED: an agent hit `holt protect`, read the lock reason naming the exact symbol at
  // risk, ran `git worktree unlock`, and deleted anyway — justifying it from the worktree's NAME
  // ("DELETEME-old-experiment"), which is the exact trap the scenario is built from.
  //
  // A gate that only watches `remove` watches the wrong step: a lock is one command from being
  // undone, and `-f -f` is git's documented override for it.
  const mustCatch = [
    ['git worktree unlock /path/to/wt', /unlock/],
    ['git -C /repo worktree unlock wt/thing', /unlock/],
    ['git worktree remove -f -f /path/to/wt', /--force --force|override/],
    ['git worktree remove --force --force /path/to/wt', /--force --force|override/],
  ];
  for (const [cmd, kindPattern] of mustCatch) {
    const hit = classifyCommand(cmd);
    assert.ok(hit, `must be classified as destructive: ${cmd}`);
    assert.match(hit.kind, kindPattern, `wrong kind for: ${cmd}`);
  }

  // …while LOCKING is not destructive — that is holt's own protective action.
  assert.equal(classifyCommand('git worktree lock --reason x /path/to/wt'), null,
    'locking must not be treated as destructive');
});

/* --------------------------------------------------------- the deny gate ---- */

test('GATE DENY: the strongest verdict wins across compound commands', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());
  const verdict = await assessCommand(`git worktree remove ${fx.wt('empty')} && git worktree remove ${fx.wt('uniqueUncommitted')}`, fx.root);
  assert.equal(verdict.decision, 'deny',
    `a later destructive match must not be disarmed by an earlier ask: ${JSON.stringify(verdict)}`);
  assert.match(verdict.reason, /UNCOMMITTED_ONLY_SYMBOL/);
});

test('GATE: a human guardAllow entry is the explicit escape hatch and is observable', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());
  const command = `rm -rf ${fx.wt('uniqueUncommitted')}`;
  const verdict = await assessCommand(command, fx.root, { guardAllow: [`^${command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`] });
  assert.equal(verdict.decision, 'allow');
  assert.equal(verdict.allowlisted, true);
  assert.equal(verdict.kind, 'human guardAllow entry');
});

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
  assert.match(verdict.reason, /holt gate/, 'the reason must say how to inspect');
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
    'when holt cannot measure, it must not silently allow destruction');
  assert.match(verdict.reason, /could not verify/i);
});

test('GATE ASK: a BOM-prefixed destructive command is never trusted', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());
  const verdict = await assessCommand(`\uFEFFrm -rf ${fx.wt('uniqueUncommitted')}`, fx.root);
  assert.equal(verdict.decision, 'ask',
    `an unparseable command must ask, never deny or allow: ${JSON.stringify(verdict)}`);
  assert.match(verdict.reason, /BOM|parse|confirm/i);
});

test('GATE: shell cd changes the worktree layer as well as the file layer', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());
  const verdict = await assessCommand(`cd ${fx.wt('uniqueUncommitted')} && git reset --hard`, fx.root);
  assert.equal(verdict.decision, 'deny',
    `cd must affect pathless git verbs too: ${JSON.stringify(verdict)}`);
  assert.match(verdict.reason, /UNCOMMITTED_ONLY_SYMBOL/);
});

test('GATE ASK: cd - and popd are unresolved, never guessed', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());
  for (const command of ['cd - && git reset --hard', 'pushd . && popd && git reset --hard']) {
    const verdict = await assessCommand(command, fx.root);
    assert.equal(verdict.decision, 'ask', `${command}: ${JSON.stringify(verdict)}`);
  }
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
  assert.match(text, /holt gate/, 'and tell the agent how to check before deleting');
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

  const allow = formatVerdict({ decision: 'allow', reason: null }, { host: 'claude-code' });
  assert.deepEqual(allow, {}, 'allow must not emit permissionDecision and bypass native host permissions');

  // Context, both hosts.
  const ccCtx = formatContext('hello', { host: 'claude-code', eventName: 'SessionStart' });
  assert.equal(ccCtx.hookSpecificOutput.additionalContext, 'hello');
  assert.equal(formatContext('hello', { host: 'generic' }).context, 'hello');

  // Empty context must not fabricate a payload.
  assert.deepEqual(formatContext(null, { host: 'claude-code' }), {});
});

/* -------------------------------------------------------- installation ---- */

test('INSTALL: AGENTS.md block is created, then updated idempotently', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-agentsmd-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const first = await installAgentsMd(dir);
  assert.equal(first.created, true);
  let text = await fs.readFile(first.path, 'utf8');
  assert.match(text, /holt gate/, 'the block must tell agents to gate before deleting');

  // Re-running must not duplicate the block.
  await installAgentsMd(dir);
  text = await fs.readFile(first.path, 'utf8');
  assert.equal(text.split('BEGIN holt').length - 1, 1, 'block must appear exactly once');
});

test('INSTALL: an existing AGENTS.md is preserved verbatim, holt appended after it', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-agentsmd2-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const user = '# My Project\n\n## Build\nRun `make test`.\n\n## Style\nTabs, not spaces.\n';
  await fs.writeFile(path.join(dir, 'AGENTS.md'), user);
  const r = await installAgentsMd(dir);

  const text = await fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8');
  assert.match(text, /Run `make test`/, 'pre-existing instructions must survive');
  assert.match(text, /Tabs, not spaces/);
  assert.equal(r.preservedUserContent, true, 'the result must report that user content was kept');
  // Order: the user content comes BEFORE holt's block, and holt never inserts its own H1.
  assert.ok(text.indexOf('make test') < text.indexOf('BEGIN holt'), 'user content stays first');
  assert.equal((text.match(/^# /gm) || []).length, 1, 'holt must not add a second top-level title');
});

test('INSTALL: re-running converges — duplicate/corrupted holt blocks collapse to one, content kept', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-agentsmd3-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  // A file that already has TWO holt blocks (a prior bug) plus real user content between them.
  const messy = 'user top\n\n<!-- BEGIN holt -->\nold one\n<!-- END holt -->\n\nuser middle\n\n<!-- BEGIN holt -->\nold two\n<!-- END holt -->\n\nuser bottom\n';
  await fs.writeFile(path.join(dir, 'AGENTS.md'), messy);
  await installAgentsMd(dir);

  const text = await fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8');
  assert.equal(text.split('BEGIN holt').length - 1, 1, 'exactly one holt block after cleanup');
  assert.ok(!text.includes('old one') && !text.includes('old two'), 'stale holt content is gone');
  for (const kept of ['user top', 'user middle', 'user bottom']) {
    assert.match(text, new RegExp(kept), `user content "${kept}" must survive the collapse`);
  }
  // And a further run is a no-op on length (idempotent, no growth).
  const len1 = text.length;
  await installAgentsMd(dir);
  const len2 = (await fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8')).length;
  assert.equal(len1, len2, 'a second run must not grow the file');
});

test('DETECT: a bare AGENTS.md does NOT falsely report codex (it is a universal standard now)', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-detect-'));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-home2-'));
  t.after(() => Promise.all([fs.rm(dir, { recursive: true, force: true }), fs.rm(home, { recursive: true, force: true })]));

  await fs.writeFile(path.join(dir, 'AGENTS.md'), '# rules\n');
  const bare = await detectHosts(dir, home);
  assert.ok(!bare.all.includes('codex'), 'AGENTS.md alone must not imply codex is installed');

  // But a real .codex marker IS detected.
  await fs.mkdir(path.join(dir, '.codex'), { recursive: true });
  const withCodex = await detectHosts(dir, home);
  assert.ok(withCodex.all.includes('codex'), '.codex marker must be detected');
});

test('INSTALL: MCP targets cover the major hosts, split by scope', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-mcp-'));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-home-'));
  t.after(() => Promise.all([
    fs.rm(dir, { recursive: true, force: true }),
    fs.rm(home, { recursive: true, force: true }),
  ]));

  const all = mcpTargets(dir, home, { scope: 'all' }).map((x) => x.host).join(' ');
  for (const expected of ['claude-code', 'cursor', 'vscode', 'devin-desktop', 'gemini-cli', 'zed', 'continue']) {
    assert.match(all, new RegExp(expected), `MCP target list should include ${expected}`);
  }

  // Default scope must be PROJECT ONLY — no path may point outside the repo.
  for (const t2 of mcpTargets(dir, home)) {
    assert.equal(t2.scope, 'project');
    assert.ok(t2.file.startsWith(dir), `default scope leaked outside the repo: ${t2.file}`);
  }
});

test('INSTALL: each host gets the entry SHAPE it actually reads', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-shapes-'));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-shapeshome-'));
  t.after(() => Promise.all([
    fs.rm(dir, { recursive: true, force: true }),
    fs.rm(home, { recursive: true, force: true }),
  ]));

  const { installMcp, mcpServerEntry } = await import('../../src/integrate/adapters.mjs');

  // Verified against a live `opencode debug config`: opencode reads
  //   mcp: { name: { type: "local", command: [...] } }
  // NOT the mcpServers/{command,args} shape everyone else uses. Writing the wrong shape
  // produces a config the host silently ignores — installed, and inert.
  const oc = mcpServerEntry('holt', 'opencode');
  assert.equal(oc.type, 'local');
  assert.deepEqual(oc.command, ['holt', 'mcp']);

  const std = mcpServerEntry('holt');
  assert.equal(std.command, 'holt');
  assert.deepEqual(std.args, ['mcp']);

  // A bin carrying arguments must be split, not passed whole — same defect class that made the
  // OpenCode plugin gate fail open.
  const withArgs = mcpServerEntry('node /path/to/holt.mjs', 'opencode');
  assert.deepEqual(withArgs.command, ['node', '/path/to/holt.mjs', 'mcp']);
  const stdWithArgs = mcpServerEntry('npx holt');
  assert.equal(stdWithArgs.command, 'npx');
  assert.deepEqual(stdWithArgs.args, ['holt', 'mcp']);

  // And end-to-end: the file opencode reads must contain the opencode shape.
  await installMcp(dir, { home, scope: 'project' });
  const written = JSON.parse(await fs.readFile(path.join(dir, 'opencode.json'), 'utf8'));
  assert.equal(written.mcp.holt.type, 'local');
  assert.ok(Array.isArray(written.mcp.holt.command));
});

test('INSTALL: user-global config is NEVER created from nothing', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-mcp2-'));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-home2-'));
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-int-'));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-inthome-'));
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
  assert.match(JSON.stringify(settings.hooks), /holt hook/);
});

test('ADAPTER: the generated OpenCode plugin is syntactically valid JS', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-oc-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const file = path.join(dir, 'holt.mjs');
  await fs.writeFile(file, opencodePlugin('holt'), 'utf8');
  // Importing proves it parses; the plugin exports a factory and runs nothing on import.
  const mod = await import(`file://${file}`);
  assert.equal(typeof mod.holt, 'function', 'plugin must export a holt factory');
});

test('ADAPTER: Claude Code hook config targets Bash and all three events', () => {
  const h = claudeCodeHooks('holt');
  assert.equal(h.PreToolUse[0].matcher, 'Bash');
  for (const evt of ['PreToolUse', 'SessionStart', 'UserPromptSubmit']) {
    assert.ok(h[evt], `missing ${evt}`);
    assert.match(JSON.stringify(h[evt]), /holt hook/);
  }
});

test('ADAPTER: host detection reports only what exists', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-detect-'));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-detecthome-'));
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
  const block = agentsMdBlock('holt');
  assert.match(block, /exit code/i);
  assert.match(block, /holt gate/);
  assert.match(block, /holt context/);
  assert.match(block, /--json/, 'agents need to know machine output exists');
});

test('HOSTS: the manifest is well-formed and holt is honest about strength', async () => {
  const { HOSTS, strengthLabel, CLOUD_CAVEAT } = await import('../../src/integrate/hosts.mjs');
  assert.ok(HOSTS.length >= 18, 'the manifest should cover the real 2026 landscape');
  const ids = new Set();
  for (const h of HOSTS) {
    assert.ok(h.id && h.name, 'every host needs an id and name');
    assert.ok(!ids.has(h.id), `duplicate host id ${h.id}`); ids.add(h.id);
    assert.ok(['block', 'mcp', 'advisory', 'git'].includes(h.strength), `${h.id}: bad strength`);
    assert.ok(['local', 'cloud'].includes(h.env), `${h.id}: bad env`);
    // Honesty invariant: a cloud host can NEVER be reported as blocking — the lock cannot apply.
    if (h.env === 'cloud') assert.notEqual(h.strength, 'block', `${h.id}: a cloud host must not claim blocking`);
    assert.ok(strengthLabel(h).length > 0);
  }
  // TWO GRADES OF "BLOCKING", AND THE DIFFERENCE IS LOAD-BEARING.
  //
  // `verifiedLive` means holt has been DRIVEN against the real host and observed to deny. Only
  // Claude Code and OpenCode have been. Cursor's adapter is written from Cursor's own published
  // hook schema — better than the guess this project has always refused to ship, and still not
  // the same claim. Collapsing the two would let a documentation-derived adapter inherit the
  // credibility of a demonstrated one, which is the overclaim this test exists to stop.
  const blocking = HOSTS.filter((h) => h.strength === 'block').map((h) => h.id).sort();
  const live = HOSTS.filter((h) => h.strength === 'block' && h.verifiedLive === true).map((h) => h.id).sort();
  assert.deepEqual(live, ['claude-code', 'opencode'],
    'only adapters actually driven against the real host may claim VERIFIED blocking');
  for (const h of HOSTS.filter((x) => x.strength === 'block')) {
    assert.equal(typeof h.verifiedLive, 'boolean',
      `${h.id} claims blocking without stating whether it has been verified live`);
    assert.match(h.note, /verified|not guessed|deterministic/i,
      `${h.id} claims blocking but its note does not say what that claim rests on`);
  }
  assert.ok(blocking.length >= live.length, 'sanity: verified blocking is a subset of blocking');
  assert.match(CLOUD_CAVEAT, /do not apply to cloud/i, 'the cloud limit must be stated plainly');
});

test('HOSTS: hostsReport marks what is detected and never claims cloud blocking', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-hosts-'));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-hosthome-'));
  t.after(() => Promise.all([fs.rm(dir, { recursive: true, force: true }), fs.rm(home, { recursive: true, force: true })]));
  const { hostsReport } = await import('../../src/integrate/adapters.mjs');

  await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
  const rep = await hostsReport(dir, home);
  // Counts blocking adapters, of which only a subset has been driven live — see the manifest
  // test above for why the two grades are kept apart.
  assert.ok(rep.counts.blocking >= 2, `at least the two verified adapters block: ${rep.counts.blocking}`);
  assert.ok(rep.detectedHere.includes('Claude Code'), 'a real marker is detected');
  // Was >= 3 (Jules, Replit, Amazon Q). Amazon Q Developer was reclassified: its detection markers
  // (.amazonq / .aws/amazonq) belong to the Q Developer CLI, a LOCAL terminal agent with a real,
  // confirmed MCP config — not the cloud-only surface the row previously assumed. See hosts.mjs.
  const cloud = rep.hosts.filter((h) => h.env === 'cloud');
  assert.ok(cloud.length >= 2, 'the cloud segment is enumerated');
  for (const c of cloud) assert.match(c.label, /cloud/i, 'cloud hosts are labelled as such');
});

test('GATE: rm -rf is caught for ANY worktree path, not only ones named "wt"', async (t) => {
  // The rm rule previously required 'worktree'/'wt' in the path, so `rm -rf ../my-feature` — the
  // most natural way to delete a worktree — bypassed the one defence holt has against rm.
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const target = fx.wt('uniqueUncommitted'); // path contains no 'wt' token
  const v = await assessCommand(`rm -rf ${target}`, fx.root);
  assert.equal(v.decision, 'deny', `rm of a work-holding worktree must be denied: ${JSON.stringify(v)}`);
  assert.ok(v.targets.includes('uniqueUncommitted'));
});

test('GATE: broadening rm did NOT make it trigger-happy — ordinary deletes stay allowed', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());
  for (const cmd of ['rm -rf node_modules', 'rm -rf dist', 'rm -rf ./build', 'rm -f /tmp/scratch.log', 'rm -rf coverage']) {
    const v = await assessCommand(cmd, fx.root);
    assert.equal(v.decision, 'allow', `${cmd} must stay allowed: ${JSON.stringify(v)}`);
  }
});

test('COVERAGE: mutation verbs are blocked, not only the deletion verb', async (t) => {
  // A lock stops `git worktree remove`. It does NOT stop the commands that destroy the SAME
  // uncommitted work in place — and those are the ones that actually cost this project work
  // during its own development. Deleting a worktree and hard-resetting it are the same loss.
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());
  const wt = fx.wt('uniqueUncommitted');

  for (const cmd of [
    'git reset --hard HEAD', 'git reset --hard origin/main',
    'git clean -fd', 'git clean -fdx',
    'git checkout -- .', 'git restore --worktree .',
  ]) {
    const v = await assessCommand(cmd, wt);
    assert.equal(v.decision, 'deny', `${cmd} destroys uncommitted work and must be denied: ${JSON.stringify(v)}`);
    assert.match(v.reason, /exists nowhere else/i, `${cmd} must say what is at stake`);
  }
});

test('COVERAGE: the same verbs are ALLOWED where there is nothing to lose (never-worse)', async (t) => {
  // The rule must be invisible in normal use. A clean worktree has nothing to protect, so
  // resetting it is ordinary work — blocking it would make holt the thing people uninstall.
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  for (const cmd of ['git reset --hard HEAD', 'git clean -fd', 'git checkout -- .']) {
    const v = await assessCommand(cmd, fx.wt('empty'));
    assert.equal(v.decision, 'allow', `${cmd} in a clean worktree must stay allowed: ${JSON.stringify(v)}`);
  }
  for (const cmd of ['git reset --soft HEAD~1', 'git checkout -b feature', 'git status', 'git clean -n']) {
    const v = await assessCommand(cmd, fx.wt('uniqueUncommitted'));
    assert.equal(v.decision, 'allow', `${cmd} is not destructive and must be allowed: ${JSON.stringify(v)}`);
  }
});

test('COVERAGE: the PRIMARY worktree is protected, though git refuses to lock it', async (t) => {
  // Structural gap: `git worktree lock` cannot lock the main worktree, so there the hook is the
  // ONLY protection — and it was excluded from the scan entirely.
  const fx = await newRepo('primary-guard');
  t.after(() => fx.cleanup());
  await fs.writeFile(path.join(fx.root, 'main-only.js'), 'export function MAIN_ONLY() {}\n');

  const v = await assessCommand('git reset --hard HEAD', fx.root);
  assert.equal(v.decision, 'deny', `uncommitted work in the MAIN tree must be defended: ${JSON.stringify(v)}`);
});

test('COVERAGE: git -C redirects which worktree a path-less verb acts on', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());
  const v = await assessCommand(`git -C ${fx.wt('uniqueUncommitted')} reset --hard`, fx.root);
  assert.equal(v.decision, 'deny', `-C must be followed to the real target: ${JSON.stringify(v)}`);
});

/* ------------------------------------------------------ THE GUARD ASYMMETRY ---- */

/**
 * TONIGHT'S INCIDENT, IN TWO HALVES.
 *
 * `git stash` (create) is a working-tree-wide sweep with no path argument — the same shape as
 * `reset --hard` and `clean -fd`, which this table already evidence-gates — and it was let
 * through unconditionally instead. Run in a working tree several agents were editing at once, it
 * took every one of their uncommitted edits into a single stash entry: the tree went clean and
 * nobody had been asked.
 *
 * `git stash pop` is the RECOVERY from exactly that, and it was a flat deny: an agent that had
 * just lost its siblings' work to a bare stash was then blocked from putting any of it back.
 * Over-refusal is not the safe failure mode here — it is the second half of the same incident.
 *
 * Both halves get the SAME fix: evidence-gated, capped at 'ask', never silent and never a wall.
 */
/** One-line git for tests that have to establish what the REAL command does. */
const gitIn = (args, cwd) => new Promise((res) => {
  execFile('git', args, { cwd, env: { ...process.env } },
    (e, so, se) => res({ code: e?.code ?? 0, out: String(so ?? ''), err: String(se ?? '') }));
});

test('COVERAGE: bare `git stash`/`stash push`/`stash save` are evidence-gated — ask, not a silent allow', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());
  const wt = fx.wt('uniqueUncommitted');
  // A TRACKED MODIFICATION IS WHAT A BARE `git stash` ACTUALLY SWEEPS. The fixture's own
  // `only_uncommitted.js` is UNTRACKED, which bare stash provably leaves alone (asserted in the
  // never-worse test below), so gating the bare forms on it would be asserting a refusal about
  // work the command cannot touch. Give the worktree something bare stash really does take.
  await fs.writeFile(path.join(wt, 'src/base.js'), 'export function baseline() { return 42; }\n');

  for (const cmd of ['git stash', 'git stash push', 'git stash push -u', 'git stash push -u -m wip', 'git stash save wip']) {
    const v = await assessCommand(cmd, wt);
    assert.equal(v.decision, 'ask',
      `${cmd} against work that exists nowhere else must ASK — never silently sweep it, and never flatly refuse ordinary stashing: ${JSON.stringify(v)}`);
    assert.match(v.reason, /uncommitted/i, `${cmd} must say what is at stake: ${v.reason}`);
    assert.match(v.reason, /workstream/i, `${cmd} must say WHICH workstream(s): ${v.reason}`);
    assert.match(v.reason, /git stash (list|apply)/, `${cmd} must name the recovery path: ${v.reason}`);
    assert.match(v.reason, /src\/base\.js/, `${cmd} must name the file it would sweep: ${v.reason}`);
  }
});

test('COVERAGE: stash — NEVER-WORSE half: a clean worktree has nothing to sweep, and stays allowed', async (t) => {
  // The rule must be invisible in ordinary use, exactly like reset --hard and clean -fd above.
  // Getting this half wrong — turning "ask sometimes" into "ask always" — is the failure mode
  // this whole project's standing rules call out by name: refusing (or interrupting) everything
  // is trivially safe and worthless.
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  for (const cmd of ['git stash', 'git stash push', 'git stash push -u', 'git stash save wip']) {
    const v = await assessCommand(cmd, fx.wt('empty'));
    assert.equal(v.decision, 'allow', `${cmd} in a clean worktree must stay allowed: ${JSON.stringify(v)}`);
  }
});

test('COVERAGE: stash SCOPED to a pathspec is deliberate and bounded — it stays allowed, not asked', async (t) => {
  // `git stash push -- <path>` (or the equivalent bare `git stash -- <path>`) sweeps only the
  // files the invoker named. That is the scoped, deliberate act this fix is supposed to leave
  // alone — asking about it would be the exact over-refusal this rule exists to avoid.
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());
  const wt = fx.wt('uniqueUncommitted');

  for (const cmd of [
    'git stash push -- src/only_uncommitted.js',
    'git stash -- src/only_uncommitted.js',
    'git stash push -u -- src/only_uncommitted.js',
    'git stash push -m "wip" -- src/only_uncommitted.js',
  ]) {
    const v = await assessCommand(cmd, wt);
    assert.equal(v.decision, 'allow',
      `a pathspec bounds the blast radius on purpose, and must not be asked about: ${cmd}: ${JSON.stringify(v)}`);
  }

  // `save` is the one exception: it has NO pathspec support in git at all, so trailing words are
  // always a message, never a path — it must stay in the evidence-gated, ask-on-dirty bucket.
  //
  // "ON DIRTY" IS LOAD-BEARING, AND THIS TEST ONCE ASSERTED IT WITHOUT IT. Against this
  // worktree — whose only content is UNTRACKED — the identical command is a proven no-op, so the
  // old expectation of `ask` here was the very defect the CATASTROPHIC tests below exist to
  // catch, sitting inside the test meant to pin the exemption. Both halves are proven with the
  // real command rather than assumed.
  const noop = await gitIn(['stash', 'save', 'src/only_uncommitted.js'], wt);
  assert.match(noop.out, /No local changes to save/,
    `premise: bare save cannot reach an untracked file, so here it is a no-op: ${JSON.stringify(noop)}`);
  assert.equal((await gitIn(['stash', 'list'], wt)).out, '', 'premise: and queued nothing');
  assert.equal((await assessCommand('git stash save src/only_uncommitted.js', wt)).decision, 'allow',
    'a no-op must not be asked about, however its trailing word is spelled');

  // Give it something bare `save` really does sweep, and the message word stays a message.
  await fs.writeFile(path.join(wt, 'src/base.js'), 'export function baseline() { return 42; }\n');
  const saveV = await assessCommand('git stash save src/only_uncommitted.js', wt);
  assert.equal(saveV.decision, 'ask',
    `save cannot be scoped to a path — its trailing words are a message, so it still sweeps everything: ${JSON.stringify(saveV)}`);
  assert.match(saveV.reason, /src\/base\.js/,
    `and what it sweeps is the tracked modification, not the word that looks like a path: ${saveV.reason}`);

  // The same dirty tree, scoped for real: still allowed. Without this the assertion above could
  // be satisfied by a rule that simply asks about everything once anything is dirty.
  assert.equal((await assessCommand('git stash push -- src/only_uncommitted.js', wt)).decision, 'allow',
    'a real pathspec still bounds the blast radius, dirty tree or not');
});

test('COVERAGE: `git stash pop` stops being a flat deny — it is the recovery action, not a new act', async (t) => {
  // MEASURED: an agent that had just had eleven siblings' work swept into the stash by a bare
  // `git stash` was then BLOCKED from putting any of it back with `pop`. A guard that blocks the
  // only way back is not protecting anyone.
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());
  const wt = fx.wt('uniqueUncommitted');

  // THE EVIDENCE FOR pop/drop/clear IS THE STASH ITSELF, so the entry has to exist before any of
  // these verbs means anything. Sweep the fixture's uncommitted work into a real stash entry —
  // the exact incident shape — and assert against a stash that genuinely holds something.
  const swept = await gitIn(['stash', 'push', '-u', '-m', 'incident'], wt);
  assert.equal(swept.code, 0, `fixture setup: the sweep must succeed: ${swept.err}`);
  const list = await gitIn(['stash', 'list'], wt);
  assert.match(list.out, /stash@\{0\}/, `fixture setup: an entry must exist: ${JSON.stringify(list)}`);

  const v = await assessCommand('git stash pop', wt);
  assert.equal(v.decision, 'ask', `pop must ask, never flatly deny the only way back: ${JSON.stringify(v)}`);
  assert.match(v.reason, /git stash apply/,
    `the message must name apply as the entry-preserving equivalent: ${v.reason}`);

  // `drop`/`clear` are genuinely final — dropping IS the destructive act, with no equivalent that
  // keeps the entry — and stay denied outright. If this fix had accidentally softened those too,
  // it would be the conservative-sounding change that is actually a regression: a real loss with
  // no confirmation step at all instead of one.
  for (const cmd of ['git stash drop', 'git stash clear']) {
    const d = await assessCommand(cmd, wt);
    assert.equal(d.decision, 'deny', `${cmd} is genuinely final and must stay denied: ${JSON.stringify(d)}`);
  }
});

/* ------------------------------------------- THE STASH'S REAL BLAST RADIUS ---- */

/**
 * A STASH CANNOT TOUCH COMMITTED HISTORY, SO COMMITTED HISTORY IS NOT EVIDENCE ABOUT A STASH.
 *
 * The rules above were gated on the workstream's whole `safe` flag — the right evidence for
 * "would DELETING this workstream lose something", built from committed deltas, uncommitted
 * counts and unique-symbol reasons that span every layer. Aimed at `git stash` it was not merely
 * cautious, it was FALSE: reproduced on the standard fixture, the `uniqueCommitted` worktree has
 * a verified-empty `git status` and a real `git stash` there prints "No local changes to save" —
 * a guaranteed no-op — yet holt asked, citing `callable:COMMITTED_ONLY_SYMBOL`, which is safely
 * committed history that no stash verb can reach.
 *
 * A guard whose stated reason is checkably untrue is worse than one that stays quiet: the next
 * reader learns to discount every message it prints.
 *
 * So every stash verdict is weighed against the evidence THAT verb can actually destroy:
 *   sweep (`stash`/`push`/`save`)  the uncommitted (+ untracked with -u, + ignored with -a) layers
 *                                  of the one worktree it runs in — never a commit
 *   pop / drop / clear             `git stash list` — an empty stash cannot lose anything
 */
const COMMITTED_EVIDENCE = /base lacks|found nowhere else|COMMITTED_ONLY_SYMBOL/;

test('CATASTROPHIC: a stash verdict never rests on committed-layer evidence a stash cannot touch', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());
  const wt = fx.wt('uniqueCommitted');

  // ---- the premise, proven rather than assumed ------------------------------------------
  const st = await gitIn(['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching'], wt);
  assert.equal(st.out, '', `premise: uniqueCommitted's status must be empty: ${JSON.stringify(st)}`);
  const real = await gitIn(['stash'], wt);
  assert.match(real.out, /No local changes to save/,
    `premise: a real bare stash here must be a proven no-op: ${JSON.stringify(real)}`);

  // ---- the verdict must match the fact ----------------------------------------------------
  for (const cmd of ['git stash', 'git stash push', 'git stash push -u', 'git stash save wip']) {
    const v = await assessCommand(cmd, wt);
    assert.equal(v.decision, 'allow',
      `${cmd} is a no-op in a worktree with a clean status — committed work is not at stake and asking about it is a false alarm: ${JSON.stringify(v)}`);
  }

  // ---- and when the sweep DOES have something to take, it says only what it takes ---------
  await fs.writeFile(path.join(wt, 'src/base.js'), 'export function baseline() { return 7; }\n');
  const v = await assessCommand('git stash', wt);
  assert.equal(v.decision, 'ask', `a tracked modification IS swept, so this asks: ${JSON.stringify(v)}`);
  assert.match(v.reason, /src\/base\.js/, `it must name the file it sweeps: ${v.reason}`);
  assert.doesNotMatch(v.reason, COMMITTED_EVIDENCE,
    'the reason must not cite committed-layer evidence — `git stash` cannot reach a commit, '
    + `and a reason that is factually false is the defect: ${v.reason}`);
  assert.doesNotMatch(v.reason, /only_committed\.js/,
    `nor name a committed file as being at stake: ${v.reason}`);
});

test('CATASTROPHIC: pop/drop/clear are weighed against `git stash list`, not against the worktrees', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());
  const wt = fx.wt('uniqueUncommitted');

  // ---- an EMPTY stash: there is nothing any of these verbs can destroy --------------------
  const empty = await gitIn(['stash', 'list'], wt);
  assert.equal(empty.out, '', `premise: the fixture starts with no stash entries: ${JSON.stringify(empty)}`);
  for (const cmd of ['git stash pop', 'git stash drop', 'git stash clear', 'git stash drop stash@{2}']) {
    const v = await assessCommand(cmd, wt);
    assert.equal(v.decision, 'allow',
      `${cmd} against an EMPTY stash cannot lose anything — refusing it is a refusal about work that does not exist: ${JSON.stringify(v)}`);
  }

  // ---- a REAL entry: now they matter, and the evidence is the entry ------------------------
  const swept = await gitIn(['stash', 'push', '-u', '-m', 'incident'], wt);
  assert.equal(swept.code, 0, `setup: ${swept.err}`);
  assert.match((await gitIn(['stash', 'list'], wt)).out, /stash@\{0\}/, 'setup: an entry must exist');

  const dropped = await assessCommand('git stash drop', wt);
  assert.equal(dropped.decision, 'deny', `dropping a real entry is final: ${JSON.stringify(dropped)}`);
  assert.match(dropped.reason, /stash@\{0\}/, `and must name the entry it would destroy: ${dropped.reason}`);
  assert.doesNotMatch(dropped.reason, COMMITTED_EVIDENCE,
    `a stash verdict must not be justified by committed history: ${dropped.reason}`);

  const popped = await assessCommand('git stash pop', wt);
  assert.equal(popped.decision, 'ask', `pop stays the recovery action: ${JSON.stringify(popped)}`);
  assert.match(popped.reason, /git stash apply/, `naming apply: ${popped.reason}`);
  assert.doesNotMatch(popped.reason, COMMITTED_EVIDENCE,
    `and not resting on committed history either: ${popped.reason}`);
});

test('CATASTROPHIC: a drop is weighed against the ONE entry it removes, not the whole stash', async (t) => {
  // The last scope error of the same family. `git stash drop`/`pop` with no selector remove
  // stash@{0} and nothing else — verified below with the real command — so justifying a refusal
  // with an older entry's contents is a warning about work the command provably cannot reach,
  // exactly like citing a commit was.
  const fx = await newRepo('stash-scope');
  t.after(() => fx.cleanup());
  const root = fx.root;

  // stash@{1}: content that lives NOWHERE else once it is dropped.
  await fs.writeFile(path.join(root, 'src/base.js'), 'export function baseline() { return 111; }\n');
  assert.equal((await gitIn(['stash', 'push', '-m', 'older-and-unique'], root)).code, 0, 'setup');
  // stash@{0}: content that is ALSO committed, so dropping it loses nothing.
  await fs.writeFile(path.join(root, 'config/registry.mjs'), 'export const REGISTRY = { LANDED: 1 };\n');
  assert.equal((await gitIn(['stash', 'push', '-m', 'newer-and-landed'], root)).code, 0, 'setup');
  await fs.writeFile(path.join(root, 'config/registry.mjs'), 'export const REGISTRY = { LANDED: 1 };\n');
  await gitIn(['add', '-A'], root);
  assert.equal((await gitIn(['commit', '-m', 'land the newer content'], root)).code, 0, 'setup');

  const list = (await gitIn(['stash', 'list'], root)).out;
  assert.match(list, /stash@\{0\}: On main: newer-and-landed/, `setup: ${list}`);
  assert.match(list, /stash@\{1\}: On main: older-and-unique/, `setup: ${list}`);

  // ---- the premise, from git itself: a bare drop takes stash@{0} ONLY --------------------
  const probe = await newRepo('stash-scope-probe');
  t.after(() => probe.cleanup());
  await fs.writeFile(path.join(probe.root, 'src/base.js'), 'a\n');
  await gitIn(['stash'], probe.root);
  await fs.writeFile(path.join(probe.root, 'src/base.js'), 'b\n');
  await gitIn(['stash'], probe.root);
  const dropOut = await gitIn(['stash', 'drop'], probe.root);
  assert.match(dropOut.out, /Dropped refs\/stash@\{0\}/, `premise: ${JSON.stringify(dropOut)}`);
  assert.match((await gitIn(['stash', 'list'], probe.root)).out, /^stash@\{0\}/,
    'premise: and the older entry survives it');

  // ---- so the verdict follows the entry the command actually removes ----------------------
  const bare = await assessCommand('git stash drop', root);
  assert.equal(bare.decision, 'allow',
    `stash@{0}'s content is committed, so dropping it loses nothing — refusing on stash@{1}'s `
    + `contents is a refusal about an entry this command cannot touch: ${JSON.stringify(bare)}`);

  const older = await assessCommand('git stash drop stash@{1}', root);
  assert.equal(older.decision, 'deny',
    `stash@{1} holds the only copy and IS destroyed by this: ${JSON.stringify(older)}`);
  assert.match(older.reason, /stash@\{1\}/, `naming the entry it destroys: ${older.reason}`);
  assert.doesNotMatch(older.reason, /stash@\{0\}/,
    `and not the one it leaves alone: ${older.reason}`);

  // `clear` is the verb that really does take everything, and it must still see stash@{1}.
  const cleared = await assessCommand('git stash clear', root);
  assert.equal(cleared.decision, 'deny', `clear takes every entry: ${JSON.stringify(cleared)}`);
  assert.match(cleared.reason, /stash@\{1\}/, `including the unique one: ${cleared.reason}`);
});

test('CATASTROPHIC: an entry whose content a ref now holds stops being refused — landing work relaxes the guard', async (t) => {
  // CONSERVATIVE IS NOT CORRECT. A stash commit is unreachable from a branch BY CONSTRUCTION, so
  // "is this entry reachable" refuses every drop forever and teaches people to switch the guard
  // off. The honest question is whether the CONTENT is reachable — and doing the right thing
  // (apply it, commit it) must visibly change the answer, or the guard is just a nag.
  const fx = await newRepo('stash-relax');
  t.after(() => fx.cleanup());
  const root = fx.root;

  await fs.writeFile(path.join(root, 'src/base.js'), 'export function baseline() { return 99; }\n');
  assert.equal((await gitIn(['stash', 'push', '-m', 'wip'], root)).code, 0, 'setup');
  assert.match((await gitIn(['stash', 'list'], root)).out, /stash@\{0\}/, 'setup: one entry');

  const before = await assessCommand('git stash drop', root);
  assert.equal(before.decision, 'deny',
    `while the stash is the only copy, dropping it is final: ${JSON.stringify(before)}`);

  // Do the right thing: bring it back and commit it. The ENTRY is untouched — same commit, same
  // reflog position — and only the content's reachability changed.
  assert.equal((await gitIn(['stash', 'apply'], root)).code, 0, 'setup: apply');
  await gitIn(['add', '-A'], root);
  assert.equal((await gitIn(['commit', '-m', 'land the wip'], root)).code, 0, 'setup: commit');
  assert.match((await gitIn(['stash', 'list'], root)).out, /stash@\{0\}/,
    'premise: the entry is STILL there — nothing about it changed');

  const after = await assessCommand('git stash drop', root);
  assert.equal(after.decision, 'allow',
    `the identical blob is now in a ref's history, so the entry holds nothing unique and the `
    + `guard must step back: ${JSON.stringify(after)}`);
  assert.equal((await assessCommand('git stash clear', root)).decision, 'allow',
    'and clear likewise — there is nothing left for either verb to lose');
});

test('CATASTROPHIC: a bare stash is judged on what bare stash sweeps — untracked needs -u', async (t) => {
  // The same class as the committed-evidence bug, one layer down: `git stash` with no `-u` does
  // not touch untracked files at all, so refusing it because untracked work exists is a refusal
  // about work the command provably leaves on disk. Proven here with the real command.
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());
  const wt = fx.wt('uniqueUncommitted');
  const only = path.join(wt, 'src/only_uncommitted.js');

  const st = await gitIn(['status', '--porcelain=v1', '--untracked-files=all'], wt);
  assert.equal(st.out.trim(), '?? src/only_uncommitted.js',
    `premise: the only content here is UNTRACKED: ${JSON.stringify(st)}`);

  const real = await gitIn(['stash'], wt);
  assert.match(real.out, /No local changes to save/,
    `premise: a bare stash here is a proven no-op: ${JSON.stringify(real)}`);
  assert.ok(await fs.stat(only).then(() => true, () => false),
    'premise: and the untracked file is still on disk afterwards');
  assert.equal((await gitIn(['stash', 'list'], wt)).out, '',
    'premise: with nothing queued in the stash');

  assert.equal((await assessCommand('git stash', wt)).decision, 'allow',
    'so the bare form must be allowed — it cannot reach the untracked file');
  assert.equal((await assessCommand('git stash push', wt)).decision, 'allow',
    'same command, same answer');

  // …and the flags that DO reach it are still gated, which is what makes the allow above a
  // measurement rather than a hole.
  for (const cmd of ['git stash -u', 'git stash push -u', 'git stash push --include-untracked', 'git stash -a']) {
    const v = await assessCommand(cmd, wt);
    assert.equal(v.decision, 'ask', `${cmd} DOES sweep untracked work and must ask: ${JSON.stringify(v)}`);
    assert.match(v.reason, /only_uncommitted\.js/, `naming it: ${v.reason}`);
  }
});

test('COVERAGE: stash pop/push NEVER-WORSE — clean repositories never see either message', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());
  const empty = fx.wt('empty');

  // `pop`'s evidence is gathered across every workstream (the shared refs/stash), so this only
  // proves the never-worse property when EVERY workstream in the fixture is actually clean —
  // which 'empty' alone does not guarantee, since standardFixture's other worktrees hold real
  // work. So this asserts the narrower, still-real claim: a repository where nothing anywhere is
  // at risk allows pop outright. Build one fresh, single-worktree repo for it.
  const clean = await newRepo('stash-clean');
  t.after(() => clean.cleanup());
  const popV = await assessCommand('git stash pop', clean.root);
  assert.equal(popV.decision, 'allow', `pop with nothing at risk anywhere must be allowed: ${JSON.stringify(popV)}`);

  const pushV = await assessCommand('git stash push', empty);
  assert.equal(pushV.decision, 'allow', `push in a clean worktree must be allowed: ${JSON.stringify(pushV)}`);
});

/* ------------------------------------------- FILE-GRANULAR DESTRUCTION ---- */

/**
 * MEASURED, before this suite existed: holt denied `git reset --hard` on a dirty tree and ALLOWED
 * every one of `rm <file>`, `git rm -f <file>`, `truncate -s0 <file>`, `shred <file>`,
 * `mv <file> /tmp/x` and `> <file>` against the exact file it itself reported as existing nowhere
 * else — 9 spellings, 9 allows. The rules reasoned about WORKTREES; the loss happens one file at
 * a time.
 *
 * Every deny below has its allow twin, because a guard that denies ordinary file deletion is
 * uninstalled the same day. That is the harder half and it is asserted first.
 */
/**
 * Match a workstream to a directory the way the PRODUCT does — canonicalised, and case-folded on
 * the platforms whose filesystems are case-insensitive.
 *
 * A raw `path.resolve()` comparison silently finds nothing on macOS (/var is a symlink to
 * /private/var) and on Windows (8.3 short names), so a test using one does not fail loudly — it
 * quietly measures an empty set and then asserts things about it. src/agent.mjs already learned
 * this the expensive way: `rm -rf <worktree>` was ALLOWED on both platforms for the same reason.
 */
async function findWorkstreamByPath(workstreams, dir) {
  const real = async (x) => {
    const abs = path.resolve(x);
    try { return await fs.realpath(abs); } catch { return abs; }
  };
  const fold = (x) => (process.platform === 'win32' || process.platform === 'darwin' ? x.toLowerCase() : x);
  const want = fold(await real(dir));
  for (const w of workstreams) {
    if (w.path && fold(await real(w.path)) === want) return w;
  }
  return undefined;
}

async function fileRiskFixture() {
  const fx = await newRepo('file-risk');
  await fx.write('.gitignore', 'node_modules/\ndist/\nbuild/\ncoverage/\n*.log\n.env\nsecrets/\n');
  await fx.write('src/committed.js', 'export function COMMITTED_HERE() {}\n');
  await fx.write('docs/guide.md', '# guide\n');
  await fx.commit('ignore rules, a committed source file and a committed doc');

  // --- content whose ONLY copy is on disk -----------------------------------------
  await fx.write('src/only_here.js', 'export function ONLY_HERE() {}\n');            // untracked
  await fx.write('notes.md', 'an hour of design notes\n');                           // untracked
  await fx.write('src/base.js', 'export function baseline() { return 99; }\n');       // MODIFIED
  await fx.write('.env', 'API_KEY=live\n');                                          // gitignored
  await fx.write('secrets/prod.env', 'TOKEN=live\n');                        // ignored DIRECTORY

  // --- regenerable noise, which must never be defended ----------------------------
  await fx.write('node_modules/dep/index.js', 'module.exports = 1;\n');
  await fx.write('dist/bundle.js', 'x\n');
  await fx.write('build/out.js', 'x\n');
  await fx.write('coverage/lcov.info', 'TN:\n');
  await fx.write('app.log', 'line\n');
  return fx;
}

test('FILE GATE: ordinary file operations stay allowed — the never-worse half', async (t) => {
  const fx = await fileRiskFixture();
  t.after(() => fx.cleanup());

  const mustAllow = [
    // regenerable output, by holt's own generated-file rule — never by a name allowlist
    'rm -rf node_modules', 'rm -rf ./node_modules', 'rm -rf dist', 'rm build/out.js',
    'rm -rf coverage', 'rm app.log', 'truncate -s0 app.log', '> app.log',
    'rm -rf dist/* build/*', 'shred -u coverage/lcov.info',
    // committed content: a commit still holds it, so removing the file is recoverable
    'rm src/committed.js', 'git rm -f src/committed.js', 'rm -rf docs', '> src/committed.js',
    'mv src/committed.js /tmp/elsewhere.js',
    // nothing there to lose
    'rm -f does-not-exist.txt', '> fresh-report.json', 'node build.js > report.html',
    // outside every worktree
    'rm -rf /tmp/scratch', 'echo hi > /dev/null', 'cargo test > /tmp/test.log 2>&1',
    'cd /tmp && rm -f notes.md', 'cd && rm notes.md',
    // not destructive at all
    'git status', 'cat notes.md', 'echo more >> notes.md', 'npm test 2>&1 | tee -a app.log',
    'git rm --cached .env', 'git rm -n notes.md', 'git clean -n',
    // quoting: a '>' inside quotes is not a redirect
    "awk '{if ($1 > 2) print $0}' notes.md", 'git log --pretty=format:"%h -> %s"',
    'echo "notes.md > gone"',
    // a rename inside the worktree moves the content, it does not destroy it
    'mv src/only_here.js src/renamed.js', 'mv notes.md docs/notes.md', 'mv notes.md docs',
    // copying READS the source, and writing INTO a directory does not replace the directory
    'cp src/only_here.js src/only_here.bak.js', 'cp -r src src-backup', 'cp notes.md docs/',
    'cp docs/guide.md dist/guide.md', 'dd if=/dev/zero of=dist/pad.bin bs=1M count=1',
  ];
  for (const cmd of mustAllow) {
    const v = await assessCommand(cmd, fx.root);
    assert.equal(v.decision, 'allow', `ordinary operation must stay allowed: ${cmd}\n${v.reason ?? ''}`);
  }
});

test('FILE GATE: the verbs that destroy one file at a time are denied', async (t) => {
  const fx = await fileRiskFixture();
  t.after(() => fx.cleanup());

  // PROVE THE INSTRUMENT SEES PRESENCE before trusting any refusal it produces: holt must
  // already be reporting these exact files as content nothing else holds.
  const { scanned } = await cachedReport(fx.root, { includePrimary: true });
  // CANONICAL comparison, for the same reason the product uses one: path.resolve() makes a path
  // absolute but does NOT resolve symlinks. On macOS os.tmpdir() hands back /var/folders/... while
  // git reports the real /private/var/folders/..., and on Windows a temp path arrives as an 8.3
  // short name — so this lookup found nothing on both, atRiskFiles(undefined) returned nothing,
  // and the test failed at its own PRECONDITION rather than testing anything. Linux has neither
  // quirk, which is exactly why it was green there and only there.
  const ws = await findWorkstreamByPath(scanned.workstreams, fx.root);
  const atRisk = new Set(atRiskFiles(ws));
  for (const f of ['src/only_here.js', 'notes.md', 'src/base.js']) {
    assert.ok(atRisk.has(f), `PRECONDITION: holt must already report ${f} as at risk — got ${[...atRisk]}`);
  }
  assert.ok(!atRisk.has('src/committed.js'), 'a committed file is not at risk');
  assert.ok(![...atRisk].some((f) => f.startsWith('node_modules/') || f.startsWith('dist/')),
    'regenerable output must never be in the at-risk set');

  const mustDeny = [
    'rm src/only_here.js',
    'rm -f notes.md',
    'rm -- notes.md',
    'rm "notes.md"',
    'git rm -f src/base.js',
    'git rm -rf src/only_here.js',
    'truncate -s0 src/base.js',
    'truncate --size=0 notes.md',
    'shred -u src/only_here.js',
    'shred -n 3 notes.md',
    'mv src/only_here.js /tmp/stash.js',
    'mv -t /tmp notes.md',
    '> src/only_here.js',
    'echo "" > notes.md',
    'cat /dev/null > src/base.js',
    'node gen.js &> notes.md',
    'unlink notes.md',
    'rm src/*.js',                       // a glob still resolves to the files it would take
    'rm -rf src',                        // a directory takes everything under it
    'rm -rf secrets',                    // a collapsed ignored directory is still evidence
    'rm .env',
    'cd src && rm only_here.js',         // cd is followed, in both directions
    'sudo rm -f notes.md',
    'npm run build && rm notes.md',
    // SAME ACT, OTHER SPELLINGS. A guard that stops `rm` and `>` while leaving these open just
    // teaches an agent which verb to reach for next.
    'cp /dev/null notes.md',
    'cp docs/guide.md src/only_here.js',
    'dd if=/dev/null of=src/only_here.js',
    'tee notes.md < /dev/null',
    'install -m 644 docs/guide.md notes.md',
  ];
  for (const cmd of mustDeny) {
    const v = await assessCommand(cmd, fx.root);
    assert.equal(v.decision, 'deny', `destroys the only copy and must be denied: ${cmd}`);
    assert.match(v.reason, /only copy is on disk/i, `${cmd} must say what is at stake`);
  }
});

test('FILE GATE: the refusal names the file, its layer and what is inside it', async (t) => {
  const fx = await fileRiskFixture();
  t.after(() => fx.cleanup());

  const v = await assessCommand('rm src/only_here.js', fx.root);
  assert.equal(v.decision, 'deny');
  assert.ok(v.files.includes('src/only_here.js'), `the verdict must carry the file: ${JSON.stringify(v.files)}`);
  assert.match(v.reason, /src\/only_here\.js/, 'the refusal names the path');
  assert.match(v.reason, /untracked/, 'the refusal names the layer the content lives in');
  assert.match(v.reason, /ONLY_HERE/, 'the refusal names a symbol that would be lost');
  assert.match(v.reason, /holt rescue/, 'the refusal says how to proceed');
});

test('FILE GATE: mv is a rename inside a worktree and a loss out of it', async (t) => {
  const fx = await fileRiskFixture();
  t.after(() => fx.cleanup());

  // Same worktree: the content still exists, under a new name. Denying this would break the
  // single most ordinary refactoring move there is.
  for (const cmd of ['mv src/only_here.js src/moved.js', 'mv notes.md docs/notes.md',
    'mv src/only_here.js ./deep/nested/moved.js']) {
    assert.equal((await assessCommand(cmd, fx.root)).decision, 'allow', `a rename must stay allowed: ${cmd}`);
  }
  // Out of the worktree, or onto another at-risk file, and the content is gone.
  for (const cmd of ['mv src/only_here.js /tmp/x.js', 'mv src/only_here.js notes.md']) {
    assert.equal((await assessCommand(cmd, fx.root)).decision, 'deny', `must be denied: ${cmd}`);
  }
});

test('FILE GATE: `>` truncates and `>>` does not — the guard tells them apart', async (t) => {
  const fx = await fileRiskFixture();
  t.after(() => fx.cleanup());

  assert.equal((await assessCommand('> notes.md', fx.root)).decision, 'deny');
  assert.equal((await assessCommand('echo x >> notes.md', fx.root)).decision, 'allow',
    'appending adds to a file, it never destroys it');
  assert.equal((await assessCommand('cmd 2>&1 | tee -a app.log', fx.root)).decision, 'allow',
    'a descriptor duplication names no file at all');
  // Redirecting a command's own diagnostics must not be read as destroying its argument.
  assert.equal((await assessCommand('grep -r ONLY_HERE src 2>/dev/null', fx.root)).decision, 'allow');
});

test('FILE GATE: the fast probe and scan.mjs agree on what is at risk', async (t) => {
  // The guard answers the common case from one `git status` instead of a full scan, so the two
  // definitions of "at risk" must not be able to drift apart. If the probe ever sees LESS than
  // the scan, a file holt reports as unique becomes deletable again — silently.
  const fx = await fileRiskFixture();
  t.after(() => fx.cleanup());

  const { scanned } = await cachedReport(fx.root, { includePrimary: true });
  // CANONICAL comparison, for the same reason the product uses one: path.resolve() makes a path
  // absolute but does NOT resolve symlinks. On macOS os.tmpdir() hands back /var/folders/... while
  // git reports the real /private/var/folders/..., and on Windows a temp path arrives as an 8.3
  // short name — so this lookup found nothing on both, atRiskFiles(undefined) returned nothing,
  // and the test failed at its own PRECONDITION rather than testing anything. Linux has neither
  // quirk, which is exactly why it was green there and only there.
  const ws = await findWorkstreamByPath(scanned.workstreams, fx.root);
  const computed = atRiskFiles(ws);
  assert.ok(computed.length >= 5, `the fixture must plant several at-risk files, got ${computed.length}`);

  for (const f of computed) {
    const v = await assessCommand(`rm ${JSON.stringify(f)}`, fx.root);
    assert.equal(v.decision, 'deny',
      `scan.mjs calls ${f} at risk, so the guard must too — otherwise the probe is blind to it`);
  }
});

test('FILE GATE: target resolution is a pure function of the command string', () => {
  // Kept parse-only so a regression here is diagnosable without a repository.
  const paths = (c) => resolveFileTargets(c).map((t) => `${t.role}:${t.raw}`);

  assert.deepEqual(paths('rm -rf a b'), ['delete:a', 'delete:b'], 'every operand is a target');
  assert.deepEqual(paths('rm -- -weird'), ['delete:-weird'], '`--` ends the flags');
  assert.deepEqual(paths('truncate -s 0 f'), ['truncate:f'], 'an option value is not a target');
  assert.deepEqual(paths('shred -n 3 f'), ['delete:f'], 'shred takes a value-bearing option too');
  assert.deepEqual(paths('git rm --cached f'), [], '--cached leaves the file on disk');
  assert.deepEqual(paths('git rm -n f'), [], 'a dry run destroys nothing');
  assert.deepEqual(paths('echo hi >> f'), [], 'append is not truncation');
  assert.deepEqual(paths('echo hi > f'), ['truncate:f'], 'truncating redirection is');
  assert.deepEqual(paths('cmd 2>&1'), [], 'a descriptor duplication names no file');
  assert.deepEqual(paths("echo 'a > b'"), [], 'a quoted > is not a redirect');
  assert.deepEqual(paths('echo "a > b"'), [], 'in either quote style');
  assert.deepEqual(paths('ls -la'), [], 'a read has no targets');
  assert.deepEqual(paths('docker rm container'), [], 'only the shell verbs, not every word "rm"');
  assert.deepEqual(paths('cp a b'), ['overwrite:b'], 'a copy reads the source and replaces the destination');
  assert.deepEqual(paths('mv a b'), ['move-src:a', 'overwrite:b'], 'a move does both');
  assert.deepEqual(paths('tee -a f'), [], 'tee -a appends');
  assert.deepEqual(paths('tee f'), ['truncate:f'], 'tee without -a truncates');
  assert.deepEqual(paths('dd if=/dev/null of=f'), ['truncate:f'], 'dd destroys of=, never if=');
  assert.deepEqual(
    resolveFileTargets('cd sub && rm f').map((t) => t.baseDir),
    ['sub'],
    'cd moves the base directory the paths resolve against',
  );
  assert.deepEqual(
    resolveFileTargets('git -C other rm f').map((t) => t.baseDir),
    ['other'],
    'git -C does the same for git',
  );
});

test('IDENTITY: rescue works in a repository with no git identity configured', async (t) => {
  // MEASURED BUG: `holt rescue` died with "Author identity unknown" wherever user.name/user.email
  // were unset — a fresh container, a CI runner, a new machine, a locked-down corporate image.
  // The command whose entire purpose is preserving work that exists nowhere else failed exactly
  // when asked to preserve it. It failed CLOSED, so nothing was destroyed; but nothing was saved
  // either, and the user is then one `git worktree remove` from losing it for real.
  const dir = await fs.mkdtemp(path.join(process.env.HOLT_TMPDIR || os.tmpdir(), 'holt-noident-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  // /dev/null for both config files is the only reliable way to make git see NO identity at all.
  const blind = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  const g = (args, cwd) => new Promise((res) => {
    execFile('git', args, { cwd, env: blind }, (e, so, se) => res({ code: e?.code ?? 0, so, se }));
  });

  await g(['init', '-q', '-b', 'main', '.'], dir);
  await fs.writeFile(path.join(dir, 'base.txt'), 'base\n');
  await g(['-c', 'user.name=x', '-c', 'user.email=x@x', 'add', '-A'], dir);
  await g(['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-qm', 'base'], dir);
  await g(['worktree', 'add', '-q', '--detach', 'wt1'], dir);
  await fs.writeFile(path.join(dir, 'wt1', 'only-copy.js'), 'export function ONLY_COPY() {}\n');

  // Confirm the premise: this repo really has no identity. Without this the test could pass
  // because git found one, proving nothing.
  const probe = await g(['config', 'user.email'], dir);
  assert.equal(probe.so.trim(), '',
    `PRECONDITION FAILED: the fixture must have NO identity, but git reports "${probe.so.trim()}" — ` +
    'this test would otherwise pass without ever exercising the fallback');

  const r = await new Promise((res) => {
    execFile(process.execPath, [HOLT_BIN, 'rescue', 'wt1'], { cwd: dir, env: blind },
      (e, so, se) => res({ code: e?.code ?? 0, so, se }));
  });
  assert.equal(r.code, 0, `rescue must succeed without a configured identity: ${r.se}`);

  const refs = await g(['for-each-ref', 'refs/holt', '--format=%(refname)'], dir);
  assert.match(refs.so, /refs\/holt\/rescue\/wt1/, 'the rescue ref must exist — not just a claim');
  const show = await g(['show', 'refs/holt/rescue/wt1:only-copy.js'], dir);
  assert.match(show.so, /ONLY_COPY/, 'the captured ref must actually contain the irreplaceable work');
});

test('IDENTITY: a configured repository keeps its OWN identity (never-worse)', async () => {
  // The fallback must never override a developer's own authorship on their own commits.
  const { authorEnv } = await import('../../src/git.mjs');
  const fx = await newRepo('identity-configured');
  try {
    const env = await authorEnv(fx.root);
    assert.deepEqual(env, {},
      `a repo with a configured identity must get NO override, got ${JSON.stringify(env)}`);
  } finally {
    await fx.cleanup();
  }
});

test('GATE: a worktree reached through a symlinked path is still protected', async (t) => {
  // MEASURED ON macOS AND WINDOWS, both of which ALLOWED `rm -rf <worktree holding the only copy
  // of something>` while Linux correctly denied it. The guard compared path.resolve() output, and
  // path.resolve does NOT resolve symlinks: on macOS os.tmpdir() is /var/folders/... while git
  // reports the real /private/var/folders/..., so the target matched no worktree and the command
  // sailed through. Two of three supported platforms had no rm protection at all.
  //
  // Built by hand rather than from the shared fixture, because the geometry is the whole point:
  // the worktree must live INSIDE the directory that is reached through a second path. A junction
  // is used on Windows, where a plain symlink needs elevation.
  const base = process.env.HOLT_TMPDIR || os.tmpdir();
  // realpath, because the product does the same and for the same reasons: on Windows os.tmpdir()
  // hands back an 8.3 short name (C:\Users\RUNNER~1\...) that git reports in its long form, and
  // on macOS /var is a symlink to /private/var. Comparing the raw value fails on both.
  const real = await fs.realpath(await fs.mkdtemp(path.join(base, 'holt-symlink-')));
  const link = path.join(base, `holt-symlink-link-${path.basename(real)}`);
  t.after(async () => {
    await fs.rm(link, { force: true, recursive: false }).catch(() => {});
    await fs.rm(real, { recursive: true, force: true }).catch(() => {});
  });

  const g = (args, cwd) => new Promise((res) => {
    execFile('git', args, { cwd, env: { ...process.env } }, (e, so) => res({ code: e?.code ?? 0, so }));
  });
  await g(['init', '-q', '-b', 'main', '.'], real);
  await g(['config', 'user.email', 'x@x'], real);
  await g(['config', 'user.name', 'x'], real);
  await fs.writeFile(path.join(real, 'base.txt'), 'base\n');
  await g(['add', '-A'], real);
  await g(['commit', '-qm', 'base'], real);
  await g(['worktree', 'add', '-q', '--detach', 'gold-scratch'], real);
  await fs.writeFile(path.join(real, 'gold-scratch', 'only.js'), 'export function ONLY_COPY() {}\n');

  try {
    await fs.symlink(real, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (e) {
    const direct = await assessCommand(`rm -rf ${path.join(real, 'gold-scratch')}`, real);
    assert.equal(direct.decision, 'deny',
      `this platform refuses symlinks (${e.message}), so at minimum the direct path must be denied`);
    return;
  }

  // The premise: git reports the REAL path, the command names the LINKED one. If those ever
  // coincide this test proves nothing, so assert they differ.
  // git prints POSIX separators even on Windows (D:/a/... not D:\a\...), so compare on a
  // normalised form — otherwise this precondition fails on Windows for a reason that has nothing
  // to do with what the test is checking.
  const slash = (x) => String(x).split(path.sep).join('/');
  const listed = slash((await g(['worktree', 'list', '--porcelain'], real)).so);
  assert.ok(listed.toLowerCase().includes(slash(path.join(real, 'gold-scratch')).toLowerCase()),
    `PRECONDITION: git must report the real path — got ${listed.slice(0, 300)}`);
  const viaLink = path.join(link, 'gold-scratch');
  assert.notEqual(viaLink, path.join(real, 'gold-scratch'),
    'PRECONDITION: the two routes must actually differ');

  const v = await assessCommand(`rm -rf ${viaLink}`, link);
  assert.equal(v.decision, 'deny',
    `a worktree is no less protected for being named through a symlink: ${JSON.stringify(v)}`);
});

test('FILE GATE: a rename stays allowed when the worktree is reached through a symlink', async (t) => {
  // MEASURED ON macOS AND WINDOWS: `mv src/a.js src/b.js` — a rename INSIDE one worktree, which
  // loses nothing — was DENIED. A guard that blocks renaming a file is uninstalled the same day.
  //
  // The cause is subtle and general: canonicalPath() fell back to the raw path when realpath
  // failed, and a move DESTINATION does not exist yet. So the source canonicalised (it exists) to
  // /private/var/... while the destination stayed /var/..., they resolved into different
  // worktrees, and an ordinary refactor looked like a move OUT. Fixed by resolving the nearest
  // EXISTING ancestor and re-appending the rest, so a not-yet-existing path still has a canonical
  // location.
  //
  // Reproduced here on any platform by reaching the worktree through a second path.
  const base = process.env.HOLT_TMPDIR || os.tmpdir();
  const real = await fs.mkdtemp(path.join(base, 'holt-mv-'));
  const link = path.join(base, `holt-mv-link-${path.basename(real)}`);
  t.after(async () => {
    await fs.rm(link, { force: true }).catch(() => {});
    await fs.rm(real, { recursive: true, force: true }).catch(() => {});
  });

  const g = (args, cwd) => new Promise((res) => {
    execFile('git', args, { cwd, env: process.env }, (e, so) => res({ code: e?.code ?? 0, so }));
  });
  await g(['init', '-q', '-b', 'main', '.'], real);
  await g(['config', 'user.email', 'x@x'], real);
  await g(['config', 'user.name', 'x'], real);
  await fs.writeFile(path.join(real, 'base.txt'), 'base\n');
  await g(['add', '-A'], real);
  await g(['commit', '-qm', 'base'], real);
  await g(['worktree', 'add', '-q', '--detach', 'lab'], real);
  await fs.mkdir(path.join(real, 'lab', 'src'), { recursive: true });
  await fs.writeFile(path.join(real, 'lab', 'src', 'only_here.js'), 'export function ONLY_HERE() {}\n');

  try {
    await fs.symlink(real, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    return; // platform refuses symlinks; the direct case is covered by the sibling tests
  }
  const viaLink = path.join(link, 'lab');

  const rename = await assessCommand('mv src/only_here.js src/moved.js', viaLink);
  assert.equal(rename.decision, 'allow',
    `a rename inside the worktree loses nothing and must stay allowed: ${JSON.stringify(rename)}`);

  // The other direction must still hold, or the fix bought safety away for convenience.
  const out = await assessCommand(`mv src/only_here.js ${path.join(base, 'stolen.js')}`, viaLink);
  assert.equal(out.decision, 'deny',
    `moving the only copy OUT of the worktree is a loss and must still be denied: ${JSON.stringify(out)}`);
});

test('FILE GATE: a Windows path survives tokenising — the escape that let work be moved out', () => {
  // MEASURED SAFETY HOLE, Windows only. The tokeniser treated `\` as a POSIX shell escape
  // unconditionally, so:
  //
  //     mv secret.js C:\Users\x\stolen.js   ->   destination parsed as "C:UsersxStolen.js"
  //
  // which is a RELATIVE path. It resolved INSIDE the worktree, so holt read a move OUT of the
  // worktree as an in-place rename and ALLOWED it — an agent on Windows could move the only copy
  // of a file out from under the guard and holt would permit it.
  //
  // Asserted at the PARSE, because that is where the defect is and it is the same on every
  // platform. Resolution is deliberately platform-dependent below that: on Linux `C:\Users\x` is
  // a perfectly legal relative filename, so asserting a verdict here would be asserting the
  // platform, not the product.
  const dest = (cmd) => (resolveFileTargets(cmd).find((t) => t.dest) ?? {}).dest;

  assert.equal(dest('mv a.js C:\\Users\\x\\stolen.js'), 'C:\\Users\\x\\stolen.js',
    'a drive-qualified path must keep every separator');
  assert.equal(dest('mv a.js D:\\tmp\\deep\\out.js'), 'D:\\tmp\\deep\\out.js',
    'and keep them all the way down, not just the first');
  assert.equal(dest('mv a.js \\\\server\\share\\out.js'), '\\\\server\\share\\out.js',
    'a UNC path opens with two backslashes and must survive intact');
});

test('FILE GATE: backslash keeps the meaning the RUNNING SHELL gives it (never-worse)', () => {
  // The other half. A backslash IS an escape in a POSIX shell, and breaking that to fix Windows
  // would trade one silent mis-parse for another: `rm foo\ bar.txt` is ONE file named "foo
  // bar.txt", and reading it as two would make holt reason about paths that do not exist.
  //
  // BUT "never-worse" IS A PER-PLATFORM PROPERTY, and asserting POSIX everywhere is asserting the
  // wrong thing. cmd and PowerShell have no backslash escape at all — on Windows `a\$b.txt` is a
  // path with a directory named `a`, and collapsing it to `a$b.txt` would invent a file. CI caught
  // exactly that: this test failed on windows-latest while the PRODUCT was right. The escaped
  // SPACE is not platform-split, because `\ ` is how both worlds quote a space.
  //
  // Neither branch skips. A skipped assertion cannot detect a regression, and both behaviours are
  // load-bearing on the platform that has them.
  const first = (cmd) => (resolveFileTargets(cmd)[0] ?? {}).raw;
  const WIN = process.platform === 'win32';

  assert.equal(first('rm foo\\ bar.txt'), 'foo bar.txt', 'an escaped space is part of the name');
  assert.equal(first('rm a\\$b.txt'), WIN ? 'a\\$b.txt' : 'a$b.txt',
    WIN ? 'on Windows a backslash is a separator, never an escape — the path must survive whole'
        : 'in a POSIX shell an escaped dollar is a literal dollar');
  assert.equal(first('rm "quoted file.txt"'), 'quoted file.txt', 'quoting is unaffected');
  assert.equal(first('rm ./src/a.js'), './src/a.js', 'ordinary relative paths are unaffected');

  // And the resolution still separates a rename from a move-out on THIS platform.
  const posix = resolveFileTargets('mv src/a.js /elsewhere/b.js').find((t) => t.dest);
  assert.equal(posix.dest, '/elsewhere/b.js', 'a POSIX destination is untouched');
});

test('WINDOWS GATE: the destructive vocabulary is not POSIX-only — PowerShell and cmd destroy work too', () => {
  // THE GUARD SPOKE ONE SHELL. Every destructive pattern was written for a POSIX shell, so on
  // Windows — where agent hosts run PowerShell or cmd by default — the entire file/worktree guard
  // was blind. `rm -rf ../feature` was caught; `Remove-Item -Recurse -Force ../feature`, which is
  // what an agent on Windows actually emits, returned null and was ALLOWED.
  //
  // That is not a cosmetic gap. git's worktree lock is defeated by neither: the lock stops
  // `git worktree remove`, and the hook is the ONLY layer covering a filesystem delete. On
  // Windows there was no layer at all, under a README that lists Windows as supported.
  //
  // Forward slashes throughout: PowerShell and cmd both accept them, and a backslash means
  // something different to the POSIX tokenizer this test also runs under.
  for (const cmd of [
    'Remove-Item -Recurse -Force wt/task-03',
    'Remove-Item -Path wt/task-03 -Recurse -Force',
    'remove-item -recurse -force wt/task-03',      // PowerShell is case-insensitive
    'ri -Recurse -Force wt/task-03',               // built-in alias
    'rd /s /q wt/task-03',                         // cmd
    'rmdir /s /q wt/task-03',
  ]) {
    const v = classifyCommand(cmd);
    assert.ok(v, `not recognised as destructive at all: ${cmd}`);
    assert.equal(v.target, 'wt/task-03', `wrong target extracted from '${cmd}': ${JSON.stringify(v)}`);
  }

  // ANTI-VACUITY: reading is not destroying. If the verb table degenerated to "match anything",
  // these would trip and every Windows agent would be blocked from looking at its own files.
  for (const cmd of ['Get-ChildItem wt/task-03', 'Get-Content wt/task-03/notes.md', 'dir wt/task-03']) {
    assert.equal(classifyCommand(cmd), null, `reading must never be treated as destruction: ${cmd}`);
  }
});

test('WINDOWS FILE GATE: per-file destruction has Windows spellings, and they carry the right role', () => {
  // The file layer, same gap. `Clear-Content` and `Set-Content` are the in-place destroyers with
  // no POSIX name at all in this table — they empty or overwrite a file that may hold the only
  // copy of an agent's work, and neither was recognised.
  const first = (cmd) => resolveFileTargets(cmd)[0];

  for (const [cmd, role, raw] of [
    ['Remove-Item wt/a/notes.md', 'delete', 'wt/a/notes.md'],
    ['del wt/a/notes.md', 'delete', 'wt/a/notes.md'],
    ['erase wt/a/notes.md', 'delete', 'wt/a/notes.md'],
    ['Clear-Content wt/a/notes.md', 'truncate', 'wt/a/notes.md'],
    ['Set-Content wt/a/notes.md -Value "gone"', 'truncate', 'wt/a/notes.md'],
    ['Out-File -FilePath wt/a/notes.md', 'truncate', 'wt/a/notes.md'],
    ['Move-Item wt/a/notes.md D:/elsewhere/notes.md', 'move-src', 'wt/a/notes.md'],
  ]) {
    const t = first(cmd);
    assert.ok(t, `no file target resolved from: ${cmd}`);
    assert.equal(t.raw, raw, `wrong path from '${cmd}': ${JSON.stringify(t)}`);
    assert.equal(t.role, role, `wrong role from '${cmd}': ${JSON.stringify(t)}`);
  }

  // `-Value` takes a VALUE, not a path — it must never be resolved as a file to protect.
  const setTargets = resolveFileTargets('Set-Content wt/a/notes.md -Value "gone"').map((t) => t.raw);
  assert.ok(!setTargets.includes('gone'), `the -Value payload is not a path: ${JSON.stringify(setTargets)}`);

  // ANTI-VACUITY: reads resolve to nothing.
  for (const cmd of ['Get-Content wt/a/notes.md', 'Select-String -Path wt/a/notes.md -Pattern x']) {
    assert.deepEqual(resolveFileTargets(cmd), [], `reading must resolve no destructive target: ${cmd}`);
  }
});


test('GATE: a command MENTIONED in quotes or a heredoc is text, not a command', () => {
  // MEASURED IN REAL USE, three times in one session: a test whose COMMENT contained a git
  // pathspec-checkout example, an `echo` of an rm example, and a heredoc writing documentation
  // about rm. Each was refused with an evidence-bearing message about work that was never in
  // danger, because the patterns matched the RAW command string.
  //
  // That is the failure this project names repeatedly - a gate that fires on things a developer
  // knows are harmless is a gate they switch off - and it lands hardest on exactly the people
  // most likely to be writing about destructive commands.
  const heredoc = 'cat > notes.md <<EOF\nrm -rf wt/task-03\nEOF';
  const quotedHeredoc = "cat > notes.md <<'EOF'\ngit worktree remove wt/x\nEOF";

  for (const [cmd, why] of [
    [heredoc, 'a heredoc body is a document being written, not a script being run'],
    [quotedHeredoc, 'the same, with a quoted terminator'],
    ["echo 'rm -rf wt/task-03'", 'a single-quoted mention'],
    ['echo "git worktree remove wt/x"', 'a double-quoted mention'],
    ["printf '%s' 'Remove-Item -Recurse -Force wt/x'", 'the Windows spelling, quoted'],
  ]) {
    assert.equal(classifyCommand(cmd), null, `${why}: ${JSON.stringify(cmd)}`);
  }

  // ANTI-VACUITY, and the half that keeps this from being a bypass. If quoting became a way to
  // hide a command, every one of these would have to still be caught - so they are asserted.
  for (const cmd of [
    'rm -rf wt/task-03',
    "echo 'about to clean' && rm -rf wt/task-03",
    'cat > notes.md <<EOF\nsome docs\nEOF\nrm -rf wt/task-03',
  ]) {
    const v = classifyCommand(cmd);
    assert.ok(v, `a REAL destructive command must still be caught: ${JSON.stringify(cmd)}`);
    assert.equal(v.target, 'wt/task-03', `and its target extracted: ${JSON.stringify(v)}`);
  }

  // A quoted TARGET is still a target - only the VERB's position decides, never the whole match.
  const spaced = classifyCommand('rm -rf "wt/my worktree"');
  assert.ok(spaced, 'a quoted path is still a path');
});


test('FILE GATE: a target beginning with a glob does not become "everything"', async (t) => {
  // REPRODUCED IN REAL USE, twice, while writing a commit message that mentioned shell
  // metacharacters. `echo x > ?` was refused with "would destroy 7 file(s)", listing the whole
  // gitignored set of the repository. Nothing there redirects to anything - the shell would create
  // one file literally named `?`.
  //
  // globFreePrefix() returns '.' when the first segment is already a glob: a stand-in meaning "no
  // prefix", not a prefix present in the string. The suffix was sliced by that stand-in's LENGTH,
  // so it ate the first real character - `*.js` became `.js`, and a bare `?` became the empty
  // string, which fell through to the `|| **` default and claimed every at-risk file in the tree.
  //
  // A target holt cannot resolve being reported as a target that hits everything is the loudest
  // possible false positive, and precisely how a guard gets switched off.
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  // Assessed from INSIDE a worktree that HOLDS at-risk content. Running it from the primary tree
  // proved nothing: the primary is excluded from scanning, so there was no at-risk set for the
  // broken matcher to over-claim and the test passed with the defect reinstated.
  const wt = fx.wt('uniqueUncommitted');
  const bare = await assessCommand('echo x > ?', wt);
  assert.equal(bare.decision, 'allow',
    `a bare glob names no identifiable file: ${JSON.stringify(bare.reason ?? '').slice(0, 300)}`);

  // The shape that actually blocked a commit: metacharacters inside a quoted message.
  const msg = await assessCommand('git commit -m "reserves < > ? | here"', wt);
  assert.equal(msg.decision, 'allow',
    `a commit message is not a redirect: ${JSON.stringify(msg.reason ?? '').slice(0, 300)}`);

  // ANTI-VACUITY, and the half that stops this becoming a bypass. A real redirect at a real
  // at-risk file must still be refused, and `rm -rf .` must still put the whole tree at stake.
  const real = await assessCommand('echo clobbered > src/only_uncommitted.js', wt);
  assert.equal(real.decision, 'deny',
    `truncating a file that exists only on disk must still be refused: ${JSON.stringify(real)}`);

  const wholeTree = await assessCommand('rm -rf .', wt);
  assert.equal(wholeTree.decision, 'deny',
    `deleting the worktree root must still be refused: ${JSON.stringify(wholeTree)}`);
});


test('GATE: a dry run and an unstage are not destruction (the annoyance half of the contract)', () => {
  // "A gate that only refuses gets switched off" is this project's own rule, and a false positive
  // on something a developer KNOWS is harmless teaches them the whole layer is arbitrary. These
  // two were found by an adversarial sweep and are the worst kind, because both are what a
  // CAREFUL developer does:
  //
  //   `git clean -fdn`  is the dry run you do BEFORE the destructive form. The pattern looked for
  //                     f or d anywhere in the flag cluster, so the safety step read as the danger.
  //   `git restore --staged .`  only unstages; the file on disk is untouched. It was refused while
  //                     the behaviourally identical `git reset HEAD .` was allowed — an
  //                     inconsistency a user cannot explain and will not tolerate.
  //
  // Both exemptions depend on ANOTHER flag elsewhere in the command, which is why rules carry an
  // `unless` predicate rather than the negative lookaheads that would have hidden this inside an
  // already dense regex.
  for (const cmd of [
    'git clean -fdn', 'git clean -ndf', 'git clean -fd --dry-run', 'git clean -n',
    'git restore --staged .', 'git restore --staged -- .', 'git restore --staged src/',
  ]) {
    assert.equal(classifyCommand(cmd), null, `harmless, and refusing it costs trust: ${cmd}`);
  }

  // THE NEVER-WORSE HALF, and it is the whole reason this test is safe to have. Every genuinely
  // destructive form must still be caught, or the exemption above became a bypass.
  for (const cmd of [
    'git clean -fd', 'git clean -fdx', 'git clean -f -d',
    'git restore .', 'git restore -- .', 'git restore --worktree .',
    'git restore --staged --worktree .', 'git checkout -- .',
  ]) {
    const v = classifyCommand(cmd);
    assert.ok(v, `this really does destroy work and must still be refused: ${cmd}`);
  }
});


test('GATE: a command holt cannot READ is never a silent allow', async (t) => {
  // NINETEEN CONFIRMED BYPASSES, found by an adversarial sweep and each one re-executed until it
  // actually destroyed the target. Every rule in the destructive table matches literal text, so
  // supplying the VERB indirectly defeated all of them:
  //
  //     $(echo rm) -rf ../feature      command substitution supplies the verb
  //     x=rm; $x -rf ../feature        a variable supplies the verb
  //     eval "rm -rf ../feature"       the argument is code, evaluated later
  //     echo <base64> | base64 -d | sh the pipeline's input is code
  //
  // holt cannot resolve any of these without EXECUTING them, which is the one thing a
  // pre-execution guard must never do. So it stops pretending: a command whose verb it cannot see
  // is UNKNOWN, and unknown is ASK — the same verdict holt already gives when a probe fails.
  // Absence of evidence is not evidence of absence, and that rule does not stop applying because
  // the ambiguity came from a shell instead of from a broken ctags.
  const fx = await newRepo('indirection');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('feature');
  await fx.write('precious.txt', 'ONLY_COPY\n', wt);

  for (const cmd of [
    `$(echo rm) -rf ${wt}`,
    '`echo rm` -rf ' + wt,
    `x=rm; $x -rf ${wt}`,
    `eval "rm -rf ${wt}"`,
    'echo cm0gLXJm | base64 -d | sh',
  ]) {
    const v = await assessCommand(cmd, fx.root);
    assert.notEqual(v.decision, 'allow',
      `holt cannot see what this runs, so it must not bless it: ${cmd} -> ${JSON.stringify(v)}`);
  }

  // A SHELL'S -c ARGUMENT IS CODE HOLT CAN READ, so wrapping is not a way to soften the verdict.
  // If this returned 'ask' rather than 'deny', `sh -c` would itself be the bypass.
  // Forward slashes: `sh -c` names a POSIX shell, and a Windows path full of backslashes inside a
  // POSIX shell string is incoherent on both platforms — the backslashes read as escapes, so the
  // fixture was asserting a command nobody would ever run. Windows accepts forward slashes in
  // paths, so this one form is a real command on every platform.
  const posixWt = wt.split(path.sep).join('/');
  for (const cmd of [`sh -c "rm -rf ${posixWt}"`, `bash -c 'rm -rf ${posixWt}'`]) {
    const v = await assessCommand(cmd, fx.root);
    assert.equal(v.decision, 'deny',
      `the inner command is fully visible and destroys work: ${cmd} -> ${JSON.stringify(v)}`);
  }

  // ANTI-VACUITY, and the half that decides whether this is tolerable. Substitution in an
  // ARGUMENT is completely ordinary. If these tripped, every developer would be interrupted for
  // `git commit -m "$(cat msg)"` and the guard would be uninstalled within a day.
  for (const cmd of [
    'git commit -m "$(cat msg.txt)"',
    'echo "$(date)" >> build.log',
    'ls $(pwd)',
    'npm run build',
    'git status',
  ]) {
    const v = await assessCommand(cmd, fx.root);
    assert.equal(v.decision, 'allow',
      `an ordinary command must not be interrupted: ${cmd} -> ${JSON.stringify(v)}`);
  }
});


test('GATE: the INDIRECTION half also knows prose from a command', async () => {
  // The masking test above covers classifyCommand. indirectVerb did not share it, and the gap
  // showed up within one commit of the indirection check landing: a `git commit -F` whose heredoc
  // MESSAGE contained `npm ci` in backticks was refused with "the command name comes from a
  // substitution or variable". The guard blocked a commit because of prose inside the commit
  // message.
  //
  // Both halves are asserted together from here so they cannot drift apart again — one half
  // knowing the difference between a command and a mention of one is not enough when either half
  // can refuse.
  const { indirectVerb } = await import('../../src/agent.mjs');

  for (const cmd of [
    "cat > msg.txt <<'EOF'\nsome prose with `npm ci` in backticks\nEOF",
    'cat > msg.txt <<EOF\nrun $(whoami) later, said the docs\nEOF',
    "echo 'rm -rf wt/x'",
    'git commit -m "fixed the `git clean -fd` false positive"',
  ]) {
    assert.equal(indirectVerb(cmd), null,
      `prose is not indirection: ${JSON.stringify(cmd)}`);
  }

  // ANTI-VACUITY: written OUTSIDE any quoted or heredoc region, the same constructs must still be
  // flagged, or the masking became the bypass.
  for (const cmd of [
    '$(echo rm) -rf ../feature',
    'x=rm; $x -rf ../feature',
    'eval "rm -rf ../feature"',
  ]) {
    assert.ok(indirectVerb(cmd), `real indirection must still be flagged: ${cmd}`);
  }
});


test('GATE: a variable assigned a literal in the same command is not opaque', async (t) => {
  // THIRD DOGFOODING INTERRUPTION. `BIN=/opt/holt/bin/holt; "$BIN" --version` is ordinary, the
  // value is sitting right there in the same command, and holt refused it as "the command name
  // comes from a substitution or variable" — saying it could not read something it demonstrably
  // could. That is the friction that gets a guard uninstalled.
  //
  // The narrowing had to be done carefully, and the anti-vacuity half below caught it failing on
  // the first attempt: resolving `$x` to `rm` made the indirection check clean, but classification
  // still matched the RAW string, where `rm` never appears as a verb — so the verdict silently
  // became ALLOW. A narrowing that turns "ask" into "allow" is the bypass, not a fix. A resolved
  // verb is now handed back for re-assessment, exactly as an `sh -c` payload is.
  const fx = await newRepo('var-verb');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('feature');
  await fx.write('precious.txt', 'ONLY_COPY\n', wt);

  // Resolved to something harmless: allowed, no interruption.
  for (const cmd of ['BIN=/opt/holt/bin/holt; "$BIN" --version', 'B=./node_modules/.bin/tsc; $B --noEmit']) {
    const v = await assessCommand(cmd, fx.root);
    assert.equal(v.decision, 'allow', `an ordinary literal-assigned command must not be interrupted: ${cmd}`);
  }

  // Resolved to something DESTRUCTIVE: denied with evidence — strictly better than the ask it
  // replaced, and the assertion that stops the narrowing from being a hole.
  const viaVar = await assessCommand(`x=rm; $x -rf ${wt}`, fx.root);
  assert.equal(viaVar.decision, 'deny',
    `a variable that resolves to rm must be judged as rm: ${JSON.stringify(viaVar)}`);

  // Still genuinely unknowable: ask, never allow.
  for (const cmd of [`X=$(which rm); $X -rf ${wt}`, '$UNSET_VAR --version', `$(echo rm) -rf ${wt}`]) {
    const v = await assessCommand(cmd, fx.root);
    assert.equal(v.decision, 'ask',
      `holt cannot resolve this and must not bless it: ${cmd} -> ${JSON.stringify(v)}`);
  }
});

test('GUARD: an inline OVERWRITE of at-risk content asks with an honest label — never "rm (deletes the file)", never a flat deny', async (t) => {
  // MEASURED LIVE, twice in one session: `node -e "...writeFileSync('src/x.mjs',...)"` against a
  // file whose only copy was uncommitted returned a DENY whose reason began
  // "rm (deletes the file) would destroy" — a message that is false about the act (nothing is
  // deleted; content is replaced) attached to a verdict that is wrong in kind (editing a file a
  // script owns is the everyday case; the calibrated answer is ask). Both times the block landed
  // on the author of the very content being protected. The remove path must keep its deny; the
  // out-of-repo write must stay allowed; and the overwrite must ask, saying "overwrite".
  const fx = await newRepo('inline-overwrite');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('editing');
  await fx.write('src/only.mjs', 'export function ONLY_COPY_HERE() { return 1; }\n', wt);
  // uncommitted on purpose: the file's current content exists nowhere else.

  const overwrite = await assessCommand(
    `node -e "require('fs').writeFileSync('src/only.mjs','edited')"`, wt);
  assert.equal(overwrite.decision, 'ask',
    `an overwrite of at-risk content is the author-editing case — ask, got: ${JSON.stringify(overwrite)}`);
  assert.match(overwrite.reason, /overwrite/i, 'the reason must describe the actual act');
  assert.doesNotMatch(overwrite.reason.split('\n')[0], /rm \(deletes the file\)/,
    'the headline must not claim a write is a delete — a guard that misdescribes what it saw is not believed next time');

  const remove = await assessCommand(
    `node -e "require('fs').rmSync('src/only.mjs')"`, wt);
  assert.equal(remove.decision, 'deny',
    `the REMOVE path keeps its deny — this fix must scope, not weaken: ${JSON.stringify(remove)}`);

  const elsewhere = await assessCommand(
    `node -e "require('fs').writeFileSync('${process.env.HOLT_TMPDIR || '/tmp'}/scratch-ok.txt','x')"`, wt);
  assert.equal(elsewhere?.decision ?? 'allow', 'allow',
    `a write outside the repo puts nothing at risk: ${JSON.stringify(elsewhere)}`);
});

/* --------------------------------------- the cache must not answer for another question ---- */

/**
 * THE GUARD FAILED OPEN IN THE EXACT CONFIGURATION `holt integrate` INSTALLS.
 *
 * For claude-code, integrate wires three hooks: PreToolUse (the blocking guard, which asks for
 * `includePrimary: true` because the human's own worktree is the one most likely to hold
 * uncommitted work), plus SessionStart and UserPromptSubmit (the brief, which does not).
 *
 * Both go through cachedReport(). The cache key hashed the repository root; the fingerprint
 * hashed worktree state. Neither hashed WHAT WAS ASKED. So the brief's answer — computed with the
 * primary worktree excluded — was handed to the guard as though it were the guard's own, the
 * guard found no primary workstream in it, and it allowed.
 *
 * Reproduced end to end before the fix, on a repository whose primary worktree held the only copy
 * of a symbol: cold cache DENIES `git clean -fd` and names the symbol; run the UserPromptSubmit
 * hook first — which the installed configuration does on every user message — and the identical
 * command is ALLOWED. `git reset --hard`, `git checkout -- .` and `git stash push -u` likewise.
 *
 * This test runs in the `core` CI job on all three operating systems.
 */
test('CACHE: an analysis computed WITHOUT the primary must never authorise a command against it', async (t) => {
  const fx = await newRepo('cache-identity');
  t.after(() => fx.cleanup());
  await fx.worktree('sib');
  // The ONLY copy of this symbol is uncommitted, in the PRIMARY worktree.
  await fx.write('primary_only.js', 'export function primaryOnlySecretHelper() { return 42; }\n');

  const DESTROYERS = ['git clean -fd', 'git reset --hard', 'git checkout -- .'];

  // ANTI-VACUITY: on a cold cache the guard must already refuse, or this test proves nothing
  // about caching — it would pass identically against a guard that refuses everything or one
  // that has no work to protect.
  for (const cmd of DESTROYERS) {
    const cold = await assessCommand(cmd, fx.root);
    assert.equal(cold?.decision, 'deny', `cold cache: ${cmd} must be refused, got ${JSON.stringify(cold)}`);
    assert.match(cold.reason, /primaryOnlySecretHelper/,
      `and the refusal must name the work at stake: ${cold.reason}`);
  }

  // Now the brief's shape — no includePrimary — exactly as `hook user-prompt-submit` asks for it.
  const brief = await cachedReport(fx.root, {});
  assert.ok(!brief.scanned.workstreams.some((w) => w.isPrimary),
    'ANTI-VACUITY: the brief\'s analysis really must exclude the primary, or there is nothing to poison with');

  // The guard must still refuse. Before the fix, every one of these came back `allow`.
  for (const cmd of DESTROYERS) {
    const after = await assessCommand(cmd, fx.root);
    assert.equal(after?.decision, 'deny',
      `after the brief hook ran, ${cmd} must STILL be refused, got ${JSON.stringify(after)}`);
    assert.match(after.reason, /primaryOnlySecretHelper/,
      `and it must still name the work at stake: ${after.reason}`);
  }

  // And the reverse direction: the guard's analysis must not be served to the brief either.
  const guard = await cachedReport(fx.root, { includePrimary: true });
  assert.ok(guard.scanned.workstreams.some((w) => w.isPrimary), 'the guard\'s analysis includes the primary');
  const brief2 = await cachedReport(fx.root, {});
  assert.ok(!brief2.scanned.workstreams.some((w) => w.isPrimary),
    'the brief must not be handed the guard\'s wider analysis either — one cache entry per question');
});

test('FILE GATE: unresolved brace expansion asks instead of silently allowing', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());
  const target = fx.wt('uniqueUncommitted');
  const verdict = await assessCommand(`rm -rf ${target}/only_uncommitted{.js,.bak}`, fx.root);
  assert.equal(verdict.decision, 'ask',
    `brace expansion is not statically resolved and must ask: ${JSON.stringify(verdict)}`);
  assert.match(verdict.reason, /brace|resolve|confirm/i);
});

test('CACHE: ignored-file changes invalidate a warm analysis', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());
  const wt = fx.wt('uniqueUncommitted');
  await fx.write('.gitignore', 'secret.env\n', wt);
  await fx.commit('ignore secret fixture', wt);
  await fx.write('secret.env', 'one\n', wt);

  const first = await cachedReport(fx.root, { includePrimary: true });
  assert.equal(first.fromCache, false);
  const second = await cachedReport(fx.root, { includePrimary: true });
  assert.equal(second.fromCache, true);

  await fs.writeFile(path.join(wt, 'secret.env'), 'two\n');
  const changed = await cachedReport(fx.root, { includePrimary: true });
  assert.equal(changed.fromCache, false,
    'ignored content is part of the safety fingerprint and must not reuse the old report');
});

test('CACHE: NEVER-WORSE — the cache still HITS when the same question is asked twice', async (t) => {
  // Without this, the fix above is satisfied by disabling the cache, which would put a full cold
  // scan in the agent's critical path on every single tool call — the 20-second stall this cache
  // exists to prevent, and the thing that gets a hook uninstalled.
  const fx = await newRepo('cache-still-hits');
  t.after(() => fx.cleanup());
  await fx.worktree('sib');
  await fx.write('a.js', 'export function cacheHitProbe() {}\n', fx.wt('sib'));

  const first = await cachedReport(fx.root, { includePrimary: true });
  assert.equal(first.fromCache, false, 'the first call computes');
  const second = await cachedReport(fx.root, { includePrimary: true });
  assert.equal(second.fromCache, true, 'the identical question must be served from cache');

  const briefFirst = await cachedReport(fx.root, {});
  assert.equal(briefFirst.fromCache, false, 'a different question computes its own answer');
  const briefSecond = await cachedReport(fx.root, {});
  assert.equal(briefSecond.fromCache, true, 'and then caches independently — no thrashing between the two');
});

/* ------------------------------------- the guard must survive a space in the path ---- */

/**
 * `C:\Users\First Last\project` AND `~/My Drive/project` ARE ORDINARY PATHS.
 *
 * Every destructive rule captured its target with `[^\s;|&]+`, which stops at the first
 * whitespace whether or not the operand is quoted. `git worktree remove "/x/My Drive/wt1"`
 * captured `"/x/My`, that matched no worktree, findWorkstream returned null, and the verdict fell
 * through to ALLOW. Measured on two byte-identical fixtures differing only by a space in the
 * parent directory name, against a worktree provably holding the only copy of a symbol, EIGHT of
 * nine forms lost the guard — only `rm` survived, and only because a separate quote-aware
 * tokeniser rescues it downstream.
 *
 * This is holt's core guarantee being off for an entire population of users, invisible to every
 * test because CI paths never contain a space. So the fixture here puts one in on purpose.
 */
test('SPACES: a worktree whose path contains a space is guarded exactly as one without', async (t) => {
  const spaced = await newRepo('has space');
  t.after(() => spaced.cleanup());
  await spaced.worktree('wt1');
  await spaced.write('only.js', 'export function SOLE_COPY_SPACED() { return 1; }\n', spaced.wt('wt1'));

  const wt = spaced.wt('wt1');
  assert.ok(wt.includes(' '), `ANTI-VACUITY: the fixture path must really contain a space: ${wt}`);

  // ANTI-VACUITY: the worktree must genuinely hold work nothing else has, or "deny" below would
  // be the right answer for the wrong reason.
  const { report } = await cachedReport(spaced.root, { includePrimary: true });
  const row = report.safe.find((s) => s.id.includes('wt1'));
  assert.equal(row?.safe, false, `the spaced worktree must hold unique work: ${JSON.stringify(row)}`);

  const q = JSON.stringify(wt);   // the operand as a shell would carry it: double-quoted
  const mustRefuse = [
    `git -C ${q} checkout -- .`,
    `git -C ${q} restore .`,
    `git -C ${q} reset --hard`,
    `git -C ${q} clean -fd`,
    `git -C ${q} stash push -u`,
    `git worktree remove ${q}`,
    `git worktree remove -f -f ${q}`,
    `git worktree unlock ${q}`,
    `rm -rf ${q}`,
    `Remove-Item -Recurse -Force ${q}`,
  ];
  for (const cmd of mustRefuse) {
    const v = await assessCommand(cmd, spaced.root);
    assert.ok(v && v.decision !== 'allow',
      `a space in the path must not disarm the guard: ${cmd} -> ${JSON.stringify(v)}`);
  }

  // The POSIX unquoted spelling of the same thing.
  const escaped = wt.replace(/ /g, '\\ ');
  const vEsc = await assessCommand(`rm -rf ${escaped}`, spaced.root);
  assert.ok(vEsc && vEsc.decision !== 'allow',
    `a backslash-escaped space must be read as one operand: ${JSON.stringify(vEsc)}`);
});

test('SPACES: NEVER-WORSE — quoting must not make the guard refuse things it should allow', async (t) => {
  // The other direction, and the one that gets a guard uninstalled. Widening the operand pattern
  // to accept quoted runs must not turn ordinary commands into refusals, and must not let one
  // operand swallow the rest of the line.
  const spaced = await newRepo('has space allow');
  t.after(() => spaced.cleanup());
  await spaced.worktree('wt1');
  await spaced.write('only.js', 'export function KEEP_ME_SPACED() {}\n', spaced.wt('wt1'));

  const outside = path.join(spaced.root, 'node_modules');
  await fs.mkdir(outside, { recursive: true });

  for (const cmd of [
    `rm -rf ${JSON.stringify(outside)}`,          // a real directory that is not a worktree
    'rm -rf dist',
    'rm -rf ./build/*.map',
    'git status',
    'git log --oneline -5',
    'echo "hello world"',
    'npm run build -- --watch',
  ]) {
    const v = await assessCommand(cmd, spaced.root);
    assert.ok(!v || v.decision === 'allow',
      `must stay allowed: ${cmd} -> ${JSON.stringify(v)}`);
  }
});

/* ------------------------------------------ the main working tree is never disposable ---- */

/**
 * "PROVABLY NOTHING TO LOSE" IS A STATEMENT ABOUT FILES. `safe: true` IS READ AS ONE ABOUT THE
 * WORKTREE.
 *
 * Scanning the primary when it is the only worktree — the right fix for a repo reporting zero risk
 * while holding real risk — made a CLEAN solo repository's only worktree "provably disposable",
 * and every surface agreed at once: `holt gate <id>` exit 0, which is the green light for the
 * chain the CLI itself prints (`holt gate $id && rm -rf $id`); MCP holt_check_workstream
 * "safe to delete"; holt_status disposable:1; `plan` listing it under DROP; `auto` prescribing
 * `holt clean --apply`; and the PreToolUse guard ALLOWING `rm -rf <repo>` — correctly by its own
 * rule, because a clean tree holds no file whose only copy is on disk.
 *
 * `git worktree remove` refuses the main working tree outright, which is the only reason
 * `clean --apply` was not already destroying repositories. `rm -rf` has no such protection, and
 * .git is inside that path: every commit, branch, reflog, stash and refs/holt/* rescue ref goes
 * with it. git-worktree(1) draws exactly this line; lazygit keeps the same distinction as data
 * (`isMain`) so callers can refuse destructive actions on it.
 */
test('PRIMARY: a clean solo repo\'s only worktree is NEVER reported disposable', async (t) => {
  const fx = await newRepo('primary-not-disposable');
  t.after(() => fx.cleanup());

  const { report } = await cachedReport(fx.root, { includePrimary: true });
  const row = report.safe.find((s) => s.isPrimary || s.path === fx.root);
  assert.ok(row, `the primary must appear in the safe report: ${JSON.stringify(report.safe)}`);
  assert.equal(row.safe, false,
    `the main working tree must never be safe to delete: ${JSON.stringify(row)}`);
  assert.equal(row.confidence, 'measured', 'and this is a measurement, not an unknown');
  assert.match(row.reasons.join(' '), /main working tree/i,
    `the reason must say why, not hedge: ${JSON.stringify(row.reasons)}`);

  // ANTI-VACUITY: the content verdict is not thrown away — `risk`/`plan` must still be able to
  // say "nothing unique here" without any consumer reading that as permission to delete.
  assert.equal(row.contentReproducible, true,
    `a clean primary's content really is reproducible, and that must stay visible: ${JSON.stringify(row)}`);

  // ...and nothing downstream offers it up.
  assert.ok(!report.plan?.drop?.some((d) => d.id === row.id),
    `plan must not put the main working tree in DROP: ${JSON.stringify(report.plan?.drop)}`);
});

test('PRIMARY: NEVER-WORSE — a linked worktree with nothing unique is STILL disposable', async (t) => {
  // The other direction, and the whole product depends on it: a fix that made everything
  // undeletable would switch `holt clean` off entirely.
  const fx = await newRepo('primary-neverworse');
  t.after(() => fx.cleanup());
  await fx.worktree('spent');

  const { report } = await cachedReport(fx.root, { includePrimary: true });
  const spent = report.safe.find((s) => s.id === 'spent');
  assert.equal(spent?.safe, true,
    `an empty LINKED worktree must remain disposable: ${JSON.stringify(spent)}`);
});

test('PRIMARY: `rm -rf <repo root>` is refused because .git is inside it', async (t) => {
  const fx = await newRepo('rm-repo-root');
  t.after(() => fx.cleanup());

  const v = await assessCommand(`rm -rf ${fx.root}`, fx.root);
  assert.equal(v?.decision, 'deny',
    `deleting the repository root must be refused: ${JSON.stringify(v)}`);
  assert.match(v.reason, /MAIN WORKING TREE/i, v.reason);
  assert.match(v.reason, /\.git is inside/i, `and it must say WHY: ${v.reason}`);
  assert.match(v.reason, /commit|reflog|stash/i,
    `naming what is actually at stake: ${v.reason}`);

  // NEVER-WORSE: ordinary deletes inside the repo are untouched, and an empty LINKED worktree
  // stays removable — otherwise this guard has made holt refuse the work it exists to enable.
  await fs.mkdir(path.join(fx.root, 'node_modules'), { recursive: true });
  const nm = await assessCommand('rm -rf node_modules', fx.root);
  assert.ok(!nm || nm.decision === 'allow', `rm -rf node_modules must stay allowed: ${JSON.stringify(nm)}`);

  await fx.worktree('spent');
  const linked = await assessCommand(`rm -rf ${fx.wt('spent')}`, fx.root);
  assert.ok(!linked || linked.decision === 'allow',
    `an empty linked worktree must stay removable: ${JSON.stringify(linked)}`);
});

test('NEWLINE: a worktree whose DIRECTORY NAME contains a newline is still guarded', async (t) => {
  // holt had TWO readers of `git worktree list --porcelain`. src/discover.mjs parses it correctly
  // (a path may span physical lines) and is pinned by a test. The guard had its own, which split
  // on '\n' and kept lines beginning `worktree ` — so such a path was recorded TRUNCATED at the
  // newline, matched nothing, and targetIsWorktree() returned false, standing the guard down.
  //
  // Measured in one repository at one moment: `holt risk` REPORTED that worktree as holding work
  // found nowhere else, naming it — and the guard ALLOWED `rm -rf` of it. holt knew, and let it
  // go. Two readers of one format is one reader too many.
  const fx = await newRepo('newline-guard');
  t.after(() => fx.cleanup());

  const weird = path.join(fx.root, '..', 'weird\nwt');
  try {
    await fx.git(['worktree', 'add', '-q', '--detach', weird]);
  } catch {
    assert.equal(process.platform, 'win32', 'a newline-named directory must be creatable off Windows');
    return;
  }
  await fs.writeFile(path.join(weird, 'only.js'), 'export function NEWLINE_SOLE() {}\n');

  // ANTI-VACUITY: holt must actually see the work, or "deny" below is right for the wrong reason.
  const { report } = await cachedReport(fx.root, { includePrimary: true });
  const row = report.unique.find((u) => u.id.includes('weird'));
  assert.ok(row && row.uncommittedOnlyCount > 0,
    `holt must see the work in the newline-named worktree: ${JSON.stringify(report.unique.map((u) => u.id))}`);

  // Every spelling a shell would actually deliver.
  for (const [shape, cmd] of [
    ['single-quoted', `rm -rf '${weird}'`],
    ['double-quoted', `rm -rf "${weird}"`],
    ['backslash-escaped', `rm -rf ${weird.replace('\n', '\\\n')}`],
  ]) {
    const v = await assessCommand(cmd, fx.root);
    assert.ok(v && v.decision !== 'allow',
      `${shape}: a newline in the path must not disarm the guard: ${JSON.stringify(v)}`);
  }
});

/* -------------------------- a substitution in an ARGUMENT is not a substituted VERB ---- */

/**
 * MEASURED AGAINST holt WHILE IT WAS GUARDING THIS REPOSITORY.
 *
 * An ordinary `gh run view` was refused with "the command name comes from a substitution or
 * variable". Every verb in it was literal — `gh`, `echo`, `cut`, `timeout`, `sort`, `head`. Only
 * the ARGUMENTS came from substitutions.
 *
 * lexSegments treated `|`, `;` and `&` inside `$(…)` as outer segment separators, so
 *
 *     ID=$(echo $R | cut -d' ' -f1); gh run view $ID
 *
 * split at the INNER pipe, the assignment-stripper consumed `ID=$(echo`, and the next word — `$R`,
 * an argument to echo — was read as a command VERB.
 *
 * OVER-REFUSAL IS A DEFECT, NOT CAUTION. A refusal an agent cannot act on costs it a turn and
 * teaches it to discount the next message — including the true ones. But the fix must not buy that
 * by going blind: a substitution's contents are commands in their own right, and `$(rm -rf x)`
 * genuinely does run `rm`. So the substitution is ONE WORD to the outer command AND is lexed as
 * commands of its own, and both halves are asserted here.
 */
test('SUBSTITUTION: literal verbs with substituted arguments are not refused', async (t) => {
  const fx = await newRepo('subst-args');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('holder');
  await fx.write('only.js', 'export function SUBST_SOLE() {}\n', wt);

  for (const cmd of [
    "R=$(gh run list --limit 3); ID=$(echo $R | cut -d' ' -f1); timeout 240 gh run view $ID | sort | head -14",
    'for c in $(git log --format=%h -5); do git show --stat $c; done',
    'echo "branch: $(git rev-parse --abbrev-ref HEAD)"',
    "test -n \"$(git status --porcelain)\" && echo dirty",
  ]) {
    const v = await assessCommand(cmd, fx.root);
    assert.ok(!v || v.decision === 'allow',
      `every verb here is literal; refusing it is an over-refusal: ${cmd}\n${JSON.stringify(v)}`);
  }
});

test('SUBSTITUTION: NEVER-WORSE — a destructive command inside a substitution is still caught', async (t) => {
  const fx = await newRepo('subst-hidden');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('holder');
  await fx.write('only.js', 'export function SUBST_HIDDEN_SOLE() {}\n', wt);
  const p = fx.wt('holder');

  for (const [why, cmd] of [
    ['rm hidden in $( )', `X=$(rm -rf ${p}); echo $X`],
    ['rm hidden in backticks', `X=\`rm -rf ${p}\`; echo $X`],
    ['a verb resolved from a literal assignment', `x=rm; $x -rf ${p}`],
    ['a verb that cannot be resolved at all', `$UNKNOWN_CMD -rf ${p}`],
    ['eval', `eval "rm -rf ${p}"`],
    ['the plain form', `rm -rf ${p}`],
  ]) {
    const v = await assessCommand(cmd, fx.root);
    assert.ok(v && v.decision !== 'allow',
      `${why}: must NOT be allowed — the fix must narrow false positives, not coverage: ${JSON.stringify(v)}`);
  }
});

/* ------------------------------------- the targeting proxy needs a verb to point at ---- */
//
// When an inline program shells out, holt reads every quoted string in it and — before this fix —
// tried each one as `rm -rf <str>`. That proxy is exact for a REMOVE, where the quoted string IS
// the removal target. For a shelled-out command the strings are that command's ARGUMENTS: a cwd,
// an env value, a flag. Nothing is being removed at all.
//
// MEASURED, and it blocked this project's own maintenance twice in one session:
//   node -e "execSync('git show HEAD:site/index.html', { cwd: '<repo>' })"
// was DENIED as "rm -rf of the main working tree" because the directory the READ-ONLY command
// runs in was fed to the proxy as a deletion target. Any script mentioning a path in `cwd:` was
// refused — including `git log`.
//
// Dropping the proxy for shell-outs would open a hole the other way, because a verb and its
// target can live in SEPARATE strings: execFile('rm', ['-rf', dir]). So the proxy now applies
// when some string actually names a destroyer. Both directions are pinned here; a change that
// cures one by re-breaking the other fails.

const RM_ = `r${'m'}`;
const inlineCase = (body) => `node -e "${body.replace(/"/g, '\\"')}"`;
// A Windows path embedded RAW into JS source is not the path — `C:\Users\x` makes `\U` and `\x`
// escape sequences, so the program holt reads is corrupted before it is ever parsed. JSON.stringify
// produces a valid JS string literal on every platform, which is what an agent would actually emit.
const jsStr = (v) => JSON.stringify(String(v));

test('GUARD: a read-only inline program is not refused for naming a path in cwd', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());
  const q = (s) => `'${s}'`;
  for (const body of [
    `const{execSync}=require(${q('child_process')});execSync(${q('git log')},{cwd:${jsStr(fx.root)}})`,
    `require(${q('child_process')}).execSync(${q('git status')},{cwd:${jsStr(fx.root)}})`,
    `execFile(${q('git')},[${q('status')}],{cwd:${jsStr(fx.root)}})`,
  ]) {
    const v = await assessCommand(inlineCase(body), fx.root);
    assert.equal(v.decision, 'allow',
      `a read-only command must not be refused for mentioning a path: ${body}`);
  }
});

test('GUARD: a destroyer split across separate strings is still caught', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());
  const q = (s) => `'${s}'`;
  // execFile/spawn/spawnSync were absent from the shell-out detector entirely, so these came back
  // ALLOW because no rule matched at all — an under-refusal found while narrowing the over-refusal.
  for (const body of [
    `execFile(${q(RM_)},[${q('-rf')},${jsStr(fx.wt('uniqueUncommitted'))}])`,
    `spawnSync(${q(RM_)},[${q('-rf')},${jsStr(fx.wt('uniqueUncommitted'))}])`,
  ]) {
    const v = await assessCommand(inlineCase(body), fx.root);
    assert.notEqual(v.decision, 'allow',
      `a destroyer named in one string with its target in another must still be caught: ${body}`);
  }
});

test('GUARD: a doubled-backslash path — how Windows paths are written in source — is unescaped', () => {
  // A Windows path spelled correctly in JS source uses DOUBLED backslashes. Taking the raw text
  // between the quotes returned the SOURCE spelling rather than the path, so it resolved to
  // nothing, holt found no target, and the removal was ALLOWED. A silent under-refusal on the
  // one platform this project has already been bitten by twice.
  //
  // Asserted on the extractor rather than end to end, because faking a Windows path on POSIX
  // proves nothing: path.sep is '/' here, so "doubling the separator" builds a string that is a
  // path on neither platform — the first version of this test did exactly that and passed
  // vacuously. Whether a resolved path then matches a worktree is ordinary path logic covered
  // elsewhere; what changed here is the unescaping, so that is what this pins.
  const src = String.raw`require('fs').rmSync('C:\\proj\\wt')`;
  assert.deepEqual(inlineStrings(src), ['fs', String.raw`C:\proj\wt`],
    'doubled backslashes in source must collapse to the single separators of the real path');

  assert.deepEqual(inlineStrings("x('/home/u/wt')"), ['/home/u/wt'],
    'a POSIX path carrying no escapes must pass through byte-for-byte');

  // NEVER-WORSE: only the doubled backslash collapses. Interpreting the rest of the escape table
  // would turn `C:\new` into `C:` + a newline and invent a path nobody wrote.
  assert.deepEqual(inlineStrings(String.raw`x('C:\new')`), [String.raw`C:\new`],
    'a single backslash is left verbatim — the source is already malformed, so do not guess');
});

test('GUARD: an inline remove naming its own target is still denied', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());
  const q = (s) => `'${s}'`;
  const v = await assessCommand(
    inlineCase(`require(${q('fs')}).${RM_}Sync(${jsStr(fx.wt('uniqueUncommitted'))},{recursive:true})`), fx.root);
  assert.notEqual(v.decision, 'allow', 'the remove role must keep its exact targeting proxy');
});

/* ------------- "removable" and "holds irreplaceable content" are different questions ---- */
//
// analyze.mjs sets safe:false for the main working tree unconditionally, and correctly: git
// refuses `git worktree remove` there and .git lives inside it, so it is never removable. But the
// guard's content verbs read that same flag to answer a DIFFERENT question — "would this command
// destroy content" — and in a single-clone repository, the layout almost every repo has, that
// made holt DENY `git reset --hard`, `git clean -fdx`, `git checkout -- .` and
// `git restore --worktree .` FOREVER. On a byte-clean tree. With no escape hatch: .holtrc.json
// cannot make holt less safe and `holt discard` cannot help because the refusal names no file.
//
// The message contradicted itself in consecutive clauses — "would destroy work that exists
// nowhere else", then "its files are reproducible from base". That is an hour-one uninstall, and
// it is the single most expensive kind of bug this project can ship: a safety tool that refuses
// ordinary work teaches its user to switch it off, after which it protects nothing.
//
// All three directions are pinned here. A change that cures the over-refusal by allowing a real
// destruction fails the second test; one that keeps the repo-root rule but re-breaks the clean
// case fails the first.

test('PRIMARY: content verbs are allowed on a byte-clean main working tree', async (t) => {
  const fx = await newRepo('primary-clean');
  t.after(() => fx.cleanup());
  const st = await fx.git(['status', '--porcelain']);
  assert.equal(String(st).trim(), '', 'premise: the fixture must be byte-clean');

  for (const cmd of ['git reset --hard', 'git clean -fdx', 'git checkout -- .', 'git restore --worktree .']) {
    const v = await assessCommand(cmd, fx.root);
    assert.equal(v.decision, 'allow',
      `${cmd} on a clean main working tree destroys nothing and must not be refused (got ${v.decision})`);
  }
});

test('PRIMARY: NEVER-WORSE — the same verbs are caught once the tree holds unique work', async (t) => {
  const fx = await newRepo('primary-dirty');
  t.after(() => fx.cleanup());
  await fx.write('only-here.js', 'export function ONLY_COPY_HERE() { return 1; }\n');

  for (const cmd of ['git reset --hard', 'git clean -fdx']) {
    const v = await assessCommand(cmd, fx.root);
    assert.notEqual(v.decision, 'allow',
      `${cmd} must still be caught when the main tree holds the only copy of something`);
  }
});

test('PRIMARY: NEVER-WORSE — rm -rf of the repository root is still refused', async (t) => {
  const fx = await newRepo('primary-rmrf');
  t.after(() => fx.cleanup());
  // Removability and content are separate questions, and this is the removability one: .git lives
  // inside the main working tree, so its loss takes every commit, branch, reflog and rescue ref
  // with it — irrespective of whether the tree is clean.
  const v = await assessCommand(`rm -rf ${fx.root}`, fx.root);
  assert.notEqual(v.decision, 'allow',
    'deleting the main working tree destroys .git and must be refused even on a clean tree');
});

/* ------------------- a command that CONTAINS a worktree destroys it, same as one inside it ---- */
//
// deepestRoot() asked only "is the target INSIDE a worktree", so a target that is an ANCESTOR of
// the worktrees — the parent that holds them, or a glob whose prefix is that parent — matched
// nothing and was dropped as "not holt's to defend". REPRODUCED, and it is the incident this
// product exists for, in the spelling it took (mergify.com/blog/the-day-my-ai-agent-deleted-29-
// git-worktrees):
//
//   rm -rf ../wt/uniqueUncommitted   -> deny   (single, resolved — the control)
//   rm -rf ../wt/*                   -> ALLOW  (the glob)
//   rm -rf ../wt                     -> ALLOW  (the parent of every worktree)
//
// Both directions are pinned. The never-worse half matters as much: a glob that matches no
// worktree, and a path outside every worktree, must stay allowed, or the fix is just a new
// over-refusal.

test('CONTAINMENT: a glob whose prefix is above the worktrees denies, naming the sole copy', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());
  // ../wt/* from the primary matches every linked worktree, including uniqueUncommitted, which
  // holds the only copy of a symbol. git worktree remove of the single one is the control.
  const single = await assessCommand(`rm -rf ${fx.wt('uniqueUncommitted')}`, fx.root);
  assert.notEqual(single.decision, 'allow', 'control: the resolved single target must already deny');

  const glob = await assessCommand('rm -rf ../wt/*', fx.root);
  assert.notEqual(glob.decision, 'allow',
    'a glob whose expansion includes a worktree holding the only copy must not be allowed');
});

test('CONTAINMENT: the parent directory of all worktrees is not a safe target', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());
  const parent = await assessCommand('rm -rf ../wt', fx.root);
  assert.notEqual(parent.decision, 'allow',
    'removing the directory that contains every worktree destroys them all');
});

test('CONTAINMENT: NEVER-WORSE — a non-matching glob and an outside path stay allowed', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());
  for (const cmd of ['rm -rf ../wt/nomatch-*', 'rm -rf /tmp/holt-not-a-worktree-xyz', 'rm -rf ./build']) {
    const v = await assessCommand(cmd, fx.root);
    assert.equal(v.decision, 'allow',
      `${cmd} reaches no worktree and must stay allowed — the fix must not manufacture refusals (got ${v.decision})`);
  }
});

/* --------------------- a for-loop over a glob is the incident, and must be seen ---------- */
//
// A compound `for VAR in LIST; do BODY; done` was never decomposed — measured,
// resolveFileTargets returned [] for it — so a destroyer in the body ran unseen. This is the
// mergify 29-worktree deletion in the spelling it actually took: a loop over `../wt-*` running
// `git worktree remove --force` on each. expandForLoops binds the variable so the body is
// assessed as `<verb> ../wt-*`, which the containment rule denies. It is pure expansion — it only
// ever shows holt what the shell will run — so a benign body (echo, a build dir) stays allowed.
// Grounded in how Continue's agent guard expands variables and DCG's tree-sitter-bash grammar
// sees loop bodies; both refuse to let an unexpanded loop hide a destroyer.

test('LOOP: `for d in ../wt-*; do rm -rf $d; done` is the incident and must deny', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());
  for (const cmd of [
    'for d in ../wt/*; do rm -rf $d; done',
    'for d in ../wt/*; do rm -rf "$d"; done',
    'for d in ../wt/*; do git worktree remove -f $d; done',   // the literal mergify verb
  ]) {
    const v = await assessCommand(cmd, fx.root);
    assert.notEqual(v.decision, 'allow',
      `a loop that removes each match of a worktree glob must not be allowed: ${cmd}`);
  }
});

test('LOOP: NEVER-WORSE — a loop whose body is harmless stays allowed', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());
  for (const cmd of ['for i in 1 2 3; do echo $i; done', 'for f in ./build/*; do rm -rf $f; done']) {
    const v = await assessCommand(cmd, fx.root);
    assert.equal(v.decision, 'allow',
      `expansion must never over-refuse a benign loop (got ${v.decision} for: ${cmd})`);
  }
});

test('WORKTREE-GLOB: git worktree remove over a glob or ancestor reaches every match', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());
  const single = await assessCommand(`git worktree remove -f ${fx.wt('uniqueUncommitted')}`, fx.root);
  assert.notEqual(single.decision, 'allow', 'control: the resolved single target must deny');

  const glob = await assessCommand('git worktree remove -f ../wt/*', fx.root);
  assert.notEqual(glob.decision, 'allow',
    'a glob that matches a worktree holding the only copy must not be allowed at the worktree layer');

  const nomatch = await assessCommand('git worktree remove -f ../wt/nomatch-*', fx.root);
  assert.equal(nomatch.decision, 'allow', 'a glob matching no worktree stays allowed');
});

test('EXPAND: expandForLoops binds the variable and never invents a body', () => {
  // Unit-level, so the binding rule is pinned independently of the guard.
  assert.deepEqual(expandForLoops('for d in ../wt-*; do rm -rf $d; done'), ['rm -rf ../wt-*']);
  assert.deepEqual(expandForLoops('for d in ../wt-*; do rm -rf "$d"; done'), ['rm -rf ../wt-*']);
  assert.deepEqual(expandForLoops('for i in 1 2 3; do echo $i; done'), ['echo 1 2 3']);
  assert.deepEqual(expandForLoops('rm -rf x'), [], 'a command with no for-loop expands to nothing');
});
