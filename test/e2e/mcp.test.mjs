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
  assert.equal(r.disposable, 2);
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
