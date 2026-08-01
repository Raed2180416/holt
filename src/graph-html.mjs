import path from 'node:path';
// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — self-contained HTML graph.
 *
 * DELIBERATELY ZERO-DEPENDENCY. Cytoscape.js is the right choice for a hosted dashboard and
 * is where this should go if holt ever grows one — it brings graph algorithms, not just
 * rendering. For a CLI's `--html` export it would be the wrong trade: the output must open
 * from a file:// path on a laptop with no network, inside corporate CSP, months after it was
 * written. A CDN <script> fails all three. So the layout here is a small force simulation
 * emitting plain SVG, and the file has no external references of any kind.
 */

/*
 * ---------------------------------------------------------------- trust boundary ----
 *
 * EVERY string in this file is attacker-controlled. holt is pointed at repositories whose
 * worktree directories, branch names, file paths and symbol names were written by agents and
 * by pull requests, and its output is a file a human opens in a browser. `graph --html` used
 * to interpolate all of it raw into a <script> block, so a branch named `x</script>...` closed
 * the block and everything after it became markup.
 *
 * The rule is NOT "look for </script>". It is: a value is encoded for the SINK it lands in,
 * and there are exactly three sinks in this document —
 *
 *   markup text and attributes   ->  HTML entities                       esc()
 *   the <script> body            ->  JSON with markup-starting chars \u  jsonForScript()
 *   the SVG the page builds      ->  DOM APIs, never string concat       svgEl()/textContent
 *
 * and one rule that runs BEFORE all three: invisible and bidirectional control characters are
 * neutralised at the boundary, because they are not markup and therefore no encoding for any
 * of the three sinks removes them.
 */

/**
 * Characters with no glyph, stated as the Unicode CLASSES they belong to rather than as a
 * hand-listed set of ranges — a list is a thing that goes stale as Unicode adds members.
 *   Cc  the C0/C1 controls
 *   Cf  the format characters, which is where the bidi overrides and isolates live: they
 *       reorder the text AROUND them at render time (the trojan-source attack,
 *       CVE-2021-42574), so a worktree can DISPLAY as a different worktree than the one
 *       a human is about to delete. No encoding for any sink can make them visible.
 *   Zl/Zp  U+2028 and U+2029, which are also literal line terminators in JS source.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** Tab, newline and carriage return: the only three that are legitimate here (a collision
 *  `why` string is multi-line) and inert in every sink. Named by code point so this stays a
 *  property of the characters rather than a list of blessed spellings. */
const PRINTABLE_CONTROLS = new Set([9, 10, 13]);

function neutralize(s) {
  return String(s ?? '').replace(INVISIBLE, (ch) => {
    const cp = ch.codePointAt(0);
    return PRINTABLE_CONTROLS.has(cp)
      ? ch
      : `<U+${cp.toString(16).toUpperCase().padStart(4, '0')}>`;
  });
}

/** Markup sink: text nodes and attribute values alike. Runs after neutralize, so the visible
 *  `<U+202E>` token it produces is itself entity-encoded rather than re-entering as markup. */
