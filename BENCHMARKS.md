# Holt evidence and benchmark contract

**Last reviewed: 2026-08-05.**

This document defines what Holt's evaluation harnesses measure and what must accompany a public
claim. It is not a scrapbook of one machine's output. A result belongs here only when a reader can
identify the corpus, denominator, command, runtime, source state and immutable artifact that
produced it.

## Current public result status

Holt is available to install and independently evaluate. This repository publishes the protocol,
fixtures and evidence requirements so users can reproduce the checks on their own repositories and
agent hosts.

- No aggregate agent A/B rate or lift is published yet. The retained six-trial run is a historical
  pilot and qualitative failure corpus, so it is not used as a savings, adoption, or performance
  number in the website, README, release notes, or sales material.
- The 2026-08-05 Codex/Luna active-hook smoke is also **diagnostic, not comparative product
  evidence**. Its treated cell omitted the installed Holt CLI required by the hook's own
  remediation, and one trial per cell is below the 20-valid-trial publication floor. Its value is
  the refusal corpus and deterministic reproductions, not a rate or lift.
- No universal latency, scale or correctness rate is claimed. Synthetic and real-repository runs
  answer different questions and may not be extrapolated into one another.
- Host configuration and payload fixtures are contract evidence, not proof that a real host
  process refused a destructive command.
- Release-specific test and mutation evidence belongs with the exact tagged artifact that produced
  it. Figures are never copied forward by hand or used as a substitute for independently running
  the protocol.

No current test count or mutation score is published. The product is ready to try; release-specific
figures remain tied to the exact artifact that produced them rather than becoming a stale headline.

## Publication rules

A benchmark result is public evidence only when all applicable fields are present:

| Field | Requirement |
|---|---|
| Corpus | Name the repository or fixture and whether it is synthetic, planted or naturally occurring |
| Source identity | Commit IDs for external repositories; Holt commit and dirty-state digest before and after the run |
| Denominator | Expected and observed repositories, worktrees, warmups, measured runs, planted states and graded states |
| Runtime | OS, architecture, Node version, CPU, memory and load context |
| Command | Exact executable and arguments, including bounds and optional backends |
| Distribution | Warmups separated from measured samples; publish p50/p90 or the complete sample set, not one convenient run |
| Correctness | Every planted object must first be found, then graded; missing evidence invalidates the run |
| Artifact | Dated JSON output plus SHA-256 stored outside the scratch directory |
| Interpretation | State what the result does and does not support; do not turn a named corpus into a universal claim |

## Exact evidence versus advisory evidence

The two must remain separate in benchmark claims as well as product copy.

| Surface | What may be measured | What must not be inferred |
|---|---|---|
| Destructive authority | Exact path, operation, mode, object type and object ID; durable copies; dirty, untracked and ignored-path risk; fail-closed unknowns | Semantic equivalence or universal safety outside the graded corpus |
| Collisions | Merge-tree-proven conflicts and separately labelled predicted file/symbol overlap | That every predicted overlap will conflict |
| Duplicates | Symbol/body overlap candidates; exact durable twins as a separate class | That two tasks are semantically identical |
| Impact | Define/reference and textual dependency hints | A conflict or runtime behaviour change |
| Order and partition | A heuristic plan over the observed relationship graph | A compatibility certificate or knowledge of the agents' intended tasks |
| Verify | Combination-only failures observed by the supplied test command | Compatibility when the supplied suite is incomplete |

## 1. Synthetic scale and correctness

```bash
node eval/bench.mjs 1000 --runs 5 --warmups 1 --out evidence.json
```

`eval/bench.mjs` creates a deterministic composition of committed-ahead, uncommitted-only,
landed-decoy and empty worktrees. Every planted worktree must be discovered before its verdict is
graded. The run fails on a wrong or missing verdict and records every timing sample, phase split,
runtime field, source-state digest and artifact checksum.

This harness supports claims about the exact requested synthetic composition. It does not support
real-repository latency or asymptotic extrapolation.

## 2. Real-repository scale

```bash
node eval/enterprise-bench.mjs --list
node eval/enterprise-bench.mjs redis --worktrees 50 --noise-level 1 \
  --runs 3 --warmups 1 --out evidence.json
```

The harness uses pinned external repository commits where configured, creates a disposable clone
for each run and refuses a single measured sample. Its artifact records expected versus observed
warmups/runs, planted versus graded verdicts, source stability and correctness failures. A missing
worktree is a failed measurement, not a clean result.

Results from one repository describe that repository, commit, planted composition and runtime.
They do not establish that the same latency or file-growth curve applies to other codebases.

## 3. Adversarial composition and invariant fuzzing

```bash
node eval/monster.mjs 120
node --test test/e2e/fuzz-invariant.test.mjs
```

The monster fixture combines hazards that isolated tests can miss: misleading names and histories,
untracked and ignored paths, Unicode paths, nested Git repositories, foreign locks, duplicates and
multi-language symbol extraction. It grades detection, verdicts and byte survival through the
protect/clean/rescue loop.

`monster.mjs` currently prints to the terminal and does not emit the runtime/source identity,
planted denominator and checksum-bearing JSON artifact required by this document. Its CI fixture is
useful regression coverage, but no monster result or language-coverage headline is publication-
eligible until that artifact path exists and accounts for every planted case.

