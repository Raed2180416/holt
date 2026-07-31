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
  // Only the two VERIFIED adapters claim 'block'; nothing else overclaims.
  const blocking = HOSTS.filter((h) => h.strength === 'block').map((h) => h.id).sort();
  assert.deepEqual(blocking, ['claude-code', 'opencode'], 'only verified adapters may claim blocking');
  assert.match(CLOUD_CAVEAT, /do not apply to cloud/i, 'the cloud limit must be stated plainly');
});

test('HOSTS: hostsReport marks what is detected and never claims cloud blocking', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-hosts-'));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-hosthome-'));
  t.after(() => Promise.all([fs.rm(dir, { recursive: true, force: true }), fs.rm(home, { recursive: true, force: true })]));
  const { hostsReport } = await import('../../src/integrate/adapters.mjs');

  await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
  const rep = await hostsReport(dir, home);
  assert.ok(rep.counts.blocking === 2, 'exactly two blocking adapters today');
  assert.ok(rep.detectedHere.includes('Claude Code'), 'a real marker is detected');
  const cloud = rep.hosts.filter((h) => h.env === 'cloud');
  assert.ok(cloud.length >= 3, 'the cloud segment is enumerated');
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
