// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — the relationship graph and the decisions that fall out of it.
 *
 * This is the layer that does not exist anywhere else. Verified against the closest prior
 * art: treehouse-worktree (MCP) exposes create/list/status/remove/lock/conflicts and treats
 * each worktree as independent; gwq shows per-worktree status only; Vibe Kanban / Conductor /
 * Superset / Nimbalyst model a worktree as a session card. The published worktree-comparison
 * skills are interactive PAIRWISE diff viewers ("compare this worktree with my workspace").
 * None of them relate N workstreams to each other by CONTENT.
 *
 * Five of the seven documented parallel-agent problems reduce to one query — what is the
 * content relationship between N workstreams — so they are answered from one graph:
 *
 *   P0 invisible/lost work   -> uniqueWork()      "this exists nowhere else"
 *   P1 hotspot collision     -> collisions()      "these two will fight"
 *   P2 context blindness     -> contextDigest()   "here's what your siblings did"
 *   P3 redundant work        -> duplicates()      "these two built the same thing"
 *   P6 safe deletion         -> safeToDelete()    "this one is provably disposable"
 *
 * P5 (review bottleneck) is served by landingPlan(), which orders and deduplicates rather
 * than reviewing. P4 (semantic conflict) is deliberately NOT attempted: it is unresolved
 * research, and a confident wrong answer there is worse than no answer.
 */

import { git, pmap } from './git.mjs';
import { symbolKey } from './symbols.mjs';

/* ------------------------------------------------------------------ helpers ---- */

const setOf = (arr) => new Set(arr);

function intersect(aSet, bArr) {
  const out = [];
  for (const x of bArr) if (aSet.has(x)) out.push(x);
  return out;
}

/**
 * DISCRIMINATIVE SYMBOLS — the filter that makes pair findings usable.
 *
 * MEASURED on a real 39-workstream repository: the unfiltered run reported 628 collisions and
 * 685 duplicate pairs. Nearly all of them were driven by symbols like `generatedAt`, `head`
 * and `$comment` — JSON metadata keys that appear in every receipt file in the repo. Every
 * workstream "shares" them with every other, so they generate a near-complete graph carrying
 * no information. 628 findings and 6 real ones are worse than useless: the real ones are
 * unreachable.
 *
 * The fix is inverse document frequency, not a blocklist. A symbol present in many workstreams
 * is boilerplate BY DEFINITION — no list of known-bad names is needed, and none has to be
 * maintained as new frameworks invent new metadata keys. This generalises to repos we have
 * never seen, which a curated list never would.
 *
 * Threshold: a symbol carried by more than 25% of live workstreams (minimum 3) is boilerplate.
 * Deliberately generous — with 4 workstreams nothing is filtered unless all but one share it.
 *
 * This filters the EVIDENCE for pair findings only. Per-workstream `added` lists keep every
 * symbol, because "what did this workstream contribute" is a different question from "what do
 * these two have in common".
 */
export function discriminativeSymbols(live, { maxShareRatio = 0.25, floor = 3 } = {}) {
  const owners = new Map();
  for (const w of live) {
    for (const k of w.addedKeys ?? []) owners.set(k, (owners.get(k) ?? 0) + 1);
  }
  const limit = Math.max(floor, Math.ceil(live.length * maxShareRatio));

  const keep = new Set();
  const dropped = [];
  for (const [k, n] of owners) {
    if (n <= limit) keep.add(k);
    else dropped.push({ symbol: k, workstreams: n });
  }
  dropped.sort((a, b) => b.workstreams - a.workstreams);
  return { keep, dropped, limit };
}

/** A workstream's added keys, restricted to the discriminative ones. */
function discriminativeKeys(w, keep) {
  return (w.addedKeys ?? []).filter((k) => keep.has(k));
}

