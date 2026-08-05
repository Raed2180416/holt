// SPDX-License-Identifier: FSL-1.1-MIT
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  ROOT, CLI_COMMANDS, FEATURES, HOST_IDS, MCP_TOOLS,
  buildEvidenceCommands, buildPlan, focusedTestMarkers, gradeCommand, gradeRun, parseTap, runtimeIdentity,
  safeArtifactPath, sourceIdentity,
} from '../../scripts/run-feature-proof.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOC = path.join(ROOT, 'docs', 'FEATURE-PROOF-MATRIX.md');
const RUNNER = path.join(ROOT, 'scripts', 'run-feature-proof.mjs');
const BIN = path.join(ROOT, 'bin', 'holt.mjs');

async function walk(dir, out = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(absolute, out);
    else if (entry.isFile() && entry.name.endsWith('.test.mjs')) {
      out.push(path.relative(ROOT, absolute).split(path.sep).join('/'));
    }
  }
  return out;
}

function run(argv) {
  return new Promise((resolve) => {
    execFile(process.execPath, argv, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: String(stdout ?? ''), stderr: String(stderr ?? ''),
      }));
  });
}

function helpCommands(help) {
  const start = help.indexOf('\nCOMMANDS\n');
  const end = help.indexOf('\nOPTIONS\n');
  assert.ok(start >= 0 && end > start, 'help must retain COMMANDS through OPTIONS sections');
  const section = help.slice(start, end);
  return [...section.matchAll(/^  ([a-z][a-z-]*)(?:\s|$)/gm)].map((match) => match[1]);
}

test('FEATURE PROOF INVENTORY: every documented CLI command is mapped exactly once in the executable denominator', async () => {
  const result = await run([BIN, '--help']);
  assert.equal(result.code, 0, result.stderr);
  const documented = helpCommands(result.stdout);
  assert.ok(documented.length >= 40, `command denominator unexpectedly shrank to ${documented.length}`);
  assert.deepEqual(CLI_COMMANDS, documented,
    'the proof inventory must change in the same commit as the CLI help; no command may silently disappear');

  const covered = new Set(FEATURES.flatMap((feature) => feature.interfaces)
    .filter((surface) => surface.startsWith('cli:')).map((surface) => surface.slice(4)));
  assert.deepEqual(CLI_COMMANDS.filter((command) => !covered.has(command)), [],
    'every documented CLI command needs a user-visible feature row');
});

test('FEATURE PROOF INVENTORY: every executable MCP tool has a feature row, including destructive tools', () => {
  const covered = new Set(FEATURES.flatMap((feature) => feature.interfaces)
    .filter((surface) => /^mcp:holt_/.test(surface)).map((surface) => surface.slice(4)));
  assert.deepEqual(MCP_TOOLS.filter((tool) => !covered.has(tool)), [],
    'a newly declared MCP tool cannot inherit proof by association');
  assert.deepEqual([...covered].filter((tool) => !MCP_TOOLS.includes(tool)), [],
    'the matrix cannot advertise an MCP tool that is not executable');
});

