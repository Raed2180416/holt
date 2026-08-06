# Holt feature proof matrix

This document is the audit ledger for Holt's user-visible product surface. It maps each feature to an exact executable test or harness, the independent oracle used to grade it, and the remaining unproven boundary. A green run is **bounded proof for one exact source identity, runtime, platform, and fixture set; it is not universal proof** and it is not permission to describe every feature as perfect.

The executable source of this matrix is [`scripts/run-feature-proof.mjs`](../scripts/run-feature-proof.mjs). [`test/unit/feature-proof-contract.test.mjs`](../test/unit/feature-proof-contract.test.mjs) fails when a CLI command, MCP tool, host, test file, feature row, or evidence command is omitted.

## What a feature-proof artifact means

Run the immutable plan inspection first, then choose a new output path outside the checkout:

```bash
node scripts/run-feature-proof.mjs --plan
node scripts/run-feature-proof.mjs --out ~/.cache/holt-feature-proof/proof-linux-x64.json
sha256sum -c ~/.cache/holt-feature-proof/proof-linux-x64.json.sha256
```

The runner imposes no global or per-command harness time limit and has no `--skip` or `--only` mode. Product operations may still exercise their separately documented safety bounds. The runner names every `*.test.mjs` file explicitly, runs the real jscpd lane, mutation corpus, and release/CI/host/path gates, and retains every command's full argv, exit code, signal, runtime, stdout, and stderr. Any skip is a failure; any todo, cancellation, zero-test command, missing corpus member, nonzero exit, or source change during the run invalidates the artifact. Existing evidence files are never overwritten.

The mandatory all-backends CI job and the release quality gate execute that exact runner and upload both `feature-proof.json` and its SHA-256 sidecar. The upload step runs even after a completed invalid proof so reviewers can inspect the failure rather than receiving only a red status with discarded evidence; absence of either artifact is itself a gate failure.

A full-feature pass therefore requires every conditional backend and platform capability named by the corpus to be available: universal-ctags, enry, jscpd, jj, OpenCode, npm, bash/POSIX shell where applicable, real Git submodules and sparse checkout, and the relevant filesystem filename/symlink behavior. An absent optional backend may be a supported product degradation, but it cannot produce an artifact claiming that backend was proven. Platform-specific skipped tests currently make a zero-skip artifact impossible on some claimed operating systems: the corpus includes Linux `/proc` race instruments, POSIX executable-mode/shell checks, and filesystem-dependent symlink/name fixtures. That is a release gap to replace with a real platform-specific oracle, not a denominator to waive or a vacuous assertion that merely recognizes the operating-system name.

Source identity includes the exact commit, tracked binary diff hash, status hash, and path-bytes/type/mode/size/SHA-256 inventories for every untracked source file and every Git-reported ignored runtime file. Ignored installed dependencies are byte-hashed because a lockfile or `npm ls` version cannot detect local modification. Nested repositories are not traversed because they are not runtime inputs of this checkout. Two consecutive samples must agree before the run and two more must agree after it; the before/after identities must also match. Runtime identity includes OS, architecture, CPU, memory, complete Node component versions, Git, ctags, enry, jscpd, jj, OpenCode, npm, Holt, the installed npm dependency graph, and hashed or redacted runtime-affecting environment variables. The JSON contains complete denominators for features, CLI commands, MCP tools, hosts, test files, evidence commands, observed tests, skips, todos, and bounded feature outcomes. The adjacent SHA-256 sidecar authenticates the artifact bytes; it does not authenticate the publisher. Output paths are write-once, must be outside the canonical checkout, and are rejected when a lexical outside path resolves through a symlink back into the source tree.

A valid artifact proves only that every declared check passed without omission on the named machine. It does not turn contract tests into live-host proof, synthetic fixtures into every real repository, or one OS into cross-platform evidence.

## Surface denominators

These lists are machine-compared with executable help/schema/manifest data on every run.

### CLI commands (42)

`cli:status` · `cli:risk` · `cli:collisions` · `cli:hotspots` · `cli:duplicates` · `cli:context` · `cli:plan` · `cli:impact` · `cli:order` · `cli:partition` · `cli:branches` · `cli:journal` · `cli:forensics` · `cli:fleet` · `cli:license` · `cli:managed-policy` · `cli:ci` · `cli:graph` · `cli:stash` · `cli:gate` · `cli:tui` · `cli:setup` · `cli:doctor` · `cli:audit` · `cli:auto` · `cli:protect` · `cli:unprotect` · `cli:rescue` · `cli:rescued` · `cli:clean` · `cli:quarantines` · `cli:restore` · `cli:purge` · `cli:discard` · `cli:verify` · `cli:hosts` · `cli:providers` · `cli:integrate` · `cli:uninstall` · `cli:brief` · `cli:mcp` · `cli:hook`

The implementation also accepts the legacy/default aliases `cli:scan`, `cli:help`, and `cli:version`; the denominator above is the set of documented command sections in the CLI's top-level help output.

### MCP tools (16)

`mcp:holt_at_risk` · `mcp:holt_branches` · `mcp:holt_check_workstream` · `mcp:holt_clean` · `mcp:holt_collisions` · `mcp:holt_context` · `mcp:holt_duplicates` · `mcp:holt_hotspots` · `mcp:holt_impact` · `mcp:holt_landing_order` · `mcp:holt_landing_plan` · `mcp:holt_partition` · `mcp:holt_protect` · `mcp:holt_purge` · `mcp:holt_rescue` · `mcp:holt_status`

MCP tools are agent-native and can return evidence or act, but MCP itself is model-invoked. Proactive context and pre-action blocking require a separately wired host lifecycle/tool hook.

### Declared hosts (30)

“Block” below means an adapter exists for the named scope. It never implies every host tool is intercepted, that the config was trusted/loaded, or that a real host process was driven unless `verifiedLive` says so.

