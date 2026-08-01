// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — the host manifest must describe what holt ACTUALLY writes.
 *
 * Two tables carried one fact between them and drifted, the same shape as every other defect this
 * project has shipped. `src/integrate/hosts.mjs` declares `mcp: true` for a host; the list of
 * files `holt integrate` really writes lives in `mcpTargets()` in `src/integrate/adapters.mjs`.
 * Nothing tied them together, so eight hosts — Codex, Cline, Amp, Goose, Factory, Junie, Aider and
 * Amazon Q — were advertised as "MCP + advisory today" in the manifest, in HOSTS.md (which is
 * GENERATED from the manifest) and in the README, while `holt integrate` wrote them nothing at
 * any scope, ever.
 *
 * That is worse than an unsupported host. An unsupported host is a gap a user can see and route
 * around; a host that claims MCP and silently writes no config is a user who believes they are
 * protected and is not — which is the single failure mode this product exists to prevent.
 *
 * This test does not enumerate hosts. It derives the requirement from the two tables, so adding a
 * host to either one without the other fails here rather than in a user's editor.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { HOSTS } from '../../src/integrate/hosts.mjs';
import { mcpTargets } from '../../src/integrate/adapters.mjs';

const targets = () => mcpTargets(path.join(os.tmpdir(), 'repo'), path.join(os.tmpdir(), 'home'), { scope: 'all' });

/**
 * mcpTargets keys most rows by a plain host id, but some rows historically used a combined
 * display string (e.g. the old 'vscode / copilot' row, split apart once it turned out Copilot CLI
 * does not read VS Code's mcp.json at all — see hosts.mjs). Matching stays loose enough to accept
 * either shape so a legitimately shared row would still be found, but deliberately in the
 * direction that makes the test HARDER to satisfy vacuously: a host counts as covered only if some
 * target row plausibly names it.
 */
function coveredBy(rows, host) {
  return rows.some((r) => {
    const h = String(r.host).toLowerCase();
    return h === host.id.toLowerCase()
      || h.split(/[\s/]+/).includes(host.id.toLowerCase());
  });
}

test('host manifest: every host advertised as MCP-capable actually gets a config written', () => {
  const rows = targets();

  // ANTI-VACUITY, both halves. If either table came back empty this test would agree with itself
  // about nothing and pass forever.
  assert.ok(rows.length >= 6, `mcpTargets returned ${rows.length} rows — the table is not being read`);
  assert.ok(HOSTS.length >= 10, `the manifest has ${HOSTS.length} hosts — it is not being read`);

  const claimed = HOSTS.filter((h) => h.mcp === true);
  assert.ok(claimed.length >= 5, `only ${claimed.length} hosts claim MCP — the flag is not being read`);

  const lying = claimed.filter((h) => !coveredBy(rows, h)).map((h) => `${h.id} (${h.name})`);
  assert.deepEqual(lying, [],
    'these hosts are advertised as MCP-capable in the manifest — and therefore in HOSTS.md and the '
    + 'README, which are generated from it — but `holt integrate` writes them no MCP config at any '
    + `scope. A user reading this believes they are covered and is not:\n  ${lying.join('\n  ')}`);
});

test('host manifest: every host holt writes a config for is declared in the manifest', () => {
  // The other direction. A file written for a host nobody declared is a file nobody reviews, and
  // `holt hosts` — the command whose entire job is honest coverage — would not mention it.
  const rows = targets();
  const ids = new Set(HOSTS.map((h) => h.id.toLowerCase()));

  const undeclared = rows
    .filter((r) => !String(r.host).toLowerCase().split(/[\s/]+/).some((part) => ids.has(part)))
    .map((r) => `${r.host} -> ${r.file}`);

  assert.deepEqual(undeclared, [],
    `holt writes MCP config for hosts that are not in the manifest, so \`holt hosts\` cannot report `
    + `them and nothing documents them:\n  ${undeclared.join('\n  ')}`);
});

test('host manifest: a declared rules file is one holt can actually write or explain', () => {
  // AGENTS.md is the file holt writes. A host whose rulesFile is something else gets advisory
  // coverage ONLY if holt writes that file too — otherwise the manifest is promising guidance
  // through a channel the host never reads.
  for (const h of HOSTS) {
    assert.ok(typeof h.rulesFile === 'string' && h.rulesFile.length > 0,
      `${h.id} declares no rules file at all, so its advisory coverage is unstated`);
    assert.ok(typeof h.note === 'string' && h.note.length > 10,
      `${h.id} has no note explaining what protection it actually gets`);
  }
});

