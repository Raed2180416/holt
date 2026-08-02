// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — THE INSTALL COMMAND IS THE FIRST THING ANYONE RUNS, AND NOTHING WAS CHECKING IT.
 *
 * The README shipped `…/releases/download/v0.3.1/holt.tgz` — a URL with a version baked into it.
 * Two separate failures live in that shape:
 *
 *   1. IT GOES STALE BY DESIGN. Every release makes the published command point at the previous
 *      one, and the only thing standing between a reader and a wrong download is somebody
 *      remembering to edit a markdown file. `v0.3.1` had in fact never been released at all, so
 *      the advertised command was a plain 404 — while the caption beside it claimed the URL was
 *      "stable across releases".
 *   2. THE RELEASE WORKFLOW ALREADY SOLVED IT AND NOBODY WIRED IT UP. `release-artifact.yml`
 *      uploads a SECOND copy of the tarball under the stable name `holt.tgz` precisely so that
 *      `releases/latest/download/holt.tgz` works forever; its own comment writes that URL out.
 *      The README simply never changed. Two files agreeing about a thing by coincidence is not
 *      agreement, and this is what it looks like when the coincidence ends.
 *
 * So this gate binds the three facts together and fails when any of them drifts apart:
 *
 *   · every GitHub release URL a reader is told to run is the STABLE-LATEST form
 *     (`/releases/latest/download/<asset>` — the form GitHub documents for "always the newest
 *     release"), never a tag-pinned one;
 *   · the `<asset>` it names is a file the release workflow ACTUALLY ATTACHES, by that exact
 *     name — an install URL pointing at an asset nobody uploads is a 404 with better manners;
 *   · the workflow still MAKES that stable copy. Delete the `cp`, and the URL breaks at the next
 *     release with nothing failing until a user reports it.
 *
 * WHAT THIS DELIBERATELY DOES NOT COVER. `.github/releases/*.md` are release BODIES, and a
 * release body must pin its own tag — a reader arriving at the v0.3.0 page should get v0.3.0.
 * That direction is already enforced by scripts/check-release-body.mjs, and the two rules are
 * opposites on purpose. `site/index.html` carries the same install command as the README and is
 * NOT yet covered here only because it is owned elsewhere in this change; adding it is one entry
 * in COVERED below, and it should be added the moment the site carries the stable URL.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'release-artifact.yml');

/** Files whose install command a human is expected to copy and run. */
const COVERED = ['README.md'];

const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
/** `git+https://github.com/Owner/repo.git` -> `Owner/repo` */
const SLUG = pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '').split('github.com/')[1];

/** Every URL under this repository's own Releases, in the given text. */
function releaseUrls(text) {
  const re = new RegExp(`https://github\\.com/${SLUG.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}/releases/\\S+?\\.tgz`, 'gi');
  return [...text.matchAll(re)].map((m) => m[0]);
}

/**
 * The literal filenames `gh release upload` attaches. Tokens that are GitHub Actions expressions
 * (`${{ … }}`) are EXCLUDED rather than guessed at: their value is only known at release time,
 * and a gate that pretended to know it would be asserting on a string it invented.
 */
function attachedAssets(workflow) {
  // The COMMAND, anchored to the start of a line — `gh release upload` also appears inside a
  // prose comment in this file, and reading the comment instead of the command would have made
  // the gate assert against an empty asset list while looking like it worked.
  const m = /^[ \t]*gh release upload\b/m.exec(workflow);
  assert.ok(m, `${WORKFLOW} no longer runs 'gh release upload' — this gate is measuring nothing`);
  // Follow shell line-continuations so the whole command is considered, not just its first line.
  const lines = workflow.slice(m.index).split('\n');
  const parts = [];
  for (const line of lines) {
    parts.push(line.replace(/\\\s*$/, ''));
    if (!/\\\s*$/.test(line)) break;
  }
  return parts.join(' ')
    .replace(/^[ \t]*gh release upload/, '')
    // Drop each expression WHOLE before tokenising. Splitting first would leave the inner
    // `needs.build.outputs.tarball` looking like a filename, and the gate would then happily
    // accept a README that named it.
    .replace(/\$\{\{[^}]*\}\}/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^["']|["']$/g, ''))
    .filter((t) => t && !t.startsWith('-') && t.includes('.'));
}

const workflowText = await fs.readFile(WORKFLOW, 'utf8');
const ASSETS = attachedAssets(workflowText);

test('the release workflow attaches at least one literally-named asset', () => {
  // Without this, every assertion below could pass by comparing against an empty set — the exact
  // shape of "the check never ran" that this suite exists to refuse.
  assert.ok(ASSETS.length > 0,
    `no literally-named asset found in the 'gh release upload' command of ${WORKFLOW}`);
});

test('every advertised install URL is the stable-latest form, not a tag-pinned one', async () => {
  let checked = 0;
  for (const rel of COVERED) {
    const text = await fs.readFile(path.join(ROOT, rel), 'utf8');
    const urls = releaseUrls(text);
    assert.ok(urls.length > 0,
      `${rel} advertises no install URL at all — either the install command was removed, or this `
      + 'gate has stopped finding it. Both need a human.');
    for (const url of urls) {
      checked++;
      assert.doesNotMatch(url, new RegExp(`/releases/download/`),
        `${rel} pins the install URL to one release: ${url}\n`
        + '  Every future release makes this command hand the reader an old build, and it 404s '
        + 'outright until that exact tag is published.\n'
        + `  Use https://github.com/${SLUG}/releases/latest/download/<asset> instead.`);
      assert.match(url, /\/releases\/latest\/download\/[^/]+$/,
        `${rel} carries a release URL in a shape this gate does not recognise: ${url}`);
    }
  }
  assert.ok(checked > 0, 'no install URL was checked — the gate is blind');
});

test('the asset the install URL names is one the release workflow actually attaches', async () => {
  for (const rel of COVERED) {
    const text = await fs.readFile(path.join(ROOT, rel), 'utf8');
    for (const url of releaseUrls(text)) {
      const asset = url.split('/').pop();
      assert.ok(ASSETS.includes(asset),
        `${rel} tells readers to download '${asset}', which the release workflow never uploads.\n`
        + `  ${WORKFLOW} attaches: ${ASSETS.join(', ')}\n`
        + '  A URL naming an asset that is never attached is a permanent 404.');
      // ...and the workflow must still CREATE that stable copy. It is a `cp` of the versioned
      // tarball; drop it and the upload has nothing to attach under this name.
      // `.+` rather than `\S+` for the source: it is a GitHub Actions expression containing
      // spaces (`cp "${{ needs.build.outputs.tarball }}" holt.tgz`). Anchored per-line, so it
      // cannot accidentally span the file.
      assert.match(workflowText, new RegExp(`^[ \\t]*cp\\s+.+\\s+${asset.replace(/\./g, '\\.')}\\s*$`, 'm'),
        `${WORKFLOW} no longer creates '${asset}' — the stable install URL in ${rel} would break `
        + 'at the next release.');
    }
  }
});
