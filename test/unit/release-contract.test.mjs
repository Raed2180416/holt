// SPDX-License-Identifier: FSL-1.1-MIT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  releaseContractProblems,
  ROOT,
} from '../../scripts/check-release-contract.mjs';
import {
  broadWritePermissions,
  mutableExecutableInstalls,
  mutableGitHubInstalls,
} from '../../scripts/check-ci-hardening.mjs';

const execFileAsync = promisify(execFile);

async function actual() {
  const read = (rel) => fs.readFile(path.join(ROOT, rel), 'utf8');
  const [action, actionBuildScript, actionBundle, actionNotices, workflow, packageJson, lock, shrinkwrap, runtimeScript, supplyChain] = await Promise.all([
    read('action.yml'),
    read('scripts/build-action-bundle.mjs'),
    read('dist/holt-action.mjs'),
    read('dist/THIRD-PARTY-NOTICES.txt'),
    read('.github/workflows/release-artifact.yml'),
    read('package.json'),
    read('package-lock.json'),
    read('npm-shrinkwrap.json'),
    read('scripts/check-git-runtime.mjs'),
    read('src/supply-chain.mjs'),
  ]);
  const alternateReleaseWorkflows = {};
  for (const name of await fs.readdir(path.join(ROOT, '.github', 'workflows'))) {
    if (!/^release-.*\.ya?ml$/.test(name) || name === 'release-artifact.yml') continue;
    alternateReleaseWorkflows[name] = await read(`.github/workflows/${name}`);
  }
  return { action, actionBuildScript, actionBundle, actionNotices, workflow, packageJson, lock, shrinkwrap, runtimeScript, supplyChain, alternateReleaseWorkflows };
}

const rules = (input) => releaseContractProblems(input).map((x) => x.rule);
const expectRule = (input, rule, label) => {
  const problems = releaseContractProblems(input);
  assert.ok(problems.some((x) => x.rule === rule),
    `${label}: expected [${rule}], got ${JSON.stringify(problems)}`);
};

test('release contract: the real action, workflow, package and locks are green', async () => {
  assert.deepEqual(releaseContractProblems(await actual()), []);
});

test('release contract: a second publishing or signing workflow is rejected', async () => {
  for (const body of [
    'steps:\n  - run: gh release create "$TAG"\n',
    'steps:\n  - uses: actions/attest@' + 'a'.repeat(40) + '\n',
    'env:\n  HOLT_RELEASE_SIGNING_KEY: ${{ secrets.HOLT_RELEASE_SIGNING_KEY }}\n',
  ]) {
    const x = await actual();
    x.alternateReleaseWorkflows['release-emergency.yml'] = body;
    expectRule(x, 'release-path', body);
  }
});

test('package-manager manifests point at a real release digest and parse SHA256SUMS order', async () => {
  const [formula, scoopRaw] = await Promise.all([
    fs.readFile(path.join(ROOT, 'Formula/holt.rb'), 'utf8'),
    fs.readFile(path.join(ROOT, 'bucket/holt.json'), 'utf8'),
  ]);
  const scoop = JSON.parse(scoopRaw);
  const zero = '0'.repeat(64);
  assert.doesNotMatch(formula, new RegExp(zero), 'Homebrew must never advertise a placeholder digest');
  assert.notEqual(scoop.hash, zero, 'Scoop must never advertise a placeholder digest');
  assert.match(formula, new RegExp(`/releases/download/v${scoop.version.replaceAll('.', '\\.')}/holt\\.tgz`));
  assert.ok(scoop.url.includes(`/releases/download/v${scoop.version}/holt.tgz`));

  // release-artifact.yml writes standard `sha256sum` output: digest first, then filename.
  // The previous regex expected the reverse and made every future Scoop autoupdate fail even
  // though the initial hard-coded hash happened to work.
  const digest = 'a'.repeat(64);
  const match = new RegExp(scoop.autoupdate.hash.regex).exec(`${digest}  holt.tgz\n`);
  assert.equal(match?.[1], digest, 'Scoop autoupdate must capture the leading SHA-256 digest');
});

