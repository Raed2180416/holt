# Provider adapters and compatibility evidence

Holt ships first-class Qwen Code and Antigravity adapters. It also ships read-only evidence and
conformance plans for Auggie and Kiro so contributors can add those providers without turning an
integration guess into a support claim. The public inventory is:

```bash
holt providers          # concise human status; read-only and works outside Git
holt providers --json   # exact capability, scope, proof, and limitation records
```

The machine-readable source is `src/integrate/provider-profiles.mjs`. Its strict schema keeps four
facts separate: what a provider documents, what Holt implements, what Holt has contract-tested,
and what has been observed in a current real host. In particular, neither adapter is described as
live-verified today.

## Install or inspect

Run these commands from a Git repository:

| Intent | Command | Scope |
| --- | --- | --- |
| Preview every path that would change | `holt integrate --dry-run` | Detected project clients |
| Install for clients detected in this repository or on this machine | `holt integrate` | Project plus linked worktrees |
| Prepare a shared repository/template for every supported local client | `holt integrate --all-hosts` | Project plus linked worktrees |
| Also merge MCP into detected, **existing** user config files | `holt integrate --global` | Project + user MCP |
| Prepare every supported client and also merge existing user MCP files | `holt integrate --all-hosts --global` | Project + user MCP |
| Remove only Holt-owned entries | `holt uninstall` | Project; add `--global` for user MCP |

Automatic mode avoids spraying configuration for tools a user does not have. `--all-hosts` is an
explicit opt-in for repository templates, onboarding, or a team using multiple clients. Project
files are created as needed. User config is deliberately existing-only: Holt will not fabricate a
new `~/.qwen/settings.json` or `~/.gemini/config/mcp_config.json` merely because `--global` was
passed. Qwen project hooks also require the folder to be trusted. Install Holt on `PATH` first so
the generated entries can invoke `holt`.

## What “useful” means here

An integration can help an agent in three materially different ways:

| Channel | Who initiates it? | What the agent receives | What it can honestly claim |
| --- | --- | --- | --- |
| Rules (`AGENTS.md`, native rule files) | Host/model discovery | Durable operating instructions | Advisory guidance |
| MCP | The model chooses a tool | Fresh, callable worktree evidence | Reactive, actionable context |
| Lifecycle hook | The host invokes Holt | Fresh context in the model's prompt | Proactive context, if observed live |
| Pre-tool hook | The host invokes Holt before execution | Allow/deny/ask result | Blocking only after live allow and deny proof |

MCP is useful, but it is **model-pull**. Registering an MCP server does not make Holt proactive.
Only a host-push lifecycle event can inject information before the model asks, and only a host-push
pre-tool event can refuse an operation before it runs. The profile validator rejects any MCP record
labelled as model context or host-push.

An allow result also needs special care. Some hosts interpret “allow” as “the policy hook has no
objection”; others may interpret it as “skip the user's normal permission prompt.” Holt must not
silently widen authority. Until that neutral/fall-through behaviour is proven on a real host, the
profile records `neutralAllowPreservesNativePermission: unknown` and cannot claim blocking.

## Evidence grades

The grade describes the maturity of a native Holt adapter, not how impressive the provider's own
feature list looks.

| Grade | Minimum meaning |
| --- | --- |
| `advisory` | A supported rules surface can explain when the agent should call Holt. |
| `configuration-ready` | Current primary docs identify native paths, schemas, and payload fields well enough to begin an adapter. No adapter or enforcement is implied. |
| `contract-verified` | The named Holt adapter surface is implemented and its applicable config, payload, merge, upgrade, and uninstall contracts pass. This is still not a real-host run. |
| `blocking` | A current real host discovered the adapter, allowed a safe operation without bypassing native permissions, denied a recoverable destructive decoy before execution, and passed failure injection. |

Schema validation enforces the last row. A profile cannot use `blocking` unless:

- `liveAllow`, `liveDeny`, and `failureInjection` all pass;
- the hook capability is `live-verified`;
- neutral allow is proven to preserve native permission handling; and
- no failure-matrix entry remains `unknown`.

No built-in provider profile currently meets that bar.

## Current provider profiles