/** Pairs of workstreams that share at least one touched file. The collision prefilter. */
export function overlappingPairs(workstreams) {
  // Invert to file -> [workstream index], so we never do the full O(n^2) comparison.
  const byFile = new Map();
  workstreams.forEach((w, i) => {
    for (const f of w.touched ?? []) {
      if (!byFile.has(f)) byFile.set(f, []);
      byFile.get(f).push(i);
    }
  });

  const pairKey = (i, j) => (i < j ? `${i}:${j}` : `${j}:${i}`);
  const pairs = new Map();
  for (const [file, idxs] of byFile) {
    if (idxs.length < 2) continue;
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        const k = pairKey(idxs[a], idxs[b]);
        if (!pairs.has(k)) pairs.set(k, { i: Math.min(idxs[a], idxs[b]), j: Math.max(idxs[a], idxs[b]), files: [] });
        pairs.get(k).files.push(file);
      }
    }
  }
  return [...pairs.values()];
}

/* ------------------------------------------------------ P0: unique work ---- */

/**
 * What would be LOST if this workstream vanished?
 *
 * A symbol is unique to W when no other workstream added it and base does not have it.
 * (Base-absence is already guaranteed: `added` is computed as head-minus-base.)
 *
 * This is the finding that justified the tool. In one measured 39-worktree repository the
 * committed layer flagged 4 workstreams as interesting, while the uncommitted layer held
 * configuration keys that existed in no other tree. Both layers feed this function, which is
 * the entire point.
 */
export function uniqueWork(scanResult) {
  const live = scanResult.workstreams.filter((w) => w.ok);

  const symbolOwners = new Map(); // symbolKey -> [workstream id]
  for (const w of live) {
    for (const k of w.addedKeys ?? []) {
      if (!symbolOwners.has(k)) symbolOwners.set(k, []);
      symbolOwners.get(k).push(w.id);
    }
  }

  return live
    .map((w) => {
      const uniqueSymbols = (w.addedKeys ?? []).filter((k) => symbolOwners.get(k).length === 1);
      const byLayer = { committed: [], uncommitted: [], untracked: [] };
      const uniqueSet = setOf(uniqueSymbols);
      for (const s of w.added ?? []) {
        if (!uniqueSet.has(symbolKey(s))) continue;
        const layer = w.committed.files.includes(s.file)
          ? 'committed'
          : w.uncommitted.untracked.includes(s.file)
            ? 'untracked'
            : 'uncommitted';
        byLayer[layer].push({ ...s, key: symbolKey(s) });
      }

      // Work that only exists uncommitted is the highest-risk class: git itself cannot
      // relate it, so nothing else in the user's toolchain will warn before it is deleted.
      //
      // COUNT FILES, NOT ONLY SYMBOLS. Symbol extraction finds nothing in notes.md, a .env, a
      // CSV, a design asset or any file whose language has no parser — so a symbol-only count
      // reported "0 at risk" for a worktree whose entire content was an untracked file. That is
      // precisely the case this product exists for (the marquee anecdote is an agent deleting
      // worktrees that "only contained untracked files"), and `gate` already refused to call it
      // safe. The report must not contradict the guard: uncommitted FILES are risk on their own,
      // whether or not a parser can see inside them.
      const uncommittedFileCount = w.uncommitted?.count ?? 0;
      const atRiskSymbols = byLayer.uncommitted.length + byLayer.untracked.length;
      const atRisk = Math.max(atRiskSymbols, uncommittedFileCount);

      return {
        id: w.id,
        path: w.path,
        family: w.family,
        uniqueSymbolCount: uniqueSymbols.length,
        uniqueSymbols,
        byLayer,
        uncommittedOnlyCount: atRisk,
        uncommittedFileCount,
        atRiskSymbolCount: atRiskSymbols,
        committedFiles: w.committed.count,
        verdict:
          atRisk > 0 ? 'unique-work-uncommitted'
            : uniqueSymbols.length > 0 ? 'unique-work-committed'
              : w.committed.count > 0 ? 'committed-delta-no-unique-symbols'
                : 'nothing-unique',
      };
    })
    .sort((a, b) => b.uncommittedOnlyCount - a.uncommittedOnlyCount || b.uniqueSymbolCount - a.uniqueSymbolCount);
}

/* ------------------------------------------------- P6: safe to delete ---- */

/**
 * Provably disposable: nothing committed that base lacks, nothing uncommitted, nothing unique.
 *
 * FAIL-CLOSED BY CONSTRUCTION. Any workstream holt could not fully scan is reported as
 * 'unknown', never as safe. Absence of evidence must produce a refusal, not a green light —
 * a cleanup tool that says "safe" because it failed to look is the worst possible defect.
 */
