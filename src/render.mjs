/**
 * holt — terminal rendering.
 *
 * Output is designed to be read by a human in a hurry and piped by a script. Every command
 * has a --json twin that emits the same data unformatted; nothing is computed only for the
 * pretty path.
 */

const useColor = () =>
  process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', grey: '\x1b[90m',
};

function c(name, s) {
  return useColor() ? `${C[name]}${s}${C.reset}` : String(s);
}

export const paint = c;

function bar(n, max, width = 18) {
  if (max <= 0) return '';
  const filled = Math.max(n > 0 ? 1 : 0, Math.round((n / max) * width));
  return '█'.repeat(filled) + c('grey', '·'.repeat(Math.max(0, width - filled)));
}

function pad(s, n) {
  const str = String(s);
  return str.length >= n ? str.slice(0, n) : str + ' '.repeat(n - str.length);
}

function padStart(s, n) {
  const str = String(s);
  return str.length >= n ? str : ' '.repeat(n - str.length) + str;
}

/** Header shown by every command: what holt measured against, and how. */
export function renderHeader(report) {
  const lines = [];
  lines.push(
    `${c('bold', 'holt')} ${c('grey', '·')} ${report.root}`,
  );
  const baseNote = report.base.how === 'primary-head-fallback'
    ? c('yellow', `${report.base.ref} (fallback — no conventional base branch found)`)
    : `${report.base.ref} ${c('grey', `(${report.base.how})`)}`;
  lines.push(`  base      ${baseNote} ${c('grey', report.base.oid.slice(0, 8))}`);
  lines.push(
    `  symbols   ${report.backend.degraded ? c('yellow', report.backend.label) : report.backend.label}`,
  );
  if (report.strictReadOnly) {
    lines.push(`  mode      ${c('yellow', 'strict-read-only — committed deltas are APPROXIMATE (over-report)')}`);
  }
  const k = report.counts;
  lines.push(
    `  scanned   ${k.scanned}/${k.workstreams} workstreams in ${k.families} famil${k.families === 1 ? 'y' : 'ies'}` +
    (k.skipped ? c('yellow', `  ·  ${k.skipped} skipped`) : ''),
  );
  return lines.join('\n');
}