test('mixed package licence metadata cannot mislabel commercial Team files as FSL', async () => {
  const [packageRaw, notice, formula, scoopRaw, teamSource] = await Promise.all([
    fs.readFile(path.join(ROOT, 'package.json'), 'utf8'),
    fs.readFile(path.join(ROOT, 'LICENSE-NOTICE.md'), 'utf8'),
    fs.readFile(path.join(ROOT, 'Formula/holt.rb'), 'utf8'),
    fs.readFile(path.join(ROOT, 'bucket/holt.json'), 'utf8'),
    fs.readFile(path.join(ROOT, 'src/team/fleet.mjs'), 'utf8'),
  ]);
  const pkg = JSON.parse(packageRaw);
  const scoop = JSON.parse(scoopRaw);
  assert.equal(pkg.license, 'SEE LICENSE IN LICENSE-NOTICE.md');
  assert.ok(pkg.files.includes('LICENSE-NOTICE.md'), 'the notice must ship in the npm tarball');
  assert.match(notice, /FSL-1\.1-MIT/);
  assert.match(notice, /LicenseRef-holt-Commercial/);
  assert.match(teamSource.split('\n')[0], /LicenseRef-holt-Commercial/);
  assert.match(formula, /license :cannot_represent/);
  assert.match(scoop.license.identifier, /Proprietary,FSL-1\.1-MIT/);
  assert.match(scoop.license.url, /LICENSE-NOTICE\.md$/);
});

test('composite hardening: executable mutable tags/branches are rejected, prose and SHAs are not', () => {
  const sha = 'a'.repeat(40);
  const fixture = (line) => `runs:\n  using: composite\n  steps:\n    - shell: bash\n      run: |\n        ${line}\n`;
  for (const spec of [
    'github:owner/tool#main',
    'github:owner/tool#v1.2.3',
    'git+https://github.com/owner/tool.git#release',
    'github:owner/tool',
  ]) {
    assert.equal(mutableGitHubInstalls(fixture(`npm install -g "${spec}"`)).length, 1,
      `${spec} was accepted as immutable executable code`);
  }
  assert.deepEqual(mutableGitHubInstalls(fixture(`npm install -g github:owner/tool#${sha}`)), []);
  assert.deepEqual(mutableGitHubInstalls(fixture('# npm install -g github:owner/tool#main')), []);
});

test('CI hardening: write-all and mutable executable installs are rejected without flagging local artifacts', () => {
  assert.equal(broadWritePermissions('permissions: write-all\njobs:\n  x:\n    runs-on: ubuntu-latest\n').length, 1);
  assert.equal(broadWritePermissions('permissions:\n  contents: read\njobs:\n  x:\n    permissions: write-all\n').length, 1);
  assert.equal(broadWritePermissions('permissions:\n  contents: read\n# permissions: write-all\n').length, 0);

  const fixture = (command) => `jobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ${command}\n`;
  for (const command of [
    'go install github.com/go-enry/go-enry/v2/cmd/enry@latest',
    'cargo install --locked jj-cli',
    'npm install -g opencode-ai',
  ]) {
    assert.equal(mutableExecutableInstalls(fixture(command)).length, 1, command);
  }
  for (const command of [
    `go install github.com/go-enry/go-enry/v2/cmd/enry@${'a'.repeat(40)}`,
    'cargo install --locked jj-cli --version 0.43.0',
    'npm install -g opencode-ai@1.18.13',
    'npm install -g "./holt-0.3.1.tgz"',
  ]) {
    assert.deepEqual(mutableExecutableInstalls(fixture(command)), [], command);
  }
});

test('prior false-green: action executes one committed bundle and cannot install another revision at runtime', async () => {
  const x = await actual();
  x.action = `${x.action}\nsteps:\n  - run: npm install -g github:Raed2180416/holt#v0.3.1\n`;
  assert.ok(rules(x).includes('action-mutable-install'));

  const wrongMain = await actual();
  wrongMain.action = wrongMain.action.replace('dist/holt-action.mjs', 'bin/holt.mjs');
  assert.ok(rules(wrongMain).includes('action-local'));
});

