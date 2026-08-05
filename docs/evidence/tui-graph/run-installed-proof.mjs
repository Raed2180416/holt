#!/usr/bin/env node
// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * End-to-end installed TUI and graph proof.
 *
 * Required bindings may be supplied as --holt-bin/--runtime/--freeze-evidence or as the explicit
 * HOLT_BIN/HOLT_RUNTIME/FREEZE_EVIDENCE environment variables. If both forms are supplied they
 * must resolve to the same paths. This runner imports no Holt production module, has no skip/only
 * mode, never reads historical screenshot directories, and installs no command watchdog.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { buildAuditFixture } from './build-audit-fixture.mjs';
import { proveGraphBrowser } from './graph-browser-proof.mjs';
import {
  assert,
  assertExecutable,
  captureFile,
  exactSet,
  exists,
  frameMeasurements,
  inside,
  installationTreeIdentity,
  isolatedEnv,
  parseDataLiteral,
  publicRunRecord,
  runProcess,
  sha256,
  stripAnsi,
  verifyFreezeEvidence,
  writeChecksumManifest,
  writeEvidenceArtifact,
  writeRaw,
} from './installed-proof-support.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PTY_DRIVER = path.join(HERE, 'tui-pty-proof.py');

function binding(cli, env, cliName, envName) {
  if (cli && env && path.resolve(cli) !== path.resolve(env)) {
    throw new Error(`--${cliName} disagrees with ${envName}`);
  }
  const value = cli ?? env;
  if (!value) throw new Error(`--${cliName} or ${envName} is required`);
  return path.resolve(value);
}

export function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const allowedValues = new Set(['holt-bin', 'runtime', 'freeze-evidence', 'out', 'fixture']);
  const values = {};
  let allowSyntheticRuntime = false;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--allow-synthetic-runtime') {
      if (allowSyntheticRuntime) throw new Error('--allow-synthetic-runtime may be supplied only once');
      allowSyntheticRuntime = true;
      continue;
    }
    if (!token.startsWith('--')) throw new Error(`unexpected positional argument: ${token}`);
    const key = token.slice(2);
    if (!allowedValues.has(key)) throw new Error(`unknown option --${key}; no skip/only mode exists`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`--${key} requires a value`);
    if (values[key] !== undefined) throw new Error(`--${key} may be supplied only once`);
    values[key] = value;
  }
  const out = values.out && path.resolve(values.out);
  const fixture = values.fixture && path.resolve(values.fixture);
  if (!out || !fixture) throw new Error('--out and --fixture are required new paths');
  return {
    holtBin: binding(values['holt-bin'], env.HOLT_BIN, 'holt-bin', 'HOLT_BIN'),
    runtime: binding(values.runtime, env.HOLT_RUNTIME, 'runtime', 'HOLT_RUNTIME'),
    freezeEvidence: binding(values['freeze-evidence'], env.FREEZE_EVIDENCE,
      'freeze-evidence', 'FREEZE_EVIDENCE'),
    out,
    fixture,
    allowSyntheticRuntime,
  };
}

function compactRun(run, files) {
  const record = publicRunRecord(run);
  delete record.stdout;
  delete record.stderr;
  if (record.stdoutEvidence) delete record.stdoutEvidence.base64;
  if (record.stderrEvidence) delete record.stderrEvidence.base64;
  return { ...record, files };
}

async function invokeInstalled(context, label, args, { cwd = context.fixture.repo } = {}) {
  const run = await runProcess(context.holtBin, args, { cwd, env: context.env });
  const stdoutFile = await writeRaw(path.join(context.out, 'raw', `${label}.stdout.bin`), run.stdoutRaw);
  const stderrFile = await writeRaw(path.join(context.out, 'raw', `${label}.stderr.bin`), run.stderrRaw);
  return { run, evidence: compactRun(run, { stdout: stdoutFile, stderr: stderrFile }) };
}

function assertExit(run, expected, label) {
  assert(run.spawnError === null, `${label} could not spawn: ${run.spawnError}`);
  assert(run.signal === null, `${label} terminated by signal ${run.signal}`);
  assert(run.exitCode === expected, `${label} exited ${run.exitCode}, expected ${expected}: ${run.stderr}`);
}

function stablePrefix(id) {
  return [...id].slice(0, 11).join('');
}

function assertCounts(text, counts, label) {
  for (const exact of [
    `${counts.atRisk} at-risk`,
    `${counts.holds} holding`,
    `${counts.unknown} unknown`,
    `${counts.disposable} disposable`,
  ]) assert(text.includes(exact), `${label} is missing exact count '${exact}'`);
}

