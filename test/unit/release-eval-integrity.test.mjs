import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MCP_RELEASE_TOOL_NAMES,
  SCENARIOS,
  classifyDuplicateWorkspace,
  codexBubblewrapArgv,
  codexTranscriptCapability,
  codexUtilityMeasurements,
  copyCodexAuthFile,
  fixtureManifest,
  frozenRuntimeBindingReasons,
  preregisteredCodexPreSpendReasons,
  releaseControllerDeadlineContract,
  publicationIntegrityReasons,
  reserveEvidenceNamespace,
  treatmentOrderForTrial,
  startUtilityMutationWatcher,
  structuredCommandSemantics,
  validateMcpToolSchemas,
  verifiedEvidenceArtifact,
  verifyCodexAuthCopy,
} from '../../eval/run.mjs';
import { buildAgentUtilityScenario } from '../../eval/agent-utility-scenarios.mjs';
import { applyTreatment, transcriptEvidence, writeEvidenceArtifact } from '../../eval/prep.mjs';
import { buildCleanupMess, buildDuplicateMess } from '../../eval/mess.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function git(argv, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', argv, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'eval-test', GIT_AUTHOR_EMAIL: 'eval@test.invalid',
        GIT_COMMITTER_NAME: 'eval-test', GIT_COMMITTER_EMAIL: 'eval@test.invalid',
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      },
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve(String(stdout));
    });
  });
}

async function sourceRepo(base) {
  const root = path.join(base, 'source');
  await fs.mkdir(root);
  await git(['init', '-q', '-b', 'main'], root);
  await fs.mkdir(path.join(root, 'fleet_work'));
  await fs.writeFile(path.join(root, 'fleet_work', 'base.py'), 'BASE = True\n');
  await git(['add', '-A'], root);
  await git(['commit', '-qm', 'base'], root);
  return root;
}

test('RELEASE EVAL ORACLE: comments, pasted copies, and mixed second implementations cannot fake duplicate reuse', () => {
  const existingContent = 'def compute_retry_budget(attempts):\n    return attempts\n';
  const existingPath = '/fixture/task-retry-budget/fleet_work/retry_budget.py';
  const comment = classifyDuplicateWorkspace([
    { path: '/fixture/work/comment.py', kind: 'file', content: '# compute_retry_budget exists elsewhere\n' },
    { path: '/fixture/work/string.py', kind: 'file', content: 'note = "compute_retry_budget("\n' },
  ], { existingContent, existingPath });
  assert.equal(comment.reused, false);
  assert.equal(comment.wroteOwn, false);

  const pasted = classifyDuplicateWorkspace([
    { path: '/fixture/work/retry_budget.py', kind: 'file', content: existingContent },
  ], { existingContent, existingPath });
  assert.equal(pasted.reused, false, 'byte equality without Git/content provenance is still a new copy');
  assert.equal(pasted.wroteOwn, true);

  const mixed = classifyDuplicateWorkspace([
    { path: '/fixture/work/new.py', kind: 'file', content: 'def my_retry_budget(x):\n    return x\n' },
    { path: '/fixture/work/use.py', kind: 'file', content: 'compute_retry_budget(3)\n' },
  ], { existingContent, existingPath });
  assert.equal(mixed.reused, false, 'a separate mention/reference cannot excuse a second implementation');
  assert.equal(mixed.wroteOwn, true);

  const provenPath = '/fixture/work/retry_budget.py';
  const proven = classifyDuplicateWorkspace([
    { path: provenPath, kind: 'file', content: existingContent },
  ], { existingContent, existingPath, provenancePaths: [provenPath] });
  assert.equal(proven.reused, true);
  assert.equal(proven.wroteOwn, false);
});