/** The default view: the decision surface, not the inventory. */
export function renderSummary(report) {
  const out = [renderHeader(report), ''];
  const k = report.counts;

  const atRisk = report.unique.filter((u) => u.uncommittedOnlyCount > 0);
  const uniqueCommitted = report.unique.filter(
    (u) => u.uncommittedOnlyCount === 0 && u.uniqueSymbolCount > 0,
  );

  out.push(c('bold', 'DECISIONS'));
  out.push('');
  out.push(
    `  ${c('red', padStart(atRisk.length, 4))}  at risk        ` +
    c('grey', 'unique work that exists ONLY uncommitted — git cannot see this'),
  );
  out.push(
    `  ${c('yellow', padStart(uniqueCommitted.length, 4))}  hold           ` +
    c('grey', 'unique committed work base lacks'),
  );
  out.push(
    `  ${c('red', padStart(k.collisions, 4))}  collisions     ` +
    c('grey', 'workstream pairs that will fight over the same content'),
  );
  out.push(
    `  ${c('magenta', padStart(k.duplicatePairs, 4))}  duplicates     ` +
    c('grey', 'pairs that built the same thing'),
  );
  out.push(
    `  ${c('green', padStart(k.safeToDelete, 4))}  disposable     ` +
    c('grey', 'provably nothing to lose'),
  );

  if (atRisk.length) {
    out.push('', c('bold', 'AT RISK — delete these and the work is gone'));
    out.push('');
    const max = Math.max(...atRisk.map((u) => u.uncommittedOnlyCount));
    for (const u of atRisk.slice(0, 12)) {
      out.push(
        `  ${pad(u.id, 34)} ${bar(u.uncommittedOnlyCount, max, 14)} ` +
        `${padStart(u.uncommittedOnlyCount, 4)} ${c('grey', 'uncommitted-only symbol(s)')}`,
      );
      const sample = [...u.byLayer.uncommitted, ...u.byLayer.untracked].slice(0, 3);
      if (sample.length) {
        out.push(c('grey', `     ${sample.map((s) => `${s.kind}:${s.name}`).join('  ')}`));
      }
    }
    if (atRisk.length > 12) out.push(c('grey', `  … and ${atRisk.length - 12} more`));
  }

  if (report.collisions.length) {
    out.push('', c('bold', 'COLLISIONS'));
    out.push('');
    for (const col of report.collisions.slice(0, 8)) {
      const sev = col.severity === 'high' ? c('red', 'HIGH') : col.severity === 'medium' ? c('yellow', 'MED ') : c('grey', 'LOW ');
      const proof = col.kind === 'proven' ? c('red', '[proven]') : c('grey', '[predicted]');
      out.push(`  ${sev} ${proof} ${col.a} ${c('grey', '<->')} ${col.b}`);
      out.push(c('grey', `       ${col.why}`));
    }
    if (report.collisions.length > 8) out.push(c('grey', `  … and ${report.collisions.length - 8} more`));
  }

  const plan = report.plan.reviewReduction;
  const surf = report.plan.reviewSurface;
  out.push('', c('bold', 'REVIEW LOAD'));
  out.push('');
  out.push(
    `  ${plan.total} workstreams  ${c('grey', '->')}  ` +
    `${c('green', `-${plan.dropped} disposable`)}  ` +
    `${c('magenta', `-${plan.collapsed} duplicate`)}  ` +
    `${c('grey', '->')}  ${c('bold', `${plan.toReview} to land`)}`,
  );
  if (surf) {
    out.push('');
    out.push(
      `  reviewing PR-by-PR:  ${c('bold', surf.files.naive)} file-reviews, ${c('bold', surf.symbols.naive)} symbol-reviews`,
    );
    out.push(
      `  actually distinct:   ${c('green', surf.files.distinct)} files ${c('grey', `(-${surf.files.reductionPct}%)`)}, ` +
      `${c('green', surf.symbols.distinct)} symbols ${c('grey', `(-${surf.symbols.reductionPct}%)`)}`,
    );
    out.push(
      c('grey', `  of those symbols: ${surf.symbols.novel} novel (need real review) · ` +
        `${surf.symbols.corroborated} corroborated (read once, then compare)`),
    );
  }

  if (report.skipped.length) {
    out.push('', c('yellow', `SKIPPED (${report.skipped.length}) — not counted as safe, not counted as clean`));
    for (const s of report.skipped.slice(0, 6)) out.push(c('grey', `  ${pad(s.id, 34)} ${s.reason}`));
    if (report.skipped.length > 6) out.push(c('grey', `  … and ${report.skipped.length - 6} more`));
  }

  out.push('');
  return out.join('\n');
}

export function renderRisk(report) {
  const out = [renderHeader(report), ''];
  out.push(c('bold', 'UNIQUE WORK  —  what only exists here'));
  out.push('');
  const rows = report.unique.filter((u) => u.uniqueSymbolCount > 0 || u.committedFiles > 0);
  if (!rows.length) {
    out.push(c('green', '  Nothing unique anywhere. Every workstream is reproducible from base.'));
    out.push('');
    return out.join('\n');
  }
  out.push(c('grey', `  ${pad('workstream', 34)} ${padStart('uniq', 5)} ${padStart('uncomm', 7)}  verdict`));
  for (const u of rows.slice(0, 40)) {
    const flag = u.uncommittedOnlyCount > 0 ? c('red', '●') : u.uniqueSymbolCount > 0 ? c('yellow', '●') : c('grey', '●');
    out.push(
      `  ${flag} ${pad(u.id, 32)} ${padStart(u.uniqueSymbolCount, 5)} ${padStart(u.uncommittedOnlyCount, 7)}  ${c('grey', u.verdict)}`,
    );
  }
  out.push('');
  out.push(c('bold', 'DISPOSABLE'));
  out.push('');
  const safe = report.safe.filter((s) => s.safe);
  if (!safe.length) out.push(c('grey', '  none — every workstream holds something'));
  for (const s of safe.slice(0, 30)) out.push(`  ${c('green', '✓')} ${pad(s.id, 40)} ${c('grey', s.confidence)}`);
  if (safe.length > 30) out.push(c('grey', `  … and ${safe.length - 30} more`));

  const unknown = report.safe.filter((s) => s.confidence === 'unknown');
  if (unknown.length) {
    out.push('', c('yellow', `UNKNOWN (${unknown.length}) — holt could not scan these, so they are NOT safe`));
    for (const s of unknown.slice(0, 10)) out.push(c('grey', `  ? ${pad(s.id, 40)} ${s.reasons[0]}`));
  }
  out.push('');
  return out.join('\n');
}