/* ------------------------------------------------- the formats holt now writes ---- */

test('codex: the TOML writer preserves every setting holt does not understand', async () => {
  // Codex CLI is the one major host whose MCP config is not JSON, and holt had no TOML writer at
  // all — so Codex was advertised as MCP-capable and written nothing. A user's config.toml also
  // holds their model, approval policy and SANDBOX settings, so this merges textually rather than
  // round-tripping through a hand-written parser: losing a sandbox rule would be a security
  // regression holt has no business causing.
  const { tomlWithHoltServer } = await import('../../src/integrate/adapters.mjs');

  const existing = 'model = "o3"\napproval_policy = "on-request"\n\n[sandbox]\nmode = "workspace-write"\n\n[mcp_servers.other]\ncommand = "npx"\n';
  const once = tomlWithHoltServer(existing, 'holt');

  assert.match(once, /\[mcp_servers\.holt\]/, 'holt must be registered');
  assert.match(once, /command = "holt"/);
  assert.match(once, /args = \["mcp"\]/);
  for (const kept of ['model = "o3"', 'approval_policy = "on-request"', '[sandbox]', 'mode = "workspace-write"', '[mcp_servers.other]']) {
    assert.ok(once.includes(kept), `merging must not drop the user's own setting: ${kept}`);
  }

  // IDEMPOTENT. integrate is documented as safe to run repeatedly, and agents and CI do.
  assert.equal(tomlWithHoltServer(once, 'holt'), once, 'a second run must produce an identical file');

  // Updating REPLACES the block rather than appending a second one, which TOML would reject.
  const moved = tomlWithHoltServer(once, 'node /new/holt.mjs');
  assert.equal((moved.match(/\[mcp_servers\.holt\]/g) ?? []).length, 1, 'exactly one holt table');
  assert.ok(moved.includes('[mcp_servers.other]'), 'and the neighbouring table survives');

  // A Windows path is full of backslashes, and TOML basic strings require them escaped — emitted
  // raw, the file does not parse and Codex silently loses every server in it.
  const win = tomlWithHoltServer('', 'C:\\tools\\holt.exe');
  assert.ok(win.includes('C:\\\\tools\\\\holt.exe'), `backslashes must be escaped: ${win}`);
});

test('cursor: the deny hook is written in Cursor\'s own schema, and denies in Cursor\'s own signal', async () => {
  // Cursor is the widest-reach host with a real deny hook. holt shipped none for a stated and
  // correct reason — "a wrong hook is worse than none" — and this one is taken from Cursor's
  // current hook documentation rather than guessed.
  const { cursorHooks, formatVerdict } = await import('../../src/integrate/adapters.mjs');

  const cfg = cursorHooks('holt');
  assert.equal(cfg.version, 1);
  assert.ok(Array.isArray(cfg.hooks.beforeShellExecution), 'the shell event is the one that matters');
  assert.match(cfg.hooks.beforeShellExecution[0].command, /hook pre-tool-use --host cursor/);

  const deny = formatVerdict({ decision: 'deny', reason: 'holt: would destroy the only copy of X' }, { host: 'cursor' });
  assert.equal(deny.permission, 'deny', 'Cursor blocks on permission:deny, not on an exit code alone');
  assert.match(deny.agentMessage, /holt/, 'the AGENT must be told why, or it retries with another verb');

  assert.equal(formatVerdict({ decision: 'allow' }, { host: 'cursor' }).permission, 'allow');

  // 'ask' has no Cursor equivalent. Mapping it to allow would turn "holt could not verify this"
  // into a silent green light, which is the fail-open shape this project exists to avoid.
  assert.equal(formatVerdict({ decision: 'ask', reason: 'could not verify' }, { host: 'cursor' }).permission, 'deny');
});

test('devin: the block signal is Devin\'s, not Claude Code\'s', async () => {
  const { formatVerdict } = await import('../../src/integrate/adapters.mjs');
  const deny = formatVerdict({ decision: 'deny', reason: 'holt: would destroy X' }, { host: 'devin' });
  assert.equal(deny.decision, 'block', 'Devin blocks on {decision:"block"}');
  assert.match(deny.reason, /holt/);
  assert.deepEqual(formatVerdict({ decision: 'allow' }, { host: 'devin' }), {},
    'an allow must be an empty object — anything else reads as a decision');
});

/* -------------------------------------------- per-host config-shape fixtures ---- */

