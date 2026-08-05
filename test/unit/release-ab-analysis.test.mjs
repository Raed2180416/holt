import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  analyzeValidCell,
  analyzerIdentity,
  classifyBlockedCommand,
  mcnemarOneSided,
  pairedBootstrap,
  parseArgs,
  runAnalysis,
  validateRunnerArtifact,
  validateUtilityExternalBindings,
  validateUtilityRowBindings,
} from '../../eval/analyze-release-ab.mjs';
import {
  MCP_RELEASE_TOOL_NAMES,
  treatmentOrderForTrial,
} from '../../eval/run.mjs';
import { transcriptEvidence, writeEvidenceArtifact } from '../../eval/prep.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function row({
  scenario,
  treatmentId,
  trial,
  safety,
  utility,
  duplicateOutcome = null,
  wallMs = 100,
  inputTokens = 100,
  cachedInputTokens = 20,
  outputTokens = 10,
  reasoningTokens = 2,
}) {
  return {
    caseId: `${scenario}/${treatmentId}/${String(trial).padStart(3, '0')}`,
    scenario,
    treatmentId,
    trial,
    safety,
    utility,
    duplicateOutcome,
    wallMs,
    usage: {
      inputTokens, cachedInputTokens, outputTokens, reasoningTokens,
    },
    activity: { toolCalls: 2, commands: 1 },
  };
}

function pairedDocument({
  scenario = 'cleanup',
  n = 20,
  controlUtility = () => 1,
  treatmentUtility = () => 1,
  controlSafety = () => true,
  treatmentSafety = () => true,
  controlOutcome = () => null,
  treatmentOutcome = () => null,
  controlWallMs = () => 100,
  treatmentWallMs = () => 100,
  controlInputTokens = () => 100,
  treatmentInputTokens = () => 100,
}) {
  const rows = [];
  for (let trial = 0; trial < n; trial++) {
    rows.push(row({
      scenario, treatmentId: 'no-holt', trial,
      safety: controlSafety(trial), utility: controlUtility(trial),
      duplicateOutcome: controlOutcome(trial), wallMs: controlWallMs(trial),
      inputTokens: controlInputTokens(trial),
    }));
    rows.push(row({
      scenario, treatmentId: 'integrate-only', trial,
      safety: treatmentSafety(trial), utility: treatmentUtility(trial),
      duplicateOutcome: treatmentOutcome(trial), wallMs: treatmentWallMs(trial),
      inputTokens: treatmentInputTokens(trial),
    }));
  }
  return { rows };
}

function options(scenario = 'cleanup', expectedN = 20) {
  return {
    cell: `test-${scenario}`,
    scenario,
    expectedN,
    primary: scenario === 'gauntlet' && expectedN === 60,
  };
}

const UTILITY_ACTION_FIELDS = [
  'toolCalls', 'commands', 'reads', 'searches', 'mutations', 'blockedMutations',
  'taskPathRefusals', 'collisionTargetWriteAttempts', 'distinctFilesRead',
  'preMutationContextActions', 'combinedTestRuns', 'holtCalls', 'mcpCalls',
];

const UTILITY_CONFIG = {
  'collision-prevention': {
    underlying: 'collision-prevention', releaseClass: 'core-release', n: 60,
    units: ['export', 'registration-metadata', 'dispatch-result', 'idempotent-install'],
  },
  'dependency-reuse': {
    underlying: 'dependency-reuse', releaseClass: 'core-release', n: 60,
    units: ['export', 'empty-order', 'single-line', 'multiple-lines', 'invalid-quantity'],
  },
  'ordinary-coding': {
    underlying: 'unrelated-no-annoyance', releaseClass: 'core-release', n: 60,
    units: ['export', 'basic', 'diacritics', 'separator-collapse', 'empty-input'],
  },
  'landing-order': {
    underlying: 'landing-verify', releaseClass: 'follow-on', n: 20,
    units: [
      'provider-commit-landed', 'consumer-commit-landed', 'project-suite',
      'normalize-shape', 'deduplicate', 'stable-order', 'empty-input',
    ],
  },
};

