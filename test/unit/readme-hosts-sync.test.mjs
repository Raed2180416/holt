// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — README.md's host claims must still be true of the manifest.
 *
 * README.md carries its own prose about host coverage in three places (the "Honest coverage"
 * bullets, the "Verified end to end" table, the "Should work, but not yet verified" table) —
 * hand-written, not generated, because the surrounding sentences are genuine editorial content
 * (why a grade means what it means, which claims are backed by what evidence) that a mechanical
 * table can't carry. HOSTS.md's own table IS generated (scripts/generate-hosts.mjs); this file is
 * the other half — it cannot regenerate README's prose without flattening it, so instead it pins
 * every host-specific factual claim the prose makes to the manifest property that makes it true.
 * If `src/integrate/hosts.mjs` changes in a way that makes one of these sentences false — a host
 * gets promoted to a verified deny hook, a host loses MCP support, the roster changes size — this
 * fails, rather than the wrong prose sitting there uncaught the way the HOSTS.md/manifest drift
 * did for real (Cursor's block-hook promotion, the Roo/Kilo split).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { HOSTS, getHost } from '../../src/integrate/hosts.mjs';
import { mcpTargets } from '../../src/integrate/adapters.mjs';
import { __test as mcpTest } from '../../src/mcp/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const README_PATH = path.join(ROOT, 'README.md');
const SITE_PATH = path.join(ROOT, 'site', 'index.html');

// mcpTargets is pure — it only joins paths to describe what WOULD be written, never touches the
// filesystem — so a nonexistent tmpdir path is enough; matches the pattern host-manifest.test.mjs
// already uses.
const mcpRows = () => mcpTargets(path.join(os.tmpdir(), 'holt-readme-sync-repo'), path.join(os.tmpdir(), 'holt-readme-sync-home'), { scope: 'all' });

const readReadme = () => fs.readFile(README_PATH, 'utf8');

test('public MCP tool-count claims are derived from the executable schema', async () => {
  const [readme, site] = await Promise.all([
    readReadme(),
    fs.readFile(SITE_PATH, 'utf8'),
  ]);
  const count = mcpTest.TOOLS.length;
  assert.ok(count > 0, 'MCP schema unexpectedly has no tools');
  assert.ok(readme.includes(`**MCP** — ${count} tools`),
    `README integration claim is stale: executable MCP schema has ${count} tools`);
  assert.ok(readme.includes(`initialize → ${count} tools →`),
    `README protocol evidence is stale: executable MCP schema has ${count} tools`);
  assert.ok(site.includes(`${count} decision-oriented tools`),
    `site MCP claim is stale: executable MCP schema has ${count} tools`);
});

function host(id) {
  const h = getHost(id);
  assert.ok(h, `test fixture refers to unknown host id '${id}' — has it been renamed/removed in hosts.mjs?`);
  return h;
}

/** Same coverage check host-manifest.test.mjs uses: does mcpTargets write something for this host. */
function writesMcpConfigFor(rows, h) {
  return rows.some((r) => {
    const lc = String(r.host).toLowerCase();
    return lc === h.id.toLowerCase() || lc.split(/[\s/]+/).includes(h.id.toLowerCase());
  });
}

test('README: "nearly 30" stays a reasonable approximation of the split product surfaces', async () => {
  const text = await readReadme();
  assert.match(text, /nearly 30 distinct agent product surfaces/,
    'the sentence this test protects has moved or been reworded — update the test');
  assert.ok(HOSTS.length >= 24 && HOSTS.length <= 34,
    `HOSTS has ${HOSTS.length} entries — README's "nearly 30" is no longer a fair approximation; update README.md`);
});

test('README: no config/source smoke is claimed as a real-host enforcement run', async () => {
  const text = await readReadme();
  assert.match(text, /none is currently claimed as a real-host enforcement run/i);
  assert.deepEqual(HOSTS.filter((h) => h.verifiedLive === true), []);
});

test('README: implemented local hook list agrees with the manifest', async () => {
  const text = await readReadme();
  assert.match(text, /Claude Code, OpenCode, Cursor, Codex local clients, Qwen Code, Copilot CLI, Cline IDE, Goose, Devin CLI and Devin Desktop Cascade/);
  for (const id of ['claude-code', 'opencode', 'cursor', 'codex', 'qwen-code', 'copilot', 'cline', 'goose', 'devin-cli', 'cascade']) {
    assert.equal(host(id).strength, 'block', `${id} is named as implemented but the manifest disagrees`);
  }
});

test('README: hook-capable unwired list remains MCP plus advisory', async () => {
  const text = await readReadme();
  assert.match(text, /Gemini, Crush, Amp, Factory and Junie still receive MCP \+ advisory/,
    'the unwired deny-hook sentence has moved or been reworded — update the test');
  const ids = ['gemini-cli', 'crush', 'amp', 'factory', 'junie'];
  for (const id of ids) {
    const h = host(id);
    assert.equal(h.strength, 'mcp',
      `README lists ${id} among "MCP + advisory" hosts whose hook is not wired — but `
      + `the manifest already has it at strength '${h.strength}'; this host has been promoted and `
      + `README's coverage summary must be updated`);
    assert.equal(h.blockCapable, true,
      `README claims ${id} "supports a deny hook" — the manifest no longer marks it blockCapable`);
  }
});

test('README: cloud/ephemeral examples are actually cloud hosts in the manifest', async () => {
  const text = await readReadme();
  assert.match(text, /Codex cloud, Copilot cloud, Cursor cloud, Google Jules, Replit Agent/,
    'the cloud-caveat example list has moved or been reworded — update the test');
  for (const id of ['codex-cloud', 'copilot-cloud', 'cursor-cloud', 'jules', 'replit']) {
    const h = host(id);
    assert.equal(h.env, 'cloud', `README cites ${id} as a cloud/ephemeral example, but its env is '${h.env}'`);
  }
});

test('README "Verified end to end": the MCP-config host list still gets a real MCP config written', async () => {
  const text = await readReadme();
  assert.match(text, /Current MCP\/hook files for Cursor, Codex, Qwen Code, Copilot, Cline, Goose, Continue, Devin CLI, Cascade, Crush, Gemini CLI and VS Code/,
    'the verified MCP-config table row has moved or been reworded — update the test');
  const rows = mcpRows();
  assert.ok(rows.length > 0, 'mcpTargets returned nothing — this test cannot verify anything, fix the fixture call');
  for (const id of ['crush', 'cursor', 'gemini-cli', 'qwen-code', 'vscode', 'copilot', 'codex', 'continue', 'devin-cli', 'cascade']) {
    const h = host(id);
    assert.equal(h.mcp, true, `README claims ${id}'s MCP config is verified-written, but the manifest says mcp:${h.mcp}`);
    assert.ok(writesMcpConfigFor(rows, h),
      `README claims holt integrate writes ${id} a real MCP config, but mcpTargets() writes nothing for it`);
  }
});

test('README "should work, unverified": the listed hosts are MCP-capable but not verified-live blockers', async () => {
  const text = await readReadme();
  assert.match(text, /Gemini, Crush, Amp, Factory and Junie hooks/,
    'the "should work, unverified" table row has moved or been reworded — update the test');
  for (const id of ['gemini-cli', 'crush', 'amp', 'factory', 'junie']) {
    const h = host(id);
    assert.equal(h.mcp, true,
      `README claims ${id} "reads AGENTS.md and/or speaks MCP" — the manifest says mcp:${h.mcp}`);
    assert.ok(!(h.strength === 'block' && h.verifiedLive === true),
      `README lists ${id} as having its deny hook "not wired" / unverified — but the manifest now `
      + `shows it as a verified-live blocking host, so this row is stale and the host should move `
      + `to the "verified end to end" table`);
  }
});

test('README: every host id this file checks against actually exists in the manifest (anti-vacuity)', () => {
  const ids = [
    'claude-code', 'opencode', 'cursor', 'codex', 'gemini-cli', 'cline', 'copilot', 'crush', 'amp',
    'factory', 'junie', 'jules', 'replit', 'vscode', 'amazon-q', 'goose', 'devin-cli', 'cascade',
    'codex-cloud', 'copilot-cloud', 'cursor-cloud', 'continue',
  ];
  assert.ok(HOSTS.length >= 10, 'sanity: the manifest looks empty');
  for (const id of ids) assert.ok(getHost(id), `fixture id '${id}' is not in HOSTS — this test would be checking nothing`);
});