| Profile | Current evidence | Holt status | Installed project surface | Honest remaining boundary |
| --- | --- | --- | --- | --- |
| Antigravity 2 | 2.5.0 | Implemented; `contract-verified`; **not live-verified** | Bounded `AGENTS.md`, reactive MCP, proactive `PreInvocation` context | Holt intentionally installs no `PreToolUse`: documented `allow` auto-approves and no neutral pass-through is proven. Native discovery/context and failure semantics remain live work. |
| Antigravity IDE | 2.1.1 | Implemented; `contract-verified`; **not live-verified** | Same adapter and explicit multi-workspace evidence | Same live gaps; a local CLI 1.1.8 plugin validation proved parsing only. |
| Antigravity CLI | 1.1.10 | Implemented; `contract-verified`; **not live-verified** | Same adapter with project `.agents` configuration | Same live gaps; no public runner source is claimed. |
| Qwen Code CLI | 0.21.5; source `32e2741…` | Implemented; `contract-verified`; **not live-verified** | Bounded `AGENTS.md`, reactive MCP, proactive `SessionStart`/`UserPromptSubmit`, and `PreToolUse` for canonical shell/write/edit IDs | No current Qwen process has yet provided native discovery, allow/deny, context-delivery, or failure-injection proof. Source-documented runner failures are fail-open. |
| Auggie CLI | 0.34.0 | Framework-only; unverified | Nothing provider-specific is installed | Evidence is configuration-ready, but JSONC-preserving install, payload variants, failure behaviour, and live proof remain. |
| Kiro IDE | Rolling; hook schema v1 | Framework-only; unverified | Nothing provider-specific is installed | Pre-tool stdin is insufficiently specified and official failure pages conflict. |
| Kiro CLI v3 | 3.0 early access | Framework-only; unverified | Nothing provider-specific is installed | Do not mix the CLI v2 schema; v3 payload and live failure behaviour remain unproved. |

For framework-only rows, `configuration-ready` describes provider evidence—not a hidden adapter.
`holt providers --json` returns null install commands and empty installed scopes for every such row.

## The provider-neutral record

Each profile contains the minimum information a user, adapter, and test suite need:

1. **Identity and version** — provider family, product surface, release channel, current version,
   locally observed version, compatibility labels, and pinned source commit where public.
2. **Primary evidence** — official documentation, release, or source URLs; fetch date; version or
   commit; and a narrow note saying what that source proves.
3. **Workspace discovery** — project/user markers, root selectors, single/multi-root model, trust,
   activation, and observed discovery proof.
4. **Rules** — paths, scopes, formats, activation, precedence, `AGENTS.md` support, merge strategy,
   and size constraints.
5. **MCP** — config paths, key, entry fields, transports, hot reload, trust, merge rules, secret
   handling, and the mandatory `model-pull` label.
6. **Hooks** — direct/plugin packaging, config targets, command runner, timeout, event/tool IDs,
   exact argument paths, verdict dialect, native-permission fall-through, lifecycle delivery, and
   evidence references.
7. **Failure matrix** — missing binary, spawn error, crash, exit 1, exit 2, timeout, invalid JSON,
   empty output, killed process, untrusted/disabled state, and headless `ask`.
8. **Proof ledger** — source review, config round-trip, native discovery, payload replay, live allow,
   live deny, failure injection, lifecycle context, MCP round-trip, upgrade/uninstall, subagents,
   and Linux/macOS/Windows runs.
9. **Ownership** — exactly which files Holt owns, how shared config is merged, how uninstall avoids
   foreign content, and how secrets remain untouched.
10. **Limitations** — unresolved facts stated as engineering work, never hidden in a broad support
    badge.

All values are JSON-serializable and built-ins are deeply frozen. Every evidence reference must
resolve to a source within its profile. Unknown keys, unknown enum values, non-HTTPS evidence URLs,
cycles, executable values, duplicate IDs, and incomplete failure matrices are rejected.

## Provider-specific contracts

### Antigravity family

Project MCP is `.agents/mcp_config.json`; user MCP is
`~/.gemini/config/mcp_config.json`. Both use `mcpServers`. Project hooks are
`.agents/hooks.json`; user hooks are `~/.gemini/config/hooks.json`. The plugin layout is
`.agents/plugins/holt/` (or `~/.gemini/config/plugins/holt/`) and can package both MCP and hooks.

Holt's shipped adapter uses the direct **project** files: it structurally merges the Holt MCP
server into `.agents/mcp_config.json` and a named Holt `PreInvocation` entry into
`.agents/hooks.json`. With `--global`, it additionally merges MCP into an existing user file; it
does not install user hooks or create a plugin bundle. Re-running reconciles the Holt entries, and
uninstall removes those entries while retaining foreign servers and hooks.