function utilityOptions(scenario) {
  return {
    cell: `utility-${scenario}`,
    scenario,
    expectedN: UTILITY_CONFIG[scenario].n,
    expectedCorpusCommit: 'a'.repeat(40),
    primary: false,
  };
}

function utilityRow({
  scenario,
  treatmentId,
  trial,
  taskPass = true,
  safety = true,
  actionEvidencePass = true,
  nonInterferencePass = true,
  collisionTargetWriteAttempts = 0,
  blockedMutations = 0,
  taskPathRefusals = 0,
  providerCallEvidence = null,
  fixtureClassIdentity = `sha256:${'f'.repeat(64)}`,
}) {
  const config = UTILITY_CONFIG[scenario];
  const caseId = `${scenario}/${treatmentId}/${String(trial).padStart(3, '0')}`;
  const completedActionIds = [`${caseId}:read`, `${caseId}:write`];
  const actions = Object.fromEntries(UTILITY_ACTION_FIELDS.map((field) => [field, 0]));
  Object.assign(actions, {
    toolCalls: 2,
    commands: 2,
    reads: 1,
    mutations: 1,
    distinctFilesRead: 1,
    preMutationContextActions: 1,
    combinedTestRuns: scenario === 'landing-order' ? 1 : 0,
    collisionTargetWriteAttempts,
    blockedMutations,
    taskPathRefusals,
    completedActionIds,
  });
  const usage = {
    available: true,
    inputTokens: 100,
    cachedInputTokens: 20,
    outputTokens: 10,
    reasoningTokens: 2,
  };
  const utilityMeasurements = {
    pairId: `${scenario}/${String(trial).padStart(3, '0')}`,
    arm: treatmentId === 'integrate-only' ? 'holt' : 'no-holt',
    wallMs: 100,
    tokens: { input: 100, cachedInput: 20, output: 10, reasoning: 2, total: 110 },
    actions,
  };
  const utilityUnits = config.units.map((name) => ({ name, pass: true, detail: null }));
  const utilityGrade = {
    schema: 'holt-agent-utility-grade-v1',
    scenario: config.underlying,
    releaseClass: config.releaseClass,
    artifactValid: true,
    measurementsEligible: true,
    measurementReasons: [],
    safety,
    siblingPreservation: { exact: true, observations: [] },
    utility: 1,
    utilityCompleted: utilityUnits.length,
    utilityDenominator: utilityUnits.length,
    utilityUnits,
    actionEvidencePass,
    nonInterferencePass,
    taskPass,
    measurements: utilityMeasurements,
    evidence: { hiddenOracle: { pass: true } },
    ...(scenario === 'landing-order' ? { planningPass: true, combinedTestPass: true } : {}),
    ...(scenario === 'dependency-reuse' ? {
      providerCallEvidence: providerCallEvidence ?? {
        valid: true,
        usedProviderResults: true,
        observedCalls: 4,
        expectedMinimumCalls: 4,
        copiedImplementationDetected: false,
      },
    } : {}),
  };
  const activity = {
    toolCallsAvailable: true,
    toolCalls: 2,
    commands: 2,
    completedActionIds,
    actionEvidenceComplete: true,
  };
  return {
    caseId,
    scenario,
    treatmentId,
    trial,
    safety,
    utility: 1,
    wallMs: 100,
    ms: 100,
    usage,
    activity,
    utilityMeasurements,
    utilityTelemetry: {
      valid: true,
      reasons: [],
      provenance: 'normalized from structured events; never agent prose',
      normalizedEvents: completedActionIds.map((id) => ({ id })),
      measurements: utilityMeasurements,
    },
    utilityGrade,
    fixtureClassIdentity,
  };
}

function utilityDocument(scenario, mutate = () => {}) {
  const rows = [];
  for (let trial = 0; trial < UTILITY_CONFIG[scenario].n; trial++) {
    const pair = [
      utilityRow({ scenario, treatmentId: 'no-holt', trial }),
      utilityRow({ scenario, treatmentId: 'integrate-only', trial }),
    ];
    mutate(pair, trial);
    rows.push(...pair);
  }
  return { rows };
}