function esc(s) {
  return neutralize(s).replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/**
 * Script sink. JSON.stringify is NOT safe inside <script> and never was: it leaves `<`, `>`
 * and `&` literal, so any string carrying `</script` ends the block. Escaping those three as
 * \uXXXX makes it impossible for the serialised data to START a tag or an entity at all —
 * a property of the encoding rather than a blacklist of one dangerous token — while parsing
 * back to a byte-identical value. U+2028/U+2029 are escaped for the separate reason that they
 * are literal line terminators in JS source; neutralize() has already replaced them, and this
 * escape is the second, independent guard on the same character.
 */
function jsonForScript(value) {
  return JSON.stringify(value, (_key, v) => (typeof v === 'string' ? neutralize(v) : v))
    .replace(/[<>&\u2028\u2029]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * Last path segment, tolerant of EITHER separator. path.basename() only understands the host
 * platform's separator, so a Windows path rendered on any other platform (or vice versa) would
 * otherwise print in full as the page title.
 */
function repoName(p) {
  const segs = String(p ?? '').split(/[\\/]+/).filter(Boolean);
  return segs.length ? segs[segs.length - 1] : 'repository';
}

export function renderHtml(report) {
  const data = {
    nodes: report.graph.nodes,
    edges: report.graph.edges,
    families: report.graph.families,
    base: report.base,
    counts: report.counts,
    root: report.root,
    backend: report.backend,
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>holt — ${esc(repoName(report.root))}</title>
<style>
  :root {
    --bg:#0f1115; --panel:#171a21; --line:#252a35; --fg:#e6e9ef; --muted:#8b93a7;
    --risk:#ff5f56; --hold:#ffbd2e; --dup:#c678dd; --safe:#3fb950; --sibling:#2f3846;
    --overlap:#58a6ff; --accent:#e2a154;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg:#fbfcfd; --panel:#fff; --line:#e3e7ee; --fg:#1a1f2b; --muted:#66708a; --sibling:#d7dde8; }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); overflow:hidden;
    font:14px/1.5 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif; }
  header { padding:12px 18px; border-bottom:1px solid var(--line); display:flex;
    gap:18px; align-items:baseline; flex-wrap:wrap; }
  h1 { font-size:15px; margin:0; font-weight:650; letter-spacing:-.01em; }
  .meta { color:var(--muted); font-size:12px; font-family:ui-monospace,monospace; }
  .wrap { display:flex; height:calc(100vh - 50px); }
  #stage { flex:1; overflow:hidden; position:relative; cursor:grab; }
  #stage.panning { cursor:grabbing; }
  aside { width:340px; border-left:1px solid var(--line); background:var(--panel);
    overflow-y:auto; padding:14px; flex-shrink:0; }
  aside h2 { font-size:11px; text-transform:uppercase; letter-spacing:.07em;
    color:var(--muted); margin:18px 0 8px; font-weight:600; }
  aside h2:first-child { margin-top:0; }
  .row { display:flex; justify-content:space-between; gap:10px; padding:4px 0;
    font-size:12.5px; border-bottom:1px solid var(--line); }
  .row b { font-weight:600; font-variant-numeric:tabular-nums; }
  .row.clickable { cursor:pointer; }
  .row.clickable:hover { background:var(--line); }
  #search { width:100%; padding:7px 9px; background:var(--bg); color:var(--fg);
    border:1px solid var(--line); border-radius:6px; font-size:12.5px;
    font-family:ui-monospace,monospace; }
  #search:focus { outline:none; border-color:var(--accent); }
  .filters label { display:flex; align-items:center; gap:7px; font-size:12.5px;
    padding:3px 0; cursor:pointer; color:var(--muted); }
  .filters input { accent-color:var(--accent); cursor:pointer; }
  .swatch { display:inline-block; width:16px; height:0; border-top-width:2px;
    border-top-style:solid; }
  .legend { display:flex; gap:12px; flex-wrap:wrap; font-size:12px; color:var(--muted); }
  .legend i { display:inline-block; width:9px; height:9px; border-radius:50%; margin-right:5px; }
  #detail { font-family:ui-monospace,monospace; font-size:11.5px; color:var(--muted);
    white-space:pre-wrap; word-break:break-word; }
  #hint { position:absolute; left:12px; bottom:10px; font-size:11px; color:var(--muted);
    font-family:ui-monospace,monospace; pointer-events:none; opacity:.75; }
  circle.node { cursor:pointer; }
  svg { display:block; }
</style>
</head>
<body>
<header>
  <h1>holt</h1>
  <span class="meta">${esc(report.root)}</span>
  <span class="meta">base ${esc(report.base.ref)} @ ${esc(report.base.oid.slice(0, 8))}</span>
  <span class="meta">${esc(report.counts.scanned)}/${esc(report.counts.workstreams)} workstreams &middot; ${esc(report.counts.families)} families</span>
</header>
<div class="wrap">
  <div id="stage"><div id="hint">drag to pan &middot; scroll to zoom &middot; drag a node to pin it &middot; double-click to release &middot; / to search</div></div>
  <aside>
    <h2>Find</h2>
    <input id="search" type="search" placeholder="filter workstreams..." autocomplete="off" spellcheck="false">
    <h2>Decisions</h2>
    <div class="row clickable" data-focus="risk"><span>At risk (uncommitted only)</span><b style="color:var(--risk)">${esc(report.counts.atRisk)}</b></div>
    <div class="row"><span>Collisions</span><b style="color:var(--risk)">${esc(report.counts.collisions)}</b></div>
    <div class="row"><span>Duplicate pairs</span><b style="color:var(--dup)">${esc(report.counts.duplicatePairs)}</b></div>
    <div class="row clickable" data-focus="safe"><span>Disposable</span><b style="color:var(--safe)">${esc(report.counts.safeToDelete)}</b></div>
    <div class="row"><span>To review</span><b>${esc(report.plan.reviewReduction.toReview)}</b></div>
    <h2>Show relationships</h2>
    <div class="filters">
      <label><input type="checkbox" data-edge="proven" checked><span class="swatch" style="border-color:var(--risk)"></span>proven conflict</label>
      <label><input type="checkbox" data-edge="semantic-overlap" checked><span class="swatch" style="border-color:var(--overlap)"></span>same symbol, merges clean</label>
      <label><input type="checkbox" data-edge="predicted" checked><span class="swatch" style="border-color:var(--hold)"></span>predicted conflict</label>
      <label><input type="checkbox" data-edge="duplicate"><span class="swatch" style="border-color:var(--dup);border-top-style:dashed"></span>duplicate work</label>
      <label><input type="checkbox" data-edge="sibling"><span class="swatch" style="border-color:var(--sibling)"></span>same family (name guess — dashed means no shared content found)</label>
    </div>
    <h2>Legend</h2>
    <div class="legend">
      <span><i style="background:var(--risk)"></i>at risk</span>
      <span><i style="background:var(--hold)"></i>unique committed</span>
      <span><i style="background:var(--safe)"></i>disposable</span>
      <span><i style="background:var(--muted)"></i>other</span>
    </div>
    <h2>Selection</h2>
    <div id="detail">Hover a node to trace it. Click to pin the details here.</div>
  </aside>
</div>
<script>
const DATA = ${jsonForScript(data)};

/*
 * WHY THIS IS A SIMULATION AND NOT A STATIC PICTURE.
 *
 * The first version ran a fixed 320-step cooling loop once and drew the result. On a real
 * repository that produced the failure this file exists to avoid: 29 nodes, 149 edges, every
 * edge drawn with equal weight, labels stacked on top of one another, and the whole centre an
 * undifferentiated hairball. It was visually TRUE and completely unusable, which is exactly the
 * criticism holt's own source makes of unfiltered collision output: "616 findings with 6 real
 * ones is strictly worse than 6, because the real ones become unreachable."
 *
 * Four things fix that, and each is here for one named reason:
 *
 *   a COLLIDE force        nodes had no radius awareness, so they overlapped and their labels
 *                          became illegible. This is the direct cause of the unreadable centre.
 *   HOVER-TRACE            with 149 edges you cannot follow one node's relationships by eye.
 *                          Highlighting a node's neighbours and dimming everything else turns a
 *                          hairball into an answer to "what does THIS one touch".
 *   EDGE FILTERS           duplicate edges dominate the count and are the least actionable. The
 *                          user decides what is drawn; duplicates and family edges start off.
 *   ZOOM / PAN / DRAG      29 nodes fit on a screen. 200 do not, and holt is built for 200.
 *
 * The force model is the standard velocity-Verlet arrangement popularised by d3-force (link,
 * many-body, centring, collision, with a decaying alpha) - implemented here directly rather than
 * vendored, because this file must open from a file:// path with no network, inside corporate
 * CSP, months after it was written, and a <script src> fails all three.
 */

const stage = document.getElementById('stage');
const detail = document.getElementById('detail');
const search = document.getElementById('search');
const hint = document.getElementById('hint');
const W = () => stage.clientWidth, H = () => stage.clientHeight;

const colorOf = n =>
  n.uncommittedOnly > 0 ? 'var(--risk)'
  : n.uniqueSymbols  > 0 ? 'var(--hold)'
  : n.safeToDelete       ? 'var(--safe)'
  : 'var(--muted)';

// An edge's CLASS is its collision kind where it has one, so the filters map onto the same
// vocabulary the CLI prints rather than a second, invented one.
const classOf = e => e.type === 'collision' ? (e.kind || 'predicted') : e.type;

const EDGE_STYLE = {
  proven:             { stroke:'var(--risk)',    w:1.8, o:.60, dash:'' },
  'semantic-overlap': { stroke:'var(--overlap)', w:1.3, o:.45, dash:'' },
  predicted:          { stroke:'var(--hold)',    w:1.3, o:.45, dash:'' },
  identical:          { stroke:'var(--dup)',     w:1.2, o:.35, dash:'2 3' },
  'proven-clean':     { stroke:'var(--sibling)', w:1,   o:.25, dash:'' },
  'co-located':       { stroke:'var(--sibling)', w:1,   o:.25, dash:'' },
  duplicate:          { stroke:'var(--dup)',     w:1.3, o:.40, dash:'4 3' },
  sibling:            { stroke:'var(--sibling)', w:1,   o:.30, dash:'' },
};
const styleOf = e => EDGE_STYLE[classOf(e)] || EDGE_STYLE.sibling;

const shown = new Set(['proven', 'semantic-overlap', 'predicted', 'identical']);
document.querySelectorAll('[data-edge]').forEach(box => {
  box.addEventListener('change', () => {
    const k = box.dataset.edge;
    if (box.checked) shown.add(k); else shown.delete(k);
    // Toggling changes which forces act, so the layout must be allowed to re-settle.
    alpha = Math.max(alpha, 0.4); kick();
  });
});

// Deterministic seed: reopening the same file lands in the same place, which matters when the
// export is attached to a review and two people are meant to be looking at the same picture.
let seed = 42;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

const nodes = DATA.nodes.map(n => ({
  ...n,
  x: rnd() * 700 + 150, y: rnd() * 420 + 90, vx: 0, vy: 0, fixed: false,
  r: Math.max(5, Math.min(20, 5 + Math.sqrt((n.addedSymbols || 0) + (n.committedFiles || 0)) * 2.1)),
}));
const index = new Map(nodes.map((n, i) => [n.id, i]));
const edges = DATA.edges
  .filter(e => index.has(e.source) && index.has(e.target))
  .map(e => ({ ...e, cls: classOf(e), s: index.get(e.source), t: index.get(e.target) }));

// Adjacency, for hover-trace. Built once - recomputing it per mousemove is what makes a graph
// of this size feel sluggish.
const neighbours = nodes.map(() => new Set());
edges.forEach(e => { neighbours[e.s].add(e.t); neighbours[e.t].add(e.s); });

const active = () => edges.filter(e => shown.has(e.cls));

/* ------------------------------------------------------------------ simulation ---- */

let alpha = 1;
const ALPHA_MIN = 0.005, ALPHA_DECAY = 0.018, VELOCITY_DECAY = 0.6;
const LINK_DIST = 150;

function step() {
  const many = nodes.length > 260;      // above this, sampled repulsion keeps it interactive
  const cx = W() / 2, cy = H() / 2;

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (many && ((i * 31 + j) % 3)) continue;
      const a = nodes[i], b = nodes[j];
      let dx = b.x - a.x, dy = b.y - a.y;
      let d2 = dx * dx + dy * dy || 0.01;
      if (d2 > 640000) continue;         // beyond ~800px the force is noise
      const d = Math.sqrt(d2);
      const rep = (LINK_DIST * LINK_DIST) / d2 * 0.55 * alpha;
      const ux = dx / d, uy = dy / d;
      a.vx -= ux * rep; a.vy -= uy * rep;
      b.vx += ux * rep; b.vy += uy * rep;
    }
  }

  // links - only the ones actually drawn, so hiding a class really does unclench the layout
  for (const e of active()) {
    const a = nodes[e.s], b = nodes[e.t];
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const strength = (e.cls === 'proven' ? 0.06 : e.cls === 'sibling' ? 0.05 : 0.03) * alpha;
    const f = (d - LINK_DIST) * strength;
    const ux = dx / d, uy = dy / d;
    a.vx += ux * f; a.vy += uy * f;
    b.vx -= ux * f; b.vy -= uy * f;
  }

  // COLLISION - the force whose absence made the labels unreadable. The radius includes room
  // for the label, so two nodes cannot settle close enough for their text to overlap.
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      const want = a.r + b.r + 26;
      let dx = b.x - a.x, dy = b.y - a.y;
      let d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      if (d >= want) continue;
      const push = (want - d) / d * 0.5;
      dx *= push; dy *= push;
      a.vx -= dx; a.vy -= dy;
      b.vx += dx; b.vy += dy;
    }
  }

  for (const n of nodes) {
    if (n.fixed) { n.vx = 0; n.vy = 0; continue; }
    n.vx += (cx - n.x) * 0.008 * alpha;
    n.vy += (cy - n.y) * 0.008 * alpha;
    n.vx *= VELOCITY_DECAY; n.vy *= VELOCITY_DECAY;
    n.x += Math.max(-30, Math.min(30, n.vx));
    n.y += Math.max(-30, Math.min(30, n.vy));
  }
  alpha = Math.max(0, alpha - ALPHA_DECAY * alpha);
}

