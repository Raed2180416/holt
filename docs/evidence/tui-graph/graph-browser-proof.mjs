// SPDX-License-Identifier: FSL-1.1-MIT
/** Browser-level proof for the standalone HTML emitted by the frozen installed Holt executable. */

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assert,
  captureFile,
  exactSet,
} from './installed-proof-support.mjs';

const VIEWPORTS = Object.freeze([
  { name: 'desktop-1440x900', width: 1440, height: 900, mobile: false },
  { name: 'mobile-390x844', width: 390, height: 844, mobile: true },
]);

const edgeClass = (edge) => edge.type === 'collision' ? (edge.kind || 'predicted') : edge.type;
const initialEdgeClasses = new Set(['proven', 'semantic-overlap', 'predicted', 'identical']);

function expectedLineCount(graph, classes) {
  const ids = new Set(graph.nodes.map((node) => node.id));
  return graph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)
    && classes.has(edgeClass(edge))).length;
}

async function browserExecutable(chromium) {
  const candidates = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, '/usr/bin/chromium', chromium.executablePath()]
    .filter(Boolean);
  for (const candidate of candidates) {
    try {
      const real = await fs.realpath(candidate);
      const stat = await fs.stat(real);
      if (stat.isFile()) return real;
    } catch { /* try the next explicit local executable */ }
  }
  throw new Error(`no local Chromium executable found: ${candidates.join(', ')}`);
}

async function screenshot(page, file) {
  await page.screenshot({
    path: file,
    fullPage: true,
    animations: 'disabled',
    caret: 'hide',
    timeout: 0,
  });
  return captureFile(file);
}

function assertNoBrowserErrors(observation) {
  assert(observation.consoleErrors.length === 0,
    `browser console errors: ${observation.consoleErrors.join(' | ')}`);
  assert(observation.pageErrors.length === 0,
    `browser page errors: ${observation.pageErrors.join(' | ')}`);
  assert(observation.requestFailures.length === 0,
    `browser request failures: ${observation.requestFailures.join(' | ')}`);
  assert(observation.networkRequests.length === 0,
    `standalone graph made network requests: ${observation.networkRequests.join(' | ')}`);
}