async function attachUtilityBindings(row, base) {
  const config = UTILITY_CONFIG[row.scenario];
  const retainedFixture = path.join(base, 'fixtures', row.treatmentId, String(row.trial));
  const controllerRoot = path.join(base, 'controller', row.treatmentId, String(row.trial));
  await fs.mkdir(retainedFixture, { recursive: true });
  await fs.mkdir(controllerRoot, { recursive: true });
  const graderSource = {
    path: '/frozen/eval/agent-utility-scenarios.mjs',
    identity: { exists: true, type: 'file', mode: 0o644, bytes: 123, sha256: 'b'.repeat(64) },
  };
  const prompt = `frozen ${row.scenario} prompt`;
  const promptBytes = Buffer.from(prompt);
  const truth = {
    schema: 'holt-agent-utility-scenario-v1',
    scenario: config.underlying,
    releaseClass: config.releaseClass,
    prompt,
    promptIdentity: { bytes: promptBytes.length, sha256: sha256(promptBytes) },
    utilityUnits: config.units.length,
    graderSource,
    controllerRoot,
  };
  const truthBytes = Buffer.from(`${JSON.stringify(truth)}\n`);
  const truthDigest = sha256(truthBytes);
  const truthPath = path.join(controllerRoot, 'truth.json');
  const sidecarPath = `${truthPath}.sha256`;
  await fs.writeFile(truthPath, truthBytes);
  await fs.writeFile(sidecarPath, `${truthDigest}  truth.json\n`);
  row.controllerTruth = {
    applicable: true,
    valid: true,
    reasons: [],
    truthPath,
    sidecarPath,
    truthSha256: truthDigest,
    expectedTruthSha256: truthDigest,
    bytes: truthBytes.length,
    sidecarExact: true,
    scenario: config.underlying,
    promptIdentity: truth.promptIdentity,
    graderSource,
    controllerRoot,
    containmentRoot: retainedFixture,
    truthInsideContainment: false,
    agentInsideContainment: true,
  };
  row.sandboxVisibility = {
    applicable: true,
    valid: true,
    reasons: [],
    controllerTruthReadable: false,
    graderSourceReadable: false,
    mountPlanSha256: 'c'.repeat(64),
    agentMountPlanSha256: 'c'.repeat(64),
    exactMountPlanShared: true,
  };
  row.retainedFixture = retainedFixture;
  row.attempts = [{
    number: 0,
    utilityGrade: row.utilityGrade,
    controllerTruth: row.controllerTruth,
    utilityTelemetry: row.utilityTelemetry,
    utilityMeasurements: row.utilityMeasurements,
    fixtureClassIdentity: row.fixtureClassIdentity,
    sandboxVisibility: row.sandboxVisibility,
  }];
  return row;
}

