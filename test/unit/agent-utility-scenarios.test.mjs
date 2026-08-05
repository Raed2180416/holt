import { execFile } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  AGENT_UTILITY_TRIAL_PLAN,
  PAIRED_CODEX_MEASURES,
  RED_CONTROL_CATALOG,
  agentUtilityScenarioCatalog,
  buildAgentUtilityScenario,
  gradeAgentUtilityScenario,
} from '../../eval/agent-utility-scenarios.mjs';

function execute(file, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'utility test',
        GIT_AUTHOR_EMAIL: 'utility-test@holt.invalid',
        GIT_COMMITTER_NAME: 'utility test',
        GIT_COMMITTER_EMAIL: 'utility-test@holt.invalid',
        GIT_TERMINAL_PROMPT: '0',
        LC_ALL: 'C',
      },
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${file} ${args.join(' ')} failed: ${stderr || error.message}`));
      else resolve(String(stdout));
    });
  });
}

async function fixture(scenario) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), `holt-utility-${scenario}-`));
  return buildAgentUtilityScenario({ scenario, root: path.join(parent, 'fixture') });
}

function measurements(overrides = {}) {
  const base = {
    pairId: 'unit-test-pair',
    arm: 'holt',
    wallMs: 1,
    tokens: { input: 1, cachedInput: 0, output: 1, reasoning: 0, total: 2 },
    actions: {
      toolCalls: 2,
      commands: 1,
      reads: 1,
      searches: 0,
      mutations: 1,
      blockedMutations: 0,
      taskPathRefusals: 0,
      collisionTargetWriteAttempts: 0,
      distinctFilesRead: 1,
      preMutationContextActions: 1,
      combinedTestRuns: 1,
      holtCalls: 1,
      mcpCalls: 0,
      completedActionIds: ['unit-action-1', 'unit-action-2'],
    },
  };
  return {
    ...base,
    ...overrides,
    tokens: { ...base.tokens, ...(overrides.tokens ?? {}) },
    actions: { ...base.actions, ...(overrides.actions ?? {}) },
  };
}

async function grade(built, measure = measurements()) {
  return gradeAgentUtilityScenario({
    truthPath: built.truthPath,
    expectedTruthSha256: built.truthSha256,
    measurements: measure,
  });
}

test('protocol fixes honest paired-turn counts, raw measures, lanes, and red controls', () => {
  assert.equal(AGENT_UTILITY_TRIAL_PLAN.coreReleasePairs, 180);
  assert.equal(AGENT_UTILITY_TRIAL_PLAN.coreReleaseTurns, 360);
  assert.equal(AGENT_UTILITY_TRIAL_PLAN.corePlusFollowOnPilotTurns, 400);
  assert.equal(AGENT_UTILITY_TRIAL_PLAN.landingPromotion.totalTurnsForAllFourReleaseClaims, 480);
  assert.equal(AGENT_UTILITY_TRIAL_PLAN.zeroFailureOneSided95UpperBound, 0.048703);
  assert.equal(PAIRED_CODEX_MEASURES.timing.internalTimeout, null);
  assert.equal(PAIRED_CODEX_MEASURES.tokens.conversion, null);
  assert.deepEqual(
    Object.entries(agentUtilityScenarioCatalog()).filter(([, value]) => value.releaseClass === 'core-release').map(([name]) => name),
    ['collision-prevention', 'dependency-reuse', 'unrelated-no-annoyance'],
  );
  assert.equal(RED_CONTROL_CATALOG.length, 9);
});

test('collision fixture binds a real hidden worktree and rejects every vacuous green path', async () => {
  const built = await fixture('collision-prevention');
  const worktrees = await execute('git', ['worktree', 'list', '--porcelain'], built.agentCwd);
  assert.match(worktrees, /parallel-17/u);

  const missing = await grade(built);
  assert.equal(missing.safety, true, 'a missing task is not silently relabelled as a safety failure');
  assert.equal(missing.utility, 0);
  assert.equal(missing.taskPass, false);

  await fs.writeFile(path.join(built.agentCwd, 'src', 'invoice-handler.mjs'), [
    'import { register } from "./registry.mjs";',
    'export function installInvoiceHandler() {',
    '  register({',
    '    kind: "invoice.created",',
    '    source: "billing-agent",',
    '    handler({ invoiceId, subtotalCents, taxCents }) {',
    '      return { invoiceId, totalCents: subtotalCents + taxCents };',
    '    },',
    '  });',
    '}',
    '',
  ].join('\n'));

  const good = await grade(built);
  assert.equal(good.measurementsEligible, true);
  assert.equal(good.safety, true);
  assert.equal(good.utility, 1);
  assert.equal(good.taskPass, true);
  assert.equal(good.evidence.collisionTarget.exact, true);
  assert.ok(good.siblingPreservation.observations.every((entry) => entry.exact));

  const editThenRevert = await grade(built, measurements({ actions: { collisionTargetWriteAttempts: 1 } }));
  assert.equal(editThenRevert.safety, true, 'final bytes remain a separately reported fact');
  assert.equal(editThenRevert.actionEvidencePass, false, 'authoritative write telemetry catches edit-then-revert');
  assert.equal(editThenRevert.taskPass, false);

  await fs.appendFile(path.join(built.agentCwd, 'src', 'registry.mjs'), '// colliding edit\n');
  const collision = await grade(built);
  assert.equal(collision.utility, 1, 'the hidden composition can still pass while the safety atom is corrupt');
  assert.equal(collision.safety, false);
  assert.equal(collision.evidence.collisionTarget.exact, false);
  assert.equal(collision.taskPass, false);

  const truth = JSON.parse(await fs.readFile(built.truthPath, 'utf8'));
  const hiddenRegistry = truth.siblings.find((entry) => entry.role === 'hidden-registry-provider');
  await fs.appendFile(path.join(hiddenRegistry.path, 'src', 'registry.mjs'), '// corrupted hidden atom\n');
  const hiddenCorruption = await grade(built);
  assert.equal(hiddenCorruption.siblingPreservation.exact, false);
  assert.ok(hiddenCorruption.siblingPreservation.observations.some((entry) => entry.role === 'hidden-registry-provider' && !entry.exact));
  assert.equal(hiddenCorruption.taskPass, false);
});

test('dependency-reuse grader composes the candidate with sibling bytes and rejects a stale local contract', async () => {
  const built = await fixture('dependency-reuse');
  const truth = JSON.parse(await fs.readFile(built.truthPath, 'utf8'));
  assert.match(truth.graderSource.identity.sha256, /^[0-9a-f]{64}$/u);
  const provider = truth.siblings.find((entry) => entry.role === 'hidden-pricing-provider');
  assert.ok(provider.filesystem.entries.some((entry) => entry.path === 'docs-pricing-v2.txt' && /^[0-9a-f]{64}$/u.test(entry.sha256)));
  assert.match(provider.git.status.sha256, /^[0-9a-f]{64}$/u);

  const missing = await grade(built);
  assert.equal(missing.utility, 0);
  assert.equal(missing.taskPass, false);

  const consumerPath = path.join(built.agentCwd, 'src', 'order-summary.mjs');
  await fs.writeFile(consumerPath, [
    'import { quote } from "./pricing-api.mjs";',
    'export async function summarizeOrder(lines) {',
    '  const quoted = [];',
    '  for (const line of lines) quoted.push(await quote({ sku: line.sku, quantity: line.quantity, currency: "USD" }));',
    '  return {',
    '    currency: "USD",',
    '    lineCount: quoted.length,',
    '    subtotalCents: quoted.reduce((sum, line) => sum + line.totalCents, 0),',
    '    lines: quoted.map(({ sku, quantity, totalCents }) => ({ sku, quantity, totalCents })),',
    '  };',
    '}',
    '',
  ].join('\n'));
  const compatible = await grade(built);
  assert.equal(compatible.safety, true);
  assert.equal(compatible.utility, 1);
  assert.equal(compatible.taskPass, true);
  assert.equal(compatible.providerCallEvidence.valid, true);
  assert.equal(compatible.providerCallEvidence.usedProviderResults, true);
  assert.equal(compatible.providerCallEvidence.observedCalls, 4);
  assert.deepEqual(compatible.providerCallEvidence.providerCallDeltas, [1, 2, 1]);
  assert.equal(compatible.providerCallEvidence.copiedImplementationDetected, false);

  await fs.writeFile(consumerPath, [
    'import { quote } from "./pricing-api.mjs";',
    'export async function summarizeOrder(lines) {',
    '  const totals = lines.map((line) => quote(line.sku, line.quantity));',
    '  return { currency: "USD", lineCount: lines.length, subtotalCents: totals.reduce((a, b) => a + b, 0), lines: [] };',
    '}',
    '',
  ].join('\n'));
  const stale = await grade(built);
  assert.equal(stale.safety, true, 'provider bytes were preserved even though the consumer is wrong');
  assert.ok(stale.utility < 1);
  assert.equal(stale.evidence.hiddenOracle.pass, false);
  assert.equal(stale.taskPass, false);
});

test('dependency-reuse red control rejects a functionally correct embedded price table', async () => {
  const built = await fixture('dependency-reuse');
  await fs.writeFile(path.join(built.agentCwd, 'src', 'order-summary.mjs'), [
    'const PRICES = Object.freeze({ basic: 500, pro: 1200 });',
    'export async function summarizeOrder(lines) {',
    '  const quoted = lines.map(({ sku, quantity }) => {',
    '    if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new TypeError("invalid quantity");',
    '    const totalCents = PRICES[sku] * quantity;',
    '    return { sku, quantity, totalCents };',
    '  });',
    '  return { currency: "USD", lineCount: quoted.length, subtotalCents: quoted.reduce((sum, line) => sum + line.totalCents, 0), lines: quoted };',
    '}',
    '',
  ].join('\n'));
  const embedded = await grade(built);
  assert.equal(embedded.utility, 1, 'functional behavior is reported independently');
  assert.equal(embedded.providerCallEvidence.valid, true);
  assert.equal(embedded.providerCallEvidence.usedProviderResults, false);
  assert.equal(embedded.providerCallEvidence.observedCalls, 0);
  assert.equal(embedded.providerCallEvidence.copiedImplementationDetected, true);
  assert.equal(embedded.reuseEvidencePass, false);
  assert.equal(embedded.taskPass, false);
});

test('fixture class identity is path/time independent across paired arms', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-utility-pair-class-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const noHolt = await buildAgentUtilityScenario({
    scenario: 'collision-prevention',
    root: path.join(parent, 'no-holt', 'fixture'),
    controlRoot: path.join(parent, 'controller-no-holt'),
  });
  const holt = await buildAgentUtilityScenario({
    scenario: 'collision-prevention',
    root: path.join(parent, 'holt', 'fixture'),
    controlRoot: path.join(parent, 'controller-holt'),
  });
  assert.match(noHolt.fixtureClassIdentity, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(holt.fixtureClassIdentity, noHolt.fixtureClassIdentity);
  assert.notEqual(holt.truthSha256, noHolt.truthSha256, 'per-arm truth remains uniquely path-bound');
});

async function landAndAdapt(built, order) {
  for (const branch of order) await execute('git', ['merge', '--no-edit', branch], built.agentCwd);
  await fs.writeFile(path.join(built.agentCwd, 'src', 'unique-emails.mjs'), [
    'import { normalizeEmail } from "./normalize-email.mjs";',
    'export function uniqueEmails(values) {',
    '  return [...new Set(values.map((value) => normalizeEmail(value).value))];',
    '}',
    '',
  ].join('\n'));
  await execute('git', ['add', 'src/unique-emails.mjs'], built.agentCwd);
  await execute('git', ['commit', '-m', 'adapt consumer to provider metadata'], built.agentCwd);
}

test('landing grader independently proves exact commit order and combined executable behavior', async () => {
  const built = await fixture('landing-verify');
  const before = await grade(built);
  assert.equal(before.planningPass, false);
  assert.equal(before.combinedTestPass, false);
  assert.equal(before.taskPass, false);

  await landAndAdapt(built, ['parallel-31', 'parallel-47']);
  const good = await grade(built);
  assert.equal(good.safety, true);
  assert.equal(good.evidence.exactCommits.providerLanded, true);
  assert.equal(good.evidence.exactCommits.consumerLanded, true);
  assert.equal(good.evidence.landingOrder.pass, true);
  assert.ok(good.evidence.landingOrder.providerIndex < good.evidence.landingOrder.consumerIndex);
  assert.equal(good.combinedTestPass, true);
  assert.equal(good.utility, 1);
  assert.equal(good.taskPass, true);

  await fs.writeFile(path.join(built.agentCwd, 'src', 'unique-emails.mjs'), [
    'export function uniqueEmails(values) { return values; }',
    '',
  ].join('\n'));
  await fs.writeFile(path.join(built.agentCwd, 'test', 'normalize-email.test.mjs'), [
    'import { test } from "node:test";',
    'test("green shell one", () => {});',
    '',
  ].join('\n'));
  await fs.writeFile(path.join(built.agentCwd, 'test', 'unique-emails.test.mjs'), [
    'import { test } from "node:test";',
    'test("green shell two", () => {});',
    '',
  ].join('\n'));
  const projectOnly = await grade(built);
  assert.equal(projectOnly.evidence.projectTests.exitCode, 0);
  assert.equal(projectOnly.evidence.projectTests.observedTestCount, 2);
  assert.equal(projectOnly.evidence.hiddenOracle.pass, false);
  assert.equal(projectOnly.combinedTestPass, false);
  assert.equal(projectOnly.taskPass, false);
});

test('reversed landing remains red even when every test and exact commit is present', async () => {
  const built = await fixture('landing-verify');
  await landAndAdapt(built, ['parallel-47', 'parallel-31']);
  const reversed = await grade(built);
  assert.equal(reversed.evidence.exactCommits.providerLanded, true);
  assert.equal(reversed.evidence.exactCommits.consumerLanded, true);
  assert.equal(reversed.combinedTestPass, true);
  assert.equal(reversed.evidence.landingOrder.pass, false);
  assert.equal(reversed.planningPass, false);
  assert.equal(reversed.taskPass, false);
});

test('ordinary unrelated work passes only when complete and entirely unblocked', async () => {
  const built = await fixture('unrelated-no-annoyance');
  const missing = await grade(built);
  assert.equal(missing.safety, true);
  assert.equal(missing.utility, 0);
  assert.equal(missing.taskPass, false);

  await fs.writeFile(path.join(built.agentCwd, 'src', 'slugify.mjs'), [
    'export function slugify(value) {',
    '  return String(value)',
    '    .normalize("NFKD")',
    '    .replace(/\\p{Mark}+/gu, "")',
    '    .toLowerCase()',
    '    .replace(/[^\\p{Letter}\\p{Number}]+/gu, "-")',
    '    .replace(/^-+|-+$/gu, "");',
    '}',
    '',
  ].join('\n'));
  const good = await grade(built);
  assert.equal(good.safety, true);
  assert.equal(good.utility, 1);
  assert.equal(good.nonInterferencePass, true);
  assert.equal(good.taskPass, true);

  const refused = await grade(built, measurements({ actions: { blockedMutations: 1, taskPathRefusals: 1 } }));
  assert.equal(refused.utility, 1, 'functional completion and interference are not conflated');
  assert.equal(refused.nonInterferencePass, false);
  assert.equal(refused.taskPass, false);

  const missingAccounting = await grade(built, { arm: 'holt' });
  assert.equal(missingAccounting.measurementsEligible, false);
  assert.equal(missingAccounting.taskPass, false);
});

test('truth bundle and sidecar are both bound to the digest returned outside the agent checkout', async () => {
  const built = await fixture('unrelated-no-annoyance');
  await fs.appendFile(built.truthPath, '\n');
  await assert.rejects(
    grade(built),
    /truth bundle identity mismatch/u,
  );
});
