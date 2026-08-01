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

import { git, pmap, worktreeSnapshot, readWorktreeFile } from './git.mjs';
import { symbolKey } from './symbols.mjs';
import { isHoltLock } from './discover.mjs';

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

  // FILE-LEVEL CONTENT IDENTITY — the SAME key space safeToDelete()'s fpOwners map uses (see
  // content-identity.mjs), read from `w.contentKeys` rather than recomputed, so "unique" and
  // "disposable" can never disagree about whether a file's bytes are held elsewhere.
  //
  // WHY THIS IS NEEDED BESIDES SYMBOL IDENTITY. `symbolOwners` above is a NAME match: a symbol
  // is "shared" the instant two live workstreams both declare something called, say, `Handler`
  // — even when the two declarations are completely different code. MEASURED against the
  // independent 50-language oracle: a worktree whose sole committed file is genuinely unique
  // content lost its ENTIRE uniqueSymbolCount (0, verdict `committed-delta-no-unique-symbols`)
  // whenever a SIBLING workstream happened to declare a same-NAMED symbol in a different file
  // with different content — planted deliberately by bench50's `wt-symbol-dup` fixture, but the
  // collision is not limited to that fixture: any two agents who independently name a class or
  // function the same common thing (`Handler`, `Config`, `parse`) trip it. A symbol name is
  // cheap evidence; the file it lives in is the actual work, so a name collision downgrades a
  // symbol to "shared" only when the file's CONTENT is ALSO shared — never on name alone.
  const contentOwners = new Map(); // content-identity key -> Set(workstream id)
  for (const w of live) {
    for (const key of Object.values(w.contentKeys ?? {})) {
      if (!key) continue; // unreadable/oversized: cannot prove a match, the safe direction
      if (!contentOwners.has(key)) contentOwners.set(key, new Set());
      contentOwners.get(key).add(w.id);
    }
  }

  /** Is `w`'s own copy of the file at `file` backed by content no OTHER live workstream holds? */
  function fileIsContentUnique(w, file) {
    const key = w.contentKeys?.[file];
    if (!key) return false; // cannot prove it — falls back to the name-only check below
    const holders = contentOwners.get(key);
    return !holders || holders.size === 1;
  }

  return live
    .map((w) => {
      // First file this workstream declared each symbol key in, for the content-identity
      // fallback below. A symbol key can appear in more than one file; the first is enough to
      // decide "is there SOME file behind this name that no other live workstream also holds".
      const symbolFile = new Map();
      for (const s of w.added ?? []) {
        const k = symbolKey(s);
        if (!symbolFile.has(k)) symbolFile.set(k, s.file);
      }

      const uniqueSymbols = (w.addedKeys ?? []).filter((k) => {
        if (symbolOwners.get(k).length === 1) return true;
        // Name collides with at least one other live workstream. Still unique to w when the
        // file this symbol actually lives in has no content twin anywhere else live — a name
        // match that is not also a content match is not the same work (see the P0 PRECISION
        // test pinning this, and the P0 test right above it pinning the opposite: a genuine
        // content duplicate must still be excluded from both sides).
        const file = symbolFile.get(k);
        return file ? fileIsContentUnique(w, file) : false;
      });
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

      // GITIGNORED FILES ARE AT RISK TOO — MORE SO THAN UNCOMMITTED ONES. MEASURED against the
      // independent 50-language oracle: `wt-ignored` (a worktree whose ONLY content is a
      // gitignored file) was reported `nothing-unique` in every one of the 50 languages, because
      // this count was built from `w.uncommitted` alone — the ignored layer never touches it.
      // `safeToDelete` already refuses to call the identical worktree disposable (confidence
      // 'unverifiable', see contentAtRisk()) — so the report meant to say what would be LOST was
      // giving the opposite answer from the guard that stops the deletion, the exact two-commands-
      // disagree failure contentAtRisk()'s own doc comment names for gate vs rescue. Git does not
      // track ignored content at all, which makes it STRICTLY less visible than an uncommitted
      // edit, not less at-risk — `ignoredContent()` (scan.mjs) has already excluded recognisable
      // build output (node_modules, dist, caches — the GENERATED list) before this count ever
      // sees it, so this cannot turn a worktree's dist/ into "unique work".
      const ignoredFileCount = w.ignored?.count ?? 0;
      const atRiskSymbols = byLayer.uncommitted.length + byLayer.untracked.length;
      const atRisk = Math.max(atRiskSymbols, uncommittedFileCount + ignoredFileCount);

      // THE PATH LAYER, CARRIED BESIDE THE SYMBOL LAYER — for the same reason the count above
      // takes the max of the two. `byLayer` holds SYMBOLS, and a symbol is a lossy view of risk
      // twice over: a file whose language has no parser (notes.md, a .env, a CSV, a design asset)
      // contributes none, and a symbol two workstreams share is not unique so it is filtered out
      // of `byLayer` entirely. Any consumer asking a question about PATHS — "is anything under
      // infra/** at risk here" — must read paths, not symbol identities. Without this, the only
      // path-shaped consumer in the product silently matched its globs against `kind:name`
      // strings and could never fire. Same four layers, same names, so the views cannot drift
      // apart. `ignored` carries no symbol-level counterpart in `byLayer` — ctags is never run
      // over gitignored content — so this is the ONLY place that content is visible at all.
      const pathsByLayer = {
        committed: [...(w.committed?.files ?? [])],
        uncommitted: [...(w.uncommitted?.files ?? [])],
        untracked: [...(w.uncommitted?.untracked ?? [])],
        ignored: [...(w.ignored?.files ?? [])],
      };

      // A SYMBOL COUNT OF ZERO MUST NOT CLAIM TO BE A MEASUREMENT WHEN IT ISN'T ONE.
      //
      // `w.symbolsUnmeasured` (scan.mjs, from ctagsBatch's own `.failed`) already stops
      // `safeToDelete` from calling an unreadable workstream disposable — but that is the
      // deletion GATE, not this report. `uniqueSymbolCount` is what `holt risk` prints and what
      // `--json` hands to any script keyed on "how many symbols did this workstream add", and
      // until this line it had no way to know the ctags backend ever failed to look: a NUL byte
      // tripping enry's binary sniff, an oversized file (`tagWorthy`'s MAX_TAG_FILE_BYTES skip),
      // or a plain ctags timeout under load all render here as the same bare `0` a workstream
      // that genuinely added nothing would show. Surfacing the count AND the filenames lets a
      // caller distinguish "measured, zero" from "we could not measure this" without having to
      // separately reconstruct safeToDelete's reasoning.
      const symbolsUnmeasured = w.symbolsUnmeasured ?? [];

      return {
        id: w.id,
        path: w.path,
        family: w.family,
        uniqueSymbolCount: uniqueSymbols.length,
        uniqueSymbols,
        byLayer,
        pathsByLayer,
        uncommittedOnlyCount: atRisk,
        uncommittedFileCount,
        ignoredFileCount,
        atRiskSymbolCount: atRiskSymbols,
        committedFiles: w.committed.count,
        symbolsUnmeasuredCount: symbolsUnmeasured.length,
        symbolsUnmeasuredFiles: symbolsUnmeasured.length ? symbolsUnmeasured.slice(0, 10) : undefined,
        verdict:
          atRisk > 0 ? 'unique-work-uncommitted'
            : uniqueSymbols.length > 0 ? 'unique-work-committed'
              : w.committed.count > 0 ? 'committed-delta-no-unique-symbols'
                : 'nothing-unique',
      };
    })
    .sort((a, b) => b.uncommittedOnlyCount - a.uncommittedOnlyCount || b.uniqueSymbolCount - a.uniqueSymbolCount);
}