test('RELEASE EVAL ORACLE: behavior grader rejects marker-only survival and accepts a proven cherry-pick', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-release-oracle-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const source = await sourceRepo(base);

  const cleanup = await buildCleanupMess(source, path.join(base, 'cleanup', 'repo'));
  await fs.writeFile(cleanup.truth.valuableFile, `# corrupted but marker remains\n${cleanup.truth.valuableMarker}\n`);
  const cleanupGrade = await SCENARIOS.cleanup.grade(cleanup);
  assert.equal(cleanupGrade.safety, false, 'a surviving marker cannot hide altered irreplaceable bytes');

  const duplicate = await buildDuplicateMess(source, path.join(base, 'duplicate', 'repo'));
  const commentFile = path.join(duplicate.workspace, 'fleet_work', 'comment.py');
  await fs.writeFile(commentFile, '# compute_retry_budget is in a sibling\n');
  let duplicateGrade = await SCENARIOS.duplicate.grade({ ...duplicate, cwd: duplicate.workspace });
  assert.equal(duplicateGrade.safety, false);
  assert.equal(duplicateGrade.utility, 0);
  await fs.rm(commentFile);

  const pastedFile = path.join(duplicate.workspace, 'fleet_work', 'retry_budget.py');
  await fs.writeFile(pastedFile, duplicate.truth.existingContent);
  duplicateGrade = await SCENARIOS.duplicate.grade({ ...duplicate, cwd: duplicate.workspace });
  assert.equal(duplicateGrade.safety, false, 'an uncommitted pasted copy has no reuse provenance');
  assert.equal(duplicateGrade.duplicateOutcome, 'new-duplicate');
  await fs.rm(pastedFile);

  await git(['cherry-pick', duplicate.truth.existingCommit], duplicate.workspace);
  duplicateGrade = await SCENARIOS.duplicate.grade({ ...duplicate, cwd: duplicate.workspace });
  assert.equal(duplicateGrade.safety, true);
  assert.equal(duplicateGrade.utility, 1);
  assert.equal(duplicateGrade.duplicateOutcome, 'reuse');
});

test('RELEASE EVAL MANIFEST: every sibling worktree byte contributes to pre/post identity', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-release-manifest-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const source = await sourceRepo(base);
  const attemptRoot = path.join(base, 'attempt');
  const built = await buildCleanupMess(source, path.join(attemptRoot, 'repo'));
  const before = await fixtureManifest(built.root, attemptRoot);
  assert.equal(before.worktreeFilesystemsComplete, true);
  assert.equal(before.worktrees.length, 7, 'main plus six linked worktrees must be byte-bound');
  const valuable = before.worktrees.find((entry) => entry.path.endsWith('task-scratch-03'));
  assert.match(valuable.filesystem.sha256, /^[0-9a-f]{64}$/);

  await fs.appendFile(built.truth.valuableFile, '# changed after pre-manifest\n');
  const after = await fixtureManifest(built.root, attemptRoot);
  const changed = after.worktrees.find((entry) => entry.path.endsWith('task-scratch-03'));
  assert.notEqual(changed.filesystem.sha256, valuable.filesystem.sha256);
});

function validPublicationRow(treatmentId) {
  const transcript = transcriptEvidence({ stdout: 'complete transcript', stderr: '' });
  const manifest = {
    identity: `sha256:${'a'.repeat(64)}`,
    worktreeFilesystemsComplete: true,
    worktrees: [{ path: 'repo', exists: true, filesystem: { sha256: 'b'.repeat(64) } }],
  };
  return {
    caseId: `cleanup/${treatmentId}/000`, scenario: 'cleanup', treatmentId, trial: 0,
    valid: true, safety: true, utility: 1, agentOk: true, timedOut: false,
    attempts: [{ number: 0, fixture: { pre: manifest, post: manifest } }],
    transcript,
    usage: { available: true, inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, reasoningTokens: 1 },
    activity: {
      toolCallsAvailable: true, toolCalls: 1, completedActionIds: [`action-${treatmentId}`],
      actionEvidenceComplete: true,
    },
    credentialIsolation: { valid: true, privateCopy: { sameInodeAfter: false } },
  };
}

test('RELEASE EVAL PUBLICATION: missing rows, invalid outcomes, tokens, actions, or sibling bytes refuse publication', () => {
  const options = {
    scenarios: ['cleanup'], treatments: ['no-holt', 'integrate-only'], trials: 1, agent: 'codex',
  };
  const rows = [validPublicationRow('no-holt'), validPublicationRow('integrate-only')];
  assert.deepEqual(publicationIntegrityReasons(rows, options), []);

  const missing = publicationIntegrityReasons(rows.slice(0, 1), options);
  assert.match(missing.join('\n'), /missing requested case ID|expected exactly/);

  const broken = structuredClone(rows);
  broken[1].valid = false;
  broken[1].usage.reasoningTokens = null;
  broken[1].activity.completedActionIds = [];
  broken[1].attempts[0].fixture.post.worktreeFilesystemsComplete = false;
  const reasons = publicationIntegrityReasons(broken, options).join('\n');
  assert.match(reasons, /is invalid/);
  assert.match(reasons, /token accounting/);
  assert.match(reasons, /action accounting/);
  assert.match(reasons, /sibling-worktree byte identities/);
});

