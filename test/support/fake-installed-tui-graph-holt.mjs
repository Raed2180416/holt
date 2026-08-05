#!/usr/bin/env node
// SPDX-License-Identifier: FSL-1.1-MIT
/** Synthetic executable used only to validate the installed TUI/graph proof harness itself. */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const IDS = [
  '01-unique-uncommitted-critical',
  '02-unique-committed-feature',
  '03-collision-payments-a',
  '04-collision-payments-b',
  '05-redundant-twin-a',
  '06-redundant-twin-b',
  '07-duplicate-implementation-a',
  '08-duplicate-implementation-b',
  '09-genuinely-empty',
  '10-extremely-long-agent-workstream-name-that-must-clip-cleanly-雪',
  `11-hostile-<img-src=x-onerror=HOLT_XSS()>&"quote'`,
];
const BUCKETS = {
  atRisk: [IDS[0], IDS[9], IDS[10]],
  holds: [IDS[1], IDS[2], IDS[3], IDS[6], IDS[7]],
  unknown: [],
  disposable: [IDS[4], IDS[5], IDS[8]],
};

function value(flag, fallback = null) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const command = process.argv[2];
const cwd = path.resolve(value('--cwd', process.cwd()));

function graphData() {
  const nodes = IDS.map((id, index) => {
    const atRisk = BUCKETS.atRisk.includes(id);
    const safe = BUCKETS.disposable.includes(id);
    const redundantWith = id === IDS[4] ? [IDS[5]] : id === IDS[5] ? [IDS[4]] : [];
    return {
      id,
      path: path.join(path.dirname(cwd), 'worktrees', id),
      branch: id === IDS[10]
        ? 'audit/hostile</script><svg-onload=HOLT_XSS()>'
        : `audit/case-${String(index + 1).padStart(2, '0')}`,
      head: `deadbeef${String(index).padStart(2, '0')}`,
      family: `family-${Math.floor(index / 2)}`,
      familyRule: 'synthetic-harness-fixture',
      verdict: safe ? 'safe to delete' : atRisk ? 'do not delete' : 'holds committed work',
      committedFiles: atRisk || id === IDS[8] ? 0 : 1,
      uncommittedFiles: atRisk ? 1 : 0,
      addedSymbols: id === IDS[8] ? 0 : 1,
      uniqueSymbols: safe ? 0 : 1,
      uncommittedOnly: atRisk ? 1 : 0,
      safeToDelete: safe,
      redundantWith,
    };
  });
  return {
    nodes,
    edges: [
      { type: 'collision', kind: 'proven', source: IDS[2], target: IDS[3], why: 'same policy, incompatible bytes' },
      { type: 'collision', kind: 'identical', source: IDS[4], target: IDS[5], why: 'identical committed tree' },
      { type: 'duplicate', source: IDS[6], target: IDS[7], why: 'same implementation, different paths' },
    ],
  };
}

const widthOf = (value) => [...value].reduce((total, character) =>
  total + (character.codePointAt(0) >= 0x1100 ? 2 : 1), 0);
function clip(value, width) {
  let output = '';
  for (const character of String(value)) {
    const next = character.codePointAt(0) >= 0x1100 ? 2 : 1;
    if (widthOf(output) + next > width) break;
    output += character;
  }
  return output + ' '.repeat(Math.max(0, width - widthOf(output)));
}

function bucketOf(id) {
  return Object.keys(BUCKETS).find((bucket) => BUCKETS[bucket].includes(id));
}