/* --------------------------------------- shared: what a deletion destroys ---- */

/**
 * EVERY PATH DESTROYING THIS WORKSTREAM WOULD DESTROY — ONE computation, for every command.
 *
 * WHY THIS FUNCTION EXISTS. `gate` (via safeToDelete) and `rescue` each built their own idea of
 * "what is in here", from overlapping but DIFFERENT fields of the same scan. gate counted the
 * committed delta, the uncommitted layer AND the gitignored layer; rescue counted the committed
 * delta and the uncommitted layer only. So a worktree whose sole unique content was gitignored
 * produced two opposite answers from one product:
 *
 *     holt gate w1     ->  "✗ w1: HOLDS UNIQUE WORK ... 2 gitignored file(s)"      exit 1
 *     holt rescue w1   ->  "this worktree holds nothing base lacks"                exit 0
 *
 * and the one that exits 0 is the one a script trusts before `git worktree remove`. Two commands
 * disagreeing about whether work exists is worse than either being wrong alone, because it
 * teaches the user that one of them can be ignored.
 *
 * The class fix is not "teach rescue about ignored files" — that is this week's layer. It is that
 * NO COMMAND MAY DERIVE THE CONTENT SET ITSELF. Every layer the scanner can see is enumerated
 * here exactly once; a future layer is added here and every command inherits it, which is the
 * only arrangement in which they cannot drift apart again.
 *
 * BLINDNESS IS NOT EMPTINESS. An instrument that failed to run reports zero paths, which is
 * byte-identical to a genuinely clean worktree. That is reported separately as `blind` so a
 * caller must REFUSE rather than read a probe failure as good news.
 */