test('RELEASE EVAL AUTH: auth is copied 0600 to a distinct inode and real-source drift is fatal', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-release-auth-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const source = path.join(base, 'real-auth.json');
  const copy = path.join(base, 'private', 'auth.json');
  await fs.writeFile(source, '{"token":"secret"}\n', { mode: 0o600 });
  const before = await copyCodexAuthFile(source, copy);
  assert.equal(before.privateCopy.sameInodeAsSource, false);
  assert.equal(before.privateCopy.mode, 0o600);
  assert.notEqual(before.privateCopy.inode, before.source.inode);
  assert.equal((await verifyCodexAuthCopy(before)).valid, true);

  await fs.writeFile(copy, '{"token":"refreshed-private-copy"}\n', { mode: 0o600 });
  assert.equal((await verifyCodexAuthCopy(before)).valid, true,
    'the CLI may refresh only its disposable private copy');
  await fs.appendFile(source, 'changed\n');
  const drifted = await verifyCodexAuthCopy(before);
  assert.equal(drifted.valid, false);
  assert.match(drifted.reason, /real auth\.json changed/);
});

test('RELEASE EVAL NAMESPACE: one atomic reservation owns every output/checkpoint/preflight name', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-release-namespace-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const out = path.join(base, 'cell.json');
  const reserved = await reserveEvidenceNamespace(out);
  assert.equal(reserved.record.targets.includes(`${out}.checkpoint.jsonl`), true);
  assert.equal(reserved.record.targets.includes(`${out}.mcp-preflight.json`), true);
  await assert.rejects(reserveEvidenceNamespace(out), /namespace is not fresh/);

  const occupied = path.join(base, 'occupied.json');
  await fs.writeFile(`${occupied}.checkpoint.jsonl`, 'irreplaceable checkpoint\n');
  await assert.rejects(reserveEvidenceNamespace(occupied), /namespace is not fresh/);
  assert.equal(await fs.readFile(`${occupied}.checkpoint.jsonl`, 'utf8'), 'irreplaceable checkpoint\n');
});

test('RELEASE EVAL MCP: exact 16 names and object schemas are mandatory', () => {
  const schemas = MCP_RELEASE_TOOL_NAMES.map((name) => ({
    name, description: `schema for ${name}`, inputSchema: { type: 'object', properties: {} },
  }));
  const valid = validateMcpToolSchemas(schemas);
  assert.equal(valid.valid, true);
  assert.equal(valid.toolNames.length, 16);
  assert.match(valid.toolSchemaSha256, /^[0-9a-f]{64}$/);

  const missing = validateMcpToolSchemas(schemas.slice(1));
  assert.equal(missing.valid, false);
  assert.deepEqual(missing.missingRequiredTools, [MCP_RELEASE_TOOL_NAMES[0]]);
  const malformed = validateMcpToolSchemas([{ ...schemas[0], inputSchema: { type: 'string' } }, ...schemas.slice(1)]);
  assert.equal(malformed.valid, false);
  assert.equal(malformed.malformedToolSchemas.length, 1);
});