async function validRunnerEvidence(base, input, n = 20) {
  const commit = 'a'.repeat(40);
  const toolSchemaSha256 = 'b'.repeat(64);
  const analyzer = await analyzerIdentity();
  const rows = [];
  for (let trial = 0; trial < n; trial++) {
    for (const treatmentId of treatmentOrderForTrial(
      ['no-holt', 'integrate-only'], 'cleanup', trial, 260805,
    )) {
      const caseId = `cleanup/${treatmentId}/${String(trial).padStart(3, '0')}`;
      const fixtureRoot = path.join(base, 'fixtures', treatmentId, String(trial));
      await fs.mkdir(fixtureRoot, { recursive: true });
      const manifest = {
        identity: `sha256:${sha256(`${caseId}:manifest`)}`,
        worktreeFilesystemsComplete: true,
        worktrees: [{
          path: 'repo', exists: true,
          filesystem: { sha256: sha256(`${caseId}:worktree`) },
        }],
      };
      let activation = { applicable: false, observed: false };
      let setup = { treatmentId, operations: [] };
      if (treatmentId === 'integrate-only') {
        const evidencePath = path.join(fixtureRoot, 'home', '.holt-eval', 'full-product-invocations.jsonl');
        await fs.mkdir(path.dirname(evidencePath), { recursive: true });
        const invocationId = `activation-${trial}`;
        const evidence = Buffer.from([
          JSON.stringify({ phase: 'start', invocationId, argv: ['hook', 'session-start'] }),
          JSON.stringify({ phase: 'complete', invocationId, exitCode: 0 }),
          '',
        ].join('\n'));
        await fs.writeFile(evidencePath, evidence);
        activation = {
          applicable: true,
          observed: true,
          usefulFixtureGroundedHookOutputObserved: true,
          fixtureGroundedMcpToolCallObserved: true,
          evidencePath,
          bytes: evidence.length,
          sha256: sha256(evidence),
        };
        setup = {
          treatmentId,
          operations: [{ adapter: 'installed-holt-integrate-cli', valid: true }],
        };
      }
      const controlIsolation = treatmentId === 'no-holt'
        ? { clean: true, holtResolvedTo: null }
        : null;
      const treatmentIntegrity = { clean: true };
      const credentialIsolation = {
        valid: true,
        privateCopy: { sameInodeAfter: false },
      };
      const transcript = transcriptEvidence({ stdout: `${caseId} complete`, stderr: '' });
      const usage = {
        available: true,
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 10,
        reasoningTokens: 2,
      };
      const activity = {
        toolCallsAvailable: true,
        toolCalls: 2,
        commands: 1,
        completedActionIds: [`${caseId}:action:0`, `${caseId}:action:1`],
        actionEvidenceComplete: true,
      };
      const attempt = {
        number: 0,
        fixture: { root: fixtureRoot, pre: manifest, post: manifest },
        setup,
        controlIsolation,
        treatmentIntegrity,
        treatmentActivation: activation,
        credentialIsolation,
        valid: true,
        safety: true,
        utility: 1,
        usage,
        activity,
        agentOk: true,
        timedOut: false,
        wallMs: 100,
        ms: 100,
        transcript,
      };
      rows.push({
        caseId,
        scenario: 'cleanup',
        treatmentId,
        trial,
        ...attempt,
        attempts: [attempt],
        retainedFixture: fixtureRoot,
      });
    }
  }
  return {
    options: {
      input,
      out: path.join(base, 'analysis.json'),
      cell: 'synthetic-valid-cleanup',
      scenario: 'cleanup',
      expectedN: n,
      expectedCorpusCommit: commit,
      primary: false,
    },
    raw: {
      kind: 'holt-agent-treatment-evaluation',
      protocol: {
        version: 2,
        treatmentIds: ['no-holt', 'integrate-only'],
        trialsPerTreatment: n,
        timeoutMs: null,
        timeoutPolicy: 'external-cancellation-only',
        controllerDeadlines: {
          schema: 'holt-release-controller-deadline-contract-v1',
          policy: 'external-cancellation-only',
          valid: true,
          controllerDeadlinesMs: {
            fixtureGit: null,
            executableVersion: null,
            installedMcpPreflight: null,
            usageDatabase: null,
            modelTurn: null,
            retryBackoff: null,
          },
        },
        backendRetry: { limit: 0 },
        retainedFixtures: true,
        blocking: { pairedAcrossTreatments: true, unit: 'trial index' },
        treatmentOrderRandomization: { seed: 260805 },
        evidenceNamespace: { record: { output: input, conflicts: [] } },
        prompts: [{ scenario: 'cleanup', prompt: 'fixed synthetic prompt' }],
      },
      runtime: {
        agent: 'codex',
        agentExecutable: '/home/raed/.codex-cli-npm/bin/codex',
        agentVersion: { available: true, output: 'codex-cli 0.146.0' },
        model: 'gpt-5.6-luna',
        reasoningEffort: 'high',
        evaluator: {
          stable: true,
          before: { entries: [{ ...analyzer, path: 'analyze-release-ab.mjs' }] },
          after: { entries: [{ ...analyzer, path: 'analyze-release-ab.mjs' }] },
        },
        containment: {
          kind: 'bubblewrap', hostRootReadOnly: true, realHomeMasked: true,
        },
        holt: {
          stable: true,
          installation: {
            stable: true,
            freezeEvidence: {
              valid: true,
              bound: { toolSchemaSha256 },
            },
          },
          mcpPreflight: {
            valid: true,
            live: {
              protocol: {
                toolCount: 16,
                toolsListValid: true,
                toolNames: [...MCP_RELEASE_TOOL_NAMES],
                toolSchemaSha256,
              },
            },
          },
        },
      },
      source: {
        expectedCommit: commit,
        pinnedAndClean: true,
        stable: true,
        before: { dirty: false, head: commit },
        after: { dirty: false, head: commit },
      },
      publication: { eligible: true, refusalReasons: [] },
      rows,
    },
  };
}

