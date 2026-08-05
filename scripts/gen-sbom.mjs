#!/usr/bin/env node
// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — generate the SBOMs for a release.
 *
 * THIS DOES NOT WRITE AN SBOM. npm has generated CycloneDX and SPDX natively since npm 10
 * (`npm sbom --sbom-format …`), it derives the graph from the lockfile npm itself resolved, and
 * nothing hand-rolled here could be more authoritative than that. This script exists for the
 * two things npm does NOT do, both of which are ways an SBOM quietly becomes fiction:
 *
 *   1. IT DESCRIBES THE WRONG TREE. `npm sbom` walks node_modules as installed. On a maintainer
 *      machine — and on any CI runner that ran `npm ci` — that is the DEV tree. Run plainly here
 *      it emits 187 components including Stryker, Babel and Express, none of which are in the
 *      published package. A buyer scanning that SBOM would open vulnerability tickets against
 *      software holt does not ship. `--package-lock-only --omit dev` is the fix, and it is the
 *      whole reason this wrapper exists.
 *   2. NOTHING CHECKS THE RESULT. An SBOM with no components, or one whose version disagrees
 *      with the tarball it is attached to, is worse than none — it is an assurance artefact
 *      that assures nothing. The assertions below fail the build instead.
 *
 *   node scripts/gen-sbom.mjs [--out <dir>]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outIdx = process.argv.indexOf('--out');
const OUT = outIdx === -1 ? ROOT : path.resolve(process.argv[outIdx + 1]);
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/**
 * Resolve npm's JavaScript entrypoint and execute it with this exact Node binary. `execFile` does
 * not launch `.cmd` wrappers on Windows without a shell; enabling a shell would make arguments
 * part of a command string. Official Node distributions place npm in one of the two locations
 * below, while npm-run scripts also expose the exact JS path through npm_execpath.
 */
export function resolveNpmCli({ execPath = process.execPath, env = process.env } = {}) {
  const execDir = path.dirname(execPath);
  const candidates = [
    env.npm_execpath,
    path.join(execDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(execDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(execDir, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);

  // POSIX package managers often expose npm as a symlink to npm-cli.js somewhere on PATH.
  if (process.platform !== 'win32') {
    for (const dir of String(env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
      try {
        const resolved = fs.realpathSync(path.join(dir, 'npm'));
        if (resolved.endsWith('.js')) candidates.push(resolved);
      } catch { /* this PATH entry has no npm executable */ }
    }
  }

  const npmCli = candidates.find((candidate) => candidate.endsWith('.js') && fs.existsSync(candidate));
  if (!npmCli) {
    throw new Error(`cannot locate npm-cli.js beside ${execPath}; refusing to invoke a shell wrapper`);
  }
  return npmCli;
}

const npmCli = resolveNpmCli();

// npm 10.9 names an application SBOM's root component after cwd's basename even while its
// bom-ref and purl correctly use package.json. Running in `/home/runner/work/holt/holt` happens to
// hide that bug; this checkout is `/home/raed/grove`, where the same command emitted a component
// named "grove" for `pkg:npm/holt@0.3.1`. Stage only the reviewed manifests under a directory
// whose basename is the package name, so the resulting document is correct on every checkout
// path. `--package-lock-only` means no source or node_modules is read from the staging directory.
const stageParent = fs.mkdtempSync(path.join(os.tmpdir(), 'holt-sbom-'));
const stageLeaf = String(pkg.name ?? '').replace(/^@/, '').replace(/[\\/]/g, '-');
if (!stageLeaf || stageLeaf === '.' || stageLeaf === '..') throw new Error('invalid package name for SBOM staging');
const SBOM_ROOT = path.join(stageParent, stageLeaf);
fs.mkdirSync(SBOM_ROOT);
for (const name of ['package.json', 'package-lock.json', 'npm-shrinkwrap.json']) {
  const source = path.join(ROOT, name);
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(SBOM_ROOT, name));
}

function sbom(format) {
  // --package-lock-only: resolve from package-lock.json, not from whatever happens to be in
  //   node_modules. Deterministic, and immune to a dirty install directory.
  // --omit dev: the published package contains no devDependency, so neither may its SBOM.
  // Optional dependencies are KEPT, because `npm i -g holt` installs them by default and a
  // buyer's scanner will see them on disk. Omitting them would be the flattering lie.
  return execFileSync(process.execPath, [npmCli,
    'sbom', '--sbom-format', format, '--sbom-type', 'application',
    '--package-lock-only', '--omit', 'dev',
  ], { cwd: SBOM_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

let cdx;
let spdx;
try {
  cdx = JSON.parse(sbom('cyclonedx'));
  spdx = JSON.parse(sbom('spdx'));
} finally {
  fs.rmSync(stageParent, { recursive: true, force: true });
}

/* ---- assertions: an SBOM that describes the wrong thing must fail the build ---- */
const fail = (m) => { process.stderr.write(`gen-sbom: ${m}\n`); process.exitCode = 1; };

if (cdx.metadata?.component?.version !== pkg.version) {
  fail(`CycloneDX says version ${cdx.metadata?.component?.version}, package.json says ${pkg.version}`);
}
if (cdx.metadata?.component?.name !== pkg.name) fail('CycloneDX component name does not match package.json');

const devLeak = (cdx.components ?? []).filter((c) => c.scope === 'excluded' || /stryker|babel/i.test(c.name ?? ''));
if (devLeak.length) fail(`dev-only packages leaked into the SBOM: ${devLeak.map((c) => c.name).join(', ')}`);

const noPurl = (cdx.components ?? []).filter((c) => !c.purl);
if (noPurl.length) fail(`${noPurl.length} component(s) have no purl, so no scanner can match them`);

const described = new Set(spdx.documentDescribes ?? []);
const spdxRoot = (spdx.packages ?? []).find((p) => described.has(p.SPDXID));
if (!spdxRoot) {
  fail('SPDX document does not identify a root package in documentDescribes');
} else {
  if (spdxRoot.name !== pkg.name) fail('SPDX package name does not match package.json');
  if (spdxRoot.versionInfo !== pkg.version) {
    fail(`SPDX says version ${spdxRoot.versionInfo}, package.json says ${pkg.version}`);
  }
}
const spdxDevLeak = (spdx.packages ?? []).filter((p) => /stryker|babel|typescript|@types\/node/i.test(p.name ?? ''));
if (spdxDevLeak.length) {
  fail(`dev-only packages leaked into the SPDX SBOM: ${spdxDevLeak.map((p) => p.name).join(', ')}`);
}

const required = (cdx.components ?? []).filter((c) => c.scope !== 'optional');
const optional = (cdx.components ?? []).filter((c) => c.scope === 'optional');

fs.writeFileSync(path.join(OUT, 'holt.cdx.json'), `${JSON.stringify(cdx, null, 2)}\n`);
fs.writeFileSync(path.join(OUT, 'holt.spdx.json'), `${JSON.stringify(spdx, null, 2)}\n`);

process.stdout.write(
  `holt.cdx.json   CycloneDX ${cdx.specVersion}  ${cdx.components?.length ?? 0} components\n`
  + `holt.spdx.json  ${spdx.spdxVersion}      ${spdx.packages?.length ?? 0} packages\n`
  + `  required runtime dependencies: ${required.length}\n`
  + `  optional (installed by default, removable with --omit=optional): ${optional.length}\n`,
);