test('FEATURE PROOF INVENTORY: feature rows are complete, unique, executable, and gap-bearing', async () => {
  const commands = await buildEvidenceCommands();
  const evidenceIds = new Set(commands.map((command) => command.id));
  const ids = FEATURES.map((feature) => feature.id);
  assert.equal(new Set(ids).size, ids.length, 'feature ids must be unique');
  assert.ok(ids.length >= 50, `feature denominator unexpectedly shrank to ${ids.length}`);

  for (const feature of FEATURES) {
    assert.match(feature.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(feature.area && feature.interfaces.length && feature.tests.length,
      `${feature.id}: area, interfaces, and exact tests are mandatory`);
    assert.ok(feature.oracle.length >= 24, `${feature.id}: independent oracle must be explained`);
    assert.ok(feature.gap.length >= 24, `${feature.id}: a remaining gap is mandatory`);
    assert.ok(feature.evidence.length, `${feature.id}: evidence command ids are mandatory`);
    for (const evidence of feature.evidence) {
      assert.ok(evidenceIds.has(evidence), `${feature.id}: unknown evidence command ${evidence}`);
    }
    for (const proof of feature.tests) {
      const absolute = path.join(ROOT, proof.path);
      const stat = await fs.stat(absolute);
      assert.ok(stat.isFile() && stat.size > 0, `${feature.id}: missing/empty proof file ${proof.path}`);
      assert.ok(proof.title.length >= 12, `${feature.id}: exact test/harness title is required`);
      const source = await fs.readFile(absolute, 'utf8');
      assert.ok(source.includes(proof.title),
        `${feature.id}: declared test/harness title is not present in ${proof.path}: ${proof.title}`);
    }
  }
});

test('FEATURE PROOF RUNNER: every test file is named explicitly; no glob or new file can be omitted', async () => {
  const expected = await walk(path.join(ROOT, 'test'));
  const commands = await buildEvidenceCommands();
  const complete = commands.find((command) => command.id === 'complete-test-corpus');
  assert.ok(complete, 'complete-test-corpus command is mandatory');
  assert.deepEqual(complete.testFiles, expected);
  assert.deepEqual(complete.args.slice(-expected.length), expected);
  assert.equal(new Set(complete.testFiles).size, complete.testFiles.length, 'test paths cannot be duplicated');
  assert.ok(complete.testFiles.includes('test/unit/feature-proof-contract.test.mjs'),
    'the anti-omission contract must itself run in the complete corpus');
  assert.ok(!complete.args.some((arg) => /[*?\[]/.test(arg)), 'test corpus must not rely on shell globs');
  assert.deepEqual(focusedTestMarkers(`test.${'on' + 'ly'}("x", fn); describe . ${'on' + 'ly'} ("y", fn);`),
    [`test.${'on' + 'ly'}(`, `describe . ${'on' + 'ly'} (`]);
  assert.deepEqual(focusedTestMarkers(`test("x", { ${'on' + 'ly'}: true }, fn);`), [`${'on' + 'ly'}: true`]);
  assert.deepEqual(focusedTestMarkers('test("ordinary", fn);'), []);
});

test('FEATURE PROOF RUNNER: the optional deep lane is mandatory for a full artifact', async () => {
  const commands = await buildEvidenceCommands();
  const deep = commands.find((command) => command.id === 'deep-runtime');
  assert.ok(deep, 'the advertised --deep lane needs its own mandatory runtime evidence');
  assert.equal(deep.kind, 'test');
  assert.ok(deep.args.includes('--internal-deep-runtime'));
  const feature = FEATURES.find((candidate) => candidate.id === 'deep-token-clone-analysis');
  assert.ok(feature?.evidence.includes('deep-runtime'));
});

test('FEATURE PROOF RUNNER: --no-symbols has an isolated behavioral lane, not reachability by association', async () => {
  const commands = await buildEvidenceCommands();
  const contract = commands.find((command) => command.id === 'no-symbols-contract');
  assert.ok(contract, 'the advertised performance mode needs dedicated equivalence and bypass evidence');
  assert.equal(contract.kind, 'test');
  assert.deepEqual(contract.testFiles, ['test/e2e/no-symbols.test.mjs']);
  assert.ok(contract.args.includes('test/e2e/no-symbols.test.mjs'));
  const feature = FEATURES.find((candidate) => candidate.id === 'bounded-analysis-and-honest-degradation');
  assert.ok(feature?.evidence.includes('no-symbols-contract'));
});

test('FEATURE PROOF RUNNER: a lexical outside path cannot symlink evidence back into source', async (t) => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-proof-boundary-'));
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));
  const link = path.join(scratch, 'outside-looking');
  await fs.symlink(ROOT, link, process.platform === 'win32' ? 'junction' : 'dir');
  const out = path.join(link, 'must-not-be-created-feature-proof.json');
  await assert.rejects(safeArtifactPath(out), /resolves through a symlink into the source tree/);
  await assert.rejects(fs.stat(path.join(ROOT, path.basename(out))),
    'canonical source-tree artifact must never be created');
});