test('prior false-green: every release quality command is executable, not optional evidence', async () => {
  const commands = [
    'npm audit --omit=dev --audit-level=moderate',
    'npm run action:check',
    'bash scripts/clone-fixtures.sh "$HOLT_REAL_REPOS"',
    'node scripts/run-feature-proof.mjs --out "$RUNNER_TEMP/feature-proof.json"',
    'npm test',
    'npm run test:mutation',
    'npm run typecheck',
    'npm run hosts:check',
    'npm run lint:paths',
    'node scripts/check-ci-hardening.mjs --self-test',
    'node scripts/gen-manifest.mjs --check',
    'node bin/holt.mjs audit',
    'git diff --exit-code',
    'git status --porcelain',
  ];
  for (const command of commands) {
    const x = await actual();
    x.workflow = x.workflow.replace(command, `echo removed-${commands.indexOf(command)}`);
    expectRule(x, 'quality', `removing ${command}`);
  }
});

test('release evidence: feature proof is mandatory and retained even when the completed proof is invalid', async () => {
  const removed = await actual();
  removed.workflow = removed.workflow.replace(
    'node scripts/run-feature-proof.mjs --out "$RUNNER_TEMP/feature-proof.json"',
    'echo feature-proof-removed',
  );
  expectRule(removed, 'feature-proof', 'removing feature-proof execution');

  const successOnly = await actual();
  successOnly.workflow = successOnly.workflow.replace('        if: ${{ always() }}', '        if: ${{ success() }}');
  expectRule(successOnly, 'feature-proof', 'discarding red feature-proof artifacts');

  const noChecksum = await actual();
  noChecksum.workflow = noChecksum.workflow.replace('${{ runner.temp }}/feature-proof.json.sha256', '${{ runner.temp }}/missing.sha256');
  expectRule(noChecksum, 'feature-proof', 'dropping feature-proof checksum sidecar');
});

test('release omit-optional proof rejects the prior global false-green and wrong ordering', async () => {
  const global = await actual();
  global.workflow = global.workflow.replace(
    'npm install --ignore-scripts --omit=optional --prefix "$OPTIONAL_PREFIX" "$GITHUB_WORKSPACE/$TARBALL"',
    'npm install -g --omit=optional "$GITHUB_WORKSPACE/$TARBALL"',
  );
  expectRule(global, 'omit-optional', 'restoring global omit-optional install');

  const unchecked = await actual();
  unchecked.workflow = unchecked.workflow.replace(
    'NODE_PATH= node scripts/check-omit-optional-install.mjs --prefix "$OPTIONAL_PREFIX"',
    'echo optional roots assumed absent',
  );
  expectRule(unchecked, 'omit-optional', 'removing optional-root assertion');

  const afterSmoke = await actual();
  const proof = 'NODE_PATH= node scripts/check-omit-optional-install.mjs --prefix "$OPTIONAL_PREFIX"';
  afterSmoke.workflow = afterSmoke.workflow.replace(proof, 'echo proof-moved-after-smoke')
    .replace(
      'NODE_PATH= node scripts/smoke-installed.mjs --bin "$HOLT_BIN"',
      `NODE_PATH= node scripts/smoke-installed.mjs --bin "$HOLT_BIN"\n          ${proof}`,
    );
  expectRule(afterSmoke, 'omit-optional', 'moving absence proof after the core smoke');
});

test('release runtime: quality, build, and installed-artifact verification each prove Git before evidence', async () => {
  const marker = 'node scripts/check-git-runtime.mjs --verify-inert-hooks';
  const base = await actual();
  const starts = [];
  let at = 0;
  while ((at = base.workflow.indexOf(marker, at)) !== -1) {
    starts.push(at);
    at += marker.length;
  }
  assert.equal(starts.length, 3, `expected one runtime proof in quality/build/verify, got ${starts.length}`);
  for (const start of starts) {
    const x = { ...base, workflow: `${base.workflow.slice(0, start)}echo removed-git-runtime${base.workflow.slice(start + marker.length)}` };
    expectRule(x, 'git-runtime', `removing runtime proof at offset ${start}`);
  }

  for (const needle of [
    'noLazyFetchSupported',
    "['--no-lazy-fetch', 'version']",
    'verifyInertHooksPath',
    'positive-control hook did not run',
  ]) {
    const x = { ...base, runtimeScript: base.runtimeScript.replaceAll(needle, '__REMOVED_RUNTIME_EVIDENCE__') };
    expectRule(x, 'git-runtime', `removing runtime-checker evidence ${needle}`);
  }
});

