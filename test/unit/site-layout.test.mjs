// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — the marketing site must not scroll sideways on a phone.
 *
 * MEASURED, in a real browser at a 375px viewport: the document was 532px wide, so the entire
 * page slid horizontally under the reader's thumb. On a page whose whole argument is rigour,
 * that is the first thing a visitor notices and the last thing they forgive.
 *
 * THE CAUSE WAS ONE CSS RULE CLASS, NOT A LIST OF BROKEN ELEMENTS. A grid track written `1fr`
 * carries an implicit `auto` MINIMUM — the max-content width of the widest item in that track.
 * This page is full of unbreakable tokens (file paths, shell commands, symbol names), so a single
 * one of them stretched its track past the viewport and dragged the document with it:
 * `.install-grid` computed to a single 508px column inside a 327px container. The fix is the
 * explicit zero minimum, `minmax(0, 1fr)`, applied to every track.
 *
 * These assertions are static — they check the CAUSES, because a browser is not available in CI.
 * The verification that the page actually stopped overflowing was done in a real browser at
 * 375px (document width 532px -> 375px, zero escaping elements) and again at 1265px to confirm
 * the multi-column desktop layout survived.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../site/index.html');

test('site: every grid track can shrink below its content (minmax(0, …), not bare fr)', async () => {
  const css = await fs.readFile(SITE, 'utf8');
  const decls = [...css.matchAll(/grid-template-columns:\s*([^;}]+)/g)].map((m) => m[1].trim());
  assert.ok(decls.length > 5,
    `only ${decls.length} grid declarations found — the pattern has drifted and this test is ` +
    'no longer reading the stylesheet');

  const bare = decls.filter((d) => /(?<![\w(.])\d*\.?\d+fr/.test(d.replace(/minmax\([^)]*\)/g, '')));
  assert.deepEqual(bare, [],
    'these grid tracks use a bare `fr`, which carries an implicit `auto` minimum and will push ' +
    `the page wider than a phone as soon as one long token lands in them: ${bare.join(' | ')}`);
});

test('site: anything legitimately wider than a phone scrolls inside its OWN container', async () => {
  const css = await fs.readFile(SITE, 'utf8');
  // A table or code block genuinely can be wider than 375px. That is fine — as long as IT
  // scrolls, rather than the document. Each of these must therefore declare its own overflow-x.
  for (const cls of ['.table-wrap', '.ab-table-wrap', '.code-block']) {
    const rule = new RegExp(`\\${cls}[^{]*\\{[^}]*overflow-x:\\s*(auto|scroll)`);
    assert.match(css, rule,
      `${cls} holds content wider than a phone but declares no overflow-x, so the PAGE scrolls ` +
      'instead of the block');
  }
});

test('site: flex and grid items are allowed to shrink', async () => {
  const css = await fs.readFile(SITE, 'utf8');
  // The companion half of the same defect: a flex ITEM also defaults to min-width:auto.
  assert.match(css, /min-width:\s*0/,
    'no `min-width: 0` rule exists — flex and grid items default to min-width:auto and will ' +
    'refuse to shrink below their content, which is the other half of the sideways-scroll bug');
});

test('site: declares a viewport meta, or none of the above matters', async () => {
  const html = await fs.readFile(SITE, 'utf8');
  assert.match(html, /<meta\s+name="viewport"[^>]*width=device-width/,
    'without width=device-width a phone renders the page at ~980px and scales it down, which ' +
    'hides every layout defect above rather than fixing one of them');
});

test('site: terminal samples flip to a readable light palette for both theme entry paths', async () => {
  const css = await fs.readFile(SITE, 'utf8');
  // The page has two ways to arrive in light mode: an explicit toggle and a visitor's light
  // system preference. Both must flip the terminal background AND its foreground; otherwise a
  // terminal can look fine in one path and ship low-contrast text in the other.
  const lightBlocks = [
    /:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/,
    /@media \(prefers-color-scheme: light\)\s*\{\s*:root:not\(\[data-theme="dark"\]\)\s*\{([\s\S]*?)\n\s*\}\s*\}/,
  ];
  for (const block of lightBlocks) {
    const match = css.match(block);
    assert.ok(match, `missing a complete light-theme token block for ${block}`);
    assert.match(match[1], /--bg-terminal:\s*#f8f5ef/,
      'light mode leaves the rendered terminal on the dark background');
    assert.match(match[1], /--term-fg:\s*#2d333b/,
      'light mode leaves the rendered terminal foreground on its dark-theme colour');
  }
  assert.match(css, /\.term\s*\{[^}]*color:\s*var\(--term-fg\)/,
    'the static TUI sample bypasses the theme token and cannot follow either light palette');
});