test('FEATURE PROOF RUNNER: runtime identity names tools, dependencies, and environment without raw values', async () => {
  const runtime = await runtimeIdentity();
  assert.equal(runtime.platform, process.platform);
  assert.equal(runtime.arch, process.arch);
  assert.equal(runtime.node.version, process.version);
  assert.equal(runtime.node.versions.node, process.versions.node);
  for (const tool of ['git', 'ctags', 'enry', 'jscpd', 'jj', 'opencode', 'npm', 'holt']) {
    assert.ok(Object.hasOwn(runtime.tools, tool), `runtime identity omitted ${tool}`);
  }
  assert.deepEqual(runtime.dependencies.command, ['npm', 'ls', '--all', '--json']);
  assert.equal(typeof runtime.dependencies.stdoutSha256, 'string');
  assert.equal(runtime.dependencies.stdoutSha256.length, 64);
  assert.ok(Array.isArray(runtime.environment));
  for (const variable of runtime.environment) {
    assert.equal(Object.hasOwn(variable, 'value'), false, `${variable.name}: raw environment value leaked`);
    assert.ok(variable.valueRedacted === true || /^[a-f0-9]{64}$/.test(variable.valueSha256),
      `${variable.name}: environment identity must be hashed or explicitly redacted`);
  }
});

test('FEATURE PROOF RUNNER: ignored executable dependencies are byte-identifiable source inputs', async () => {
  const source = await sourceIdentity();
  assert.equal(source.captureSamples.length, 2);
  assert.ok(Array.isArray(source.dirtyState.ignoredRuntime));
  assert.ok(source.dirtyState.ignoredRuntime.length > 0,
    'a checkout executing installed packages cannot silently report zero ignored runtime files');
  const installed = source.dirtyState.ignoredRuntime.filter((entry) => entry.path.startsWith('node_modules/'));
  assert.ok(installed.length > 0, 'node_modules bytes must be represented, not inferred from version labels');
  assert.ok(installed.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256)));
});

test('FEATURE PROOF RUNNER: deterministic plan exposes full denominators and no partial-run switch', async () => {
  const first = await buildPlan();
  const second = await buildPlan();
  assert.deepEqual(second, first);
  assert.equal(first.universalProof, false);
  assert.equal(first.inventories.features.count, FEATURES.length);
  assert.equal(first.inventories.cliCommands.count, CLI_COMMANDS.length);
  assert.equal(first.inventories.mcpTools.count, MCP_TOOLS.length);
  assert.equal(first.inventories.hosts.count, HOST_IDS.length);
  assert.equal(first.inventories.testFiles.paths.length, first.inventories.testFiles.count);
  assert.equal(first.inventories.evidenceCommands.ids.length, first.inventories.evidenceCommands.count);
  assert.ok(first.inventories.evidenceCommands.count >= 12,
    'full proof must retain the dedicated deep-runtime lane and all cross-cutting gates');

  const source = await fs.readFile(RUNNER, 'utf8');
  assert.doesNotMatch(source, /\b(?:skip|only)\s*:/,
    'runner must not grow a code-level skip/only escape hatch');
  for (const command of first.commands) assert.ok(!('timeout' in command), `${command.id}: harness time limit is forbidden`);

  const a = await run([RUNNER, '--plan']);
  const b = await run([RUNNER, '--plan']);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(b.code, 0, b.stderr);
  assert.equal(a.stdout, b.stdout, 'the public plan must be byte-deterministic for unchanged source');
  assert.deepEqual(JSON.parse(a.stdout), first);

  const partial = await run([RUNNER, '--only', 'core']);
  assert.notEqual(partial.code, 0);
  assert.match(partial.stderr, /partial\/skip filters are intentionally unsupported/);
});

test('FEATURE PROOF RUNNER: zero tests, skips, todos, cancellations, and nonzero exits all invalidate evidence', () => {
  const clean = 'TAP version 13\n1..2\n# tests 2\n# suites 0\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
  assert.deepEqual(parseTap(clean), {
    tests: 2, suites: 0, pass: 2, fail: 0, cancelled: 0, skipped: 0, todo: 0,
    containsSkipDirective: false, containsTodoDirective: false,
  });
  assert.equal(gradeCommand({ kind: 'test', exitCode: 0, stdout: clean, stderr: '' }).pass, true);

  for (const [name, output] of [
    ['zero tests', clean.replace('# tests 2', '# tests 0')],
    ['skip summary', clean.replace('# skipped 0', '# skipped 1')],
    ['skip directive', `${clean}\nok 3 - unavailable # SKIP missing tool\n`],
    ['todo summary', clean.replace('# todo 0', '# todo 1')],
    ['cancelled', clean.replace('# cancelled 0', '# cancelled 1')],
  ]) {
    const grade = gradeCommand({ kind: 'test', exitCode: 0, stdout: output, stderr: '' });
    assert.equal(grade.pass, false, `${name} must invalidate proof`);
  }
  assert.equal(gradeCommand({ kind: 'gate', exitCode: 9, stdout: '', stderr: 'failed' }).pass, false);
});

