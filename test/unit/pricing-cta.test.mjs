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

  const offers = [...site.matchAll(/<article\b[^>]*data-offer="([^"]+)"[^>]*>([\s\S]*?)<\/article>/g)];
  assert.equal(offers.length, 1, 'today\'s public launch must expose exactly one offer');
  assert.equal(offers[0][1], 'free-core', 'the only current offer must be the free/core product');
  assert.match(offers[0][2], /<h3>Free core<\/h3>/);
  assert.match(offers[0][2], /data-cta="install"[^>]*href="#install"[^>]*>Install now\b/,
    'the free/core offer must have a visible CTA to the working install path');

  assert.match(site, /Team and Enterprise are deliberately not offered in this launch/);
  assert.doesNotMatch(site, /id="cta-team"|data-checkout=|Start a Team plan|__HOLT_API__|\/checkout\b/,
    'a free/core launch must not accidentally expose paid checkout or sales CTAs');
  assert.doesNotMatch(pages, /HOLT_API_URL|__HOLT_API__|checkout endpoint/i,
    'the Pages deploy must not silently reactivate a paid checkout');
});