export function renderCollisions(report) {
  const out = [renderHeader(report), ''];
  if (!report.collisions.length) {
    out.push(c('green', 'No collisions. No two workstreams contest the same content.'), '');
    return out.join('\n');
  }
  out.push(c('bold', `COLLISIONS (${report.collisions.length})`), '');
  for (const col of report.collisions) {
    const sev = col.severity === 'high' ? c('red', 'HIGH') : col.severity === 'medium' ? c('yellow', 'MED ') : c('grey', 'LOW ');
    const proof = col.kind === 'proven' ? c('red', 'proven by merge-tree') : c('grey', 'predicted');
    out.push(`${sev}  ${c('bold', col.a)} ${c('grey', '<->')} ${c('bold', col.b)}  ${col.sameFamily ? c('grey', '(same family)') : c('yellow', '(cross-dispatch)')}`);
    out.push(`      ${proof} ${c('grey', '·')} ${col.why}`);
    out.push(c('grey', `      files: ${col.sharedFiles.slice(0, 4).join(', ')}${col.sharedFiles.length > 4 ? ` … +${col.sharedFiles.length - 4}` : ''}`));
    if (col.sharedSymbols.length) {
      out.push(c('grey', `      symbols: ${col.sharedSymbols.slice(0, 5).join(', ')}${col.sharedSymbols.length > 5 ? ' …' : ''}`));
    }
    out.push('');
  }
  return out.join('\n');
}

export function renderDuplicates(report, deep) {
  const out = [renderHeader(report), ''];
  out.push(c('bold', `DUPLICATE WORK — symbol identity (${report.duplicates.length} pair(s))`), '');
  if (!report.duplicates.length) out.push(c('grey', '  none'));
  for (const d of report.duplicates.slice(0, 25)) {
    const tag = d.sameFamily ? c('grey', 'expected fan-out') : c('yellow', 'CROSS-DISPATCH WASTE');
    out.push(`  ${c('bold', d.a)} ${c('grey', '<->')} ${c('bold', d.b)}  ${tag}`);
    out.push(c('grey', `      ${d.sharedCount} shared symbol(s), similarity ${(d.similarity * 100).toFixed(0)}%: ${d.sharedSymbols.slice(0, 4).join(', ')}`));
  }

  if (deep) {
    out.push('', c('bold', 'DEEP — token clone detection'), '');
    if (!deep.ran) {
      out.push(c('yellow', `  did not run: ${deep.reason}`));
    } else if (!deep.pairs.length) {
      out.push(c('grey', `  ${deep.tool} compared ${deep.filesCompared ?? 0} added-line file(s), found no cross-workstream clones`));
    } else {
      out.push(c('grey', `  ${deep.tool} · ${deep.clones} clone(s) across ${deep.filesCompared} added-line file(s)`), '');
      for (const p of deep.pairs.slice(0, 15)) {
        const tag = p.sameFamily ? c('grey', 'expected fan-out') : c('yellow', 'CROSS-DISPATCH WASTE');
        out.push(`  ${c('bold', p.a)} ${c('grey', '<->')} ${c('bold', p.b)}  ${tag}`);
        out.push(c('grey', `      ${p.duplicatedLines} duplicated line(s) in ${p.cloneCount} clone(s)`));
      }
    }
  }
  out.push('');
  return out.join('\n');
}