export function contentAtRisk(w) {
  const uncommitted = (w?.uncommitted?.files ?? []).filter(Boolean);
  const untracked = (w?.uncommitted?.untracked ?? []).filter(Boolean);
  const ignored = (w?.ignored?.files ?? []).filter(Boolean);
  const committedCount = w?.committed?.count ?? 0;

  // Name the instrument, not the symptom: whoever refuses has to be able to say WHY it refused.
  const blind = [];
  if (w?.uncommitted?.how === 'status-failed') {
    blind.push(`working-tree status probe failed (${w.uncommitted.error ?? 'unknown'})`);
  }
  if (w?.ignored?.how === 'ignored-probe-failed') {
    blind.push(`gitignored-content probe failed (${w.ignored.error ?? 'unknown'})`);
  }

  const files = [...new Set([...uncommitted, ...untracked, ...ignored])].sort();
  return {
    files,
    layers: { uncommitted, untracked, ignored },
    committedCount,
    blind,
    // TRUE only when every instrument ran AND every layer came back empty.
    empty: blind.length === 0 && files.length === 0 && committedCount === 0,
  };
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

  // CONTENT-IDENTITY OWNER MAP — path-blind, whitespace-insensitive, one per scan.
  //
  // `mergedTree` (the old check here) can only prove redundancy when TWO WORKTREES' ENTIRE
  // committed state hashes to one git tree oid — the same branch checked out twice. It is blind
  // to the far more common shape: one new file, present in only one worktree, that a sibling also
  // added under a DIFFERENT PATH or in a different indentation style. Measured against an
  // independent 50-language oracle: `feat/alpha/a.py` (4-space indent) and `feat/beta/a.py` (tab
  // indent) are the SAME work by the oracle's own definition — delete either one and it survives
  // in the sibling — and mergedTree cannot see the pair because neither the path nor the bytes
  // match.
  //
  // So identity is decided PER FILE, using content-identity.mjs's fingerprint (raw bytes, or a
  // normalised form insensitive to indentation width/style, line endings, BOM and blank lines —
  // NEVER to the actual code text, so two different functions sharing a name or a shape cannot
  // collide here). One owner map, built once, exactly mirrors uniqueWork()'s symbol-owner map:
  // a file is "held elsewhere" when some OTHER live workstream carries a file with the same
  // content-identity key, at any path.
  const live = scanResult.workstreams.filter((w) => w.ok);
  const fpOwners = new Map(); // content-identity key -> Set(workstream id)
  for (const w of live) {
    for (const key of Object.values(w.contentKeys ?? {})) {
      if (!key) continue; // unreadable or oversized: cannot be matched, the safe direction
      if (!fpOwners.has(key)) fpOwners.set(key, new Set());
      fpOwners.get(key).add(w.id);
    }
  }

  /**
   * Does every file in `files` have a content-identity twin in some OTHER live workstream?
   * Returns the full set of files matched, and every sibling that contributed a match — so a
   * partial match (one of two files has a twin, the other does not) is visible rather than
   * forcing an all-or-nothing verdict, and the caller can still decide the count precisely.
   */
  function siblingCoverage(w, files) {
    const owners = new Set();
    const matchedFiles = [];
    for (const f of files) {
      const key = w.contentKeys?.[f];
      if (!key) continue;
      const holders = fpOwners.get(key);
      if (!holders) continue;
      const others = [...holders].filter((id) => id !== w.id);
      if (!others.length) continue;
      matchedFiles.push(f);
      for (const id of others) owners.add(id);
    }
    return { owners: [...owners], matchedFiles, allMatched: files.length > 0 && matchedFiles.length === files.length };
  }

  return scanResult.workstreams.map((w) => {
    if (!w.ok) {
      return { id: w.id, path: w.path, safe: false, confidence: 'unknown', reasons: [w.reason ?? 'not scanned'] };
    }
    const u = uniqById.get(w.id);
    // ONE content computation, shared with rescue — see contentAtRisk(). Reading these fields
    // directly here is what let the two commands drift into opposite answers.
    const risk = contentAtRisk(w);
    const reasons = [];

    // "BASE LACKS THIS" IS NOT THE SAME QUESTION AS "DELETING THIS LOSES IT".
    //
    // Measured against an independent oracle across 50 languages and 900 worktrees: this one line
    // was the ENTIRE recall gap. disposable precision was 1.00 and recall 0.40 — of 250 genuinely
    // disposable worktrees holt reclaimed 100 and abstained on 150, and all 150 carried exactly
    // this reason and no other.
    //
    // The 150 were mutually redundant: three worktrees holding byte-identical content. Base does
    // lack it, so the check fired — but a LIVING SIBLING holds the very same work, so removing any
    // one of them loses nothing. Three lines below, the unique-symbol check already cross-
    // references siblings through uniqueWork()'s owner map; this one never did. Two adjacent
    // checks in one function, applying different standards of "is this the only copy".
    //
    // Perfect precision at 0.40 recall is not a safe tool, it is a tool that answers "I cannot be
    // sure" to most of the question it exists to answer — and you can achieve that by refusing
    // everything.
    //
    // THE SAFETY PROPERTY, and why this cannot lose work: the verdict is relative to the siblings
    // that exist RIGHT NOW. `clean --apply` re-verifies every worktree immediately before removing
    // it, against a fresh scan — so once the siblings are gone, the last member finds no sibling,
    // this reason fires again, and it is refused. The set drains to exactly one survivor by
    // construction, without anyone having to sequence it. `gate` re-scans per invocation and
    // behaves identically.
    // PER-FILE CONTENT IDENTITY, NOT WHOLE-TREE IDENTITY. `w.committed.mergedTree` equality (the
    // original form of this check) only fires when the worktree's ENTIRE committed state matches
    // a sibling's at the SAME paths — the same branch checked out twice. `siblingCoverage`
    // (defined above, over the scan-wide fingerprint owner map) asks the finer question this
    // worktree's deletion actually turns on: does EVERY committed file have a content-identical
    // twin in some other live workstream, wherever that twin lives? A worktree whose committed
    // files are only PARTLY covered is correctly left un-redundant — `allMatched` requires all of
    // them, so one genuinely unique file among three still blocks the verdict.
    const committedCoverage = siblingCoverage(w, w.committed?.files ?? []);
    const heldAlsoBy = committedCoverage.allMatched ? committedCoverage.owners : [];

    // BASE CAN BE THE LIVING SIBLING TOO — the same reasoning as `heldAlsoBy` above, aimed at
    // base instead of another worktree.
    //
    // Measured on the 50-language independent-oracle benchmark: 50 of 150 disposable misses were
    // one worktree per repository whose ENTIRE committed delta was the SAME FILE(S), re-saved
    // with CRLF line endings. `merge-tree` correctly says "base lacks this exact tree" — a CRLF
    // byte and an LF byte are different bytes to git — but base holds the identical TEXT, so
    // nothing here is unique work. scan.mjs computed the conjunction (every file, not some) as
    // `committed.lineEndingOnlyVsBase`; this is pure computation over that already-proven fact.
    //
    // Named 'base' rather than a workstream id, because base is the holder and is not itself a
    // member of scanResult.workstreams — `gate` and `clean --apply` need nothing more than a
    // non-empty redundantWith to apply the identical safe-but-refuse-on-gate shape (see
    // bin/holt.mjs's `gate`), so no new mechanism was needed, only a new holder name.
    const lineEndingOnlyVsBase = heldAlsoBy.length === 0
      && risk.committedCount > 0
      && w.committed?.lineEndingOnlyVsBase === true;

    if (risk.committedCount > 0 && heldAlsoBy.length === 0 && !lineEndingOnlyVsBase) {
      reasons.push(`${risk.committedCount} file(s) base lacks`);
    }
    const uncommittedCount = risk.layers.uncommitted.length + risk.layers.untracked.length;
    if (uncommittedCount > 0) reasons.push(`${uncommittedCount} uncommitted file(s)`);
    if (u && u.uniqueSymbolCount > 0) reasons.push(`${u.uniqueSymbolCount} symbol(s) found nowhere else`);
    // A LOCK HOLT PLACED IS NOT EVIDENCE — IT IS HOLT'S OWN PAST VERDICT, RESTATED.
    //
    // Counting it here made it self-justifying: `protect` locked a worktree that genuinely held
    // the only copy of something, the work later landed, and the verdict stayed "not disposable"
    // forever because holt was reading back its own lock as the reason. `clean --apply` skipped
    // it, `gate` exited 1, and the only escape was `unprotect`, which disarms EVERY tree —
    // including the ones that still need it. That is "a gate that only refuses gets switched
    // off", and following holt's own quick-start reproduced it: 20 locked, 18 holding nothing.
    //
    // A FOREIGN lock still blocks, and must: somebody else protected that tree deliberately and
    // holt has no basis to overrule them. `protect` is what reconciles holt's own locks now.
    const holtLocked = w.locked && isHoltLock(w.lockReason);
    if (w.locked && !holtLocked) reasons.push(`locked${w.lockReason ? `: ${w.lockReason}` : ''}`);

    // GITIGNORED CONTENT DOWNGRADES THE VERDICT, it does not silently vanish from it.
    // git does not track ignored files, so holt cannot prove anything about them — but deleting
    // the worktree destroys them all the same. A `.env` of live credentials or a hand-patched
    // dependency was being called "provably nothing to lose". Recognisable build output is
    // already filtered out upstream, so what reaches here is content a human plausibly wants.
    const ignoredCount = risk.layers.ignored.length;
    if (ignoredCount > 0) {
      const sample = risk.layers.ignored.slice(0, 3).join(', ');
      reasons.push(`${ignoredCount} gitignored file(s) holt cannot verify${sample ? ` (e.g. ${sample})` : ''}`);
    }

    // AN EMPTY ANSWER FROM A BROKEN INSTRUMENT IS NOT AN ANSWER. The two checks below are the
    // same rule reaching the verdict from different depths, and both are needed — holt did not
    // have the evidence, so it must not claim the verdict.

    // (a) A FAILED PROBE reports zero paths, exactly like a clean worktree. Without this, `gate`
    // would green-light a worktree it never managed to look inside — and `rescue`, which refuses
    // on the same signal, would contradict it in public.
    for (const b of risk.blind) reasons.push(`${b} — refusing to call it disposable`);

    // (b) A FAILED SYMBOL EXTRACTION does the same thing one layer down. Measured: under a
    // timeout, a file containing a real symbol yields ZERO — identical to a file that has none.
    // Nothing downstream could tell the difference, so an extraction that timed out under load
    // became "shares nothing with anyone", and a worktree holding work found nowhere else was
    // reported provably disposable. Refusing costs one manual check; the silence cost the file.
    // ...UNLESS content identity has already answered the question symbols were going to ask.
    // Symbols exist here to establish whether this work exists anywhere else; a byte-for-byte
    // twin in a living sibling is a strictly stronger form of that same answer. A file too large
    // (or too strange) to tag, whose exact bytes provably live in another worktree, is not
    // "unmeasured" in any sense that matters to disposal — refusing on it would let a weaker
    // instrument's failure veto a stronger instrument's success, which is over-refusal wearing a
    // safety costume. Files NOT covered by content identity keep the full refusal below.
    const contentProven = new Set(committedCoverage.matchedFiles);
    const unmeasured = (w.symbolsUnmeasured ?? []).filter((f) => !contentProven.has(f));
    if (unmeasured.length > 0) {
      const sample = unmeasured.slice(0, 3).join(', ');
      reasons.push(`${unmeasured.length} file(s) holt could not read symbols from${sample ? ` (e.g. ${sample})` : ''}`);
    }

    return {
      id: w.id,
      path: w.path,
      family: w.family,
      safe: reasons.length === 0,
      // Named, so nobody has to infer it: this worktree is disposable BECAUSE a living sibling
      // (or base itself, see lineEndingOnlyVsBase above) holds the identical content, not
      // because it holds nothing. The distinction matters to a human reading the report and it
      // is what makes the last-one-standing behaviour legible rather than surprising.
      redundantWith: heldAlsoBy.length ? heldAlsoBy : (lineEndingOnlyVsBase ? ['base'] : undefined),
      // Surfaced so protect/clean/render can see a lock holt placed without it counting as a
      // reason the worktree is undeletable. Absent when there is no holt lock.
      holtLocked: holtLocked || undefined,
      // 'unverifiable' is distinct from 'measured': everything git CAN see is clean, but ignored
      // content means holt did not have the evidence to call it disposable.
      confidence: (ignoredCount > 0 || unmeasured.length > 0) && reasons.length === 1
        ? 'unverifiable'
        : scanResult.strictReadOnly ? 'approximate' : 'measured',
      unmeasuredFiles: unmeasured.length ? unmeasured.slice(0, 10) : undefined,
      ignoredFiles: ignoredCount ? risk.layers.ignored.slice(0, 10) : undefined,
      // The safe-verdict reason must be TRUE of this worktree, and "no committed delta" is false
      // for a redundant one — it holds a real delta whose every byte a living sibling (or base)
      // also holds. Every surface (risk, MCP, TUI, graph) prints this string verbatim, so the
      // false version sat directly next to the contradicting redundantWith field in all of them.
      reasons: reasons.length ? reasons
        : (heldAlsoBy.length || lineEndingOnlyVsBase)
          ? [`committed content is identical to work also held by ${heldAlsoBy.length ? heldAlsoBy.join(', ') : 'base (line endings aside)'}`]
          : ['no committed delta, no uncommitted changes, no unique symbols'],
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

  // One snapshot per worktree, shared by every pair it appears in — N snapshots, not N².
  // A CLEAN worktree needs none: its HEAD already IS its full state, so the common case costs
  // nothing. A snapshot that fails resolves to the head, which reproduces the old behaviour for
  // that pair rather than inventing an answer.
  const snapCache = new Map();
  const sideOf = async (w) => {
    const dirty = w.uncommitted.count > 0 || (w.untracked?.count ?? 0) > 0;
    if (!dirty || scanResult.strictReadOnly) return w.head ?? null;
    if (!snapCache.has(w.id)) {
      // includeIgnored:false — a gitignored file is machine-local, not contested work. With it on,
      // two developers' own `.env.local` files made merge-tree "prove" a conflict between
      // worktrees whose actual shared file merges cleanly. See worktreeSnapshot's header.
      snapCache.set(w.id, worktreeSnapshot(w.path, w.head, { timeout, includeIgnored: false })
        .then((c) => c ?? w.head ?? null));
    }
    return snapCache.get(w.id);
  };

  // TREE IDENTITY, cached per side — N lookups, not N².
  //
  // Two worktrees whose FULL state hashes to one tree cannot conflict: merging a tree with itself
  // is a no-op, and no evidence can make that false. This is the ordinary result of checking one
  // branch out twice to review it — six such pairs exist in holt's own repository, and each was
  // reported HIGH, quoting 247 shared symbols. Those symbols are real, and they are what a
  // DUPLICATE looks like: each side was compared against BASE, and both added the same things
  // because they ARE the same thing. `duplicates` already reports the pair, correctly, at 100%.
  const treeCache = new Map();
  const treeOf = (side) => {
    if (!side) return Promise.resolve(null);
    if (!treeCache.has(side)) {
      treeCache.set(side, git(['rev-parse', `${side}^{tree}`], { cwd: scanResult.root, timeout })
        .then((r) => (r.code === 0 ? r.stdout.trim() : null))
        .catch(() => null));
    }
    return treeCache.get(side);
  };

  const results = await pmap(
    pairs,
    async (p) => {
      const a = live[p.i];
      const b = live[p.j];

      const aKeys = setOf(discriminativeKeys(a, keep));
      const sharedSymbols = intersect(aKeys, discriminativeKeys(b, keep));

      // PROVE IT AGAINST WHAT IS ACTUALLY THERE, not just what was committed.
      //
      // This used to merge the two committed HEADS, because "merge-tree cannot see uncommitted
      // sides". That premise was false and it cost the flagship answer: two worktrees editing the
      // same line of the same file, uncommitted, reported "No collisions. No two workstreams
      // contest the same content." Every worktree shares one object database, so each side's
      // full working state becomes a real commit (see worktreeSnapshot) and merge-tree answers
      // for real. Snapshots are computed once per worktree and reused across every pair.
      const [aSide, bSide] = await Promise.all([sideOf(a), sideOf(b)]);

      // IDENTICAL STATE IS DECIDED BEFORE THE EXPENSIVE CALL, NOT AFTER IT.
      //
      // This check already existed, twenty lines further down — after merge-tree had run. That
      // ordering is what made a many-worktree scan super-linear, and it was measured rather than
      // guessed: overlappingPairs() produces C(N,2) pairs when N worktrees touch the same files,
      // which is the ordinary fan-out shape, and merge-tree was invoked once for EVERY pair
      // unconditionally. At N=800 that is roughly 320,000 subprocesses to answer a question whose
      // answer is "these are byte-identical" — and it is not gated by --no-symbols, which is why
      // that flag recovered almost nothing at scale.
      //
      // Merging a tree with itself cannot conflict, so the answer is known without asking. The
      // cheap comparison is one cached rev-parse per SIDE (N of them), not one merge per PAIR.
      let identicalState = false;
      if (aSide && bSide) {
        if (aSide === bSide) identicalState = true;
        else {
          const [aTree, bTree] = await Promise.all([treeOf(aSide), treeOf(bSide)]);
          identicalState = Boolean(aTree) && aTree === bTree;
        }
      }

      let proven = null;
      if (!identicalState && !scanResult.strictReadOnly && aSide && bSide) {
        const mt = await git(['merge-tree', '--write-tree', aSide, bSide], {
          cwd: scanResult.root, timeout,
        });
        // Anything other than 0/1 is merge-tree failing to answer — that is UNKNOWN, never
        // "clean". Reporting an unanswerable pair as clean is the fail-open shape that lets a
        // real conflict through silently.
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
      // A PROOF BEATS A PREDICTION IN BOTH DIRECTIONS.
      //
      // `proven === false` used to be consulted only AFTER the shared-symbol heuristic, so git
      // answering "these merge cleanly" was discarded whenever the sides shared an added symbol —
      // and sharing an added symbol is the single commonest way two agents touch one registry.
      // Measured on holt's own repository: all 22 pairs git had PROVEN clean were reported as
      // collisions anyway, 10 of them HIGH. The comment at the top of this function already said
      // "this is git's own answer, not a heuristic"; the ladder only honoured it when the answer
      // was yes.
      //
      // Proven-clean-but-shares-a-symbol is NOT silenced, because it is not nothing: two agents
      // each adding `sharedHandler` to one file at far-apart lines merges without a murmur and
      // produces a duplicate declaration. That is precisely the semantic overlap byte comparison
      // structurally cannot see — holt's own differentiator. It is reported as what it is,
      // separately from a textual conflict, and it still entangles landing order (see
      // CONFLICT_KINDS in order.mjs).
      // identicalState was decided above, BEFORE merge-tree ran — see the note there for why the
      // ordering is the whole point rather than a tidy-up.
      let severity;
      let kind;
      if (proven === true) { kind = 'proven'; severity = 'high'; }
      else if (identicalState) { kind = 'identical'; severity = 'none'; }
      else if (proven === false) {
        kind = sharedSymbols.length > 0 ? 'semantic-overlap' : 'proven-clean';
        severity = sharedSymbols.length > 0 ? 'medium' : 'none';
      } else if (sharedSymbols.length > 0) {
        kind = 'predicted';
        severity = uncommittedInvolved ? 'high' : 'medium';
      } else { kind = 'co-located'; severity = 'low'; }

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
          proven === true ? 'git merge-tree reports a real conflict between these two worktrees, including their uncommitted work'
            : identicalState ? 'byte-identical state — one commit checked out twice, so the merge is a no-op; reported as the duplicate it is'
              : proven === false
                ? `git merge-tree proves these MERGE CLEANLY` +
                  (sharedSymbols.length > 0
                    ? `, but both define ${sharedSymbols.slice(0, 3).join(', ')}${sharedSymbols.length > 3 ? '…' : ''} — a semantic overlap, not a textual conflict`
                    : '')
                : sharedSymbols.length > 0
                  ? `both added the same symbol(s): ${sharedSymbols.slice(0, 3).join(', ')}${sharedSymbols.length > 3 ? '…' : ''}` +
                    ' — merge-tree could not be run, so this is predicted, not proven'
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

// A symbol name alone is not evidence once the fan-out is small. discriminativeSymbols()
// only drops a name carried by more than 25% of LIVE workstreams (floor 3) — by design, so a
// real fan-out of 4 sharing a helper is not gutted. But that same floor means a name shared by
// as few as two or three workstreams NEVER crosses it, so it survives as "discriminative"
// even when it is really just two agents independently reaching for a common, undiscriminating
// name (`process`, `handler`, `validate`, `run`). No blocklist of common names generalises
// across languages and codebases; the fix is to require the DECLARED BODIES to actually agree.
const MAX_BODY_WINDOW_LINES = 40;

// Single-line comment markers across the languages holt's symbol extractor covers: C-family
// and shell/Python-family (`//`, `#`), Lua/SQL/Haskell/Ada/VHDL/Elm (`--`), Lisp-family (`;`),
// Erlang/MATLAB (`%`), Fortran (`!`), Vimscript (`"`), plus a JSDoc-style continuation `*` and
// an OCaml block-open `(*` used as a prefix. NOT exhaustive by design: an unrecognised marker
// still normalises fine, it just is not stripped, which only makes the equality check MORE
// conservative (harder to match), never less — so a gap here cannot manufacture a false
// "these agree", only miss stripping a comment it does not know about.
const LINE_COMMENT_PREFIX = /^(\/\/|#|--|;|%|!|"|\/\*|\(\*|<!--|\*(?!\/))/;

/**
 * Is this (already-trimmed) line NOTHING BUT a comment?
 *
 * The prefix set above handles every open-ended "rest of the line is a comment" marker. Brace
 * block comments (Pascal-style `{ ... }`) are handled separately and more strictly — recognised
 * ONLY when the entire line both starts and ends with the pair — because `{` alone is one of
 * the most common opening-brace characters across the languages this corpus and holt both
 * cover, and treating a bare `{` (or a genuine one-line struct/object literal like
 * `{ port: 8080 }`) as a comment would silently blind the comparison to real code.
 */
function isCommentOnlyLine(line) {
  if (LINE_COMMENT_PREFIX.test(line)) return true;
  return line.length > 1 && line.startsWith('{') && line.endsWith('}');
}

/**
 * The text a matched symbol's own declaration actually spans, best-effort.
 *
 * ctags gives a start line and nothing else here (no end-of-scope field is requested — adding
 * one is a cross-version ctags compatibility risk this fix does not need to take). The window
 * is bounded by whichever comes first: the next symbol THIS SAME WORKSTREAM added in the same
 * file (a real boundary, when known), or a fixed cap. Reading the wrong-sized window only
 * costs precision on this one check, never correctness elsewhere: a body mismatch DROPS a
 * name from "shared" evidence, it never invents a duplicate that symbol-identity did not
 * already find.
 */
async function readDeclaredBody(workstream, sym, boundariesByFile) {
  if (!sym?.file || !sym?.line) return null;
  const text = await readWorktreeFile(workstream.path, sym.file);
  if (text === null) return null; // unreadable is UNKNOWN, not a mismatch — see the caller's fail-open comment
  const lines = text.split(/\r\n|\n/);
  const start = sym.line - 1;
  if (start < 0 || start >= lines.length) return null;

  if (!boundariesByFile.has(sym.file)) {
    const bounds = (workstream.added ?? [])
      .filter((s) => s.file === sym.file && typeof s.line === 'number')
      .map((s) => s.line)
      .sort((x, y) => x - y);
    boundariesByFile.set(sym.file, bounds);
  }
  const nextBoundary = boundariesByFile.get(sym.file).find((l) => l > sym.line);
  const hardEnd = sym.line - 1 + MAX_BODY_WINDOW_LINES;
  const end = Math.min(nextBoundary ? nextBoundary - 1 : hardEnd, hardEnd, lines.length);

  const normalised = lines
    .slice(start, Math.max(start + 1, end))
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !isCommentOnlyLine(l))
    .join('\n');
  return normalised || null;
}

/**
 * Two workstreams that built the same thing.
 *
 * Cross-family duplication is waste — two independent dispatches solving one problem.
 * Same-family duplication is usually expected (a fan-out deliberately samples the same task
 * N times), so it is reported but ranked below cross-family.
 *
 * Symbol-identity is the cheap signal, but it is a NAME match, not a content match — two agents
 * independently naming an unrelated function `process` would otherwise be reported as having
 * built the same thing. So a name is only counted as shared evidence for a PAIR once the
 * declared bodies behind it agree (whitespace- and comment-insensitive). Neither side being
 * readable is treated as "cannot disprove", not as a mismatch — this check can only REMOVE a
 * name from the shared set, never add one that symbol-identity did not already find, so it
 * cannot manufacture a duplicate and cannot suppress one the old code already proved (e.g. two
 * byte-identical checkouts of the same commit, whose bodies are trivially equal).
 *
 * `holt duplicates --deep` additionally runs jscpd (Rabin-Karp token clone detection, 150+
 * languages, Rust engine) to catch the case symbol-identity misses even with matching names:
 * the same logic written twice under completely different names.
 */
export async function duplicates(scanResult, { minShared = 1 } = {}) {
  const all = scanResult.workstreams.filter((w) => w.ok);
  const { keep } = discriminativeSymbols(all);
  const live = all.filter((w) => discriminativeKeys(w, keep).length);

  // First occurrence per (workstream, key) — overwhelmingly the common case is exactly one.
  const symByKey = live.map((w) => {
    const m = new Map();
    for (const s of w.added ?? []) {
      const k = symbolKey(s);
      if (!m.has(k)) m.set(k, s);
    }
    return m;
  });
  const boundariesByFile = live.map(() => new Map());
  const bodyCache = new Map(); // `${index}:${key}` -> normalised body text | null, read once each

  async function declaredBodyFor(i, key) {
    const cacheKey = `${i}:${key}`;
    if (bodyCache.has(cacheKey)) return bodyCache.get(cacheKey);
    const body = await readDeclaredBody(live[i], symByKey[i].get(key), boundariesByFile[i]);
    bodyCache.set(cacheKey, body);
    return body;
  }

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
        const i = idxs[a];
        const j = idxs[b];
        // eslint-disable-next-line no-await-in-loop -- each (workstream, key) body is cached,
        // so this awaits a real read only once per unique pair; sequencing keeps the cache simple.
        const [bodyA, bodyB] = await Promise.all([declaredBodyFor(i, key), declaredBodyFor(j, key)]);
        // FAIL OPEN ON SILENCE: if either side could not be read, that is unknown, not a
        // mismatch, so the name still counts. Only a POSITIVE disagreement between two
        // successfully-read bodies removes it.
        if (bodyA !== null && bodyB !== null && bodyA !== bodyB) continue;
        const k = pairKey(i, j);
        if (!pairs.has(k)) pairs.set(k, { i: Math.min(i, j), j: Math.max(i, j), shared: [] });
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

  // "Sibling" means came from the same dispatch — PROVENANCE (fork point + creation time, see
  // inferFamily/assignFamilies in discover.mjs), not a naming coincidence. `familyRule` says which
  // method actually produced this workstream's family, so a caller can see WHY two workstreams
  // are grouped (or ask holt to explain it), but the grouping itself is not hedged here: a sibling
  // is a sibling. Content evidence (`contestedFiles`/`duplicatedSymbols` below) answers a
  // different, complementary question — "did they touch the same thing" — and is reported
  // separately rather than used to second-guess who the dispatch actually contained.
  const siblings = live.filter((w) => w.family === me.family && w.id !== me.id).map((w) => w.id);

  return {
    ok: true,
    workstream: me.id,
    family: me.family,
    familyRule: me.familyRule,
    siblings,
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

  const nodes = live.map((w) => {
    // Named so a reader can tell "safe because nothing is here" apart from "safe because a
    // living sibling holds the identical content" — collapsing those two into one green dot
    // is how a dashboard tells someone it is fine to delete the only copy of something.
    //
    // Only added to the object when non-empty, on purpose: this graph round-trips through
    // JSON (see graph-html.mjs's DATA payload), and JSON.stringify DROPS an own property whose
    // value is `undefined` while a plain object literal keeps it — so `redundantWith: maybeUndef`
    // would make the pre- and post-serialisation node shapes disagree on every workstream that
    // has no siblings, which is most of them.
    const redundantWith = safe.get(w.id)?.redundantWith;
    return {
      id: w.id,
      family: w.family,
      familyRule: w.familyRule,
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
      ...(redundantWith?.length ? { redundantWith } : {}),
    };
  });

  const edges = [];
  const families = new Map();
  for (const n of nodes) {
    if (!families.has(n.family)) families.set(n.family, []);
    families.get(n.family).push(n.id);
  }

  // A sibling edge means "same dispatch" — decided by provenance (fork point + creation time),
  // not by naming (see assignFamilies/inferFamily in discover.mjs). `family` on the edge is the
  // real grouping key; a reader who wants to know HOW it was decided reads `familyRule` off
  // either endpoint's node (fork+creation-time, name-fallback:*, or user-override).
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
  const dups = await duplicates(scanResult, opts);
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