| Host inventory id | Product | Environment | Declared grade | MCP | Current proof boundary |
|---|---|---:|---|---:|---|
| `host:claude-code` | Claude Code | local | block | yes | Adapter/config contract-tested, not driven live; block scope: shell + exact Write/full-file Edit. |
| `host:opencode` | OpenCode | local | block | yes | Adapter/config contract-tested, not driven live; block scope: shell commands. |
| `host:cursor` | Cursor | local | block | yes | Adapter/config contract-tested, not driven live; block scope: shell commands. |
| `host:cursor-cloud` | Cursor Cloud Agent | cloud | advisory | no | Advisory or Git-only surface; no host-level blocking claim. |
| `host:codex` | OpenAI Codex CLI / local clients | local | block | yes | Adapter/config contract-tested, not driven live; block scope: shell + exact apply_patch delete/risky move. |
| `host:codex-cloud` | OpenAI Codex cloud | cloud | advisory | no | Advisory or Git-only surface; no host-level blocking claim. |
| `host:gemini-cli` | Gemini CLI | local | mcp | yes | MCP/advisory integration; model cooperation required and no blocking claim. |
| `host:antigravity` | Google Antigravity 2 / IDE / CLI | local | mcp | yes | Executable project MCP plus proactive PreInvocation context/autoprotect contract; no PreToolUse/blocking claim and not driven live. |
| `host:qwen-code` | Qwen Code | local | block | yes | Adapter/config contract-tested, not driven live; block scope: shell + exact write_file/full-file edit. |
| `host:copilot` | GitHub Copilot CLI | local | block | yes | Adapter/config contract-tested, not driven live; block scope: shell commands. |
| `host:copilot-cloud` | GitHub Copilot cloud coding agent | cloud | advisory | no | Advisory or Git-only surface; no host-level blocking claim. |
| `host:cline` | Cline IDE extension | local | block | no | Adapter/config contract-tested, not driven live; block scope: shell commands. |
| `host:cline-cli` | Cline CLI | local | mcp | yes | MCP/advisory integration; model cooperation required and no blocking claim. |
| `host:crush` | Crush (Charm) | local | mcp | yes | MCP/advisory integration; model cooperation required and no blocking claim. |
| `host:amp` | Amp (Sourcegraph) | local | mcp | yes | MCP/advisory integration; model cooperation required and no blocking claim. |
| `host:goose` | Goose (Block) | local | block | no | Adapter/config contract-tested, not driven live; block scope: shell commands. |
| `host:factory` | Factory Droid | local | mcp | yes | MCP/advisory integration; model cooperation required and no blocking claim. |
| `host:junie` | JetBrains Junie | local | mcp | yes | MCP/advisory integration; model cooperation required and no blocking claim. |
| `host:amazon-q` | Amazon Q Developer | local | mcp | yes | MCP/advisory integration; model cooperation required and no blocking claim. |
| `host:zed` | Zed | local | mcp | yes | MCP/advisory integration; model cooperation required and no blocking claim. |
| `host:aider` | Aider | local | advisory | no | Advisory or Git-only surface; no host-level blocking claim. |
| `host:roo` | Roo Code (archived) | local | mcp | yes | MCP/advisory integration; model cooperation required and no blocking claim. |
| `host:kilo` | Kilo Code | local | mcp | yes | MCP/advisory integration; model cooperation required and no blocking claim. |
| `host:warp` | Warp | local | mcp | yes | MCP/advisory integration; model cooperation required and no blocking claim. |
| `host:devin-cli` | Devin CLI / Devin Local | local | block | yes | Adapter/config contract-tested, not driven live; block scope: shell commands. |
| `host:cascade` | Devin Desktop Cascade (formerly Windsurf) | local | block | yes | Adapter/config contract-tested, not driven live; block scope: shell commands. |
| `host:jules` | Google Jules | cloud | advisory | no | Advisory or Git-only surface; no host-level blocking claim. |
| `host:replit` | Replit Agent | cloud | advisory | no | Advisory or Git-only surface; no host-level blocking claim. |
| `host:continue` | Continue | local | mcp | yes | MCP/advisory integration; model cooperation required and no blocking claim. |
| `host:vscode` | VS Code (host shell) | local | advisory | yes | Advisory or Git-only surface; no host-level blocking claim. |

Google Antigravity is now present as an executable **MCP plus proactive-context adapter**, not a blocking or live-verified integration. The project writer installs `.agents/mcp_config.json` and a JSONC-preserving `.agents/hooks.json` PreInvocation entry that injects changed sibling context and can auto-protect at invocation zero. It deliberately does not install PreToolUse: no neutral documented pass-through has been proven, so translating Holt's narrow allow into Antigravity auto-approval could weaken native permissions. “Works with apps” currently means a supported local agent/editor app can launch the Holt CLI/MCP server and, where documented, its project hook. Holt has no separate always-running desktop daemon, and cloud/ephemeral apps do not inherit local Git locks.

### Promotion gaps not counted as blocking or live proof

| Adapter | Counted classification | What exists | What remains outside the claim |
|---|---|---|---|
| `host:antigravity` | MCP plus proactive context; **not blocking or live** | Project MCP/config writer, PreInvocation context/autoprotect hook, JSONC-preserving install/upgrade, foreign-namespace refusal, detection, activation diagnostics, and symmetric uninstall are executable and contract-tested. | A real Antigravity process drive, loaded/trusted-state proof, failure-semantics proof, and a safe documented neutral PreToolUse response. Provider profiles are research metadata and do not independently inflate this adapter grade. |

## Feature-to-proof matrix

Each quoted evidence name below is an exact string present in the named test/harness source. “Remaining gap” is part of the feature contract: it prevents a bounded result from being marketed as a stronger claim.

### Core analysis and decisions

#### `discovery-and-source-layers`

- User surfaces: `cli:status`, `cli:scan`
- Exact executable evidence: `test/e2e/detection.test.mjs` — “discovery: finds every worktree, and the primary is excluded by default”; `test/e2e/adversarial.test.mjs` — “ADVERSARIAL: detached HEAD is scanned normally”
- Independent oracle: Git porcelain plus independently planted committed, uncommitted, untracked, ignored, detached, deleted, and moved states.
- Remaining unproven gap: No finite fixture set proves every Git layout, filesystem, object store, or future Git version.
- Mandatory runner evidence: `complete-test-corpus`, `git-runtime`

#### `risk-and-content-identity`

- User surfaces: `cli:risk`, `mcp:holt_at_risk`
- Exact executable evidence: `test/e2e/destructive-authority.test.mjs` — “AUTHORITY: identical bytes at different paths are different work”; `test/e2e/break-it.test.mjs` — “ATTACK: work hidden ONLY inside a .gitignore-d path”
- Independent oracle: Exact path, Git mode/type, object identity, and direct byte manifests independent of symbol extraction.
- Remaining unproven gap: Unsupported or unmeasured semantic equivalence is retained as risk; it is not inferred away.
- Mandatory runner evidence: `complete-test-corpus`, `mutation-fingerprint`

#### `disposition-gate`

- User surfaces: `cli:gate`, `mcp:holt_check_workstream`
- Exact executable evidence: `test/e2e/cli.test.mjs` — “CLI: `gate` exit codes are the documented contract”; `test/e2e/break-it.test.mjs` — “ATTACK: a stale cache must not authorise a deletion”
- Independent oracle: Fresh report lookup with exact exit-code assertions and planted sole-copy/redundant/unknown states.
- Remaining unproven gap: `gate` cannot re-verify a later unrelated rm invocation; recoverable `clean --apply` is the rechecking action path.
- Mandatory runner evidence: `complete-test-corpus`, `guard-corpus`

#### `collision-analysis`

- User surfaces: `cli:collisions`, `mcp:holt_collisions`
- Exact executable evidence: `test/e2e/detection.test.mjs` — “P1 PRESENCE: a real registry conflict is detected AND proven by merge-tree”; `test/e2e/detection.test.mjs` — “P1 PRECISION: a pair git PROVES merges cleanly is not a conflict”
- Independent oracle: Git merge-tree for committed combinations plus independently planted uncommitted same-hunk conflicts.
- Remaining unproven gap: Predicted uncommitted overlap is evidence, not a merge-conflict certificate; runtime interactions need `verify`.
- Mandatory runner evidence: `complete-test-corpus`, `mutation-fingerprint`

#### `hotspot-analysis`

