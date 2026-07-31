# holt — published benchmarks

Every number on this page is reproducible from this repository with the command shown beside it.
No number is published without its conditions. Each section states what was measured, how the
fixture was constructed, the exact command to reproduce it, and one sentence on what the result
does and does not establish. Runtime for the figures below: Linux, Node v24.18.0, holt v0.2.0.

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
| 100 | 532 ms | 5.3 ms | 100/100 correct |
| 300 | 1.33 s | 4.4 ms | 300/300 correct |
| 1000 | 5.44 s | 5.4 ms | **1000/1000 correct** |

Time grows linearly in N, not worse. Reproduce: `node eval/bench.mjs 1000` (first argument is N).

**Means:** verdict correctness does not degrade and scan time scales predictably as worktree count
grows. **Does not mean:** this composition is synthetic and evenly balanced across four fixed
categories — it says nothing about correctness on adversarially-shaped repositories; see §2 and §3
for that.

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

| Arm | Irreplaceable survived | Acted |
|---|---|---|
| naked | 4/6 (one trial destroyed all 5) | 3/6 |
| holt, warnings only | 6/6 | 0/6 — froze |
| holt, shipped (MCP acting tools + routed AGENTS.md + protect) | 5/5, 5/5, 5/5 | 8/9, 8/9, 1/9 removed |

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
| tests | 199 passing (`npm test`) |
| deliberate-defect mutations | 13/13 killed (`npm run test:mutation`) — first run was 10/12; both survivors were real holes, fixed |
| mutation isolation | mutations run in a disposable repo copy; a tripwire fingerprints the live repo after every mutation, exits 2 on any drift, and was proven able to fire by deliberate sabotage |
| languages asserted by symbol name | 50 (`test/unit/languages.test.mjs`) |

**Means:** the suite was checked to fail when the exact high-stakes behavior it claims to cover is
broken, not merely observed to be green. **Does not mean:** 13 hand-picked mutations amount to full
mutation coverage of the codebase — they target the highest-stakes behaviors by design (see
`test/mutation.mjs` for why hand-picked mutations were chosen over exhaustive Stryker mutation).

## Falsification policy

Five times during development, the measuring instrument itself was wrong (a fabricated A/B
result, a grader checking the wrong path, a leaked answer key, a silently-dropped symbol class,
and the mutation harness executing the very defect it simulated against the live repo).
Each is now a named regression test or a permanent tripwire. If you find a number on this page
you cannot reproduce, that is a bug — file it.