function renderTui(filter = 'all', selected = 0, columns = 120, rows = 36, root = cwd) {
  const all = IDS.map((id) => ({ id, bucket: bucketOf(id) }));
  const filtered = filter === 'all' ? all : all.filter((row) => row.bucket === filter);
  const current = filtered[Math.min(selected, Math.max(0, filtered.length - 1))];
  const listWidth = Math.min(46, Math.floor(columns * 0.38));
  const detailWidth = columns - listWidth - 3;
  const bodyHeight = rows - 6;
  const counts = root.endsWith('empty-repo')
    ? { atRisk: 0, holds: 0, unknown: 0, disposable: 0 }
    : { atRisk: 3, holds: 5, unknown: 0, disposable: 3 };
  const visible = root.endsWith('empty-repo') ? [] : filtered;
  const lines = [
    clip(` holt · ${root}  base main@deadbeef`, columns),
    clip(` ${counts.atRisk} at-risk · ${counts.holds} holding · ${counts.unknown} unknown · ${counts.disposable} disposable · 1 collisions · 1 duplicate pairs`, columns),
    '─'.repeat(columns),
  ];
  for (let index = 0; index < bodyHeight; index++) {
    const row = visible[index];
    const left = row ? ` ● ${row.id} ${row.bucket === 'disposable' ? 'DISPOSABLE' : row.bucket === 'atRisk' ? 'AT RISK' : 'HOLDS'}` : '';
    let detail = '';
    if (index === 0) {
      if (root.endsWith('empty-repo') || !current) detail = 'no workstreams match this filter';
      else detail = current.id;
    } else if (index === 1 && current) {
      detail = current.bucket === 'disposable' ? 'DISPOSABLE — provably nothing to lose'
        : current.bucket === 'atRisk' ? 'AT RISK — uncommitted-only work' : 'HOLDS — committed work';
    } else if (index === 2 && current) {
      detail = current.bucket === 'disposable' ? 'verdict   safe to delete' : 'verdict   do not delete';
    } else if (index === bodyHeight - 1 && current) {
      detail = current.bucket === 'disposable'
        ? 'holt clean --apply would quarantine this (recoverable; branch retained)'
        : `holt rescue ${current.id} --release preserves then unlocks`;
    }
    lines.push(`${clip(left, listWidth)} │ ${clip(detail, detailWidth)}`);
  }
  lines.push('─'.repeat(columns));
  lines.push(clip(` ↑↓/jk move   f filter:${filter}   P protect   C clean(dry)   r rescan   q quit`, columns));
  lines.push(' '.repeat(columns));
  return lines.join('\n');
}

function runTui() {
  if (path.basename(cwd) === 'not-a-repository') {
    process.stderr.write(`holt: not a git repository: ${cwd}\n`);
    process.exit(2);
  }
  const snapshot = process.argv.includes('--snapshot');
  if (snapshot) {
    const columns = Number(value('--columns', '120'));
    const rows = Number(value('--rows', '36'));
    process.stdout.write(`${renderTui('all', 0, columns, rows)}\n`);
    return;
  }
  const filters = ['all', 'atRisk', 'holds', 'unknown', 'disposable'];
  let filterIndex = 0;
  let selected = 0;
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdout.write('\x1b[?1049h\x1b[?25l');
  const draw = () => process.stdout.write(`\x1b[2J\x1b[H${renderTui(
    filters[filterIndex], selected, process.stdout.columns ?? 120, process.stdout.rows ?? 36,
  )}`);
  process.stdout.on('resize', draw);
  const quit = () => {
    process.stdout.write('\x1b[?25h\x1b[?1049l');
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.exit(0);
  };
  process.stdin.on('data', (chunk) => {
    for (const key of chunk.toString('utf8')) {
      if (key === 'q') return quit();
      if (key === 'f') { filterIndex = (filterIndex + 1) % filters.length; selected = 0; }
      else if (key === 'j') selected = Math.min(selected + 1, BUCKETS[filters[filterIndex]]?.length - 1);
      else if (key === 'k') selected = Math.max(0, selected - 1);
      draw();
    }
  });
  draw();
}

function safeJson(value) {
  return JSON.stringify(value).replace(/[<>&]/g, (character) => ({
    '<': '\\u003c', '>': '\\u003e', '&': '\\u0026',
  })[character]);
}