export function safeToDelete(scanResult, unique = null) {
  const uniq = unique ?? uniqueWork(scanResult);
  const uniqById = new Map(uniq.map((u) => [u.id, u]));

  return scanResult.workstreams.map((w) => {
    if (!w.ok) {
      return { id: w.id, path: w.path, safe: false, confidence: 'unknown', reasons: [w.reason ?? 'not scanned'] };
    }
    const u = uniqById.get(w.id);
    const reasons = [];
    if (w.committed.count > 0) reasons.push(`${w.committed.count} file(s) base lacks`);
    if (w.uncommitted.count > 0) reasons.push(`${w.uncommitted.count} uncommitted file(s)`);
    if (u && u.uniqueSymbolCount > 0) reasons.push(`${u.uniqueSymbolCount} symbol(s) found nowhere else`);
    if (w.locked) reasons.push(`locked${w.lockReason ? `: ${w.lockReason}` : ''}`);

    // GITIGNORED CONTENT DOWNGRADES THE VERDICT, it does not silently vanish from it.
    // git does not track ignored files, so holt cannot prove anything about them — but deleting
    // the worktree destroys them all the same. A `.env` of live credentials or a hand-patched
    // dependency was being called "provably nothing to lose". Recognisable build output is
    // already filtered out upstream, so what reaches here is content a human plausibly wants.
    const ignoredCount = w.ignored?.count ?? 0;
    if (ignoredCount > 0) {
      const sample = (w.ignored.files ?? []).slice(0, 3).join(', ');
      reasons.push(`${ignoredCount} gitignored file(s) holt cannot verify${sample ? ` (e.g. ${sample})` : ''}`);
    }

    return {
      id: w.id,
      path: w.path,
      family: w.family,
      safe: reasons.length === 0,
      // 'unverifiable' is distinct from 'measured': everything git CAN see is clean, but ignored
      // content means holt did not have the evidence to call it disposable.
      confidence: ignoredCount > 0 && reasons.length === 1
        ? 'unverifiable'
        : scanResult.strictReadOnly ? 'approximate' : 'measured',
      ignoredFiles: ignoredCount ? (w.ignored.files ?? []).slice(0, 10) : undefined,
      reasons: reasons.length ? reasons : ['no committed delta, no uncommitted changes, no unique symbols'],
    };
  }).sort((a, b) => Number(b.safe) - Number(a.safe));
}

/* ------------------------------------------------------- P1: collisions ---- */

/**
 * Pairs that will fight.
 *
 * Two tiers, and the distinction is reported rather than blurred:
 *
 *   PROVEN    — both sides have committed content and `merge-tree` reports a real conflict.
 *               This is git's own answer, not a heuristic.
 *   PREDICTED — the sides share a file but at least one side's changes are uncommitted, so
 *               merge-tree cannot see them. Confidence is raised when both sides added the
 *               SAME symbol, which is the registry-hotspot signature.
 *
 * We never call a predicted collision proven. The literature names "shared hotspot files
 * (routes, configs, registries)" as the top collision class, and those live overwhelmingly in
 * the uncommitted layer while an agent is still working — precisely where proof is impossible.
 */
