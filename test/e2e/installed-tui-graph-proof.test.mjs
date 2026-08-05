// SPDX-License-Identifier: FSL-1.1-MIT

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  captureFile,
  evidenceIdentity,
  installationTreeIdentity,
  runProcess,
  sha256,
} from '../../docs/evidence/tui-graph/installed-proof-support.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNNER = path.join(ROOT, 'docs', 'evidence', 'tui-graph', 'build-audit-fixture.mjs');
const FAKE = path.join(ROOT, 'test', 'support', 'fake-installed-tui-graph-holt.mjs');

async function writeFreeze(file, raw) {
  const artifact = {
    ...raw,
    artifact: {
      schema: 'holt-eval-evidence-v2',
      identity: evidenceIdentity(raw),
      identityScope: 'raw evidence excluding derived summary',
    },
    summary: [],
  };
  const encoded = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
  await fs.writeFile(file, encoded, { flag: 'wx', mode: 0o600 });
  await fs.writeFile(`${file}.sha256`, `${sha256(encoded)}  ${path.basename(file)}\n`, {
    flag: 'wx', mode: 0o600,
  });
}

async function syntheticRuntime(base) {
  const runtime = path.join(base, 'runtime');
  const packageRoot = path.join(runtime, 'node_modules', 'holt');
  const bin = path.join(packageRoot, 'bin', 'holt.mjs');
  await fs.mkdir(path.dirname(bin), { recursive: true });
  await fs.copyFile(FAKE, bin, fs.constants.COPYFILE_EXCL);
  await fs.chmod(bin, 0o755);
  await fs.writeFile(path.join(packageRoot, 'package.json'), `${JSON.stringify({
    name: 'holt',
    version: '0.0.0-synthetic-proof-harness',
    type: 'module',
    bin: { holt: 'bin/holt.mjs' },
  }, null, 2)}\n`, { flag: 'wx' });
  await fs.writeFile(path.join(runtime, 'package.json'), `${JSON.stringify({
    private: true,
    name: 'holt-tui-graph-synthetic-runtime',
  }, null, 2)}\n`, { flag: 'wx' });

  const [installTree, packageTree, executable] = await Promise.all([
    installationTreeIdentity(runtime),
    installationTreeIdentity(packageRoot),
    captureFile(bin),
  ]);
  const freeze = path.join(base, 'freeze.json');
  await writeFreeze(freeze, {
    kind: 'holt-frozen-installed-runtime',
    valid: true,
    synthetic: true,
    preflight: { valid: true, shutdown: { clean: true } },
    runtime: {
      root: runtime,
      packageRoot,
      package: { name: 'holt', version: '0.0.0-synthetic-proof-harness' },
      before: { installTree, packageTree, executable },
      afterTree: installTree,
      immutableAcrossPreflight: true,
    },
  });
  return { runtime, packageRoot, bin, freeze };
}

async function runHarness({ frozen, out, fixture, allowSynthetic = true }) {
  const args = [RUNNER, '--out', out, '--fixture', fixture];
  if (allowSynthetic) args.push('--allow-synthetic-runtime');
  return runProcess(process.execPath, args, {
    cwd: ROOT,
    env: {
      ...process.env,
      HOLT_BIN: frozen.bin,
      HOLT_RUNTIME: frozen.runtime,
      FREEZE_EVIDENCE: frozen.freeze,
      PLAYWRIGHT_CHROMIUM_EXECUTABLE: '/usr/bin/chromium',
    },
  });
}

async function browserProofCapability() {
  let playwright;
  try {
    playwright = await import('playwright');
  } catch (error) {
    return `Playwright package unavailable: ${error?.message ?? error}`;
  }
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    '/usr/bin/chromium',
    playwright.chromium?.executablePath?.(),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(await fs.realpath(candidate));
      if (stat.isFile()) return null;
    } catch { /* the next platform-local candidate may exist */ }
  }
  return `no local Chromium executable found: ${candidates.join(', ')}`;
}

