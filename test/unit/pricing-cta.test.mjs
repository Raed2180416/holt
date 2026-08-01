// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — the pricing page must be able to make a sale, or at least take a message.
 *
 * `site/index.html` priced a Team and an Enterprise tier with ZERO clickable path to either one —
 * no button, no link, not even a mailto: — while `.github/workflows/pages.yml` already contained
 * a step ("Wire the checkout endpoint if configured") written entirely around a "Start a Team
 * plan" button that did not exist in the file it was patching. The workflow's own `__HOLT_API__`
 * substitution had nothing to substitute into. A visitor who reached #pricing today had no way to
 * become a customer and no way to ask a human — which is worse than the dead button the runbook
 * warned against, because a dead button is at least visible as broken.
 *
 * The fix ships the Team button pointed at a channel a human actually reads (a GitHub issue,
 * matching the `/checkout` 503 fallback and the `thanks.html` resend-failure copy — never a
 * `mailto:` to a domain this project does not own, which is the exact mistake fixed elsewhere in
 * this codebase and must not be reintroduced here) and carries the `__HOLT_API__` placeholder
 * `pages.yml` expects, in a `data-` attribute the page can safely rewrite from *once it has been
 * substituted to a real http(s) origin* — never the other direction.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SITE = path.join(ROOT, 'site', 'index.html');

async function readSite() { return fs.readFile(SITE, 'utf8'); }

/** Every `.price` card block, in document order, as raw HTML. */
function priceCards(html) {
  const grid = html.match(/<div class="price-grid"[^>]*>([\s\S]*?)<\/div>\s*<p style="margin-top:24px">/);
  assert.ok(grid, 'the pricing grid markup has moved or been renamed — this test no longer reads it');
  const body = grid[1];
  const cards = [...body.matchAll(/<div class="price(?: featured)?">([\s\S]*?)<\/div>\s*(?=<div class="price|$)/g)]
    .map((m) => m[1]);
  assert.equal(cards.length, 3, `expected 3 pricing cards (Free/Team/Enterprise), found ${cards.length}`);
  return cards;
}

test('pricing: every tier card has a clickable path forward, not just a promise', async () => {
  const html = await readSite();
  const cards = priceCards(html);
  const names = ['Free', 'Team', 'Enterprise'];
  cards.forEach((card, i) => {
    const anchors = [...card.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>/g)];
    assert.ok(anchors.length >= 1,
      `${names[i]} card has no link or button at all — a visitor cannot act on this tier`);
  });
});

test('pricing: the Team button never SHIPS pointed at the raw, unresolvable placeholder', async () => {
  const html = await readSite();
  const cards = priceCards(html);
  const team = cards[1];

  const hrefs = [...team.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length >= 1, 'the Team card must carry at least one href');
  for (const href of hrefs) {
    assert.doesNotMatch(href, /__HOLT_API__/,
      `the Team button's href is the literal, un-substituted placeholder — this is exactly the ` +
      `dead-link shape the launch runbook warns is worse than no button at all: ${href}`);
    assert.match(href, /^https?:\/\/|^#/, `the Team button href must be a real URL or in-page anchor, got: ${href}`);
  }

  // The default fallback must be a channel a human actually reads. This project already fixed
  // one instance of a mailto: to a domain it does not own (server 503, thanks.html) — the same
  // mistake must not exist here.
  assert.doesNotMatch(team, /mailto:sales@holt\.dev/i,
    'the Team card must not fall back to mailto:sales@holt.dev — that domain is not owned by ' +
    'this project (see server/index.mjs and site/thanks.html for the channel actually used)');
  assert.match(team, /href="https:\/\/github\.com\/Raed2180416\/holt\/issues\/new/,
    'the Team button\'s honest fallback must open a GitHub issue, the channel this project ' +
    'controls and already uses everywhere else a checkout-adjacent failure is surfaced');
});

test('pricing: the Team button carries the __HOLT_API__ placeholder pages.yml expects to substitute', async () => {
  const html = await readSite();
  const workflow = await fs.readFile(path.join(ROOT, '.github', 'workflows', 'pages.yml'), 'utf8');
  assert.match(workflow, /__HOLT_API__/,
    'anti-vacuity: pages.yml no longer mentions __HOLT_API__ — this test and that workflow have drifted apart');

  const cards = priceCards(html);
  const team = cards[1];
  const dataCheckout = team.match(/data-checkout="([^"]+)"/);
  assert.ok(dataCheckout, 'the Team button must carry a data-checkout attribute holding the __HOLT_API__ placeholder');
  assert.match(dataCheckout[1], /^__HOLT_API__\/checkout\?plan=team$/,
    `data-checkout must be exactly the placeholder + the real checkout path the server exposes ` +
    `(see parseCheckoutRequest in server/index.mjs), got: ${dataCheckout[1]}`);
});

test('pricing: substituting HOLT_API_URL (as pages.yml does) produces a real checkout link', async () => {
  const html = await readSite();
  const API = 'https://holt-licenses.fly.dev';
  // The EXACT substitution pages.yml performs: a literal split/join of the placeholder string.
  const substituted = html.split('__HOLT_API__').join(API);

  assert.doesNotMatch(substituted, /__HOLT_API__/, 'every placeholder occurrence must be replaced');
  assert.match(substituted, new RegExp(`data-checkout="${API}/checkout\\?plan=team"`),
    'after substitution, data-checkout must be a real, complete checkout URL');
});

test('pricing: the rewire script only ever moves the href TOWARD a real URL, never away from one', async () => {
  const html = await readSite();
  const script = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/)?.[1] ?? '';
  assert.ok(script.includes('cta-team'), 'the theme-toggle script no longer wires up the Team CTA — the mechanism moved or was deleted');

  // Simulate the guarded branch exactly as the shipped script does, so a regression that flips or
  // removes the http(s) guard (making the button reachable while still pointed at the raw
  // placeholder) is caught without a browser.
  const guard = /if\s*\(\s*\/\^https\?:\\\/\\\/\/\.test\(checkoutUrl\)\s*\)\s*teamCta\.href\s*=\s*checkoutUrl;/;
  assert.match(script, guard,
    'the href rewrite must be gated on the value already being a real http(s) URL — otherwise an ' +
    'un-substituted __HOLT_API__ placeholder could be written into a live href');
});

test('pricing: Enterprise offers a real contact path, not inert text', async () => {
  const html = await readSite();
  const cards = priceCards(html);
  const enterprise = cards[2];
  const hrefs = [...enterprise.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(hrefs.some((h) => /^https:\/\/github\.com\/Raed2180416\/holt\/issues\/new/.test(h)),
    `Enterprise's "Talk to us" must actually link somewhere a human reads it, got hrefs: ${JSON.stringify(hrefs)}`);
});