export async function collisions(scanResult, opts = {}) {
  const { concurrency = 6, timeout = 60_000 } = opts;
  const live = scanResult.workstreams.filter((w) => w.ok);
  const pairs = overlappingPairs(live);
  const { keep } = discriminativeSymbols(live);

  const results = await pmap(
    pairs,
    async (p) => {
      const a = live[p.i];
      const b = live[p.j];

      const aKeys = setOf(discriminativeKeys(a, keep));
      const sharedSymbols = intersect(aKeys, discriminativeKeys(b, keep));

      // Can merge-tree see both sides? Only if both have committed content that base lacks.
      const bothCommitted = a.committed.count > 0 && b.committed.count > 0;
      let proven = null;
      if (bothCommitted && !scanResult.strictReadOnly && a.head && b.head) {
        const mt = await git(['merge-tree', '--write-tree', a.head, b.head], {
          cwd: scanResult.root, timeout,
        });
        if (mt.code <= 1) proven = mt.code === 1;
      }

      const uncommittedInvolved =
        a.uncommitted.count > 0 || b.uncommitted.count > 0;

      // A COLLISION REQUIRES EVIDENCE, NOT CO-LOCATION.
      //
      // Measured on a real 39-worktree repository: treating "shares a file and someone has
      // uncommitted changes" as a medium collision produced 616 findings, 313 of them with no
      // evidence beyond both sides having touched the same hot file. In a repo where 491 pairs
      // all touch one large shared config module, that is a near-complete graph. 616 findings with 6
      // real ones is strictly worse than 6, because the real ones become unreachable.
      //
      // Evidence is: git proved a conflict, OR both sides added the same discriminative symbol.
      // Bare file overlap is downgraded to 'low' and excluded from the default report — still
      // available via --all, because it is not nothing, it is just not actionable on its own.
      let severity;
      let kind;
      if (proven === true) { kind = 'proven'; severity = 'high'; }
      else if (sharedSymbols.length > 0) {
        kind = 'predicted';
        severity = uncommittedInvolved ? 'high' : 'medium';
      } else if (proven === false) { kind = 'proven-clean'; severity = 'none'; }
      else { kind = 'co-located'; severity = 'low'; }

      return {
        a: a.id, b: b.id,
        aPath: a.path, bPath: b.path,
        sameFamily: a.family === b.family,
        sharedFiles: p.files.sort(),
        sharedFileCount: p.files.length,
        sharedSymbols,
        kind,
        severity,
        mergeTreeConflict: proven,
        why:
          proven === true ? 'git merge-tree reports a real conflict between these two heads'
            : sharedSymbols.length > 0
              ? `both added the same symbol(s): ${sharedSymbols.slice(0, 3).join(', ')}${sharedSymbols.length > 3 ? '…' : ''}` +
                (uncommittedInvolved ? ' — and at least one side is uncommitted, so merge-tree cannot confirm it' : '')
              : `co-located in ${p.files.length} shared file(s), no symbol-level overlap`,
      };
    },
    concurrency,
  );

  const order = { high: 0, medium: 1, low: 2, none: 3 };
  const keepLow = opts.includeCoLocated === true;
  const ranked = results
    .filter((r) => r.severity !== 'none')
    .sort((x, y) => order[x.severity] - order[y.severity] || y.sharedSymbols.length - x.sharedSymbols.length);

  // TWO CONSUMERS, OPPOSITE ERROR COSTS — so one array cannot serve both.
  //
  // A HUMAN reading a triage surface has a hard attention budget: on a real 39-worktree repo,
  // admitting bare file overlap produced 616 findings with 6 real ones, which is strictly worse
  // than 6 because the real ones become unreachable. Precision wins; co-located pairs are hidden.
  //
  // A MACHINE sequencing a landing order has the inverse cost. A false positive costs a human
  // three seconds of "not really"; a false NEGATIVE tells `order` that two workstreams editing
  // the same file are independent, they get sequenced in parallel, and the second one fails to
  // apply. That is the flagship sequencing claim breaking on the exact case it exists for.
  //
  // So: `visible` is what humans read, `all` is what order/plan/gate consume, and `hotspots`
  // aggregates the hidden bucket BY FILE — "5 workstreams edit config/registry.mjs" is one
  // finding carrying the same information as ten pairwise rows, without the explosion.
  const visible = keepLow ? ranked : ranked.filter((r) => r.severity !== 'low');
  visible.all = ranked;
  visible.hidden = ranked.filter((r) => r.severity === 'low');
  visible.hotspots = hotspotsFrom(visible.hidden);
  return visible;
}

/** Aggregate co-located pairs by the file they share, so N pairs become one readable finding. */
function hotspotsFrom(pairs) {
  const byFile = new Map();
  for (const p of pairs) {
    for (const f of p.sharedFiles ?? []) {
      if (!byFile.has(f)) byFile.set(f, new Set());
      byFile.get(f).add(p.a);
      byFile.get(f).add(p.b);
    }
  }
  return [...byFile.entries()]
    .map(([file, ids]) => ({ file, workstreams: [...ids].sort(), count: ids.size }))
    .filter((h) => h.count > 1)
    .sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));
}