- User surfaces: `cli:hotspots`, `mcp:holt_hotspots`
- Exact executable evidence: `test/e2e/detection.test.mjs` — “P1 HOTSPOT: merge-unknown shared files remain visible as an aggregate”; `test/unit/partition.test.mjs` — “partition: full collision evidence feeds hotspots even when the visible list is filtered”
- Independent oracle: Set intersection over independently planted changed-file manifests.
- Remaining unproven gap: A shared file is deliberately not called a conflict; hotspots rank review attention only.
- Mandatory runner evidence: `complete-test-corpus`

#### `duplicate-analysis`

- User surfaces: `cli:duplicates`, `mcp:holt_duplicates`
- Exact executable evidence: `test/e2e/detection.test.mjs` — “P3 RECALL: the same function reformatted in two worktrees is still duplicate work”; `test/e2e/detection.test.mjs` — “P3 PRECISION: two workstreams that coincidentally pick the same name for unrelated work are not duplicates”
- Independent oracle: Planted same-body and same-name/different-body controls across independently timed dispatch families.
- Remaining unproven gap: Symbol/body and optional token-clone evidence do not prove semantic equivalence for all languages.
- Mandatory runner evidence: `complete-test-corpus`, `mutation-fingerprint`

#### `deep-token-clone-analysis`

- User surfaces: `option:--deep`, `mcp-option:holt_duplicates.deep`, `backend:jscpd`
- Exact executable evidence: `scripts/run-feature-proof.mjs` — “DEEP BACKEND: renamed added-line clone is found, unrelated work stays absent, and same-workstream clones stay excluded”; `test/unit/package-contents.test.mjs` — “package: every shipped bare import is declared and optional imports are load-time degradable”
- Independent oracle: Three real worktrees with planted renamed cross-dispatch clone, unrelated negative control, and same-workstream clone, graded from jscpd output ownership.
- Remaining unproven gap: The mandatory proof needs the optional jscpd backend; token clones remain review candidates and do not prove semantic equivalence.
- Mandatory runner evidence: `deep-runtime`, `complete-test-corpus`

#### `language-and-parser-backends`

- User surfaces: `backend:universal-ctags`, `backend:enry`, `backend:regex-fallback`, `cli:doctor`
- Exact executable evidence: `test/unit/languages.test.mjs` — “language coverage: every case yields its named symbols”; `test/unit/languages.test.mjs` — “COMPAT: every pack is loadable by this ctags and defines what it claims”; `test/e2e/adversarial.test.mjs` — “ADVERSARIAL: same extension, different languages, resolved by CONTENT”
- Independent oracle: Named source declarations across the measured language corpus plus ambiguous-extension files whose content selects different parsers.
- Remaining unproven gap: Coverage is the named corpus on the installed backend versions; generated syntax, future grammars, and every language construct remain outside it.
- Mandatory runner evidence: `complete-test-corpus`, `git-runtime`

#### `strict-read-only-analysis`

- User surfaces: `option:--strict-read-only`
- Exact executable evidence: `test/e2e/strict-read-only.test.mjs` — “STRICT-READ-ONLY: writes zero objects, on a fixture proven to write objects otherwise”; `test/e2e/strict-read-only.test.mjs` — “STRICT-READ-ONLY: degraded verdicts are labelled approximate, never presented as measured”
- Independent oracle: Git object counts before/after strict and non-strict positive-control scans plus confidence labels on planted committed deltas.
- Remaining unproven gap: Strict mode intentionally over-reports some committed deltas and is not an equivalence-preserving substitute for the normal instrument.
- Mandatory runner evidence: `complete-test-corpus`, `git-runtime`

#### `bounded-analysis-and-honest-degradation`

- User surfaces: `contract:analysis-bounds`, `option:--limit`, `option:--no-symbols`
- Exact executable evidence: `test/e2e/no-symbols.test.mjs` — “--no-symbols: safety decisions and Git-proven conflicts equal a full scan while symbol findings are explicitly absent”; `test/e2e/no-symbols.test.mjs` — “--no-symbols: a fresh CLI scan bypasses the planted symbol backend; the positive control reaches it”; `test/e2e/break-it.test.mjs` — “ATTACK: a file too large to tag reads as "no symbols" instead of "not measured"”; `test/e2e/stash-evidence.test.mjs` — “STASH: more than MAX_ENTRIES entries → truncated flag is set and describeStash warns”; `test/e2e/mcp.test.mjs` — “MCP: every list-returning tool SAYS when it capped the list”
- Independent oracle: Paired full/file-only scans over planted disposable, at-risk, duplicate, and conflicting work, plus a fresh-process symbol-backend boundary trap and fixtures that cross every named bound.
- Remaining unproven gap: `--no-symbols` deliberately omits unique-symbol, semantic-overlap, duplicate, and impact evidence; the backend-bypass control proves avoided extraction work, not a universal wall-clock or token saving.
- Mandatory runner evidence: `no-symbols-contract`, `complete-test-corpus`

#### `sibling-context`

- User surfaces: `cli:context`, `mcp:holt_context`
- Exact executable evidence: `test/e2e/detection.test.mjs` — “P2 PRESENCE: the digest names the sibling contesting the same file”; `test/e2e/cli.test.mjs` — “SCRIPTABILITY: context exits non-zero for an unknown id, zero for a real one”
- Independent oracle: Fixture workstream identity plus known sibling file/symbol overlap.
- Remaining unproven gap: Context is a measured snapshot; it cannot predict writes made after the call.
- Mandatory runner evidence: `complete-test-corpus`

#### `dependency-impact`

- User surfaces: `cli:impact`, `mcp:holt_impact`
- Exact executable evidence: `test/e2e/impact.test.mjs` — “IMPACT PRESENCE: finds a producer/consumer pair that shares NO file”; `test/e2e/real-repos.test.mjs` — “REAL REPOS: the exact pinned four-repository corpus was exercised”
- Independent oracle: A producer defines and a separate consumer references a planted symbol while sharing no file.
- Remaining unproven gap: Static symbol references cannot see every reflective, generated, data-driven, or runtime dependency.
- Mandatory runner evidence: `complete-test-corpus`

#### `stash-risk`

- User surfaces: `cli:stash`
- Exact executable evidence: `test/e2e/stash-evidence.test.mjs` — “TREE ENTRY AUTHORITY: an exact reachable path/mode/type/object relaxes drop and clear”; `test/e2e/actions.test.mjs` — “CATASTROPHIC: stash drop/clear are destructive; pop remains recovery”
- Independent oracle: Planted stash trees compared directly with reachable Git trees.
- Remaining unproven gap: Corrupt or unreadable stash objects remain unknown rather than receiving an all-clear.
- Mandatory runner evidence: `complete-test-corpus`

#### `status-risk-and-brief`

- User surfaces: `cli:brief`
- Exact executable evidence: `test/e2e/brief-cadence.test.mjs` — “BRIEF: the per-prompt hook speaks once, then stays quiet until something changes”; `test/e2e/cli.test.mjs` — “FIRST RUN: `holt brief` never fabricates a clean bill when the scan could not answer”
- Independent oracle: Repository fingerprint changes and explicit unknown/at-risk fixtures.
- Remaining unproven gap: Concise output necessarily omits lower-priority rows; full JSON/status retains the denominator.
- Mandatory runner evidence: `complete-test-corpus`