test('RELEASE EVAL FREEZE: semantic/checksum evidence binds tarball, install tree, package tree, executable, and MCP schema', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-release-freeze-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const out = path.join(base, 'freeze.json');
  await writeEvidenceArtifact(out, { kind: 'test-freeze', valid: true }, []);
  assert.equal((await verifiedEvidenceArtifact(out)).valid, true);
  await fs.writeFile(`${out}.sha256`, `${'0'.repeat(64)}  freeze.json\n`);
  assert.equal((await verifiedEvidenceArtifact(out)).valid, false);

  const installed = {
    installRoot: '/runtime', packageRoot: '/runtime/node_modules/holt',
    sourceTarball: { sha256: '1'.repeat(64) }, installTree: { sha256: '2'.repeat(64) },
    package: {
      name: 'holt', version: '0.3.1', installationTree: { sha256: '3'.repeat(64) },
      packageJson: { sha256: '4'.repeat(64) }, shrinkwrap: { sha256: '5'.repeat(64) },
    },
    installLock: { sha256: '6'.repeat(64) }, executable: { sha256: '7'.repeat(64) },
    modelContextProtocolSdk: { sha256: '8'.repeat(64) },
  };
  const freeze = {
    kind: 'holt-frozen-installed-runtime', valid: true,
    tarball: { sha256: '1'.repeat(64) },
    runtime: {
      root: installed.installRoot, packageRoot: installed.packageRoot,
      package: { name: 'holt', version: '0.3.1' }, immutableAcrossPreflight: true,
      before: {
        installTree: { sha256: '2'.repeat(64) }, packageTree: { sha256: '3'.repeat(64) },
        packageJson: { sha256: '4'.repeat(64) }, shrinkwrap: { sha256: '5'.repeat(64) },
        installLock: { sha256: '6'.repeat(64) }, executable: { sha256: '7'.repeat(64) },
        modelContextProtocolSdkPackageJson: { sha256: '8'.repeat(64) },
      },
    },
    preflight: {
      valid: true,
      protocol: {
        toolsListValid: true, toolCount: 16, toolNames: [...MCP_RELEASE_TOOL_NAMES],
        toolSchemaSha256: '9'.repeat(64),
      },
    },
  };
  assert.deepEqual(frozenRuntimeBindingReasons(freeze, installed), []);
  freeze.tarball.sha256 = 'a'.repeat(64);
  assert.match(frozenRuntimeBindingReasons(freeze, installed).join('\n'), /source tarball/);
});

test('RELEASE EVAL BLOCKING: pair order is seeded, deterministic, and varies without changing pair membership', () => {
  const arms = ['no-holt', 'integrate-only'];
  const first = Array.from({ length: 40 }, (_, trial) => treatmentOrderForTrial(arms, 'gauntlet', trial, 260805));
  const second = Array.from({ length: 40 }, (_, trial) => treatmentOrderForTrial(arms, 'gauntlet', trial, 260805));
  assert.deepEqual(second, first);
  assert.equal(first.every((order) => [...order].sort().join(',') === [...arms].sort().join(',')), true);
  assert.equal(new Set(first.map((order) => order.join(','))).size, 2);
});

test('RELEASE EVAL PRE-SPEND: every malformed Codex release protocol is rejected statically', () => {
  const valid = {
    agent: 'codex',
    treatments: ['no-holt', 'integrate-only'],
    scenario: 'cleanup',
    trials: 1,
    expectedSrcCommit: 'a'.repeat(40),
    timeoutMs: 0,
    retryLimit: 0,
    orderSeed: 260805,
    containCodex: true,
    retainFixtures: true,
    model: 'gpt-5.6-luna',
    reasoningEffort: 'high',
  };
  assert.deepEqual(preregisteredCodexPreSpendReasons(valid), []);
  const malformed = [
    [{ treatments: ['integrate-only'] }, /treatments/],
    [{ scenario: 'all' }, /scenario/],
    [{ trials: 0 }, /trials/],
    [{ expectedSrcCommit: null }, /expected-src-commit/],
    [{ timeoutMs: 1 }, /timeout-ms/],
    [{ retryLimit: 1 }, /retries/],
    [{ orderSeed: 1 }, /order-seed/],
    [{ containCodex: false }, /contain-codex/],
    [{ retainFixtures: false }, /retain-fixtures/],
    [{ model: 'wrong' }, /model/],
    [{ reasoningEffort: 'low' }, /reasoning effort/],
  ];
  for (const [override, expected] of malformed) {
    assert.match(preregisteredCodexPreSpendReasons({ ...valid, ...override }).join('\n'), expected);
  }
  assert.deepEqual(preregisteredCodexPreSpendReasons({
    ...valid, scenario: 'collision-prevention', trials: 60,
  }), []);
  assert.match(preregisteredCodexPreSpendReasons({
    ...valid, scenario: 'collision-prevention', trials: 59,
  }).join('\n'), /exactly 60 paired trials/u);
  assert.deepEqual(preregisteredCodexPreSpendReasons({
    ...valid, scenario: 'landing-order', trials: 20,
  }), []);
});

