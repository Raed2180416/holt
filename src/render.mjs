// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — terminal rendering.
 *
 * Output is designed to be read by a human in a hurry and piped by a script. Every command
 * has a --json twin that emits the same data unformatted; nothing is computed only for the
 * pretty path.
 */

import { budget, padTo, padStartTo, provenanceLines as sharedProvenanceLines } from './untrusted.mjs';
import { stashRecoveryGuidance } from './stash.mjs';

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

// Width-aware, not `String.length`-aware. `.length` counts UTF-16 units, so `fix-日本語` (7 units,
// 10 columns) shoved every later column three places right, and `slice(0, n)` could cut between a
// surrogate pair and emit a lone surrogate — invalid UTF-8, a replacement glyph on screen. Both
// are "a sanitiser that mangles an ordinary name", which fails for the same reason an injection
// getting through does.
const pad = (s, n) => padTo(s, n);
const padStart = (s, n) => padStartTo(s, n);

/**
 * THE BOUNDARY, applied where this file can actually enforce it.
 *
 * Everything printed here is either holt's own words or something the repository controls —
 * worktree ids, branch names, file paths, symbol names, stash messages, collision reasons. Before
 * this existed, a worktree whose directory basename contained a newline printed free-standing
 * lines of forged holt imperative inside `holt collisions`, and an ESC in a name cleared the
 * terminal that was showing the real warning. Both are reproduced in test/e2e/injection.test.mjs.
 *
 * Every renderer opens a budget and every repository-derived value goes through `u.take` or
 * `u.cell`. That is the structural home: the rule is "no repo value reaches `out` except through
 * the budget", one rule for the whole file, and test/unit/untrusted.test.mjs drives EVERY export
 * of this module with a report whose every string is a payload and fails on any control, bidi or
 * zero-width character in the result. A new interpolation added without the boundary goes red
 * without anyone remembering to guard it.
 */
const repoData = () => budget();

/**
 * The marker for a value printed where holt has promised an IDENTIFIER — a workstream id, a
 * branch, a file path, a symbol. Such a value is fenced when its extent would otherwise be
 * unreadable (see `wrap()` in src/untrusted.mjs). Reattack that motivated it: a worktree named
 * `HIGH [proven] main <-> main   (same family)` rendered as
 *
 *     HIGH  HIGH [proven] main <-> main   (same family) <-> VERIFIED-DISPOSABLE-…  (same family)
 *
 * — structurally contained, and impossible to read. Free-text positions (a stash message, a
 * collision reason, holt's own sentences) deliberately do NOT carry it.
 */
const ID = { ident: true };

/**
 * The provenance label, and the evidence lines.
 *
 * One implementation, in src/untrusted.mjs, shared by every renderer in the program — this file,
 * `holt graph`, `holt order`, `holt partition`, `holt branches` and the TUI. See the comment
 * there for why each line may state only what its own counter proves.
 */
const provenanceLines = (u) => sharedProvenanceLines(u, c);

/**
 * Header shown by every command: what holt measured against, and how.
 *
 * `base.ref` is a BRANCH NAME and `root` is a filesystem path — both repository-controlled, both
 * printed on the first two lines of every command, which is the most quoted output holt has.
 * @param {any} report
 * @param {ReturnType<typeof budget>} [u]
 */
