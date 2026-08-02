# holt — published benchmarks

Every number on this page is reproducible from this repository with the command shown beside it.
No number is published without its conditions. Each section states what was measured, how the
fixture was constructed, the exact command to reproduce it, and one sentence on what the result
does and does not establish. Runtime for the figures below: Linux, Node v24.18.0, holt v0.3.0.

## 1 · Correctness at scale

**What this measures:** whether verdict correctness holds, and how wall-clock scan time grows, as
the number of worktrees increases from 100 to 1000.

**Fixture:** `eval/bench.mjs` builds one repository (a 50-file base) with N worktrees in a fixed,
deterministic composition per 10 worktrees — 3 committed-ahead (unique function each; must be
flagged, not disposable), 2 uncommitted-only (unique file each; must be flagged at-risk), 3 landed
decoys (base independently has the same content; must be disposable), 2 empty (must be disposable)
— then scans, analyzes, and **re-grades every verdict** against the planted ground truth. A scanner
that got faster by skipping work fails the run outright, which would void the speed number.

| N | total | per worktree | verdicts |
|---|---|---|---|
| 100 | 715 ms | 7.2 ms | 100/100 correct |
| 300 | 2.15 s | 7.2 ms | 300/300 correct |
| 1000 | 7.97 s | 8.0 ms | **1000/1000 correct** |

Reproduce: `node eval/bench.mjs 1000` (first argument is N).

**These verdicts were re-graded after the harness was found unable to disagree.** Until this was
fixed, `eval/bench.mjs` had two stacked defects, and they are the same shape as the one holt exists
to catch — a measurement that cannot tell *nothing was wrong* from *nothing was measured*:

- **The `hold` category was fail-open.** `const s = report.safe.find(...); if (s?.safe) error()`
  records an error only when the answer is TRUE, and a worktree holt never reported on yields
  `undefined` — falsy — which is silence. Erasing all the committed-ahead worktrees from every
  array in holt's report still printed `hold 9/9 held ✓` at exit 0. At N=1000 that was **300 of
  the 1000 verdicts never graded**.
- **The summary line was `planted / planted`** — literally `${expect.hold.size}/${expect.hold.size}`,
  structurally incapable of printing a disagreement. holt actively calling every committed-ahead
  worktree SAFE TO DELETE — the loudest possible product failure — still printed `hold 9/9 held`
  beside its own error list.

The grader now treats NOT FOUND as an error in its own right, before any verdict is inspected, and
every numerator above has a denominator counting what was actually graded. `holt` itself was not
wrong: re-run against the corrected grader, all 1000 verdicts are genuinely correct. The number was
true and unverified, which is not the same as verified, and this page is not allowed to print the
difference. `test/unit/eval-validity.test.mjs` now grades the grader.

### The same measurement on a REAL repository, which contradicts the line above

This section used to end "Time grows linearly in N, not worse." That was measured only on the
fixture described above — a 50-file base — and it is **false on a real repository**. Measured on
redis (1,858 files per worktree), with peak RSS captured alongside wall clock:

| N worktrees | wall clock | peak RSS | verdicts |
|---|---|---|---|
| 50 | 1.9 s | 240 MB | 50/50 correct |
| 100 | 5.0 s | 254 MB | 100/100 correct |
| 200 | 5.8 s | 270 MB | 200/200 correct |
| 400 | 22.1 s | 307 MB | 400/400 correct |
| 800 | 71.8 s | 346 MB | **800/800 correct** |

16× the worktrees costs 37× the time. That is **super-linear**, and `--no-symbols` recovers only
2.6× of it at N=800 (71.8 s → 27.4 s), so symbol extraction is not the majority of the cost —
something scaling with registered worktree COUNT is, and the exact mechanism is not yet identified.

**File count is the harder wall.** The Linux kernel (94,852 files) with a full-repo diff took
**16 min 26 s and 1.75 GB RSS**, against 886 ms for the identical diff with `--no-symbols` — a
1113× cost attributable entirely to ctags at that file count. 50,000 uncommitted small files in an
otherwise trivial repository took 87.8 s versus 0.3 s. Reproduce: shallow-clone the repository,
touch every tracked file, and run `holt status --json --include-primary`.

