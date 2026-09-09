# Complete handoff: automatic sessions and useful coordination

Prepared 9 September 2026. **This is unfinished development work, not a release.**

## Assignment from the owner

Complete the entire original scope end to end. The owner is transferring the work to a new
agent to finish autonomously, including implementation, integration, testing, documentation,
packaging and the repository's release workflow. Do not stop after a plan, a first slice or a
list of limitations. Preserve the strengths of existing Holt while making normal work fast,
automatic and low-friction. Hooks must not repeatedly interrupt users or restart completed
agent turns. Use creative freedom to resolve implementation obstacles and provide useful,
verified alternatives where a platform cannot provide a particular primitive.

The owner's final assignment supersedes the earlier ten-minute development timebox. Work
independently; no subagent delegation was authorized for this implementation. Growth/outreach
is paused. Do not resume marketing, send messages to other people or create growth automations.

Read these documents together:

1. [Original complete architecture](AUTOMATIC-SESSIONS-ARCHITECTURE.md): the full scope,
   primary research, 61 existing feature mappings, 18 failure scenarios and acceptance experiment.
2. This handoff: current code, evidence, unfinished work and important implementation cautions.
3. [Implementation ledger](AUTOMATIC-SESSIONS-IMPLEMENTATION.md): development milestones.
4. [Executable feature matrix](FEATURE-PROOF-MATRIX.md), `scripts/run-feature-proof.mjs`,
   `AGENTS.md` and `CONTRIBUTING.md`: repository-specific proof and operating contracts.

The architecture's header deliberately says "proposed": it was written before implementation.
Its old counts describe the reviewed baseline. Do not read either the proposal or a current
feature-inventory count as evidence that a capability is complete.

## Repository and exact starting point

- Repository: <https://github.com/Raed2180416/holt>
- Continue branch: `codex/holt-automatic-sessions-20260908`.
- Baseline: `b99e098e214f4e84388ffa9d6fa6b675f951732a`.
- Main implementation milestone: `573d7cc5` (52 files; sessions, editor, checkpoints,
  validation, landing, hooks, surfaces and tests).
- Follow-up implementation commit: `3179aaea653c5b08cc20d83c7c2dd6811d78d805`
  (preserves existing recovery wording contracts while keeping MCP schemas compact).
- This handoff and the original architecture are added in a subsequent documentation commit
  on the same branch. Use the remote branch tip, not main alone.
- At handoff, public main was still `b99e098e`; fetch again before integrating. The desktop's
  primary checkout separately contains unpublished work and must not be reset or force-pushed.
- Public v0.4.7 is the earlier release. It does **not** contain this development branch. The
  package version on this branch has not yet been advanced for a new release.

In a fresh web-agent environment, fetch/clone the repository and check out this branch into
an isolated task worktree. Follow the checkout policy in `AGENTS.md`; do not use an integration
checkout as a scratchpad. Install dependencies from the committed shrinkwrap. The previous
environment used `npm ci --ignore-scripts`, Node 24.20.0 and Git 2.55.0. Honor the declared
Node/Git minimums and verify optional backends explicitly.

Code exploration instructions in the owner's environment require codebase-memory-mcp tools
first. They were unavailable during this implementation; ordinary source search was used only
after checking availability. If available in the new environment, index the repository and use
them before code exploration. Always read source before editing it.

All desktop implementation files were committed before handoff. There is no required hidden
patch or uncommitted implementation to retrieve. Local test logs and live-editor evidence are
not portable proof artifacts; reproduce relevant checks in the new environment.

## What is implemented and has focused evidence

