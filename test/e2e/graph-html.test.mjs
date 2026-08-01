// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — `graph --html` must not be injectable.
 *
 * THIS FILE EXISTS BECAUSE THE ONE COMMAND THAT WRITES A FILE FOR A BROWSER HAD NO TEST AT ALL.
 *
 * `renderHtml` interpolated the whole report into a <script> block with `JSON.stringify`, which
 * leaves `<`, `>` and `&` literal. A worktree path or branch name containing `</script>` closed
 * the block and everything after it was parsed as markup — and holt is pointed at repositories
 * whose branches were named by agents and by pull requests, so that is reachable input, not a
 * theoretical one. Reproduced before the fix: a repo with a worktree at `.../wt/evil</script>x`
 * on branch `x</script><svg/onload=alert(1)>` produced a document with THREE raw `</script>`
 * tokens in the script block and a live `<svg/onload=...>` element.
 *
 * The assertions below are deliberately about the DOCUMENT'S STRUCTURE, never about a token:
 * a fix that special-cased the string `</script>` would pass a `</script>` test and still ship
 * the hole. What is asserted is that no repository-controlled byte can START markup in any of
 * the three sinks — the markup, the script block, and the SVG the page builds at runtime — and,
 * as the anti-vacuity half, that the data still ARRIVES intact after being made inert.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderHtml } from '../../src/graph-html.mjs';
import { inspect } from '../../src/index.mjs';
import { newRepo, standardFixture, creatableComponent } from '../fixtures.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'holt.mjs');

/**
 * One hostile alphabet, used for every field. Each character is here for a different sink:
 *   </script>            closes the script block
 *   <svg/onload= , <img  starts an element once the block is closed
 *   " and '              closes an attribute value
 *   \u202E               right-to-left override: reverses the DISPLAYED spelling of the name a
 *                        human is about to decide whether to delete (CVE-2021-42574)
 *   \u2028               a literal line terminator in JS source, invisible in HTML
 *   &                    starts an entity, so a naive "escape < and > only" fix is caught
 */
const RLO = String.fromCharCode(0x202E);   // right-to-left override
const LS = String.fromCharCode(0x2028);    // line separator
const PAYLOAD =
  `</script><svg/onload=HOLT_XSS()>"'&<img src=x onerror=HOLT_XSS()>${RLO}gnp.js${LS}`;

/**
 * The tags `renderHtml` itself writes. Nothing else may exist in the output — that is the whole
 * property, stated once. Banning substrings ("onerror=", "<svg") would be the wrong assertion:
 * those are harmless as TEXT and must be allowed to appear, escaped, in a workstream's name.
 * What must never happen is a tag nobody wrote.
 */
// The complete set of element names the TEMPLATE itself contains. Anything else in the document
// was put there by data, which is the definition of the defect this file exists to catch. Adding
// a control to the page means adding it here deliberately — the allowlist is the review step.
const TEMPLATE_TAGS = new Set([
  '!doctype', 'html', 'head', 'meta', 'title', 'style', 'body', 'header',
  'h1', 'h2', 'span', 'div', 'aside', 'b', 'i', 'script',
  // the interactive controls: search box, edge-type filters and their labels
  'input', 'label',
]);

/** Control and format characters, minus the three (tab, LF, CR) that legitimately lay out
 *  the document. Stated as Unicode classes so a newly assigned bidi character is covered the
 *  day it exists, rather than the day someone remembers to extend a list of ranges. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const LAYOUT = new Set([9, 10, 13]);
const invisibleIn = (text) =>
  [...(text.match(INVISIBLE) || [])].filter((ch) => !LAYOUT.has(ch.codePointAt(0)));

function scriptBody(html) {
  const open = html.indexOf('<script>');
  assert.ok(open >= 0, 'the document has no <script> block — the test is reading the wrong thing');
  return html.slice(open + '<script>'.length);
}

/** The single structural invariant: the script block ends exactly once, where we put it. */
function assertScriptBlockIntact(html) {
  const closes = (scriptBody(html).match(/<\/script/gi) || []).length;
  assert.equal(closes, 1,
    `the <script> block is closed ${closes} time(s); anything but 1 means repository data ` +
    `broke out of it and the rest of the document is attacker-authored markup`);
}