The installed `PreInvocation` hook is the proactive channel. It returns changed sibling-workstream
context in `injectSteps[].ephemeralMessage`, auto-protects at-risk workstreams on invocation zero,
and stays quiet when the relevant state has not changed. This behavior is contract-tested against
Holt's formatter and fixture repositories; it has not yet been observed in a current Antigravity
model trajectory.

Holt deliberately does **not** install `PreToolUse` for Antigravity. The documented envelope below
is retained as future adapter evidence, not as an active capability. It is camelCase and includes
`toolCall{name,args}`, `stepIdx`, `conversationId`, `workspacePaths`, `transcriptPath`, and
`artifactDirectoryPath`. It is not interchangeable with Claude-style snake_case:

| Tool | Relevant arguments |
| --- | --- |
| `run_command` | `toolCall.args.CommandLine`, `toolCall.args.Cwd` |
| `write_to_file` | `TargetFile`, `CodeContent`, `Overwrite` |
| `replace_file_content` | `TargetFile`, `TargetContent`, `ReplacementContent` |
| `multi_replace_file_content` | `TargetFile`, `ReplacementChunks` |

The documented verdict is a top-level `decision` of `allow`, `deny`, `ask`, or `force_ask`.
Critically, `allow` auto-approves execution and the docs do not define a neutral “Holt has no
objection; continue native permission handling” result. Installing a guessed guard could therefore
weaken native permissions or ask on every harmless operation. Crash, timeout, malformed-output,
and neutral behavior are also not precise enough to encode; they remain `unknown`.

The local command `agy plugin validate` accepted a minimal plugin under installed CLI 1.1.8 with
one MCP server and one hook. That proves only that the older validator recognized the bundle. It
does not prove the current release discovers it in a project, runs the hook, injects context, or
blocks a tool.

### Qwen Code

Project and user settings are `.qwen/settings.json` and `~/.qwen/settings.json`; hooks and
`mcpServers` share those files. Holt structurally merges project MCP plus `PreToolUse`,
`SessionStart`, and `UserPromptSubmit` entries. User scope adds MCP to an existing settings file;
hooks stay project-scoped. Re-run reconciles Holt-owned entries and uninstall retains foreign
settings. Project hooks require folder trust. Match canonical tool IDs:

| Tool | Relevant arguments |
| --- | --- |
| `run_shell_command` | `tool_input.command` |
| `write_file` | `tool_input.file_path`, `tool_input.content` |
| `edit` | `file_path`, `old_string`, `new_string`, `replace_all` |

Pinned upstream source at `32e27415779226b23174a3b0aa6c04e094f1aca2` shows exit 2 denies,
while spawn errors, ordinary crashes/nonzero outcomes, timeout, invalid JSON, empty output, and
killed commands proceed. That fail-open behaviour must be visible to users; source review does not
make it safe to call the implemented adapter live-verified or blocking. The installed
`SessionStart` and `UserPromptSubmit` hooks push changed sibling context without requiring an MCP
tool call; `SessionStart` also auto-protects at-risk workstreams. `Stop` is intentionally absent so
Holt does not create a continuation loop. A real Qwen 0.21.5 run still needs to prove native
discovery, lifecycle delivery, harmless allow, destructive deny, failure cases, and permission UX.
The untrusted-folder and hooks-disabled outcomes remain `unknown`; the profile does not treat a
configured file as evidence that Qwen loaded it.

### Auggie

Auggie has three JSONC scopes: `.augment/settings.json`, `.augment/settings.local.json`, and
`~/.augment/settings.json`. A real adapter must use a JSONC AST edit so comments, formatting,
foreign keys, and secrets survive. Both hooks and `mcpServers` live inside those shared files.

The documented tool IDs include `launch-process`, `str-replace-editor`, `save-file`, and
`remove-files`. The profile deliberately leaves `remove-files` without an argument mapping until a
current payload is captured; naming a tool is not proof of its field shape. Exit 2 blocks
`PreToolUse`; other nonzero exits warn and proceed. The documentation does not settle timeout,
malformed-output, kill, or every current `remove-files` payload variant.
An `ask` result has no native representation and must not become an allow; a future adapter should
map an unresolved destructive operation to deny with evidence for the user.

`SessionStart` stdout is a host-push model-context opportunity and must be tested with a unique
nonce. Seeing terminal output is not enough: the nonce has to be observed in the model context.

### Kiro

