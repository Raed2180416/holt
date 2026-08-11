// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — THE INSTALL COMMAND IS THE FIRST THING ANYONE RUNS, AND NOTHING WAS CHECKING IT.
 *
 * History: the README shipped `…/releases/download/v0.3.1/holt.tgz` — a URL with a version baked
 * into it that went stale by design and 404'd outright because v0.3.1 had never been released.
 * The first version of this gate bound the README's GitHub-release URL to the release workflow's
 * attached assets so neither could drift from the other.
 *
 * holt is distributed via GitHub release tarballs (not the npm registry), so the canonical install
 * is `npm install -g <github-url>`. This gate binds three facts together:
 *
 *   · every covered file advertises an `npm install -g` command pointing at a GitHub release
 *     tarball — the same on Linux, macOS and Windows, with no version baked in;
 *   · the README and site use the stable-latest form (`releases/latest/download/`) which always
 *     resolves to the newest release and never goes stale;
 *   · no covered file carries a tag-pinned release URL (`/releases/download/<tag>/…`), which
 *     is the exact shape that 404'd before — tag-pinned URLs belong only in release bodies.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Files whose install command a human is expected to copy and run. */
const COVERED = [
  'README.md',
  'site/index.html',
  'SUPPORT.md',
  'docs/launch/DESIGN-PARTNER-PROGRAM.md',
];

test('every covered file advertises an npm install command for the GitHub release tarball', async () => {
  let checked = 0;
  for (const rel of COVERED) {
    const text = await fs.readFile(path.join(ROOT, rel), 'utf8');
    // The install command must be `npm install -g <url>` where the URL points at the GitHub
    // release tarball. The stable-latest form is required for README/site so the command
    // never goes stale.
    assert.match(text,
      /npm\s+install\s+-g\s+https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/latest\/download\/holt\.tgz/,
      `${rel} does not advertise 'npm install -g <github-releases-latest-tarball>'. `
      + 'Either the install command was changed, or this gate has stopped finding it. Both need a human.');
    checked++;
  }
  assert.ok(checked > 0, 'no install command was checked — the gate is blind');
});

test('no covered file carries a tag-pinned GitHub-release URL', async () => {
  // The shape that 404'd: /releases/download/<tag>/<asset>.tgz. A stable-latest form
  // (/releases/latest/download/) is acceptable as a fallback, but a tag-pinned URL in the README
  // or site goes stale the moment the next release is cut.
  for (const rel of COVERED) {
    const text = await fs.readFile(path.join(ROOT, rel), 'utf8');
    const pinned = /\/releases\/download\/v?\d[\w.-]*\//.exec(text);
    assert.ok(!pinned,
      `${rel} carries a tag-pinned release URL: ${pinned?.[0]}\n`
      + '  Every future release makes this command hand the reader an old build, and it 404s '
      + '  outright until that exact tag is published.\n'
      + '  Use `releases/latest/download/holt.tgz` instead.');
  }
});

test('shipped remediation never points at the unclaimed npm registry name', async () => {
  const shipped = [];
  for (const base of ['src', 'bin']) {
    const root = path.join(ROOT, base);
    for (const rel of await fs.readdir(root, { recursive: true })) {
      if (!rel.endsWith('.mjs')) continue;
      const label = path.posix.join(base, rel.split(path.sep).join('/'));
      shipped.push({ rel: label, text: await fs.readFile(path.join(root, rel), 'utf8') });
    }
  }
  assert.ok(shipped.length > 20, 'the shipped-source scan is unexpectedly empty');
  for (const { rel, text } of shipped) {
    assert.doesNotMatch(text, /npm install -g holt(?:[`\s),.]|$)/,
      `${rel} must not recommend an npm registry package that is not published`);
  }

  for (const rel of ['src/integrate/adapters.mjs', 'src/supply-chain.mjs']) {
    const source = shipped.find((entry) => entry.rel === rel)?.text ?? '';
    assert.match(source,
      /npm install -g https:\/\/github\.com\/Raed2180416\/holt\/releases\/latest\/download\/holt\.tgz/,
      `${rel} remediation must name the same official stable GitHub release as README/site`);
  }
});