| Area | Current implementation | Evidence and limits |
| --- | --- | --- |
| Session authority | `src/sessions.mjs`, `src/ownership.mjs` | Multiple automatic sessions, legacy manual lease coexistence, ordered/idempotent events, private capabilities, generation-fenced handoff, pending operations, retained expired state. Focused real Git tests pass. |
| Host API | `src/session-host.mjs`, package export `holt/sessions` | Register before work, acknowledge operation completion, drain, finish, handoff, capture buffers, pin committed checkpoints. This is not yet automatic participation in every agent host. |
| Linux command lifetime | `src/session-runner.mjs`, `bin/holt-supervisor.py` | `holt run -- <argv>` uses a Linux subreaper and waits for detached descendants. Preserves argument boundaries and exit codes. It observes lifetime; it is not a sandbox. |
| Runner crash recovery | `src/session-recovery.mjs` | Private supervisor completion records survive a killed wrapper. A later wrapped command can retire a positively drained old runner. Killing the supervisor itself still leaves an unresolved hold. |
| Editor text recovery | `src/session-buffers.mjs`, `src/session-bridge.mjs` | Private immutable captures preserve UTF-16 text, including lone surrogates and CRLF. Exclusive JSON export never overwrites a user's file. EOF retains the attachment. |
| VS Code bridge | `src/integrate/editor/*`, `src/integrate/editor-install.mjs` | Real VS Code 1.136.1 exercised typing, private unsaved recovery, saving, language reopen and normal retirement. Installation receipts preserve modified/unowned files. Reconnect and non-file coverage are unfinished. |
| Quiet lifecycle hooks | `src/agent.mjs`, `bin/holt.mjs`, host adapters | Unchanged prompts stay silent; independent reported sessions have independent context; actual compaction can refresh it. Stop is neutral. Cursor's generated Stop continuation hook was removed. |
| Immutable committed versions | `src/checkpoints.mjs` | Capture/ref pinning, verification, bounded inventory, merge candidate preparation against a specific base. A producer can keep editing a later version. |
| Exact candidate validation | `src/checkpoint-validation.mjs` | Separate registered checkout, explicit argv, supervised descendants, raw tracked input comparison, pinned candidate/base and retained output digest. Failed tests, an observed failing detached child and hidden tracked-input changes refuse a pass. |
| Candidate landing | `src/checkpoint-landing.mjs`, worker, `src/git.mjs` | Supervised fixed worker, durable job, original index/raw affected-path captures, native Git ref/index locking and expected-base update. Normal test preserves unrelated staged and unstaged edits while producer continues. Active editor and overlapping local work refuse safely. Crash coverage is incomplete. |
| Surfaces | CLI, `src/mcp/server.mjs`, render/TUI/graph | Checkpoint operations and buffer recovery are exposed; existing worktree views show automatic holders and saved commits. Complete candidate-oriented planning and interactive recovery are still missing. |
| Quarantine actions | `src/actions.mjs` | Clean, restore and purge coordinate final transitions with ownership. Active sessions in quarantined storage prevent conflicting actions. The remaining action families need scoped integration. |
| Supply chain | `src/python-audit.mjs`, `src/supply-chain.mjs`, manifest/bundle | Python/native/process authority is declared, not disguised. Development audit passed 7/7. Static audit is an inventory, not a sandbox or complete Python semantic proof. |

Current public interfaces include `run`, `session`, `editor` and `checkpoint`; checkpoint has
`list`, `capture`, `show`, `prepare`, `validate`, `validation`, `land` and `recover`. Validation
requires exact argv after `--`. Land must run in the intended integration checkout at the
validated base. See actual help and schemas for current syntax; do not infer missing flags.

## Verification status: do not overstate it

- First broad regression during final stabilization: **1,763/1,767 passed**. Failures were
  three MCP wording assertions and one native-path portability lint finding.
- Next broad run: **1,765/1,767 passed**, no skips/cancellations. The remaining two failures
  expected "restore argv" and "keeps the branch" in MCP descriptions. That run took about
  97 seconds in the previous environment and started before the final wording corrections.
- Commit `3179aaea` fixes those final two assertions. A targeted run then passed **5/5**:
  the clean/purge/recovery contracts, MCP wire-schema size and native-path lint.
- A broader focused run passed **88/88** across sessions, runner recovery, editor installation,
  bridge, quiet hooks, checkpoints, MCP protocol, feature inventory and host contracts.
- A documentation/feature-inventory/README synchronization run passed **26/26**.
- Type checking reached **zero diagnostics**. Host-manifest check passed. The development
  supply-chain audit passed **7/7**. These are scoped checks, not a signed release certificate.
- The **168-case mutation run is incomplete**. It was deliberately stopped at the owner's
  earlier deadline after five observed defects were caught. There is no passing mutation
  artifact for this branch.
- There is **no full all-green run of the final complete implementation**, no final installed
  artifact proof, no cross-platform proof of the new features, and no release of this work.

Do not reuse old v0.4.7 release evidence, combine runs across changing source and call them one
exact-artifact pass, raise the 12,000-character MCP schema ceiling, waive mutation survivors,
or turn missing optional backends/platform skips into positive proof.

## Remaining work packages — complete all applicable parts

### 1. Finish the authority service and normal host participation

The architecture calls for a lightweight local service/client path whose durable state remains
authoritative. Current stdio editor and library clients are useful foundations, but there is
no completed common socket/named-pipe service with reconnect, connection identity and all host
clients. Evaluate whether to unify the existing bridges behind that service; do not create two
independent ownership authorities. Keep ordinary one-shot analysis independent of daemon uptime.

