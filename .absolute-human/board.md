---
id: bar-b-20260802
title: "Holt Bar B confident launch"
status: executing
created: "2026-08-02T17:00:00Z"
updated: "2026-08-02T17:00:00Z"
git_tracked: false
evaluator_enabled: true
total_tasks: 7
completed_tasks: 0
failed_tasks: 0
current_wave: 0
total_waves: 6
---

## Intake Summary

- **Task**: Continue the holt Bar B launch program to a completely confident release.
- **Type**: cross-cutting safety, correctness, benchmark-integrity, UX, CI, and release proof.
- **Complexity**: complex.
- **Problem**: The current main branch is green on its existing suite but still contains known unverified claims and structural gaps listed in the supplied Bar B brief.
- **Success Criteria**: Every safety/correctness claim is reproduced by a meaningful test or CI job; every published number is re-derived or removed; the guard fails closed on unresolved inputs and preserves host-native permissions; the release installs and drives a real repository on the supported matrix; final adversarial, mutation, typecheck, package, and end-to-end gates are green.
- **Constraints**: Preserve all Holt-protected sibling work and stash content; never delete a worktree without `holt gate <id>` and exit-code 0; fail closed on missing evidence; no direct push; follow existing Node ESM/test conventions; no new dependency without live verification.
- **Dependencies**: WF1 guard contract before WF4; WF3 number truth before docs/release; WF5 CI/release proof after code stabilizes; at-risk worktrees must be reviewed before any cleanup.
- **Edge Cases**: shell quoting, BOM/unparseable hook payloads, unresolved variables/globs/braces, git -C, ignored files/cache, submodules/binaries, zero/partial evidence, hostile CI inputs, no-TTY/tiny output, moved repositories and HOME isolation.
- **Testing Strategy**: TDD where behavior changes; unit tests for pure parsing/formatting; integration/e2e for real git/hooks/filesystem; mutation tests for safety invariants; independent benchmark graders; cross-platform CI and clean-room package smoke tests.
- **Board Persistence**: gitignored-by-policy (board is session state; do not delete until convergence).

## Task Graph

| ID | Title | Type | Size | Dependencies | Wave | Status |
|----|-------|------|------|-------------|------|--------|
| BAR-001 | Reconcile baseline, workstreams, stash, and evidence | research | M | - | 0 | in-progress |
| BAR-002 | Guard safety structural closure | code/test | L | BAR-001 | 1 | pending |
| BAR-003 | True-number and grader integrity closure | code/test | L | BAR-001 | 1 | pending |
| BAR-004 | Command correctness hostile matrix | code/test | L | BAR-002 | 2 | pending |
| BAR-005 | Host permission, escape hatch, cadence, and hot path | code/test | L | BAR-002 | 3 | pending |
| BAR-006 | Cross-platform CI, supply chain, provider, and release proof | infra/test | L | BAR-003,BAR-004,BAR-005 | 4 | pending |
| BAR-007 | Final converge: full suite, mutation, typecheck, adversarial, package/install, docs gate | verification | L | BAR-002..BAR-006 | 5 | pending |

### Dependency Graph

```
BAR-001
  ├──> BAR-002 ──> BAR-004 ──┐
  └──> BAR-003 ──────────────┼──> BAR-006 ──> BAR-007
       BAR-002 ──> BAR-005 ──┘
```

## Tasks

### BAR-001: Reconcile baseline, workstreams, stash, and evidence
- **Status**: in-progress
- **Research Notes**: Main is clean at 21e803b34. Suite 799/799, mutation 54/54, typecheck 218 ceiling, hosts check green. Holt reports 35 workstreams, 5 at-risk, 1 stash at-risk, 88 collisions. Do not clean. Unique uncommitted work exists in dupfix-isolation-check/wt, pre-fix, wt-buyer-review-policy, vfy-cigate/wt-revert; rev-supply-chain/wt is unverifiable due ignored SBOM files. Stash@{0} contains orphan_real.js and is unique.
- **Verification**: Baseline commands completed; six read-only audits dispatched; current gaps catalogued.

### BAR-002: Guard safety structural closure
- **Status**: pending
- **Acceptance Criteria**: BOM/unparseable payloads cannot allow; brace/unresolved path classes ask; ignored-file cache state invalidates; rescue/discard binary/submodule content is verified; multi-match verdict semantics are explicit and tested; structural resolution is introduced without regressions.

### BAR-003: True-number and grader integrity closure
- **Status**: pending
- **Acceptance Criteria**: Mutation syntax/import errors are not scored as killed; enterprise bench is relocatable and cannot print all-clear with zero graded cases; latency harness validates verdicts; A/B claims meet an explicitly justified sample-size gate or are removed; every published number has a stranger-runnable command.

### BAR-004: Command correctness hostile matrix
- **Status**: pending
- **Acceptance Criteria**: duplicates, verify, partition, tui, uninstall, shallow CI, impact, and deep-boundary claims either hold under hostile tests or are narrowed honestly.

### BAR-005: Host permission, escape hatch, cadence, and hot path
- **Status**: pending
- **Acceptance Criteria**: allow hooks preserve host-native permission flow; asks/denials are host-capability aware; guarded legitimate commands have a documented human-controlled escape; refusal evidence matches actual reachable targets; cadence and scan performance are bounded and measured.

### BAR-006: Cross-platform CI, supply chain, provider, and release proof
- **Status**: pending
- **Acceptance Criteria**: supported OS matrix runs relevant adversarial suites; workflow permissions and action provenance are hardened without unverifiable claims; provider configs are tested across moved paths/HOME; packed tarball installs and performs the real job; feature scope is intentional.

### BAR-007: Final convergence
- **Status**: pending
- **Acceptance Criteria**: clean final tree except this board/session state; full suite 0 skipped; mutation all scored mutants killed with valid kill classification; typecheck no regression; hosts/published-number gates green; final attack corpus and package/install smoke pass; no unresolved blocker hidden in docs.

## Risk Register

| ID | Risk | Likelihood | Impact | Mitigation | Status |
|----|------|------------|--------|------------|--------|
| R-001 | Guard refactor opens fail-open path | M | Critical | Red tests first, independent destroyer gate, mutation pins, full incident panel | Open |
| R-002 | Parallel worktree contains only copy of a security fix | High | Critical | Holt status/risk, no deletion, inspect/rescue before integration | Open |
| R-003 | Benchmark claims remain unmeasured or grader-vacuous | High | Critical | Make graders fail on missing evidence, independent oracle, published-number gate | Open |
| R-004 | Host hook output bypasses native permissions | High | High | Adapter contract tests against actual hook JSON and host docs | Open |
| R-005 | Cross-platform workflow passes without running intended coverage | M | High | explicit matrix assertions, package smoke, path lint/version probes | Open |
| R-006 | Main changes collide with sibling work | High | High | scope-disjoint patches, inspect all unique work before integration, no blind cherry-picks | Open |

## Execution Log

### Wave 0 - 2026-08-02
- Main baseline reconciled; no worktree deletion performed.
- Holt status/risk: 35 scanned, 5 at-risk, 1 stash at-risk, 29 safe according to machine verdict; safe entries were not removed because cleanup was not the task.
- Audits dispatched for WF1, WF2, WF3, WF4, WF5, and workstream archaeology.
- Baseline: 799/799 tests, 54/54 mutations, 218 typecheck diagnostics at ceiling, hosts check green, eval bench N=20 correct.

## Deferred Work

- No deliberate deferral yet. Any unresolved Bar B claim must be removed or explicitly marked unverified before convergence.