/* -------------------------------------------------------- P3: duplicates ---- */

/**
 * Two workstreams that built the same thing.
 *
 * Cross-family duplication is waste — two independent dispatches solving one problem.
 * Same-family duplication is usually expected (a fan-out deliberately samples the same task
 * N times), so it is reported but ranked below cross-family.
 *
 * Symbol-identity is the cheap signal and it is exact. `holt duplicates --deep` additionally
 * runs jscpd (Rabin-Karp token clone detection, 150+ languages, Rust engine) to catch the
 * case symbol-identity misses: the same logic written twice under different names.
 */
export function duplicates(scanResult, { minShared = 1 } = {}) {
  const all = scanResult.workstreams.filter((w) => w.ok);
  const { keep } = discriminativeSymbols(all);
  const live = all.filter((w) => discriminativeKeys(w, keep).length);

  const owners = new Map(); // symbolKey -> [index]
  live.forEach((w, i) => {
    for (const k of discriminativeKeys(w, keep)) {
      if (!owners.has(k)) owners.set(k, []);
      owners.get(k).push(i);
    }
  });

  const pairKey = (i, j) => (i < j ? `${i}:${j}` : `${j}:${i}`);
  const pairs = new Map();
  for (const [key, idxs] of owners) {
    if (idxs.length < 2) continue;
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        const k = pairKey(idxs[a], idxs[b]);
        if (!pairs.has(k)) pairs.set(k, { i: Math.min(idxs[a], idxs[b]), j: Math.max(idxs[a], idxs[b]), shared: [] });
        pairs.get(k).shared.push(key);
      }
    }
  }

  return [...pairs.values()]
    .filter((p) => p.shared.length >= minShared)
    .map((p) => {
      const a = live[p.i];
      const b = live[p.j];
      return {
        a: a.id, b: b.id,
        aFamily: a.family, bFamily: b.family,
        sameFamily: a.family === b.family,
        sharedSymbols: p.shared.sort(),
        sharedCount: p.shared.length,
        classification: a.family === b.family ? 'expected-fanout' : 'cross-dispatch-waste',
        // Jaccard over DISCRIMINATIVE added symbols: 1.0 means the two workstreams contributed
        // identical sets. Computed on the filtered sets so shared boilerplate cannot inflate it.
        similarity:
          p.shared.length /
          new Set([...discriminativeKeys(a, keep), ...discriminativeKeys(b, keep)]).size,
      };
    })
    .sort((x, y) => {
      if (x.sameFamily !== y.sameFamily) return x.sameFamily ? 1 : -1;
      return y.sharedCount - x.sharedCount;
    });
}

/* ------------------------------------------------- P2: context digest ---- */

/**
 * What an agent working in workstream X needs to know about its siblings.
 *
 * This is the direct answer to context blindness: each agent sees the repo as it was when it
 * started and has no awareness of concurrent work. The digest is intentionally SMALL — it is
 * meant to be pasted into a running agent's context, so it reports decisions (avoid this file,
 * this symbol already exists next door) rather than dumping diffs.
 */
export function contextDigest(scanResult, workstreamId, { maxItems = 12 } = {}) {
  const live = scanResult.workstreams.filter((w) => w.ok);
  const me = live.find((w) => w.id === workstreamId);
  if (!me) {
    return { ok: false, error: `no scanned workstream with id '${workstreamId}'`, known: live.map((w) => w.id) };
  }

  const { keep } = discriminativeSymbols(live);
  const myFiles = setOf(me.touched ?? []);
  const myKeys = setOf(discriminativeKeys(me, keep));

  const contested = [];
  const alreadyBuilt = [];

  for (const other of live) {
    if (other.id === me.id) continue;

    const sharedFiles = intersect(myFiles, other.touched ?? []);
    if (sharedFiles.length) {
      contested.push({
        workstream: other.id,
        family: other.family,
        files: sharedFiles.sort().slice(0, maxItems),
        fileCount: sharedFiles.length,
        hasUncommitted: other.uncommitted.count > 0,
      });
    }

    const sharedSyms = intersect(myKeys, discriminativeKeys(other, keep));
    if (sharedSyms.length) {
      alreadyBuilt.push({
        workstream: other.id,
        family: other.family,
        symbols: sharedSyms.slice(0, maxItems),
        count: sharedSyms.length,
      });
    }
  }

  contested.sort((a, b) => b.fileCount - a.fileCount);
  alreadyBuilt.sort((a, b) => b.count - a.count);

  return {
    ok: true,
    workstream: me.id,
    family: me.family,
    siblings: live.filter((w) => w.family === me.family && w.id !== me.id).map((w) => w.id),
    contestedFiles: contested.slice(0, maxItems),
    duplicatedSymbols: alreadyBuilt.slice(0, maxItems),
    advice: buildAdvice(contested, alreadyBuilt),
  };
}