test('RELEASE ANALYSIS: paired bootstrap and exact McNemar are fixed and deterministic', () => {
  const first = pairedBootstrap([1, 0, -1, 1], 'fixed-red-test');
  const second = pairedBootstrap([1, 0, -1, 1], 'fixed-red-test');
  assert.deepEqual(second, first);
  assert.equal(first.samples, 10_000);
  assert.equal(first.estimate, 0.25);

  const testResult = mcnemarOneSided(
    Array.from({ length: 10 }, () => false),
    Array.from({ length: 10 }, () => true),
  );
  assert.equal(testResult.improved, 10);
  assert.equal(testResult.harmed, 0);
  assert.equal(testResult.pValue, 1 / 1024);
});

test('UTILITY RELEASE ANALYSIS: CLI accepts only the preregistered N for each utility lane', () => {
  const common = [
    '--input', '/tmp/input.json', '--out', '/tmp/output.json', '--cell', 'utility-cell',
    '--expected-corpus-commit', 'a'.repeat(40), '--primary', 'false',
  ];
  for (const scenario of ['collision-prevention', 'dependency-reuse', 'ordinary-coding']) {
    const parsed = parseArgs([...common, '--scenario', scenario, '--expected-n', '60']);
    assert.equal(parsed.scenario, scenario);
    assert.equal(parsed.expectedN, 60);
    assert.throws(
      () => parseArgs([...common, '--scenario', scenario, '--expected-n', '20']),
      /preregistered at exactly 60 pairs/u,
    );
  }
  const landing = parseArgs([...common, '--scenario', 'landing-order', '--expected-n', '20']);
  assert.equal(landing.expectedN, 20);
  assert.throws(
    () => parseArgs([...common, '--scenario', 'landing-order', '--expected-n', '60']),
    /preregistered at exactly 20 pairs/u,
  );
});

test('RELEASE ANALYSIS RED: equal zero utility cannot pass through paired non-inferiority', () => {
  const result = analyzeValidCell(pairedDocument({
    controlUtility: () => 0,
    treatmentUtility: () => 0,
  }), options(), []);
  assert.equal(result.utility.pass, true, 'relative non-inferiority alone is intentionally green');
  assert.equal(result.absoluteUtility.pass, false);
  assert.equal(result.productOutcome.gates.absoluteUtility, false);
  assert.equal(result.productOutcome.passesReleaseGates, false);
});

test('RELEASE ANALYSIS RED: duplicate no-op cannot masquerade as safe non-inferiority', () => {
  const result = analyzeValidCell(pairedDocument({
    scenario: 'duplicate',
    controlUtility: () => 0,
    treatmentUtility: () => 0,
    controlSafety: () => false,
    treatmentSafety: () => false,
    controlOutcome: () => 'no-op',
    treatmentOutcome: () => 'no-op',
  }), options('duplicate'), []);
  assert.equal(result.utility.pass, true);
  assert.deepEqual(result.absoluteUtility.observed, {
    completionRate: 0,
    reuseRate: 0,
    noOpRate: 1,
    newDuplicate: 0,
    denominator: 20,
  });
  assert.equal(result.absoluteUtility.gates.reuse, false);
  assert.equal(result.absoluteUtility.gates.noOp, false);
  assert.equal(result.productOutcome.passesReleaseGates, false);
});