**Means:** verdict correctness does NOT degrade at real scale — 800/800 correct on a real
repository with real file counts, which is the property that matters most. **Does not mean:** the
timings scale linearly. They do not, on either axis, and a repository of Linux's size is not
usable with symbol extraction on today. `--no-symbols` is the working answer there and the
super-linear worktree-count growth is an open defect, recorded here rather than omitted.

## 2 · The monster round (worst-case composition)

**What this measures:** verdict correctness, byte-level content survival through the full
destructive loop (`protect` → `clean --apply` → `rescue`), and detection by the symbol layer —
all inside one repository engineered to contain every hazard holt is designed to handle, at once.

**Fixture:** `eval/monster.mjs` builds a single repository containing junk heaps, buried gold (one
real file among heaps of junk), lying names in both directions (`DELETEME` holding gold, `KEEP` and
`IMPORTANT` empty), unicode names and symbols, names with spaces, a worktree literally named
`x.lock`, nested git repos, foreign locks, broken registrations (backing directory deleted out from
under git), gitignored-only trees, landed decoys with rich multi-commit history, work duplicated
across exactly two trees, and valuable work buried in each of the 50 supported languages.

| Trees | gold50 symbol detections | verdicts | bytes after destructive loop |
|---|---|---|---|
| 121 | 41/41 | all correct | all intact |
| 151 (pre-gold50 composition) | — | all correct | all intact |

Reproduce: `node eval/monster.mjs 120` · a 40-tree round is pinned in CI (`test/e2e/monster.test.mjs`).

What the monster caught while being built — the reason it exists: an ls-tree unicode-quoting bug
(rescue refused correct captures), a Dockerfile-variant mapping gap (`Dockerfile.prod` had no
parser), and four false failures in its own first grader. Each is now a fix plus a permanent
regression test.

**Means:** the scan, verdict, and destructive-action pipeline hold up under a deliberately
worst-case, adversarially-composed repository, not only clean fixtures. **Does not mean:** the
monster is exhaustive — it encodes the hazards its authors thought to plant; §3's randomized
fuzzer exists specifically for the states nobody thought to hand-write.

## 3 · Randomized invariant fuzzing (independent oracle)

**What this measures:** whether holt ever violates its single core safety invariant — *if the
oracle finds recoverable content holt could lose, holt must not call the worktree safe, and
`clean --apply` must not remove it* — under randomly generated, not hand-imagined, worktree states.

**Fixture:** 8 seeded rounds × 6 worktrees, each a random composition across every dimension holt
reasons about (committed-ahead / committed-but-landed / uncommitted-tracked / untracked / deleted
files / renames / detached vs. branched / nested junk). Ground truth comes from an oracle that
shares no code with holt: raw `git status` plus direct file-content comparison against a pristine
base checkout. The seed is logged in the assertion message, so any failure reproduces exactly
rather than being reported as a one-off flake.

**48/48 states, zero violations.** Reproduce: `node --test test/e2e/fuzz-invariant.test.mjs`

**Means:** across 48 independently-checked, randomly generated states, holt never called unsafe
content safe and never removed it. **Does not mean:** seeded random sampling, however reproducible,
is exhaustive proof over all possible git states — it is evidence against the blind spots of the
hand-written tests, which is a narrower claim than universal safety.

## 4 · Clean-room degradation (controlled environment)

**What this measures:** whether holt degrades loudly rather than silently when the optional
analysis backends it normally shells out to are entirely absent, and whether its safety, detection,
CLI, and invariant-fuzzer tests still pass in that state.

**Fixture:** a `node:22-slim` container with git only on `PATH` — no `ctags`, no `enry`, no
`jscpd`, no `jj`.

| | |
|---|---|
| backend reported | `regex fallback (ctags-not-found)` — loud, not silent |
| safety + detection + CLI + invariant fuzzer | **47/47 pass** |

Reproduce: run the same suites inside a minimal container with the optional tooling stripped, e.g.
`docker run --rm -v "$PWD":/holt -w /holt node:22-slim bash -c "apt-get update -qq && apt-get
install -y -qq git && npm ci --omit=optional && node --test test/unit/safety.test.mjs
test/e2e/detection.test.mjs test/e2e/cli.test.mjs test/e2e/fuzz-invariant.test.mjs"`