function buildAdvice(contested, alreadyBuilt) {
  const out = [];
  if (alreadyBuilt.length) {
    const top = alreadyBuilt[0];
    out.push(
      `${top.count} symbol(s) you added also exist in '${top.workstream}' — check before duplicating: ${top.symbols.slice(0, 3).join(', ')}`,
    );
  }
  if (contested.length) {
    const top = contested[0];
    out.push(
      `'${top.workstream}' is editing ${top.fileCount} of the same file(s)${top.hasUncommitted ? ' with uncommitted changes' : ''} — highest contention: ${top.files[0]}`,
    );
  }
  if (!out.length) out.push('no contested files and no duplicated symbols against any other workstream');
  return out;
}

/* --------------------------------------------------- P5: landing plan ---- */

/**
 * An ORDER to land N workstreams in, not a review.
 *
 * The review bottleneck is asymmetric — agents produce far faster than humans can review —
 * so the leverage is in reviewing LESS, not reviewing faster: drop provably-disposable
 * workstreams, collapse duplicates to one representative, and order what remains so each
 * landing does not invalidate the next.
 *
 * Ordering rule: land the least-entangled first. A workstream that collides with nothing can
 * be landed and forgotten; one that collides with four others should be landed when the
 * others are already resolved, so its conflicts are real rather than speculative.
 *
 * Executing the rebases is explicitly NOT holt's job — git-machete, stack-pr and Graphite
 * already do stacked-branch restacking well. holt produces the order; they apply it.
 */
export function landingPlan(scanResult, { collisions: cols = [], duplicates: dups = [] } = {}) {
  const uniq = uniqueWork(scanResult);
  const safe = safeToDelete(scanResult, uniq);
  const safeIds = setOf(safe.filter((s) => s.safe).map((s) => s.id));
  const live = scanResult.workstreams.filter((w) => w.ok);

  const entanglement = new Map();
  for (const c of cols) {
    if (c.severity === 'none') continue;
    const w = c.severity === 'high' ? 3 : c.severity === 'medium' ? 2 : 1;
    entanglement.set(c.a, (entanglement.get(c.a) ?? 0) + w);
    entanglement.set(c.b, (entanglement.get(c.b) ?? 0) + w);
  }

  // Collapse cross-family duplicate groups to one representative: the one with more unique work.
  const uniqById = new Map(uniq.map((u) => [u.id, u]));
  const supersededBy = new Map();
  for (const d of dups) {
    if (d.sameFamily) continue;
    if (d.similarity < 0.6) continue; // only collapse when the overlap is substantial
    const ua = uniqById.get(d.a)?.uniqueSymbolCount ?? 0;
    const ub = uniqById.get(d.b)?.uniqueSymbolCount ?? 0;
    const [keep, drop] = ua >= ub ? [d.a, d.b] : [d.b, d.a];
    if (!supersededBy.has(drop)) supersededBy.set(drop, keep);
  }

  const candidates = scanResult.workstreams
    .filter((w) => w.ok)
    .filter((w) => !safeIds.has(w.id))
    .map((w) => {
      const u = uniqById.get(w.id);
      return {
        id: w.id,
        path: w.path,
        family: w.family,
        uniqueSymbols: u?.uniqueSymbolCount ?? 0,
        uncommittedOnly: u?.uncommittedOnlyCount ?? 0,
        entanglement: entanglement.get(w.id) ?? 0,
        supersededBy: supersededBy.get(w.id) ?? null,
        filesToReview: w.touched.length,
      };
    });

  const toLand = candidates
    .filter((c) => !c.supersededBy)
    .sort((a, b) => a.entanglement - b.entanglement || b.uniqueSymbols - a.uniqueSymbols);

  return {
    drop: safe.filter((s) => s.safe).map((s) => ({ id: s.id, why: 'nothing unique, nothing uncommitted, nothing base lacks' })),
    collapse: candidates.filter((c) => c.supersededBy).map((c) => ({ id: c.id, into: c.supersededBy, why: 'duplicate of another dispatch' })),
    order: toLand.map((c, i) => ({ step: i + 1, ...c })),
    reviewReduction: {
      total: live.length,
      dropped: safe.filter((s) => s.safe).length,
      collapsed: candidates.filter((c) => c.supersededBy).length,
      toReview: toLand.length,
    },
    reviewSurface: reviewSurface(live, safeIds),
    note: 'holt produces the ORDER. Executing rebases is git-machete / stack-pr / Graphite territory.',
  };
}

