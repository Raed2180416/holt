// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — the site deploy gate, mirrored into the test suite.
 *
 * pages.yml has a "Verify the site is self-contained" step that greps every site/*.html for
 * external assets and refuses to deploy if any are found. That gate runs ONLY on push to main
 * (the pages workflow's trigger), so a PR that adds a Google Fonts import or a CDN script can
 * merge green — the suite never checks — and the deploy dies on the NEXT push to main, freezing
 * the live site at whatever was deployed before the PR. This happened: three logo-prototype
 * files each carried a Google Fonts CSS import, the deploy died at step 2 of 6 on every push
 * for weeks, and no test noticed because the gate lived in the workflow and not in the suite.
 *
 * This test mirrors the EXACT grep the workflow runs, so the gate fires on every `npm test` and
 * every CI matrix job, not just on the pages deploy. A PR that introduces an external asset
 * fails here before it merges.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../site');

// The EXACT pattern pages.yml greps for: src="https?://, href="https?://...css|js, @import,
// url(https?://. Any one of these means the page reaches out to a CDN at render time.
const EXTERNAL_ASSET_RE = /src="https?:\/\/|href="https?:\/\/[^"]*\.(css|js)|@import|url\(https?:\/\//;

test('site: every site/*.html is self-contained — no external assets (mirrors the pages.yml deploy gate)', async () => {
  const files = await fs.readdir(SITE_DIR);
  const htmlFiles = files.filter((f) => f.endsWith('.html'));
  assert.ok(htmlFiles.length > 0, 'no HTML files in site/ — the directory has moved or is empty');

  const failures = [];
  for (const f of htmlFiles) {
    const content = await fs.readFile(path.join(SITE_DIR, f), 'utf8');
    if (EXTERNAL_ASSET_RE.test(content)) {
      // Report the specific offending pattern so the fix is obvious.
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (EXTERNAL_ASSET_RE.test(lines[i])) {
          failures.push(`${f}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }
  }

  assert.equal(failures.length, 0,
    `site/*.html must be self-contained — pages.yml refuses to deploy external assets, but the ` +
    `suite never checked until now. Offending lines:\n${failures.join('\n')}`);
});