test('installed TUI/graph proof harness validates exact terminal/browser behavior but refuses synthetic publication',
  async (t) => {
    const browserGap = await browserProofCapability();
    if (browserGap) {
      t.skip(`browser proof capability unavailable: ${browserGap}`);
      return;
    }
    const retainedRoot = process.env.HOLT_TUI_GRAPH_TEST_RETAIN;
    const base = retainedRoot
      ? path.resolve(retainedRoot)
      : await fs.mkdtemp(path.join(os.tmpdir(), 'holt-installed-tui-graph-proof-'));
    if (retainedRoot) {
      await assert.rejects(fs.access(base), /ENOENT/);
      await fs.mkdir(base, { recursive: false, mode: 0o700 });
    } else {
      t.after(() => fs.rm(base, { recursive: true, force: true }));
    }
    const frozen = await syntheticRuntime(base);
    const out = path.join(base, 'proof');
    const fixture = path.join(base, 'fixture');

    const run = await runHarness({ frozen, out, fixture });
    assert.equal(run.spawnError, null);
    assert.equal(run.signal, null);
    assert.equal(run.exitCode, 0, run.stderr);
    const result = JSON.parse(run.stdout);
    assert.equal(result.ok, true);
    assert.equal(result.publicationEligible, false);
    assert.match(result.refusalReasons.join('\n'), /synthetic frozen executable/);

    const evidenceBytes = await fs.readFile(path.join(out, 'evidence.json'));
    const evidence = JSON.parse(evidenceBytes);
    assert.equal(evidence.valid, true);
    assert.equal(evidence.publication.eligible, false);
    assert.equal(evidence.protocol.installedExecutableOnly, true);
    assert.equal(evidence.protocol.noInternalCommandWatchdog, true);
    assert.equal(evidence.protocol.historicalScreenshotsUsed, false);
    assert.equal(evidence.protocol.screenshotBaselinesUpdated, false);
    assert.deepEqual(evidence.protocol.explicitBindings, ['HOLT_BIN', 'HOLT_RUNTIME', 'FREEZE_EVIDENCE']);
    assert.equal(evidence.freeze.executable.path, frozen.bin);
    assert.equal(evidence.runtime.unchanged, true);

    assert.equal(evidence.tui.valid, true);
    assert.equal(evidence.tui.snapshots['120x36'].rows, 36);
    assert.ok(evidence.tui.snapshots['120x36'].maxWidth <= 120);
    assert.equal(evidence.tui.snapshots['80x20'].rows, 20);
    assert.ok(evidence.tui.snapshots['80x20'].maxWidth <= 80);
    assert.deepEqual(evidence.tui.interactive.keys,
      ['f', 'j', 'f', 'f', 'f', 'x', 'resize:80x20', 'j', 'x', 'q']);
    assert.notEqual(evidence.tui.interactive.selection.before, evidence.tui.interactive.selection.after);
    assert.equal(evidence.tui.interactive.frames['filter-disposable-resized-move-j-80x20'].rows, 20);

    assert.equal(evidence.graph.valid, true);
    assert.equal(evidence.graph.parity.jsonNodes, 11);
    assert.equal(evidence.graph.parity.htmlNodes, 11);
    assert.equal(evidence.graph.parity.jsonEdges, evidence.graph.parity.htmlEdges);
    assert.equal(evidence.graph.parity.exactJsonHtml, true);
    assert.equal(evidence.graph.hostileEscaping.dataLiteralMarkupDelimiters, 0);
    assert.equal(evidence.graph.hostileEscaping.scriptCloseCount, 1);
    assert.equal(evidence.graph.browser.contexts.length, 2);
    for (const context of evidence.graph.browser.contexts) {
      assert.equal(context.isolatedContext, true);
      assert.equal(context.reducedMotion, true);
      assert.deepEqual(context.consoleErrors, []);
      assert.deepEqual(context.pageErrors, []);
      assert.deepEqual(context.requestFailures, []);
      assert.deepEqual(context.networkRequests, []);
      assert.ok(context.screenshots.length >= 2);
    }
    const mobile = evidence.graph.browser.contexts.find((context) => context.viewport.mobile);
    assert.ok(mobile.layout.stage.width >= 390 * 0.95);
    assert.ok(mobile.layout.aside.y >= mobile.layout.stage.bottom - 1);

    const checksumRows = evidence.artifacts.rows;
    assert.ok(checksumRows.some((row) => row.path === 'graph-desktop-1440x900-default.png'));
    assert.ok(checksumRows.some((row) => row.path === 'graph-mobile-390x844-default.png'));
    assert.ok(checksumRows.some((row) => row.path === 'raw/tui-snapshot-120x36.stdout.bin'));
    assert.ok(checksumRows.some((row) => row.path === 'installed-graph.html'));
    const evidenceSidecar = await fs.readFile(path.join(out, 'evidence.json.sha256'), 'utf8');
    assert.equal(evidenceSidecar, `${sha256(evidenceBytes)}  evidence.json\n`);
    assert.ok((await fs.stat(path.join(out, 'ARTIFACT-SHA256SUMS'))).size > 100);

    const overwrite = await runHarness({
      frozen,
      out,
      fixture: path.join(base, 'fixture-overwrite-probe'),
    });
    assert.notEqual(overwrite.exitCode, 0);
    assert.match(overwrite.stderr, /refusing to overwrite or reuse output path/);
    await assert.rejects(fs.access(path.join(base, 'fixture-overwrite-probe')));

    const syntheticRefusal = await runHarness({
      frozen,
      out: path.join(base, 'proof-no-synthetic-authority'),
      fixture: path.join(base, 'fixture-no-synthetic-authority'),
      allowSynthetic: false,
    });
    assert.notEqual(syntheticRefusal.exitCode, 0);
    assert.match(syntheticRefusal.stderr, /synthetic frozen runtime refused/);
    await assert.rejects(fs.access(path.join(base, 'proof-no-synthetic-authority')));

    if (!retainedRoot) {
      await fs.appendFile(frozen.bin, '\n// deliberate post-freeze mutation\n');
      const mutation = await runHarness({
        frozen,
        out: path.join(base, 'proof-mutated-runtime'),
        fixture: path.join(base, 'fixture-mutated-runtime'),
      });
      assert.notEqual(mutation.exitCode, 0);
      assert.match(mutation.stderr, /runtime tree does not match FREEZE_EVIDENCE|executable sha256 does not match/);
      await assert.rejects(fs.access(path.join(base, 'proof-mutated-runtime')));
    } else {
      t.diagnostic(`retained non-publishable harness evidence at ${out}`);
    }
  });