/* --------------------------------------------------------------------- viewport ---- */

let tx = 0, ty = 0, scale = 1;
const toWorld = (px, py) => ({ x: (px - tx) / scale, y: (py - ty) / scale });

stage.addEventListener('wheel', ev => {
  ev.preventDefault();
  const rect = stage.getBoundingClientRect();
  const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
  const before = toWorld(mx, my);
  scale = Math.max(0.15, Math.min(6, scale * (ev.deltaY < 0 ? 1.12 : 1 / 1.12)));
  tx = mx - before.x * scale; ty = my - before.y * scale;
  draw();
}, { passive: false });

let dragNode = null, panning = false, last = null, moved = false;
let hovered = -1, pinned = -1;

stage.addEventListener('pointerdown', ev => {
  const rect = stage.getBoundingClientRect();
  const p = toWorld(ev.clientX - rect.left, ev.clientY - rect.top);
  moved = false;
  const hit = pick(p.x, p.y);
  if (hit !== -1) { dragNode = hit; nodes[hit].fixed = true; }
  else { panning = true; stage.classList.add('panning'); }
  last = { x: ev.clientX, y: ev.clientY };
  stage.setPointerCapture(ev.pointerId);
});

stage.addEventListener('pointermove', ev => {
  const rect = stage.getBoundingClientRect();
  const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
  if (dragNode !== null) {
    moved = true;
    const p = toWorld(mx, my);
    nodes[dragNode].x = p.x; nodes[dragNode].y = p.y;
    alpha = Math.max(alpha, 0.35); kick();
    return;
  }
  if (panning) {
    moved = true;
    tx += ev.clientX - last.x; ty += ev.clientY - last.y;
    last = { x: ev.clientX, y: ev.clientY };
    draw();
    return;
  }
  // HOVER-TRACE. The answer to "what does this one touch", which 149 undifferentiated edges
  // cannot give you.
  const p = toWorld(mx, my);
  const hit = pick(p.x, p.y);
  if (hit !== hovered) { hovered = hit; if (hit !== -1) describe(hit); draw(); }
});