/** No element exists in the document that the renderer did not write. */
function assertNoInjectedTags(html) {
  // The script block is JS, not markup — `i < nodes.length` is not a tag. Check the rest.
  const markup = html.slice(0, html.indexOf('<script>')) +
                 html.slice(html.lastIndexOf('</script>'));
  const tags = [...markup.matchAll(/<\/?([a-zA-Z!][a-zA-Z0-9-]*)/g)].map((m) => m[1].toLowerCase());
  const rogue = [...new Set(tags)].filter((t) => !TEMPLATE_TAGS.has(t));
  assert.deepEqual(rogue, [],
    `element(s) the renderer never writes appear in the document: ${rogue.join(', ')}`);
}

/** The serialised payload must be incapable of starting markup or hiding a control character. */
function assertPayloadInert(html) {
  const raw = dataLiteral(html);
  for (const ch of ['<', '>', '&']) {
    assert.ok(!raw.includes(ch),
      `the DATA literal contains a raw '${ch}' — it can start a tag or an entity inside <script>`);
  }
  const hidden = invisibleIn(html);
  assert.deepEqual(hidden, [],
    `invisible or bidirectional control character(s) survived into the document: ` +
    hidden.map((ch) => 'U+' + ch.codePointAt(0).toString(16).toUpperCase()).join(' '));
}

function dataLiteral(html) {
  const body = scriptBody(html);
  const start = body.indexOf('const DATA = ') + 'const DATA = '.length;
  const end = body.indexOf(';\n', start);
  assert.ok(start > 12 && end > start, 'could not find the DATA payload — pattern drift');
  return body.slice(start, end);
}

/** Pull `const DATA = <json>;` back out and parse it. */
const parseData = (html) => JSON.parse(dataLiteral(html));

/* ------------------------------------------------------------------ the fixture ---- */

/**
 * A real repository whose worktree PATH, DIRECTORY NAME and BRANCH NAME are all hostile.
 * `/` is legal in a git ref and legal as a path separator, so `</script>` genuinely reaches
 * the report through both — it is not something the test had to hand-inject.
 */
async function hostileRepo() {
  const fx = await newRepo('htmlinj');
  const wtRoot = path.join(fx.root, '..', 'wt');
  await fs.mkdir(wtRoot, { recursive: true });

  // EVERYTHING GIT NAMES IS BACKED BY A FILE, INCLUDING REFS.
  //
  // The first version of this comment claimed a branch name could carry the full payload on every
  // platform because "a ref is not a path component". CI corrected it: git stores a loose ref AS A
  // FILE, so `refs/heads/agent/</script><svg...>` needs a directory named `</script><svg` and
  // Windows refuses to create it —
  //   fatal: cannot lock ref ... unable to create directory for .git/refs/heads/...
  //
  // So BOTH the directory and the branch are trimmed to what this platform can represent, and the
  // parts Windows cannot hold are carried where the filesystem has no say: inside file CONTENT,
  // which is where the RLO and the script-closing payload land as symbol and path text in the
  // report. The property under test — no element exists in the document that the renderer did not
  // write — is asserted identically on every platform; only the delivery vehicle differs.
  const viaPath = path.join(wtRoot, creatableComponent(['evil', '</script>', 'x']) || 'evil-x');
  await fs.mkdir(path.dirname(viaPath), { recursive: true });
  await fx.git(['worktree', 'add', '-q', '-b',
    `agent/${creatableComponent(['</script>', '<svg/onload=HOLT_XSS()>']) || 'plain'}`, viaPath, 'main']);
  // File CONTENT is where the untrimmable payload rides on every platform: a filesystem has no
  // opinion about bytes inside a file, so the script-closing sequence and the bidi override reach
  // the renderer here even where they cannot appear in a name.
  await fs.writeFile(path.join(viaPath, 'only.js'),
    `export function HOSTILE_PATH_ONLY() {}\n// ${PAYLOAD}\n`);

  // Quotes, angle brackets and a right-to-left override in a single directory component.
  const viaName = path.join(wtRoot,
    creatableComponent(['a', '"', '><img src=x onerror=HOLT_XSS()>', RLO, 'gnp.js']) || `a${RLO}gnp.js`);
  await fx.git(['worktree', 'add', '-q', '-b',
    `agent/${creatableComponent(['quoted', '"', 'name']) || 'quotedname'}`, viaName, 'main']);
  await fs.writeFile(path.join(viaName, 'other.js'), 'export function HOSTILE_NAME_ONLY() {}\n');

  return fx;
}