function listPane(frame) {
  return frame.lines.filter((line) => line.includes('│'))
    .map((line) => line.slice(0, line.indexOf('│'))).join('\n');
}

function selectedDetailId(frame) {
  const firstBody = frame.lines.find((line) => line.includes('│'));
  assert(firstBody, 'TUI frame has no body/detail divider');
  return firstBody.slice(firstBody.indexOf('│') + 1).trim().split(/\s+\[/)[0];
}

function assertAllRowsVisible(frame, expected, label) {
  const pane = listPane(frame);
  for (const id of expected.all) {
    const prefix = stablePrefix(id);
    assert(pane.includes(prefix), `${label} list pane is missing oracle workstream prefix '${prefix}'`);
  }
}

function assertFilterFrame(frame, filter, expected, label) {
  assert(frame.text.includes(`filter:${filter}`), `${label} footer is not filter:${filter}`);
  const pane = listPane(frame);
  const wanted = expected[filter];
  for (const id of wanted) {
    assert(pane.includes(stablePrefix(id)), `${label} is missing ${id}`);
  }
  for (const other of ['atRisk', 'holds', 'unknown', 'disposable']) {
    if (other === filter) continue;
    for (const id of expected[other]) {
      assert(!pane.includes(stablePrefix(id)), `${label} leaks ${other} workstream ${id}`);
    }
  }
  if (wanted.length === 0) {
    assert(frame.text.includes('no workstreams match this filter'),
      `${label} does not explain the empty filter state`);
  }
}

async function proveTui(context) {
  const expected = context.fixture.oracle.value.expected;
  const counts = expected.counts;
  const snapshot120 = await invokeInstalled(context, 'tui-snapshot-120x36', [
    'tui', '--snapshot', '--cwd', context.fixture.repo, '--columns', '120', '--rows', '36',
  ]);
  assertExit(snapshot120.run, 0, 'installed TUI 120x36 snapshot');
  const frame120 = frameMeasurements(snapshot120.run.stdoutRaw, 36, 120, 'TUI 120x36 snapshot');
  assertCounts(frame120.text, counts, 'TUI 120x36 snapshot');
  assertAllRowsVisible(frame120, expected, 'TUI 120x36 snapshot');
  assert(frame120.text.includes(expected.atRisk[0]), 'TUI detail lost the exact highest-risk id');
  assert(frame120.text.includes(`holt rescue ${expected.atRisk[0]} --release`),
    'TUI detail lost the exact evidence-backed rescue argv before width clipping');
  assert(!stripAnsi(snapshot120.run.stdoutRaw).includes('\x1b'), 'TUI 120x36 has residual ANSI bytes');

  const snapshot80 = await invokeInstalled(context, 'tui-snapshot-80x20', [
    'tui', '--snapshot', '--cwd', context.fixture.repo, '--columns', '80', '--rows', '20',
  ]);
  assertExit(snapshot80.run, 0, 'installed TUI 80x20 snapshot');
  const frame80 = frameMeasurements(snapshot80.run.stdoutRaw, 20, 80, 'TUI 80x20 snapshot');
  assertCounts(frame80.text, counts, 'TUI 80x20 snapshot');
  assertAllRowsVisible(frame80, expected, 'TUI 80x20 snapshot');
  assert(!stripAnsi(snapshot80.run.stdoutRaw).includes('\x1b'), 'TUI 80x20 has residual ANSI bytes');

  const empty = await invokeInstalled(context, 'tui-empty-state', [
    'tui', '--snapshot', '--cwd', context.fixture.emptyRepo, '--columns', '80', '--rows', '20',
  ], { cwd: context.fixture.emptyRepo });
  assertExit(empty.run, 0, 'installed TUI empty state');
  const emptyFrame = frameMeasurements(empty.run.stdoutRaw, 20, 80, 'TUI empty state');
  assertCounts(emptyFrame.text, { atRisk: 0, holds: 0, unknown: 0, disposable: 0 },
    'TUI empty state');
  assert(emptyFrame.text.includes('no workstreams match this filter'),
    'TUI empty state lacks an explanatory empty message');

  const error = await invokeInstalled(context, 'tui-error-state', [
    'tui', '--snapshot', '--cwd', context.fixture.errorRoot, '--columns', '80', '--rows', '20',
  ], { cwd: context.fixture.errorRoot });
  assert(error.run.spawnError === null && error.run.signal === null,
    'installed TUI error-state command did not complete normally');
  assert(error.run.exitCode !== 0, 'TUI returned success for a non-repository');
  assert(/repository|git/i.test(error.run.stderr),
    `TUI non-repository error is not actionable: ${error.run.stderr}`);

  const python = await fs.realpath(process.env.PYTHON3 ?? '/usr/bin/python3');
  const pty = await runProcess(python, [PTY_DRIVER, '--holt-bin', context.holtBin,
    '--cwd', context.fixture.repo], { cwd: context.fixture.repo, env: context.env });
  const ptyStdout = await writeRaw(path.join(context.out, 'raw', 'tui-pty-driver.stdout.bin'), pty.stdoutRaw);
  const ptyStderr = await writeRaw(path.join(context.out, 'raw', 'tui-pty-driver.stderr.bin'), pty.stderrRaw);
  assertExit(pty, 0, 'installed interactive TUI PTY proof');
  let ptyValue;
  try { ptyValue = JSON.parse(pty.stdout); } catch (failure) {
    throw new Error(`PTY proof did not emit one JSON value: ${failure.message}`);
  }
  assert(ptyValue.schema === 'holt-installed-tui-pty-v1' && ptyValue.exitCode === 0,
    'PTY proof schema or exit status mismatch');
  const frames = {};
  for (const entry of ptyValue.frames) {
    const raw = Buffer.from(entry.rawBase64, 'base64');
    const file = await writeRaw(path.join(context.out, 'raw', `${entry.name}.ansi.bin`), raw);
    frames[entry.name] = {
      ...frameMeasurements(raw, entry.rows, entry.columns, entry.name),
      file,
    };
  }
  assertCounts(frames['initial-all-120x36'].text, counts, 'interactive initial frame');
  assertAllRowsVisible(frames['initial-all-120x36'], expected, 'interactive initial frame');
  assertFilterFrame(frames['filter-atRisk-120x36'], 'atRisk', expected, 'interactive atRisk filter');
  assertFilterFrame(frames['filter-atRisk-move-j-120x36'], 'atRisk', expected,
    'interactive atRisk j movement');
  const selectedBefore = selectedDetailId(frames['filter-atRisk-120x36']);
  const selectedAfter = selectedDetailId(frames['filter-atRisk-move-j-120x36']);
  assert(selectedBefore !== selectedAfter, `j did not change selection: ${selectedBefore}`);
  assert(expected.atRisk.includes(selectedBefore) && expected.atRisk.includes(selectedAfter),
    'j moved selection outside the atRisk oracle bucket');
  assertFilterFrame(frames['filter-holds-120x36'], 'holds', expected, 'interactive holds filter');
  assertFilterFrame(frames['filter-unknown-empty-120x36'], 'unknown', expected,
    'interactive unknown empty filter');
  assertFilterFrame(frames['filter-disposable-120x36'], 'disposable', expected,
    'interactive disposable filter');
  assertFilterFrame(frames['filter-disposable-resized-move-j-80x20'], 'disposable', expected,
    'interactive resized disposable filter');

  const frameEvidence = Object.fromEntries(Object.entries(frames).map(([name, frame]) => [name, {
    rows: frame.rows,
    columns: frame.columns,
    maxWidth: frame.maxWidth,
    file: frame.file,
  }]));
  return {
    valid: true,
    oracleCounts: counts,
    snapshots: {
      '120x36': { command: snapshot120.evidence, rows: 36, maxWidth: frame120.maxWidth },
      '80x20': { command: snapshot80.evidence, rows: 20, maxWidth: frame80.maxWidth },
    },
    states: { empty: empty.evidence, error: error.evidence },
    interactive: {
      driver: await captureFile(PTY_DRIVER),
      python: await captureFile(python),
      command: compactRun(pty, { stdout: ptyStdout, stderr: ptyStderr }),
      keys: ptyValue.keys,
      selection: { before: selectedBefore, after: selectedAfter },
      frames: frameEvidence,
    },
  };
}

function parseGraphJson(run) {
  try { return JSON.parse(run.stdout); } catch (failure) {
    throw new Error(`installed graph --json did not emit one JSON value: ${failure.message}`);
  }
}

function pairMatches(edge, pair) {
  return [edge.source, edge.target].sort().join('\0') === [...pair].sort().join('\0');
}

function graphBuckets(graph) {
  const atRisk = graph.nodes.filter((node) => node.uncommittedOnly > 0).map((node) => node.id);
  const disposable = graph.nodes.filter((node) => node.safeToDelete === true).map((node) => node.id);
  const holds = graph.nodes.filter((node) => node.uncommittedOnly === 0 && node.safeToDelete !== true)
    .map((node) => node.id);
  return { atRisk, holds, disposable };
}

async function proveGraph(context) {
  const expected = context.fixture.oracle.value.expected;
  const terminal = await invokeInstalled(context, 'graph-terminal', [
    'graph', '--cwd', context.fixture.repo,
  ]);
  assertExit(terminal.run, 0, 'installed graph terminal');
  const json = await invokeInstalled(context, 'graph-json', [
    'graph', '--cwd', context.fixture.repo, '--json',
  ]);
  assertExit(json.run, 0, 'installed graph JSON');
  const graph = parseGraphJson(json.run);
  exactSet(graph.nodes.map((node) => node.id), expected.all, 'graph JSON nodes');
  assert(Array.isArray(graph.edges), 'graph JSON edges is not an array');
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  for (const edge of graph.edges) {
    assert(nodeIds.has(edge.source) && nodeIds.has(edge.target),
      `graph edge references absent endpoint: ${JSON.stringify(edge)}`);
  }
  const buckets = graphBuckets(graph);
  exactSet(buckets.atRisk, expected.atRisk, 'graph at-risk nodes');
  exactSet(buckets.holds, expected.holds, 'graph holding nodes');
  exactSet(buckets.disposable, expected.disposable, 'graph disposable nodes');
  assert(graph.edges.some((edge) => edge.type === 'collision' && edge.kind === 'proven'
    && pairMatches(edge, expected.provenCollision)), 'graph lacks the independent proven collision edge');
  assert(graph.edges.some((edge) => edge.type === 'duplicate'
    && pairMatches(edge, expected.duplicatePair)), 'graph lacks the planted duplicate edge');
  for (const id of expected.redundantPair) {
    const node = graph.nodes.find((candidate) => candidate.id === id);
    const other = expected.redundantPair.find((candidate) => candidate !== id);
    assert(node?.redundantWith?.includes(other), `${id} does not name redundant sibling ${other}`);
  }

  const terminalText = stripAnsi(terminal.run.stdoutRaw);
  const exactHeader = `holt graph  ${graph.nodes.length} workstreams · ${graph.edges.length} relationships`;
  assert(terminalText.includes(exactHeader), `graph terminal header differs from JSON: ${exactHeader}`);

  const htmlPath = path.join(context.out, 'installed-graph.html');
  assert(!await exists(htmlPath), `refusing graph HTML overwrite: ${htmlPath}`);
  const htmlRun = await invokeInstalled(context, 'graph-html-command', [
    'graph', '--cwd', context.fixture.repo, '--html', htmlPath,
  ]);
  assertExit(htmlRun.run, 0, 'installed graph HTML');
  const htmlBytes = await fs.readFile(htmlPath);
  const html = htmlBytes.toString('utf8');
  const { literal, data } = parseDataLiteral(html);
  assert(JSON.stringify(data.nodes) === JSON.stringify(graph.nodes),
    'graph HTML DATA nodes differ byte-semantically from graph --json');
  assert(JSON.stringify(data.edges) === JSON.stringify(graph.edges),
    'graph HTML DATA edges differ byte-semantically from graph --json');
  assert(!/[<>&]/.test(literal), 'graph HTML DATA literal contains a raw markup/entity delimiter');
  assert((html.slice(html.indexOf('<script>')).match(/<\/script/gi) ?? []).length === 1,
    'graph HTML inline script is closed more or less than once');
  assert(data.nodes.some((node) => node.id === expected.hostile.id),
    'hostile graph node was lost instead of escaped');
  assert(data.nodes.some((node) => node.branch === expected.hostile.branch),
    'hostile graph branch was lost instead of escaped');
  const hidden = [...html.matchAll(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu)]
    .map((match) => match[0]).filter((character) => !['\t', '\n', '\r'].includes(character));
  assert(hidden.length === 0, `graph HTML contains hidden control characters: ${hidden.length}`);

  const htmlIdentity = await captureFile(htmlPath);
  const browser = await proveGraphBrowser({
    htmlPath,
    graph,
    oracle: context.fixture.oracle.value,
    out: context.out,
  });
  return {
    valid: true,
    exactOracle: {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      buckets,
      collisionPair: expected.provenCollision,
      duplicatePair: expected.duplicatePair,
      redundantPair: expected.redundantPair,
    },
    parity: {
      terminalHeader: exactHeader,
      jsonNodes: graph.nodes.length,
      jsonEdges: graph.edges.length,
      htmlNodes: data.nodes.length,
      htmlEdges: data.edges.length,
      exactJsonHtml: true,
    },
    hostileEscaping: {
      exactIdRoundTrip: true,
      exactBranchRoundTrip: true,
      dataLiteralMarkupDelimiters: 0,
      hiddenControlCharacters: 0,
      scriptCloseCount: 1,
    },
    commands: { terminal: terminal.evidence, json: json.evidence, html: htmlRun.evidence },
    html: htmlIdentity,
    browser,
  };
}

async function assertFreshPaths(options) {
  for (const [label, target] of [['output', options.out], ['fixture', options.fixture]]) {
    assert(!await exists(target), `refusing to overwrite or reuse ${label} path: ${target}`);
  }
  assert(options.out !== options.fixture, '--out and --fixture must be distinct');
  assert(!inside(options.out, options.fixture) && !inside(options.fixture, options.out),
    '--out and --fixture may not contain one another');
  assert(!inside(options.runtime, options.out) && !inside(options.runtime, options.fixture),
    'proof output/fixture may not mutate the frozen runtime');
}

export async function runInstalledProof(options) {
  await assertFreshPaths(options);
  await assertExecutable(options.holtBin);
  const freeze = await verifyFreezeEvidence({
    runtime: options.runtime,
    holtBin: options.holtBin,
    freezeEvidence: options.freezeEvidence,
    allowSynthetic: options.allowSyntheticRuntime,
  });

  await fs.mkdir(path.dirname(options.out), { recursive: true });
  await fs.mkdir(options.out, { recursive: false, mode: 0o700 });
  await writeRaw(path.join(options.out, '.write-once-proof'),
    `holt installed TUI/graph proof\nfreeze ${freeze.semanticIdentity}\n`);
  const fixture = await buildAuditFixture(options.fixture);
  const env = isolatedEnv(fixture.home, options.runtime, options.holtBin);
  const context = { ...options, fixture, env };

  const tui = await proveTui(context);
  const graph = await proveGraph(context);
  const runtimeAfter = await installationTreeIdentity(await fs.realpath(options.runtime));
  assert(runtimeAfter.sha256 === freeze.runtime.sha256,
    'frozen runtime changed while proving installed TUI/graph behavior');

  const checksumManifest = await writeChecksumManifest(options.out);
  const refusalReasons = freeze.synthetic
    ? ['synthetic frozen executable validates the harness only; run against a real packed frozen runtime']
    : [];
  const rawEvidence = {
    kind: 'holt-installed-tui-graph-proof',
    valid: true,
    generatedAt: new Date().toISOString(),
    protocol: {
      installedExecutableOnly: true,
      explicitBindings: ['HOLT_BIN', 'HOLT_RUNTIME', 'FREEZE_EVIDENCE'],
      frozenDependencyClosure: true,
      noInternalCommandWatchdog: true,
      writeOnce: true,
      historicalScreenshotsUsed: false,
      browserContexts: 'isolated per viewport',
      reducedMotion: true,
      screenshotBaselinesUpdated: false,
    },
    publication: { eligible: refusalReasons.length === 0, refusalReasons },
    bindings: {
      holtBin: options.holtBin,
      runtime: options.runtime,
      freezeEvidence: options.freezeEvidence,
      out: options.out,
      fixture: options.fixture,
    },
    freeze,
    fixture: {
      root: fixture.fixture,
      repo: fixture.repo,
      emptyRepo: fixture.emptyRepo,
      errorRoot: fixture.errorRoot,
      oracle: {
        path: fixture.oracle.path,
        identity: fixture.oracle.identity,
        file: fixture.oracle.file,
        sidecar: fixture.oracle.sidecar,
      },
    },
    tui,
    graph,
    runtime: { before: freeze.runtime, after: runtimeAfter, unchanged: true },
    artifacts: checksumManifest,
  };
  const evidencePath = path.join(options.out, 'evidence.json');
  const written = await writeEvidenceArtifact(evidencePath, rawEvidence, [{
    name: 'installed-tui-graph',
    valid: true,
    publicationEligible: refusalReasons.length === 0,
    nodes: graph.parity.jsonNodes,
    edges: graph.parity.jsonEdges,
    screenshots: graph.browser.contexts.flatMap((entry) => entry.screenshots).length,
  }]);
  return {
    ok: true,
    publicationEligible: refusalReasons.length === 0,
    refusalReasons,
    evidence: { path: evidencePath, identity: written.identity, sha256: written.fileSha256 },
    output: options.out,
    fixture: options.fixture,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runInstalledProof(parseArgs());
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