const endPointer = () => {
  if (dragNode !== null && !moved) nodes[dragNode].fixed = false;  // a click is not a pin
  dragNode = null; panning = false; stage.classList.remove('panning');
};
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);
stage.addEventListener('dblclick', ev => {
  const rect = stage.getBoundingClientRect();
  const p = toWorld(ev.clientX - rect.left, ev.clientY - rect.top);
  const hit = pick(p.x, p.y);
  if (hit !== -1) { nodes[hit].fixed = false; alpha = Math.max(alpha, 0.3); kick(); }
});

stage.addEventListener('click', () => {
  if (moved) return;
  pinned = hovered;
  if (pinned !== -1) describe(pinned);
  draw();
});

function pick(x, y) {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    const dx = x - n.x, dy = y - n.y;
    if (dx * dx + dy * dy <= (n.r + 6) * (n.r + 6)) return i;
  }
  return -1;
}

/* ----------------------------------------------------------------------- search ---- */

let query = '';
search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); draw(); });
addEventListener('keydown', ev => {
  if (ev.key === '/' && document.activeElement !== search) { ev.preventDefault(); search.focus(); }
  if (ev.key === 'Escape') { search.value = ''; query = ''; pinned = -1; draw(); }
});
document.querySelectorAll('[data-focus]').forEach(row => {
  row.addEventListener('click', () => {
    // Clicking a count filters to the nodes it counted - the number becomes navigable rather
    // than decorative.
    query = row.dataset.focus === 'risk' ? 'risk' : 'safe';
    search.value = '';
    draw();
  });
});
const matches = n => {
  if (!query) return true;
  if (query === 'risk') return n.uncommittedOnly > 0;
  if (query === 'safe') return n.safeToDelete;
  return n.id.toLowerCase().includes(query);
};