/**
 * REVIEW SURFACE — the honest measure of P5, and the one that makes it a product.
 *
 * Counting workstreams was measuring the wrong thing. On a real 39-workstream repo the plan
 * "reduced" review from 39 to 36 — an 8% saving that nobody would pay for. But a reviewer does
 * not read workstreams, they read CHANGES, and the same change appears in many workstreams: when
 * five agents each add `ARC_MEMORY_PROMOTION_K`, a human needs to understand it ONCE and then
 * only confirm the other four match.
 *
 * So the real quantity is: how many DISTINCT things need human eyes, versus how many a
 * PR-by-PR review would put in front of them.
 *
 *   naive       sum over workstreams of files touched   (what reviewing each PR costs today)
 *   distinct    the union of those files                (what actually needs reading)
 *   novel       symbols that appear in exactly ONE workstream — genuine review
 *   corroborated symbols in 2+ workstreams — read once, then compare
 *
 * This is a measurement, not a promise: it says what the redundancy IS, and the reduction is
 * only realised by a reviewer who uses the grouping. Reported as such.
 */
export function reviewSurface(live, safeIds = new Set()) {
  const inPlay = live.filter((w) => !safeIds.has(w.id));

  let naiveFiles = 0;
  let naiveSymbols = 0;
  const distinctFiles = new Set();
  const symbolOwners = new Map();

  for (const w of inPlay) {
    naiveFiles += w.touched.length;
    for (const f of w.touched) distinctFiles.add(f);
    const keys = w.addedKeys ?? [];
    naiveSymbols += keys.length;
    for (const k of keys) {
      if (!symbolOwners.has(k)) symbolOwners.set(k, 0);
      symbolOwners.set(k, symbolOwners.get(k) + 1);
    }
  }

  let novel = 0;
  let corroborated = 0;
  for (const count of symbolOwners.values()) {
    if (count === 1) novel++; else corroborated++;
  }

  const pct = (from, to) => (from > 0 ? Math.round((1 - to / from) * 100) : 0);

  return {
    workstreamsInPlay: inPlay.length,
    files: { naive: naiveFiles, distinct: distinctFiles.size, reductionPct: pct(naiveFiles, distinctFiles.size) },
    symbols: {
      naive: naiveSymbols,
      distinct: symbolOwners.size,
      novel,
      corroborated,
      reductionPct: pct(naiveSymbols, symbolOwners.size),
    },
    explanation:
      'naive = what PR-by-PR review puts in front of a human; distinct = what actually needs reading. ' +
      'novel symbols appear in exactly one workstream and need real review; corroborated symbols appear ' +
      'in several and need reading once, then comparing.',
  };
}

/* ------------------------------------------------------------- the graph ---- */

