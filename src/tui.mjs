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
import { discover, repoAbsenceError } from './discover.mjs';
import { scan } from './scan.mjs';
import { analyze } from './analyze.mjs';
import { budget, PROVENANCE_NOTE } from './untrusted.mjs';

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

/** Matches exactly the escape sequences `paint()` above can produce — never a prefix of one,
 *  never a suffix. Used to measure and to truncate text that already carries colour codes
 *  without ever cutting a sequence in half (see truncateAnsi below). */
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** The width a terminal will actually show: escape codes cost zero columns, everything else
 *  is one code point (see pad() above for why raw .length is not this number). */
function visibleWidth(s) {
  return [...String(s).replace(ANSI_RE, '')].length;
}

/**
 * Truncate PAINTED text to `width` visible columns without ever slicing an escape sequence in
 * half. `l.slice(0, width)` on a string that contains `paint()` output counts escape bytes as
 * if they were visible characters, so on a real repository (long ids, narrow terminals) it
 * regularly cut inside a code like `\x1b[90m` — the terminal then received a dangling `\x1b[9`
 * with no terminating letter, which is not text, so a strict verifier that strips ONLY
 * well-formed sequences (`\x1b\[[0-9;]*m`) sees the raw escape byte leak straight into the
 * "visible" content. This walks the string keeping every complete escape sequence intact,
 * counts only real columns against the budget, and always closes with an explicit reset so a
 * colour started before the cut can never bleed into whatever the caller prints next.
 *
 * AND THE SAME LESSON A SECOND TIME, FOR A SECOND ALPHABET. Keeping ANSI sequences whole was only
 * half of it: since the boundary landed, these lines also carry holt's OWN escape tokens, `⟨U+009B⟩`
 * and `⟨+29 more⟩`, and cutting by code point sliced them into `⟨U+0`. That is not merely ugly —
 * `decodeMarked` cannot recover it, and `residualHazards` reports the dangling introducer, so the
 * frame carried a value the module cannot decode. It is exactly the [A-3] defect that
 * `clipToWidth` fixed inside src/untrusted.mjs, in the one clipper that predates the boundary. A
 * holt escape token is therefore atomic here too: it fits in the remaining columns whole, or it
 * does not go in at all.
 */
const HOLT_ESC_OPEN = '⟨';
const HOLT_ESC_CLOSE = '⟩';

function truncateAnsi(s, width) {
  const str = String(s);
  if (visibleWidth(str) <= width) return str;
  const budget = Math.max(0, width - 1);
  let out = '';
  let seen = 0;
  let i = 0;
  while (i < str.length) {
    ANSI_RE.lastIndex = i;
    const m = ANSI_RE.exec(str);
    if (m && m.index === i) { out += m[0]; i += m[0].length; continue; }
    if (str[i] === HOLT_ESC_OPEN) {
      const end = str.indexOf(HOLT_ESC_CLOSE, i + 1);
      if (end !== -1) {
        const token = str.slice(i, end + 1);
        const w = [...token].length;
        if (seen + w > budget) break;   // whole, or not at all
        out += token; i = end + 1; seen += w;
        continue;
      }
    }
    if (seen >= budget) break;
    // codePointAt(i) is only undefined when i is out of range, and the while guard above
    // already guarantees i < str.length — the fallback is for the type checker, never live.
    const cp = str.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    out += ch; i += ch.length; seen++;
  }
  return `${out}…${ansi.reset}`;
}

/* ----------------------------------------------------------------- model ---- */

const BUCKET = {
  atRisk: { key: 'atRisk', label: 'AT RISK', colour: 'red', order: 0, hint: 'uncommitted-only work — git cannot see this' },
  holds: { key: 'holds', label: 'HOLDS', colour: 'yellow', order: 1, hint: 'committed work base lacks' },
  unknown: { key: 'unknown', label: 'UNKNOWN', colour: 'magenta', order: 2, hint: 'could not assess — treat as unsafe' },
  disposable: { key: 'disposable', label: 'DISPOSABLE', colour: 'green', order: 3, hint: 'provably nothing to lose' },
};

// The list column's label field must fit the LONGEST label ('DISPOSABLE'), not a width sized
// for the shortest one ('HOLDS'). A fixed 6 truncated every label but HOLDS to illegibility
// ('DISPOSABLE' -> 'DISPOS', 'AT RISK' -> 'AT RIS', 'UNKNOWN' -> 'UNKNOW') on every real repo,
// which is all of them: BUCKET is a closed, known set, so this is computed once, not guessed.
const LABEL_W = Math.max(...Object.values(BUCKET).map((b) => b.label.length));

