// SPDX-License-Identifier: FSL-1.1-MIT
/** Public-site accessibility and indexing contracts that do not require a browser in CI. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SITE = path.join(ROOT, 'site');

function channel(value) {
  const n = value / 255;
  return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  assert.ok(match, `expected a six-digit hex colour, got ${hex}`);
  const [r, g, b] = [0, 2, 4].map((offset) => channel(Number.parseInt(match[1].slice(offset, offset + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground, background) {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function variables(css) {
  return Object.fromEntries([...css.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)]
    .map((match) => [`--${match[1]}`, match[2].toLowerCase()]));
}

test('site: primary page has a keyboard-reachable semantic structure', async () => {
  const [html, css] = await Promise.all([
    fs.readFile(path.join(SITE, 'index.html'), 'utf8'),
    fs.readFile(path.join(SITE, 'styles.css'), 'utf8'),
  ]);

  assert.match(html, /<html\s+lang="en">/);
  assert.match(html, /<a class="skip-link" href="#main">/);
  assert.match(html, /<main id="main" tabindex="-1">/,
    'the skip-link target must accept programmatic focus, not only scroll into view');
  assert.equal((html.match(/<h1\b/g) || []).length, 1, 'the landing page needs exactly one h1');
  assert.ok((html.match(/<nav\b[^>]*aria-label=/g) || []).length >= 2,
    'primary and footer navigation need distinct accessible labels');
  assert.match(html, /<button class="copy-button"[^>]*type="button"[^>]*aria-live="polite"/);
  assert.doesNotMatch(html, /tabindex="[1-9]\d*"/, 'positive tabindex creates a surprising focus order');
  for (const list of html.match(/<(?:ul|ol)\b[^>]*>/g) || []) {
    assert.match(list, /\brole="list"/,
      `list-style:none needs role="list" to preserve Safari and VoiceOver semantics: ${list}`);
  }

  assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*3px\s+solid/s,
    'keyboard focus needs a visible, non-colour-only indicator');
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/,
    'the site must respect the visitor reduced-motion preference');
  assert.match(css, /\.nav a\s*\{[^}]*min-height:\s*44px/s);
  assert.match(css, /\.button\s*\{[^}]*min-height:\s*48px/s);
  assert.match(css, /\.copy-button\s*\{[^}]*min-height:\s*44px/s);
});

test('site: the first copied workflow is inspection-only and names its runtime boundary', async () => {
  const html = await fs.readFile(path.join(SITE, 'index.html'), 'utf8');
  const payload = /var command = '([^']+)'/.exec(html)?.[1] ?? '';
  assert.ok(payload, 'copy payload was not found');
  assert.match(payload, /holt --version\\nholt doctor\\nholt status\\nholt risk/);
  assert.doesNotMatch(payload,
    /holt (?:auto|protect|unprotect|rescue|clean|restore|purge|discard|setup|integrate|uninstall)\b/,
    'the first-paste workflow must not mutate Git, locks, quarantine, files, or host configuration');
  assert.match(html, /Requires Node <code>\^22\.22\.2 \|\| \^24\.15\.0 \|\| &gt;=26\.0\.0<\/code> and Git 2\.45 or newer/);
  assert.match(html, /Protection and quarantine remain separate, explicit actions/);
});

test('site: small public text combinations meet WCAG AA contrast', async () => {
  const css = await fs.readFile(path.join(SITE, 'styles.css'), 'utf8');
  const vars = variables(css);
  const checks = [
    ['ink on paper', vars['--ink'], vars['--paper']],
    ['soft ink on paper', vars['--ink-soft'], vars['--paper']],
    ['faint ink on paper', vars['--ink-faint'], vars['--paper']],
    ['faint ink on bright paper', vars['--ink-faint'], vars['--paper-bright']],
    ['faint ink on deep paper', vars['--ink-faint'], vars['--paper-deep']],
    ['signal on paper', vars['--signal'], vars['--paper']],
    ['white on signal button', vars['--white'], vars['--signal']],
    ['hero body on night', '#c8d1c8', vars['--night']],
    ['hero metadata on night', '#8fa095', vars['--night']],
    ['roadmap body on night', '#99aaa0', vars['--night']],
    ['partner body on soft signal', '#634c41', vars['--signal-soft']],
    ['partner status on soft signal', '#76574b', vars['--signal-soft']],
  ];

  for (const [label, foreground, background] of checks) {
    assert.ok(foreground && background, `${label}: colour variable was not found`);
    const ratio = contrast(foreground, background);
    assert.ok(ratio >= 4.5, `${label}: contrast ${ratio.toFixed(2)} is below 4.5:1`);
  }
});

test('site: only the canonical landing page is invited into search indexes', async () => {
  const [index, thanks, robots, sitemap] = await Promise.all([
    fs.readFile(path.join(SITE, 'index.html'), 'utf8'),
    fs.readFile(path.join(SITE, 'thanks.html'), 'utf8'),
    fs.readFile(path.join(SITE, 'robots.txt'), 'utf8'),
    fs.readFile(path.join(SITE, 'sitemap.xml'), 'utf8'),
  ]);

  assert.match(index, /<meta name="robots" content="index,follow">/);
  assert.match(index, /<link rel="canonical" href="https:\/\/raed2180416\.github\.io\/holt\/">/);
  assert.match(index, /<meta property="og:image:width" content="1079">/);
  assert.match(index, /<meta property="og:image:height" content="392">/);
  assert.match(thanks, /<meta name="robots" content="noindex,follow">/);

  for (const name of ['logo-prototype.html', 'logo-prototype-v2.html', 'logo-prototype-v3.html', 'logo-prototype-v4.html']) {
    const html = await fs.readFile(path.join(SITE, name), 'utf8');
    assert.match(html, /<meta name="robots" content="noindex,nofollow">/,
      `${name} is a design artifact and must not compete with the product landing page`);
    assert.match(robots, new RegExp(`Disallow: /${name.replace('.', '\\.')}($|\\n)`));
  }

  assert.match(robots, /Sitemap: https:\/\/raed2180416\.github\.io\/holt\/sitemap\.xml/);
  assert.match(sitemap, /<loc>https:\/\/raed2180416\.github\.io\/holt\/<\/loc>/);
  assert.equal((sitemap.match(/<url>/g) || []).length, 1,
    'prototype and thank-you routes must not appear in the public sitemap');
});
