// SPDX-License-Identifier: FSL-1.1-MIT

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  CLI_COMMANDS,
  MCP_TOOLS,
  assertFreshScratch,
  buildFixture,
  fixtureManifest,
  installationTreeIdentity,
  parseArgs,
  validatePublicationArtifact,
  verifyFreezeEvidence,
  writeEvidence,
} from '../../eval/installed-surface-proof.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function temp(t, label) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `holt-installed-proof-${label}-`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('installed proof: exact public denominators remain 42 CLI commands and 16 MCP tools', () => {
  assert.equal(CLI_COMMANDS.length, 42);
  assert.equal(new Set(CLI_COMMANDS).size, 42);
  assert.equal(MCP_TOOLS.length, 16);
  assert.equal(new Set(MCP_TOOLS).size, 16);
  assert.ok(CLI_COMMANDS.includes('mcp'));
  assert.deepEqual(MCP_TOOLS.filter((name) => /^holt_/.test(name)), MCP_TOOLS);
});

test('installed proof: parser has no skip/only mode and requires the freeze evidence chain', () => {
  assert.throws(() => parseArgs(['--runtime', '/r', '--holt-bin', '/b', '--out', '/o']),
    /--freeze-evidence is required/);
  assert.throws(() => parseArgs([
    '--runtime', '/r', '--holt-bin', '/b', '--freeze-evidence', '/f', '--out', '/o', '--skip', 'mcp',
  ]), /unknown option --skip/);
  const parsed = parseArgs([
    '--runtime', '/r', '--holt-bin', '/b', '--freeze-evidence', '/f', '--out', '/o',
  ]);
  assert.equal(parsed.runtime, path.resolve('/r'));
  assert.equal(parsed.holtBin, path.resolve('/b'));
  assert.equal(parsed.freezeEvidence, path.resolve('/f'));
  assert.equal(parsed.out, path.resolve('/o'));
  assert.equal(parsed.work, `${path.resolve('/o')}.work`);
});

test('installed proof: scratch is write-once and an unmarked existing path is never reused or removed', async (t) => {
  const root = await temp(t, 'scratch');
  const fresh = path.join(root, 'fresh');
  const owned = await assertFreshScratch(fresh);
  assert.equal(owned.retained, true);
  await assert.rejects(() => assertFreshScratch(fresh), /belongs to an earlier write-once run/);
  const foreign = path.join(root, 'foreign');
  await fs.mkdir(foreign);
  await fs.writeFile(path.join(foreign, 'valuable.txt'), 'must survive\n');
  await assert.rejects(() => assertFreshScratch(foreign), /without this runner marker/);
  assert.equal(await fs.readFile(path.join(foreign, 'valuable.txt'), 'utf8'), 'must survive\n');
});

test('installed proof: fixture identity includes sibling bytes, refs, index and status—not just primary', async (t) => {
  const root = await temp(t, 'fixture');
  const runtime = path.join(root, 'runtime');
  const holtBin = path.join(runtime, 'node_modules', 'holt', 'bin', 'holt.mjs');
  await fs.mkdir(path.dirname(holtBin), { recursive: true });
  await fs.writeFile(holtBin, '#!/usr/bin/env node\n');
  const fixture = await buildFixture(path.join(root, 'fixture'), runtime, holtBin);
  const before = await fixtureManifest(fixture);
  assert.equal(before.registeredCount, 3, 'primary + unique-work + empty-work');
  assert.equal(before.worktrees.length, before.registeredCount);
  assert.ok(before.refs.bytes > 0);
  for (const worktree of before.worktrees) {
    assert.ok(worktree.files.identity);
    assert.ok(worktree.indexFile?.sha256);
    assert.ok(worktree.indexListing.sha256);
    assert.ok(worktree.status.sha256);
  }
  // Git resolves macOS /var aliases to /private/var and may use a different display spelling on
  // Windows. The manifest intentionally records the canonical filesystem path; resolve the
  // fixture inputs before selecting rows so this proof tests identity rather than path syntax.
  const [repoReal, siblingReal] = await Promise.all([
    fs.realpath(fixture.repo), fs.realpath(fixture.worktrees['unique-work']),
  ]);
  const primaryBefore = before.worktrees.find((row) => row.path === repoReal);
  const siblingBefore = before.worktrees.find((row) => row.path === siblingReal);
  await fs.writeFile(path.join(fixture.worktrees['unique-work'], 'src', 'sole-copy.js'),
    'export function SOLE_COPY_PROOF() { return "mutated sibling only"; }\n');
  const after = await fixtureManifest(fixture);
  const primaryAfter = after.worktrees.find((row) => row.path === repoReal);
  const siblingAfter = after.worktrees.find((row) => row.path === siblingReal);
  assert.equal(primaryAfter.files.identity, primaryBefore.files.identity,
    'positive control: primary working bytes did not change');
  assert.notEqual(siblingAfter.files.identity, siblingBefore.files.identity,
    'sibling byte mutation changes its manifest');
  assert.ok(Buffer.from(siblingAfter.status.base64, 'base64').includes(Buffer.from('src/sole-copy.js')),
    'the per-worktree status denominator names the sibling-only untracked path (status need not change when only its bytes change)');
  assert.notEqual(after.identity, before.identity,
    'top-level fixture identity cannot hide a sibling-only mutation');
});