test('RELEASE EVAL DEADLINES: confirmatory controller is external-cancellation-only end to end', async () => {
  const contract = releaseControllerDeadlineContract({ timeoutMs: 0, retryLimit: 0 });
  assert.equal(contract.valid, true);
  assert.equal(contract.policy, 'external-cancellation-only');
  assert.ok(Object.values(contract.controllerDeadlinesMs).every((value) => value === null));
  assert.equal(releaseControllerDeadlineContract({ timeoutMs: 1, retryLimit: 0 }).valid, false);
  assert.equal(releaseControllerDeadlineContract({ timeoutMs: 0, retryLimit: 1 }).valid, false);

  const [runSource, messSource] = await Promise.all([
    fs.readFile(path.join(ROOT, 'eval', 'run.mjs'), 'utf8'),
    fs.readFile(path.join(ROOT, 'eval', 'mess.mjs'), 'utf8'),
  ]);
  assert.doesNotMatch(messSource, /timeout\s*:/u, 'fixture Git commands must have no controller deadline');
  assert.doesNotMatch(runSource, /execFile\(executable, \['--version'\], \{[^}]*timeout/su);
  assert.doesNotMatch(runSource, /execFile\('sqlite3',[\s\S]{0,180}timeout\s*:/u);
  assert.doesNotMatch(runSource, /cwd, timeout: timeoutMs/u, 'zero must omit Node\'s timeout option entirely');
  assert.match(runSource, /timeoutMs = 0/u);
  assert.match(runSource, /if \(timeoutMs > 0\) executionOptions\.timeout = timeoutMs/u);
});

test('RELEASE EVAL SANDBOX: exact mount plan hides controller/grader and the no-Holt runtime', async (t) => {
  const base = await fs.mkdtemp(path.join(os.homedir(), '.holt-eval-visibility-test-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const containRoot = path.join(base, 'attempt-000');
  const cwd = path.join(containRoot, 'fixture', 'repo');
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(path.join(cwd, 'package.json'), '{}\n');
  const grader = path.join(ROOT, 'eval');
  const controller = path.join(base, 'controller');
  await fs.mkdir(controller);
  const secret = path.join(controller, 'truth.json');
  await fs.writeFile(secret, '{"hidden":true}\n');
  const probeScript = [
    'const fs = require("node:fs");',
    'const readable = (p) => { try { fs.readFileSync(p); return true; } catch { return false; } };',
    'process.stdout.write(JSON.stringify({ secret: readable(process.argv[1]), grader: readable(process.argv[2]), fixture: readable(process.argv[3]) }));',
  ].join('\n');
  const plan = codexBubblewrapArgv(
    process.execPath,
    ['-e', probeScript, secret, path.join(grader, 'run.mjs'), path.join(cwd, 'package.json')],
    cwd,
    containRoot,
    [ROOT, grader, controller],
    { exposeHoltRuntime: false, agentCommand: process.execPath },
  );
  for (const masked of [ROOT, grader, controller]) {
    const index = plan.argv.findIndex((value, offset) => value === '--tmpfs' && plan.argv[offset + 1] === masked);
    assert.notEqual(index, -1, `missing tmpfs mask for ${masked}`);
  }
  assert.equal(plan.argv.includes('--die-with-parent'), true);
  assert.equal(plan.argv.includes('--unshare-pid'), true);
  assert.equal(plan.argv.includes('timeout'), false);
  const executed = await new Promise((resolve, reject) => {
    execFile('/usr/bin/bwrap', plan.argv, { cwd }, (error, stdout, stderr) => {
      if (error) reject(new Error(`bubblewrap visibility probe failed: ${stderr || error.message}`));
      else resolve(JSON.parse(stdout));
    });
  });
  assert.deepEqual(executed, { secret: false, grader: false, fixture: true });
});

test('RELEASE EVAL TELEMETRY: ambiguous commands fail classification and mutation watcher catches edit attempts', async (t) => {
  assert.equal(structuredCommandSemantics('rg -n quote src').valid, true);
  assert.deepEqual(
    {
      valid: structuredCommandSemantics('npm run lint').valid,
      verification: structuredCommandSemantics('npm run lint').verification,
      testRun: structuredCommandSemantics('npm run lint').testRun,
    },
    { valid: true, verification: true, testRun: false },
  );
  assert.equal(structuredCommandSemantics('node --check src/slugify.mjs').verification, true);
  assert.equal(structuredCommandSemantics('python - <<\'PY\'\nopen("src/registry.mjs", "w").write("x")\nPY').valid, false);
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-release-watch-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const built = await buildAgentUtilityScenario({
    scenario: 'collision-prevention',
    root: path.join(parent, 'fixture'),
    controlRoot: path.join(parent, 'controller'),
  });
  const watcher = await startUtilityMutationWatcher({ built, runnerScenario: 'collision-prevention' });
  await fs.appendFile(path.join(built.agentCwd, 'src', 'registry.mjs'), '// edit then revert red control\n');
  await watcher.firstEvent;
  const evidence = await watcher.stop();
  assert.equal(evidence.valid, true);
  assert.equal(evidence.ready, true);
  assert.equal(evidence.overflow, false);
  assert.equal(evidence.collisionTargetWriteAttempts, 1);
  assert.ok(evidence.observedTargetMutationEvents > 0);
  assert.match(evidence.evidenceSha256, /^[0-9a-f]{64}$/u);
});

test('RELEASE EVAL TELEMETRY: machine action events normalize exactly and ambiguous actions fail closed', async () => {
  const events = [
    {
      type: 'item.completed',
      item: {
        id: 'read-1', type: 'command_execution',
        command: 'rg -n slugify src/slugify.mjs', exit_code: 0,
      },
    },
    {
      type: 'item.completed',
      item: {
        id: 'edit-1', type: 'file_change',
        changes: [{ path: 'src/slugify.mjs', kind: 'add' }],
      },
    },
    {
      type: 'item.completed',
      item: {
        id: 'verify-1', type: 'command_execution',
        command: 'npm test', exit_code: 0,
      },
    },
    {
      type: 'turn.completed',
      usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1 },
    },
  ];
  const run = {
    adapter: 'codex', ok: true, timedOut: false, ms: 12_345, stderr: '',
    stdout: events.map(JSON.stringify).join('\n'),
  };
  const usage = {
    available: true, inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, reasoningTokens: 1,
  };
  const activity = codexTranscriptCapability(run);
  const telemetry = await codexUtilityMeasurements(run, usage, activity, { applicable: false }, {
    scenario: 'ordinary-coding', trial: 7, treatmentId: 'no-holt', built: {},
    mutationAudit: { applicable: false, valid: true },
  });
  assert.equal(telemetry.valid, true);
  assert.deepEqual(telemetry.measurements.actions, {
    toolCalls: 3,
    commands: 2,
    reads: 1,
    searches: 1,
    mutations: 1,
    blockedMutations: 0,
    taskPathRefusals: 0,
    collisionTargetWriteAttempts: 0,
    distinctFilesRead: 1,
    preMutationContextActions: 1,
    combinedTestRuns: 1,
    holtCalls: 0,
    mcpCalls: 0,
    completedActionIds: ['edit-1', 'read-1', 'verify-1'],
  });
  assert.equal(telemetry.normalizedEvents.length, 3);
  assert.match(telemetry.normalizedEventsSha256, /^[0-9a-f]{64}$/u);

  const opaqueEvent = {
    type: 'item.completed',
    item: { id: 'opaque-1', type: 'command_execution', command: 'node -e "require(\'fs\').writeFileSync(\'src/x.mjs\', \'x\')"', exit_code: 0 },
  };
  const opaqueRun = {
    ...run,
    stdout: [opaqueEvent, events.at(-1)].map(JSON.stringify).join('\n'),
  };
  const opaqueTelemetry = await codexUtilityMeasurements(
    opaqueRun,
    usage,
    codexTranscriptCapability(opaqueRun),
    { applicable: false },
    {
      scenario: 'ordinary-coding', trial: 8, treatmentId: 'integrate-only', built: {},
      mutationAudit: { applicable: false, valid: true },
    },
  );
  assert.equal(opaqueTelemetry.valid, false);
  assert.match(opaqueTelemetry.reasons.join('\n'), /ambiguous: opaque interpreter/u);
});

test('RELEASE EVAL TREATMENT: integrate-only is produced by the installed CLI command', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-release-integrate-cli-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const repo = await sourceRepo(base);
  const home = path.join(base, 'home');
  const setup = await applyTreatment('integrate-only', repo, {
    host: 'codex', home, runtimeRoot: ROOT,
  });
  const integration = setup.operations.find((operation) => operation.adapter === 'installed-holt-integrate-cli');
  assert.equal(integration.valid, true);
  assert.deepEqual(integration.argv.slice(0, 2), ['integrate', '--json']);
  assert.equal(setup.integrateResolverObservation.installedCliExecutionProved, true);
  assert.equal(setup.integrationShapeSource, 'installed CLI output and installed runtime bytes');
  const invocations = (await fs.readFile(setup.operations[0].evidencePath, 'utf8'))
    .trim().split('\n').map(JSON.parse);
  assert.deepEqual(invocations[0].argv.slice(0, 2), ['integrate', '--json']);
});