/** Append the payload to EVERY string leaf. Covers fields a fixture cannot naturally poison. */
function poison(value) {
  if (typeof value === 'string') return value + PAYLOAD;
  if (Array.isArray(value)) return value.map(poison);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, poison(v)]));
  }
  return value;
}

/* ------------------------------------------------------------------- the tests ---- */

test('HTML INJECTION: a hostile worktree path and branch name cannot break out of the document', async (t) => {
  const fx = await hostileRepo();
  t.after(() => fx.cleanup());

  const report = await inspect(fx.root, {});
  const html = renderHtml(report);

  assertScriptBlockIntact(html);
  assertNoInjectedTags(html);
  assertPayloadInert(html);

  // ANTI-VACUITY. Escaping everything to nothing would pass every assertion above. The hostile
  // names must still ARRIVE — inert, but present and identifiable — or the graph is a blank page.
  const data = parseData(html);
  const ids = data.nodes.map((n) => n.id).join('\n');
  const paths = data.nodes.map((n) => n.path).join('\n');
  const branches = data.nodes.map((n) => n.branch).join('\n');
  assert.equal(data.nodes.length, 2, `expected both hostile worktrees in the payload, got ${data.nodes.length}`);
  assert.match(paths, /script>x/, 'the hostile path did not survive into the payload');
  assert.match(branches, /onload=HOLT_XSS\(\)>/, 'the hostile branch did not survive into the payload');
  assert.match(ids, /img src=x/, 'the hostile directory name did not survive into the payload');

  // The override is neutralised rather than passed through: it carries no glyph, so no encoding
  // for any sink can make it visible, and it silently reverses the name a human is reading.
  assert.ok(!JSON.stringify(data).includes(RLO), 'a right-to-left override survived into the page');
  assert.match(ids, /<U\+202E>/, 'the override was dropped silently instead of being shown');
});

test('HTML INJECTION: EVERY string in the report is inert, not just the ones a fixture produces', async (t) => {
  const fx = await hostileRepo();
  t.after(() => fx.cleanup());

  // family, verdict, collision `why`, shared symbol and file lists, backend label, base ref —
  // every one of them reaches the document, and a fixture cannot naturally make all of them
  // hostile. Poisoning the report itself asserts the CLASS: no string field is a special case.
  const html = renderHtml(poison(await inspect(fx.root, {})));

  assertScriptBlockIntact(html);
  assertNoInjectedTags(html);
  assertPayloadInert(html);
  assert.ok(!/<\/script/i.test(html.slice(html.indexOf('<body>'), html.indexOf('<script>'))),
    'poisoned data closed a tag inside the markup half of the document');
  assert.ok(parseData(html).nodes.length > 0, 'the poisoned payload no longer parses as JSON');
});