async function syntheticFreeze(t) {
  const root = await temp(t, 'freeze');
  const runtime = path.join(root, 'runtime');
  const packageRoot = path.join(runtime, 'node_modules', 'holt');
  const holtBin = path.join(packageRoot, 'bin', 'holt.mjs');
  await fs.mkdir(path.dirname(holtBin), { recursive: true });
  await fs.writeFile(holtBin, '#!/usr/bin/env node\nprocess.stdout.write("holt 9.9.9\\n");\n', { mode: 0o755 });
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: 'holt', version: '9.9.9', type: 'module', bin: { holt: 'bin/holt.mjs' },
  }));
  await fs.writeFile(path.join(runtime, 'package-lock.json'), '{}\n');
  const tarball = path.join(root, 'holt-9.9.9.tgz');
  await fs.writeFile(tarball, 'exact tarball bytes\n');
  const [installTree, packageTree] = await Promise.all([
    installationTreeIdentity(runtime), installationTreeIdentity(packageRoot),
  ]);
  const executable = await fs.readFile(holtBin);
  const tarballBytes = await fs.readFile(tarball);
  const raw = {
    kind: 'holt-frozen-installed-runtime',
    generatedAt: '2026-08-05T00:00:00.000Z',
    valid: true,
    tarball: { path: tarball, bytes: tarballBytes.length, sha256: sha256(tarballBytes) },
    runtime: {
      root: runtime,
      packageRoot,
      package: { name: 'holt', version: '9.9.9' },
      before: {
        installTree,
        packageTree,
        executable: { path: holtBin, bytes: executable.length, sha256: sha256(executable) },
      },
      afterTree: installTree,
      immutableAcrossPreflight: true,
    },
    preflight: { valid: true, shutdown: { clean: true } },
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  };
  const semantic = `sha256:${sha256(JSON.stringify(raw))}`;
  const artifact = {
    ...raw,
    artifact: { schema: 'holt-eval-evidence-v2', identity: semantic, identityScope: 'raw evidence excluding derived summary' },
    summary: [],
  };
  const freezeEvidence = path.join(root, 'freeze.json');
  const encoded = `${JSON.stringify(artifact, null, 2)}\n`;
  await fs.writeFile(freezeEvidence, encoded);
  await fs.writeFile(`${freezeEvidence}.sha256`, `${sha256(encoded)}  ${path.basename(freezeEvidence)}\n`);
  return { root, runtime, packageRoot, holtBin, tarball, freezeEvidence };
}

test('installed proof: freeze evidence cryptographically binds JSON, sidecar, runtime, package, executable and tarball', async (t) => {
  const fx = await syntheticFreeze(t);
  const verified = await verifyFreezeEvidence(fx);
  assert.equal(verified.valid, true);
  assert.equal(verified.packageJson.version, '9.9.9');
  assert.equal(verified.runtime.sha256, (await installationTreeIdentity(fx.runtime)).sha256);

  await fs.writeFile(fx.tarball, 'different tarball bytes\n');
  await assert.rejects(() => verifyFreezeEvidence(fx), /tarball bytes do not match/);
});

function syntheticValidArtifact() {
  const mcp = MCP_TOOLS.map((tool) => ({
    surface: `mcp:${tool}`, tool, skipped: false, valid: true, failures: [],
    calls: [{}], transport: { clean: true }, plantedManifest: {}, afterSubjectManifest: {},
  }));
  const cli = CLI_COMMANDS.map((command) => command === 'mcp'
    ? {
        surface: 'cli:mcp', command, skipped: false, valid: true, failures: [], invocations: [{}],
        protocolToolCalls: 16, cleanShutdowns: 16,
      }
    : {
        surface: `cli:${command}`, command, skipped: false, valid: true, failures: [], invocations: [{}],
        plantedManifest: {}, afterSubjectManifest: {},
      });
  return {
    kind: 'holt-installed-surface-proof-v1',
    protocol: { noInternalTimeouts: true },
    freeze: { valid: true },
    runtime: { immutable: true },
    package: { immutable: true },
    scratch: { markerVerified: true },
    cli: { probes: cli },
    mcp: { probes: mcp },
  };
}

test('installed proof: publication validator rejects omissions, skips, weak help-only rows and runtime drift', () => {
  assert.deepEqual(validatePublicationArtifact(syntheticValidArtifact()), { valid: true, failures: [] });

  const omitted = syntheticValidArtifact();
  omitted.mcp.probes.pop();
  assert.equal(validatePublicationArtifact(omitted).valid, false);

  const skipped = syntheticValidArtifact();
  skipped.cli.probes[0].skipped = true;
  assert.equal(validatePublicationArtifact(skipped).valid, false);

  const helpOnly = syntheticValidArtifact();
  helpOnly.cli.probes.find((row) => row.command === 'status').invocations = [];
  assert.ok(validatePublicationArtifact(helpOnly).failures.some((row) => /no behavioral invocation/.test(row)));

  const drift = syntheticValidArtifact();
  drift.runtime.immutable = false;
  assert.ok(validatePublicationArtifact(drift).failures.some((row) => /runtime changed/.test(row)));
});

test('installed proof: evidence and exact SHA sidecar are write-once', async (t) => {
  const root = await temp(t, 'write');
  const out = path.join(root, 'proof.json');
  const written = await writeEvidence(out, { kind: 'synthetic', valid: false });
  const bytes = await fs.readFile(out);
  const sidecar = await fs.readFile(`${out}.sha256`, 'utf8');
  assert.equal(sidecar, `${sha256(bytes)}  proof.json\n`);
  assert.equal(written.fileSha256, sha256(bytes));
  await assert.rejects(() => writeEvidence(out, { kind: 'second' }), /refusing to overwrite/);
});
