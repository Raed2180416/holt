# verify v2 — the verdict ladder (P4 design, synthesized 2026-07-31)

Source: 7-angle SOTA sweep + completeness critic (8 agents, ~1M tokens; full findings in the
session workflow journal). Every design decision below cites its evidence.

## What the field taught us

1. **Nobody has shipped it.** Multi-language, high-precision AND high-recall semantic-conflict
   detection does not exist anywhere — every measured technique is Java-only (Soot/EvoSuite
   infrastructure), evaluated on 50–150 hand-curated scenarios of the EASY case (both sides
   touch the same element). holt's no-shared-file impact-pair case has no published benchmark.
2. **The precision/recall split is structural.** Dynamic/test-based = high-P/low-R (ICSE'24:
   P .80/R .14; SAM best-combo R 32% — arXiv:2310.02395). Static reachability = the recall
   side (P .65/R .88 vs reference subsample — arXiv:2310.04269; 62% recall at 30M-SLOC C++
   scale, SAP HANA call-graph "dangerous dependencies"). You need BOTH, layered.
3. **More machinery can make it WORSE.** Adding pointer/alias analysis collapsed recall 28%→7%
   (arXiv:2507.20081). holt's ctags-grade conservative graph is not a compromise — it is the
   published right regime for fail-closed detection. NEVER build alias analysis for this.
4. **The precision lever is refactoring-awareness, not aliasing.** 54% of static FPs are
   rename/move/extract noise; filtering them cost ~zero recall (+22% precision — RefFilter,
   arXiv:2510.01960). holt can approximate this from its own symbol signatures.
5. **The cheapest real semantic oracle is the language's own checker.** A type/build error on
   the MERGED tree when both sides pass alone is a PROVEN interaction (Bucond: 100% P /
   88–100% R on that conflict class; Crystal: ~⅓ of real conflicts are build conflicts).

## The ladder

Each rung is strictly cheaper than the next, every rung fail-closed, recall accumulates, and
every verdict names WHICH rungs ran and which were unavailable for this language — parity of
honesty where there cannot be parity of machinery.

| Rung | Check | Cost | Evidence base |
|---|---|---|---|
| R0 | duplicate qualified-name/signature added by both sides (merges clean, won't compile) — from the EXISTING symbol table | ~zero | jFSTMerge's documented FN class |
| R1 | type/build differential: run `tsc --noEmit` / `cargo check` / `go vet` / `javac` /… on A-alone, B-alone, A+B-merged scratch trees; merged-only failure = proven interaction | seconds | Bucond 100%P; Crystal ⅓-of-conflicts |
| R2 | transitive nomination: bounded-depth call-graph closure from each side's changed symbols, INTERSECTED (TOM's UUT selection); + git co-change mining as the language-blind hidden-coupling signal; − RefFilter-style rename suppression | pure graph, offline | SAP HANA 62%R; Code Maat; RefFilter +22%P |
| R3 | targeted differential test runs: aim the existing 3-run verify machinery at the R2-nominated surface instead of the whole suite; batch low-risk sets and bisect on failure (Dorfman/TAP group testing) to scale past C(N,2) | existing infra, scheduled | ICSE'24 dynamic P .80; TAP batching |
| R4 | (deferred) generated characterization probes at the shared surface; per-language runtime infra required | high | SAM lineage, R 32% ceiling known |

Cross-cutting:
- **Adjudication memory** (jj/rerere pattern): persist human dismissals keyed on
  symbol+context hash — reports show only what's NEW; strictly never-worse.
- **Watch mode** (merge-queue pattern): re-verify each worktree against the CURRENT heads of
  its siblings, not a snapshot — agents' branches move mid-session.
- **Verdict language** stays holt's: "these rungs found nothing" is reportable;
  "compatible" is not. R-unavailable is stated per language, never silent.

## Build order (each lands with tests, ships alone)

1. R0 duplicate-decl check — one pass over data holt already holds.
2. R1 checker table + doctor detection + 3-way scratch runs (extends verify.mjs's existing
   scratch-worktree machinery; the command table starts with the top ~10 languages and
   degrades by declaring).
3. R2 transitive closure + co-change miner + rename suppressor (all on existing ctags/git data).
4. R3 targeted/batched scheduling of the existing suite runner.
5. Adjudication memory; watch mode.

Critic's flags worth holding: SVF/LLVM-IR as a future non-JVM static substrate; Daikon-style
invariant mining and Diffy-style record-replay as future R4 variants; SymDiff/POPL'88
non-interference as the formal lineage if we ever want proofs on a subset. The hardest
unsolved remains verdict TRUST across a 50-language matrix with no assumed build infra — the
ladder answers it by degrading loudly per rung per language, never by pretending coverage.