test('HTML INJECTION: the page builds its SVG as DOM, so a hostile id cannot become an element', async (t) => {
  const fx = await hostileRepo();
  t.after(() => fx.cleanup());

  const html = renderHtml(await inspect(fx.root, {}));

  // Run the page's OWN script against a minimal DOM. A file that is well-formed on disk can
  // still be injectable in the browser: the old renderer concatenated the workstream id into
  // `<title>` and assigned the result to innerHTML, so the id was parsed as markup at runtime.
  const created = [];
  const makeEl = (name) => {
    const el = {
      tagName: name, attrs: {}, children: [], text: '',
      setAttribute(k, v) { this.attrs[k] = String(v); },
      appendChild(c) { this.children.push(c); return c; },
      replaceChildren(...c) { this.children = c; },
      addEventListener() {},
      // The page is interactive now: it pans, zooms, drags and traces. These are the DOM
      // surfaces that requires. They are modelled rather than stubbed away for the same reason
      // innerHTML is below — a shim that silently swallowed a call would let the page take a
      // path this test never observes, and the whole point is to run the REAL script.
      removeEventListener() {},
      setPointerCapture() {},
      getBoundingClientRect() { return { left: 0, top: 0, width: 1000, height: 700 }; },
      classList: { add() {}, remove() {} },
      set textContent(v) { this.text = String(v); this.children.length = 0; },
      get textContent() { return this.text; },
      // innerHTML is modelled deliberately, not stubbed away. It is the sink the old renderer
      // used, and a shim that quietly ignored it would report "no rogue elements" for a page
      // that in a real browser builds them — an instrument that cannot see the defect it is
      // pointed at. Assigning markup here therefore creates whatever tags the markup names.
      set innerHTML(v) {
        this.children = [];
        for (const m of String(v).matchAll(/<\s*([a-zA-Z][a-zA-Z0-9-]*)/g)) {
          this.children.push(makeEl(m[1].toLowerCase()));
        }
      },
      get dataset() { return { i: this.attrs['data-i'] }; },
      get clientWidth() { return 1000; },
      get clientHeight() { return 700; },
      querySelectorAll(sel) {
        const out = [];
        const walk = (n) => { if (n.tagName === sel) out.push(n); n.children.forEach(walk); };
        this.children.forEach(walk);
        return out;
      },
    };
    created.push(el);
    return el;
  };
  const stage = makeEl('div');
  const detail = makeEl('div');
  const search = makeEl('input');
  const hint = makeEl('div');
  const document = {
    createElementNS: (_ns, name) => makeEl(name),
    getElementById: (id) => (id === 'stage' ? stage : id === 'search' ? search : id === 'hint' ? hint : detail),
    // The filter checkboxes and the clickable counts. Returning an empty list is right: this
    // test is about what the page BUILDS from repository data, and those controls are static
    // template markup already covered by the tag allowlist above.
    querySelectorAll: () => [],
    get activeElement() { return null; },
  };

  const body = scriptBody(html);
  const src = body.slice(0, body.lastIndexOf('</script>'));
  // A syntax error here is itself a finding: it means the escaping corrupted the script.
  // Only what the PAGE builds counts. stage/detail/search/hint are this harness's own stand-ins
  // for elements that exist in the static template, and leaving them in the record would let a
  // genuinely injected element of the same name hide behind one of them.
  created.length = 0;

  // requestAnimationFrame is driven for a BOUNDED number of frames rather than stubbed to a
  // no-op: the page now lays out inside the animation loop, so a no-op would mean nothing is
  // ever drawn and every assertion below would pass against an empty document.
  let frames = 0;
  const raf = (fn) => { if (frames++ < 3) fn(); return frames; };
  const run = new Function('document', 'addEventListener', 'setTimeout', 'clearTimeout',
    'requestAnimationFrame', 'Math', src);
  run(document, () => {}, () => 0, () => {}, raf, Math);

  // Only the tags the renderer is allowed to build may exist. An injected element would appear
  // here as a tag name nobody wrote — which is the general statement of the defect.
  const ALLOWED = new Set(['div', 'svg', 'g', 'line', 'circle', 'title', 'text']);
  const rogue = created.filter((e) => !ALLOWED.has(e.tagName));
  assert.deepEqual(rogue.map((e) => e.tagName), [],
    `the page built element(s) no renderer code creates: ${rogue.map((e) => e.tagName).join(', ')}`);

  // Anti-vacuity: it must have built the graph, and the hostile id must be present AS TEXT.
  const circles = created.filter((e) => e.tagName === 'circle');
  assert.ok(circles.length >= 2,
    `expected at least 2 circles, got ${circles.length} — the page rendered nothing, so nothing below is being tested`);
  const texts = created.filter((e) => e.tagName === 'title' || e.tagName === 'text').map((e) => e.text);
  assert.ok(texts.some((t2) => /img src=x/.test(t2)),
    'the hostile id never reached the page as text — the assertion above proved nothing');
  for (const el of created) {
    for (const v of Object.values(el.attrs)) {
      assert.ok(!/HOLT_XSS|<|>/.test(v), `repository data landed in an attribute: ${v}`);
    }
  }
});