#### `configuration-and-policy-escape-hatch`

- User surfaces: `config:.holtrc.json`
- Exact executable evidence: `test/e2e/config-authority.test.mjs` — “CONFIG AUTHORITY: a repository cannot grant itself permission”; `test/e2e/config-cli.test.mjs` — “config: an unparseable .holtrc.json fails LOUDLY — exit 2, never a silent default”; `test/unit/saferegex.test.mjs` — “SAFEREGEX: an unbounded pattern is declined inside the budget instead of hanging”
- Independent oracle: Malformed, unknown-key, authority-downgrade, safe-regex, and compound-command controls.
- Remaining unproven gap: A human allow rule records intent but cannot make an intrinsically destructive command safe.
- Mandatory runner evidence: `complete-test-corpus`

### Coordination and landing

#### `review-plan`

- User surfaces: `cli:plan`, `mcp:holt_landing_plan`
- Exact executable evidence: `test/e2e/detection.test.mjs` — “P5: the plan drops disposables, collapses duplicates, and orders the rest”; `test/e2e/detection.test.mjs` — “P5 COLLAPSE: exact fan-out copies collapse only when every copy is durable”
- Independent oracle: Known disposable, exact durable duplicate, unique, and entangled workstreams in one fixture.
- Remaining unproven gap: The plan is advisory and cannot know product priority or reviewer intent.
- Mandatory runner evidence: `complete-test-corpus`

#### `landing-order`

- User surfaces: `cli:order`, `mcp:holt_landing_order`
- Exact executable evidence: `test/unit/order.test.mjs` — “SEQUENCING: co-located pairs entangle the ORDER even though triage hides them”; `test/unit/order.test.mjs` — “order: deterministic across runs on identical input”
- Independent oracle: Synthetic evidence graphs with known connected components and deterministic tie breaks.
- Remaining unproven gap: Least-entangled-first is a heuristic, never a proof that the resulting software is correct.
- Mandatory runner evidence: `complete-test-corpus`

#### `agent-partition`

- User surfaces: `cli:partition`, `mcp:holt_partition`
- Exact executable evidence: `test/unit/partition.test.mjs` — “partition: buckets are disjoint and cover every top-level segment”; `test/unit/partition.test.mjs` — “partition: PROPERTY — no two conflicting workstreams land in different buckets”
- Independent oracle: Seeded random graphs checked for disjoint coverage, ownership, and conflict co-location.
- Remaining boundary: Without explicit task paths/components, Holt returns `insufficient_task_context` and labels the output as an advanced structural view; even an anchored map does not infer a complete task decomposition or developer expertise.
- Mandatory runner evidence: `complete-test-corpus`

#### `branch-graveyard`

- User surfaces: `cli:branches`, `mcp:holt_branches`
- Exact executable evidence: `test/e2e/branches.test.mjs` — “BRANCHES: landed vs content-landed vs unlanded, classified by content not ancestry”; `test/e2e/actions.test.mjs` — “CLEAN ATTACK: an unmerged branch must not be silently deleted”
- Independent oracle: Git ancestry and tree-content comparisons against planted merge, squash, unique, and checked-out branches.
- Remaining unproven gap: Content-landed and unknown branches are review findings; Holt does not auto-delete them.
- Mandatory runner evidence: `complete-test-corpus`

#### `pair-verification`

- User surfaces: `cli:verify`
- Exact executable evidence: `test/e2e/verify.test.mjs` — “VERIFY: reports the interaction, attributed to the COMBINATION”; `test/e2e/verify.test.mjs` — “VERIFY: an already-red suite is NOT reported as an interaction”
- Independent oracle: A/B/A+B Git merges executing a planted user test whose failure exists only in the combination.
- Remaining unproven gap: It executes user code and only observes the supplied test command; an incomplete suite remains incomplete.
- Mandatory runner evidence: `complete-test-corpus`

### Graph and TUI

#### `relationship-graph`

- User surfaces: `cli:graph`
- Exact executable evidence: `test/e2e/graph-html.test.mjs` — “GRAPH LEGIBILITY: no label is drawn on top of another”; `test/e2e/graph-html.test.mjs` — “HTML INJECTION: EVERY string in the report is inert”; `test/unit/ascii-graph.test.mjs` — “render: stays BOUNDED at scale”
- Independent oracle: DOM-level hostile-string checks, geometric label intersection checks, and graph-edge/node invariants.
- Remaining unproven gap: Automated geometry and injection checks are not a broad human usability study or every-browser run.
- Mandatory runner evidence: `complete-test-corpus`

#### `interactive-tui`

- User surfaces: `cli:tui`
- Exact executable evidence: `test/e2e/tui.test.mjs` — “TUI: the frame shows the story a human needs”; `test/e2e/tui.test.mjs` — “TUI: the overflow counter is never negative, never zero, and never exceeds the total”
- Independent oracle: Exact terminal frames at bounded dimensions plus keyboard-action state transitions.
- Remaining unproven gap: Snapshot/PTY coverage does not prove rendering in every terminal emulator or assistive technology.
- Mandatory runner evidence: `complete-test-corpus`, `portable-denominator`

### Actions, recovery, and purge

#### `protect-auto-unprotect`

- User surfaces: `cli:protect`, `cli:auto`, `cli:unprotect`, `mcp:holt_protect`
- Exact executable evidence: `test/e2e/actions.test.mjs` — “PROTECT ATTACK: does a locked worktree actually survive --force?”; `test/e2e/actions.test.mjs` — “PROTECT ATTACK: -f -f still overrides, and we must not pretend otherwise”; `test/e2e/actions.test.mjs` — “AUTO: does every lossless thing by itself, and refuses to delete anything”; `test/e2e/unprotect-force.test.mjs` — “UNPROTECT --force CLI: bare --force (no --reason, no --yes) is refused before anything changes”
- Independent oracle: Real Git worktree locks challenged by force removal, foreign lock ownership, and landing convergence.
- Remaining unproven gap: Git documents double-force override; Holt reports this and relies on host guards for covered commands.
- Mandatory runner evidence: `complete-test-corpus`, `guard-corpus`, `mutation-fingerprint`

#### `rescue-and-inventory`

- User surfaces: `cli:rescue`, `cli:rescued`, `mcp:holt_rescue`
- Exact executable evidence: `test/e2e/actions.test.mjs` — “RESCUE ATTACK: the work is restorable AFTER the worktree is destroyed”; `test/e2e/git-execution-boundary.test.mjs` — “GIT BOUNDARY: rescue captures pre-filter bytes exactly without starting the configured program”
- Independent oracle: Independent read-back of every captured path, Git type, mode, object id, and byte digest from the rescue ref.
- Remaining unproven gap: Dirty submodules are refused rather than falsely captured; recovery then needs explicit user handling.
- Mandatory runner evidence: `complete-test-corpus`, `guard-corpus`, `mutation-fingerprint`

#### `clean-quarantine-restore`