function graphHtml(graph) {
  const counts = {
    atRisk: graph.nodes.filter((node) => node.uncommittedOnly > 0).length,
    safe: graph.nodes.filter((node) => node.safeToDelete).length,
  };
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>holt graph</title><style>
:root{--bg:#0f1115;--panel:#171a21;--line:#303641;--fg:#e6e9ef;--muted:#9aa3b6;--risk:#ff5f56;--safe:#3fb950;--hold:#ffbd2e;--dup:#c678dd;--accent:#58a6ff}
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:var(--bg);color:var(--fg);font:14px system-ui,sans-serif}
header{height:50px;padding:10px 16px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:14px;overflow:hidden}h1{font-size:20px;margin:0}.meta{color:var(--muted);white-space:nowrap}
.wrap{display:flex;height:calc(100vh - 50px);width:100%}#stage{flex:1;min-width:0;position:relative;overflow:hidden}aside{width:340px;flex:none;overflow:auto;border-left:1px solid var(--line);padding:14px;background:var(--panel)}
#hint{position:absolute;left:12px;bottom:10px;color:var(--muted);font-size:11px}.row{display:flex;justify-content:space-between;padding:5px}.clickable{cursor:pointer}.filters{display:grid;gap:5px}#search{width:100%;padding:8px;background:var(--bg);color:var(--fg);border:1px solid var(--line)}#detail{white-space:pre-wrap;word-break:break-word;font:12px ui-monospace,monospace}h2{font-size:11px;text-transform:uppercase;color:var(--muted);margin:14px 0 6px}circle.node{cursor:pointer}circle.node:focus-visible{outline:3px solid var(--accent)}svg{display:block}
@media(max-width:600px){header{font-size:11px;gap:7px}.wrap{flex-direction:column}#stage{width:100%;height:55%;flex:none}aside{width:100%;height:45%;border-left:0;border-top:1px solid var(--line)}}
</style></head><body><header><h1>holt</h1><span class="meta">installed graph</span><span class="meta">${graph.nodes.length} workstreams</span></header>
<div class="wrap"><div id="stage"><div id="hint">Tab/arrow keys select · Enter pins · / searches</div></div><aside>
<h2>Find</h2><input id="search" type="search"><h2>Decisions</h2>
<div class="row clickable" data-focus="risk" role="button" tabindex="0"><span>At risk</span><b>${counts.atRisk}</b></div>
<div class="row clickable" data-focus="safe" role="button" tabindex="0"><span>Disposable</span><b>${counts.safe}</b></div>
<h2>Show relationships</h2><div class="filters">
<label><input type="checkbox" data-edge="proven" checked>proven conflict</label><label><input type="checkbox" data-edge="semantic-overlap" checked>semantic overlap</label><label><input type="checkbox" data-edge="predicted" checked>predicted</label><label><input type="checkbox" data-edge="duplicate">duplicate work</label><label><input type="checkbox" data-edge="sibling">same family</label>
</div><h2>Selection</h2><div id="detail">Hover a node to trace it. Click to pin the details here.</div></aside></div>
<script>
const DATA = ${safeJson(graph)};
const stage=document.getElementById('stage'),hint=document.getElementById('hint'),search=document.getElementById('search'),detail=document.getElementById('detail');
const shown=new Set(['proven','semantic-overlap','predicted','identical']);let query='',pinned=-1,keyboardFocused=-1,pendingFocus=-1;let running=false;
const cls=e=>e.type==='collision'?(e.kind||'predicted'):e.type;const matches=n=>!query||query==='risk'?(!query||n.uncommittedOnly>0):query==='safe'?n.safeToDelete:n.id.toLowerCase().includes(query);
function describe(i){const n=DATA.nodes[i],rel=DATA.edges.filter(e=>e.source===n.id||e.target===n.id);detail.textContent=n.id+'\\n'+'─'.repeat(Math.min(34,n.id.length))+'\\nfamily      '+n.family+' ('+n.familyRule+')\\nhead        '+n.head+'\\nbranch      '+n.branch+'\\nverdict     '+n.verdict+'\\n\\nedges ('+rel.length+')';}
function el(name,attrs){const node=document.createElementNS('http://www.w3.org/2000/svg',name);for(const [key,val] of Object.entries(attrs))node.setAttribute(key,String(val));return node;}
function draw(){const active=document.activeElement?.getAttribute?.('data-node-index');const restore=pendingFocus!==-1?pendingFocus:(active===null||active===undefined?-1:Number(active));const w=stage.clientWidth,h=stage.clientHeight;const svg=el('svg',{width:w,height:h,viewBox:'0 0 '+w+' '+h});const g=el('g',{});const pos=DATA.nodes.map((n,i)=>({x:60+(i%4)*Math.max(70,(w-120)/3),y:55+Math.floor(i/4)*Math.max(70,(h-110)/2)}));for(const edge of DATA.edges.filter(e=>shown.has(cls(e)))){const a=pos[DATA.nodes.findIndex(n=>n.id===edge.source)],b=pos[DATA.nodes.findIndex(n=>n.id===edge.target)];g.appendChild(el('line',{x1:a.x,y1:a.y,x2:b.x,y2:b.y,stroke:'#8b93a7',opacity:.6}));}DATA.nodes.forEach((n,i)=>{const circle=el('circle',{class:'node',cx:pos[i].x,cy:pos[i].y,r:10,fill:n.uncommittedOnly?'var(--risk)':n.safeToDelete?'var(--safe)':'var(--hold)',opacity:matches(n)?1:.12,tabindex:0,role:'button','data-node-index':i,'aria-pressed':pinned===i?'true':'false','aria-label':'Workstream '+n.id});const title=el('title',{});title.textContent=n.id;circle.appendChild(title);circle.addEventListener('focus',()=>{keyboardFocused=i;describe(i)});circle.addEventListener('click',ev=>{ev.stopPropagation();pinned=pinned===i?-1:i;keyboardFocused=i;pendingFocus=i;describe(i);draw()});circle.addEventListener('keydown',ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();pinned=pinned===i?-1:i;keyboardFocused=i;pendingFocus=i;describe(i);draw();return;}const delta=ev.key==='ArrowRight'||ev.key==='ArrowDown'?1:ev.key==='ArrowLeft'||ev.key==='ArrowUp'?-1:0;if(!delta)return;ev.preventDefault();let next=i;for(let tries=0;tries<DATA.nodes.length;tries++){next=(next+delta+DATA.nodes.length)%DATA.nodes.length;if(matches(DATA.nodes[next]))break;}keyboardFocused=next;pendingFocus=next;describe(next);draw();});g.appendChild(circle)});svg.appendChild(g);stage.replaceChildren(svg,hint);if(restore!==-1)svg.querySelector('[data-node-index="'+restore+'"]').focus({preventScroll:true});pendingFocus=-1;}
search.addEventListener('input',()=>{query=search.value.trim().toLowerCase();draw()});addEventListener('keydown',ev=>{if(ev.key==='/'&&document.activeElement!==search){ev.preventDefault();search.focus()}if(ev.key==='Escape'){search.value='';query='';pinned=-1;keyboardFocused=-1;pendingFocus=-1;draw()}});
document.querySelectorAll('[data-focus]').forEach(row=>{const activate=()=>{query=row.dataset.focus==='risk'?'risk':'safe';search.value='';pinned=-1;keyboardFocused=-1;pendingFocus=-1;draw()};row.addEventListener('click',activate);row.addEventListener('keydown',ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();activate()}})});document.querySelectorAll('[data-edge]').forEach(box=>box.addEventListener('change',()=>{box.checked?shown.add(box.dataset.edge):shown.delete(box.dataset.edge);draw()}));addEventListener('resize',draw);draw();
</script></body></html>`;
}

async function runGraph() {
  const graph = graphData();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(graph)}\n`);
    return;
  }
  const htmlPath = value('--html');
  if (htmlPath) {
    await fs.writeFile(path.resolve(htmlPath), graphHtml(graph), { encoding: 'utf8', flag: 'wx' });
    process.stdout.write(`wrote ${path.resolve(htmlPath)}  (${graph.nodes.length} nodes, ${graph.edges.length} edges)\n`);
    return;
  }
  process.stdout.write(`holt graph  ${graph.nodes.length} workstreams · ${graph.edges.length} relationships\n\n`);
  process.stdout.write(`collision: ${IDS[2]} ↔ ${IDS[3]}\n`);
  process.stdout.write(`duplicate: ${IDS[6]} ↔ ${IDS[7]}\n`);
}

if (command === 'tui') runTui();
else if (command === 'graph') await runGraph();
else {
  process.stderr.write(`synthetic harness executable: unsupported command ${command}\n`);
  process.exit(2);
}