test('HTML INJECTION: the shipped command, not just the function', async (t) => {
  const fx = await hostileRepo();
  t.after(() => fx.cleanup());
  const out = path.join(await fs.mkdtemp(path.join(process.env.HOLT_TMPDIR || os.tmpdir(), 'holt-html-')), 'g.html');

  const code = await new Promise((resolve) => {
    execFile(process.execPath, [BIN, 'graph', '--html', out], {
      cwd: fx.root, timeout: 180_000, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1' },
    }, (err) => resolve(err ? (err.code ?? 1) : 0));
  });
  assert.equal(code, 0, 'holt graph --html did not exit 0 on a hostile repository');

  const html = await fs.readFile(out, 'utf8');
  assertScriptBlockIntact(html);
  assertNoInjectedTags(html);
  assertPayloadInert(html);
});

test('NEVER WORSE: ordinary names render byte-for-byte faithfully, unescaped and unmangled', async (t) => {
  // The negative control. The old renderer STRIPPED < > & out of visible labels to stay safe,
  // which silently renamed the workstream a human was reading; the new one must neither strip
  // nor entity-encode a name that was never dangerous, and the payload must round-trip exactly.
  const fx = await newRepo('htmlbenign');
  t.after(() => fx.cleanup());
  await fx.worktree('feature-login');
  const holds = await fx.worktree('feature-billing');
  await fs.writeFile(path.join(holds, 'b.js'), 'export function BENIGN_ONLY() {}\n');

  const report = await inspect(fx.root, {});
  const html = renderHtml(report);

  const data = parseData(html);
  assert.deepEqual(data.nodes, report.graph.nodes, 'a benign payload did not round-trip identically');
  assert.deepEqual(data.edges, report.graph.edges, 'a benign payload did not round-trip identically');

  const ids = data.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ['feature-billing', 'feature-login'],
    'ordinary worktree names came back altered');
  assert.match(html, /<title>holt — /, 'the document lost its title');
  assert.ok(html.includes(`>${report.counts.workstreams} workstreams`) ||
            html.includes(`/${report.counts.workstreams} workstreams`),
    'the header counts stopped rendering once they were routed through the escaper');
  assertScriptBlockIntact(html);
});