- User surfaces: `cli:clean`, `cli:quarantines`, `cli:restore`, `mcp:holt_clean`
- Exact executable evidence: `test/e2e/actions.test.mjs` — “CLEAN ATTACK (TOCTOU): work appearing DURING the run must abort that delete”; `test/e2e/actions.test.mjs` — “CLEAN RECOVERY: first-class restore preserves protection that predated quarantine”; `test/e2e/cli.test.mjs` — “CLI: `clean --apply` reports recoverable quarantine and explicit zero deletion”
- Independent oracle: Real registered worktree identity, late-write races, lock continuity, byte survival, and exact restore argv.
- Remaining unproven gap: Quarantine retains disk usage by design until a separately proven physical purge is exposed and chosen.
- Mandatory runner evidence: `complete-test-corpus`, `guard-corpus`, `mutation-fingerprint`

#### `guarded-discard`

- User surfaces: `cli:discard`
- Exact executable evidence: `test/e2e/actions.test.mjs` — “DISCARD: nested empty directories do not dead-end recoverable cleanup”; `test/e2e/actions.test.mjs` — “DISCARD: a many-leaf generated tree is captured without exhausting object writers”; `test/e2e/actions.test.mjs` — “DISCARD: binary content is captured byte-for-byte before removal”; `test/e2e/actions.test.mjs` — “DISCARD RACE: a same-name replacement created after capture is never erased”; `test/e2e/actions.test.mjs` — “DISCARD: restoring a tracked executable proves content, type, and executable mode”
- Independent oracle: Pre-removal ref capture independently compared by bytes/type/mode/path across empty-directory shape, 384 sole-copy leaves, binary data, and post-capture replacement races.
- Remaining unproven gap: Platform-specific ACLs and extended attributes are not represented by the Git object model.
- Mandatory runner evidence: `complete-test-corpus`, `guard-corpus`, `mutation-fingerprint`

#### `quarantine-purge`

- User surfaces: `cli:purge`, `mcp:holt_purge`, `api:purgeQuarantine`
- Exact executable evidence: `test/e2e/actions.test.mjs` — “CLEAN PURGE: preview is inert; apply anchors exact HEAD and reclaims a clean quarantine”; `test/e2e/actions.test.mjs` — “CLEAN PURGE RACE: Git independently refuses late work and Holt restores the lock”
- Independent oracle: Exact HEAD recovery ref, dirty-state refusal, lock-authority tamper, and late-write race checks.
- Remaining unproven gap: Purge is intentionally irreversible after re-verification; it retains the exact HEAD and branch, not uncommitted bytes introduced after a refused check.
- Mandatory runner evidence: `complete-test-corpus`, `mutation-fingerprint`

### Agent integrations, hooks, and MCP

#### `shell-command-guard`

- User surfaces: `cli:hook`
- Exact executable evidence: `test/e2e/shell-grammar.test.mjs` — “GRAMMAR: a destroyer is seen through every construct that can carry it”; `test/e2e/shell-grammar.test.mjs` — “GRAMMAR NEVER-WORSE: the same constructs carrying ordinary work stay out of the way”; `test/e2e/guard-classes-repair.test.mjs` — “[C] find primaries, -exec utilities and stdin-fed xargs destroy, and are refused”
- Independent oracle: Host payloads drive real hook subprocesses against destructive and ordinary shell grammar controls.
- Remaining unproven gap: Only documented wired host events are intercepted; arbitrary external processes remain outside the host hook.
- Mandatory runner evidence: `complete-test-corpus`, `guard-corpus`, `mutation-fingerprint`

#### `native-file-tool-guard`

- User surfaces: `hook:claude-code:Write`, `hook:claude-code:Edit`, `hook:codex:apply_patch`
- Exact executable evidence: `test/e2e/native-tool-hooks.test.mjs` — “Codex apply_patch delete reaches fresh file evidence while Update File remains seamless”; `test/unit/native-tool-hooks.test.mjs` — “arbitrary local-function and MCP inputs are not reinterpreted as filesystem contracts”
- Independent oracle: Current documented structured tool envelopes with path/content state independently inspected before the action.
- Remaining unproven gap: Coverage is intentionally exact: incremental edits and unknown MCP/local-function schemas are not guessed.
- Mandatory runner evidence: `complete-test-corpus`, `host-manifest-sync`, `mutation-fingerprint`

#### `proactive-lifecycle-context`

- User surfaces: `hook:session-start`, `hook:user-prompt-submit`, `hook:session-end`, `hook:stop`
- Exact executable evidence: `test/e2e/brief-cadence.test.mjs` — “CODEX BRIEF: UserPromptSubmit uses additionalContext once, then emits no unchanged prompt noise”; `test/e2e/brief-cadence.test.mjs` — “BRIEF: SessionStart is never suppressed”; `test/e2e/brief-cadence.test.mjs` — “CURSOR STOP: followup_message is completed-only, one-loop-bounded”; `test/e2e/autoprotect.test.mjs` — “AUTOPROTECT: session-start with --autoprotect locks at-risk worktrees before the agent moves”
- Independent oracle: Repeated lifecycle envelopes against unchanged and changed repository fingerprints.
- Remaining unproven gap: Proactivity exists only on hosts with a documented wired lifecycle event; MCP alone remains model-invoked.
- Mandatory runner evidence: `complete-test-corpus`, `host-manifest-sync`

#### `integration-install-upgrade-uninstall`

- User surfaces: `cli:integrate`, `cli:uninstall`
- Exact executable evidence: `test/e2e/integration.test.mjs` — “INSTALL: integrate() wires AGENTS.md + MCP + detected hosts only”; `test/e2e/integrate-upgrade.test.mjs` — “UPGRADE: a stale hook entry from a prior version is RECONCILED, never duplicated”; `test/unit/host-hook-contracts.test.mjs` — “shared hook upgrades and uninstall preserve sibling user commands”
- Independent oracle: Byte comparison of pre-existing host configs before install, repeated upgrade, and uninstall.
- Remaining unproven gap: A correct config on disk does not prove a host loaded it, trusted it, or drove an enforcement event.
- Mandatory runner evidence: `complete-test-corpus`, `host-manifest-sync`, `mutation-fingerprint`

#### `host-compatibility-report`

- User surfaces: `cli:hosts`
- Exact executable evidence: `test/unit/host-manifest.test.mjs` — “host config fixtures: file path + top-level key match each host”; `test/unit/readme-hosts-sync.test.mjs` — “README: no config/source smoke is claimed as a real-host enforcement run”; `test/e2e/opencode-plugin.test.mjs` — “OPENCODE: opencode itself loads the plugin (skips if opencode is absent)”
- Independent oracle: Executable host manifest, config writers, source/CLI config probes, and explicit verifiedLive flags.
- Remaining unproven gap: Most hosts are contract-tested rather than driven live; an adapter entry is not proof that the host loaded or executed it.
- Mandatory runner evidence: `complete-test-corpus`, `host-manifest-sync`, `portable-denominator`

#### `provider-adapter-status`