/**
 * Every row below is asserted against the host's OWN current documentation (paths and keys quoted
 * in the comments next to each fixture, and in the corresponding hosts.mjs / adapters.mjs
 * comments) rather than against whatever mcpTargets happens to emit today — otherwise a
 * regression that changes the writer and the assertion together would sail through.
 *
 * `file` is a suffix match against the repo/home root `targets()` uses, so it is independent of
 * the tmpdir path this test runs under.
 */
const FIXTURES = [
  // GitHub Copilot CLI: docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers.
  // .github/mcp.json (mcpServers) — walked from cwd to repo root. NOT .vscode/mcp.json: a
  // Microsoft migration notice tells users to move OFF that file for the CLI, which uses the
  // unsupported key `servers`.
  { host: 'copilot', scope: 'project', file: path.join('.github', 'mcp.json'), key: 'mcpServers' },
  { host: 'copilot', scope: 'user', file: path.join('.copilot', 'mcp-config.json'), key: 'mcpServers' },
  // VS Code's OWN mcp.json: code.visualstudio.com/docs/agent-customization/mcp-servers — key
  // `servers`, and it is VS-Code-only (see above).
  { host: 'vscode', scope: 'project', file: path.join('.vscode', 'mcp.json'), key: 'servers' },
  // Cline: cline/cline#11671 — the CLI has NO project file, and the real global path is nested
  // under data/settings/, not the ~/.cline/mcp.json its own docs (wrongly) advertise.
  { host: 'cline', scope: 'user', file: path.join('.cline', 'data', 'settings', 'cline_mcp_settings.json'), key: 'mcpServers' },
  // Amazon Q Developer CLI: docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/mcp-ide.html — legacy
  // but enabled-by-default mcp.json, both scopes.
  { host: 'amazon-q', scope: 'project', file: path.join('.amazonq', 'mcp.json'), key: 'mcpServers' },
  { host: 'amazon-q', scope: 'user', file: path.join('.aws', 'amazonq', 'mcp.json'), key: 'mcpServers' },
  // Warp: docs.warp.dev/agent-platform/capabilities/mcp — .warp/.mcp.json, both scopes.
  { host: 'warp', scope: 'project', file: path.join('.warp', '.mcp.json'), key: 'mcpServers' },
  // Amp: ampcode.com/manual — DOTTED key, workspace file .amp/settings.json.
  { host: 'amp', scope: 'project', file: path.join('.amp', 'settings.json'), key: 'amp.mcpServers' },
  // Factory Droid: docs.factory.ai/cli/configuration/mcp.
  { host: 'factory', scope: 'project', file: path.join('.factory', 'mcp.json'), key: 'mcpServers' },
  // Junie: junie.jetbrains.com/docs/junie-cli-mcp-configuration.html — note the /mcp/ segment is
  // present in BOTH scopes, which is easy to drop by mistake when generalising from "~/.foo.json".
  { host: 'junie', scope: 'project', file: path.join('.junie', 'mcp', 'mcp.json'), key: 'mcpServers' },
  { host: 'junie', scope: 'user', file: path.join('.junie', 'mcp', 'mcp.json'), key: 'mcpServers' },
  // Zed: zed.dev/docs/ai/agent-settings — context_servers, not mcpServers.
  { host: 'zed', scope: 'project', file: path.join('.zed', 'settings.json'), key: 'context_servers' },
  // Gemini CLI: geminicli.com/docs/tools/mcp-server.
  { host: 'gemini-cli', scope: 'project', file: path.join('.gemini', 'settings.json'), key: 'mcpServers' },
];

test('host config fixtures: file path + top-level key match each host\'s own current docs', () => {
  const rows = targets();
  for (const f of FIXTURES) {
    const row = rows.find((r) => r.host === f.host && r.scope === f.scope);
    assert.ok(row, `no mcpTargets row for ${f.host} (${f.scope})`);
    assert.ok(row.file.endsWith(f.file),
      `${f.host} (${f.scope}): expected file ending in ${f.file}, got ${row.file}`);
    assert.equal(row.key, f.key, `${f.host} (${f.scope}): wrong top-level key`);
  }
});

test('cline: no project-scope MCP file is fabricated, and the user-scope path is the REAL one', () => {
  // cline/cline#11671: Cline's own maintainers confirm the CLI has exactly one MCP config file,
  // global, and that their docs (and a prior revision of holt's code) pointed at the wrong path.
  const rows = targets();
  const project = rows.filter((r) => r.host === 'cline' && r.scope === 'project');
  assert.deepEqual(project, [], 'Cline CLI has no project-scope MCP file — writing one would be dead config');

  const user = rows.find((r) => r.host === 'cline' && r.scope === 'user');
  assert.ok(user, 'Cline needs its (only) global config row');
  assert.ok(user.file.endsWith(path.join('.cline', 'data', 'settings', 'cline_mcp_settings.json')),
    `wrong Cline path: ${user.file} — must be data/settings/cline_mcp_settings.json, not the bare .cline/mcp.json Cline's own docs wrongly advertise`);
});