test('prior false-green: a tag that does not resolve to checked-out HEAD is rejected twice', async () => {
  const x = await actual();
  x.workflow = x.workflow.replaceAll('TAG_SHA=$(git rev-parse "$TAG^{commit}")', 'TAG_SHA="$HEAD_SHA"');
  expectRule(x, 'tag-identity', 'removing tag-to-HEAD checks');
});

test('release trigger: manual tags, prerelease suffixes, and stale immutability variables cannot bypass live preflight', async () => {
  const manual = await actual();
  manual.workflow = manual.workflow.replace("  push:\n    tags: ['v*']", "  push:\n    tags: ['v*']\n  workflow_dispatch:");
  expectRule(manual, 'trigger', 'restoring workflow_dispatch');

  const suffix = await actual();
  suffix.workflow = suffix.workflow.replace('^refs/tags/v[0-9]+\\.[0-9]+\\.[0-9]+$', '^refs/tags/v.+$');
  expectRule(suffix, 'trigger', 'accepting prerelease or arbitrary v-prefixed tags');

  const stale = await actual();
  stale.workflow = stale.workflow.replace('repos/$GITHUB_REPOSITORY/immutable-releases', 'repos/$GITHUB_REPOSITORY/releases')
    .replace('HOLT_RELEASE_ADMIN_TOKEN', 'HOLT_IMMUTABLE_RELEASES_ENABLED');
  expectRule(stale, 'immutable-preflight', 'replacing live admin-readable API proof with a variable');

  const late = await actual();
  const endpoint = 'repos/$GITHUB_REPOSITORY/immutable-releases';
  const last = late.workflow.lastIndexOf(endpoint);
  late.workflow = `${late.workflow.slice(0, last)}repos/$GITHUB_REPOSITORY/releases${late.workflow.slice(last + endpoint.length)}`;
  expectRule(late, 'immutable-preflight', 'removing the immediate pre-publication live recheck');
});

test('prior false-green: release assets are built once and never clobbered', async () => {
  const x = await actual();
  x.workflow = x.workflow.replace('gh release create "$TAG"',
    'gh release upload "$TAG" holt.tgz --clobber\n          gh release create "$TAG"');
  expectRule(x, 'asset-once', 'restoring upload --clobber');

  const y = await actual();
  y.workflow = y.workflow.replace('NAME=$(npm pack --ignore-scripts --silent)',
    'NAME=$(npm pack --ignore-scripts --silent)\n          npm pack --ignore-scripts');
  expectRule(y, 'asset-once', 'building a second tarball');
});

test('prior false-green: imaginary CLI provenance and mutable attest actions are rejected', async () => {
  const x = await actual();
  x.workflow = x.workflow.replace(/uses: actions\/attest@[0-9a-f]{40}[^\n]*/,
    'run: gh attestation create holt.tgz');
  expectRule(x, 'attestation', 'replacing actions/attest with gh attestation create');

  const y = await actual();
  y.workflow = y.workflow.replace(/uses: actions\/attest@[0-9a-f]{40}/, 'uses: actions/attest@v4');
  expectRule(y, 'attestation', 'moving actions/attest to a tag');
});

test('attestation verification binds signer, source ref, source digest, and CycloneDX predicate independently', async () => {
  for (const needle of ['--signer-workflow', '--source-ref', '--source-digest']) {
    const x = await actual();
    x.workflow = x.workflow.replace(needle, `--removed-${needle.slice(2)}`);
    expectRule(x, 'attestation-identity', `removing ${needle}`);
  }
  const sbom = await actual();
  sbom.workflow = sbom.workflow.replace('--predicate-type https://cyclonedx.org/bom', '--predicate-type removed');
  expectRule(sbom, 'attestation-sbom', 'removing CycloneDX predicate verification');
});

test('prior false-green: signing cannot skip, sign the checksum file, or omit base64 encoding', async () => {
  for (const [from, to] of [
    ["if (!pem) throw new Error('HOLT_RELEASE_SIGNING_KEY is required');", 'if (!pem) process.exit(0);'],
    ['MANIFEST.sha256.sig', 'SHA256SUMS.sig'],
    ["signature.toString('base64')", 'signature.toString()'],
  ]) {
    const x = await actual();
    x.workflow = x.workflow.replaceAll(from, to);
    expectRule(x, 'signing', `signing mutation ${from}`);
  }
});