**Means:** losing the optional backends degrades analysis capability (symbol-level lookups fall
back to regex) without degrading safety or correctness on the suites named above. **Does not mean:**
every code path was exercised in this configuration — only those four suites were run against it.

## 5 · Agent A/B (pilot — n stated, never dropped)

**What this measures:** whether an autonomous coding agent, given identical prompts that never
mention holt, avoids destroying irreplaceable work in a repository where every surface-level signal
(file and directory names, timestamps) is built to mislead it — with and without holt available as
an acting tool.

**Fixture:** Claude Haiku 4.5 subagents against the 16-worktree lying-names gauntlet described in
§2's trap catalogue, graded solely from the resulting filesystem state — the agent is never shown
what "correct" looks like.

| Arm | Irreplaceable survived (safety) | Cleanup (utility, mean) |
|---|---|---|
| naked | 4/6 (one trial destroyed all 5) | 43% |
| holt, warnings only | 6/6 | 0% — froze |
| holt, shipped (MCP acting tools + routed AGENTS.md + protect) | **6/6 — never lost work** | **73%** |

**The two columns are different measurements.** Safety is holt's guarantee and it was perfect
(6/6; the naked agent lost the only copy of a file in 2 of 6 trials). Utility measures what a
small model (Haiku 4.5) *chose* to clean — holt agents cleaned more on average, but a cheap model
is variable and one trial per arm cleaned almost nothing (the naked arm hit 0/5 twice). That
variance belongs to the model, not holt: `holt clean --apply` removes every provably-disposable
worktree deterministically, with no model in the loop, so utility has a 100% path that does not
depend on agent judgment at all.

Two shipped-config trials ran the full loop (protect → clean → rescue) autonomously, with rescue
refs verifiable in-trial. Reproduce: `node eval/prep.mjs build gauntlet 6` → drive any agent against
the generated repos → `node eval/prep.mjs grade`.

An earlier run against a simpler, separate cleanup scenario (not the lying-names gauntlet above)
measured +33 pts safety / +30 pts utility, Fisher exact p = 0.227 at n = 6 — reported here as
directional, not significant.

**These are pilots: 3–6 trials/arm.** **Means:** in this small sample, making holt available as
an acting tool did not cause the agent to destroy irreplaceable work, and in the warnings-only arm
the agent froze rather than act incorrectly. **Does not mean:** a trial count this small is
statistically powered to support a general safety or utility claim — no percentage or p-value in
this section should be read as more than directional until trial counts are much larger.

## 6 · Test-suite integrity

**What this measures:** whether the test suite is meaningful — passing, and demonstrably able to
catch real defects, not merely green.

**Fixture:** the mutation harness (`test/mutation.mjs`) deliberately breaks specific, high-stakes
behaviors in the source — the ones where being wrong is dangerous, such as authorizing deletion of
work or running a command that was promised never to run — then asserts the covering tests go red.
Mutations run against a disposable copy of the repository; a tripwire fingerprints the live repo
after every mutation and exits 2 on any drift, and that tripwire was itself proven able to fire by
deliberate sabotage.

| Instrument | Result |
|---|---|
| tests | 752 passing (`npm test`) — the count that EXECUTES on a clean CI runner |
| deliberate-defect mutations | 43/43 killed (`npm run test:mutation`) — first run was 10/12; both survivors were real holes, fixed |
| mutation isolation | mutations run in a disposable repo copy; a tripwire fingerprints the live repo after every mutation, exits 2 on any drift, and was proven able to fire by deliberate sabotage |
| languages asserted by symbol name | 50 (`test/unit/languages.test.mjs`) |

CI compares the published number against tests that actually PASSED, never against the total
defined, and prints every skip — because a skipped test prints `ok` while never running, and
counting it would inflate the claim.

That rule used to cost a number rather than fix one. `test/e2e/opencode-plugin.test.mjs` drives
the real `opencode` binary and skipped when it was absent, so CI measured 697 while README claimed
698 and this table explained a 698-versus-699 split: three numbers for one suite, and the gate
failing the build over the difference instead of the difference being removed. The deeper cost was
worse — opencode is one of the 29 integration targets holt wires, and the only test that drives it
for real had therefore never executed in CI once.