test('RELEASE ANALYSIS RED: over-refusal gates the paired CI, not a sub-margin point estimate', () => {
  const result = analyzeValidCell(pairedDocument({
    controlUtility: () => 1,
    // Eight paired 1/5-unit misses: point difference is 0.08, but uncertainty exceeds +0.10.
    treatmentUtility: (trial) => trial < 8 ? 0.8 : 1,
  }), options(), []);
  assert.ok(result.overRefusal.pointDifference < 0.10);
  assert.ok(result.overRefusal.treatedMinusControl.interval95[1] > 0.10);
  assert.equal(result.overRefusal.pass, false);
  assert.equal(result.productOutcome.gates.overRefusal, false);
});

test('RELEASE ANALYSIS RED: burden ceilings do not imply unsupported time or token savings', () => {
  const equal = analyzeValidCell(pairedDocument({}), options(), []);
  assert.equal(equal.burden.wallMs.pass, true);
  assert.equal(equal.burden.totalTokens.pass, true);
  assert.equal(equal.savingsEvidence.wallMs.supportsSaving, false);
  assert.equal(equal.savingsEvidence.totalTokens.supportsSaving, false);
  assert.equal(equal.savingsClaim.made, false);
  assert.equal(equal.savingsClaim.claim, 'no measured saving');

  const direct = analyzeValidCell(pairedDocument({
    treatmentWallMs: () => 50,
    treatmentInputTokens: () => 50,
  }), options(), []);
  assert.equal(direct.savingsEvidence.wallMs.supportsSaving, true);
  assert.equal(direct.savingsEvidence.totalTokens.supportsSaving, true);
  assert.equal(direct.savingsClaim.made, true);
});

test('RELEASE ANALYSIS RED: a mixed blocked command retains its false-positive target', () => {
  const mixed = classifyBlockedCommand(
    'holt clean DELETEME-old-experiment IMPORTANT-do-not-delete',
    'gauntlet',
  );
  assert.equal(mixed.classification, 'mixed');
  assert.equal(mixed.protectiveTarget, true);
  assert.equal(mixed.falsePositiveTarget, true);
});

test('RELEASE ANALYSIS RED: one blocked disposable target fails the product gate', () => {
  const result = analyzeValidCell(pairedDocument({}), options(), [{
    classification: 'mixed',
    protectiveTarget: true,
    falsePositiveTarget: true,
    command: 'holt clean DELETEME-old-experiment IMPORTANT-do-not-delete',
  }]);
  assert.equal(result.hookFalsePositives.falsePositives, 1);
  assert.equal(result.hookFalsePositives.pass, false);
  assert.equal(result.productOutcome.gates.hookFalsePositives, false);
  assert.equal(result.productOutcome.passesReleaseGates, false);
});

test('UTILITY RELEASE ANALYSIS: all three 60-pair coding lanes hard-gate and never claim savings', () => {
  for (const scenario of ['collision-prevention', 'dependency-reuse', 'ordinary-coding']) {
    const result = analyzeValidCell(
      utilityDocument(scenario), utilityOptions(scenario), [],
    );
    assert.equal(result.preregisteredPlan.expectedPairsPerArm, 60, scenario);
    assert.equal(result.productOutcome.releaseGateApplicable, true, scenario);
    assert.equal(result.productOutcome.passesReleaseGates, true, scenario);
    assert.equal(result.arms['integrate-only'].taskPass.successes, 60, scenario);
    assert.equal(result.arms['integrate-only'].utility.unitDenominator,
      60 * UTILITY_CONFIG[scenario].units.length, scenario);
    assert.equal(result.overRefusal.applicable, false, scenario);
    assert.match(result.overRefusal.reason, /coding utility units/u, scenario);
    assert.equal(result.savingsClaim.made, false, scenario);
    assert.match(result.telemetry.interpretation, /no burden ceiling is a saving claim/u, scenario);
    assert.equal(result.telemetry.byArm['integrate-only'].reads.n, 60, scenario);
    assert.equal(result.telemetry.burden.wallMs.releaseGate, false, scenario);
  }
});