test('release signing key in the workflow must be trusted by the installed verifier', async () => {
  const x = await actual();
  x.workflow = x.workflow.replace(
    /EXPECTED_RELEASE_PUBLIC_KEY_B64:\s*[A-Za-z0-9+/=]+/,
    `EXPECTED_RELEASE_PUBLIC_KEY_B64: ${Buffer.alloc(44, 0).toString('base64')}`,
  );
  expectRule(x, 'signing-trust', 'workflow/public verifier key drift');
});

test('prior false-green: SBOM must be generated, shipped, and attested against the tarball', async () => {
  const x = await actual();
  x.workflow = x.workflow.replace('node scripts/gen-sbom.mjs', 'echo no-sbom');
  expectRule(x, 'sbom', 'removing SBOM generation');

  const y = await actual();
  y.workflow = y.workflow.replace('sbom-path:', 'old-sbom-input:');
  expectRule(y, 'attestation', 'removing the SBOM attestation input');
});

test('prior false-green: publication cannot precede evidence or leave a mutable draft path', async () => {
  const x = await actual();
  x.workflow = x.workflow.replace('needs: [quality, build, verify, attest]', 'needs: build');
  expectRule(x, 'graph', 'publishing after build alone');

  const y = await actual();
  y.workflow = y.workflow.replace('gh release edit "$TAG" --draft=false', 'echo leave-draft');
  expectRule(y, 'publish-last', 'removing final publication');

  const z = await actual();
  z.workflow = z.workflow.replace('.immutable', '.mutable');
  expectRule(z, 'publish-last', 'not requiring immutable releases');
});

test('publication verifies remote state and digest for every asset without forcing a backfill latest', async () => {
  for (const needle of ['asset.state', 'asset.digest', "createHash('sha256')"]) {
    const x = await actual();
    x.workflow = x.workflow.replaceAll(needle, `removed_${needle.replace(/\W/g, '_')}`);
    expectRule(x, 'remote-assets', `removing ${needle}`);
  }
  const verify = await actual();
  verify.workflow = verify.workflow.replace('gh release verify-asset "$TAG" "$ASSET"', 'echo no-asset-attestation');
  expectRule(verify, 'remote-assets', 'removing per-asset GitHub verification');

  const latest = await actual();
  latest.workflow = latest.workflow.replace('gh release edit "$TAG" --draft=false', 'gh release edit "$TAG" --draft=false --latest');
  expectRule(latest, 'release-kind', 'forcing an older stable release to latest');
});