CI now installs opencode, so nothing skips and there is one number: **752 defined, 752 passing.**
A developer without opencode installed sees 751 passing and 1 skipped, and `npm test` says so.

**Means:** the suite was checked to fail when the exact high-stakes behavior it claims to cover is
broken, not merely observed to be green. **Does not mean:** 42 hand-picked mutations amount to full
mutation coverage of the codebase — they target the highest-stakes behaviors by design (see
`test/mutation.mjs` for why hand-picked mutations were chosen over exhaustive Stryker mutation).

## 7 · Independent 50-language oracle (bench50) — the `unique` question

**What this measures:** whether `risk --json`'s `unique[]` verdict — the answer to "what would be
LOST if this worktree vanished", the finding the product exists to give — agrees with an
independent, content-hashing oracle that shares no code with holt, across 900 worktrees spanning
every language holt publishes coverage for.

**Fixture:** `bench50`, a measurement apparatus that lives outside this repository on purpose (see
its own README for why). 50 repositories, one per supported language, each carrying the same 18
worktree shapes — including `wt-unique` (committed work found nowhere else), `wt-ignored`
(gitignored-only content, invisible to `git status`), `wt-symbol-dup` (declares `wt-unique`'s exact
symbol names in a different file with different content — the one shape designed to make a
symbol-based and a content-based witness disagree), and `wt-nul` (unique work in a file containing
a literal NUL byte). The oracle answers from git plumbing and raw content hashing only.

**Before:** precision 1.00, recall 0.76 (tp 494, fp 0, tn 250, **fn 156** / n 900). Precision was
never the problem — holt never wrongly claimed uniqueness. It stayed silent about 156 worktrees
that DID hold irreplaceable content, which is the specific failure mode this product exists to
prevent: worse than a false "disposable", because nothing downstream ever raises it as a concern
in the first place.

Every one of the 156 was one of four causes, and every one was **holt being wrong**, not the
oracle asking a different question:

| cause | count | root cause | fix |
|---|---|---|---|
| `wt-unique` + `wt-symbol-dup` name collision | 100 | `uniqueWork()` (`src/analyze.mjs`) decided a symbol was "unique to W" purely by NAME — a `Handler` class in one worktree and an unrelated `Handler` class in a sibling zeroed BOTH worktrees' unique-symbol count, even though their files' actual bytes were completely different | a name collision now downgrades a symbol from "unique" only when the FILE it lives in also has a content-identity twin (raw or whitespace/line-ending-normalised hash, `src/content-identity.mjs`) in the colliding worktree — a name match that is not also a content match is not the same work |
| `wt-ignored` | 50 | `uniqueWork()` built its at-risk file count from the uncommitted/untracked layers only; the gitignored layer was invisible to it entirely, so a worktree whose ONLY content was gitignored came back `nothing-unique` — while `safeToDelete` (a different function, `contentAtRisk()`) already refused to call the SAME worktree disposable | gitignored file count now feeds the same at-risk calculation the uncommitted/untracked layers already did, so `unique` and `safeToDelete` can no longer disagree about whether the identical content is "nothing" or "unverifiable" |
| `wt-nul` | 6 (of 50 languages: C#, R, D, Objective-C, MATLAB, F#) | enry's binary-content sniff (a NUL byte anywhere near the start of a file) misclassified real, compiling source as `{"language":"","type":"Binary"}` whenever the file's only unusual content was a NUL byte inside a comment — and holt trusted that verdict as "not code", skipping symbol extraction entirely, even though ctags parses the identical bytes cleanly | ambiguous-extension files (`.cs`, `.r`, `.d`, `.m`, `.fs`, …) that enry flags `Binary` are now reclassified from a NUL-stripped COPY used for classification only; ctags always reads the real on-disk bytes. A plain "ignore enry and guess by extension" fallback was tried and rejected — it silently reintroduces the same failure for `.fs`/`.pro`, which ctags maps to Forth/INI by default and extracts nothing from |

The count above is exact, not sampled: every `unique` disagreement in the corpus was one of these
four worktree shapes, confirmed by bucketing all 156 misses by worktree name (100 + 50 + 6 = 156).
None of them is the documented content-vs-symbol divergence bench50's own scorer names for the
`duplicate` question (`wt-unique`/`wt-symbol-dup` legitimately disagreeing on "did these two build
the same thing") — that divergence is real, it is a different question, and it is scored and
reported separately (`duplicateSymbolSideChannel` in `score-holt.mjs`'s output), never folded into
the numbers below.

**After:** precision 1.00, recall **1.00** (tp 650, fp 0, tn 250, fn 0 / n 900). Zero `unique`
disagreements against the oracle, and the scorer's own `knownGaps.symbolVsContentUnique` and
`nulByteSymbolBlindSpot.languages` counters — its running tally of documented, un-fixed gaps —
both read zero.

Reproduce (from the bench50 apparatus, sibling to this repository):
`node generate.mjs && node oracle-run.mjs && node score-holt.mjs`, then read
`byQuestion.unique` in the resulting `score-holt.json`.

**Means:** across every supported language and all four adversarial worktree shapes this corpus
plants against the `unique` question, holt's answer now matches an independent, content-hashing
oracle exactly. **Does not mean:** the `duplicate` question is equally clean — see the next
section for the exact number and why it is not moving further.

## 8 · Independent 50-language oracle (bench50) — the `duplicate` question

**What this measures:** whether `duplicates --json`'s pairs agree with the same oracle's
content-identity verdict for "did these two workstreams build the same thing", across all 153
pairs of the 18 worktrees in each of the 50 language repositories (7,650 pairs total).

**Measured:** precision 0.75, recall 1.00 (tp 150, **fp 50**, tn 7450, fn 0 / n 7650). Every one
of the 50 false positives is the *same* planted case, once per language: `wt-unique` and
`wt-symbol-dup` declare identical symbol names with identical bodies, in two different files,
where the second file also carries two trailing comment lines the first does not. Symbol-identity
(and a declared-body comparison — see below) correctly says "these built the same thing"; the
oracle's content-identity check correctly says "these files are not byte-identical". Both are
right, about different questions — this is bench50's own documented, deliberately unresolvable
case (see its README, "What this apparatus does NOT prove", #1 and #2), not a fresh defect, and it
is why the number above does not read 1.00: closing it would mean holt stopping believing its own
correct, hand-verified answer in favour of the oracle's, on the one shape built to make them
disagree. The harder, hand-labelled `duplicate-symbol` side channel bench50 raises for exactly
this case — "do the two sides' declared symbols and bodies actually agree" — holt answers
correctly on all 850 instances (`duplicateSymbolSideChannel.holtAgreesWithHandLabel`), confirming
this is the oracle's known limitation, not holt's.

**What changed, and what did not:** `duplicates()` (`src/analyze.mjs`) used to count a symbol
name as "shared" between two workstreams whenever both added it, regardless of what either side's
declaration actually said. `discriminativeSymbols()` already filters names common across a LARGE
fraction of workstreams (boilerplate), but that filter has a floor: a name shared by as few as two
or three workstreams never crosses it, so two agents independently naming an unrelated helper
`process`, `handler` or `validate` read as duplicate work. Verified directly (not assumed): a
controlled fixture with two workstreams that each declare a function named `process` with
unrelated bodies was reported as a 100%-similarity duplicate before this fix, and reported nothing
after (`test/e2e/detection.test.mjs`, "P3 PRECISION"; the same class is also covered adversarially
in `test/e2e/break-it.test.mjs`, "ATTACK: coincidental common names must not fabricate
duplicates" — previously passing only because it accepted a *hedged* false positive, tightened to
require none at all). The fix: a name is only counted as shared evidence for a given PAIR once the
two sides' actual declared bodies agree (whitespace- and comment-insensitive, across the
single-line and block comment styles of every language in this corpus) — read once per
(workstream, symbol), cached, and never invoked when either side is unreadable, so it can only
REMOVE a name from "shared" on positive evidence of disagreement, never add one symbol-identity
did not already find. That is why bench50's `duplicate` precision and recall are unchanged before
and after (0.75/1.00 both times, `duplicateSymbolSideChannel` 850/850 both times): the false
positive this fix targets does not occur anywhere in this corpus, by the corpus's own design (see
above) — it targets a real, separate, small-fan-out risk this apparatus does not plant, and the
regression test proves it directly instead.

**The recall half, and why this corpus cannot grade it.** That precision was first bought with a
*textual* comparison of the two declared bodies, and text equality answers "did they type the same
bytes", not "did they build the same thing" — a genuine duplicate almost never types the same
bytes (one wraps the signature, the other keeps it on one line; one indents with tabs, the other
with four spaces). Under the textual gate every such pair was a MISMATCH and the real duplicate
went **unreported**. bench50 structurally cannot see that regression, because `wt-symbol-dup`
plants bodies that are byte-identical to `wt-unique`'s — the one input shape on which textual and
token-stream equality can never disagree. The comparison is now over a whitespace-normalised,
string-literal-aware token stream: outside a literal a whitespace run collapses (to nothing beside
a delimiter, so re-wrapping an argument list is the same code); inside a literal whitespace is
data and stays byte-significant; and when the lexer cannot be sure it tracked the literals — an
unterminated quote, which is what a Rust lifetime, a Lisp quote, an apostrophe in a trailing
comment and a window truncated mid-string all look like — it bails and the strict textual verdict
stands, so being unsure can only cost recall, never precision. For declared-body comparison of the
*same* symbol name this is sound even in off-side-rule languages: the caller already per-line
trimmed away every indent, and two valid Python bodies cannot differ in only a line boundary
(splitting or joining statements needs a `;` or a `\`, both kept and compared). Pinned in
`test/e2e/detection.test.mjs` ("P3 RECALL: the same function reformatted in two worktrees is still
duplicate work", and "P3 PRECISION: whitespace inside a string literal is content, not layout" for
the boundary), and at the granularity no worktree fixture reaches in
`test/unit/declared-body-tokens.test.mjs`, whose five contract clauses are each shown to be
load-bearing by seven mutants of the lexer, 0 survivors.

Reproduce: `node score-holt.mjs`, then read `byQuestion.duplicate` and
`duplicateSymbolSideChannel` in the resulting `score-holt.json`. Re-measured after the
token-stream change on the full 50-language corpus: `duplicate` precision **0.75**, recall
**1.00** (tp 150, fp 50, tn 7450, fn 0 / n 7650), all 50 false positives still the single
`wt-unique + wt-symbol-dup` shape (`knownGaps.symbolVsContentDuplicate` 50), side channel
850/850 — i.e. the recall relaxation cost this corpus's precision nothing.

**Means:** the 0.75 precision on this question is fully accounted for by one documented,
hand-verified case bench50 itself says should not be used to grade symbol-level precision, and a
real, different false-positive class (small-fan-out name coincidences) is now closed and covered
by a regression test. **Does not mean:** duplicate detection is content-aware in general — outside
the specific declared-body check above, it is still a name match; `holt duplicates --deep` (jscpd
token-clone detection) is the tool for the same logic written twice under different names.

## 9 · Independent 50-language oracle (bench50) — `disposable`, `conflict`, `refuse`, and the oracle's own proof of independence

**What this measures:** the same 900-worktree, 50-language bench50 corpus and the same independent
oracle as §§7–8, scored on the three remaining questions `risk`/`clean`/`collisions`/`gate` answer
— `disposable` (safe to delete), `conflict` (two worktrees' uncommitted state cannot both land),
and `refuse` (holt correctly declines to certify a worktree it cannot verify) — plus the
apparatus-wide agreement rate across all five questions, and the one number that would void every
other one in this document if it were nonzero: how often holt ever called a worktree "safe to
delete" that the oracle says holds content found nowhere else.

**Oracle independence is checked, not asserted.** Every number in §§7–9 rests on the oracle in
`bench50/oracle/` sharing no code with holt. `node independence-check.mjs` proves that three ways,
in increasing strength: **(1)** a static walk of every import reachable from the oracle's entry
points, plus a comment-and-string-stripped scan for escape hatches (`require`, `createRequire`, a
literal path into this repository) — measured: 6 reachable files, 0 violations, 0 escape hatches;
**(2)** the real oracle run under a Node module-resolution hook that aborts the process the instant
any specifier resolves inside `/home/raed/grove`; **(3)** the hook proven to actually fire —
`probe-imports-holt.mjs` deliberately imports holt and must succeed with the hook absent and fail
with it present, because a clean run under a hook that is not watching looks identical to a clean
run under one that is. Measured: exit 0 without the hook, exit 1 with it, the abort message
present. All three passed on the run this section reports (`independence-proof.json`,
`"independent": true`) — reproduce with `node independence-check.mjs --corpus <the corpus dir>`.

**Fixture:** identical to §7 — 50 repositories (one per supported language), 18 worktrees each, all
153 worktree pairs per repository, ground truth from an oracle that answers strictly from git
plumbing and raw content hashing, never from holt.

**Measured:**

| question | precision | recall | tp | fp | tn | fn | n |
|---|---|---|---|---|---|---|---|
| disposable | 1.00 | 1.00 | 250 | 0 | 650 | 0 | 900 |
| conflict | 1.00 | 0.96 | 48 | 0 | 7600 | 2 | 7650 |
| refuse | 1.00 | 1.00 | 50 | 0 | 850 | 0 | 900 |

**The catastrophic-failure check.** Across all 900 worktrees, holt called disposable **zero** that
the oracle says held content found nowhere else — the specific failure mode that destroys
irreplaceable work. 0 events in 900 trials bounds the true rate at **≤0.33%** (95% one-sided
exact), stated as a bound rather than as 0%, on purpose: the corpus is finite and "never observed"
is not the same claim as "cannot happen".

**The two `conflict` misses:** `r03-a-ts` and `r06-a-java`, each the planted
`wt-conflict-a`/`wt-conflict-b` pair, 2 of the corpus's 50 (one designed conflict pair per
repository — the set of which 2 repositories miss has moved between scoring runs taken minutes
apart during active development of this exact code path, most recently `r12-a-kt` alone; see the
falsification policy below for why a moving miss is reported as what it is rather than smoothed
into a single stale number). The oracle's `git merge-tree` snapshot comparison says these collide;
`holt collisions --json --all` did not surface either pair (`absent-from-holt-report` in the
scorer's disagreement log). Recorded here rather than rounded away — the specific repositories are
named so the next run confirms or refutes this exact claim, not a vaguer one.

**Overall, all five questions, all 18,000 claims** (the 850 `duplicate-symbol` claims the oracle
abstains on are excluded exactly as §8 excludes them — scoring against a question nobody answered
is not measurement): holt agreed with the oracle on **17,948 of 18,000 — 99.71%**. Every
disagreement is accounted for: 50 are §8's documented `duplicate` false positive (the one
content-vs-symbol case bench50 deliberately cannot resolve), and 2 are the `conflict` misses above.
None is a silent, unexplained gap.

Reproduce: `node generate.mjs && node oracle-run.mjs && node score-holt.mjs`, then read
`byQuestion.disposable`, `byQuestion.conflict`, `byQuestion.refuse`, `headline.agreement`, and
`catastrophic` in the resulting `score-holt.json`.

**Means:** on this corpus, holt never once authorised deleting irreplaceable work, never once
wrongly refused to certify a worktree it could in fact verify, and matched an independent oracle on
99.71% of 18,000 claims spanning 50 languages — with the oracle proven independent by static
analysis, a runtime hook, and a probe proving the hook fires, not merely by the comment saying so.
**Does not mean:** the corpus is real-world messiness (§8's own limitations list — synthetic,
shallow, one file per shape — applies here too), a `conflict` miss whose specific repository moves
run to run is a stable, closed defect just because its magnitude (2 of 50) looks small, and 99.71%
agreement is not "correct" — it is exactly the number of claims checked, with the disagreements
named, not averaged away.

## 10 · Enterprise benchmark — real repos, real mess, real scale

**What this measures:** holt's full pipeline (discover → scan → analyze) and every CLI command
against REAL repositories with messy worktrees containing uncommitted files, gitignored secrets,
binary files, huge files (>2MiB), and landed duplicates. Unlike §1's synthetic fixture, this tests
against real codebases with real file types, real symbol extraction, and real git operations.

**Fixture:** `eval/enterprise-bench.mjs` fetches a real repo once into a read-only cache, then
takes a DISPOSABLE local clone per run, creates N worktrees with noise-level 2 (the maximum:
binary files, huge files, gitignored content, and landed duplicates), runs the full pipeline,
grades every verdict against planted ground truth, and drives every CLI command (`status`, `risk`,
`collisions`, `graph`, `clean`, `doctor`, `stash`) for valid output and correct exit codes. One
warmup run is discarded and reported separately; the figures below are the median and p90 of three
measured runs.

### The numbers this section used to carry were wrong, and how

| repo | files | wt | **total p50** | p90 | cold | **scan p50** | **peak RSS** | graded | disposable |
|---|---|---|---|---|---|---|---|---|---|
| redis | 1,861 | 31 | **2.22 s** | 3.10 s | 0.73 s | **1.63 s** | **222 MB** | 30/30 | 15/15 |
| postgres | 7,680 | 31 | **5.01 s** | 5.39 s | 3.71 s | **3.67 s** | **422 MB** | 30/30 | 15/15 |
| holt-self† | 20,176 | 31 | **10.1 s** | 17.1 s | 19.3 s | **7.05 s** | **845 MB** | 30/30 | 15/15 |

† `holt-self` is NOT a 20,176-file codebase. holt is 111 JavaScript files and 41,321 lines; the
repository also tracks a `manyfiles/` directory of 20,000 one-line fixture files committed by
accident in c2019447a. This row therefore measures git and holt against 20,000 trivial files, not
against holt's own source, and it is kept only as the "many small files" shape. Read the redis and
postgres rows for the realistic picture.

The table that stood here previously read `holt-self 974 ms / 73 MB`, `redis 2.78 s / 1.2 GB`,
`postgres 12.2 s / 1.2 GB`, and its own prose described that as "RSS scales with file count
(73 MB → 1.2 GB from 20K → 7.7K files)" — more files producing less memory. It was not a scaling
law; it was a broken harness, and the sentence explaining it should have been the tell. Four
defects produced it, every one of them the same shape as the bug holt exists to catch — a
measurement that cannot tell *nothing was wrong* from *nothing was measured*:

1. **The grader passed when holt found nothing.** `report.safe.find(...)?.safe` is `undefined` for
   a workstream holt never reported on, `undefined` is falsy, and no error was recorded — for any
   of the four planted categories. Runs against stale worktree registrations, where holt correctly
   reported on nothing at all, printed `✓ NO ISSUES FOUND`. The 1.2 GB figures are that error
   path: holt trying to scan 30 directories that were not there.
2. **The workstream column was always zero.** The harness read `disc.worktrees`; `discover()`
   returns `workstreams`. The field never existed.
3. **"Peak RSS" was a single sample taken after the pipeline had finished.**
4. **The clone was cached and then committed into.** The landed-duplicate case has to commit to
   base, so each run inherited the previous run's commits: "median of three runs" was the median
   of three different repositories.

All four are fixed, and `test/unit/eval-validity.test.mjs` now grades the grader — including the
case where holt reports nothing, which is the one that produced the numbers above.

**Verdict:** on the corrected harness, 30 of 30 planted workstreams are *found and graded* in
every repo, with zero wrong verdicts and 15/15 disposables correctly identified. Cost is real and
worth stating plainly: **peak RSS is hundreds of megabytes**, roughly 0.04–0.12 MB per tracked file
per 31 worktrees, and a 2 GB CI container running holt over a large monorepo with many worktrees
is a configuration to test before relying on. Wall-clock grows sublinearly in file count (4.1×
the files costs 2.3× the time from redis to postgres).

Reproduce: `node eval/enterprise-bench.mjs all --worktrees 30 --noise-level 2 --runs 3`

**Does not mean:** 30 worktrees is the ceiling (§1 tests up to 1000), the repos represent every
ecosystem (C and JavaScript only — Rust, Go, Python, Java, and monorepos are future work), or that
"zero issues" means holt is bug-free — it means the planted ground truth was correctly identified
at this scale, with this noise level, on these repos. The measurements were taken on a loaded
14 GiB developer machine; the redis samples spanned 0.73–3.10 s, so treat p50 as an order of
magnitude, not a precise figure.

## Falsification policy

Five times during development, the measuring instrument itself was wrong (a fabricated A/B
result, a grader checking the wrong path, a leaked answer key, a silently-dropped symbol class,
and the mutation harness executing the very defect it simulated against the live repo).
Each is now a named regression test or a permanent tripwire. If you find a number on this page
you cannot reproduce, that is a bug — file it.