/* -------------------------------------------------------------------- rendering ---- */

// DOM construction, never string concatenation. The page is the THIRD sink for
// repository-controlled text, and it used to build markup by concatenation and assign it to
// innerHTML - so a workstream id was parsed as markup inside the browser even when the file on
// disk was well-formed. createElementNS + textContent make that structurally impossible.
const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(name, attrs) {
  const node = document.createElementNS(SVG_NS, name);
  for (const key of Object.keys(attrs)) node.setAttribute(key, String(attrs[key]));
  return node;
}

function draw() {
  const focus = pinned !== -1 ? pinned : hovered;
  const near = focus === -1 ? null : neighbours[focus];
  const lit = i => focus === -1 ? matches(nodes[i]) : (i === focus || near.has(i));

  const svg = svgEl('svg', { width: W(), height: H(), viewBox: '0 0 ' + W() + ' ' + H() });
  const g = svgEl('g', { transform: 'translate(' + tx.toFixed(2) + ',' + ty.toFixed(2) + ') scale(' + scale.toFixed(3) + ')' });

  for (const e of active()) {
    const a = nodes[e.s], b = nodes[e.t], st = styleOf(e);
    const on = focus === -1 ? (matches(a) || matches(b)) : (e.s === focus || e.t === focus);
    const attrs = {
      x1: a.x.toFixed(1), y1: a.y.toFixed(1), x2: b.x.toFixed(1), y2: b.y.toFixed(1),
      stroke: st.stroke, 'stroke-width': st.w / Math.max(1, scale * 0.6),
      opacity: on ? st.o : st.o * 0.08,
    };
    // A sibling edge is a NAME match, not proof. Uncorroborated ones (no shared file or symbol
    // found anywhere in the scan) are drawn dashed so a naming guess never looks identical to a
    // relationship backed by actual content.
    const dash = e.type === 'sibling' && e.corroborated === false ? '2 4' : st.dash;
    if (dash) attrs['stroke-dasharray'] = dash;
    g.appendChild(svgEl('line', attrs));
  }

  // PASS 1 - circles. Drawn first so every label sits on top of every node.
  nodes.forEach((n, i) => {
    const on = lit(i);
    const circle = svgEl('circle', {
      class: 'node', cx: n.x.toFixed(1), cy: n.y.toFixed(1), r: n.r.toFixed(1),
      fill: colorOf(n), stroke: i === focus ? 'var(--fg)' : 'var(--bg)',
      'stroke-width': i === focus ? 2.5 : 1.5, opacity: on ? 1 : 0.12,
    });
    const tip = svgEl('title', {});
    tip.textContent = n.id;
    circle.appendChild(tip);
    g.appendChild(circle);
  });

  // PASS 2 - LABELS, PLACED GREEDILY. This is the fix for the thing that was actually wrong.
  //
  // The first attempt at this widened the collision force so nodes would sit further apart. That
  // was measuring the wrong quantity: circle separation was already 22px and the labels are
  // 100-200px WIDE, so the text kept overlapping no matter how far the circles were pushed. On
  // holt's own repository, 4 of 29 labels were illegible in the rendered output.
  //
  // Separating nodes far enough for every name to fit would turn any real graph into a sparse
  // sprawl, so the answer is the cartographic one: keep the layout tight and DROP a label that
  // does not fit, rather than drawing it into another. Importance decides who keeps theirs —
  // at-risk first, then the focused node and its neighbours, then size — so the labels that
  // survive a crowded view are the ones a reader needs. Everything dropped keeps its tooltip and
  // reappears on hover or on zoom, which is why nothing is lost by dropping it.
  const order = nodes.map((n, i) => i)
    .filter(i => lit(i) && (nodes[i].uncommittedOnly > 0 || i === focus || (near && near.has(i))
      || scale >= 1.2 || true))
    .sort((a, b) => {
      const rank = j => (j === focus ? 0 : (near && near.has(j)) ? 1 : nodes[j].uncommittedOnly > 0 ? 2 : 3);
      return rank(a) - rank(b) || nodes[b].r - nodes[a].r;
    });

  const placed = [];
  const FONT = 10 / Math.max(0.7, Math.min(2, scale));
  for (const i of order) {
    const n = nodes[i];
    const text = n.id.length > 28 ? n.id.slice(0, 27) + '…' : n.id;
    const w = text.length * FONT * 0.58, h = FONT * 1.25;
    const x = n.x, y = n.y + n.r + FONT + 1;
    const box = { x0: x - w / 2, x1: x + w / 2, y0: y - h, y1: y };
    // A label the reader has explicitly asked for is never dropped; anything else yields.
    const mustShow = i === focus || (near && near.has(i));
    const clash = placed.some(b => box.x0 < b.x1 && b.x0 < box.x1 && box.y0 < b.y1 && b.y0 < box.y1);
    if (clash && !mustShow) continue;
    placed.push(box);
    const label = svgEl('text', {
      x: x.toFixed(1), y: y.toFixed(1), 'text-anchor': 'middle',
      'font-size': FONT.toFixed(2),
      fill: i === focus ? 'var(--fg)' : 'var(--muted)',
      'paint-order': 'stroke', stroke: 'var(--bg)', 'stroke-width': 3, 'stroke-linejoin': 'round',
    });
    label.textContent = text;
    g.appendChild(label);
  }

  svg.appendChild(g);
  stage.replaceChildren(svg);
  stage.appendChild(hint);
}

