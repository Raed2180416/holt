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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const README_PATH = path.join(ROOT, 'README.md');

// mcpTargets is pure — it only joins paths to describe what WOULD be written, never touches the
// filesystem — so a nonexistent tmpdir path is enough; matches the pattern host-manifest.test.mjs
// already uses.
const mcpRows = () => mcpTargets(path.join(os.tmpdir(), 'holt-readme-sync-repo'), path.join(os.tmpdir(), 'holt-readme-sync-home'), { scope: 'all' });

const readReadme = () => fs.readFile(README_PATH, 'utf8');

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

test('README: "~20 agent hosts" stays a reasonable approximation of the manifest size', async () => {
  const text = await readReadme();
  assert.match(text, /~20 agent hosts/, 'the sentence this test protects has moved or been reworded — update the test');
  // Loose bounds on purpose: "~20" tolerates the roster growing or shrinking a bit without a doc
  // change, but a manifest that has drifted to e.g. 40 or 8 hosts makes "~20" actively misleading.
  assert.ok(HOSTS.length >= 15 && HOSTS.length <= 30,
    `HOSTS has ${HOSTS.length} entries — README's "~20 agent hosts" is no longer a fair approximation; update README.md`);
});

test('README: hosts named as verified-live deterministic blocking really are', async () => {
  const text = await readReadme();
  assert.match(text, /Claude Code and OpenCode are \*verified live\*/,
    'the verified-live blocking sentence has moved or been reworded — update the test');
  for (const id of ['claude-code', 'opencode']) {
    const h = host(id);
    assert.equal(h.strength, 'block', `README claims ${id} is a verified-live blocking host, but its strength is '${h.strength}'`);
    assert.equal(h.verifiedLive, true, `README claims ${id} is verified-live, but verifiedLive is not true`);
  }
});

test('README: Cursor is named as docs-verified-but-not-live, matching the manifest', async () => {
  const text = await readReadme();
  assert.match(text, /\*\*Cursor\*\* now also blocks.*written from documentation rather than driven live/s,
    'the Cursor docs-verified sentence has moved or been reworded — update the test');
  const h = host('cursor');
  assert.equal(h.strength, 'block', 'README claims Cursor blocks; manifest disagrees');
  assert.equal(h.verifiedLive, false,
    'README claims Cursor\'s adapter is "written from documentation rather than driven live" — '
    + 'the manifest now says verifiedLive:true, so Cursor has been promoted and README is stale');
});

test('README: hosts named as "support a deny hook, MCP + advisory now" are not already verified-live blockers', async () => {
  const text = await readReadme();
  assert.match(text, /Codex, Gemini, Cline, Copilot, Crush, Amp, Factory and Junie \*support\* a deny hook/,
    'the deny-hook-planned sentence has moved or been reworded — update the test');
  const ids = ['codex', 'gemini-cli', 'cline', 'copilot', 'crush', 'amp', 'factory', 'junie'];
  for (const id of ids) {
    const h = host(id);
    assert.equal(h.strength, 'mcp',
      `README lists ${id} among "MCP + advisory now" hosts that merely support a deny hook — but `
      + `the manifest already has it at strength '${h.strength}'; this host has been promoted and `
      + `README's coverage summary must be updated`);
    assert.equal(h.blockCapable, true,
      `README claims ${id} "supports a deny hook" — the manifest no longer marks it blockCapable`);
  }
});

test('README: cloud/ephemeral examples are actually cloud hosts in the manifest', async () => {
  const text = await readReadme();
  assert.match(text, /Google Jules, Replit Agent, Devin cloud/,
    'the cloud-caveat example list has moved or been reworded — update the test');
  for (const id of ['jules', 'replit']) {
    const h = host(id);
    assert.equal(h.env, 'cloud', `README cites ${id} as a cloud/ephemeral example, but its env is '${h.env}'`);
  }
});

test('README "Verified end to end": the MCP-config host list still gets a real MCP config written', async () => {
  const text = await readReadme();
  assert.match(text, /Crush, Cursor, Gemini CLI, VS Code, Copilot CLI MCP config/,
    'the verified MCP-config table row has moved or been reworded — update the test');
  const rows = mcpRows();
  assert.ok(rows.length > 0, 'mcpTargets returned nothing — this test cannot verify anything, fix the fixture call');
  for (const id of ['crush', 'cursor', 'gemini-cli', 'vscode', 'copilot']) {
    const h = host(id);
    assert.equal(h.mcp, true, `README claims ${id}'s MCP config is verified-written, but the manifest says mcp:${h.mcp}`);
    assert.ok(writesMcpConfigFor(rows, h),
      `README claims holt integrate writes ${id} a real MCP config, but mcpTargets() writes nothing for it`);
  }
});

test('README "should work, unverified": the listed hosts are MCP-capable but not verified-live blockers', async () => {
  const text = await readReadme();
  assert.match(text, /Codex, Cline, Amp, Factory, Junie, Amazon Q Developer CLI/,
    'the "should work, unverified" table row has moved or been reworded — update the test');
  for (const id of ['codex', 'cline', 'amp', 'factory', 'junie', 'amazon-q']) {
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
    'factory', 'junie', 'jules', 'replit', 'vscode', 'amazon-q',
  ];
  assert.ok(HOSTS.length >= 10, 'sanity: the manifest looks empty');
  for (const id of ids) assert.ok(getHost(id), `fixture id '${id}' is not in HOSTS — this test would be checking nothing`);
});