Wire at least one real agent's supported start/tool-success/tool-failure/session-end lifecycle
so the user does not have to remember ownership calls or wrap every command manually. Preserve
the host's actual identity; do not invent user/session attribution from an arbitrary process ID.
Record admitted operations before granting writes. Handle canceled/failed tools and lost replies.
Do not retire on model Stop, idle CPU, permission waits or an expired heartbeat. Unsupported
host events must be reported as a capability boundary without globally blocking ordinary work.

Prove a full real-host start → ordinary work → background work → checkpoint → finish/recovery
journey with no ownership chore and no repeat prompt noise. Setup/doctor should verify event
delivery with a harmless probe, not merely report that configuration exists.

### 2. Reconnect and reconciliation, including ambiguous failure

Implement editor/host reconnect using durable session identity and generation rotation. A
successor must reconcile pending operations and exact buffer versions; stale old writers or
delayed finishes cannot release the successor. Handle sleep, abrupt EOF, helper restart,
client restart, missing acknowledgements and bridge upgrade. Do not accumulate a fresh orphaned
session on every reconnect. Bound retries and expose one actionable recovery state.

Runner recovery needs explicit treatment of supervisor death and pre-launch failures. Review
receipt creation failures, operation-start failures, close-ack loss, heartbeat ordering and
the capture-output UTF-8 chunk boundary. The current output collector uses per-chunk decoding;
use a streaming decoder so split multibyte characters remain intact.

### 3. Finish editor coverage without inventing workspace ownership

Support initial dirty documents, rapid edits, save-as, rename, multiple windows, workspace
removal, reload, crash and extension disable/upgrade. Distinguish clean deactivation from
claiming that the whole editor window ended. A disabled extension cannot keep observing edits.

Add untitled/non-file text to a private editor-level recovery inventory when no worktree is
proven. Do not attach an untitled document to an arbitrary open repository. Add notebook and
custom-editor coverage through supported APIs or explicit capability reporting and a concrete
preservation route. Preserve document identity/version, encoding/EOL metadata and ordered text
without silently saving it over disk. Test remote workspace identity on the host owning storage.

Keep the writable editor attachment through asynchronous document events. A clean last buffer
or repeated `isDirty` check cannot prove that no edit is about to happen.

### 4. Consistent uncommitted checkpoints and lineage

Current checkpoints cover committed trees only. Add consistent snapshots of staged-only,
unstaged, untracked and ignored content with explicit coverage of available unsaved buffers.
Use a briefly quiesced cooperating writer set or a verified managed snapshot backend. An
ordinary recursive copy or two matching status reads while arbitrary writers run is insufficient.

Preserve distinct index and disk versions, raw bytes/modes/symlinks, intentional empty paths,
builtin Git conversions and external-filter boundaries. Pin lineage and recovery objects before
acknowledgement. Never transplant the snapshot into the live producer. Capture failure retains
the previous complete version plus a named incomplete transaction.

Handle subdirectory invocation consistently: checkpoint source identity should bind the actual
worktree root rather than a display path chosen by the caller. Examine sparse/submodule/LFS/jj
coverage explicitly; do not imply a Git lock controls Jujutsu storage.

### 5. Complete landing and validation recovery

This is safety-critical unfinished work. Current recovery can publish the index/ref after a
fully completed checkout whose bytes still match. **It does not automatically finish an
interruption inside `read-tree`**; that state remains held for review. Provide a verified,
idempotent path for each interrupted phase without overwriting a concurrent replacement.

Inject real process crashes before/after every durable step: session creation, intent,
original-index capture, ref prepare, checkout start, partial checkout, next-index publication,
index rename, ref commit, completion receipt and session retirement. Verify preservation of
index-only work, ignored/untracked paths, binary data, symlinks, modes, split indexes, sparse
worktrees and moves. Test a moving base, changed symbolic HEAD, native Git contention, lost
commit acknowledgements and reused paths. Verify that the original writer tree has drained
before recovery; killing the outer Node wrapper alone does not prove its Git child ended.

Use `src/git.mjs`'s existing environment and verb boundary. Do not globally allow merge/reset/
checkout to bypass it. A Git transaction updating the checked-out referent already accounts for
HEAD; explicitly queuing `symref-verify HEAD` with that update produced a duplicate-update error
and was removed. Recheck supported Git-version behavior rather than assuming latest-only APIs.

Review strict validation-record shapes and candidate/parent/ref bindings; verify inputs did not
change unnoticed during tests. A certificate describes the supplied command and observed
coverage, not universal correctness. The detached-child failure count currently covers child
statuses observed by the supervisor, not every status already consumed by another parent.