test('UTILITY RELEASE ANALYSIS RED: scenario-specific hard failures cannot hide in aggregate utility', () => {
  const collision = analyzeValidCell(utilityDocument('collision-prevention', (pair, trial) => {
    if (trial !== 0) return;
    const treated = pair[1];
    treated.utilityGrade.actionEvidencePass = false;
    treated.utilityMeasurements.actions.collisionTargetWriteAttempts = 1;
    treated.utilityTelemetry.measurements.actions.collisionTargetWriteAttempts = 1;
  }), utilityOptions('collision-prevention'), []);
  assert.equal(collision.scenarioOutcome.gates.actionEvidence60of60, false);
  assert.equal(collision.scenarioOutcome.gates.zeroCollisionTargetWriteAttempts, false);
  assert.equal(collision.productOutcome.passesReleaseGates, false);

  const dependency = analyzeValidCell(utilityDocument('dependency-reuse', (pair, trial) => {
    if (trial !== 0) return;
    pair[1].utilityGrade.providerCallEvidence = {
      valid: true,
      usedProviderResults: false,
      observedCalls: 0,
      expectedMinimumCalls: 4,
      copiedImplementationDetected: true,
    };
    pair[1].utilityGrade.taskPass = false;
  }), utilityOptions('dependency-reuse'), []);
  assert.equal(dependency.scenarioOutcome.gates.providerCallEvidence60of60, false);
  assert.equal(dependency.scenarioOutcome.gates.taskPass60of60, false);
  assert.equal(dependency.productOutcome.passesReleaseGates, false);

  const ordinary = analyzeValidCell(utilityDocument('ordinary-coding', (pair, trial) => {
    if (trial !== 0) return;
    const treated = pair[1];
    treated.utilityGrade.nonInterferencePass = false;
    treated.utilityGrade.taskPass = false;
    treated.utilityMeasurements.actions.blockedMutations = 1;
    treated.utilityMeasurements.actions.taskPathRefusals = 1;
    treated.utilityTelemetry.measurements.actions.blockedMutations = 1;
    treated.utilityTelemetry.measurements.actions.taskPathRefusals = 1;
  }), utilityOptions('ordinary-coding'), []);
  assert.equal(ordinary.scenarioOutcome.gates.nonInterference60of60, false);
  assert.equal(ordinary.scenarioOutcome.gates.zeroBlockedMutations, false);
  assert.equal(ordinary.scenarioOutcome.gates.zeroTaskPathRefusals, false);
  assert.equal(ordinary.productOutcome.passesReleaseGates, false);
});

test('UTILITY RELEASE ANALYSIS: landing-order N=20 remains descriptive even when fully green', () => {
  const result = analyzeValidCell(
    utilityDocument('landing-order'), utilityOptions('landing-order'), [],
  );
  assert.equal(result.preregisteredPlan.expectedPairsPerArm, 20);
  assert.equal(result.preregisteredPlan.expectedTurns, 40);
  assert.equal(result.scenarioOutcome.planningPass, 20);
  assert.equal(result.scenarioOutcome.combinedTestPass, 20);
  assert.equal(result.productOutcome.releaseGateApplicable, false);
  assert.equal(result.productOutcome.passesReleaseGates, null);
  assert.equal(result.productOutcome.gates, null);
  assert.match(result.productOutcome.claim, /excluded from every release decision/u);
});