export function renderHeader(report, u = repoData()) {
  const lines = [];
  lines.push(
    `${c('bold', 'holt')} ${c('grey', '·')} ${u.take(report.root)}`,
  );
  const ref = u.take(report.base.ref, ID);
  const baseNote = report.base.how === 'primary-head-fallback'
    ? c('yellow', `${ref} (fallback — no conventional base branch found)`)
    // `how` is holt's own enum today. It is marked anyway: the cost is nothing, and "this field
    // happens to be ours right now" is the assumption every one of these leaks was built on.
    : `${ref} ${c('grey', `(${u.take(report.base.how)})`)}`;
  lines.push(`  base      ${baseNote} ${c('grey', String(report.base.oid).slice(0, 8))}`);
  lines.push(
    `  symbols   ${report.backend.degraded ? c('yellow', u.take(report.backend.label)) : u.take(report.backend.label)}`,
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

/**
 * `report.counts.scanned === 0` means one of two very different things, and every all-zero
 * DECISIONS table or "nothing unique" verdict below is reached by BOTH of them:
 *   - the overwhelmingly common first run: nobody has created a second worktree yet, so there is
 *     nothing to compare THIS one against, and every count is zero because the comparison never
 *     ran, not because it ran and cleared the repo.
 *   - every sibling really was checked and really held nothing unique — a genuine all-clear.
 * A report that cannot tell these apart reads as confident either way. Since `report.counts`
 * already knows which one happened, say so, in the same words `holt setup` already uses for the
 * same situation (see step 3 of cmdSetup in bin/holt.mjs).
 */
/**
 * What holt is NOT vouching for, said out loud whenever an all-clear-shaped line prints.
 *
 * The primary worktree is excluded from the scan by default, and the commonest first-run shape
 * there is — one repository, no fan-out yet, uncommitted-only work in the primary — got
 * "Nothing unique anywhere. Every workstream is reproducible from base.": true of the zero
 * workstreams scanned, false of the repository, and shown to exactly the person least equipped
 * to know the difference. A dirty (or unreadable) excluded primary is named beside every verdict
 * that could otherwise read as "holt checked everything".
 */
function primaryCaveat(report, u) {
  const p = report.primaryUnscanned;
  if (!p) return [];
  if (p.dirtyFiles === 0) return [];
  const id = u.take(p.id);
  return [p.dirtyFiles === null
    ? c('yellow', `  (holt could not even read the primary worktree's status — '${id}' is NOT covered by the verdict above)`)
    : c('yellow', `  (your primary worktree '${id}' holds ${p.dirtyFiles} uncommitted change(s) holt is NOT auditing — `
      + 'the verdict above is about the OTHER worktrees. `holt risk --include-primary` covers it.)')];
}

function noSiblingsNote(report) {
  // Gated on WORKSTREAMS, not on scanned: `counts.scanned` counts only the workstreams that
  // scanned OK, so a total scan failure used to print "no worktrees yet — fan out and re-run"
  // two lines beneath its own header reading "scanned 0/2 · 2 skipped" — denying the existence
  // of worktrees it had just counted, and prescribing MORE of them as the remedy. The two empty
  // states are opposites: no worktrees is a fresh repo; all-skipped is a scan holt must not
  // paper over with onboarding advice.
  if (report.counts.workstreams === 0) {
    // "no OTHER worktrees" — the primary exists and the reader is standing in it. The old text
    // said "no worktrees yet" about a repository with one, which is the kind of small falsehood
    // that costs the tool its word right at first contact.
    return c('grey', '  no other worktrees yet — holt relates parallel workstreams, and this repo has '
      + 'only the primary. `git worktree add ../<name> <branch>`, then re-run.');
  }
  // THE SOLO REPOSITORY: the risk verdict is earned, the COMPARISON is not.
  //
  // holt now scans the primary when it is the only worktree, so "nothing at risk" here is a real
  // measurement rather than a statement about worktrees that do not exist. But collisions,
  // duplicates, families and landing order are still necessarily zero, and zero-because-nothing-
  // to-compare looks exactly like zero-because-verified from the output alone.
  if (report.soloPrimary) {
    return c('grey', '  this repo has only the primary worktree, so holt scanned it directly — the verdict '
      + 'below is real. Cross-worktree findings (collisions, duplicates) are empty because there is '
      + 'nothing to compare against yet: `git worktree add ../<name> <branch>`.');
  }
  if (report.counts.scanned === 0) {
    return c('red', `  none of the ${report.counts.workstreams} workstream(s) could be scanned — `
      + 'every verdict below is about NOTHING. See the skip reasons above; holt cannot vouch for '
      + 'unscanned work.');
  }
  return null;
}

/** The default view: the decision surface, not the inventory. */
export function renderSummary(report) {
  const u = repoData();
  const out = [renderHeader(report, u), ''];
  const k = report.counts;

  const atRisk = report.unique.filter((u) => u.uncommittedOnlyCount > 0);
  const uniqueCommitted = report.unique.filter(
    (u) => u.uncommittedOnlyCount === 0 && u.uniqueSymbolCount > 0,
  );

  const note = noSiblingsNote(report);
  if (note) { out.push(note, ''); }

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
    for (const r of atRisk.slice(0, 12)) {
      out.push(
        `  ${u.cell(r.id, 34, ID)} ${bar(r.uncommittedOnlyCount, max, 14)} ` +
        `${padStart(r.uncommittedOnlyCount, 4)} ${c('grey', 'uncommitted-only symbol(s)')}`,
      );
      const sample = [...r.byLayer.uncommitted, ...r.byLayer.untracked].slice(0, 3);
      if (sample.length) {
        out.push(c('grey', `     ${sample.map((s) => `${u.take(s.kind)}:${u.take(s.name, ID)}`).join('  ')}`));
      }
    }
    if (atRisk.length > 12) out.push(c('grey', `  … and ${atRisk.length - 12} more`));
  }

  out.push(...stashSection(report, u));

  if (report.collisions.length) {
    out.push('', c('bold', 'COLLISIONS'));
    out.push('');
    for (const col of report.collisions.slice(0, 8)) {
      const sev = col.severity === 'high' ? c('red', 'HIGH') : col.severity === 'medium' ? c('yellow', 'MED ') : c('grey', 'LOW ');
      const proof = col.kind === 'proven' ? c('red', '[proven]') : c('grey', '[predicted]');
      out.push(`  ${sev} ${proof} ${u.take(col.a, ID)} ${c('grey', '<->')} ${u.take(col.b, ID)}`);
      out.push(c('grey', `       ${u.take(col.why)}`));
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
    for (const s of report.skipped.slice(0, 6)) out.push(c('grey', `  ${u.cell(s.id, 34, ID)} ${u.take(s.reason)}`));
    if (report.skipped.length > 6) out.push(c('grey', `  … and ${report.skipped.length - 6} more`));
  }

  out.push(...provenanceLines(u));
  out.push('');
  return out.join('\n');
}

/**
 * THE STASH — a REPOSITORY-level section, deliberately not a workstream row.
 *
 * This is what would have made the reported incident visible. Sweep work into the stash and every
 * other block goes quiet in the same instant: the worktree is byte-clean, so it holds no unique
 * work, is not at risk, and is provably disposable. Each of those is true about the worktree and
 * together they are a report claiming the repository holds nothing unrecoverable while a stash
 * commit holds the only copy of it.
 *
 * A stash has no path, no branch and nothing to land, so it gets its own lines rather than a
 * fabricated row in a list that `gate`, `rescue` and `clean` all act on.
 *
 * A FUNCTION, NOT AN INLINE BLOCK, because both renderers that describe risk have an early return
 * for "no workstream rows to show" — and that early return is reached in EXACTLY the swept-stash
 * case. Written inline once, the section sat below the return that the incident triggers, which
 * is a stash warning that appears in every situation except the one it was written for.
 *
 * ONLY WHEN THERE IS SOMETHING TO SAY: entries whose content a ref already holds are not printed.
 * `git stash apply` + commit makes an entry harmless, and a section that keeps shouting after
 * that teaches the reader to skip it.
 */
function stashSection(report, u) {
  const stash = report.stash;
  if (!stash || (!stash.atRisk.length && stash.checked)) return [];
  const out = ['', c('bold', 'STASH — held by no worktree, and by no ref either'), ''];
  if (!stash.checked) {
    out.push(c('yellow', "  holt could not fully check this repository's stash — treat its entries as holding unique work"));
  }
  for (const e of stash.atRisk.slice(0, 6)) {
    // A stash MESSAGE is free text the attacker writes: `git stash push -m` takes anything,
    // newlines included. It is printed here verbatim and reaches an agent through `holt risk`.
    out.push(
      `  ${u.cell(e.selector, 14, ID)} ${padStart(e.uniqueCount, 4)} ` +
      `${c('grey', 'file(s) whose content no ref holds')}  ${c('grey', u.take(e.message))}`,
    );
    const sample = e.unique.slice(0, 3).map((x) => `${u.take(x.path, ID)} (${u.take(x.layer)})`);
    if (sample.length) out.push(c('grey', `     ${sample.join('  ')}`));
  }
  if (stash.atRisk.length > 6) out.push(c('grey', `  … and ${stash.atRisk.length - 6} more`));
  out.push('');
  out.push(c('grey', `  ${stashRecoveryGuidance()}`));
  out.push(c('grey', '  until then `git stash drop`/`clear` destroys them and git cannot bring them back.'));
  return out;
}

/** Does the stash hold content no ref holds? The one fact that can falsify "nothing unique". */
function stashHoldsUnique(report) {
  return !!report.stash && (report.stash.atRisk.length > 0 || report.stash.checked === false);
}

export function renderRisk(report) {
  const u = repoData();
  const out = [renderHeader(report, u), ''];
  out.push(c('bold', 'UNIQUE WORK  —  what has no durable copy elsewhere'));
  out.push('');
  // Include FILE-level risk, not only symbol-level. A worktree whose entire content is an
  // untracked notes.md has no extractable symbols, and filtering on symbols alone printed
  // "Nothing unique anywhere" for exactly the case this tool exists to catch — while `gate`
  // was simultaneously refusing to call it safe. The report must never contradict the guard.
  const rows = report.unique.filter((r) => r.uniqueSymbolCount > 0 || r.committedFiles > 0
    || r.uncommittedOnlyCount > 0);
  if (!rows.length) {
    // "Nothing unique anywhere" is a VERDICT — it means every workstream was checked and each
    // one was reproducible from base. With zero workstreams scanned there was no checking to do,
    // and printing the verdict anyway reads as "holt looked and this repo is fine" to someone who
    // has simply not created a second worktree yet. Say THAT instead.
    //
    // AND THE VERDICT IS ABOUT WORKSTREAMS, WHICH IS NOT THE SAME AS "ABOUT THIS REPOSITORY".
    // The swept-stash case lands here with every workstream genuinely reproducible from base and
    // the only copy of real work sitting in a stash commit — so the green line was literally true
    // about what it measured and read as an all-clear about something else. It is qualified when
    // the stash holds content no ref holds, and the section still prints. This early return is
    // precisely the path the incident takes; a stash section below it would never have run.
    const note = noSiblingsNote(report);
    if (note) {
      out.push(note, ...primaryCaveat(report, u), ...stashSection(report, u), ...provenanceLines(u), '');
      return out.join('\n');
    }
    out.push(stashHoldsUnique(report)
      ? c('yellow', '  No WORKSTREAM holds unique work — but the stash does, and no ref holds that content.')
      : c('green', '  Nothing unique anywhere. Every workstream is reproducible from base.'));
    out.push(...primaryCaveat(report, u));
    out.push(...stashSection(report, u));
    out.push(...provenanceLines(u));
    out.push('');
    return out.join('\n');
  }
  out.push(c('grey', `  ${pad('workstream', 34)} ${padStart('uniq', 5)} ${padStart('uncomm', 7)}  verdict`));
  for (const r of rows.slice(0, 40)) {
    const flag = r.uncommittedOnlyCount > 0 ? c('red', '●') : r.uniqueSymbolCount > 0 ? c('yellow', '●') : c('grey', '●');
    out.push(
      `  ${flag} ${u.cell(r.id, 32, ID)} ${padStart(r.uniqueSymbolCount, 5)} ${padStart(r.uncommittedOnlyCount, 7)}  ${c('grey', u.take(r.verdict))}`
      + (r.uniqueSymbolCount === 0 && r.uncommittedFileCount > 0
        ? c('grey', `\n      ${r.uncommittedFileCount} uncommitted file(s) with no parseable symbols — still lost if deleted`)
        : '')
      // THE 'uniq' COLUMN CAN BE A FLOOR, NOT A TOTAL. ctagsBatch names every file it could not
      // read (a NUL byte tripping the content classifier, a file over the size cap, a timeout) in
      // `symbolsUnmeasuredFiles` — say so here, or the number above reads as a complete count when
      // it may be an undercount that safeToDelete is already refusing to trust.
      + (r.redundantWith?.length
        ? c('grey', `\n      identical content is also currently held by ${r.redundantWith.slice(0, 3).map((id) => u.take(id, ID)).join(', ')}`
          + `${r.redundantWith.length > 3 ? ` and ${r.redundantWith.length - 3} more` : ''}`
          + `${r.redundantWithDurable?.length ? '' : '; no durable copy is proven in those holders'}`)
        : '')
      + (r.symbolsUnmeasuredCount > 0
        ? c('yellow', `\n      ${r.symbolsUnmeasuredCount} file(s) holt could not read symbols from `
          + `(e.g. ${(r.symbolsUnmeasuredFiles ?? []).slice(0, 3).map((f) => u.take(f, ID)).join(', ')}) — 'uniq' is a floor, not a total`)
        : ''),
    );
  }
  // A SILENTLY TRUNCATED AT-RISK LIST IS THE ONE TRUNCATION THAT COSTS WORK.
  //
  // This is the table a reader scans to decide what must not be deleted, and it stopped at 40 with
  // no counter and no total in its header — so on a repository with more than 40 workstreams
  // holding work found nowhere else, the rest simply were not there, and a complete-looking list
  // said so. Identical in shape to the defect commit 13dc53a13 fixed in the TUI and to the session
  // brief that counted 8 and named 5; this is the third surface, and the highest-stakes one.
  if (rows.length > 40) {
    out.push(c('yellow', `  … and ${rows.length - 40} more workstream(s) hold work found nowhere else `
      + `— \`holt risk --json\` lists every one`));
  }
  out.push('');
  out.push(c('bold', 'DISPOSABLE'));
  out.push('');
  const safe = report.safe.filter((s) => s.safe);
  if (!safe.length) out.push(c('grey', '  none — every workstream holds something'));
  for (const s of safe.slice(0, 30)) out.push(`  ${c('green', '✓')} ${u.cell(s.id, 40, ID)} ${c('grey', u.take(s.confidence))}`);
  if (safe.length > 30) out.push(c('grey', `  … and ${safe.length - 30} more`));

  const unknown = report.safe.filter((s) => s.confidence === 'unknown');
  if (unknown.length) {
    out.push('', c('yellow', `UNKNOWN (${unknown.length}) — holt could not scan these, so they are NOT safe`));
    for (const s of unknown.slice(0, 10)) out.push(c('grey', `  ? ${u.cell(s.id, 40, ID)} ${u.take(s.reasons[0])}`));
    // The header carries the total, so this is not invisible — but a reader following the LIST
    // still needs to be told the list stopped, not just that the count was larger.
    if (unknown.length > 10) out.push(c('grey', `  … and ${unknown.length - 10} more`));
  }
  // THE CAVEAT BELONGS ON THE PATH PEOPLE ACTUALLY READ, TOO.
  //
  // Both calls to primaryCaveat() sat in the EMPTY-findings branch above, so "a dirty unscanned
  // primary is named beside every verdict that could read as 'holt checked everything'" was true
  // of the all-clear and false of every report with findings in it — which is the report anyone
  // with a fan-out running actually looks at. Reproduced: a repo with one sibling holding one
  // uncommitted symbol and a primary holding another printed the sibling's row and said nothing
  // whatsoever about the primary's, with no caveat anywhere in the output.
  const caveat = primaryCaveat(report, u);
  if (caveat.length) out.push('', ...caveat);
  out.push(...provenanceLines(u));
  out.push('');
  return out.join('\n');
}

/** One line per contested FILE, instead of one per pair — N pairs collapse to one finding. */
function hotspotLines(report, u) {
  const hs = report.hotspots ?? [];
  if (!hs.length) return [];
  const out = ['', c('bold', 'SHARED FILES  —  no symbol overlap, but the same file'), ''];
  for (const h of hs.slice(0, 12)) {
    out.push(`  ${c('yellow', '▪')} ${u.take(h.file, ID)}  ${c('grey', `${h.count} workstreams: ${h.workstreams.slice(0, 4).map((w) => u.take(w, ID)).join(', ')}${h.workstreams.length > 4 ? '…' : ''}`)}`);
  }
  out.push(c('grey', '  these are sequenced serially by `holt order`; use --all to list every pair'));
  return out;
}

/**
 * THE ONE RENDERER WITH NO ROW BOUND. Every other section here stops at 8, 12, 25, 30 or 40 rows
 * and says "… and N more"; this one printed every collision, and the repository decides how many
 * there are. On a real repo holt reported 88, at four lines each — with names the repository also
 * chooses. That is the flooding vector: holt's genuine warning ends up thousands of lines above
 * whatever the agent is still holding. The BUDGET is the general fix (repo text is capped in
 * total, and the withholding is announced), and the row bound below is the same file's own
 * established convention applied to the section that was missing it.
 */
const MAX_COLLISION_ROWS = 40;

export function renderHotspots(report, limit = 12) {
  const u = repoData();
  const rows = report.hotspots ?? [];
  const shown = rows.slice(0, limit);
  const out = [c('bold', `HOTSPOTS (${rows.length}) — files shared by multiple workstreams`), ''];
  if (!rows.length) out.push(c('green', '  No low-evidence shared-file hotspots were measured.'));
  for (const h of shown) {
    out.push(`  ${u.take(h.file, ID)}  ${h.count} workstream(s): `
      + h.workstreams.map((id) => u.take(id, ID)).join(', '));
  }
  if (rows.length > shown.length) {
    out.push(c('grey', `  … and ${rows.length - shown.length} more — use 'holt hotspots --json --limit 100' for the bounded full list`));
  }
  out.push(c('grey', '  This is aggregated file overlap, not a proven merge conflict; use it before partitioning.'));
  out.push(...provenanceLines(u));
  out.push('');
  return out.join('\n');
}

export function renderCollisions(report) {
  const u = repoData();
  const out = [renderHeader(report, u), ''];
  if (!report.collisions.length) {
    out.push(c('green', 'No collisions. No two workstreams contest the same content.'));
    out.push(...hotspotLines(report, u));
    out.push(...provenanceLines(u));
    out.push('');
    return out.join('\n');
  }
  out.push(c('bold', `COLLISIONS (${report.collisions.length})`), '');
  for (const col of report.collisions.slice(0, MAX_COLLISION_ROWS)) {
    const sev = col.severity === 'high' ? c('red', 'HIGH') : col.severity === 'medium' ? c('yellow', 'MED ') : c('grey', 'LOW ');
    const proof = col.kind === 'proven' ? c('red', 'proven by merge-tree') : c('grey', 'predicted');
    out.push(`${sev}  ${c('bold', u.take(col.a, ID))} ${c('grey', '<->')} ${c('bold', u.take(col.b, ID))}  ${col.sameFamily ? c('grey', '(same family)') : c('yellow', '(cross-dispatch)')}`);
    out.push(`      ${proof} ${c('grey', '·')} ${u.take(col.why)}`);
    out.push(c('grey', `      files: ${col.sharedFiles.slice(0, 4).map((f) => u.take(f, ID)).join(', ')}${col.sharedFiles.length > 4 ? ` … +${col.sharedFiles.length - 4}` : ''}`));
    if (col.sharedSymbols.length) {
      out.push(c('grey', `      symbols: ${col.sharedSymbols.slice(0, 5).map((s) => u.take(s, ID)).join(', ')}${col.sharedSymbols.length > 5 ? ' …' : ''}`));
    }
    out.push('');
  }
  if (report.collisions.length > MAX_COLLISION_ROWS) {
    out.push(c('grey', `  … and ${report.collisions.length - MAX_COLLISION_ROWS} more — \`holt collisions --json\` lists every pair`), '');
  }
  out.push(...provenanceLines(u));
  return out.join('\n');
}

const MAX_DUPLICATE_ROWS = 25;

export function renderDuplicates(report, deep) {
  const u = repoData();
  const out = [renderHeader(report, u), ''];
  out.push(c('bold', `DUPLICATE WORK — symbol identity (${report.duplicates.length} pair(s))`), '');
  if (!report.duplicates.length) out.push(c('grey', '  none'));
  for (const d of report.duplicates.slice(0, MAX_DUPLICATE_ROWS)) {
    const tag = d.sameFamily ? c('grey', 'expected fan-out') : c('yellow', 'CROSS-DISPATCH WASTE');
    out.push(`  ${c('bold', u.take(d.a, ID))} ${c('grey', '<->')} ${c('bold', u.take(d.b, ID))}  ${tag}`);
    out.push(c('grey', `      ${d.sharedCount} shared symbol(s), similarity ${(d.similarity * 100).toFixed(0)}%: ${d.sharedSymbols.slice(0, 4).map((s) => u.take(s, ID)).join(', ')}`));
  }
  if (report.duplicates.length > MAX_DUPLICATE_ROWS) {
    out.push(c('grey', `  … and ${report.duplicates.length - MAX_DUPLICATE_ROWS} more — use 'holt duplicates --json' for every measured pair`));
  }

  if (deep) {
    out.push('', c('bold', 'DEEP — token clone detection'), '');
    if (!deep.ran) {
      out.push(c('yellow', `  did not run: ${u.take(deep.reason)}`));
    } else if (!deep.pairs.length) {
      out.push(c('grey', `  ${u.take(deep.tool)} compared ${deep.filesCompared ?? 0} added-line file(s), found no cross-workstream clones`));
    } else {
      out.push(c('grey', `  ${u.take(deep.tool)} · ${deep.clones} clone(s) across ${deep.filesCompared} added-line file(s)`), '');
      for (const p of deep.pairs.slice(0, 15)) {
        const tag = p.sameFamily ? c('grey', 'expected fan-out') : c('yellow', 'CROSS-DISPATCH WASTE');
        out.push(`  ${c('bold', u.take(p.a, ID))} ${c('grey', '<->')} ${c('bold', u.take(p.b, ID))}  ${tag}`);
        out.push(c('grey', `      ${p.duplicatedLines} duplicated line(s) in ${p.cloneCount} clone(s)`));
      }
    }
  }
  out.push(...provenanceLines(u));
  out.push('');
  return out.join('\n');
}

export function renderPlan(report) {
  const u = repoData();
  const out = [renderHeader(report, u), ''];
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
    for (const d of p.drop.slice(0, 20)) out.push(c('grey', `  ✓ ${u.take(d.id, ID)}`));
    if (p.drop.length > 20) out.push(c('grey', `  … and ${p.drop.length - 20} more`));
    out.push('');
  }
  if (p.collapse.length) {
    out.push(c('magenta', `COLLAPSE (${p.collapse.length}) — duplicate of another dispatch`));
    for (const x of p.collapse) out.push(c('grey', `  ${u.take(x.id, ID)} → ${u.take(x.into, ID)}`));
    out.push('');
  }
  out.push(c('bold', `LAND IN THIS ORDER (${p.order.length}) — least entangled first`));
  out.push('');
  for (const s of p.order.slice(0, 30)) {
    out.push(
      `  ${padStart(s.step, 3)}. ${u.cell(s.id, 34, ID)} ` +
      c('grey', `${s.filesToReview} file(s) · ${s.uniqueSymbols} unique · entanglement ${s.entanglement}`),
    );
  }
  if (p.order.length > 30) out.push(c('grey', `  … and ${p.order.length - 30} more`));
  out.push('', c('grey', `  ${p.note}`));
  out.push(...provenanceLines(u));
  out.push('');
  return out.join('\n');
}

export function renderCollapse(plan) {
  const u = repoData();
  const rows = plan.supersededBy ?? plan.collapse ?? [];
  const out = [c('bold', `SUPERSEDED WORKSTREAMS (${rows.length})`), ''];
  if (!rows.length) out.push(c('grey', '  none — no exact, durable duplicate has earned a recommendation'));
  for (const row of rows.slice(0, 40)) {
    out.push(`  ${u.take(row.id, ID)} ${c('grey', '→')} ${u.take(row.into, ID)} `
      + c('grey', `(${row.confidence ?? 'measured'} · ${(Number(row.similarity ?? 1) * 100).toFixed(0)}% identical)`));
    out.push(c('grey', `      ${u.take(row.why)}`));
  }
  if (rows.length > 40) out.push(c('grey', `  … and ${rows.length - 40} more`));
  out.push(c('grey', '  Review the representative; this is advisory and does not delete or merge anything.'));
  out.push(...provenanceLines(u));
  out.push('');
  return out.join('\n');
}

export function renderImpact(imp) {
  const u = repoData();
  const out = [];
  out.push(c('bold', 'CROSS-WORKSTREAM IMPACT') + c('grey', '  — dependency, NOT conflict'));
  out.push('');
  out.push(c('grey', `  ${imp.tool ? u.take(imp.tool) : 'no reference search available'}`));
  out.push('');

  if (!imp.pairs.length) {
    out.push(c('green', '  No workstream references a symbol another workstream defines.'));
    out.push('');
    for (const cav of imp.caveats) out.push(c('grey', `  · ${cav}`));
    out.push(...provenanceLines(u));
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
    out.push(`  ${conf}  ${c('bold', u.take(p.producer, ID))} ${c('grey', 'defines →')} ${c('bold', u.take(p.consumer, ID))} ${c('grey', 'uses')}`);
    const shown = p.unambiguousSymbols.length ? p.unambiguousSymbols : p.symbols;
    out.push(c('grey', `        ${shown.slice(0, 6).map((s) => u.take(s, ID)).join(', ')}${p.symbolCount > 6 ? ` … +${p.symbolCount - 6}` : ''}`));
    out.push(c('grey', `        defined in: ${p.definedIn.slice(0, 2).map((f) => u.take(f, ID)).join(', ')}`));
  }
  if (imp.pairs.length > 20) out.push(c('grey', `  … and ${imp.pairs.length - 20} more`));

  out.push('');
  out.push(c('bold', '  WHAT THIS DOES AND DOES NOT TELL YOU'));
  for (const cav of imp.caveats) out.push(c('grey', `  · ${cav}`));
  out.push(...provenanceLines(u));
  out.push('');
  return out.join('\n');
}

export function renderContext(digest) {
  const u = repoData();
  if (!digest.ok) {
    // THE ERROR PATH IS AN INJECTION PATH TOO. `digest.error` names the workstream the user asked
    // for and `known` lists every id in the repository, so `holt context <anything>` in a hostile
    // clone printed the full attacker-chosen name list through a branch nothing else guards.
    return [
      c('red', `holt: ${u.take(digest.error)}`),
      c('grey', `known: ${digest.known.map((k) => u.take(k, ID)).join(', ')}`),
      ...provenanceLines(u),
    ].join('\n');
  }
  const out = [];
  // Translate the family rule into a human-readable hint. "creation-burst" means workstreams
  // created close together in time; "name-fallback" means grouped by name stem; "user-override"
  // means the user's .holtrc.json set it explicitly.
  const ruleHint = digest.familyRule === 'creation-burst' ? 'created close together'
    : digest.familyRule === 'user-override' ? 'grouped by .holtrc.json'
    : digest.familyRule === 'name-fallback' ? 'grouped by name stem'
    : digest.familyRule;
  out.push(c('bold', `CONTEXT for ${u.take(digest.workstream, ID)}`) + c('grey', `  (sibling group: ${u.take(ruleHint)})`));
  out.push('');
  if (digest.siblings.length) out.push(c('grey', `  siblings: ${digest.siblings.map((s) => u.take(s, ID)).join(', ')}`), '');
  // `advice` is holt's sentence with repository names interpolated INTO it upstream, in
  // src/analyze.mjs — so by the time it arrives here it is one string and the boundary can only
  // treat the whole line as repository data. That is correct but coarse; the residual note in the
  // patch asks buildAdvice() to mark the names at the point it interpolates them, which is the
  // only place the two can still be told apart.
  for (const a of digest.advice) out.push(`  ${c('yellow', '!')} ${u.take(a, { max: 600 })}`);
  out.push('');
  if (digest.duplicatedSymbols.length) {
    out.push(c('bold', '  ALREADY BUILT NEXT DOOR'));
    for (const d of digest.duplicatedSymbols) {
      out.push(`    ${u.cell(d.workstream, 30, ID)} ${d.count} ${c('grey', d.symbols.slice(0, 4).map((s) => u.take(s, ID)).join(', '))}`);
    }
    out.push('');
  }
  if (digest.contestedFiles.length) {
    out.push(c('bold', '  CONTESTED FILES'));
    for (const f of digest.contestedFiles) {
      out.push(`    ${u.cell(f.workstream, 30, ID)} ${f.fileCount} ${f.hasUncommitted ? c('yellow', '(uncommitted)') : ''}`);
      out.push(c('grey', `      ${f.files.slice(0, 3).map((x) => u.take(x, ID)).join(', ')}`));
    }
    out.push('');
  }
  out.push(...provenanceLines(u));
  return out.join('\n');
}

/* ------------------------------------------------------------ moved here to be under the gate -- */

/**
 * `holt order`, `holt partition` and `holt branches` used to be rendered INLINE in bin/holt.mjs's
 * dispatcher, and that placement was the whole bug: bin/holt.mjs exports nothing, so the gate in
 * test/unit/untrusted.test.mjs — which enumerates every export of this file and drives it with a
 * report whose every string is a payload — could not see them. Measured on one hostile repository
 * with a newline in a worktree basename: `holt collisions` fenced the name correctly while
 * `holt order` and `holt partition` each printed a free-standing forged `[holt] …` line.
 *
 * They are functions here, not statements there, for exactly one reason: so the gate enumerates
 * them. The rule the gate enforces is "no repository value reaches a line except through the
 * budget", and the only way to keep that rule honest is for every renderer to be reachable from
 * one place that can be enumerated.
 */
export function renderOrder(plan) {
  const u = repoData();
  const out = [c('bold', 'holt order') + c('grey', '  (heuristic — conflictsWithLater names the merges to watch)')];
  if (plan.excluded?.length) {
    out.push(c('yellow', `\n  EXCLUDED FROM LANDING (${plan.excluded.length})`)
      + c('grey', '  primary, disposable, or non-exact work is evidence—not a parallel landing candidate'));
    for (const item of plan.excluded.slice(0, 12)) {
      out.push(`    ${u.take(item.id, ID)}  ${c('grey', u.take(item.reason))}`);
    }
    if (plan.excluded.length > 12) out.push(c('grey', `    … and ${plan.excluded.length - 12} more`));
  }
  if (plan.parallel.length) {
    out.push(`\n  PARALLEL-SAFE  ${c('grey', 'no observed interaction — land in any order, concurrently')}`);
    for (const id of plan.parallel) out.push(`    ${c('green', u.take(id, ID))}`);
  }
  for (const lane of plan.lanes) {
    out.push(`\n  LANE (${lane.members.length} entangled)`);
    lane.order.forEach((step, i) => {
      const later = step.conflictsWithLater
        .map((x) => `${u.take(x.id, ID)} (${x.why.map((w) => u.take(w)).join('; ')})`).join(', ');
      out.push(`    ${i + 1}. ${u.take(step.id, ID)}${later ? c('yellow', `  → watch: ${later}`) : c('green', '  → clears the lane')}`);
    });
  }
  out.push(...provenanceLines(u));
  out.push('');
  return out.join('\n');
}

export function renderPartition(plan) {
  const u = repoData();
  const out = [c('bold', `holt partition — ${plan.agents} agents`)
    + c('grey', `  (${plan.granularity ?? 'top-level-directory'} · structural advisory, not a task plan)`)];
  if (plan.taskContext?.status === 'insufficient_task_context') {
    out.push(c('yellow', '\n  INSUFFICIENT TASK CONTEXT')
      + c('grey', ' — no task paths/components were supplied; these buckets describe repository shape only.'));
    out.push(c('grey', '  Supply --path/--component, or keep this explicitly as the advanced structural view.'));
  } else if (plan.taskContext?.status === 'unresolved') {
    out.push(c('yellow', '\n  TASK ANCHORS UNRESOLVED')
      + c('grey', ` — none matched: ${plan.taskContext.unmatched.map((x) => u.take(x, ID)).join(', ')}`));
  } else if (plan.taskContext?.status === 'partial') {
    out.push(c('yellow', '\n  TASK SCOPE PARTIAL')
      + c('grey', ` — ${plan.taskContext.matchedFiles} tracked file(s) matched; unresolved: ${plan.taskContext.unmatched.map((x) => u.take(x, ID)).join(', ')}`));
  } else if (plan.taskContext?.status === 'provided') {
    out.push(c('green', `\n  TASK SCOPE`) + c('grey', ` — ${plan.taskContext.matchedFiles} tracked file(s) matched the supplied anchors`));
  }
  for (const b of plan.buckets) {
    out.push(`\n  AGENT ${b.agent}  ${c('grey', `${b.weight} tracked file(s)`)}`);
    // A directory name is repository-controlled in exactly the way a worktree basename is.
    out.push(`    ${b.dirs.map((d) => u.take(d, ID)).join('  ')}`);
  }
  if (plan.avoid.length) {
    out.push(`\n  ${c('yellow', 'ALREADY CONTESTED')}  ${c('grey', 'one owner each — currently touched by multiple live workstreams')}`);
    for (const a of plan.avoid.slice(0, 15)) {
      const held = a.currentlyHeldBy.map((h) => u.take(h, ID)).join(', ');
      out.push(`    ${u.take(a.file, ID)}  ${c('grey', `held by ${held}`)}  → agent ${a.assignTo ?? '?'}`);
    }
    // A partitioning plan read as complete is a plan that assigns contested files to nobody.
    if (plan.avoid.length > 15) {
      out.push(c('grey', `    … and ${plan.avoid.length - 15} more contested file(s) — 'holt partition --json' lists every one`));
    }
  }
  out.push(...provenanceLines(u));
  out.push('');
  return out.join('\n');
}

export function renderBranches(audit) {
  const u = repoData();
  const base = audit.base.ref ? u.take(audit.base.ref, ID) : String(audit.base.oid).slice(0, 12);
  const checkedOut = audit.checkedOut ?? audit.excludedCheckedOut ?? [];
  const checked = checkedOut.length
    ? checkedOut.map((x) => u.take(x, ID)).join(', ') : 'none';
  const out = [c('bold', 'holt branches')
    + c('grey', `  vs ${base} · ${audit.audited} audited · checked-out report-only: ${checked}`)];
  const section = (label, items, colour) => {
    if (!items.length) return;
    out.push(`\n  ${c(colour, label)}`);
    for (const b of items) {
      out.push(`    ${u.take(b.name, ID)}  ${c('grey', u.take(b.reason))}`);
      // `command` is holt's own sentence with a branch name interpolated upstream; the boundary
      // can only treat the assembled string as repository data, and it does.
      if (b.command) out.push(`      ${c('grey', '$')} ${u.take(b.command)}`);
      if (b.files) {
        out.push(`      ${c('grey', b.files.slice(0, 5).map((f) => u.take(f, ID)).join(', ')
          + (b.fileCount > 5 ? ` … +${b.fileCount - 5}` : ''))}`);
      }
    }
  };
  section(`LANDED — safe to delete (${audit.landed.length})`, audit.landed, 'green');
  section(`CONTENT-LANDED — evidence says landed, git ancestry says no (${audit.contentLanded.length})`, audit.contentLanded, 'yellow');
  section(`UNLANDED — holds work (${audit.unlanded.length})`, audit.unlanded, 'red');
  section(`UNKNOWN — instrument failed, refusing to classify (${audit.unknown.length})`, audit.unknown, 'red');
  if (audit.applied.length) {
    out.push('\n  APPLIED');
    for (const a of audit.applied) {
      out.push(`    ${u.take(a.name, ID)}  ${a.ok ? c('green', 'deleted (-d)') : c('red', `refused: ${u.take(a.error)}`)}`);
    }
  }
  out.push(`\n  ${c('grey', audit.note)}`);
  out.push(...provenanceLines(u));
  out.push('');
  return out.join('\n');
}
