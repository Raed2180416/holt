<div align="center">

# 🌳 holt

### Know what every agent changed. Coordinate it. Preserve it. Ship it.

**holt turns every worktree's commits, staged edits, local files and relationships into one shared<br>decision surface—so agents stop re-inspecting the same state, avoid duplicate work, land the right order,<br>and preserve anything unique before cleanup.**

[![symbols](https://img.shields.io/badge/symbols-ctags%20%2B%20measured%20compat-blue)](#built-on-proven-oss)
[![license](https://img.shields.io/badge/license-FSL%20core%20%7C%20commercial%20Team-blue)](#license)
[![docs](https://img.shields.io/badge/docs-site-blue)](https://raed2180416.github.io/holt/)

Requires a supported Node release (22, 24 or 26) and **Git 2.45 or newer**. Check with
`git --version`; Holt also probes the required `--no-lazy-fetch` capability and `holt doctor`
prints an upgrade diagnosis instead of attempting repository analysis on an older Git.

```bash
npm install -g https://github.com/Raed2180416/holt/releases/latest/download/holt.tgz
```

<sub>One command, no clone, no build — built, installed and driven against a real repository on
Linux, macOS and Windows by CI before that file is attached. No version is baked into that URL:
`releases/latest/download/` always resolves to the newest release, so the command never goes stale
and never has to be edited when one is cut.</sub>

<details>
<summary>Other install methods</summary>

**macOS (Homebrew):**
```bash
brew tap Raed2180416/holt https://github.com/Raed2180416/holt
brew install holt
```

**Windows (Scoop):**
```powershell
scoop bucket add holt https://github.com/Raed2180416/holt
scoop install holt
```

**One-off (no global install):**
```bash
npx github:Raed2180416/holt status
```

</details>

<!-- HOLT:SOCIAL-PROOF:BEGIN
Social proof stays commented out until the numbers can carry it: 500 stars, whichever lands
first. scripts/milestone.mjs switches this block on by itself.

<div align="center">

[![stars](https://img.shields.io/github/stars/raed2180416/holt?style=for-the-badge&color=e2a154&labelColor=0a0b0d)](https://github.com/raed2180416/holt/stargazers)
[![CI](https://img.shields.io/github/actions/workflow/status/raed2180416/holt/ci.yml?style=for-the-badge&labelColor=0a0b0d)](https://github.com/raed2180416/holt/actions/workflows/ci.yml)

<a href="https://star-history.com/#raed2180416/holt&Date">
  <img alt="Star history" width="600" src="https://api.star-history.com/svg?repos=raed2180416/holt&type=Date&theme=dark">
</a>

</div>
HOLT:SOCIAL-PROOF:END -->


</div>

---

## The 30-second story

Parallel agents leave work in commits, the index, the working tree, untracked files and ignored
paths. Git can inspect each worktree, but ordinary porcelain does not relate that complete
in-flight state across all worktrees and answer the destructive question: **if this worktree goes
away now, does the project lose the last durable copy of anything?**

holt builds that relationship before it authorises an action. Exact path, operation, mode, object
type and object ID evidence drives deletion authority. Symbol overlap, dependency impact, landing
order and partitioning are kept separate as advisory intelligence: useful for coordination, never
silently promoted into permission to destroy work.

The operating loop is deliberately concrete:

```text
inspect → protect → rescue or discard to a verified ref → re-check → clean
```

`holt clean` is a dry run until `--apply`, and even then it recomputes each candidate immediately
before moving the whole registered worktree into locked local quarantine. Unknown or unverifiable
work stays put. No files or branches are deleted, and exact restore argv is returned.

### Why it exists

I hit the problem while using Claude Code on a complex project. What looked like rapid progress
turned into a bloated forest of worktrees, recreated implementations, and unclear cleanup. I could
not tell which work was unique, which was a duplicate, or what was safe to remove, and restarting
felt safer than trusting the state I had.

Holt is built for that moment. It does **not** replace an agent orchestrator or decide what task an
agent should take. It reads the actual Git state that already exists across linked worktrees, gives
humans and agents one shared view of unique, duplicate, conflicting and dependent work, and makes
cleanup recoverable instead of irreversible.

---

## The gap holt fills

**Git ships the parts, not the repository-wide destructive verdict.** `merge-tree` compares
commits; Git's porcelain does not relate committed, staged, dirty, untracked and ignored-path state
across every linked worktree and then decide whether removal would discard the only known copy.
Holt builds that exact evidence separately from advisory symbol and dependency analysis.

| Tool | What it is good at | Where holt fits |
|---|---|---|
| [Git worktree](https://git-scm.com/docs/git-worktree.html) | Native creation, movement, locking and removal | holt relates content across the worktrees before using Git's lock or removal primitives |
| [Claude Code worktrees](https://code.claude.com/docs/en/worktrees) | Vendor-managed session isolation, subagent worktrees and cleanup | holt adds repository-wide evidence across work created by different clients |
| [Worktrunk](https://worktrunk.dev/faq/) | Worktree lifecycle, hooks, merge workflow, CI status and developer ergonomics | holt supplies content-based destructive authority; the products can be used together |
| [GitButler](https://docs.gitbutler.com/ai-agents/overview) | An alternative multi-branch workspace designed for parallel agent work | holt is additive for teams staying on native Git worktrees |
| [Graphite](https://graphite.com/docs/graphite-merge-queue) / [Mergify](https://docs.mergify.com/merge-queue/) | PR ordering, batching and CI after work is committed and shared | holt protects local work before push or PR |
| **holt** | Cross-worktree content evidence, fail-closed gates and verified capture/cleanup | It does not enforce cloud sandboxes by default or claim semantic knowledge of ignored content |

**In one sentence:** holt is the local in-flight work integrity layer for teams already running
parallel agents in Git worktrees. It complements worktree managers and merge queues by protecting
the state that exists before a pull request does.

---

**Benchmark methods and reproducible evaluation: [BENCHMARKS.md](BENCHMARKS.md).** Holt is ready
to install and use in real repositories today. The benchmark protocol is open for anyone to run
independently; any published result includes its complete, linked evidence artifact.

## Evidence, without turning a pilot into a promise

The repository includes adversarial evaluation fixtures in which names, commit counts and history
point in the wrong direction. Agents must preserve irreplaceable work, remove genuinely redundant
work and handle a duplicated pair where either copy may go but both may not. Grading reads the
resulting filesystem and Git state; agent self-report is not accepted as evidence.

Holt's deterministic feature, mutation, filesystem, Git, package and protocol suites cover the
shipped product surface. The retained six-trial agent run is a historical pilot and qualitative
failure corpus, not a rate or lift claim. The open evaluator requires 20 valid trials per treatment
before it publishes a comparative rate, and keeps a blocking host hook, instructions plus MCP, and
a Git lock as separate mechanisms rather than pooling them into a misleading number.

See [eval/README.md](eval/README.md) for the publication contract and [BENCHMARKS.md](BENCHMARKS.md)
for the artifact requirements used by scale, correctness and real-repository runs. The
[feature proof matrix](docs/FEATURE-PROOF-MATRIX.md) maps every shipped feature to executable
evidence, an independent oracle, and any remaining unproven boundary.

---

## What holt ships

The command surface is organised around a single job: make parallel local work understandable and
safe to act on.

| Feature family | Commands | Evidence boundary |
|---|---|---|
| **Exact destructive authority** | `status`, `risk`, `gate`, `clean` | Exact path, operation, mode, object type and object ID evidence decides whether removal is allowed. A failed instrument or unmeasured path produces `unverifiable`, not permission. |
| **Cross-worktree intelligence** | `collisions`, `hotspots`, `duplicates --deep`, `context`, `impact`, `plan` | Proven textual conflicts are distinguished from predicted same-file or symbol overlap. Duplicate and dependency results are review candidates, not destructive authority. |
| **Coordination** | `order`, `partition`, `branches`, `stash` | Order and partition are heuristic plans over the observed graph, not compatibility certificates or knowledge of the agents' tasks. Branch deletion uses `git branch -d`, never `-D`. |
| **Safe action loop** | `protect`, `auto`, `rescue`, `discard`, `clean`, `purge` | Rescue and discard capture to a verified ref first. `auto` performs reversible protection changes; `clean --apply` moves fresh-checked candidates into locked quarantine. The separately named, dry-run-first `purge` re-verifies a completed clean quarantine, anchors its exact HEAD, retains its branch, and uses non-forced Git removal to reclaim disk. |
| **Combination testing** | `verify A B --run "<test command>"` | Runs the supplied suite against A, B and A+B. A clean result means only that the supplied tests observed no combination-only failure. |
| **Evidence and incident review** | `journal`, `forensics` | The hash chain detects edits, deletion, reordering and truncation relative to its checkpoint. Actor attribution is reported, inferred or unknown; absent hook coverage is not guessed. |
| **Agent access** | `mcp`, `integrate`, `brief`, `hook`, `hosts`, `providers` | MCP exposes 16 decision-oriented tools: twelve read-only and four acting. Host and provider coverage is project-scoped and graded as blocking, MCP plus advisory, or advisory in [HOSTS.md](HOSTS.md) and [docs/PROVIDER-ADAPTERS.md](docs/PROVIDER-ADAPTERS.md). |

Ignored paths are included in the destructive decision. When holt cannot prove their bytes
reproducible, it refuses to call the worktree disposable. That is different from claiming semantic
understanding of ignored content.

---

## See the work without re-deriving it

The TUI is the basic-user view: risk-sorted workstreams, the exact unique work behind the selected
row, and the next preserving command. In the audited 10-worktree fixture it put the independently
planted 2/10 at-risk worktrees first and visibly separated a genuinely empty tree from a tree that
is safe only while its redundant twin survives.

![Risk-sorted Holt TUI](docs/evidence/tui-graph/run-2026-08-05-final/controlled-tui-120x36.png)

The graph is the advanced view: proven collisions are visible by default, optional duplicate and
family layers expose deeper coordination waste, and each node opens the evidence behind its
relationships. The exported HTML is a single offline file with search, filters, keyboard
navigation and no external resources. This is not a generic activity graph; every edge comes from
Holt's preservation, collision, duplication or ordering evidence.

![Offline Holt relationship graph](docs/evidence/tui-graph/run-2026-08-05-final/controlled-graph-default.png)

The complete hands-on audit includes the ground-truth oracle, 80- and 120-column terminal captures,
live Grove captures, browser interaction observations, defects found and their regressions:
[TUI and relationship-graph evidence](docs/evidence/tui-graph/README.md).

---

## Protection without depending on model judgement

Instructions and MCP context help an agent choose well; they are not an enforcement boundary. For
local Git worktrees, holt can apply Git's own lock from its content verdict:

```console
$ holt protect
$ git worktree remove --force wt/task-scratch-03
fatal: cannot remove a locked working tree, lock reason: holt: holds work found
nowhere else (e.g. callable:acquire_token_budget). Run 'holt rescue task-scratch-03'
to preserve it, or 'holt risk' to inspect.
```

That lock does not require a particular agent integration: **Git prints holt's reason** to a local
caller that uses `git worktree remove --force`. Host hooks extend the boundary to supported shell
commands such as filesystem deletion and explicit unlock. Codex also covers exact `apply_patch`
deletes/risky moves, and Claude covers exact Write/whole-file Edit replacements; per-host scope
and failure modes are listed separately in [HOSTS.md](HOSTS.md).

And because a gate that only refuses gets switched off:

```console
$ holt rescue task-scratch-03 --release   # verified capture → refs/holt/rescue/<id> → unlock
$ holt clean --apply                      # re-check, then quarantine disposable worktrees
$ holt quarantines                        # list recovery copies by their original worktree id
$ holt restore task-scratch-03            # restore without overwriting or weakening an older lock
```

`rescue` **exits non-zero if the capture cannot be verified** — so
`holt rescue X --release && git worktree remove X` stops before destroying anything. `clean`
re-checks every worktree immediately before an atomic same-filesystem move; a verdict computed
seconds ago cannot authorise even that move now. The result names the quarantine path and exact
recovery argv, while `quarantines` and `restore` provide the same route as first-class CLI and MCP
operations. Restore refuses an occupied destination, releases only a transit lock Holt acquired,
and preserves a protection lock that existed before quarantine. The worktree remains registered,
locked and branch-reachable until restored.
This clears it from Holt's active set but deliberately does **not** reclaim its disk space.

**And a gate that only refuses gets switched off.** `holt discard <path>` is the escape hatch, and it
is deliberately not a bypass: it captures the content to a verified ref *first*, then removes it —
so the guard stays on and the loss does not. A capture that cannot be verified aborts having
deleted nothing. A tracked file is *reverted* to HEAD rather than deleted, because that is what
"throw away my edits" means, and `git checkout -- <path>` is itself refused. It is journalled, and
it prints the command that brings the content back.

**Secret boundary:** `rescue` and `discard` preserve captured bytes—including untracked or ignored
bytes that could contain credentials—as ordinary **unencrypted local Git objects** reachable from
`refs/holt/*`. Holt does not classify those bytes as secrets and does not push the refs, but a
backup, mirror, or tool that copies `.git` can copy them. Use whole-worktree quarantine instead, or
move secrets through your approved encrypted secret-storage process, when the repository object
database is not an acceptable trust boundary. Removing a ref is not immediate erasure: unreachable
objects remain until Git garbage collection.

The command guard recognises supported Windows forms too: `Remove-Item -Recurse -Force`, `rd /s
/q`, `del /f /q`, `Move-Item`, `Clear-Content` and `Set-Content`. On Windows, a configured host
hook is the layer that can refuse a filesystem delete before it runs.

**Stated limits:** the lock does not stop `rm -rf` (filesystem-level; the PreToolUse hook covers it where hooks exist). `git worktree unlock` and `remove -f -f` defeat it — both are classified destructive and denied by the hook layer, with the same evidence-bearing message. And a pre-execution check cannot see through shell indirection — `$(echo rm)`, a variable-supplied verb, `eval` — so holt does not pretend it can: it returns **ask**, never a silent allow, for a command whose verb it could not read.

---


## One command to integrate everything

```console
$ holt integrate
```

- **AGENTS.md** — the cross-tool standard the widest set of agents read, written as an idempotent fenced block that **preserves an existing AGENTS.md verbatim** (it is a common file — holt never overwrites it, only refreshes its own `<!-- BEGIN holt -->` region).
- **MCP** — 16 tools in the executable schema: twelve read-only and four acting. By default only
  clients detected in the repository or on this machine receive config; `--all-hosts` explicitly
  prepares every supported project client for a mixed-client team. Config-shape tests are not
  mislabelled as real-host executions. `holt_clean` is mutating but non-destructive because it
  retains the registered worktree, branch and recovery argv; separately permissioned
  `holt_purge` is honestly marked destructive and remains a dry run until `apply:true`.
- **Hooks** — project-scoped shell guards for Claude Code, OpenCode, Cursor, Codex, Qwen Code, Copilot CLI, Cline IDE, Goose, Devin CLI and Devin Desktop Cascade, plus a git pre-commit warning as the floor. Codex's same pre-tool hook assesses exact `apply_patch` Delete File/risky-move operations; Claude and Qwen assess their documented full-write and measured whole-file Edit/edit contracts while leaving incremental edits silent. Arbitrary local-function and MCP arguments stay outside that native-file boundary because their schemas are tool/server-specific. Each host gets its own payload and deny schema; fail-open/time-out limits are stated per row in `holt hosts`. Claude Code, Codex and Qwen also get documented `SessionStart` and `UserPromptSubmit` context hooks: session start auto-protects at-risk siblings before the first tool call, while prompt submit injects a brief only when actionable sibling state changed. Claude Stop is deliberately absent because its context feedback continues the conversation instead of remaining a passive advisory; Cursor Stop uses a completed-only, one-loop-bounded `followup_message`, likewise an automatic follow-up prompt rather than passive context. OpenCode's stable plugin keeps the shell gate but emits no `session.created` console pseudo-context.
- Project-scoped by default. Your `~/.config` is never touched, never created.

### Honest coverage — run `holt hosts` to see it per agent

holt knows nearly 30 distinct agent product surfaces and tells you exactly what protection each gets, because "works everywhere" would be a lie:

`holt providers` is the provider-neutral compatibility inventory. It separates documented,
implemented, contract-tested and live-observed evidence for every surface. Qwen Code and
Antigravity have project-scoped contract-verified adapters; neither is labelled live-verified.
Antigravity receives proactive `PreInvocation` context but no guessed `PreToolUse` gate because its
documented `allow` can auto-approve execution and no neutral pass-through has been proven. Auggie
and Kiro remain framework-only with null install commands. The exact contracts and conformance
work are in [docs/PROVIDER-ADAPTERS.md](docs/PROVIDER-ADAPTERS.md).

`holt doctor` checks activation separately from capability. For every detected host it reports the
static-advisory, project-hook and project-MCP files independently, including whether each file
actually contains a Holt command. A file marked `configured-on-disk` is **not** reported as loaded,
trusted or exercised: those states remain `unknown`, and `liveProof` remains `false` until durable
local execution evidence exists. Machine consumers should use `activationIntegrity` in
`holt doctor --json`; `unwiredWorktrees` remains as a compatibility array and is explicitly not a
runtime or enforcement verdict.

- **Implemented deterministic pre-tool blocking:** Claude Code, OpenCode, Cursor, Codex local clients, Qwen Code, Copilot CLI, Cline IDE, Goose, Devin CLI and Devin Desktop Cascade cover their named shell surface; Claude and Qwen additionally cover documented full-write/measured whole-file-edit replacement, while Codex covers documented `apply_patch` deletion/risky moves. Their current schemas are contract-tested, but none is currently claimed as a real-host enforcement run. Cursor, Qwen, Goose, Cline and Cascade explicitly fail open when their hook runner fails; Copilot timeouts fail open; Codex project hooks require review and trust through `/hooks`. Holt follows the current [Codex hook contract](https://learn.chatgpt.com/docs/hooks) and [Qwen Code hook contract](https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks/): `PreToolUse` retains the named denial boundary, while `SessionStart` and `UserPromptSubmit` contribute proactive context rather than pretending MCP will be called automatically. `holt hosts` carries those limits instead of flattening every hook into the same promise.
- **Lifecycle output follows the host, not a generic “injection” claim:** [Claude's current hook reference](https://code.claude.com/docs/en/hooks) documents Stop `additionalContext` as feedback that continues the conversation under the same loop protections as `decision:"block"`, so Holt does not present it as a quiet advisory. [Cursor's official Stop example](https://cursor.com/blog/agent-best-practices#example-long-running-agent-loop) consumes `followup_message` as another loop, so Holt permits one only for a changed brief on the original completed loop. [OpenCode's stable plugin API](https://dev.opencode.ai/docs/plugins/) documents events and logging but no model-context hook; terminal logging is therefore not presented as context delivery. [OpenCode V2](https://opencode.ai/v2/docs/build/plugins) does document a real pre-dispatch context hook, but marks the entire API beta, with a different plugin shape; Holt does not mix that contract into its stable 1.x adapter. These paths are execution-level contract tests, not claimed live-host model runs.
- **Hook-capable, not yet wired:** Gemini, Crush, Amp, Factory and Junie still receive MCP + advisory. holt ships no guessed hook format.
- **MCP + advisory:** supported MCP clients receive a project-scoped server entry; hosts that read
  AGENTS.md also receive the bounded operating guidance. Either surface remains advisory unless a
  blocking hook is listed.
- **The local Git floor:** a worktree lock covers `git worktree remove --force`, and a pre-commit
  hook reports project risk. Filesystem deletion, explicit unlock and double-force removal require
  a configured blocking host hook.
- **Cloud/ephemeral agents (Codex cloud, Copilot cloud, Cursor cloud, Google Jules, Replit Agent) — stated plainly:** the local worktree lock does **not** apply there. A repository hook file is not enforcement unless the sandbox also provisions and runs holt; the default cloud rows remain advisory. See [HOSTS.md](HOSTS.md).

---

## Built on proven OSS — with thanks

Holt assembles instruments rather than reinventing them:
[universal-ctags](https://github.com/universal-ctags/ctags) for symbols, with parser probes and
compatibility definitions loaded only for gaps demonstrated on the installed build;
[enry](https://github.com/go-enry/go-enry) for content-based resolution of ambiguous extensions
such as F# versus Forth; [jscpd](https://github.com/kucherenko/jscpd) for optional token-level clone
detection; `git merge-tree` for committed-delta evidence; and
[jj](https://github.com/jj-vcs/jj) as a first-class backend. Symbol findings remain advisory, and
`holt doctor` names backend absence or parser gaps instead of converting them into deletion
authority.

Optional analysis backends have named degradation paths: `holt doctor` shows what is present and
what an absence changes.

Thank you to the maintainers and contributors behind these projects. Holt deliberately builds on
their proven primitives rather than asking teams to replace the tools and repositories they already
trust.

---

## The test suite attacks itself

The interesting checks are the hostile ones. **No current test count or mutation score is
published.** A figure becomes eligible only from a complete green release-suite run and a
complete mutation run with no survivors.

- **Mutation testing.** `test/mutation.mjs` breaks high-stakes behaviours on purpose — a classifier
  authorising everything, rescue skipping verification, clean deleting on stale evidence and
  redundancy ignoring durability — and requires the relevant tests to fail. Mutations run in a
  disposable repository copy, with a tripwire over the live tree.
- **Adversarial state and command fixtures** exercise commit-only deletion, renames, reverts,
  mutation during a scan, stale-cache authorisation, joint deletion of redundant twins and
  disguised destructive commands.
- **The CLI is tested as a binary**, with exit codes asserted per command.
- **The eval polices itself.** It refuses to score trials the agent never ran, and its answer key is proven unreachable from trial repos.
- Byte-for-byte proof that scanning changes nothing; jj op-log proven unchanged; read-only vs MUTATE tiers with mutation unreachable without explicit opt-in — `reset --hard`, `push`, `stash` refused even *with* it.

---

## Exercised, and not yet exercised end to end

This table separates protocol and automated evidence from gaps that still require a real host or
long-running environment.

**Exercised in automated, filesystem or protocol tests**

| Surface | How it was verified |
|---|---|
| Core scan, safety, actions, CLI | Unit, end-to-end, invariant and mutation suites run the classifier and destructive actions against disposable repositories |
| Linux / macOS / Windows core | CI matrix runs the safety classifier, detection, CLI-as-binary, actions and the invariant fuzzer on all three |
| MCP protocol | Live over real stdio: initialize → 16 tools → `tools/call` returning correct data, including reversible quarantine/restore and separately annotated destructive purge |
| Host config contracts | Current MCP/hook files for Cursor, Codex, Qwen Code, Copilot, Cline, Goose, Continue, Devin CLI, Cascade, Crush, Gemini CLI and VS Code are generated and parsed in schema fixtures; Codex `apply_patch`, Claude Write/full-file Edit and Qwen `write_file`/full-file `edit` paths reach disposable Git repositories; `opencode debug config` confirms OpenCode discovery. These are automated contract/filesystem checks, not real-host deny runs. |
| Language extraction | 50 languages asserted by symbol name; the count is now derived from the *installed* ctags, never claimed blind |
| Purchase path | Socket-level tests cover signed webhook → licence → CLI activation and rejection of forged events |

**Should work, but not yet verified** — treat as unproven until it is:

| Surface | Why it should work | What is unproven |
|---|---|---|
| Claude Code, OpenCode, Cursor, Codex, Qwen Code, Copilot CLI, Cline IDE, Goose, Devin CLI, Cascade hooks | Current docs/source, generated files, payload extraction and host-specific output/exit channels are contract-tested; exact Claude/Codex/Qwen native-file paths also reach fresh repository evidence in automated E2E tests | No real host process was driven through a destructive call and observed refusing it; arbitrary MCP/local-function schemas and specialized opt-out paths are not covered; fail-open and trust limits are in [HOSTS.md](HOSTS.md) |
| Gemini, Crush, Amp, Factory and Junie hooks | Their hosts document deny-hook surfaces and holt provides MCP/advisory coverage | Bespoke deterministic adapters are not wired yet |
| jj (Jujutsu) backend | Implemented and unit-tested against a real jj repo | Not exercised across a long multi-workspace session |
| Windows *end-to-end* agent flows | The core suite passes on Windows in CI | Hooks + MCP under Windows agent hosts are untested by us |
| Very large repos (10k+ files, 200+ worktrees) | The real-repository harness records warmups, repeated runs, planted and graded denominators, source stability and an artifact checksum | Scale and latency depend on repository shape; run the open harness on your repository and inspect the named limits |
| git-LFS, submodules, sparse-checkout | holt reads git's own output, which handles these | No dedicated test fixture yet |

**Different on jj** — worth knowing before you adopt it there: Jujutsu auto-snapshots the working
copy, so "work that exists only as uncommitted changes" largely stops being a category. holt's
flagship value — *what you are about to lose* — is therefore mostly a **git**-specific value. On jj
what remains is duplicates, collisions, landing order and review-load reduction: still a real
product, but a different pitch, and this is stated openly rather than left for you to discover.

**Known boundaries:** cloud/ephemeral agents have no local worktree, so the local lock cannot reach
them by default — the per-host detail is in [HOSTS.md](HOSTS.md). holt enumerates ignored paths for
the destructive verdict, but it does not claim semantic analysis of ignored content; unresolved
ignored bytes keep a worktree out of the disposable set.

---

## Verify the runtime data boundary yourself — `holt audit`

Every dev tool says it doesn't phone home. holt ships the evidence, and it is the *customer* who
runs it, on the copy they installed, offline, with no repository and no account:

```console
$ holt audit
# prints this installation's version, file count and tree digest,
# then reports every integrity and capability check by name
```

`src/supply-chain.mjs` declares the package's in-process filesystem, process, evaluation and socket
capabilities, plus external binaries, environment reads and confirmed child-process network
paths. `holt audit` compares those declarations against the installed bytes and fails on an
undeclared primitive or a declaration with nothing behind it.

Exactly two shipped files can open a socket: the approved, pinned and hash-verified `ctags`
download behind setup, which you can skip, and explicit Enterprise `managed-policy sync` against
administrator-supplied credential-free TUF bases. Ordinary analysis, hooks, MCP, CI policy
evaluation, status and licensing stay offline. Separately, confirmed setup actions may invoke your
package manager or exact-versioned
`go install github.com/go-enry/go-enry/v2/cmd/enry@v2.9.6`; those child processes may use the network,
and the package-manager path may use `sudo` on Linux. Both appear in the audit ledger. Git network verbs are outside Holt's argv
allowlist, but repository/user-configured Git filters or hooks are not Holt-owned network calls and
are not covered by that statement.

Free on every tier, and deliberately so — asking a security reviewer to buy a licence before they
can check whether the tool is safe to buy is a closed loop.

**Three exact direct runtime dependencies:** the MCP SDK, strict JSONC parser, and TUF client that
power advertised product surfaces. Only the `jscpd` deep-clone backend is optional. Node 22.22.2+
(within Node 22), Node 24.15.0+, or Node 26+ and Git 2.45+ remain prerequisites. Git
2.45 is the safety floor because its documented `--no-lazy-fetch` / `GIT_NO_LAZY_FETCH` control
lets Holt refuse missing local objects instead of contacting a promisor remote during an evidence
read. See the official [git(1) documentation](https://git-scm.com/docs/git) and
[Git downloads](https://git-scm.com/downloads). The release
workflow is configured to generate CycloneDX 1.5 and SPDX 2.3 SBOMs and request SLSA v1.0 Build L2
provenance. Verify the assets and attestation on the specific release you download; workflow
configuration is not evidence that the run completed, and v0.3.0 did not ship those assets:
[SUPPLY-CHAIN.md](SUPPLY-CHAIN.md) · [security questionnaire](docs/SECURITY-QUESTIONNAIRE.md).

## Honest boundaries

- **P4 in general remains unsolved.** `verify` decides a *specific suspected pair* empirically; it does not certify compatibility, and the wording is asserted by test.
- **No universal scale or latency claim is published.** Synthetic and real-repository harnesses
  record repeated samples, planted/graded denominators and source stability. Results apply to the
  named corpus and runtime in their artifact; `--no-symbols` is available when symbol extraction
  is the dominant cost.
- **`holt audit` runs inside the package it audits.** It detects a substituted or modified package; it is not a defence against an attacker who already owns the machine. Pair it with `gh attestation verify`, which is signed outside the package.
- **SLSA Build L2, not L3.** L3 needs the build to run in a reusable workflow. It is on the list and it is not claimed.

### Published analysis bounds

The current analysis surface has six explicit work bounds. They are listed because a bound you cannot see is
indistinguishable from an answer — each one announces itself when it binds, and none of them
quietly shrinks a result.

| Limit | Value | What it bounds | What you see when it binds |
|---|---|---|---|
| Taggable file size | 2 MB | files handed to universal-ctags for symbol extraction | the file is named in `symbolsUnmeasuredFiles`, the row reads *"N file(s) holt could not read symbols from … 'uniq' is a floor, not a total"*, and `safeToDelete` will not call that worktree disposable on the strength of it |
| Text-scan size | 4 MB | files read whole for content identity | the same: named as unmeasured, never counted as empty |
| Stash entries scanned | 25 | how far `holt stash` walks the reflog | *"holt scanned only the first 25 stash entries — there are more"*, and the response carries `truncated: true` |
| Stash paths per entry | 400 | paths carried into the reachability walk | the entry is reported as checked-with-a-bound rather than clean |
| git call timeout | 30 s | any single git invocation | the call **throws** (`git … timed out after 30000ms`); callers record the instrument as failed, and a failed instrument is reported as `unknown` — e.g. `branches` returns *"instrument failed — refusing to classify; nothing here licenses a deletion"* |
| `partition --agents` | 256 | requested agent count | refused by name with exit 2, never silently clamped |

**The property that matters is not the numbers, it is the direction.** These paths are designed to fail
*closed*: when a bound binds, holt says so and lowers its own confidence. They do not let holt
answer from partial data as though the data were complete — which is the exact failure it exists to
prevent, and it would be no more acceptable in holt than in the tools it watches.

Display caps are separate: a shortened CLI list prints `… and N more`, and bounded MCP list
responses carry `returned` and `truncated`.

## Configuration

Optional, and most repositories will never need it. Drop a `.holtrc.json` in the repository root
(the **main** worktree — one config per project, not per worktree) to override two heuristics:

```json
{
  "familyOverrides": ["^(shard-\\d+)-.*$"],
  "maintenanceFloor": 8,
  "maintenanceRatio": 0.4
}
```

| Key | Type | Default | What it changes |
|---|---|---|---|
| `familyOverrides` | array of regex strings | `[]` | How worktree names are grouped into "the same dispatch" for sibling/duplicate reporting (`inferFamily` in `src/discover.mjs`), for a fan-out naming scheme holt's built-in patterns don't recognise. A match here is trusted directly (`familyRule: 'user-override'`), same as it always was for a caller that supplied it in code — this file is only a new way to reach that existing knob. |
| `maintenanceFloor` | non-negative integer | `5` | Minimum disposable-worktree count before `holt`'s agent brief nags about running `holt clean --apply`. |
| `maintenanceRatio` | number, `0`–`1` | `0.3` | Minimum disposable-fraction-of-total before the same nag fires. |
| `guardAllow` | array of regex strings | `[]` | **The human escape hatch for the guard.** Each entry approves ONE command. See below. |

No file, or a file with any subset of these keys, is fine. **An unparseable or invalid file is a
hard error** — `holt` exits 2 with the exact reason (bad JSON, unknown key, wrong type, invalid
regex) rather than silently falling back to defaults; a config you believe is active is never
quietly discarded. Nothing in this file can make a "safe to delete" verdict less accurate: the
first three keys tune display/nagging heuristics, never the content-identity comparison in
`src/analyze.mjs` that actually decides what counts as unique work. See `src/config.mjs`.

### Overruling the guard (`guardAllow`), and the break-glass

`guardAllow` is the one key that can overrule holt's evidence, so its scope is exactly the command
you read and nothing next to it:

```json
{ "guardAllow": ["^rm -rf (dist|build)$"] }
```

- **An entry must match one WHOLE command.** Matching is anchored for you, so `"rm -rf dist"` and
  `"^rm -rf dist$"` mean the same thing. It will not approve `rm -rf distant-relative`.
- **A compound command is approved only when every one of its commands is.** `rm -rf dist; rm -rf
  ../feature` needs an entry for the second half too. Comments and string literals approve nothing:
  `rm -rf ../feature # rm -rf dist` is the deletion, not the comment. This is the same rule Claude
  Code applies to its own `Bash(…)` permission rules.
- **An entry whose wildcard could span a command separator is declined**, loudly, with the rewrite —
  `.*`, `\S`, `[^…]`. Those approve commands nobody reviewed. Bound the wildcard instead:
  `^rm -rf dist/[\\w.-]+$`.
- **Every use is journalled and announced** to you in the session, so an entry you did not write is
  visible the first time it fires.

This is deliberately something holt never asks an agent to write on your behalf: `.holtrc.json` is
an ordinary in-repo file, and the tools that edit files are not guarded.

If a bug in holt makes the analyser **crash**, the break-glass is an **environment variable**, not a
config key — so it is out of reach of anything running inside the repository. Read what it does
precisely, because the distinction is the whole point: it lets a command through when holt could not
form a verdict at all. It does **not** overrule a verdict holt did form — a refusal stands with this
set (measured: exit 2 either way). The route past a refusal holt should not have made is a bounded
`guardAllow` entry, which is reviewed and journalled:

```console
$ HOLT_HOOK_FAIL_OPEN=1 claude     # a crashing analyser stops blocking you; refusals still stand
```

Please report anything that needs it: <https://github.com/Raed2180416/holt/issues>.

## Quick start

```console
$ npm install -g https://github.com/Raed2180416/holt/releases/latest/download/holt.tgz
$ cd your-repo
$ holt setup         # inspect backends and wire supported project-scoped integrations
$ holt auto          # locks what would be lost; tells you what needs a decision
```

`holt auto` is the autopilot, and the line it draws is deliberate:

- **It does everything that cannot lose data, by itself.** Locking a worktree that holds the only
  copy of something, and releasing a lock whose justification has expired, are both reversible —
  if holt is wrong, nothing is destroyed.
- **It never deletes.** `clean --apply` is gated on "provably disposable", then performs only a
  reversible quarantine move. Irreversible actions are handed to you with evidence and exact
  commands, never taken unilaterally.

The same actions are available through the acting MCP tools, so an integrated agent can preserve,
quarantine, restore and explicitly reclaim a verified clean quarantine through the evidence-
bearing path instead of falling back to an unchecked shell command.

```console
$ holt status        # the decision surface
$ holt clean --apply # move provably-disposable worktrees into locked local quarantine
$ holt quarantines   # list recovery copies by original identity
$ holt restore <id>  # restore one without overwriting or weakening prior protection
$ holt purge <id>    # preview disk reclamation; add --apply only after reviewing evidence
$ holt discard <path> # the escape hatch — captures to a verified ref, then removes
```


## Free is the complete single-repository product

> **Launch scope:** Team and Enterprise are not being sold or activated in this free/core launch.
> Their implementation remains in the repository for audit and future design-partner work, but
> there is no public paid price, checkout, service commitment, data-processing agreement, or
> identity-management offer today. The descriptions
> below document code scope and boundaries; they are not an availability promise.

The scanner, exact gate, coordination views, safe actions, MCP server, TUI, inline CI, local
journal and single-repository forensics are free under [FSL-1.1-MIT](LICENSE.md) for every defined
Permitted Purpose, including internal commercial use that is not a Competing Use. Files covered by
that licence convert to MIT two years after each release. The commercial Team and Enterprise
implementations under `src/team/` use a
[separate commercial licence](src/team/LICENSE); they do not inherit the FSL future-MIT grant.

Team adds exactly four cross-repository or centrally reviewed capabilities:

| Capability | Free | Team — per active repository, unlimited developers |
|---|---|---|
| Complete single-repository analysis and action surface | ✓ | ✓ |
| Project-scoped MCP, host adapters, TUI and inline CI | ✓ | ✓ |
| Hash-chained local journal, verification, one-shot export and single-repo forensics | ✓ | ✓ |
| Base-authoritative policy file (`policy-file`) | | ✓ |
| Fleet inventory and trusted-journal verification (`fleet`) | | ✓ |
| Cross-repository session correlation (`forensics-fleet`) | | ✓ |
| Cursor-tracked local file sink with rewrite detection (`audit-sink`) | | ✓ |

The policy loader treats the base branch as authoritative: a candidate change cannot weaken,
remove or self-approve the rules used to judge it. Fleet totals include only repositories whose
populated journals verify; missing or untrusted repositories are named instead of being folded into
a clean-looking aggregate. The audit sink is exactly-once during normal cursor progression and
at-least-once after a crash, with stable event IDs for downstream deduplication.

### Enterprise adds centrally authenticated, non-bypassable policy

Enterprise ships one concrete software surface: `holt managed-policy enroll|sync|status|recover`.
On a single-purpose Linux runner, a root administrator enrolls a TUF trust root, an
administrator-asserted repository label and one persistent absolute workspace path. An explicit
`sync` authenticates signed metadata and policy, activates it crash-safely, and ordinary
unprivileged `holt ci` then evaluates that system policy offline. Centrally assigned rules are
additive to repository and user rules: a candidate branch cannot edit, ignore or replace the
authority judging it. A replacement at the enrolled path, a missing signed assignment, expiry,
partial activation, rollback or unverifiable authority refuses with an actionable status/recovery
receipt instead of silently dropping to weaker policy.

That is useful where the enterprise problem is “prove every repository was judged by policy the
repository could not weaken,” without sending code to a hosted control plane. It is not a generic
enterprise badge. **SSO and SCIM are not shipped.** Customer-controlled offline licence issuance,
signed removable-media policy updates, contractual support SLAs and an executed DPA are also not
presented as available features. Policy enforcement continues offline on the last authenticated
generation only while its signed validity window permits it; a customer-controlled local HTTP
mirror is supported for explicit sync. **GitHub-hosted/ephemeral fresh checkouts are not a supported
system-authority topology yet:** environment variables and Git remotes are not authenticated
identity, and Holt does not yet verify provider OIDC. The exact deployment commands, pass-through
boundary and threat model are in [the managed-policy administrator guide](docs/MANAGED-POLICY.md).
Once the fixed store contains a profile, any other workspace path and any additional system profile
refuse; shared multi-repository runners are intentionally unsupported rather than silently exempted.

The single-repository journal and timeline are free because they are your own data in your own Git
directory, and `holt journal --json` prints them directly. Team prices the relationship one
repository cannot compute: joining verified journals can surface that one session was refused in
repository A and completed a destructive action in repository B.

> An earlier version of this table listed a **webhook audit sink** as a paid feature. It does not
> exist — it is in `FEATURE_ROADMAP`, which grants nothing at any tier — and it has been removed
> from the table rather than left to imply otherwise. A test asserts every priced feature has a
> real `checkEntitlement` call site, so this cannot drift back.

**Why per-repo, not per-seat:** your risk scales with how many repositories have agents fanning
into worktrees, not with how many people you employ. A 3-dev team running 40 agent-repos carries
far more collision risk than a 50-dev team on 5 quiet ones — per-seat would charge them backwards.
Unlimited developers, with no seat minimum.

**Repository analysis, journal processing and licence verification remain local on every tier.**
Fleet scans repositories on your machine; the audit sink writes newline-delimited OCSF/ECS/CEF to
a file you control, which an existing log shipper may tail. holt does not send repository data or
telemetry. The separately approved setup/install paths may download a pinned tool or invoke your
package manager, as disclosed in [SUPPLY-CHAIN.md](SUPPLY-CHAIN.md).
## What comes next

The free, single-repository core is the product you can use today. The next stage builds from the
same evidence model: portable recovery capsules, optional encrypted external checkpoints with
restore testing, deeper live-host conformance, and a focused shared workspace for teams. Enterprise
identity, policy and lifecycle controls will be shaped with design partners before an enterprise
offer is made. The public [roadmap](https://raed2180416.github.io/holt/#roadmap) is direction, not
a calendar: real workflow failures and user feedback decide the order.

Team capabilities use locally verified, signed entitlements; they do not require a hosted code
upload, telemetry, or licence check-in. That future work will stay focused on shared workstream
integrity rather than becoming a generic project-management dashboard.

---

## License

Holt has an explicit two-part licence boundary:

- The complete single-repository product is covered by **[FSL-1.1-MIT](LICENSE.md)**: free for
  every defined Permitted Purpose, including internal commercial use that is not a Competing Use.
  Its competing-use restriction applies to making Holt or substantially similar functionality
  available as a competing commercial product or service; read the licence for the exact boundary.
- Each FSL-covered release converts to MIT on its own second anniversary.
- The Team and Enterprise implementations under `src/team/` are source-available under their
  [commercial licence](src/team/LICENSE). They require the corresponding paid entitlement for work use, may
  not be redistributed and do not carry the FSL future-MIT grant.

**holt™** is part of **Contrare Research**. For product and research queries, email
[research.contrare@outlook.com](mailto:research.contrare@outlook.com).

© 2026 Contrare