The invariant fuzzer uses replayable seeded state compositions and an independent filesystem/Git
oracle. A green run is evidence for the recorded seeds and states, not exhaustive proof over every
possible Git state.

## 4. Agent evaluation

The current contract is in [eval/README.md](eval/README.md). A publishable comparison requires:

- at least 20 valid trials per treatment;
- a fully decontaminated control environment;
- exact agent, model, host and version;
- identical prompts and complete transcripts;
- independent filesystem and Git grading;
- safety and utility reported together;
- invalid/backend-failure trials excluded from rates and named;
- a full-product treatment whose installed CLI, proactive context, MCP/config, blocking hook and
  Git integration all come from the same pinned runtime and are all proven reachable/live.

Mechanism-isolation cells remain useful for diagnosis, but they cannot be presented as the
product. In particular, a blocking hook without the installed CLI it tells the agent to run is an
invalid product arm. The publishable product comparison is `no-holt` versus `integrate-only`, where
`integrate-only` now means the actual pinned `holt integrate` result plus a reachable private
executable named `holt`. The isolated `destructive-authority` cell is diagnostic-only and forces
publication refusal.

The current `eval/prep.mjs` and `eval/run.mjs` implementations enforce this machinery contract.
They keep `no-holt`, `context-only`, `integrate-only`, `protect-only` and
`destructive-authority` as separate diagnostic identities; reject a generic `holt` arm; suppress
rates and lifts when the control, integration or live activation is contaminated or unproven; and
retain complete stdout/stderr transcripts with treatment-specific denominators and evidence
hashes. For Codex, a publishable `integrate-only` row additionally requires observed
`SessionStart`, `UserPromptSubmit` and `PreToolUse` calls, a stable pinned CLI, exact benchmark hook
payload retention, and the expected AGENTS, MCP, hook and Git surfaces. That makes a qualifying run
possible—it does not manufacture one. Until at least 20 valid, isolated trials per publishable
treatment have been run and their artifacts retained, there is still no publication-eligible rate
or lift.

### 2026-08-05 diagnostic smoke and resolved product defects

The corrected active-hook smoke artifact is
[`eval/results-codex-luna-gauntlet-smoke-trusted-hook-v2-20260805.json`](eval/results-codex-luna-gauntlet-smoke-trusted-hook-v2-20260805.json).
Its live PreToolUse wrapper recorded 42 complete invocations, but the treated trial produced ten
refusals and completed only 7/9 planted disposable removals. The control completed 9/9. Because
this is one trial and the treated cell was not the full product, no causal rate or lift may be
reported.

The refusal-by-refusal evidence is in
[`eval/codex-luna-hook-smoke-causal-analysis-20260805.md`](eval/codex-luna-hook-smoke-causal-analysis-20260805.md)
and its adjacent checksum-bearing JSON. It found zero proven saved-loss events, nine proven
task-level false positives and one unresolved shell-variable batch whose truncated suffix prevents
a verdict. The two utility misses were never attempted or blocked; the agent trusted adversarial
worktree names even after Holt labelled both worktrees disposable.

[`eval/reproduce-codex-empty-ignored-dir.mjs`](eval/reproduce-codex-empty-ignored-dir.mjs)
preserves the original pinned-runtime failure: one clean linked worktree containing an empty
ignored `dist/` directory triggered a remediation loop, and a common two-variable target chain was
over-refused. That artifact is historical defect evidence, not the current-product verdict.

The current source accepts and honestly handles the empty-directory case and resolves the bounded
variable chain. The deterministic corrected-runtime check is retained in
[`eval/results-corrected-overrefusal-matrix-20260805.json`](eval/results-corrected-overrefusal-matrix-20260805.json)
with its adjacent SHA-256 file. It is explicitly a local reproducer, not an agent A/B result. A new
paired smoke remains blocked until the final release tarball is npm-installed in an ambient-masked
runtime and passes MCP protocol/version preflight. Only a clean final-artifact smoke may authorize
the repeated 20-valid-trial run; no rate or lift is published from the diagnostic runs.

## 5. Host and MCP evidence

The MCP protocol test starts the real stdio server, initializes it, enumerates the executable tool
schema and calls tools against disposable repositories. Host integration tests generate and parse
the current project configuration and exercise documented payload/output contracts.

That evidence supports the labels in [HOSTS.md](HOSTS.md): blocking contract-tested, MCP plus
advisory, or advisory. It does not support "verified live" until a real host process is driven
through a destructive command and observed refusing it.

## 6. Test-suite integrity

```bash
npm test
npm run test:mutation
```

The ordinary suite covers unit, end-to-end, protocol, action and invariant behaviour. The mutation
harness deliberately weakens high-stakes mechanisms and requires the relevant tests to fail. It
runs in a disposable repository copy and fingerprints the live source tree after each mutation.

A partial run, a run with skipped/invalid cases, or a mutation run with any survivor is not eligible
for a public headline. The permanent historical `10/12` record documents an early falsification
that exposed two real holes; it is not a competing current score.

## Evidence storage

Benchmark scratch space is disposable. Artifacts are not. For harnesses that implement `--out`,
write outside the marked work directory, retain the printed SHA-256 beside the JSON and link that
exact artifact from any public number. A console-only harness such as the current `monster.mjs` is
not artifact-capable merely because this document asks for one. If there is no stable artifact,
publish the method and the gap—not the number.
