// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — the TUI.  `holt tui`
 *
 * The product started life as "a graph tool for humans and AI to deeply understand worktrees."
 * The AI half is MCP/hooks/AGENTS.md. This is the human half: one screen that answers, at a
 * glance, the question every other surface answers in JSON — what did my N workstreams produce,
 * what is at risk, what collides, and what can go.
 *
 * DESIGN RULES
 *   - Zero dependencies. Raw ANSI + node:readline keypress events. A safety tool's UI must not
 *     drag in a TUI framework that breaks on the next Node major.
 *   - Risk-sorted, colour-coded: at-risk first (red), holds-committed (yellow), disposable
 *     (green), unknown (magenta). The sort IS the message.
 *   - Read-only by default. The only mutating keys are explicit, capitalised, and confirmed:
 *     P = protect (dry-run shown first), C = clean (dry-run shown first). Everything else looks.
 *   - `--snapshot` renders one frame to stdout and exits — that is how the tests see it, and how
 *     it stays honest: a TUI that can only be eyeballed is a TUI that regresses silently.
 *
 * LAYOUT
 *   header   repo · base · counts
 *   left     workstream list (▲/▼ or j/k, filtered by f)
 *   right    detail pane for the selection: verdict, layers, symbols, collisions, edges
 *   footer   keybindings + last action result
 */

import process from 'node:process';
import { discover } from './discover.mjs';
import { scan } from './scan.mjs';
import { analyze } from './analyze.mjs';

/* ------------------------------------------------------------------ ansi ---- */

const ESC = '\x1b[';
const ansi = {
  clear: `${ESC}2J${ESC}H`,
  home: `${ESC}H`,
  hideCursor: `${ESC}?25l`,
  showCursor: `${ESC}?25h`,
  alt: `${ESC}?1049h`,
  main: `${ESC}?1049l`,
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  inverse: `${ESC}7m`,
  red: `${ESC}31m`, green: `${ESC}32m`, yellow: `${ESC}33m`,
  blue: `${ESC}34m`, magenta: `${ESC}35m`, cyan: `${ESC}36m`, grey: `${ESC}90m`,
};
const paint = (c, s) => `${ansi[c]}${s}${ansi.reset}`;

/** Display width is not string length once unicode is involved; keep it simple but safe. */
function pad(s, n) {
  const str = String(s);
  const w = [...str].length;
  return w >= n ? [...str].slice(0, n).join('') : str + ' '.repeat(n - w);
}

/* ----------------------------------------------------------------- model ---- */

const BUCKET = {
  atRisk: { key: 'atRisk', label: 'AT RISK', colour: 'red', order: 0, hint: 'uncommitted-only work — git cannot see this' },
  holds: { key: 'holds', label: 'HOLDS', colour: 'yellow', order: 1, hint: 'committed work base lacks' },
  unknown: { key: 'unknown', label: 'UNKNOWN', colour: 'magenta', order: 2, hint: 'could not assess — treat as unsafe' },
  disposable: { key: 'disposable', label: 'DISPOSABLE', colour: 'green', order: 3, hint: 'provably nothing to lose' },
};

function bucketOf(node, verdict, uniq) {
  if (!verdict || verdict.confidence === 'unknown') return BUCKET.unknown;
  if (verdict.safe) return BUCKET.disposable;
  if ((uniq?.uncommittedOnlyCount ?? 0) > 0 || node.uncommittedFiles > 0) return BUCKET.atRisk;
  return BUCKET.holds;
}

export async function buildModel(cwd, opts = {}) {
  const disc = await discover(cwd, opts);
  if (!disc.root) throw Object.assign(new Error(`not a git repository: ${cwd}`), { code: 'ENOTREPO' });
  const scanned = await scan(disc, opts);
  const report = await analyze(scanned, opts);

  const uniqById = new Map(report.unique.map((u) => [u.id, u]));
  const safeById = new Map(report.safe.map((s) => [s.id, s]));

  const rows = report.graph.nodes.map((n) => {
    const uniq = uniqById.get(n.id);
    const verdict = safeById.get(n.id);
    const bucket = bucketOf(n, verdict, uniq);
    const collisions = report.collisions.filter((c) => c.a === n.id || c.b === n.id);
    return {
      id: n.id,
      family: n.family,
      branch: n.branch,
      head: n.head,
      bucket: bucket.key,
      bucketMeta: bucket,
      verdict,
      uniq,
      collisions,
      committedFiles: n.committedFiles,
      uncommittedFiles: n.uncommittedFiles,
      addedSymbols: n.addedSymbols,
      uniqueSymbols: n.uniqueSymbols,
    };
  });

  // Unknown workstreams appear in safe[] but may be missing from graph nodes; surface them too.
  for (const s of report.safe) {
    if (!rows.some((r) => r.id === s.id) && s.confidence === 'unknown') {
      rows.push({
        id: s.id, family: '?', branch: null, head: null,
        bucket: 'unknown', bucketMeta: BUCKET.unknown, verdict: s,
        uniq: null, collisions: [], committedFiles: 0, uncommittedFiles: 0,
        addedSymbols: 0, uniqueSymbols: 0,
      });
    }
  }

  rows.sort((a, b) => a.bucketMeta.order - b.bucketMeta.order
    || (b.uniq?.uncommittedOnlyCount ?? 0) - (a.uniq?.uncommittedOnlyCount ?? 0)
    || a.id.localeCompare(b.id));

  return { report, rows, root: disc.root };
}

