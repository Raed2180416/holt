# holt — published benchmarks

Every number on this page is reproducible from this repository with the command shown beside it.
No number is published without its conditions. Machine for the figures below: AMD Ryzen 7 7840HS w/ Radeon 780M Graphics, Linux,
Node v24.18.0, holt @ `e5cfa43`.

## 1 · Correctness at scale

`eval/bench.mjs` builds N worktrees in a fixed planted composition (30% committed-ahead, 20%
uncommitted-only, 30% landed-decoy, 20% empty), scans, and **re-grades every verdict** — a
scanner that got faster by skipping work fails the run, voiding the speed number.

| N | total | per worktree | verdicts |
|---|---|---|---|
| 100 | 532 ms | 5.3 ms | 100/100 correct |
| 300 | 1.33 s | 4.4 ms | 300/300 correct |
| 1000 | 5.44 s | 5.4 ms | **1000/1000 correct** |

Linear in N. Reproduce: `node eval/bench.mjs 1000`

## 2 · The monster round (worst-case composition)

`eval/monster.mjs` builds one repository containing every hazard at once: junk heaps, buried
gold, lying names in both directions, unicode names and symbols, names with spaces, a worktree
named `x.lock`, nested git repos, foreign locks, broken registrations, gitignored-only trees,
landed decoys with rich history, work duplicated across exactly two trees — and **valuable work
buried in each of the 50 supported languages**, graded three ways: verdict, byte survival
through the full destructive loop (protect → clean --apply → rescue), and detection by the
symbol layer itself.

| Trees | gold50 symbol detections | verdicts | bytes after destructive loop |
|---|---|---|---|
| 121 | 41/41 | all correct | all intact |
| 151 (pre-gold50 composition) | — | all correct | all intact |

Reproduce: `node eval/monster.mjs 120` · A 40-tree round is pinned in CI (`test/e2e/monster.test.mjs`).

What the monster caught while being built — the reason it exists: the ls-tree unicode-quoting
bug (rescue refused correct captures), the Dockerfile-variant mapping gap
(`Dockerfile.prod` had no parser), and four false failures in its own first grader.

## 3 · Randomized invariant fuzzing (independent oracle)

8 seeded rounds × 6 worktrees of random state compositions, checked against an oracle that
shares no code with holt (raw `git status` + direct content comparison against base):
*holt never calls oracle-risky content safe, and `clean --apply` never removes it.*

**48/48 states, zero violations.** Reproduce: `node --test test/e2e/fuzz-invariant.test.mjs`

## 4 · Clean-room degradation (controlled environment)

`node:22-slim` container, git only — no ctags, no enry, no jscpd, no jj:

| | |
|---|---|
| backend reported | `regex fallback (ctags-not-found)` — loud, not silent |
| safety + detection + CLI + invariant fuzzer | **47/47 pass** |

## 5 · Agent A/B (pilot — n stated, never dropped)

Claude Haiku 4.5 subagents, identical prompts that never mention holt, graded from filesystem
state. The gauntlet: 16 worktrees where every surface signal lies.

| Arm | Irreplaceable survived | Acted |
|---|---|---|
| naked | 4/6 (one trial destroyed all 5) | 3/6 |
| holt, warnings only | 6/6 | 0/6 — froze |
| holt, shipped (MCP acting tools + routed AGENTS.md + protect) | 5/5, 5/5, 5/5 | 8/9, 8/9, 1/9 removed |

Two shipped-config trials ran the full loop autonomously (rescue refs verifiable in-trial).
**These are pilots**: 3–6 trials/arm. Earlier cleanup-scenario run: +33 pts safety / +30 pts
utility, Fisher exact p = 0.227 at n = 6 — reported as directional, not significant.
Reproduce: `node eval/prep.mjs build gauntlet 6` → drive any agent → `node eval/prep.mjs grade`.

## 6 · Test-suite integrity

| Instrument | Result |
|---|---|
| tests | 199 passing (`npm test`) |
| deliberate-defect mutations | 13/13 killed (`npm run test:mutation`) — first run was 10/12; both survivors were real holes, fixed |
| mutation isolation | mutations run in a disposable repo copy; a tripwire fingerprints the live repo after every mutation, exits 2 on any drift, and was proven able to fire by deliberate sabotage |
| languages asserted by symbol name | 50 (`test/unit/languages.test.mjs`) |

## Falsification policy

Five times during development, the measuring instrument itself was wrong (a fabricated A/B
result, a grader checking the wrong path, a leaked answer key, a silently-dropped symbol class,
and the mutation harness executing the very defect it simulated against the live repo).
Each is now a named regression test or a permanent tripwire. If you find a number on this page
you cannot reproduce, that is a bug — file it.