Finish validation-job recovery and retained scratch-worktree lifecycle. Existing `src/verify.mjs`
also needs review for descendant drain and safe scratch cleanup; new checkpoint validation must
not leave the old pair-verification workflow weaker or inconsistent.

### 6. Apply shared evidence to every action at its actual scope

Complete integration for discard/recover-discard, native file tools, shell guards, rescue with
release, protect/unprotect/auto, gate, clean, restore, purge and landing. Retain worktree-wide
attachments for physical moves, but use affected-path evidence for narrow operations.

Do not block every file edit because some unrelated editor exists. Do not let a destructive
action erase another writer's unsaved/pending version merely because a backup exists. Preserve
both and offer a diff, handoff, checkpoint or supported isolated route. Avoid a self-deadlock
where a pre-tool hook registers its own operation and then treats that operation as a foreign
hold. Bind exemptions to the exact authenticated operation, not an owner label.

Test both sides: actual hazardous writes are stopped/preserved and ordinary unrelated writes,
new files, safe disposal and completed task retirement finish without needless intervention.

### 7. Version-aware coordination and dependency observations

Add bounded observations of what a session actually read and the version consumed. Connect
changes to targeted, deduplicated re-read/test advice. Pending/unsaved/checkpointed symbols can
reuse existing parsers off the critical path, with source version and coverage labels.

Integrate these into context, impact, collisions, hotspots, duplicate/reuse suggestions and
partitioning. Intended edits remain advisory; speculative plans must not reserve the repository
indefinitely. Parser failures degrade structural advice, not lifecycle authority. Do not claim
semantic serializability or collect hidden model reasoning.

### 8. Plan, order, graph and TUI must operate on useful versions

Ready immutable checkpoints should appear in review plans and landing order even while a newer
producer version remains active. Current views attach saved-version metadata to worktree rows;
they are not yet the complete candidate-centric interaction model.

Show relationships among sessions, resources, produced versions, validation and dependencies
without a new graph node per heartbeat. Add practical review/validate/land/recover/handoff/task-
retirement actions, clear retained-storage reasons and bounded empty/error states. Logical task
retirement must not claim physical space was reclaimed. CLI/MCP/TUI/graph must return the same
fresh decision model and not invent deletable worktrees for checkpoint-only objects.

### 9. Optional managed execution and disposable generated resources

Evaluate and integrate an existing backend rather than building a new kernel/filesystem. The
original design discusses AgentFS and CubeSandbox; another existing backend is acceptable if
its actual guarantees meet the tested contract. No managed backend has been implemented yet.

Construct explicitly authorized disposable output layers from known provenance. Keep source
and user patches in separately preserved storage. Drain or freeze the contained writer set
before snapshot/reclamation, prove completion, record inputs/backend/authority, and invalidate
the disposable contract when an unknown writer or user override enters. Do not retrofit an old
`node_modules`, `dist` or ignored directory into disposable status based on its name.

Test a real dependency reinstall/build journey with fewer interruptions and preservation of a
manual dependency patch in an unmanaged directory. Filesystem rollback cannot undo remote API
effects. Do not expose host credentials, Docker sockets or broad host write mounts by default.

### 10. Verified platform and remote-storage contracts

Implement or provide a supported managed-runtime route for Windows/macOS process lifetime and
snapshot needs. The ordinary CLI must keep working without Python, a daemon or a sandbox when
the requested operation does not need one.

Useful research established immediately before handoff:

- Apple's current XNU `bsd/sys/event.h` explicitly says `NOTE_TRACK`, `NOTE_TRACKERR` and
  `NOTE_CHILD` have been unsupported since macOS 10.5. Do **not** implement a pretend complete
  macOS process tree using those constants or a PID/process-group absence scan.
  [Primary source](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/event.h).