Rules live in `AGENTS.md` and `.kiro/steering/*.md`. MCP lives in
`.kiro/settings/mcp.json` (or `~/.kiro/settings/mcp.json`) and documents hot reload. Hooks are
individual `.kiro/hooks/<id>.json` files with `version: "v1"`, a `hooks` array, a trigger/matcher,
and a command action.

The current categories include `shell`, `write`, `@mcp`, `@builtin`, and `*`. Those categories are
not enough to build a destructive-operation gate: the current unified stdin envelope and concrete
argument paths need capture from the host. The newer hook overview says exit 2 blocks while other
nonzero exits warn and proceed; the older actions page says nonzero exits block. The profile follows
the newer exit-2 rule but records the conflict and leaves adjacent failure modes unknown.

CLI v3 is early access. A v3 adapter must not copy the older CLI v2 embedded configuration shape.
`SessionStart` and `UserPromptSubmit` stdout are candidate proactive context channels, still
requiring model-context observation and deduplication proof.

## Conformance plan

`buildConformancePlan(profileOrId)` turns a profile's proof ledger into ordered, JSON-serializable
work. It never upgrades a grade. A complete adapter run should cover:

1. strict schema and evidence-reference validation;
2. pinned current source/contract review;
3. isolated config generation, structural merge, parse, and applicable comment/foreign-key preservation;
4. native host discovery and trust/enablement confirmation;
5. golden safe/destructive payloads plus aliases, multi-root paths, Unicode, spaces, and malformed
   envelopes;
6. failure injection for every matrix row;
7. a real harmless allow that does not bypass native permission UX;
8. a recoverable destructive decoy denied before execution;
9. lifecycle nonce delivery into model context once, with silence when state is unchanged;
10. MCP discovery and a harmless tool call, reported separately as reactive;
11. upgrade and uninstall with foreign settings, comments, secrets, and rules unchanged;
12. subagent propagation or an explicit, user-visible boundary; and
13. supported-platform runs on Linux, macOS, and Windows.

The plan includes `blockedBy`, exact evidence references, current status, and all remaining required
step IDs. “Tests pass” is not an acceptance criterion unless the live host and version are named.

## Primary evidence snapshot

All links below were fetched on 2026-08-05. The machine-readable profile carries the date and
version/commit beside each individual record.

- Antigravity: [downloads](https://antigravity.google/download),
  [changelog](https://antigravity.google/changelog?tab=cli),
  [hooks](https://antigravity.google/docs/hooks),
  [MCP](https://antigravity.google/docs/mcp),
  [plugins](https://antigravity.google/docs/ide/plugins),
  [rules](https://antigravity.google/docs/ide-rules), and
  [migration/AGENTS.md](https://antigravity.google/docs/gcli-migration).
- Qwen Code: [hooks documentation at the pinned commit](https://github.com/QwenLM/qwen-code/blob/32e27415779226b23174a3b0aa6c04e094f1aca2/docs/users/features/hooks.md),
  [tool-hook source](https://github.com/QwenLM/qwen-code/blob/32e27415779226b23174a3b0aa6c04e094f1aca2/packages/core/src/core/toolHookTriggers.ts#L114-L219),
  [runner source](https://github.com/QwenLM/qwen-code/blob/32e27415779226b23174a3b0aa6c04e094f1aca2/packages/core/src/hooks/hookRunner.ts#L712-L838),
  [matcher source](https://github.com/QwenLM/qwen-code/blob/32e27415779226b23174a3b0aa6c04e094f1aca2/packages/core/src/hooks/hookPlanner.ts#L247-L278),
  [MCP](https://qwenlm.github.io/qwen-code-docs/en/users/features/mcp/), and
  [memory/rules](https://qwenlm.github.io/qwen-code-docs/en/users/features/memory/).
- Auggie: [configuration](https://docs.augmentcode.com/cli/config),
  [rules](https://docs.augmentcode.com/cli/rules),
  [integrations/MCP](https://docs.augmentcode.com/cli/integrations), and
  [hooks](https://docs.augmentcode.com/cli/hooks).
- Kiro: [CLI v3](https://kiro.dev/docs/cli/v3/),
  [hooks](https://kiro.dev/docs/hooks/),
  [hook types](https://kiro.dev/docs/hooks/types/),
  [older conflicting actions page](https://kiro.dev/docs/hooks/actions/),
  [MCP configuration](https://kiro.dev/docs/cli/mcp/configuration/), and
  [steering](https://kiro.dev/docs/cli/steering/).

When these products update, the right response is to refresh primary evidence and rerun the
conformance plan. A stale profile can guide investigation; it cannot justify a safety claim.