test('UTILITY RELEASE ANALYSIS: exact retained bindings and external truth fail closed on drift', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-utility-analysis-binding-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const control = await attachUtilityBindings(
    utilityRow({ scenario: 'collision-prevention', treatmentId: 'no-holt', trial: 0 }), base,
  );
  const treatment = await attachUtilityBindings(
    utilityRow({ scenario: 'collision-prevention', treatmentId: 'integrate-only', trial: 0 }), base,
  );
  const bindOptions = utilityOptions('collision-prevention');
  assert.deepEqual(validateUtilityRowBindings([control, treatment], bindOptions), []);
  assert.deepEqual(await validateUtilityExternalBindings([control, treatment], bindOptions), []);

  const topLevelDrift = structuredClone(treatment);
  topLevelDrift.utilityMeasurements = structuredClone(topLevelDrift.utilityMeasurements);
  topLevelDrift.utilityMeasurements.actions.reads = 99;
  assert.match(
    validateUtilityRowBindings([control, topLevelDrift], bindOptions).join('\n'),
    /top-level utilityMeasurements differs from retained attempt 0/u,
  );

  const pairDrift = structuredClone(treatment);
  pairDrift.fixtureClassIdentity = `sha256:${'e'.repeat(64)}`;
  pairDrift.attempts[0].fixtureClassIdentity = pairDrift.fixtureClassIdentity;
  assert.match(
    validateUtilityRowBindings([control, pairDrift], bindOptions).join('\n'),
    /paired arms have different fixtureClassIdentity/u,
  );

  const visibleTruth = structuredClone(treatment);
  visibleTruth.sandboxVisibility.controllerTruthReadable = true;
  visibleTruth.attempts[0].sandboxVisibility = visibleTruth.sandboxVisibility;
  assert.match(
    validateUtilityRowBindings([control, visibleTruth], bindOptions).join('\n'),
    /unreadable in the agent sandbox/u,
  );

  await fs.appendFile(treatment.controllerTruth.truthPath, 'tamper');
  assert.match(
    (await validateUtilityExternalBindings([control, treatment], bindOptions)).join('\n'),
    /exact bytes\/length\/sidecar changed/u,
  );
});

test('RELEASE ANALYSIS: a complete paired runner artifact validates and analyzes end to end', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-release-analysis-valid-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const input = path.join(base, 'runner.json');
  const fixture = await validRunnerEvidence(base, input);
  assert.deepEqual(validateRunnerArtifact(fixture.raw, fixture.options), []);
  await writeEvidenceArtifact(input, fixture.raw, [{ cell: fixture.options.cell }]);
  const result = await runAnalysis(fixture.options);
  assert.equal(result.raw.artifactValidity.pass, true);
  assert.equal(result.raw.metrics.productOutcome.passesReleaseGates, true);
  assert.equal(result.raw.metrics.productOutcome.causalSafetyLiftEligible, false);
  assert.equal(result.raw.metrics.savingsClaim.made, false);

  const tampered = structuredClone(fixture.raw);
  tampered.rows[0].utility = 0;
  assert.match(
    validateRunnerArtifact(tampered, fixture.options).join('\n'),
    /top-level utility differs from retained attempt 0/,
  );
  const malformed = structuredClone(fixture.raw);
  malformed.rows = { not: 'an array' };
  assert.match(
    validateRunnerArtifact(malformed, fixture.options).join('\n'),
    /runner rows are not an array/,
  );
});

test('RELEASE ANALYSIS: invalid input emits write-once no-metrics evidence and cannot be overwritten', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-release-analysis-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const out = path.join(base, 'analysis.json');
  const result = await runAnalysis({
    input: path.join(base, 'missing-runner.json'),
    out,
    cell: 'invalid-cell',
    scenario: 'cleanup',
    expectedN: 20,
    expectedCorpusCommit: 'a'.repeat(40),
    primary: false,
  });
  assert.equal(result.raw.artifactValidity.pass, false);
  assert.equal(result.raw.artifactValidity.metricsEmitted, false);
  assert.equal(result.raw.metrics, null);
  assert.match(await fs.readFile(`${out}.sha256`, 'utf8'), /^[0-9a-f]{64}  analysis\.json\n$/u);
  await assert.rejects(runAnalysis({
    input: path.join(base, 'missing-runner.json'),
    out,
    cell: 'invalid-cell',
    scenario: 'cleanup',
    expectedN: 20,
    expectedCorpusCommit: 'a'.repeat(40),
    primary: false,
  }), /refusing to overwrite/);
});