test('GRAPH LEGIBILITY: no label is drawn on top of another', async (t) => {
  // THE DEFECT THIS PINS, measured on holt's own repository: 29 nodes, and 4 of the labels were
  // drawn into each other so the dense centre could not be read at all.
  //
  // The first attempt widened the collision force to push nodes apart. That measured the wrong
  // quantity - circle separation was already 22px while the labels are 100-200px WIDE - and the
  // text kept overlapping. Separating nodes far enough for every name to fit would turn any real
  // graph into a sparse sprawl, so the layout stays tight and a label that does not fit is
  // DROPPED instead of drawn into its neighbour. Dropped labels keep their tooltip and return on
  // hover or zoom, so nothing is lost.
  //
  // This runs the emitted page's OWN script, because the property is a product of the layout at
  // runtime and cannot be read off the source.
  // A DENSE fixture, deliberately. The first version of this test used the standard 7-worktree
  // fixture and PASSED WITH THE DEFECT DELIBERATELY REINSTATED - at that density every label fits
  // however it is placed, so the test asserted nothing. The real complaint came from a 29-node
  // graph with long worktree names, so the fixture reproduces that: enough nodes, and names long
  // enough, that a placer which draws everything unconditionally MUST collide.
  const fx = await newRepo('graph-dense');
  t.after(() => fx.cleanup());
  const NAMES = [
    'feat-audit-chain-receipts', 'feat-forensics-attribution', 'feat-policy-base-authority',
    'feat-supply-chain-evidence', 'fix-ci-base-policy-shallow', 'fix-file-granular-guard',
    'fix-html-escape-release', 'fix-rescue-gate-parity', 'fix-team-layer-defects',
    'fix-verify-verdict-booleans', 'rev-supply-chain-review', 'reviewer-audit-pass',
    'reviewer-forensics-pass', 'rvw-buyer-policy-check', 'vfy-cigate-baseline',
    'vfy-fileguard-revert', 'vfy-fleet-counting', 'wf-team-layer-run',
    'wt-buyer-review-policy', 'wt-policy-authority-x', 'wt-rescue-gate-fix',
    'wt-supply-chain-evidence', 'wt-verify-verdict-run', 'wt-htmlescape-check',
  ];
  for (const name of NAMES) {
    await fx.worktree(name);
    await fx.write('src/' + name.replace(/-/g, '_') + '.js',
      'export function ' + name.replace(/-/g, '_') + '() { return 1; }\n', fx.wt(name));
  }
  const html = renderHtml(await inspect(fx.root, {}));
  const expectedNodes = NAMES.length;

  const W = 1400, H = 850;
  const created = [];
  const makeEl = (name) => {
    const el = {
      tagName: name, attrs: {}, children: [], text: '',
      setAttribute(k, v) { this.attrs[k] = String(v); },
      appendChild(c) { this.children.push(c); return c; },
      replaceChildren(...c) { this.children = c; },
      addEventListener() {}, removeEventListener() {}, setPointerCapture() {},
      getBoundingClientRect() { return { left: 0, top: 0, width: W, height: H }; },
      classList: { add() {}, remove() {} },
      set textContent(v) { this.text = String(v); },
      get textContent() { return this.text; },
      get dataset() { return {}; },
      get clientWidth() { return W; },
      get clientHeight() { return H; },
      querySelectorAll() { return []; },
    };
    created.push(el);
    return el;
  };
  const stage = makeEl('div');
  const document = {
    createElementNS: (_n, name) => makeEl(name),
    getElementById: (id) => (id === 'stage' ? stage : makeEl('div')),
    querySelectorAll: () => [],
    get activeElement() { return null; },
  };
  let frames = 0;
  const raf = (fn) => { if (frames++ < 600) fn(); return frames; };
  const body = scriptBody(html);
  const src = body.slice(0, body.lastIndexOf('</script>'));
  new Function('document', 'addEventListener', 'setTimeout', 'clearTimeout',
    'requestAnimationFrame', 'Math', src)(document, () => {}, () => 0, () => {}, raf, Math);

  const svg = stage.children[stage.children.length - 2] ?? stage.children[0];
  const g = svg.children.find((c) => c.tagName === 'g') ?? svg;
  const circles = g.children.filter((c) => c.tagName === 'circle');
  const labels = g.children.filter((c) => c.tagName === 'text');

  // ANTI-VACUITY. Drawing NO labels would satisfy "nothing overlaps" perfectly, so the graph must
  // be shown to have rendered and to still be naming most of what it drew.
  assert.ok(circles.length >= expectedNodes,
    `the page rendered ${circles.length} nodes - nothing below is being tested`);
  assert.ok(labels.length >= Math.ceil(circles.length * 0.6),
    `only ${labels.length} of ${circles.length} nodes kept a label - the placer is dropping too much`);

  const boxes = labels.map((t2) => {
    const fs = +(t2.attrs['font-size'] || 10);
    const w = String(t2.text).length * fs * 0.58, h = fs * 1.25;
    const x = +t2.attrs.x, y = +t2.attrs.y;
    return { x0: x - w / 2, x1: x + w / 2, y0: y - h, y1: y, label: t2.text };
  });

  const clashes = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1) {
        clashes.push(`${a.label} <-> ${b.label}`);
      }
    }
  }
  assert.deepEqual(clashes, [],
    `these labels are drawn on top of each other, which is what made the graph unreadable:\n  ${clashes.join('\n  ')}`);
});
