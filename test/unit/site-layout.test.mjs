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
const STYLES = path.resolve(path.dirname(SITE), 'styles.css');

test('site: every grid track can shrink below its content (minmax(0, …), not bare fr)', async () => {
  const css = await fs.readFile(STYLES, 'utf8');
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
  const css = await fs.readFile(STYLES, 'utf8');
  // A table or code block genuinely can be wider than 375px. That is fine — as long as IT
  // scrolls, rather than the document. Each of these must therefore declare its own overflow-x.
  for (const cls of ['.code-card pre']) {
    const rule = new RegExp(`\\${cls}[^{]*\\{[^}]*overflow-x:\\s*(auto|scroll)`);
    assert.match(css, rule,
      `${cls} holds content wider than a phone but declares no overflow-x, so the PAGE scrolls ` +
      'instead of the block');
  }
});

test('site: flex and grid items are allowed to shrink', async () => {
  const css = await fs.readFile(STYLES, 'utf8');
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

test('site: the declared light page and dark command sample use readable palettes', async () => {
  const css = await fs.readFile(STYLES, 'utf8');
  assert.match(css, /:root\s*\{[^}]*color-scheme:\s*light/s,
    'the editorial surface is light-only and must declare that browser colour scheme explicitly');
  assert.match(css, /body\s*\{[^}]*background:\s*var\(--paper\)[^}]*color:\s*var\(--ink\)/s,
    'the light page must bind both its background and foreground to the declared palette');
  assert.match(css, /\.code-card\s*\{[^}]*background:\s*var\(--night\)/s,
    'the command sample must declare its dark surface instead of inheriting the light page');
  assert.match(css, /\.code-card pre\s*\{[^}]*color:\s*#d6ddd4/s,
    'the command sample must declare a readable foreground on its dark surface');
});

test('site: uses the Holt-only, theme-ready wordmark and mark assets consistently', async () => {
  const html = await fs.readFile(SITE, 'utf8');
  const css = await fs.readFile(STYLES, 'utf8');
  assert.match(html, /brand\/holt-wordmark-transparent\.png/,
    'the hero should show the Holt-only wordmark, not the duplicate-h lockup card');
  assert.match(html, /brand\/holt-mark-transparent\.png/,
    'navigation and footer should use the theme-ready standalone h mark');
  assert.equal((html.match(/class="brand-rest"[^>]*>olt<\/span>/g) || []).length, 2,
    'each compact lockup must pair the standalone h mark with only the remaining letters "olt"');
  assert.doesNotMatch(html, /holt-mark-transparent\.png[^<]*<\/?.*?>?\s*holt\b/,
    'the standalone h mark must never be followed by a second complete "holt" word');
  assert.match(css, /\.hero-wordmark\s*\{[^}]*filter:[^;}]*brightness\(0\)[^;}]*invert\(1\)/s,
    'the dark hero must render the supplied dark wordmark with an explicit high-contrast treatment');
  assert.doesNotMatch(html, /<img[^>]+src="brand\/holt-lockup\.png"/,
    'the old paper lockup must not be rendered inside the theme-aware site chrome');
  assert.doesNotMatch(html, /data:image\/svg\+xml/,
    'the old generated favicon hides the supplied Holt mark from the public brand surface');
  for (const asset of [
    'holt-lockup.png', 'holt-wordmark.png', 'holt-mark.png',
    'holt-wordmark-transparent.png', 'holt-mark-transparent.png',
  ]) {
    await fs.access(path.resolve(path.dirname(SITE), 'brand', asset));
  }
});

test('site: design-partner CTAs resolve to an on-page explanation and a concrete intake', async () => {
  const [html, intake] = await Promise.all([
    fs.readFile(SITE, 'utf8'),
    fs.readFile(path.resolve(path.dirname(SITE), '..', '.github', 'ISSUE_TEMPLATE', 'design_partner.yml'), 'utf8'),
  ]);
  assert.equal((html.match(/href="#contact"/g) || []).length, 2,
    'the header and hero design-partner CTAs should visibly navigate to the on-page next step');
  assert.match(html,
    /href="https:\/\/github\.com\/Raed2180416\/holt\/issues\/new\?template=design_partner\.yml"/,
    'the public workflow option must open the dedicated design-partner intake');
  assert.match(html,
    /id="start-contact"[^>]*href="mailto:research\.contrare@outlook\.com\?subject=Holt%20design-partner%20conversation"/,
    'the primary contact action must name the real contact address and open an email draft');
  assert.match(html, /id="contact-status"[^>]*aria-live="polite"/,
    'the contact action needs a visible live fallback when the browser has no mail handler');
  assert.match(html, /navigator\.clipboard\.writeText\(email\)\.then\(function \(\) \{ update\(true\); \}, fallback\)/,
    'the contact action must copy the real address before relying on a configured mail handler');
  assert.match(html, /status\.textContent = copied[\s\S]*Email copied:[\s\S]*opening your email app/,
    'the contact action must provide visible feedback even when a mail handler does not open');
  assert.match(intake, /This issue is public/);
  assert.match(intake, /one successful workflow and one resilience scenario/i,
    'design-partner intake must request a resilience control, not only a product wish');
});