- Windows Job Objects can contain descendants. Assigning after an ordinary process starts is
  too late. Review creation-time `PROC_THREAD_ATTRIBUTE_JOB_LIST` and supported alternatives;
  even create-suspended then assign has a crash gap. Completion-port notifications alone are
  not a complete absence proof. Query actual job state and control breakaway/inheritance.
  [Microsoft explanation](https://devblogs.microsoft.com/oldnewthing/20230209-00/?p=107812),
  [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).
- Docker daemon 29.7.2 was available in the desktop environment. This is only an availability
  observation: no Docker backend or snapshot guarantee was implemented or validated. The web
  environment must probe its own capabilities.

Run actual platform CI and installed-runtime tests. Do not call conditional skips cross-platform
proof. Remote repositories need authority on the host owning storage; synchronized JSON or a
shared network directory alone does not coordinate separate machines.

### 11. Bounded storage, fast paths, upgrade and recovery access

Implement reference-aware retention and storage accounting across active sessions, buffer CAS
objects, runner proofs, checkpoint/candidate refs, validation worktrees, landing receipts and
editor installation recovery copies. Explicitly protect the last recovery copy; limits must
produce useful bounded behavior rather than silently evicting it or retaining everything forever.

Measure p50/p95/p99 event, hook, report and recovery overhead, memory and bytes retained. Preserve
the existing unrelated/read-only tool fast paths and avoid a full repository scan per keystroke.
Deduplicate changes by affected version/reason and bound reconnect/event queues.

Complete mixed-version/downgrade/unknown-record and concurrent-client tests. Old clients must
not interpret a new schema as unclaimed. Preserve lock continuity and recovery accessibility
through install, upgrade, uninstall and entitlement changes. Do not introduce a cloud/model
dependency into offline core analysis or couple recovery to billing availability.

### 12. Finish audit, forensic and policy integration

Journal meaningful attach/grant/handoff/checkpoint/landing/recovery transitions and surface
journal-write failures without pretending failed logging undid an already completed mutation.
Keep capabilities, raw buffer text and secrets out of ordinary context, reports, logs and SIEM
exports. Distinguish authenticated host attribution from display labels and inferred authorship.

Extend filesystem/process/native capability inventory for every new backend. Review the Python
lexical detector's aliases/import forms and negative controls; an honest static inventory is
not an AST-level proof or a sandbox. Bind action receipts to externally authoritative managed
policy without allowing repository text to grant itself broader authority.

### 13. Complete the feature mapping and usefulness experiment

Review **every one of the 61 mappings in section 12 of the original architecture**, including
the entries requiring no new dependency. Update the executable matrix with exact tests and
honest gaps rather than one broad row claiming unrelated features by association.

Run the section 15 four-configuration experiment: original content-based behavior; automatic
lifecycle; lifecycle plus versions/editor; managed execution where supported. Use two coding
sessions, an unsaved editor and a background job; include crashes, reordered events, a moving
base and cleanup races **and successful ordinary controls**. Independently verify final code,
preserved bytes, the version landed, interventions, retries, latency and retained storage.

Use a pinned, affordable collaboration-task subset with external correctness tests, matching
agents/budgets/inputs across arms. Set budgets from measured baselines, not after seeing results.
Count unsupported cases and abandoned tasks honestly. Zero observed loss within a finite corpus
is not a universal guarantee and should never be advertised as one.

### 14. Integrate, package and release the exact completed result

Keep changes on the task branch until coherent. Re-read current main, preserve unrelated owner
work, resolve conflicts deliberately and sign commits with DCO. Before a PR, the four commands
in `CONTRIBUTING.md` must all pass:

```bash
npm test
npm run test:mutation
npm run typecheck
npm run hosts:check
```

Run path, host, action-bundle, package, release-contract and feature-proof gates appropriate to
the final delta. Regenerate hosts when changed, the committed action bundle and the manifest.
Use exact-source proof artifacts; do not edit source while treating a long run as final evidence.
Read `scripts/run-feature-proof.mjs` and the release workflows for complete commands and required
backends. Do not loosen gates, waive survivors or inflate live-host counts to finish faster.

Test a freshly installed final tarball, optional-dependency absence, install/upgrade/uninstall,
CLI/MCP parity and supported OS/Node combinations. Choose the next release version deliberately;
do not overwrite immutable v0.4.7. Complete the configured signing, attestation, artifact and
published-release verification. If the new environment lacks an essential credential or host,
finish all independent work and identify that exact external dependency; do not claim success.

Finish the owner's actual outcome before returning to growth. Close the task worktree only after
the coherent delta is durably captured and deliberately integrated and Holt's per-worktree gate
permits disposal. Never delete sibling worktrees or unlock protection to manufacture cleanliness.

## Working style and completion standard

Lead with useful behavior and concise progress. Do not repeatedly ask for approvals already
provided, send recurring unchanged warnings, or frame an unfinished feature as completed because
one fixture passed. Keep missing capabilities precise and supply a tested alternative where
possible. The owner wants implementation, not another research-only handoff.

You are finished when the original architecture's applicable outcomes are implemented and
integrated, the adversarial and successful journeys pass, the full final-source gates pass,
the installed/published artifact is independently verified, and all remaining limitations are
specific boundaries rather than unimplemented items silently removed from scope.