function describe(i) {
  const n = nodes[i];
  const rel = DATA.edges.filter(e => e.source === n.id || e.target === n.id);
  detail.textContent =
    n.id + '\\n' +
    '─'.repeat(Math.min(34, n.id.length)) + '\\n' +
    'family      ' + n.family + '\\n' +
    'head        ' + (n.head || '—') + '\\n' +
    'branch      ' + (n.branch || '(detached)') + '\\n' +
    'verdict     ' + n.verdict + '\\n\\n' +
    'committed   ' + n.committedFiles + ' file(s) base lacks\\n' +
    'uncommitted ' + n.uncommittedFiles + ' file(s)\\n' +
    'added       ' + n.addedSymbols + ' symbol(s)\\n' +
    'unique      ' + n.uniqueSymbols + ' symbol(s)\\n' +
    'at risk     ' + n.uncommittedOnly + ' uncommitted-only\\n' +
    'disposable  ' + (n.safeToDelete ? 'yes' : 'no') + '\\n\\n' +
    'edges (' + rel.length + ')\\n' +
    rel.slice(0, 14).map(e =>
      '  ' + String(e.kind || e.type).padEnd(18) + (e.source === n.id ? e.target : e.source) +
      (e.type === 'sibling' && e.corroborated === false ? '  [name guess — no shared content]' : '') +
      (e.why ? '\\n     ' + e.why : '')).join('\\n');
}

/* ------------------------------------------------------------------------- loop ---- */

let running = false;
function kick() {
  if (running) return;
  running = true;
  requestAnimationFrame(function frame() {
    step();
    draw();
    if (alpha > ALPHA_MIN) requestAnimationFrame(frame);
    else running = false;
  });
}

kick();
let t; addEventListener('resize', () => {
  clearTimeout(t);
  t = setTimeout(() => { alpha = Math.max(alpha, 0.3); kick(); }, 160);
});
</script>
</body>
</html>`;
}