/** Nodes + edges, for rendering or for an agent to reason over. */
export function buildGraph(scanResult, { collisions: cols = [], duplicates: dups = [] } = {}) {
  const live = scanResult.workstreams.filter((w) => w.ok);
  const uniq = uniqueWork(scanResult);
  const uniqById = new Map(uniq.map((u) => [u.id, u]));
  const safe = new Map(safeToDelete(scanResult, uniq).map((s) => [s.id, s]));

  const nodes = live.map((w) => ({
    id: w.id,
    family: w.family,
    path: w.path,
    head: w.head ? w.head.slice(0, 8) : null,
    branch: w.branch,
    committedFiles: w.committed.count,
    uncommittedFiles: w.uncommitted.count,
    addedSymbols: w.stats.addedSymbols,
    uniqueSymbols: uniqById.get(w.id)?.uniqueSymbolCount ?? 0,
    uncommittedOnly: uniqById.get(w.id)?.uncommittedOnlyCount ?? 0,
    safeToDelete: safe.get(w.id)?.safe ?? false,
    verdict: uniqById.get(w.id)?.verdict ?? 'unknown',
  }));

  const edges = [];
  const families = new Map();
  for (const n of nodes) {
    if (!families.has(n.family)) families.set(n.family, []);
    families.get(n.family).push(n.id);
  }
  for (const [family, ids] of families) {
    if (ids.length < 2) continue;
    for (let i = 1; i < ids.length; i++) {
      edges.push({ type: 'sibling', source: ids[0], target: ids[i], family, weight: 1 });
    }
  }
  for (const c of cols) {
    edges.push({
      type: 'collision', source: c.a, target: c.b,
      weight: c.sharedFileCount, severity: c.severity, kind: c.kind, why: c.why,
      // The contested content itself: a graph that only says "these two fight" is a picture;
      // one that says WHICH symbol and WHICH file they fight over is a decision aid.
      symbols: (c.sharedSymbols ?? []).slice(0, 8),
      files: (c.sharedFiles ?? []).slice(0, 8),
    });
  }
  for (const d of dups) {
    edges.push({
      type: 'duplicate', source: d.a, target: d.b,
      weight: d.sharedCount, similarity: Number(d.similarity.toFixed(3)),
      classification: d.classification,
      symbols: (d.sharedSymbols ?? []).slice(0, 8),
    });
  }

  return { nodes, edges, families: [...families.entries()].map(([name, ids]) => ({ name, members: ids })) };
}

/* --------------------------------------------------------- one-shot report ---- */

/** Everything, computed once. The shape every renderer and the MCP server consume. */
export async function analyze(scanResult, opts = {}) {
  const cols = await collisions(scanResult, opts);
  const dups = duplicates(scanResult, opts);
  const uniq = uniqueWork(scanResult);
  const safe = safeToDelete(scanResult, uniq);
  // Machine consumers get the FULL evidence (co-located included): sequencing conservatively
  // costs a little parallelism, sequencing wrongly costs a failed apply.
  const colsAll = cols.all ?? cols;
  const plan = landingPlan(scanResult, { collisions: colsAll, duplicates: dups });
  const graph = buildGraph(scanResult, { collisions: colsAll, duplicates: dups });

  // Filtering is never silent. A bounded result that does not say what it bounded reads as
  // full coverage, which is how a tool quietly starts lying about what it looked at.
  const live = scanResult.workstreams.filter((w) => w.ok);
  const { dropped, limit } = discriminativeSymbols(live);

  return {
    base: scanResult.base,
    root: scanResult.root,
    backend: scanResult.backend,
    strictReadOnly: scanResult.strictReadOnly,
    counts: {
      workstreams: scanResult.workstreams.length,
      scanned: scanResult.workstreams.filter((w) => w.ok).length,
      skipped: scanResult.skipped.length,
      families: graph.families.length,
      collisions: cols.length,
      duplicatePairs: dups.length,
      safeToDelete: safe.filter((s) => s.safe).length,
      atRisk: uniq.filter((u) => u.uncommittedOnlyCount > 0).length,
    },
    unique: uniq,
    safe,
    collisions: cols,
    collisionsAll: colsAll,
    hotspots: cols.hotspots ?? [],
    duplicates: dups,
    plan,
    graph,
    skipped: scanResult.skipped,
    filtering: {
      rule: `a symbol carried by more than ${limit} of ${live.length} workstream(s) is treated as boilerplate and excluded from PAIR evidence only`,
      droppedCount: dropped.length,
      dropped: dropped.slice(0, 15),
      note: 'per-workstream added/unique symbol lists are NOT filtered',
    },
  };
}
