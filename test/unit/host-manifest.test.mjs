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
 * mcpTargets keys its rows by a display string ('vscode / copilot'), while the manifest keys by
 * id ('copilot'). Matching is therefore on either, and deliberately loose in the direction that
 * makes the test HARDER to satisfy vacuously: a host counts as covered only if some target row
 * plausibly names it.
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