- User surfaces: `cli:providers`
- Exact executable evidence: `test/e2e/providers-cli.test.mjs` — “PROVIDERS CLI: human output separates implemented, contract-verified, live-verified, and framework-only”; `test/e2e/providers-cli.test.mjs` — “PROVIDERS CLI: JSON exposes install scope and reactive versus proactive capability contracts”; `test/e2e/providers-cli.test.mjs` — “PROVIDERS CLI: read-only command works outside a Git repository”; `test/unit/provider-profiles.test.mjs` — “adapter inventory separates shipped installation from provider capability and reports activation semantics”
- Independent oracle: Human and JSON CLI reports are compared with strict provider profiles, install scopes, capability initiation semantics, and an outside-repository read-only control.
- Remaining unproven gap: Contract verification is not a live provider run; framework-only profiles install nothing, and no profile may claim blocking until its live allow/deny/failure matrix passes.
- Mandatory runner evidence: `complete-test-corpus`

#### `antigravity-context-and-mcp-adapter`

- User surfaces: `host:antigravity`, `hook:antigravity:PreInvocation`, `mcp-config:antigravity`
- Exact executable evidence: `test/unit/antigravity-adapter.test.mjs` — “Antigravity installs proactive context without an authority-granting PreToolUse hook”; `test/unit/antigravity-adapter.test.mjs` — “Antigravity MCP, hook detection, activation diagnostics and uninstall are symmetric”; `test/unit/antigravity-adapter.test.mjs` — “Antigravity PreInvocation enters model context and unchanged later invocations stay quiet”
- Independent oracle: Isolated JSONC configs plus a real repository with planted sibling-only work, first/later invocation controls, activation inspection, and uninstall read-back.
- Remaining unproven gap: The adapter is MCP plus proactive context, not blocking: no PreToolUse hook is installed, loaded/live state is unknown, and no real Antigravity process has been driven.
- Mandatory runner evidence: `complete-test-corpus`, `host-manifest-sync`

#### `mcp-decision-tools`

- User surfaces: `cli:mcp`, `mcp:holt_status`, `mcp:holt_collisions`, `mcp:holt_hotspots`, `mcp:holt_duplicates`, `mcp:holt_context`, `mcp:holt_impact`, `mcp:holt_landing_order`, `mcp:holt_branches`, `mcp:holt_partition`, `mcp:holt_landing_plan`
- Exact executable evidence: `test/e2e/mcp.test.mjs` — “MCP holt_status: returns the decision surface, not an inventory”; `test/e2e/mcp-protocol.test.mjs` — “MCP PROTOCOL: tools/list returns the full, well-formed tool set”
- Independent oracle: Real stdio JSON-RPC plus direct comparison with planted repository truth.
- Remaining unproven gap: MCP is reactive: the model/host must invoke a tool unless a separate lifecycle hook injects context.
- Mandatory runner evidence: `complete-test-corpus`

#### `mcp-action-tools`

- User surfaces: `mcp:holt_clean`, `mcp:holt_rescue`, `mcp:holt_protect`
- Exact executable evidence: `test/e2e/mcp.test.mjs` — “MCP: holt_clean declares the reversible quarantine contract”; `test/e2e/mcp-protocol.test.mjs` — “MCP PROTOCOL: the acting tools ACT — the full loop an agent needs, over the wire”
- Independent oracle: Protocol calls followed by independent Git refs, locks, quarantine paths, and restore-state inspection.
- Remaining unproven gap: The host approval policy still decides whether non-read-only MCP calls may execute.
- Mandatory runner evidence: `complete-test-corpus`, `guard-corpus`

#### `mcp-security-boundary`

- User surfaces: `mcp:boundary`
- Exact executable evidence: `test/e2e/mcp-hostile.test.mjs` — “HOSTILE: `repo` cannot point holt at another repository — reading OR removing”; `test/e2e/mcp-hostile.test.mjs` — “HOSTILE: not one control, bidi or invisible character reaches the model, and ordinary names are untouched”; `test/e2e/mcp.test.mjs` — “MCP: limit is honoured and clamped”
- Independent oracle: Two unrelated real repositories, hostile identifiers, schema-invalid arguments, and full wire responses.
- Remaining unproven gap: Transport/security behavior beyond the shipped stdio server and supported SDK version is not claimed.
- Mandatory runner evidence: `complete-test-corpus`, `mutation-fingerprint`

#### `activation-integrity-diagnostics`

- User surfaces: `cli:doctor`
- Exact executable evidence: `test/unit/activation-integrity.test.mjs` — “full current Codex config is configured on disk while trust/runtime/live remain unknown”; `test/e2e/cli.test.mjs` — “DOCTOR: a worktree created after integrate is reported as unwired”
- Independent oracle: Isolated homes with separately planted advisory, hook, and MCP files.
- Remaining unproven gap: Trust, loaded state, runtime state, and live proof remain unknown without a real host event.
- Mandatory runner evidence: `complete-test-corpus`, `host-manifest-sync`

### Journal, forensics, SIEM, and team

#### `journal-integrity-and-proofs`

- User surfaces: `cli:journal`
- Exact executable evidence: `test/e2e/audit-chain.test.mjs` — “CLI: --prove emits an offline RFC 6962 inclusion proof that verifies”; `test/unit/journal.test.mjs` — “JOURNAL: inside a repository it still writes, and under the COMMON git dir”
- Independent oracle: Independent hash recomputation, planted line tamper, append/rewrite races, and proof verification.
- Remaining unproven gap: The journal sees Holt and wired-hook events; it cannot attest to unobserved external actions.
- Mandatory runner evidence: `complete-test-corpus`, `mutation-fingerprint`

#### `journal-exports-and-summary`

- User surfaces: `journal:verify`, `journal:prove`, `journal:export`, `journal:summary`
- Exact executable evidence: `test/unit/siem.test.mjs` — “ATTACK: a hostile value cannot forge an extra record in ANY line-oriented format”; `test/unit/siem.test.mjs` — “a journal that does not VERIFY refuses to export, in every format”; `test/unit/roi.test.mjs` — “roi: prevented losses count blocks and verified rescues, and only those”
- Independent oracle: Known event ledger transformed into OCSF, ECS, CEF, JSON, CSV, and in-toto with schema/line controls.
- Remaining unproven gap: Format conformance tests are not a live ingestion run against every downstream SIEM product.
- Mandatory runner evidence: `complete-test-corpus`

#### `forensics-timeline`

- User surfaces: `cli:forensics`
- Exact executable evidence: `test/e2e/forensics.test.mjs` — “FORENSICS: `holt forensics <id>` reconstructs created / wrote / attempted / survived”; `test/e2e/forensics.test.mjs` — “FORENSICS: a host that says nothing produces `unknown`, NOT the human running the shell”
- Independent oracle: Planted journal events correlated with Git reflog/worktree state and explicit actor/session controls.
- Remaining unproven gap: Forensics cannot reconstruct events no available evidence source recorded.
- Mandatory runner evidence: `complete-test-corpus`

#### `fleet-policy-and-ci`

- User surfaces: `cli:fleet`, `cli:ci`, `journal:fleet`, `forensics:fleet`
- Exact executable evidence: `test/e2e/team.test.mjs` — “FLEET NEVER-WORSE: distinct repositories are never merged, and an unidentifiable directory is still reported”; `test/e2e/policy-authority.test.mjs` — “BYPASS 1: a candidate that DELETES the policy is still judged by the base policy”; `test/e2e/ci-gate.test.mjs` — “CI GATE: a branch that DELETES .holt/policy.json is still gated by the base policy”
- Independent oracle: Multiple real repositories, linked-worktree identity controls, base-authoritative policy, and exact CI exits.
- Remaining unproven gap: Team fleet mechanics and reviewed repository policy do not provide Enterprise identity provisioning or signed central-policy distribution by themselves.
- Mandatory runner evidence: `complete-test-corpus`, `ci-hardening`