test('privileged jobs are attached to the protected release environment', async () => {
  const base = await actual();
  for (const id of ['preflight', 'build', 'attest', 'publish']) {
    const x = { ...base };
    const marker = `  ${id}:`;
    const start = x.workflow.indexOf(marker);
    const after = x.workflow.slice(start + marker.length);
    const nextJob = /^  [A-Za-z_][A-Za-z0-9_-]*:\s*(?:#.*)?$/m.exec(after);
    const end = nextJob ? start + marker.length + nextJob.index : x.workflow.length;
    const body = x.workflow.slice(start, end).replace('    environment: release\n', '');
    x.workflow = `${x.workflow.slice(0, start)}${body}${x.workflow.slice(end)}`;
    expectRule(x, 'environment', `removing release environment from ${id}`);
  }
});

test('package contract: complete runtime surfaces are required, exact, locked, and patched', async () => {
  const x = await actual();
  const pkg = JSON.parse(x.packageJson);
  const lock = JSON.parse(x.lock);
  assert.deepEqual(pkg.dependencies, {
    '@modelcontextprotocol/sdk': '1.30.0',
    'jsonc-parser': '3.3.1',
    'tuf-js': '6.0.0',
  }, 'a user-facing runtime surface became silently optional or drifted');
  assert.deepEqual(pkg.optionalDependencies, { jscpd: '5.0.14' });
  assert.equal(pkg.engines.node, '^22.22.2 || ^24.15.0 || >=26.0.0');
  assert.equal(pkg.engines.git, '>=2.45.0', 'package metadata omits the required Git safety floor');
  assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
  assert.deepEqual(lock.packages[''].optionalDependencies, pkg.optionalDependencies);
  assert.equal(lock.packages['node_modules/fast-uri'].version, '3.1.5');
  assert.equal(lock.packages['node_modules/hono'].version, '4.12.34');
  assert.equal(x.lock, x.shrinkwrap, 'publishable shrinkwrap drifted from the reviewed lock');

  x.shrinkwrap = `${x.shrinkwrap}\n`;
  expectRule(x, 'package', 'lock/shrinkwrap drift');

  const optionalMcp = await actual();
  const optionalPkg = JSON.parse(optionalMcp.packageJson);
  optionalPkg.optionalDependencies['@modelcontextprotocol/sdk'] = optionalPkg.dependencies['@modelcontextprotocol/sdk'];
  delete optionalPkg.dependencies['@modelcontextprotocol/sdk'];
  optionalMcp.packageJson = `${JSON.stringify(optionalPkg, null, 2)}\n`;
  expectRule(optionalMcp, 'package', 'making an advertised runtime surface optional');
});

test('SBOM contract: root identity is the package, not the checkout directory basename', async (t) => {
  // npm 10.9 emitted `name: grove` here while the purl said holt. That happened to look correct on
  // CI because its checkout directory was also named holt. Exercise the generator from this real
  // differently-named checkout and assert both identity and patched dependency versions.
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-sbom-test-'));
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));
  const fixtureRoot = path.join(scratch, 'checkout-name-must-not-leak');
  const out = path.join(scratch, 'out');
  await fs.mkdir(path.join(fixtureRoot, 'scripts'), { recursive: true });
  await fs.mkdir(out);
  await Promise.all([
    fs.copyFile(path.join(ROOT, 'scripts/gen-sbom.mjs'), path.join(fixtureRoot, 'scripts/gen-sbom.mjs')),
    fs.copyFile(path.join(ROOT, 'package.json'), path.join(fixtureRoot, 'package.json')),
    fs.copyFile(path.join(ROOT, 'package-lock.json'), path.join(fixtureRoot, 'package-lock.json')),
    fs.copyFile(path.join(ROOT, 'npm-shrinkwrap.json'), path.join(fixtureRoot, 'npm-shrinkwrap.json')),
  ]);
  await execFileAsync(process.execPath, ['scripts/gen-sbom.mjs', '--out', out], {
    cwd: fixtureRoot,
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const cdx = JSON.parse(await fs.readFile(path.join(out, 'holt.cdx.json'), 'utf8'));
  const spdx = JSON.parse(await fs.readFile(path.join(out, 'holt.spdx.json'), 'utf8'));
  const described = new Set(spdx.documentDescribes ?? []);
  const spdxRoot = spdx.packages.find((x) => described.has(x.SPDXID));
  assert.equal(cdx.metadata.component.name, 'holt');
  assert.notEqual(cdx.metadata.component.name, path.basename(fixtureRoot),
    'SBOM root identity leaked the checkout directory name again');
  assert.equal(spdxRoot?.name, 'holt');
  assert.equal(spdxRoot?.versionInfo, '0.4.0');
  assert.notEqual(spdxRoot?.name, path.basename(fixtureRoot),
    'SPDX root identity leaked the checkout directory name again');
  assert.ok(cdx.components.some((x) => x.name === 'hono' && x.version === '4.12.34'));
  assert.ok(cdx.components.some((x) => x.name === 'fast-uri' && x.version === '3.1.5'));
  assert.equal(cdx.components.some((x) => /typescript|@types\/node/.test(x.name)), false,
    'development-only packages leaked into the release SBOM');

  const generator = await fs.readFile(path.join(ROOT, 'scripts/gen-sbom.mjs'), 'utf8');
  assert.doesNotMatch(generator, /npm\.cmd/,
    'Windows must not execute npm through a .cmd wrapper that execFile cannot launch safely');
  assert.match(generator, /execFileSync\(process\.execPath, \[npmCli,/,
    'SBOM generation must execute npm-cli.js with the already selected Node binary');
});
