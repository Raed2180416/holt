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
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outIdx = process.argv.indexOf('--out');
const OUT = outIdx === -1 ? ROOT : path.resolve(process.argv[outIdx + 1]);
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function sbom(format) {
  // --package-lock-only: resolve from package-lock.json, not from whatever happens to be in
  //   node_modules. Deterministic, and immune to a dirty install directory.
  // --omit dev: the published package contains no devDependency, so neither may its SBOM.
  // Optional dependencies are KEPT, because `npm i -g holt` installs them by default and a
  // buyer's scanner will see them on disk. Omitting them would be the flattering lie.
  return execFileSync(npmBin, [
    'sbom', '--sbom-format', format, '--sbom-type', 'application',
    '--package-lock-only', '--omit', 'dev',
  ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

const cdx = JSON.parse(sbom('cyclonedx'));
const spdx = JSON.parse(sbom('spdx'));

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
