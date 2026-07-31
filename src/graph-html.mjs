/**
 * grove — self-contained HTML graph.
 *
 * DELIBERATELY ZERO-DEPENDENCY. Cytoscape.js is the right choice for a hosted dashboard and
 * is where this should go if grove ever grows one — it brings graph algorithms, not just
 * rendering. For a CLI's `--html` export it would be the wrong trade: the output must open
 * from a file:// path on a laptop with no network, inside corporate CSP, months after it was
 * written. A CDN <script> fails all three. So the layout here is a small force simulation
 * emitting plain SVG, and the file has no external references of any kind.
 */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
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
<title>grove — ${esc(report.root.split('/').pop() || 'repository')}</title>
<style>
  :root {
    --bg:#0f1115; --panel:#171a21; --line:#252a35; --fg:#e6e9ef; --muted:#8b93a7;
    --risk:#ff5f56; --hold:#ffbd2e; --dup:#c678dd; --safe:#3fb950; --sibling:#2f3846;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg:#fbfcfd; --panel:#fff; --line:#e3e7ee; --fg:#1a1f2b; --muted:#66708a; --sibling:#d7dde8; }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
    font:14px/1.5 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif; }
  header { padding:16px 20px; border-bottom:1px solid var(--line); display:flex;
    gap:24px; align-items:baseline; flex-wrap:wrap; }
  h1 { font-size:15px; margin:0; font-weight:650; letter-spacing:-.01em; }
  .meta { color:var(--muted); font-size:12px; font-family:ui-monospace,monospace; }
  .wrap { display:flex; height:calc(100vh - 58px); }
  #stage { flex:1; overflow:hidden; position:relative; }
  aside { width:330px; border-left:1px solid var(--line); background:var(--panel);
    overflow-y:auto; padding:16px; }
  aside h2 { font-size:11px; text-transform:uppercase; letter-spacing:.07em;
    color:var(--muted); margin:20px 0 8px; font-weight:600; }
  aside h2:first-child { margin-top:0; }
  .row { display:flex; justify-content:space-between; gap:10px; padding:4px 0;
    font-size:12.5px; border-bottom:1px solid var(--line); }
  .row b { font-weight:600; font-variant-numeric:tabular-nums; }
  .legend { display:flex; gap:14px; flex-wrap:wrap; font-size:12px; color:var(--muted); }
  .legend i { display:inline-block; width:9px; height:9px; border-radius:50%; margin-right:5px; }
  #detail { font-family:ui-monospace,monospace; font-size:11.5px; color:var(--muted);
    white-space:pre-wrap; word-break:break-word; }
  circle { cursor:pointer; }
  circle:hover { stroke:var(--fg) !important; stroke-width:2.5px !important; }
  text { pointer-events:none; font-size:9px; fill:var(--muted);
    font-family:ui-monospace,monospace; }
  svg { display:block; }
</style>
</head>
<body>
<header>
  <h1>grove</h1>
  <span class="meta">${esc(report.root)}</span>
  <span class="meta">base ${esc(report.base.ref)} @ ${esc(report.base.oid.slice(0, 8))}</span>
  <span class="meta">${report.counts.scanned}/${report.counts.workstreams} workstreams · ${report.counts.families} families</span>
</header>
<div class="wrap">
  <div id="stage"></div>
  <aside>
    <h2>Decisions</h2>
    <div class="row"><span>At risk (uncommitted only)</span><b style="color:var(--risk)">${report.counts.atRisk}</b></div>
    <div class="row"><span>Collisions</span><b style="color:var(--risk)">${report.counts.collisions}</b></div>
    <div class="row"><span>Duplicate pairs</span><b style="color:var(--dup)">${report.counts.duplicatePairs}</b></div>
    <div class="row"><span>Disposable</span><b style="color:var(--safe)">${report.counts.safeToDelete}</b></div>
    <div class="row"><span>To review</span><b>${report.plan.reviewReduction.toReview}</b></div>
    <h2>Legend</h2>
    <div class="legend">
      <span><i style="background:var(--risk)"></i>at risk</span>
      <span><i style="background:var(--hold)"></i>unique committed</span>
      <span><i style="background:var(--safe)"></i>disposable</span>
      <span><i style="background:var(--muted)"></i>other</span>
    </div>
    <h2>Selection</h2>
    <div id="detail">Click a node.</div>
  </aside>
</div>
<script>
const DATA = ${JSON.stringify(data)};

const stage = document.getElementById('stage');
const detail = document.getElementById('detail');
const W = () => stage.clientWidth, H = () => stage.clientHeight;