async function settle(page, expectedNodes) {
  await page.waitForFunction((count) =>
    document.querySelectorAll('circle.node').length === count, expectedNodes, { timeout: 0 });
  await page.waitForFunction(() => typeof running === 'undefined' || running === false,
    null, { timeout: 0 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function assertLayout(page, viewport) {
  const layout = await page.evaluate(() => {
    const stage = document.getElementById('stage')?.getBoundingClientRect();
    const aside = document.querySelector('aside')?.getBoundingClientRect();
    const search = document.getElementById('search')?.getBoundingClientRect();
    return {
      viewport: { width: innerWidth, height: innerHeight },
      document: {
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
      },
      stage: stage && { x: stage.x, y: stage.y, width: stage.width, height: stage.height, bottom: stage.bottom },
      aside: aside && { x: aside.x, y: aside.y, width: aside.width, height: aside.height, bottom: aside.bottom },
      search: search && { x: search.x, y: search.y, width: search.width, right: search.right },
    };
  });
  assert(layout.stage && layout.aside && layout.search, `${viewport.name} is missing stage/aside/search`);
  assert(layout.document.scrollWidth <= viewport.width,
    `${viewport.name} has horizontal overflow ${layout.document.scrollWidth} > ${viewport.width}`);
  assert(layout.search.x >= 0 && layout.search.right <= viewport.width,
    `${viewport.name} search control is clipped`);
  assert(layout.stage.height >= 240, `${viewport.name} graph stage is too short: ${layout.stage.height}`);
  if (viewport.mobile) {
    assert(layout.stage.width >= viewport.width * 0.95,
      `${viewport.name} graph stage is squeezed to ${layout.stage.width}px`);
    assert(layout.aside.width >= viewport.width * 0.95,
      `${viewport.name} controls are squeezed to ${layout.aside.width}px`);
    assert(layout.aside.y >= layout.stage.bottom - 1,
      `${viewport.name} graph and controls are not stacked`);
  } else {
    assert(layout.stage.width >= 900, `${viewport.name} graph stage is too narrow: ${layout.stage.width}`);
    assert(layout.aside.width >= 300, `${viewport.name} aside is too narrow: ${layout.aside.width}`);
    assert(layout.aside.x >= layout.stage.x + layout.stage.width - 1,
      `${viewport.name} graph and controls are not side by side`);
  }
  return layout;
}

async function assertSearch(page, graph, hostileId) {
  await page.locator('#search').fill(hostileId, { timeout: 0 });
  const opacities = await page.locator('circle.node').evaluateAll((nodes) =>
    nodes.map((node) => ({ index: Number(node.dataset.nodeIndex), opacity: node.getAttribute('opacity') })));
  const hostileIndex = graph.nodes.findIndex((node) => node.id === hostileId);
  assert(hostileIndex >= 0, 'hostile oracle node is absent from graph JSON');
  for (const row of opacities) {
    assert(row.opacity === (row.index === hostileIndex ? '1' : '0.12'),
      `search opacity mismatch for node index ${row.index}: ${row.opacity}`);
  }
  return { hostileIndex, opacities };
}

async function assertDecisionFilter(page, graph, selector, expectedPredicate, activation) {
  const row = page.locator(selector);
  if (activation === 'keyboard') {
    await row.focus({ timeout: 0 });
    await page.keyboard.press('Enter');
  } else {
    await row.click({ timeout: 0 });
  }
  const opacities = await page.locator('circle.node').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('opacity')));
  const observed = opacities.filter((opacity) => opacity === '1').length;
  const expected = graph.nodes.filter(expectedPredicate).length;
  assert(observed === expected,
    `${selector} exposes ${observed} nodes, expected exact graph count ${expected}`);
  return { observed, expected, activation };
}

async function exerciseContext({ browser, htmlPath, graph, oracle, out, viewport }) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    reducedMotion: 'reduce',
    colorScheme: 'dark',
    locale: 'en-US',
    serviceWorkers: 'block',
    deviceScaleFactor: 1,
  });
  const observation = {
    viewport,
    isolatedContext: true,
    reducedMotion: true,
    consoleErrors: [],
    pageErrors: [],
    requestFailures: [],
    networkRequests: [],
    screenshots: [],
  };
  context.on('request', (request) => {
    if (/^https?:/i.test(request.url())) observation.networkRequests.push(request.url());
  });
  context.on('requestfailed', (request) => {
    observation.requestFailures.push(`${request.url()}: ${request.failure()?.errorText ?? 'unknown'}`);
  });

  const page = await context.newPage();
  page.setDefaultTimeout(0);
  page.setDefaultNavigationTimeout(0);
  page.on('console', (message) => {
    if (message.type() === 'error') observation.consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => observation.pageErrors.push(error.message));
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load', timeout: 0 });
  await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
  await settle(page, graph.nodes.length);

  const nodeIndexes = await page.locator('circle.node').evaluateAll((nodes) =>
    nodes.map((node) => Number(node.dataset.nodeIndex)));
  exactSet(nodeIndexes, graph.nodes.map((_node, index) => index), `${viewport.name} DOM node indexes`);
  const expectedInitialLines = expectedLineCount(graph, initialEdgeClasses);
  const observedInitialLines = await page.locator('#stage svg line').count();
  assert(observedInitialLines === expectedInitialLines,
    `${viewport.name} initial edge lines ${observedInitialLines} != ${expectedInitialLines}`);
  observation.initial = { nodes: nodeIndexes.length, lines: observedInitialLines };
  observation.layout = await assertLayout(page, viewport);
  observation.screenshots.push(await screenshot(page,
    path.join(out, `graph-${viewport.name}-default.png`)));

  await page.keyboard.press('/');
  assert(await page.evaluate(() => document.activeElement?.id) === 'search',
    `${viewport.name} '/' did not focus search`);
  observation.search = await assertSearch(page, graph, oracle.expected.hostile.id);
  observation.screenshots.push(await screenshot(page,
    path.join(out, `graph-${viewport.name}-hostile-search.png`)));
  await page.keyboard.press('Escape');
  assert(await page.locator('#search').inputValue() === '', `${viewport.name} Escape did not clear search`);

  observation.riskFilter = await assertDecisionFilter(page, graph, '[data-focus="risk"]',
    (node) => node.uncommittedOnly > 0, 'click');
  await page.keyboard.press('Escape');
  observation.safeFilter = await assertDecisionFilter(page, graph, '[data-focus="safe"]',
    (node) => node.safeToDelete === true, 'keyboard');
  await page.keyboard.press('Escape');

  if (!viewport.mobile) {
    const duplicate = page.locator('[data-edge="duplicate"]');
    assert(!await duplicate.isChecked(), 'duplicate relationship filter must start unchecked');
    await duplicate.check({ timeout: 0 });
    const withDuplicate = new Set([...initialEdgeClasses, 'duplicate']);
    const expectedLines = expectedLineCount(graph, withDuplicate);
    const observedLines = await page.locator('#stage svg line').count();
    assert(observedLines === expectedLines,
      `duplicate filter drew ${observedLines} edges, expected ${expectedLines}`);
    observation.edgeFilter = { initial: observedInitialLines, duplicateEnabled: observedLines, expected: expectedLines };
    observation.screenshots.push(await screenshot(page,
      path.join(out, 'graph-desktop-duplicates-enabled.png')));

    const first = page.locator('circle.node').first();
    await first.focus({ timeout: 0 });
    const before = Number(await first.getAttribute('data-node-index'));
    await page.keyboard.press('ArrowRight');
    const after = await page.locator('circle.node:focus').getAttribute('data-node-index');
    assert(after !== null && Number(after) !== before, 'ArrowRight did not move graph keyboard focus');
    await page.keyboard.press('Enter');
    const focused = page.locator(`circle.node[data-node-index="${after}"]`);
    assert(await focused.getAttribute('aria-pressed') === 'true', 'Enter did not pin focused node');
    const detail = await page.locator('#detail').textContent();
    const selected = graph.nodes[Number(after)];
    assert(detail?.startsWith(`${selected.id}\n`), 'selection detail does not begin with exact node id');
    const relationCount = graph.edges.filter((edge) =>
      edge.source === selected.id || edge.target === selected.id).length;
    assert(detail.includes(`edges (${relationCount})`), 'selection detail edge count differs from graph JSON');
    observation.keyboard = { before, after: Number(after), selected: selected.id, relationCount };

    const hostileIndex = graph.nodes.findIndex((node) => node.id === oracle.expected.hostile.id);
    const hostile = page.locator(`circle.node[data-node-index="${hostileIndex}"]`);
    await hostile.focus({ timeout: 0 });
    await page.keyboard.press('Enter');
    const hostileDetail = await page.locator('#detail').textContent();
    assert(hostileDetail?.startsWith(`${oracle.expected.hostile.id}\n`),
      'hostile node detail did not preserve exact inert text');
    const hostileTitle = await hostile.locator('title').textContent();
    assert(hostileTitle?.includes(oracle.expected.hostile.id), 'hostile SVG title lost the exact id');
    const injection = await page.evaluate(() => ({
      images: document.querySelectorAll('img').length,
      rogueScripts: document.querySelectorAll('script[src]').length,
      markerType: typeof globalThis.HOLT_XSS,
    }));
    assert(injection.images === 0 && injection.rogueScripts === 0 && injection.markerType === 'undefined',
      `hostile graph data created executable markup: ${JSON.stringify(injection)}`);
    observation.hostileDom = injection;
    observation.screenshots.push(await screenshot(page,
      path.join(out, 'graph-desktop-keyboard-detail.png')));
  }

  assertNoBrowserErrors(observation);
  await context.close();
  return observation;
}

export async function proveGraphBrowser({ htmlPath, graph, oracle, out }) {
  const { chromium } = await import('playwright');
  const executablePath = await browserExecutable(chromium);
  const browser = await chromium.launch({ executablePath, headless: true, timeout: 0 });
  const version = browser.version();
  const contexts = [];
  try {
    for (const viewport of VIEWPORTS) {
      contexts.push(await exerciseContext({ browser, htmlPath, graph, oracle, out, viewport }));
    }
  } finally {
    await browser.close();
  }
  return {
    valid: true,
    playwrightIsolation: 'one fresh BrowserContext per viewport',
    browser: { executable: await captureFile(executablePath), version },
    contexts,
  };
}
