# Automatic sessions implementation

Status: in progress. This document tracks the full product change; a passing first slice does
not establish completion. The design reviewed on 8 September 2026 is the starting point.

The product must help work finish with fewer interruptions. Existing exact-content authority,
recoverable actions, strict read-only analysis, bounded work, and honest capability reporting
remain requirements. Semantic hints and liveness observations must not become deletion proofs.

## Required outcomes and evidence

| Outcome | Required evidence | Status |
| --- | --- | --- |
| Host-driven participation independent of model memory | Real runner launch, work, child operations, completion and crash journeys | Pending |
| Multiple sessions, editors and background jobs in one workspace | Serialized lifecycle, private credentials, generation fencing, independent attachment holds | In progress |
| Record work before granting mutation | Concurrent operation and cleanup race tests; crash leaves a recoverable intention | Pending |
| Useful immutable checkpoints while producers continue | Capture consistency, private recoverability, exact candidate validation and integration-base comparison | Pending |
| Editor buffers survive failure without overwriting user files | Initial snapshot, ordered updates, version validation, private recovery, real editor exercise | Pending |
| Scoped recovery and honest completion | Pending operations drain; late events cannot retire a successor; task retirement separate from physical reclamation | Pending |
| Coordinating information improves normal work | Targeted path and dependency updates, measured ordinary successful journeys and false interventions | Pending |
| All applicable actions honor shared evidence | Gate, clean, discard, rescue, protect, restore, purge and landing integration tests | Pending |
| CLI, MCP, TUI and graph tell the same story | Contract and rendered interaction checks for sessions, pending work and checkpoints | Pending |
| Fast and bounded operation | Unrelated/read-only fast paths, bounded records, measured event/report latency, storage retention | Pending |
| Hooks remain quiet during ordinary work | No repeat notices on unchanged prompts, actual compaction refresh, independent readers, no Stop continuation, no duplicate session-end warning | Focused real CLI checks pass; full integration verification pending |
| Explicit backend and host capabilities | Live validation distinguished from fixtures; optional integrations do not disable existing behavior | Pending |
| Disposable generated work by construction | Runner-owned overlay provenance and separate preservation of user patches | Pending |
| Safe upgrades and lifecycle management | Legacy leases, unknown versions, concurrent clients, interrupted migration, install/upgrade/uninstall | Pending |
| Preserve all existing strengths | All 61 feature families reviewed; full tests, mutation checks, type check, host and release integrity checks | Pending |

Implementation and verification must use an isolated task worktree. Growth activity is paused
while this work is active. No claim of universal visibility or absence of gotchas is established
by this checklist.

## Implemented and exercised

The current branch includes the following working paths. This is development evidence, not a
release declaration:

- Linux command supervision waits for detached descendants. Killing the wrapper retains the
  session; a durable supervisor completion receipt enables later automatic recovery.
- Multiple automatic sessions coexist with legacy manual leases. Ordered events, handoff
  generation fencing and private buffer recovery preserve independent holders.
- The local VS Code extension was exercised in VS Code 1.136.1 with actual typing, unsaved text
  recovery, saving, language reopen and normal shutdown. Installation/uninstallation preserves
  modified extension files rather than deleting them.
- Unchanged prompt hooks stay silent. Independent readers receive context, actual compaction
  refreshes it, and Stop never asks the host to continue an otherwise finished task.
- Committed checkpoints can be prepared and tested in a separate checkout. Passing validation
  binds the candidate, base, command, raw tracked inputs and process-tree completion.
- A validated candidate can land in the selected integration checkout while its producer keeps
  working. The integration test verifies preservation of unrelated staged and unstaged bytes.
  Active editor ownership and overlapping local work refuse landing without discarding either.
- CLI and MCP expose checkpoint capture, validation, landing and recovery. TUI/graph show saved
  committed versions and active sessions. Lifecycle actions preserve ownership during quarantine.

## Remaining release work

The full regression and 168-case mutation runs were started on 9 September; their completion
must be checked before integration or release. Type checking, host-manifest checks and the
development supply-chain audit were checked independently.

Unfinished scope includes Windows/macOS process-tree supervision, editor reconnect and non-file
buffers, consistent uncommitted checkpoints, generated overlays, scoped discard coordination,
storage retention, comprehensive latency measurements, and final visual/action integration.
Landing recovery currently resumes only after a complete checkout with matching bytes and a
positive writer completion receipt. An interruption inside checkout remains held for review;
automatic completion of that phase and adversarial crash coverage are still required.

The implementation stays on its task branch until these requirements are satisfied. Existing
public v0.4.7 does not contain this development work.