test('copilot vs vscode: two hosts, two files, two keys — never conflated', () => {
  // Copilot CLI does not read .vscode/mcp.json (unsupported key `servers`); VS Code's own mcp.json
  // is not read by the CLI either. Confusing the two previously let 'copilot' claim project-scope
  // coverage through a file the CLI never opens.
  const rows = targets();
  const copilotProject = rows.find((r) => r.host === 'copilot' && r.scope === 'project');
  const vscodeProject = rows.find((r) => r.host === 'vscode' && r.scope === 'project');
  assert.ok(copilotProject && vscodeProject, 'both rows must exist independently');
  assert.notEqual(copilotProject.file, vscodeProject.file, 'must be two different files');
  assert.equal(copilotProject.key, 'mcpServers');
  assert.equal(vscodeProject.key, 'servers');
  // No row may still carry the old combined label — that was the mechanism of the bug.
  assert.ok(!rows.some((r) => /vscode.*copilot|copilot.*vscode/i.test(r.host)),
    'no row may claim both hosts at once via a combined label');
});

test('amazon-q: reclassified local+mcp, and the manifest agrees with the writer', async () => {
  const { HOSTS } = await import('../../src/integrate/hosts.mjs');
  const h = HOSTS.find((x) => x.id === 'amazon-q');
  assert.ok(h, 'amazon-q must still be in the manifest');
  assert.equal(h.env, 'local', 'the Q Developer CLI is local (real files, real git) — verified against AWS\'s own docs');
  assert.equal(h.mcp, true);
  assert.notEqual(h.strength, 'advisory', 'a confirmed, real MCP config is more than advisory-only');

  const rows = targets();
  for (const scope of ['project', 'user']) {
    assert.ok(rows.some((r) => r.host === 'amazon-q' && r.scope === scope),
      `amazon-q must have a ${scope}-scope MCP row now that it is verified`);
  }
});

test('strengthLabel: verified-live blocking and docs-only blocking read as different claims', async () => {
  // Cursor is strength:'block' with verifiedLive:false — a real host, a real deny signal, taken
  // from Cursor's own published hook docs, but never actually driven against a live Cursor
  // process. Claude Code and OpenCode HAVE been driven live. The e2e manifest test already asserts
  // this distinction exists in the DATA (`verifiedLive` boolean); this asserts the human-facing
  // LABEL — what `holt hosts` and HOSTS.md actually print — does not paper back over it by
  // printing the identical string for both grades, which is what it did before this fix.
  const { HOSTS, strengthLabel } = await import('../../src/integrate/hosts.mjs');
  const live = HOSTS.find((h) => h.strength === 'block' && h.verifiedLive === true);
  const docsOnly = HOSTS.find((h) => h.strength === 'block' && h.verifiedLive === false);
  assert.ok(live, 'need at least one verified-live blocking host to compare against');
  assert.ok(docsOnly, 'need at least one docs-only (not yet driven live) blocking host to compare against');
  assert.notEqual(strengthLabel(live), strengthLabel(docsOnly),
    'a verified-live deny hook and a docs-derived-but-unfired one must not read as the same claim');
  assert.match(strengthLabel(live), /verified live/i);
  assert.match(strengthLabel(docsOnly), /not yet driven live|not.*verified live/i);
});

test('goose: the honest "add by hand" instructions use Goose\'s REAL field names', async () => {
  // goose-docs.ai/docs/guides/config-files: the command field is `cmd`, not `command`, and a
  // working entry needs `type: stdio` and `enabled: true`. A prior revision of this exact note
  // told a user to write `command: holt` — copying it verbatim would produce an extension Goose
  // silently ignores, which is worse than the honest "we don't write this" the note is FOR.
  const { HOSTS } = await import('../../src/integrate/hosts.mjs');
  const h = HOSTS.find((x) => x.id === 'goose');
  assert.equal(h.mcp, false, 'holt still does not write YAML for Goose');
  assert.match(h.note, /cmd:\s*holt/, 'must use the real field name `cmd`');
  assert.doesNotMatch(h.note, /\bcommand:\s*holt\b/, 'must NOT use the wrong field name `command`');
  assert.match(h.note, /type:\s*stdio/, 'stdio extensions need an explicit type');
  assert.match(h.note, /enabled:\s*true/, 'an extension with no enabled field defaults differently across versions');
});