/* ---------------------------------------------------------------- render ---- */

export function renderFrame(model, state, size) {
  const { rows, report } = model;
  const width = Math.max(80, size.columns ?? 120);
  const height = Math.max(20, size.rows ?? 34);
  const listW = Math.min(46, Math.floor(width * 0.38));
  const detailW = width - listW - 3;
  const bodyH = height - 5;

  const filtered = state.filter === 'all' ? rows : rows.filter((r) => r.bucket === state.filter);
  const sel = Math.min(state.selected, Math.max(0, filtered.length - 1));
  const scroll = Math.max(0, Math.min(sel - Math.floor(bodyH / 2), filtered.length - bodyH));

  const out = [];

  // header
  const k = report.counts;
  out.push(
    paint('bold', ' holt ') + paint('grey', '· ') + paint('cyan', model.root)
    + paint('grey', `  base ${report.base.ref}@${report.base.oid.slice(0, 8)}`),
  );
  const counts = [
    paint('red', `${rows.filter((r) => r.bucket === 'atRisk').length} at-risk`),
    paint('yellow', `${rows.filter((r) => r.bucket === 'holds').length} holding`),
    paint('magenta', `${rows.filter((r) => r.bucket === 'unknown').length} unknown`),
    paint('green', `${rows.filter((r) => r.bucket === 'disposable').length} disposable`),
    paint('grey', `${k.collisions} collisions · ${k.duplicatePairs} duplicate pairs`),
  ].join(paint('grey', '  ·  '));
  out.push(` ${counts}`);
  out.push(paint('grey', '─'.repeat(width)));

  // body
  const detail = detailLines(filtered[sel], detailW, bodyH);
  for (let i = 0; i < bodyH; i++) {
    const r = filtered[scroll + i];
    let left;
    if (!r) left = ' '.repeat(listW);
    else {
      const mark = paint(r.bucketMeta.colour, '●');
      const line = ` ${mark} ${pad(r.id, listW - 10)} ${paint('grey', pad(r.bucketMeta.label, 6))}`;
      left = (scroll + i === sel) ? `${ansi.inverse}${line}${ansi.reset}` : line;
    }
    out.push(`${left} ${paint('grey', '│')} ${detail[i] ?? ''}`);
  }

  // footer
  out.push(paint('grey', '─'.repeat(width)));
  out.push(
    ' ' + [
      paint('bold', '↑↓/jk') + paint('grey', ' move'),
      paint('bold', 'f') + paint('grey', ` filter:${state.filter}`),
      paint('bold', 'P') + paint('grey', ' protect'),
      paint('bold', 'C') + paint('grey', ' clean(dry)'),
      paint('bold', 'r') + paint('grey', ' rescan'),
      paint('bold', 'q') + paint('grey', ' quit'),
    ].join('   ')
    + (state.message ? `   ${paint('cyan', state.message)}` : ''),
  );

  return out.join('\n');
}

