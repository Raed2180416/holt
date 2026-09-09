# Automatic session awareness and useful coordination for Holt

**Status: proposed architecture, not an implemented capability. Research checked 8 September 2026.**

This design is grounded in Holt's source at b99e098e214f4e84388ffa9d6fa6b675f951732a and the current feature-proof matrix: 61 feature entries, 45 CLI commands, 18 MCP tools, and 30 declared host adapters. Those are inventory counts, not proof that automatic lifecycle protection works in 30 hosts. No new runtime capability is established by this document.

The product requirement is useful progress with recoverable work. Both missed hazards and unnecessary interference are defects. A tool that stops everything can prevent loss while failing its purpose.

## Decision

Build a small, provider-neutral session and operation service around Holt's existing content analysis and recovery machinery. Let trusted host integrations maintain ownership automatically, add an optional editor bridge for unsaved work, and expose captured versions as reviewable objects independently of the session that produced them. Offer a stronger execution boundary through an optional existing sandbox backend when a workflow needs control over arbitrary shell programs or process memory.

The central change is to distinguish **a task, a writable workspace, a captured version, and the storage that holds it**. They have different lifetimes. An agent can continue its task while a captured version is tested and reviewed. A finished task can leave a recoverable checkpoint. Physical reclamation waits for the last relevant user of the actual storage.

Do not turn every file read into an exclusive lock. Do not make an LLM judge the final authority on losing bytes. Do not make a new privileged filesystem or an always-running supervisor model mandatory for ordinary Holt usage.

~~~mermaid
flowchart TD
    H["Agent host, editor, job runner"] --> S["Sessions, pending operations, versions"]
    D["Git and exact filesystem evidence"] --> E["One evidence view"]
    S --> E
    E --> A["Context, reuse, impact, collision advice"]
    E --> C["Verified immutable checkpoint"]
    C --> R["Review and test against an exact base"]
    R --> L["Land the captured version"]
    S --> W["Continue newer work"]
    C --> X["Recover if needed"]
    S --> G["Drain and detach before storage reclamation"]
    G --> Q["Fresh check, recoverable quarantine, receipt"]
~~~

## 1. What can actually be automatic?

| Problem | Practical mechanism | What remains outside that guarantee |
| --- | --- | --- |
| An agent starts in a clean worktree | The host registers a session before giving it write access; a pre-tool hook provides an additional registration check | A scanner cannot observe an unregistered agent's intended first write |
| An agent is thinking or waiting for permission | The host retains its session claim through idle intervals | Model silence and low CPU usage do not mean the task has ended |
| A shell launches background children | A controlled runner retains a job record until the contained job has drained | A parent PID alone does not identify every surviving child |
| A human has an unsaved document | An editor bridge reports document identity, version, dirty state and, when enabled, recoverable content | Filesystem monitoring cannot read arbitrary unsaved application state |
| A task finishes normally | The host drains pending work, accounts for editor state, publishes a verified checkpoint, and ends its claim | A final assistant answer is not sufficient evidence |
| A host crashes or disconnects | Reconnect and reconcile the recorded session; offer recovery from durable checkpoints | A timeout cannot prove that unknown state is safe to discard |
| A completed version needs review while work continues | Review a fixed commit or captured snapshot, with its own base and validation evidence | A report about a moving directory is not a certificate for a later version |
| Arbitrary tools need stronger isolation | Run the task in a controlled workspace or sandbox with a mediated filesystem and process boundary | Local sandbox rollback cannot undo an external payment, message or remote service change |

This is a large expansion of practical coverage without requiring the model to remember ownership commands. It is still scoped to the integrations and execution boundaries actually present.

## 2. Current research: what to borrow, and what not to infer

These are primary sources examined for mechanisms and limitations, not a claim to have exhaustively ranked all research. Paper results below belong to the authors' setups. None are Holt measurements.