export function renderPlan(report) {
  const out = [renderHeader(report), ''];
  const p = report.plan;
  out.push(c('bold', 'LANDING PLAN'), '');
  const r = p.reviewReduction;
  out.push(
    `  ${r.total} workstreams  ${c('grey', '->')}  ${c('green', `drop ${r.dropped}`)}  ` +
    `${c('magenta', `collapse ${r.collapsed}`)}  ${c('grey', '->')}  ${c('bold', `${r.toReview} to land`)}`,
  );
  out.push('');

  if (p.drop.length) {
    out.push(c('green', `DROP (${p.drop.length}) — nothing to lose`));
    for (const d of p.drop.slice(0, 20)) out.push(c('grey', `  ✓ ${d.id}`));
    if (p.drop.length > 20) out.push(c('grey', `  … and ${p.drop.length - 20} more`));
    out.push('');
  }
  if (p.collapse.length) {
    out.push(c('magenta', `COLLAPSE (${p.collapse.length}) — duplicate of another dispatch`));
    for (const x of p.collapse) out.push(c('grey', `  ${x.id} → ${x.into}`));
    out.push('');
  }
  out.push(c('bold', `LAND IN THIS ORDER (${p.order.length}) — least entangled first`));
  out.push('');
  for (const s of p.order.slice(0, 30)) {
    out.push(
      `  ${padStart(s.step, 3)}. ${pad(s.id, 34)} ` +
      c('grey', `${s.filesToReview} file(s) · ${s.uniqueSymbols} unique · entanglement ${s.entanglement}`),
    );
  }
  if (p.order.length > 30) out.push(c('grey', `  … and ${p.order.length - 30} more`));
  out.push('', c('grey', `  ${p.note}`), '');
  return out.join('\n');
}

export function renderImpact(imp) {
  const out = [];
  out.push(c('bold', 'CROSS-WORKSTREAM IMPACT') + c('grey', '  — dependency, NOT conflict'));
  out.push('');
  out.push(c('grey', `  ${imp.tool ?? 'no reference search available'}`));
  out.push('');

  if (!imp.pairs.length) {
    out.push(c('green', '  No workstream references a symbol another workstream defines.'));
    out.push('');
    for (const cav of imp.caveats) out.push(c('grey', `  · ${cav}`));
    out.push('');
    return out.join('\n');
  }

  out.push(
    `  ${c('bold', imp.counts.pairs)} producer/consumer pair(s)` +
    `  ${c('grey', '·')}  ${c('yellow', imp.counts.high)} with unambiguous evidence`,
  );
  out.push('');

  for (const p of imp.pairs.slice(0, 20)) {
    const conf = p.confidence === 'high' ? c('yellow', 'HIGH') : p.confidence === 'medium' ? c('grey', 'MED ') : c('grey', 'LOW ');
    out.push(`  ${conf}  ${c('bold', p.producer)} ${c('grey', 'defines →')} ${c('bold', p.consumer)} ${c('grey', 'uses')}`);
    const shown = p.unambiguousSymbols.length ? p.unambiguousSymbols : p.symbols;
    out.push(c('grey', `        ${shown.slice(0, 6).join(', ')}${p.symbolCount > 6 ? ` … +${p.symbolCount - 6}` : ''}`));
    out.push(c('grey', `        defined in: ${p.definedIn.slice(0, 2).join(', ')}`));
  }
  if (imp.pairs.length > 20) out.push(c('grey', `  … and ${imp.pairs.length - 20} more`));

  out.push('');
  out.push(c('bold', '  WHAT THIS DOES AND DOES NOT TELL YOU'));
  for (const cav of imp.caveats) out.push(c('grey', `  · ${cav}`));
  out.push('');
  return out.join('\n');
}

export function renderContext(digest) {
  if (!digest.ok) {
    return c('red', `holt: ${digest.error}`) + '\n' + c('grey', `known: ${digest.known.join(', ')}`);
  }
  const out = [];
  out.push(c('bold', `CONTEXT for ${digest.workstream}`) + c('grey', `  (family ${digest.family})`));
  out.push('');
  if (digest.siblings.length) out.push(c('grey', `  siblings: ${digest.siblings.join(', ')}`), '');
  for (const a of digest.advice) out.push(`  ${c('yellow', '!')} ${a}`);
  out.push('');
  if (digest.duplicatedSymbols.length) {
    out.push(c('bold', '  ALREADY BUILT NEXT DOOR'));
    for (const d of digest.duplicatedSymbols) {
      out.push(`    ${pad(d.workstream, 30)} ${d.count} ${c('grey', d.symbols.slice(0, 4).join(', '))}`);
    }
    out.push('');
  }
  if (digest.contestedFiles.length) {
    out.push(c('bold', '  CONTESTED FILES'));
    for (const f of digest.contestedFiles) {
      out.push(`    ${pad(f.workstream, 30)} ${f.fileCount} ${f.hasUncommitted ? c('yellow', '(uncommitted)') : ''}`);
      out.push(c('grey', `      ${f.files.slice(0, 3).join(', ')}`));
    }
    out.push('');
  }
  return out.join('\n');
}