/** A workstream is "safe" for two different reasons and a dashboard that draws them identically
 *  is dangerous: one holds nothing at all, the other holds real committed work that is only
 *  disposable because a LIVING SIBLING happens to hold the same content right now. Deleting one
 *  redundant member is fine; deleting all of them at once (bypassing holt, which is exactly what
 *  a human clearing a screenful of green dots does) destroys the only copy. The list marker and
 *  the detail pane both need to tell these apart, so this is the one place that decides it. */
const isRedundantSafe = (row) => row.bucket === 'disposable' && (row.verdict?.redundantWith?.length ?? 0) > 0;

function bucketOf(node, verdict, uniq) {
  if (!verdict || verdict.confidence === 'unknown') return BUCKET.unknown;
  if (verdict.safe) return BUCKET.disposable;
  if ((uniq?.uncommittedOnlyCount ?? 0) > 0 || node.uncommittedFiles > 0) return BUCKET.atRisk;
  return BUCKET.holds;
}

export async function buildModel(cwd, opts = {}) {
  const disc = await discover(cwd, opts);
  if (!disc.root) throw repoAbsenceError(disc, cwd);
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
      familyRule: n.familyRule,
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
        id: s.id, family: '?', familyRule: null, branch: null, head: null,
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

/**
 * THE BOUNDARY, in the TUI.
 *
 * Every id, branch, path, symbol key and reason on this screen is repository-controlled. The TUI
 * was the worst of the unguarded surfaces: a worktree basename with a newline in it did not just
 * add a line, it desynchronised the whole frame, because `renderFrame` composes exactly `height`
 * lines and joins them. Same rule as everywhere else — nothing repository-derived reaches a line
 * except through the budget — and one line of the frame is now reserved for the provenance label,
 * so the reader is never left guessing which half of the screen holt wrote.
 *
 * The compact single line, rather than `provenanceLines`' up-to-four, is a TUI constraint: the
 * frame must be exactly `height` lines or the terminal scrolls and the redraw tears.
 */
function provenanceFooter(u) {
  if (!u.used) return paint('grey', ' ');
  const bits = [PROVENANCE_NOTE];
  if (u.markedValues > 0) bits.push(paint('yellow', `⚠ ${u.markedValues} carried control/bidi/zero-width, shown ⟦fenced⟧`));
  if (u.escapedValues > 0) bits.push(`${u.escapedValues} contain a holt marker character, shown escaped`);
  if (u.clippedValues > 0) bits.push(`${u.clippedValues} clipped at holt's per-value cap`);
  if (u.omittedValues > 0) bits.push(paint('yellow', `⚠ ${u.omittedValues} withheld — over budget`));
  return paint('grey', ` ${bits.join('  ·  ')}`);
}

export function renderFrame(model, state, size) {
  const { rows, report } = model;
  const u = budget();
  const width = Math.max(80, size.columns ?? 120);
  const height = Math.max(20, size.rows ?? 34);
  const listW = Math.min(46, Math.floor(width * 0.38));
  const detailW = width - listW - 3;
  // One line fewer than before: the last is the provenance label. See provenanceFooter.
  const bodyH = height - 6;

  const filtered = state.filter === 'all' ? rows : rows.filter((r) => r.bucket === state.filter);
  const sel = Math.min(state.selected, Math.max(0, filtered.length - 1));
  const scroll = Math.max(0, Math.min(sel - Math.floor(bodyH / 2), filtered.length - bodyH));

  const out = [];

  // header
  const k = report.counts;
  out.push(
    paint('bold', ' holt ') + paint('grey', '· ') + paint('cyan', u.take(model.root))
    + paint('grey', `  base ${u.take(report.base.ref, { ident: true })}@${String(report.base.oid).slice(0, 8)}`),
  );
  const disposableRows = rows.filter((r) => r.bucket === 'disposable');
  const redundantOnly = disposableRows.filter(isRedundantSafe).length;
  const counts = [
    paint('red', `${rows.filter((r) => r.bucket === 'atRisk').length} at-risk`),
    paint('yellow', `${rows.filter((r) => r.bucket === 'holds').length} holding`),
    paint('magenta', `${rows.filter((r) => r.bucket === 'unknown').length} unknown`),
    paint('green', `${disposableRows.length} disposable`)
      + (redundantOnly ? paint('grey', ` (${redundantOnly} only because a sibling holds it)`) : ''),
    paint('grey', `${k.collisions} collisions · ${k.duplicatePairs} duplicate pairs`),
  ].join(paint('grey', '  ·  '));
  out.push(` ${counts}`);
  out.push(paint('grey', '─'.repeat(width)));

  // body
  const detail = detailLines(filtered[sel], detailW, bodyH, u);
  for (let i = 0; i < bodyH; i++) {
    const r = filtered[scroll + i];
    let left;
    if (!r) left = ' '.repeat(listW);
    else {
      // A redundant-but-safe row gets a HALF disc, not the full one: it is disposable only while
      // its sibling lives (see isRedundantSafe). A human clearing a screenful of identical green
      // dots deletes all of them at once — which is exactly how the only copy dies when two
      // worktrees are each other's only backup. The glyph is the at-a-glance layer; the label
      // suffix and the detail pane carry the words.
      const redundant = isRedundantSafe(r);
      const mark = paint(r.bucketMeta.colour, redundant ? '◐' : '●');
      // LABEL_W, not a guessed 6 — see the comment on LABEL_W: a fixed 6 truncated every label
      // but HOLDS into an unreadable stub. The id column absorbs the difference.
      const label = pad(redundant ? `${r.bucketMeta.label}*` : r.bucketMeta.label, LABEL_W + 1);
      const line = ` ${mark} ${u.cell(r.id, listW - LABEL_W - 5, { ident: true })} ${paint('grey', label)}`;
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
    // `state.message` is holt's own sentence about the last action, but it interpolates a
    // workstream id, so it crosses the boundary like anything else.
    + (state.message ? `   ${paint('cyan', u.take(state.message, { max: width }))}` : ''),
  );
  out.push(provenanceFooter(u));

  return out.join('\n');
}

function detailLines(row, width, height, u = budget()) {
  if (!row) return [paint('grey', 'no workstreams match this filter')];
  const L = [];
  const b = row.bucketMeta;

  const redundant = (row.verdict?.redundantWith ?? []).map((x) => u.take(x, { ident: true }));
  L.push(paint('bold', u.take(row.id, { ident: true }))
    + (row.branch ? paint('grey', `  [${u.take(row.branch, { ident: true })}]`) : paint('grey', '  (detached)')));
  // "provably nothing to lose" is TRUE for an empty worktree and FALSE for a redundant one — it
  // holds real committed work, it is just work a living sibling also holds right now. Saying the
  // generic hint here is the exact equivalence this pane must not draw.
  L.push(paint(b.colour, `${b.label}`) + paint('grey', redundant.length
    ? ` — safe only because a living sibling holds the identical content (${redundant.join(', ')})`
    : ` — ${b.hint}`));
  // `redundant` above is already marked; the join is of marked values, never of raw ids.
  L.push('');
  if (row.verdict) {
    L.push(paint('grey', 'verdict   ') + (row.verdict.safe ? paint('green', 'safe to delete') : paint('red', 'do not delete')));
    for (const reason of row.verdict.reasons ?? []) L.push(paint('grey', '          ') + u.take(reason, { max: width }));
  }
  if (redundant.length) {
    L.push(paint('grey', 'redundant ') + `identical to work also held by ${redundant.join(', ')}`);
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
    // HOW MANY FIT IS COMPUTED ONCE, AND THE REMAINDER IS DERIVED FROM IT.
    //
    // This was three expressions for one quantity — `height - L.length - 8` chose the slice,
    // `height - L.length - 6` decided whether to print the line, and `height - (8)` computed the
    // number in it — and `L.length` GROWS as the loop pushes, so the second one did not even read
    // the same value as the first. On a short terminal the slice floored at 3 while the counter
    // subtracted a window that no longer matched, and the pane printed impossible things:
    //
    //     12 unique symbols, height 26  ->  "… and 0 more"     (printed at all is wrong)
    //     12 unique symbols, height 28  ->  "… and -2 more"    (measured)
    //
    // Deriving the remainder from what was actually shown makes both impossible by construction:
    // `rest` cannot exceed `layers.length`, cannot go negative, and the line cannot appear when
    // there is nothing left to mention.
    const budget = Math.max(3, height - L.length - 8);
    const shown = layers.slice(0, budget);
    for (const [layer, key] of shown) {
      L.push(`  ${paint(layer === 'committed' ? 'yellow' : 'red', '▪')} ${u.cell(key, width - 18, { ident: true })} ${paint('grey', layer)}`);
    }
    const rest = layers.length - shown.length;
    if (rest > 0) L.push(paint('grey', `  … and ${rest} more`));
  }

  if (row.collisions.length) {
    L.push('');
    L.push(paint('bold', 'collisions'));
    for (const c of row.collisions.slice(0, 4)) {
      const other = c.a === row.id ? c.b : c.a;
      L.push(`  ${paint(c.severity === 'high' ? 'red' : 'yellow', '⚡')} ${u.take(other, { ident: true })} ${paint('grey', u.take(c.kind))}`);
    }
  }

  L.push('');
  L.push(paint('grey', row.verdict?.safe
    ? 'holt clean --apply would remove this'
    : `holt rescue ${u.take(row.id, { ident: true })} --release preserves then unlocks`));

  // truncateAnsi, never a raw slice: `l.slice(0, width)` counts escape bytes as columns and cuts
  // colour codes in half — the terminal then receives a dangling `\x1b[9` that is not text, and
  // the unterminated colour bleeds into every line printed after it. See truncateAnsi's contract.
  return L.map((l) => truncateAnsi(l, width));
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