#### `managed-policy-authority`

- User surfaces: `cli:managed-policy`, `cli:ci`
- Exact executable evidence: `test/e2e/managed-policy-cli.test.mjs` — “managed-policy is a real Enterprise entitlement with a reachable command surface”; `test/e2e/managed-policy-tuf.test.mjs` — “real Updater verifies and activates policy with a root-bound sorted receipt, then offline authority load performs zero fetches”; `test/e2e/managed-policy-authority.test.mjs` — “system-enrolled active policy resolves by exact trusted identity and evaluates every layer additively without fetch”
- Independent oracle: Real tuf-js signatures/rotation/delegation, root-owned out-of-repository authority, inode-bound repository identity, crash receipts, and byte-identical last-good state.
- Remaining unproven gap: SSO/SCIM, Windows system ACL authority, signed offline-media update workflow, and a hosted macOS root-ownership run are not shipped or proven.
- Mandatory runner evidence: `complete-test-corpus`, `mutation-fingerprint`

#### `continuous-siem-sink`

- User surfaces: `journal:sink`
- Exact executable evidence: `test/e2e/audit-chain.test.mjs` — “PAID: the sink emits once, then is idempotent — a SIEM is not double-billed for a re-run”; `test/unit/siem.test.mjs` — “every exported record carries its RFC 6962 leaf hash as the de-duplication id”
- Independent oracle: Append/restart/tamper fixtures with independent cursor and record-id checks.
- Remaining unproven gap: The shipped sink writes a configured path; live vendor transport, credentials, retry, and backpressure integrations are not proven.
- Mandatory runner evidence: `complete-test-corpus`

#### `actor-attribution`

- User surfaces: `journal:actor`
- Exact executable evidence: `test/unit/actor.test.mjs` — “actor: with no evidence at all, everything is unknown and nothing is fabricated”; `test/e2e/team.test.mjs` — “JOURNAL: every recorded action names WHO, and never invents one”
- Independent oracle: Controlled environment/session combinations with hostile values and absent-identity negatives.
- Remaining unproven gap: Environment-derived identity is reported or inferred, not cryptographic human identity.
- Mandatory runner evidence: `complete-test-corpus`

### Supply chain, package, and release

#### `supply-chain-audit-and-offline-runtime`

- User surfaces: `cli:audit`
- Exact executable evidence: `test/unit/supply-chain.test.mjs` — “the shipped package passes its own audit”; `test/unit/supply-chain.test.mjs` — “RED: one flipped byte in one shipped file is caught and named”; `test/unit/no-network.test.mjs` — “NO NETWORK: analysis, hooks, MCP and CI stay offline; only explicit managed-policy sync is in src”
- Independent oracle: Manifest byte flips/add/delete, pinned signature controls, executable capability scan, and planted network calls.
- Remaining unproven gap: An unsigned development checkout proves integrity against its local manifest, not publisher authenticity.
- Mandatory runner evidence: `complete-test-corpus`, `mutation-fingerprint`, `release-contract`

#### `package-and-installed-artifact`

- User surfaces: `package:npm-tarball`, `install:omit-optional`
- Exact executable evidence: `test/unit/package-contents.test.mjs` — “package: every module the shipped code imports is inside the tarball”; `test/unit/supply-chain.test.mjs` — “THE REAL TARBALL SELF-VERIFIES — the manifest must describe what npm actually packs”; `test/unit/install-url.test.mjs` — “every covered file advertises an npm install command for the GitHub release tarball”; `test/unit/omit-optional-install.test.mjs` — “OMIT OPTIONAL PROOF CLI: absence exits zero and a planted optional root exits nonzero”
- Independent oracle: Fresh npm pack contents, import closure, manifest verification, isolated-prefix optional-root inspection, and installed CLI smoke.
- Remaining unproven gap: Local candidate proof does not make the currently published registry/release asset identical or current.
- Mandatory runner evidence: `complete-test-corpus`, `release-contract`

#### `release-and-ci-contract`

- User surfaces: `release:github`, `ci:github-actions`
- Exact executable evidence: `test/unit/release-contract.test.mjs` — “release contract: the real action, workflow, package and locks are green”; `test/unit/release-body.test.mjs` — “RELEASE BODY: the body checked into this repository passes its own gate”; `test/unit/published-numbers-gate.test.mjs` — “gate: the checker PASSES on the real synchronized claim-or-withholding state”
- Independent oracle: Workflow parser with planted mutable refs, permission widening, evidence reordering, asset clobber, and false claims.
- Remaining unproven gap: Static/local contract proof is not a successful protected remote release on Linux, macOS, and Windows.
- Mandatory runner evidence: `complete-test-corpus`, `ci-hardening`, `release-contract`, `release-bodies`

### Backends and platform compatibility

#### `platform-and-path-portability`

- User surfaces: `runtime:linux`, `runtime:macos`, `runtime:windows`
- Exact executable evidence: `test/unit/native-path-class.test.mjs` — “NATIVE PATHS: the lint FIRES on every historical defect — proven, not assumed”; `test/unit/cat-file-batch-newline-paths.test.mjs` — “catFileBatch: a newline in one path does not shift every LATER record onto the wrong spec”; `test/e2e/moved-repo.test.mjs` — “moved repo: step 3 — after `git worktree repair`, the answers are EQUIVALENT to the original”
- Independent oracle: Native path APIs, hostile filenames, protocol framing, and explicitly named cross-platform guard corpus.
- Remaining unproven gap: One local run proves only its named platform; macOS/Windows require separate zero-skip artifacts.
- Mandatory runner evidence: `complete-test-corpus`, `portable-denominator`, `path-boundary`, `guard-corpus`

#### `git-repository-shape-compatibility`

- User surfaces: `compat:submodules`, `compat:sparse-checkout`, `compat:git-lfs`
- Exact executable evidence: `test/e2e/adversarial.test.mjs` — “ADVERSARIAL: a submodule does not derail the parent scan”; `test/e2e/actions.test.mjs` — “CATASTROPHIC: rescue REFUSES a dirty submodule instead of reporting it verified”; `test/e2e/index-flag-blindness.test.mjs` — “index flags: the flag ALONE is not the evidence — an absent path is not at risk (sparse checkout)”; `test/e2e/guard-classes-repair.test.mjs` — “[B] a sparse checkout is classifiable and cheap — no E2BIG, no per-call second”
- Independent oracle: Real populated and dirty submodules plus sparse worktrees with Git index flags and independently inspected on-disk paths.
- Remaining unproven gap: Submodule and sparse-checkout paths are exercised, but Git LFS has no dedicated fixture; filters, missing LFS objects, and every promisor configuration remain unproven.
- Mandatory runner evidence: `complete-test-corpus`, `git-runtime`, `guard-corpus`

#### `jujutsu-backend`