| Work and version checked | Relevant result or mechanism | Decision for Holt |
| --- | --- | --- |
| **AgentRoom**, 24 Aug 2026, v1 | File claims and structured coordination on a CRDT workspace. Its own description makes write discipline advisory; convergent edits can still be semantically incompatible. Main quality scoring lacks a held-out execution correctness suite. | Borrow explicit state and precise coordination messages. Keep isolated worktrees by default. Do not adopt character-level convergence as proof that code can land. [Paper](https://arxiv.org/html/2608.23740v1) |
| **CoAgent**, 13 Jun 2026, v1 | Orders agent trajectories, records tool footprints, notifies affected readers, and uses predeclared inverse actions. Its guarantees assume mediated tools and declared effects; unrestricted Bash does not satisfy that model. Irreversible operations must wait. | Borrow operation identities, observed dependencies and targeted repair. Avoid a global agent transaction lasting minutes, and avoid claiming automatic serializability for arbitrary commands. [Paper](https://arxiv.org/html/2606.15376v1) |
| **Shepherd**, 24 Jun 2026, v3 | Separates action intent from outcome and records execution as a reversible trace. The authors report pair-coding improvement from 28.8% to 54.7% in their supervisor experiment. The formal proof covers a restricted semantic core, not arbitrary Python, shell, sandbox implementations or production recovery. | Borrow typed events and versioned execution history. Make any model-based supervisor optional and measure its total cost. A proof label must name its exact boundary. [Paper](https://arxiv.org/html/2605.10913v3) |
| **DeltaBox**, 8 Jun 2026, v2 | Couples filesystem and process checkpoints, including generation-aware handling of files opened before a layer switch. The deployment uses Firecracker with a modified guest kernel. Reported fast paths are workload-dependent. | Valuable reference for an optional managed backend. Do not rebuild this machinery in Holt's portable CLI. Do not assume renaming an overlay makes existing writable handles harmless. [Paper](https://arxiv.org/html/2605.22781v2) |
| **Crab**, 30 Apr 2026, v1 | Uses OS-visible net effects, cgroup process membership and dirty-page tracking to select checkpoint work and overlap it with model wait time. | Borrow the goal of avoiding unnecessary full checkpoints. Use runtime evidence to reduce work; do not promote a heuristic about harmless activity into permission to lose uncaptured data. [Paper](https://arxiv.org/html/2604.28138v1) |
| **TClone**, 17 May 2026, v1 | Explores branching a live GUI workspace with filesystem and application state, separating fast forks from durable checkpoints. | Shows that richer GUI preservation is feasible inside a controlled environment. It is not a way for a CLI to recover every existing native editor buffer without integration. [Paper](https://arxiv.org/html/2605.17320v1) |
| **CooperBench**, 26 Jan 2026, v2 | Over 600 collaborative tasks across 12 libraries and four languages, with expert-written tests; evaluates coordination failures as well as individual coding ability. | Reuse a pinned, affordable subset for coordination evaluation alongside Holt-specific lifecycle tests. Better warnings alone are not a task-success result. [Paper](https://arxiv.org/html/2601.13295v2) |
| **AgentFS**, current official docs and repository | Persistent copy-on-write filesystem state, an SDK, and shared named sessions. The project is explicitly beta; a shared filesystem view does not establish semantic coordination. | Evaluate as an optional storage adapter. Validate its exact snapshot consistency and platform behavior before depending on it. Do not infer process-memory capture from a filesystem database. [Introduction](https://docs.turso.tech/agentfs/introduction), [sessions](https://docs.turso.tech/agentfs/guides/sessions), [repository](https://github.com/tursodatabase/agentfs) |
| **CubeSandbox**, current official repository and snapshot documentation | Existing VM sandbox infrastructure with snapshot, clone and rollback interfaces for filesystem and memory. The project separately identifies cross-node and fault-recovery work on its roadmap. | Evaluate an existing backend before building infrastructure. Snapshot locality, external volumes, network effects, restore verification and deployment requirements must be explicit. [Repository](https://github.com/TencentCloud/CubeSandbox), [snapshot guide](https://docs.cubesandbox.com/guide/snapshot-rollback-clone) |
| **Entire**, current official integration and privacy documentation | Automatically connects host lifecycle events to sessions and checkpoints; documents per-host differences and separates local working snapshots from pushed session metadata. | Evidence that automatic host participation is practical. Import references when useful; do not duplicate transcripts or treat another tool's session status as deletion authority. [Integrations](https://docs.entire.io/agents/overview), [storage boundary](https://docs.entire.io/security) |
| **Jujutsu operation log**, current official technical docs | Content-addressed repository views and divergent operation histories retain distinct operations and merge their views. | Model immutable checkpoint lineage and concurrent outcomes explicitly. A repository operation history still does not observe arbitrary application memory. [Concurrency design](https://jj-vcs.github.io/jj/latest/technical/concurrency/) |

Two older foundations remain especially useful. Hazard pointers separate logical removal from physical reclamation; the analogy is to retire a task while retaining the storage still referenced by a session. Chubby's sequencers illustrate why a stale actor must be rejected at the resource that accepts its operation. These are design analogies, not claims that memory algorithms can be copied unchanged into a distributed filesystem. [Hazard pointers](https://research.ibm.com/publications/hazard-pointers-safe-memory-reclamation-for-lock-free-objects), [Chubby](https://research.google.com/archive/chubby-osdi06.pdf).

The synthesis is an engineering proposal: automatic participation for ordinary tools, immutable versions for progress, and optional execution control for stronger guarantees. No examined system removes all three requirements.

## 3. Existing Holt components this extends

The current source already has a clean separation worth preserving:

1. Discovery enumerates workstreams and reads their ownership state.
2. Scanning gathers Git and filesystem evidence, including layers Git status alone misses.
3. Analysis computes content risk, coordination advice and disposition.
4. Actions independently recheck their authority and use capture or recoverable quarantine.
5. CLI, MCP, hooks, graph and TUI expose these decisions.

Source anchors at the reviewed commit:

| Component | Current responsibility | Proposed extension |
| --- | --- | --- |
| [Public analysis pipeline](https://github.com/Raed2180416/holt/blob/b99e098e214f4e84388ffa9d6fa6b675f951732a/src/index.mjs#L36) | discover → scan → analyze | Add an immutable evidence-view identifier and optional live overlay |
| [Ownership lifecycle](https://github.com/Raed2180416/holt/blob/b99e098e214f4e84388ffa9d6fa6b675f951732a/src/ownership.mjs#L373) | Explicit claim, heartbeat, handoff, release | Automatic host clients; actor sets, operation records, generations |
| [Ownership/cleanup mutex](https://github.com/Raed2180416/holt/blob/b99e098e214f4e84388ffa9d6fa6b675f951732a/src/ownership.mjs#L479) | Serializes claim against the final cleanup move | Reuse this authority boundary; do not hold a database transaction for an agent's whole lifetime |
| [Disposition](https://github.com/Raed2180416/holt/blob/b99e098e214f4e84388ffa9d6fa6b675f951732a/src/analyze.mjs#L705) | Active or unresolved ownership prevents cleanup | Make reasons action- and resource-specific |
| [Cleanup](https://github.com/Raed2180416/holt/blob/b99e098e214f4e84388ffa9d6fa6b675f951732a/src/actions.mjs#L2874) | Rechecks identity and content before locked quarantine | Account for every attached actor and keep versioned receipts |
| [Hook dispatcher](https://github.com/Raed2180416/holt/blob/b99e098e214f4e84388ffa9d6fa6b675f951732a/bin/holt.mjs#L1450) | Tool guarding, startup/prompt context, advisory session end | Add protocol clients at supported host events |
| [MCP dispatch](https://github.com/Raed2180416/holt/blob/b99e098e214f4e84388ffa9d6fa6b675f951732a/src/mcp/server.mjs#L1117) | Explicit lifecycle tool and reports | Expose status/recovery to the model; keep routine lifecycle ownership in the host |
| [Content identity](https://github.com/Raed2180416/holt/blob/b99e098e214f4e84388ffa9d6fa6b675f951732a/src/content-identity.mjs) | Exact byte identity separate from advisory similarity | Preserve that separation for buffers and snapshots |

Current ownership is deliberately worktree-wide and uses a caller-supplied owner identifier. It is a cooperative local contract, not an authenticated multi-tenant session broker. Automatic integrations should not disguise that existing identifier as a secure release capability.

## 4. The data model

Use one authority service per repository on a host, reached through a local socket or named pipe. A long-lived helper improves latency and tracks connections; the durable records, not the helper's memory, remain authoritative. Existing one-shot analysis continues to work when the helper is not running.

The proposed records are:

| Record | Essential fields | Purpose |
| --- | --- | --- |
| Workspace | repository identity, workspace identity, backend, current path binding, generation | Survive path changes without confusing a newly reused name with the old worktree |
| Session | host instance, session ID, actor/parent IDs, capability set, lifecycle, generation | Distinguish a main agent, its children, a human editor and a background runner |
| Attachment | workspace/resource, actor, read-use or write capability, connection generation | Prevent reclaiming something still in use without exclusively locking every read |
| Operation | operation ID, actor generation, intent, known path scope, started/completed/uncertain, before/after observations | Close the gap between planning a write and observing its result |
| Buffer | editor/URI, document generation and version, dirty state, saved disk identity, optional recovery object | Track state that does not yet exist in the working directory |
| Checkpoint | immutable content manifest, parent, base commit, buffer/process coverage, persistence receipt | Produce a reviewable or recoverable version without treating a moving directory as fixed |
| Dependency observation | consuming session/version, observed input identity, producing version | Notify a consumer when a premise it actually used changes |
| Action receipt | requested action, authorized scope, inputs/generations, capture refs, result, restore information | Explain and recover the specific action that occurred |

A session may hold several resources. A workspace may have several attachments, but its normal writable task still has one primary owner. Children get explicit scoped participation; an editor contributes its own evidence. Removing one actor must not erase the others.

Paths alone are inadequate identities. Bind a path to a repository/workspace generation and filesystem identity; handle case folding, symlinks, moved roots, Windows drives, remote URIs, nested repositories and reused directory names explicitly.

An agent's stated intention to edit a file is advisory until a real operation is admitted. Otherwise a speculative plan could reserve a project indefinitely.

### Persistence and security

Store the small lifecycle journal outside branch-controlled files. Use atomic record publication and durable intent-before-grant ordering. The service must acknowledge a protected operation only after the relevant protection is durable. A crash during publication leaves a recoverable incomplete transition.

Keep content snapshots separate from the lifecycle journal. Heartbeats update compact state; they should not fill the forensic log. Record claims, grants, handoffs, checkpoints, authority changes and action outcomes. Bound storage and never silently evict the only recovery copy.

Use a host-generated capability for lifecycle mutation, bound to the session and generation. Show a human-readable owner label in reports; do not expose the capability through model context, command-line arguments or exports. Restrict local socket access and repository scope. Same-user hostile code is not automatically excluded by a local capability; stronger isolation requires a separate execution boundary.

A daemon outage is not proof that a session ended. A parser outage is not a reason to stop an unrelated ordinary write. Recover each failure at its actual boundary.

### Performance, retention and upgrade boundaries

The tool fast path should consult the affected session/resource records, not rescan the whole repository. Batch noncritical observations and parse changed versions asynchronously. Preserve intent-before-write ordering where a durable grant matters. Measure the cost of the durable step rather than hiding it in an average dominated by model inference.

Use short operation reservations, stable acquisition order for multi-path operations, and bounded retry. A workspace attachment prevents reclamation; it must not become a database mutex held across minutes of inference. An ordinary read observation usually creates a dependency, not an exclusive reservation.

Retain checkpoint objects through explicit references from sessions, review candidates and recovery receipts. Retire the visible task independently. Garbage collection can reclaim only objects with no remaining references under the configured retention and disposal authority. Count retained bytes accurately and show which live or recovery reference holds them. A storage limit must not silently evict the only recovery copy.

Version the protocol and on-disk schema. Migration must preserve the existing lease/native lock continuously, and an older client must not interpret an unsupported new record as unclaimed. Mixed-version lifecycle mutation and downgrade are separate required tests. Do not maintain two independent authorities through casual dual writes. A client bypassing the broker cannot inherit the broker's automatic guarantee.

Keep a repository's authority local to the host owning its writable storage. A shared network path or a synchronized journal does not create cross-host coordination. Remote workers need an explicit server-owned workspace identity and a backend that mediates their writes.

## 5. Automatic lifecycle without an ownership chore

The normal experience should be: install once, use the same agent, continue working, review a result, close the task.

### Start and tool execution

The host starts or attaches a session before handing the workspace to a writer. The runtime records a lease automatically. For a supported tool call, it records the operation before letting that operation execute. On completion, it records the result and the relevant disk/version observations.

For exact native edits, scope can be a small set of paths. An arbitrary shell program can have broad effects; string parsing cannot certify a complete write set. In ordinary host mode, retain the workspace attachment and record what is known. In managed mode, the filesystem/process boundary supplies stronger observations.

Host events have different semantics. Claude documents PreToolUse as a blocking boundary, but SessionStart and SessionEnd are not blocking events. WorktreeCreate replaces the default creation behavior, while WorktreeRemove cannot veto removal. Therefore, startup registration needs a pre-tool backstop, and automatic host-owned worktree teardown needs explicit integration with the runner's actual lifecycle. Installing a removal notification alone does not establish protection. [Claude hook reference](https://code.claude.com/docs/en/hooks).

OpenCode exposes session events and before/after tool hooks. Its installed version and live behavior still need verification; a documented callback is not proof that Holt's generated adapter enforces it. [OpenCode plugin API](https://dev.opencode.ai/docs/plugins/).

A model's Stop event is a turn boundary. Treat a normal pause, permission request, compaction or final answer as a possible continuing session. Do not release ownership just because the assistant stopped speaking.

### Hand off

The receiving actor acknowledges the handoff while the resource is still held. Then the service changes the generation and owner in one transition. Delayed heartbeats or release events from the old generation cannot clear the new claim.

This only fences operations that check the generation. An already-open raw file descriptor outside the controlled runner can still write; a JSON generation counter does not revoke OS access.

### Finish

For a host capable of enforcing completion:

1. Stop admitting new writes for the finishing scope.
2. Drain registered operations, subprocesses and children.
3. Resolve editor participation: save, retain a separate recovery snapshot, keep the attachment, or detach the editor from that scope.
4. Capture and independently verify the intended version.
5. Publish its durable receipt.
6. End that actor's claim; retain claims belonging to anyone else.
7. Run any already-authorized landing or cleanup action against fresh identities.

If a step is interrupted, retain the prior durable state and give the user a concrete recovery route. Do not restart the whole task when reconciliation can finish the recorded transition.

Completion can be automatic on a reliable graceful runner shutdown. Ambiguous exits remain recoverable. This does not require a person to approve every heartbeat, write or checkpoint.

## 6. Unsaved buffers: the subtle race

VS Code exposes document dirty state and change/save events. An editor bridge can initially enumerate its documents, then reconcile versioned events. It should support text documents first, and report notebook/custom editor/remote coverage separately. This covers participating editors, not arbitrary applications. [VS Code API](https://code.visualstudio.com/api/references/vscode-api).

An asynchronous “document changed” event arrives after an edit. If Holt allowed cleanup between the edit and event delivery, the bridge would still have a race. Therefore:

- While a participating editor has a writable workspace attached, retain a workspace attachment that prevents moving its directory.
- Use individual buffer versions to explain risk and enable narrow recovery, not to guess that an open writable workspace is globally idle.
- Do not assume that checking isDirty twice can freeze human typing.
- A clean disconnect must reconcile and detach. An abrupt disconnect preserves the last known unresolved state.

This can sound restrictive until review and physical removal are separated. An open editor need not stop review of an immutable checkpoint. A finished task can leave the active list while its storage remains attached. Show retained storage and its reason accurately; do not claim disk space was reclaimed.

Buffer capture must preserve the user's version independently. Never silently save it to the working file or overwrite another writer's result. A recovery snapshot is not automatically “the final patch.” Metadata-only mode can prevent loss by retaining the attachment, but cannot restore bytes it never stored.

Capture buffer text with its editor version, encoding and line-ending metadata. Do not confuse an editor's text representation with the exact historical bytes on disk. Keep these recovery objects private and local by default; routine journals carry identifiers and outcomes, not the content.

An untitled document has no proven target worktree merely because an editor is open. Bind it only through a known workspace association; otherwise list it in the editor recovery inventory without claiming it belongs to a particular task.

## 7. The most useful change: review versions while work continues

Holt currently excludes an actively owned worktree from landing recommendations. That is appropriate for a moving target, but it need not exclude a separately captured version.

Give a ready checkpoint an identity:

- exact code/filesystem manifest or commit;
- intended integration base and expected current target revision;
- tests and merge checks run against that version;
- declared omissions, including unsaved work left outside the candidate;
- producing session and checkpoint lineage.

The agent can then continue on a newer version while Holt reviews the captured one. For committed work, immutable Git objects already provide much of this basis. For uncommitted work, a consistent capture needs either cooperating writers to pause briefly or a backend with real snapshot semantics.

Never take an ordinary recursive copy while a process is writing and call the result atomic. Never transplant a checkpoint into the live worktree as a convenience.

Landing uses a separate integration checkout and a compare-and-swap check on the expected base. If the base moved, recompute the affected verification. If it did not, use the already verified candidate. After a successful integration, tell continuing sessions which base and interfaces changed.

This creates an active benefit: review starts earlier, integration stops racing live edits, and a session does not have to disappear for its completed contribution to be useful.

## 8. A small agent-side index with a large payoff

The first useful index is an **operation and version index**: who has which resource, which operation is pending, what a session actually read, and which version is durable. It does not require another embedding database or collecting private model reasoning.

Add an advisory structural overlay later:

- Derive symbols from versioned buffers or captured edits using existing parser backends.
- Label results as intended, unsaved, saved or checkpointed.
- Bind every derived symbol to its source version.
- When a producer changes a file or interface a sibling consumed, emit one specific update containing the changed version and affected paths.
- Feed that evidence into context, impact, collision review and partition recommendations.

For example: “The auth task changed refreshToken's return shape after your last read. Your API handler still uses the old form. Compare these two versions.” That is more useful than “another agent may be editing this repository.”

Observed file reads are not a complete account of semantic dependency. An agent may have read an entire directory or inferred a constraint from earlier context. Mark the scope honestly. Use the index to prioritize re-reading and testing; do not advertise full serializability.

Use CRDTs only if shared editing becomes a deliberate product mode with its own evaluation. Keep alternate edits as independently recoverable versions when intent conflicts. Automatically interleaving text can preserve characters while damaging a program.

## 9. Stop making generated files a guessing problem

For normal unmanaged worktrees, the existing exact-content rules continue to apply. A directory name, package lockfile, successful build or .gitignore entry does not prove every byte is reproducible.

For an optional managed runner, introduce an explicit disposable output layer:

1. The user or trusted task policy authorizes a particular layer as replaceable build/dependency output.
2. The runner gives the operation exclusive write access to that layer and records inputs and backend identity.
3. User edits and task source go to separately preserved storage.
4. When the operation has drained, the runner can retire the output layer under its declared contract.
5. Any direct user override or unknown writer invalidates that contract for the affected layer.

This lets an ordinary rebuild or dependency reinstall proceed without a recurring warning about “possibly unique generated work.” It does so by constructing a disposable resource, not by guessing from its filename. Lifecycle scripts with external side effects remain outside a filesystem-only rollback.

Do not retrofit existing ignored directories into this policy without classifying their provenance. A manually patched dependency is user work until proven otherwise.

## 10. Optional managed execution

There are two useful deployment levels:

**Host integration:** portable, small, uses current agents and editors. It automates their participation and preserves ordinary Holt workflows. Coverage follows the host's actual tool and lifecycle surfaces.

**Managed workspace:** the runner controls a task's writable storage and descendant processes. An existing sandbox/overlay backend provides checkpoint, drain and resource revocation. Holt supplies repository identity, cross-task analysis, review, recovery policy and receipts.

A Linux implementation can use cgroup membership and completion notifications for a contained process set. Freeze completion must be observed, and the runner must prevent members escaping or unrelated writers entering. Windows/macOS require their own verified backend contracts; Linux behavior is not a portability proof. [Linux cgroup documentation](https://docs.kernel.org/admin-guide/cgroup-v2.html).

Filesystem watchers are useful for invalidating caches and discovering positive evidence. They are not cleanup certificates: queues can overflow and observed state can become inconsistent. If a expected stream loses events, invalidate its affected evidence and reconcile. Do not equate lack of events with lack of writers. [inotify documentation](https://www.man7.org/linux/man-pages/man7/inotify.7.html).

A sandbox can capture its own process state. It cannot recover an unsaved buffer in a separate unmanaged editor. It also cannot reverse an external API effect by restoring local files. Such effects need their own authorization and compensation contract; Holt should not expand into a universal transaction manager.

## 11. Product behavior: success before warnings

Every intervention must have an affected object, a current reason, and a useful action. The default progression is:

1. Proceed quietly when the operation is valid.
2. Resolve routine bookkeeping automatically.
3. Preserve an exact preimage or use an isolated version when that satisfies the authorized action.
4. Tell the agent about a precise changed dependency or available alternative.
5. Interrupt the user only when the remaining choice actually needs their intent.

Capture is not permission to overwrite someone else's live work. A recovered file can still be the wrong outcome if the active editor or task is disrupted.

Concrete behavior:

| Situation | Intended experience |
| --- | --- |
| New file in the owner's workspace | Write proceeds; lifecycle accounting is automatic |
| Normal edit to a committed file | Existing edit policy applies; no extra generic ownership prompt |
| Another task wants to overwrite a live unsaved version | Keep both versions, provide a diff/handoff route; stop that overwrite only |
| A task's tested checkpoint is ready while the task continues | Review or land the checkpoint with its own evidence |
| Another worktree has an unresolved session | Continue unrelated work and analysis |
| Dependency reinstall in a declared disposable layer | Proceed after draining the layer's prior operation |
| Dependency reinstall in an old directory containing a manual patch | Preserve and name that patch; offer the supported capture/rebuild route |
| A captured discard was interrupted | Reconcile the recorded transaction instead of advising repeated broad cleanup |
| A closed task still has an editor attached | Archive the task view, retain its storage, and show accurate retained-space accounting |
| A heartbeat is late during laptop sleep | Reconnect and reconcile; do not repeatedly nag or infer abandonment |

Use a reason fingerprint to deduplicate unchanged warnings. Re-notify when the affected version, action, severity or available remedy changes. Do not inject the full repository status into every prompt.

There must be no global “some editor might exist” hold. Missing optional integration is a capability boundary reported during setup/diagnosis, not a reason to disable all existing content-based functionality. Conversely, a known lost attachment cannot be silently treated as absent.

### How to measure usefulness

Do not collapse these into one “safety score”:

- **Missed-loss rate:** hazardous eligible actions that lose or overwrite intended work within the supported boundary.
- **Missed-coordination rate:** seeded or independently confirmed incompatible/stale interactions not surfaced before their consequential action.
- **False intervention rate:** actions stopped or redirected despite being valid under their actual scope and ownership.
- **Avoidable intervention rate:** real hazards that the product could have resolved through an already-authorized recovery/isolation route without asking.
- **Completion and effort:** task success, time to first useful change, time to review/land, user interventions, retry loops and recovery time.
- **Operating cost:** p50/p95/p99 added latency, memory, checkpoint bytes and model tokens.
- **Adoption:** people finishing a second task with Holt enabled, recurring use, and concrete uninstall reasons.

Label uncertainty separately from a positive hazard finding. Use independent workload labels and record an entire action journey, including retries. A guard cannot improve its score by excluding all hard cases or counting an abandoned task as a prevention success.

Tune the action scope and recovery path before weakening byte-preservation requirements. The aim is to reduce both error classes by collecting better evidence and making more actions reversible.

## 12. Mapping every currently declared feature

The feature IDs below are copied from the reviewed feature-proof matrix. “No new dependency” is intentional: not every feature needs a session service to do its existing job.

| # | Feature ID | Integration and useful outcome |
| --- | --- | --- |
| 1 | discovery-and-source-layers | Add live/buffer/checkpoint evidence as separately identified layers; preserve existing disk enumeration |
| 2 | risk-and-content-identity | Preserve exact path/mode/type/bytes; distinguish uncaptured buffer work from durable recovery |
| 3 | disposition-gate | Report the current action-specific result; a read-only gate still cannot authorize a later unrelated rm |
| 4 | live-worktree-ownership | Automate host participation; aggregate actors and reject stale lifecycle generations |
| 5 | collision-analysis | Add versioned pending/unsaved overlap as advisory evidence and offer concrete conflicting versions |
| 6 | hotspot-analysis | Rank observed concurrent work; avoid calling shared files conflicts |
| 7 | duplicate-analysis | Compare actual versions, label provisional work, suggest reuse without deleting either copy |
| 8 | deep-token-clone-analysis | Keep the optional bounded parser path; do not put clone analysis on each tool's critical path |
| 9 | language-and-parser-backends | Reuse parsers for overlays; a parser failure degrades structural advice, not lifecycle authority |
| 10 | strict-read-only-analysis | Read existing records without spawning, claiming, heartbeating or mutating state |
| 11 | bounded-analysis-and-honest-degradation | Bound event queues, buffer capture and parser work; name incomplete coverage rather than omit it |
| 12 | sibling-context | Deliver relevant version changes, active ownership and reusable completed work |
| 13 | dependency-impact | Link observed reads and changed interfaces to targeted re-reading and tests |
| 14 | stash-risk | Keep stash inventory; attach a source session only when identity proves the relationship |
| 15 | status-risk-and-brief | Show useful next actions and changed reasons, not repeated generic warnings |
| 16 | configuration-and-policy-escape-hatch | Separate user-authorized disposable resources from semantic guesses; preserve managed-policy authority |
| 17 | review-plan | Plan over explicit ready checkpoints as well as legacy worktree candidates |
| 18 | landing-order | Order immutable candidates; ongoing edits on a newer version need not exclude a ready predecessor |
| 19 | agent-partition | Incorporate actual reservations and intended task paths; suggest available work without inventing tasks |
| 20 | branch-graveyard | Distinguish branch history, live sessions and recoverable checkpoints; age remains advisory |
| 21 | pair-verification | Run on pinned candidate/base combinations in isolation; associate results with those identities |
| 22 | relationship-graph | Show sessions, produced versions and dependencies without making every heartbeat a node |
| 23 | interactive-tui | Provide review, recover, handoff and archive actions with precise reasons |
| 24 | protect-auto-unprotect | Keep content locks distinct from session attachments; unprotect cannot silently release another actor |
| 25 | rescue-and-inventory | Capture known disk state and available buffer snapshots; report exactly what was and was not captured |
| 26 | clean-quarantine-restore | Check live storage use at the final move; retain recoverable quarantine and bind restores to current paths |
| 27 | guarded-discard | Check affected path owners, preserve exact preimages and reconcile interrupted transactions |
| 28 | quarantine-purge | Require actual retained-storage authority and no live attachments; archival UI state is not deletion consent |
| 29 | shell-command-guard | Register admitted operations automatically; use managed execution for claims beyond parseable tool scope |
| 30 | native-file-tool-guard | Use exact paths and expected versions to avoid stale overwrites and unnecessary whole-tree blocks |
| 31 | proactive-lifecycle-context | Separate passive context from authoritative lifecycle transitions; no release on model Stop |
| 32 | integration-install-upgrade-uninstall | Reuse install receipts; preserve unresolved session/recovery state during upgrade or uninstall |
| 33 | host-compatibility-report | Publish capabilities per host/version with contract and live-runtime evidence distinguished |
| 34 | provider-adapter-status | Separate installed configuration from active event delivery and actual blocking behavior |
| 35 | antigravity-context-and-mcp-adapter | Consume supported context/MCP events; do not relabel advisory integration as write interception |
| 36 | mcp-decision-tools | Return bounded evidence views and actionable alternatives; routine ownership remains a host responsibility |
| 37 | mcp-action-tools | Route CLI and MCP through the same fresh action checks and recovery transaction |
| 38 | mcp-security-boundary | Bind repository and action scope; prevent model-visible owner labels from acting as release credentials |
| 39 | activation-integrity-diagnostics | Check the complete event path with a harmless probe; report disconnects once with a repair route |
| 40 | journal-integrity-and-proofs | Append meaningful authority transitions with durable references; do not imply an audit log proves all inputs true |
| 41 | journal-exports-and-summary | Export decisions and outcomes; keep raw buffer text and secrets out of routine exports |
| 42 | forensics-timeline | Link intended operation, actual effect, checkpoint and recovery to explain incidents |
| 43 | fleet-policy-and-ci | Aggregate declared coverage and outcomes; keep local action authority on the host owning the resource |
| 44 | managed-policy-authority | Preserve external policy authority and version it in receipts; repository text cannot grant itself broader access |
| 45 | continuous-siem-sink | Send bounded transition events under configured policy; avoid heartbeat noise and implicit source upload |
| 46 | actor-attribution | Separate host-authenticated actor identity from display names and inferred authorship |
| 47 | supply-chain-audit-and-offline-runtime | Keep core offline; audit optional runner/editor packages and avoid mandatory model or cloud dependencies |
| 48 | package-and-installed-artifact | Verify the installed broker/client versions, migrations, paths and optional-backend absence behavior |
| 49 | release-and-ci-contract | Add lifecycle and usefulness evidence to exact-artifact release gates; never inherit evidence from another version |
| 50 | platform-and-path-portability | Test IPC, path identity, case behavior, crash recovery and process boundaries on each claimed platform |
| 51 | git-repository-shape-compatibility | Bind submodule, sparse, LFS, detached and moved-worktree resources correctly; preserve unsupported states |
| 52 | jujutsu-backend | Map workspace and operation identities explicitly; Git-specific locks cannot be assumed to protect jj storage |
| 53 | pinned-real-repository-corpus | Add actual lifecycle journeys to pinned repositories, with independent expected outcomes |
| 54 | monster-and-randomized-invariants | Explore races, event reordering, restarts and ordinary successful controls together |
| 55 | benchmark-evidence-protocol | Publish latency, overhead, failure rates and task completion with complete denominators |
| 56 | offline-license-and-entitlements | Recovery and durable records must remain accessible across entitlement changes; preserve current contracts |
| 57 | purchase-and-license-service | No runtime dependency on checkout or webhook availability; do not add session coupling to billing |
| 58 | pricing-and-public-claims | Describe only verified automatic coverage and measured user benefit; no claim that 30 adapters equal 30 live proofs |
| 59 | setup-doctor-and-cli-contract | Verify once, explain supported behavior plainly, and keep the normal workflow short |
| 60 | integration-base-authority | Bind checkpoints and landing evidence to the owner-authorized integration destination |
| 61 | machine-output-and-analysis-scope | Version the schema; include scope, freshness and omissions; preserve existing gate exit semantics |

## 13. Failure handling and races that must be designed first

| Failure or race | Required response |
| --- | --- |
| Clean directory is claimed just before cleanup | Serialize registration and final move; only one succeeds |
| Tool is granted, then service crashes before completion | Recover the durable operation as unresolved; reconcile its real effects |
| Parent exits but a child keeps writing | The contained job remains attached until all relevant descendants drain |
| Laptop sleeps past the lease interval | Reconnect/reconcile by generation; no assumption of abandonment |
| Old owner's delayed release arrives after handoff | Reject it using the current generation and capability |
| A directory name is reused | Treat it as a new workspace identity; do not apply the old receipt |
| A buffer changes during checkpoint creation | Keep the newer buffer pending; the receipt names only the captured version |
| Editor bridge connects after documents are already dirty | Initial document snapshot plus ordered event reconciliation |
| Editor event delivery is asynchronous | Keep a writable attachment; do not rely on the last dirty flag for physical removal |
| Watch queue overflows | Invalidate affected cache/coverage and rescan; retain known pending operations |
| A checkpoint is only partially written | Keep the previous durable checkpoint and incomplete transaction; never report successful preservation |
| Tests complete for an older candidate | Keep that result attached to the older candidate; do not reuse it on a newer version |
| Integration base changes after tests | Revalidate the affected candidate/base combination before landing |
| Restore target has a new concurrent replacement | Preserve both; recover-discard/restore must not overwrite the replacement |
| A task archives while an editor remains attached | Remove task-list clutter only; retain and account for its storage |
| A sandbox process escapes the declared boundary | Downgrade the guarantee and stop dependent reclamation; do not invent complete containment |
| An action changes a remote service | Record the external effect contract; local rollback alone is insufficient |
| A license expires or helper is uninstalled | Preserve recovery access and recorded state; no silent deletion |

Bound retries and make reconciliation idempotent. A busy action should offer a useful checkpoint or affected scope, not an endless loop of “try again.”

## 14. Implementation sequence and acceptance

### Stage A: automatic lifecycle for one real host

Implement the minimal service/client protocol, automatic start/operation/finish transitions, reconnect, and generation checks. Choose the host whose installed runtime can actually be driven and measured; Claude's public lifecycle is a concrete candidate, but the user's actual runner should determine the first production target.

Prove the normal journey without manual ownership calls. Include a pre-first-write cleanup attempt, a long thinking interval, a background child, normal finish, crash recovery and a clean control that is actually cleaned.

Acceptance requires both prevented loss and useful completion. A successful fixture denial is not a complete host proof.

### Stage B: versioned review and narrow action policy

Add immutable checkpoint candidates and common action checks for discard, restore, rescue-with-release, cleanup and purge. Review a completed checkpoint while its producer continues working. Preserve all existing exact-content and primary-checkout contracts.

This stage is the largest direct usability improvement: it stops whole-task liveness from becoming a whole-task freeze.

### Stage C: editor bridge and dependency updates

Start with text buffers in one editor. Test real initial dirty documents, edits during capture, save-as, rename, close, crash and multiple windows. Add versioned structural overlays and precise sibling updates only after the data flow is reliable.

### Stage D: optional managed backend

Evaluate an existing copy-on-write or sandbox implementation against Holt's exact Git, path, process and recovery requirements. Prototype one backend behind a capability interface. Do not add cross-platform or cross-host guarantees until demonstrated.

Use it first for bounded tasks with expensive generated output or background processes, where fewer interruptions and cheaper recovery have measurable value.

### Stage E: measured expansion

Expand host/platform combinations only when real-runtime journeys pass. Keep configuration-contract counts separate from live verified counts. Import external checkpoint references when they remove duplication.

## 15. The decisive experiment

Run the same realistic task journey under four configurations:

1. Current content-based Holt.
2. Automatic lifecycle.
3. Lifecycle plus versioned review/editor participation.
4. The same design with a managed backend where supported.

Use two coding sessions, a human editor with an unsaved change, and a background dependency/test job. Include a checkpoint ready to review while another version is still changing. Inject a crash, delayed handoff event, missed event stream, moving integration base and a cleanup race. Include ordinary uncontentious edits and a finished disposable worktree as positive controls.

Independently verify preserved bytes, intended final code behavior, which version landed, and whether the ordinary control completed. Compare task completion, unnecessary/avoidable interruptions, repair time, tail latency, storage and token cost. Record unsupported boundaries in the denominator.

Also run a pinned subset of collaboration tasks with external correctness tests. Run each arm with the same agents, budgets and task inputs. Do not attribute a stronger model's improvement to Holt.

A release should require zero observed loss and stale-generation acceptance in its stated deterministic/adversarial corpus, successful normal journeys, and no regression in ordinary edit/finish behavior. That finite result must not be advertised as a universal zero-error rate. Numerical latency and intervention budgets should be set from baseline measurements before the trial, not invented afterward to fit the result.

## 16. Alternatives rejected or deferred

| Alternative | Why it is insufficient as the default |
| --- | --- |
| More prompts telling agents to claim/release | Leaves correct behavior dependent on remembering instructions |
| PID scanning and inactivity timers | Does not account for buffers, detached descendants or future writes |
| Every read reserves the entire repository | Turns parallel work into waiting and produces avoidable holds |
| Shared CRDT code as the default | Text convergence does not establish semantic compatibility |
| A supervisor LLM approves every action | Adds latency/cost and moves a deterministic preservation boundary into probabilistic judgment |
| Full process checkpoints before every tool | Expensive and unnecessary for many ordinary operations |
| Build a new kernel/filesystem immediately | Delays useful host integration and creates a large new correctness burden |
| Automatically clear expired leases | Trades visible inconvenience for unmeasured loss |
| Preserve everything forever | Avoids a hard reclamation decision but eventually fails storage and usability |
| Treat capture as permission for any overwrite | Can still disrupt another person's live task even if bytes are recoverable |

## 17. The product promise this architecture could earn

“Keep working in your usual tools. Holt tracks what is in use, brings completed work together, and gives you a verified way back when something goes wrong.”

That promise should be earned through repeated complete tasks with low interruption rates. The next useful milestone is one automatic, measured start → work → review → finish/recover journey. A larger feature count, a longer warning, or an unverified “all agents supported” claim would not establish it.