function detailLines(row, width, height) {
  if (!row) return [paint('grey', 'no workstreams match this filter')];
  const L = [];
  const b = row.bucketMeta;

  L.push(paint('bold', row.id) + (row.branch ? paint('grey', `  [${row.branch}]`) : paint('grey', '  (detached)')));
  L.push(paint(b.colour, `${b.label}`) + paint('grey', ` — ${b.hint}`));
  L.push('');
  if (row.verdict) {
    L.push(paint('grey', 'verdict   ') + (row.verdict.safe ? paint('green', 'safe to delete') : paint('red', 'do not delete')));
    for (const reason of row.verdict.reasons ?? []) L.push(paint('grey', '          ') + reason);
  }
  L.push(paint('grey', 'committed ') + `${row.committedFiles} file(s) base lacks`);
  L.push(paint('grey', 'uncommit  ') + `${row.uncommittedFiles} file(s)`);
  L.push(paint('grey', 'symbols   ') + `${row.addedSymbols} added · ${row.uniqueSymbols} found nowhere else`);

  const layers = row.uniq ? [
    ...row.uniq.byLayer.uncommitted.map((s) => ['uncommitted', s.key]),
    ...row.uniq.byLayer.untracked.map((s) => ['untracked', s.key]),
    ...row.uniq.byLayer.committed.map((s) => ['committed', s.key]),
  ] : [];
  if (layers.length) {
    L.push('');
    L.push(paint('bold', 'unique work') + paint('grey', ' (what deletion would lose)'));
    for (const [layer, key] of layers.slice(0, Math.max(3, height - L.length - 8))) {
      L.push(`  ${paint(layer === 'committed' ? 'yellow' : 'red', '▪')} ${pad(key, width - 18)} ${paint('grey', layer)}`);
    }
    if (layers.length > height - L.length - 6) L.push(paint('grey', `  … and ${layers.length - (height - 8)} more`));
  }

  if (row.collisions.length) {
    L.push('');
    L.push(paint('bold', 'collisions'));
    for (const c of row.collisions.slice(0, 4)) {
      const other = c.a === row.id ? c.b : c.a;
      L.push(`  ${paint(c.severity === 'high' ? 'red' : 'yellow', '⚡')} ${other} ${paint('grey', c.kind)}`);
    }
  }

  L.push('');
  L.push(paint('grey', row.verdict?.safe
    ? 'holt clean --apply would remove this'
    : `holt rescue ${row.id} --release preserves then unlocks`));

  return L.map((l) => l.length > width ? `${l.slice(0, width - 1)}…` : l);
}

/* ------------------------------------------------------------ interactive ---- */

export async function runTui(cwd, opts = {}) {
  let model = await buildModel(cwd, opts);
  const state = { selected: 0, filter: 'all', message: `${model.rows.length} workstreams scanned` };

  if (opts.snapshot) {
    // One frame, no alternate screen, no raw mode. This is the testable path, and it must go
    // through EXACTLY the same renderer as the interactive one.
    process.stdout.write(`${renderFrame(model, state, { columns: opts.columns ?? 120, rows: opts.rows ?? 34 })}\n`);
    return;
  }

  const { emitKeypressEvents } = await import('node:readline');
  emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdout.write(ansi.alt + ansi.hideCursor);

  const draw = () => {
    process.stdout.write(ansi.clear + renderFrame(model, state, {
      columns: process.stdout.columns, rows: process.stdout.rows,
    }));
  };
  const cleanup = () => {
    process.stdout.write(ansi.showCursor + ansi.main);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  const FILTERS = ['all', 'atRisk', 'holds', 'unknown', 'disposable'];

  process.stdin.on('keypress', async (_str, key) => {
    if (!key) return;
    const filtered = state.filter === 'all' ? model.rows : model.rows.filter((r) => r.bucket === state.filter);

    if (key.name === 'q' || (key.ctrl && key.name === 'c')) cleanup();
    else if (key.name === 'down' || key.name === 'j') state.selected = Math.min(state.selected + 1, filtered.length - 1);
    else if (key.name === 'up' || key.name === 'k') state.selected = Math.max(state.selected - 1, 0);
    else if (key.name === 'f') {
      state.filter = FILTERS[(FILTERS.indexOf(state.filter) + 1) % FILTERS.length];
      state.selected = 0;
    } else if (key.name === 'r') {
      state.message = 'rescanning…'; draw();
      model = await buildModel(cwd, opts);
      state.message = `rescanned: ${model.rows.length} workstreams`;
    } else if (key.sequence === 'P') {
      // Mutating keys are capitalised and act in two steps: first press shows the dry run.
      const { protect } = await import('./actions.mjs');
      if (state.armProtect) {
        state.message = 'protecting…'; draw();
        const p = await protect(cwd, {});
        model = await buildModel(cwd, opts);
        state.message = `protected ${p.protected} workstream(s)`;
        state.armProtect = false;
      } else {
        const p = await (await import('./actions.mjs')).protect(cwd, { dryRun: true });
        state.message = `would lock ${p.protected} — press P again to apply`;
        state.armProtect = true;
      }
    } else if (key.sequence === 'C') {
      const { clean } = await import('./actions.mjs');
      if (state.armClean) {
        state.message = 'cleaning…'; draw();
        const c = await clean(cwd, { apply: true });
        model = await buildModel(cwd, opts);
        state.message = `removed ${c.removed} · skipped ${c.skipped.length}`;
        state.armClean = false;
      } else {
        const c = await clean(cwd, {});
        state.message = `would remove ${c.wouldRemove.length} — press C again to apply`;
        state.armClean = true;
      }
    } else {
      state.armProtect = false;
      state.armClean = false;
    }
    draw();
  });

  draw();
}