const colorOf = n =>
  n.uncommittedOnly > 0 ? 'var(--risk)'
  : n.uniqueSymbols  > 0 ? 'var(--hold)'
  : n.safeToDelete       ? 'var(--safe)'
  : 'var(--muted)';

const edgeStyle = e =>
  e.type === 'collision' ? { stroke: 'var(--risk)',    w: e.severity === 'high' ? 2 : 1, o: .55, dash: '' }
: e.type === 'duplicate' ? { stroke: 'var(--dup)',     w: 1.5, o: .5,  dash: '4 3' }
:                          { stroke: 'var(--sibling)', w: 1,   o: .35, dash: '' };

// ---- layout: a small force simulation. Deterministic seed so reopening the file is stable.
let seed = 42;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

const nodes = DATA.nodes.map(n => ({
  ...n, x: rnd() * 800 + 100, y: rnd() * 500 + 60, vx: 0, vy: 0,
  r: Math.max(5, Math.min(20, 5 + Math.sqrt((n.addedSymbols || 0) + (n.committedFiles || 0)) * 2.1)),
}));
const index = new Map(nodes.map((n, i) => [n.id, i]));
const edges = DATA.edges
  .filter(e => index.has(e.source) && index.has(e.target))
  .map(e => ({ ...e, s: index.get(e.source), t: index.get(e.target) }));

function simulate(steps = 320) {
  const k = 165;
  for (let step = 0; step < steps; step++) {
    const temp = 1 - step / steps;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d2 = dx * dx + dy * dy || 0.01;
        const d = Math.sqrt(d2);
        const rep = (k * k) / d2 * 0.9;
        const ux = dx / d, uy = dy / d;
        a.vx -= ux * rep; a.vy -= uy * rep;
        b.vx += ux * rep; b.vy += uy * rep;
      }
    }
    for (const e of edges) {
      const a = nodes[e.s], b = nodes[e.t];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const strength = e.type === 'sibling' ? 0.055 : e.type === 'collision' ? 0.03 : 0.02;
      const f = (d - k) * strength;
      const ux = dx / d, uy = dy / d;
      a.vx += ux * f; a.vy += uy * f;
      b.vx -= ux * f; b.vy -= uy * f;
    }
    const cx = W() / 2, cy = H() / 2;
    for (const n of nodes) {
      n.vx += (cx - n.x) * 0.012;
      n.vy += (cy - n.y) * 0.012;
      n.x += Math.max(-28, Math.min(28, n.vx)) * temp;
      n.y += Math.max(-28, Math.min(28, n.vy)) * temp;
      n.vx *= 0.82; n.vy *= 0.82;
      n.x = Math.max(28, Math.min(W() - 28, n.x));
      n.y = Math.max(28, Math.min(H() - 28, n.y));
    }
  }
}

function draw() {
  const svg = ['<svg width="' + W() + '" height="' + H() + '" viewBox="0 0 ' + W() + ' ' + H() + '">'];
  for (const e of edges) {
    const a = nodes[e.s], b = nodes[e.t], st = edgeStyle(e);
    svg.push('<line x1="' + a.x.toFixed(1) + '" y1="' + a.y.toFixed(1) +
             '" x2="' + b.x.toFixed(1) + '" y2="' + b.y.toFixed(1) +
             '" stroke="' + st.stroke + '" stroke-width="' + st.w +
             '" opacity="' + st.o + '"' + (st.dash ? ' stroke-dasharray="' + st.dash + '"' : '') + '/>');
  }
  nodes.forEach((n, i) => {
    svg.push('<circle data-i="' + i + '" cx="' + n.x.toFixed(1) + '" cy="' + n.y.toFixed(1) +
             '" r="' + n.r.toFixed(1) + '" fill="' + colorOf(n) +
             '" stroke="var(--bg)" stroke-width="1.5"><title>' + n.id + '</title></circle>');
    if (n.r >= 9 || nodes.length <= 40) {
      const label = n.id.length > 22 ? n.id.slice(0, 21) + '…' : n.id;
      svg.push('<text x="' + n.x.toFixed(1) + '" y="' + (n.y + n.r + 10).toFixed(1) +
               '" text-anchor="middle">' + label.replace(/[<>&]/g, '') + '</text>');
    }
  });
  svg.push('</svg>');
  stage.innerHTML = svg.join('');

  stage.querySelectorAll('circle').forEach(el => {
    el.addEventListener('click', () => {
      const n = nodes[+el.dataset.i];
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
          '  ' + e.type.padEnd(10) + (e.source === n.id ? e.target : e.source) +
          (e.why ? '\\n     ' + e.why : '')).join('\\n');
    });
  });
}

simulate();
draw();
let t; addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => { simulate(60); draw(); }, 160); });
</script>
</body>
</html>`;
}