test('FEATURE PROOF RUNNER: publication requires clean source, finite result shapes, and observed passing proof IDs', async () => {
  const plan = await buildPlan();
  const output = FEATURES.flatMap((feature) => feature.tests.map((proof) => proof.title)).join('\n');
  const results = plan.commands.map((command) => ({
    id: command.id, kind: command.kind, durationMs: 1, stdout: output, stderr: '',
    tap: { tests: 1, skipped: 0, todo: 0 }, grade: { pass: true, reasons: [] },
  }));
  const dirtySource = {
    before: { captureStable: true, commit: 'a', dirtyStateSha256: 'a', dirty: true },
    after: { captureStable: true, commit: 'a', dirtyStateSha256: 'a', dirty: true },
  };
  const grade = gradeRun(plan, results, dirtySource);
  assert.equal(grade.sourceClean, false);
  assert.equal(grade.valid, false);
  assert.equal(grade.resultShapeFailures.length, 0);
  assert.equal(grade.tokenClaims.claimed, false);
  assert.ok(grade.features.every((feature) => feature.observedPassingTestIds.length > 0));

  results[0].durationMs = Number.NaN;
  const malformed = gradeRun(plan, results, { ...dirtySource, before: { ...dirtySource.before, dirty: false }, after: { ...dirtySource.after, dirty: false } });
  assert.deepEqual(malformed.resultShapeFailures, [results[0].id]);
  assert.equal(malformed.valid, false);
});

test('FEATURE PROOF DOCUMENT: every feature, exact test, host, CLI, and MCP denominator is visible to auditors', async () => {
  const doc = await fs.readFile(DOC, 'utf8');
  assert.match(doc, /bounded proof/i);
  assert.match(doc, /not universal/i);
  assert.match(doc, /skips?[^\n]*fail/i);
  assert.match(doc, /source identity/i);
  assert.match(doc, /Google Antigravity[^\n]*not a blocking or live-verified integration/i);
  assert.ok(HOST_IDS.includes('antigravity'), 'the executable Antigravity adapter must stay in the host denominator');
  assert.ok(FEATURES.some((feature) => feature.id === 'antigravity-context-and-mcp-adapter'));
  assert.match(doc, /host:antigravity[^\n]*not blocking or live/i);
  assert.match(doc, /Provider profiles[^\n]*do not independently inflate this adapter grade/i);
  assert.doesNotMatch(doc, /every feature (?:works|is working) (?:absolutely )?perfectly/i);

  for (const feature of FEATURES) {
    assert.ok(doc.includes(`\`${feature.id}\``), `documentation missing feature ${feature.id}`);
    assert.ok(doc.includes(feature.oracle), `${feature.id}: documentation drifted from its independent oracle`);
    assert.ok(doc.includes(feature.gap), `${feature.id}: documentation drifted from its declared gap`);
    for (const surface of feature.interfaces) {
      assert.ok(doc.includes(`\`${surface}\``), `${feature.id}: documentation missing surface ${surface}`);
    }
    for (const proof of feature.tests) {
      assert.ok(doc.includes(`\`${proof.path}\``), `${feature.id}: documentation missing ${proof.path}`);
      assert.ok(doc.includes(`“${proof.title}”`), `${feature.id}: documentation missing exact title ${proof.title}`);
    }
  }
  assert.ok(doc.includes(`### CLI commands (${CLI_COMMANDS.length})`));
  assert.ok(doc.includes(`### MCP tools (${MCP_TOOLS.length})`));
  assert.ok(doc.includes(`### Declared hosts (${HOST_IDS.length})`));
  for (const command of CLI_COMMANDS) assert.ok(doc.includes(`\`cli:${command}\``), `documentation missing cli:${command}`);
  for (const tool of MCP_TOOLS) assert.ok(doc.includes(`\`mcp:${tool}\``), `documentation missing mcp:${tool}`);
  for (const host of HOST_IDS) assert.ok(doc.includes(`\`host:${host}\``), `documentation missing host:${host}`);
});
