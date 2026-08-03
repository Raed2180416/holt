/**
 * holt — MCP surface.
 *
 * Two things are being verified, and the second matters as much as the first:
 *   1. every tool returns the right ANSWER against ground truth;
 *   2. every tool returns a SMALL answer. An MCP tool that dumps 69 workstreams so the model
 *      can rediscover that 4 matter has failed even when its data is correct.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { standardFixture } from '../fixtures.mjs';
import { __test } from '../../src/mcp/server.mjs';

const { handle, TOOLS, clearCache } = __test;

async function call(name, fx, args = {}) {
  clearCache();
  return handle(name, { repo: fx.root, ...args });
}

test('MCP: every tool declares a name, description and object input schema', () => {
  assert.ok(TOOLS.length >= 7, 'expected the full tool set');
  for (const t of TOOLS) {
    assert.match(t.name, /^holt_[a-z_]+$/, `bad tool name: ${t.name}`);
    assert.ok(t.description.length > 40, `${t.name}: description too thin to route on`);
    assert.ok(t.description.length < 400, `${t.name}: description bloated — schemas are the token cost`);
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.inputSchema.additionalProperties, false, `${t.name}: schema must be closed`);
  }
});

test('MCP holt_status: returns the decision surface, not an inventory', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const r = await call('holt_status', fx);

  assert.equal(r.workstreams, 8);
  assert.equal(r.atRisk, 1, 'one workstream holds uncommitted-only work');
  assert.equal(r.collisions, 1);
  // Four, not two, and the extra pair is the POINT: alpha-1 and beta-1 commit byte-identical
  // content at different paths (the fixture's "two dispatches built the same thing"), so each is
  // disposable while the other lives — the per-file content-identity recall fix. The summary must
  // also SAY that two of the four are only conditionally safe, because an agent reading
  // `disposable: 4` with no qualifier deletes all four and loses the work both copies held.
  assert.equal(r.disposable, 4);
  assert.equal(r.disposableRedundant, 2,
    'the redundant pair must be distinguished from the genuinely-empty worktrees');
  assert.match(r.reviewQueue, /to review/);
  assert.ok(Array.isArray(r.topRisks) && r.topRisks.length === 1);
  assert.equal(r.topRisks[0].id, 'uniqueUncommitted');

  // Token discipline: the summary must not carry the full workstream list.
  const size = JSON.stringify(r).length;
  assert.ok(size < 2500, `holt_status payload is ${size} chars — too large for a summary tool`);
});

test('MCP holt_check_workstream: fail-closed verdicts with reasons', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const risky = await call('holt_check_workstream', fx, { id: 'uniqueUncommitted' });
  assert.equal(risky.safeToDelete, false);
  assert.match(risky.recommendation, /DO NOT DELETE/);
  assert.ok(risky.reasons.length > 0);

  const disposable = await call('holt_check_workstream', fx, { id: 'empty' });
  assert.equal(disposable.safeToDelete, true);
  assert.equal(disposable.confidence, 'measured');

  const missing = await call('holt_check_workstream', fx, { id: 'not-a-worktree' });
  assert.ok(missing.error, 'unknown id must be an explicit error');
  assert.ok(Array.isArray(missing.known) && missing.known.length > 0, 'must list what IS known');
});

test('MCP holt_context: names the contending sibling and what it already built', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const r = await call('holt_context', fx, { id: 'collideA' });
  assert.equal(r.workstream, 'collideA');
  const contested = r.contestedFiles.find((c) => c.workstream === 'collideB');
  assert.ok(contested, 'collideB should be reported as contesting');
  assert.ok(contested.files.includes('config/registry.mjs'));
  assert.ok(r.advice.length > 0);
});

test('MCP holt_collisions: reports the proven conflict with its evidence', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const r = await call('holt_collisions', fx);
  assert.equal(r.total, 1);
  const [c] = r.pairs;
  assert.equal(c.kind, 'proven');
  assert.equal(c.severity, 'high');
  assert.ok(c.why.includes('merge-tree'));
});

test('MCP holt_duplicates: finds the cross-dispatch pair', async (t) => {
  const { fx, truth } = await standardFixture();
  t.after(() => fx.cleanup());

  const r = await call('holt_duplicates', fx);
  const pair = r.pairs.find((p) =>
    (p.a === truth.duplicatePair[0] && p.b === truth.duplicatePair[1]) ||
    (p.b === truth.duplicatePair[0] && p.a === truth.duplicatePair[1]));
  assert.ok(pair, `expected duplicate pair ${truth.duplicatePair.join('/')}`);
  assert.equal(pair.classification, 'cross-dispatch-waste');
});

test('MCP: every list-returning tool SAYS when it capped the list', async (t) => {
  // A CAPPED LIST THAT DOES NOT SAY IT IS CAPPED READS AS THE WHOLE LIST. Measured on the owner's
  // repository, holt_collisions answered "what will I collide with?" with 10 pairs of 127 and no
  // field saying so, while holt_duplicates had reported {returned, truncated} all along. An agent
  // cannot ask for the rest of a list it was never told was cut — the project's signature defect
  // (absence of evidence read as evidence of absence) on the agent-facing surface.
  //
  // THIS TEST ASSERTS THE CONTRACT, NOT A TRUNCATION EVENT, and the difference is why it works.
  // The first version only checked tools with >= 2 rows and skipped the rest; this fixture yields
  // ONE collision, ONE duplicate and ZERO impact/hotspot rows, so it silently exercised a single
  // tool and passed with the fix reverted. `returned`/`truncated` must be present and consistent
  // at EVERY row count — including zero — so that is what is checked, and the count of tools
  // actually reached is asserted so this can never quietly go vacuous again.
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const LIST_TOOLS = [
    ['holt_collisions', 'pairs'],
    ['holt_duplicates', 'pairs'],
    ['holt_at_risk', 'workstreams'],
    ['holt_impact', 'pairs'],
    ['holt_hotspots', 'hotspots'],
  ];

  let exercised = 0;
  let truncationSeen = 0;
  for (const [tool, key] of LIST_TOOLS) {
    const full = await call(tool, fx, { limit: 100 });
    const rows = full[key] ?? [];

    assert.equal(typeof full.total, 'number', `${tool} must report a total`);
    assert.equal(typeof full.returned, 'number',
      `${tool} returns a list and must report 'returned' — without it a reader cannot tell a short list from a cut one`);
    assert.equal(typeof full.truncated, 'boolean', `${tool} must report 'truncated' as a boolean`);
    assert.equal(full.returned, rows.length, `${tool}: 'returned' must equal the rows actually sent`);
    assert.equal(full.truncated, full.total > full.returned,
      `${tool}: 'truncated' must be exactly (total > returned) — it said ${full.truncated} for ${full.returned} of ${full.total}`);
    exercised++;

    // Where the fixture has enough rows to cut, prove the flag actually flips.
    if (rows.length >= 2) {
      const capped = await call(tool, fx, { limit: 1 });
      assert.equal(capped.returned, (capped[key] ?? []).length, `${tool}: capped 'returned' must match the rows sent`);
      assert.equal(capped.truncated, true,
        `${tool} capped ${capped.total} rows to ${capped.returned} and did not say so`);
      truncationSeen++;
    }
  }

  // ANTI-VACUITY. A fixture change that empties these tools would otherwise turn this whole test
  // into an assertion about nothing, which is exactly how the first version passed while broken.
  assert.equal(exercised, LIST_TOOLS.length,
    `only ${exercised} of ${LIST_TOOLS.length} list tools were reached`);
  assert.ok(truncationSeen >= 1,
    'no tool in this fixture had enough rows to actually truncate — the flag was never observed ' +
    'flipping, so this test is not proving the behaviour it claims to');
});

test('MCP holt_landing_plan: accounts for every workstream', async (t) => {
  const { fx, truth } = await standardFixture();
  t.after(() => fx.cleanup());

  const r = await call('holt_landing_plan', fx);
  const seen = new Set([
    ...r.drop,
    ...r.collapse.map((s) => s.split(' -> ')[0]),
    ...r.order.map((o) => o.id),
  ]);
  for (const w of truth.allWorktrees) {
    assert.ok(seen.has(w), `'${w}' missing from the landing plan`);
  }
});

test('MCP: limit is honoured and clamped', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const r = await call('holt_at_risk', fx, { limit: 1 });
  assert.ok(r.workstreams.length <= 1);

  const huge = await call('holt_at_risk', fx, { limit: 99999 });
  assert.ok(Array.isArray(huge.workstreams), 'an absurd limit must not throw');
});

test('MCP: a non-repository path returns a clear error, not a crash', async () => {
  clearCache();
  await assert.rejects(
    () => handle('holt_status', { repo: '/nonexistent/definitely/not/a/repo' }),
    (e) => /not a git repository/.test(e.message),
  );
});