- User surfaces: `backend:jj`
- Exact executable evidence: `test/e2e/jj.test.mjs` — “jj: end-to-end, holt finds the work in a jj workspace”; `test/e2e/jj-backend.test.mjs` — “jj-backend: the working copy is snapshotted (snapshotBased: true, no uncommitted layer)”
- Independent oracle: A real colocated jj repository/workspace checked with jj operation-log immutability and Git cat-file.
- Remaining unproven gap: A run without jj is rejected as a skip; one installed jj version does not prove every past/future version.
- Mandatory runner evidence: `complete-test-corpus`

### Worst-case and benchmark protocols

#### `pinned-real-repository-corpus`

- User surfaces: `harness:real-repos`
- Exact executable evidence: `test/e2e/real-repos.test.mjs` — “exact pinned four-repository corpus was exercised”
- Independent oracle: Pinned Click, Gin, ripgrep, and Express commits with planted duplicate/collision/risk/disposable/impact truth.
- Remaining unproven gap: Four repositories and languages are a named corpus, not universal ecosystem coverage.
- Mandatory runner evidence: `complete-test-corpus`

#### `monster-and-randomized-invariants`

- User surfaces: `harness:monster`, `harness:fuzz`
- Exact executable evidence: `test/e2e/monster.test.mjs` — “MONSTER: 40 worktrees of every trap at once — full loop, every byte graded”; `test/e2e/fuzz-invariant.test.mjs` — “FUZZ INVARIANT seed=${seed}: holt never calls at-risk content safe, never removes it”
- Independent oracle: Direct filesystem/base comparison and retained-byte checks share no verdict code with Holt.
- Remaining unproven gap: Seeded randomized and synthetic worst cases remain finite; passing them is not proof against every possible race.
- Mandatory runner evidence: `complete-test-corpus`, `mutation-fingerprint`

#### `benchmark-evidence-protocol`

- User surfaces: `harness:enterprise`, `harness:hook-latency`, `harness:agent-ab`
- Exact executable evidence: `test/unit/benchmark-evidence.test.mjs` — “BENCH EVIDENCE: missing numeric samples stay in the denominator”; `test/unit/benchmark-evidence.test.mjs` — “BENCH EVIDENCE: enterprise smoke preserves warmups, repetitions, grading, commands, and source identity”; `test/unit/eval-validity.test.mjs` — “EVAL VALIDITY: invalid trials are EXCLUDED from rates, not counted as successes”
- Independent oracle: Pinned source identity, planted ground truth, retained warmups/samples, complete denominators, and checksum sidecars.
- Remaining unproven gap: Harness validity is not product-effectiveness evidence; smoke or low-repetition A/B results are not publishable.
- Mandatory runner evidence: `complete-test-corpus`

### Purchase, licensing, and public claims

#### `offline-license-and-entitlements`

- User surfaces: `cli:license`
- Exact executable evidence: `test/unit/license.test.mjs` — “ATTACK: payload edited to upgrade the tier, original signature kept”; `test/e2e/purchase-path.test.mjs` — “E2E: the full happy path — signed webhook mints a license the CLIENT accepts”
- Independent oracle: Throwaway Ed25519 keys, forged/malformed/expired tokens, and real CLI activation/status/deactivation.
- Remaining unproven gap: SSO/SCIM and customer-controlled offline licence issuance/renewal remain unshipped; managed policy is proved separately and does not erase those gaps.
- Mandatory runner evidence: `complete-test-corpus`

#### `purchase-and-license-service`

- User surfaces: `server:checkout`, `server:webhook`, `server:resend`, `server:health`
- Exact executable evidence: `test/unit/server.test.mjs` — “ATTACK: forged signature, wrong secret, and tampered body are all refused”; `test/unit/server.test.mjs` — “ledger: a torn final line is COUNTED, never silently dropped”; `test/e2e/purchase-path.test.mjs` — “E2E CONCURRENCY: many simultaneous deliveries of one event mint exactly one license”
- Independent oracle: In-process HTTP server, raw webhook HMAC, throwaway signing key, append-only ledger, and mocked provider responses.
- Remaining unproven gap: Provider APIs are mocked in the repository suite; a deployed live Stripe/Resend purchase and support drill is still required. The source comments mention a billing portal, but no portal route ships.
- Mandatory runner evidence: `complete-test-corpus`

#### `pricing-and-public-claims`

- User surfaces: `site:pricing`, `readme:claims`
- Exact executable evidence: `test/unit/pricing-cta.test.mjs` — “free/core launch exposes one honest install path and no paid-tier checkout”; `test/unit/published-numbers.test.mjs` — “published numbers: test count is synchronized or explicitly withheld everywhere”; `test/unit/site-layout.test.mjs` — “site: anything legitimately wider than a phone scrolls inside its OWN container”
- Independent oracle: Static surfaces parsed against the free-only CTA, executable entitlements, and measured-number gates.
- Remaining unproven gap: Copy/CTA consistency does not prove buyer comprehension or adoption; paid checkout is intentionally outside this launch.
- Mandatory runner evidence: `complete-test-corpus`, `release-bodies`

### Setup and first-run experience

#### `setup-doctor-and-cli-contract`

- User surfaces: `cli:setup`, `cli:doctor`, `cli:help`, `cli:version`
- Exact executable evidence: `test/e2e/cli.test.mjs` — “CLI: every command is REACHABLE and exits 0”; `test/e2e/cli.test.mjs` — “FIRST RUN: a repo with no commits gets a one-line message, never a stack trace”; `test/unit/git-runtime-contract.test.mjs` — “runtime contract: selected Git is >=2.45 and implements --no-lazy-fetch”
- Independent oracle: Real subprocess exits/stdout/stderr across first-run repository states and live Git capability probes.
- Remaining unproven gap: Backend installation needs explicit consent and network; supported host setup still needs host trust/load verification.
- Mandatory runner evidence: `complete-test-corpus`, `git-runtime`, `host-manifest-sync`

#### `machine-output-and-analysis-scope`

- User surfaces: `option:--json`, `option:--include-primary`, `option:--all`, `option:--base`, `option:--family-window`
- Exact executable evidence: `test/e2e/cli.test.mjs` — “CLI: --json output is parseable for every command that claims it”; `test/e2e/cli.test.mjs` — “FIRST RUN: the solo-repo caveat — a dirty, unscanned primary is NAMED beside every all-clear”; `test/e2e/cli.test.mjs` — “CLI: a numeric flag is parsed and never silently coerced”
- Independent oracle: Subprocess JSON parsing, planted dirty-primary scope controls, and malformed/boundary numeric option cases.
- Remaining unproven gap: Parseable JSON is not a versioned schema guarantee for every nested field; consumers must pin a Holt version.
- Mandatory runner evidence: `complete-test-corpus`

## Cross-cutting release decision

Holt is ready to install and evaluate in its documented free-core scope. For broader confidence,
the open program is to produce zero-skip artifacts on every claimed OS; run the pinned 4/4
real-repository corpus and the monster/randomized oracles; retain a repeated agent A/B benchmark
with uncontaminated controls; drive any host promoted to “live”; install and audit the exact
candidate tarball; and complete real commercial and protected-release drills before those
capabilities are promoted. A bounded component result stays scoped to its recorded source, runtime,
platform and fixtures; it is not a claim that every future host or repository behaves identically.