test('site: install copy action has a fallback and never fails silently', async () => {
  const html = await fs.readFile(SITE, 'utf8');
  assert.match(html, /navigator\.clipboard\.writeText\(command\)\.then\(done, fallback\)/,
    'modern clipboard rejection must enter the same explicit fallback as an unavailable API');
  assert.match(html, /document\.execCommand\('copy'\)/,
    'the static Pages site needs a compatibility fallback for restricted clipboard contexts');
  assert.match(html, /button\.textContent = 'Copy failed'/,
    'if both copy mechanisms fail, the live region must tell the user instead of doing nothing');
  assert.doesNotMatch(html, /then\(done, function \(\) \{\}\)/,
    'clipboard rejection must never be swallowed by an empty handler');
});

test('site: leads with Holt strengths instead of defensive or gotcha framing', async () => {
  const html = await fs.readFile(SITE, 'utf8');
  assert.match(html, /See every workstream\. Preserve every valuable change\. Keep agents moving\./,
    'the repository-intelligence section must lead with the operational benefit');
  assert.match(html, /Explore the system/,
    'adoption guidance should invite technical depth instead of warning the reader away');
  assert.doesNotMatch(html, /The missing layer|Read before adopting|Roadmap \/ not available yet|fail-closed decisions/i,
    'the public narrative must not lead with deficit, refusal, or gotcha language');
});

test('site: product proof is a real Holt capture, never an invented interface', async () => {
  const html = await fs.readFile(SITE, 'utf8');
  const css = await fs.readFile(STYLES, 'utf8');
  const capture = path.resolve(path.dirname(SITE), 'product', 'controlled-tui-120x36.png');
  const evidenceCapture = path.resolve(path.dirname(SITE), '..', 'docs', 'evidence', 'tui-graph',
    'run-2026-08-05-final', 'controlled-tui-120x36.png');
  const evidenceManifest = path.resolve(path.dirname(evidenceCapture), '..', 'SHA256SUMS');

  assert.match(html, /src="product\/controlled-tui-120x36\.png"/,
    'the hero must render the checked-in Holt TUI evidence capture');
  assert.match(html, /Actual product \/ production renderer/,
    'the capture must be identified as real product output, not decoration');
  assert.match(html, /holt tui --snapshot/,
    'the page must name the exact public command that produced the product surface');
  assert.match(html, /docs\/evidence\/tui-graph/,
    'the product capture must link to its reproducible evidence packet');
  assert.doesNotMatch(html, /illustrative surface|representative view|repo-tree|decision-card|tree-row/i,
    'a marketing mock must never be presented in the hero as if it were Holt product UI');
  assert.doesNotMatch(css, /Product surface illustration|\.repo-tree|\.decision-card|\.tree-row/,
    'dead mock-interface styling must be removed so it cannot be quietly reactivated');
  const [siteBytes, evidenceBytes, checksums] = await Promise.all([
    fs.readFile(capture),
    fs.readFile(evidenceCapture),
    fs.readFile(evidenceManifest, 'utf8'),
  ]);
  assert.ok(siteBytes.length > 100_000,
    `the product capture is missing or implausibly small (${siteBytes.length} bytes)`);
  assert.deepEqual(siteBytes, evidenceBytes,
    'the public image must be the exact audited TUI evidence bytes, not a lookalike screenshot');
  assert.match(checksums,
    /fd931ae4ff36228c94e71abbb9b3a6d1942a78e44a7123f7c476ad47f79fcc38\s+docs\/evidence\/tui-graph\/run-2026-08-05-final\/controlled-tui-120x36\.png/,
    'the source capture must remain bound to the checked-in evidence checksum');
});
