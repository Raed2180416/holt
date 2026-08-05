// SPDX-License-Identifier: FSL-1.1-MIT

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('free/core launch exposes one honest install path and no paid-tier checkout', async () => {
  const [site, pages] = await Promise.all([
    fs.readFile(path.join(ROOT, 'site', 'index.html'), 'utf8'),
    fs.readFile(path.join(ROOT, '.github', 'workflows', 'pages.yml'), 'utf8'),
  ]);

  const grid = site.match(/<div class="price-grid"[^>]*>([\s\S]*?)<\/div>\s*<p style="margin-top:24px">/);
  assert.ok(grid, 'the free/core card must remain visible');
  const cards = [...grid[1].matchAll(/<div class="price(?: featured)?">([\s\S]*?)<\/div>\s*(?=<div class="price|$)/g)];
  assert.equal(cards.length, 1, 'today\'s public launch has exactly one tier: Free');
  assert.match(cards[0][1], /<span class="tier-name">Free<\/span>/);
  assert.match(cards[0][1], /href="#install"[^>]*>Install now<\/a>/);

  assert.match(site, /Team and Enterprise are deliberately not offered in this launch/);
  assert.doesNotMatch(site, /id="cta-team"|data-checkout=|Start a Team plan|>Talk to us<|__HOLT_API__/,
    'a free/core launch must not accidentally expose paid checkout or sales CTAs');
  assert.doesNotMatch(pages, /HOLT_API_URL|__HOLT_API__|checkout endpoint/i,
    'the Pages deploy must not silently reactivate a paid checkout');
});
