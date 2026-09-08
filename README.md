<div align="center">

<img src="docs/brand/holt-wordmark.png" alt="Holt, a product of Contrare Research" width="560">

# Holt

### See what your agents changed. Keep the work that matters.

**Find duplicate work, overlapping edits, dependencies, and changes that need preserving.
Built by a solo developer at Contrare Research.**

[![license](https://img.shields.io/badge/license-FSL%20core%20%7C%20commercial%20Team-blue)](#license)
[![release](https://img.shields.io/github/v/release/Raed2180416/holt?label=latest%20release)](https://github.com/Raed2180416/holt/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/Raed2180416/holt/ci.yml?branch=main&label=core%20CI)](https://github.com/Raed2180416/holt/actions/workflows/ci.yml)
[![docs](https://img.shields.io/badge/docs-site-blue)](https://raed2180416.github.io/holt/)

</div>

I built Holt after Claude Code duplicated work and deleted originals while I was working on a
large project. Keeping track of the agents had become its own job.

Holt brings their separate workspaces, called **Git worktrees**, into one local view. It helps you
see what changed, find repeated implementations and overlapping edits, review what depends on
what, and check what needs preserving before cleanup. You can use it from a terminal, inspect an
offline graph, or give your agents the same context through project integrations.

The useful question is what the agent should know **before its next action**. Is another
worktree already implementing the API it needs? Will a sibling change collide with this one?
Does a workspace still hold the only copy of a fix? Holt makes that cross-worktree state
inspectable and queryable, with separate evidence checks for preservation and cleanup.

This is a tool for the agent's workflow. The current release does not claim measured gains in
agent success rate, speed, or token use. Those need valid comparisons on real tasks.

## Try a read-only check

### See the result before using your own repository

[Run the disposable first-look fixture](https://github.com/Raed2180416/holt-first-look). It makes a
temporary Git repository with two sibling worktrees, then runs Holt in strict read-only mode. One
worktree has a reassuring name but holds modified, untracked, and ignored work; the other is empty.
Nothing in your own repository is changed, removed, or uploaded.

```bash
git clone https://github.com/Raed2180416/holt-first-look.git
cd holt-first-look
./try-holt.sh
```

### Check your own repository, read only

Open a terminal inside a repository with linked worktrees, then run:

```bash
npm exec --yes --loglevel=error --allow-remote=root --package=https://github.com/Raed2180416/holt/releases/latest/download/holt.tgz -- holt risk --strict-read-only --no-symbols --include-primary
```

Requires Node `^22.22.2 || ^24.15.0 || >=26.0.0` and Git 2.45 or newer. This downloads the official
release into npm's cache and runs the check without a global install. It does not change repository
files, hooks, or locks, and does not upload your code. `--allow-remote=root` permits this explicitly
requested URL package on npm 12 while keeping transitive URL dependencies blocked.

Look for **UNIQUE WORK**. Holt reports local work that needs attention across the main checkout
and its linked worktrees. This quick mode skips symbol analysis; committed comparisons can be
approximate, so it is a first look, not permission to delete anything. A repository with no linked
worktrees or no unsaved work may have little to show.

I'm Raed, the solo developer behind Holt at **Contrare Research**. I'm trying to find people this
actually helps. If you give it a try, [tell me how it went](https://github.com/Raed2180416/holt/issues/new?template=first_look.yml).
Honest opinions and criticism are welcome, including if it feels confusing or unnecessary.

[Website and demo](https://raed2180416.github.io/holt/) ·
[Disposable first look](https://github.com/Raed2180416/holt-first-look) ·
[Git worktree cleanup guide](https://raed2180416.github.io/holt/git-worktree-cleanup.html)

<!-- HOLT:SOCIAL-PROOF:BEGIN
Social proof stays commented out until the published 500-star gate is met and a reviewed change
enables it. scripts/milestone.mjs is report-only unless a maintainer deliberately runs --apply.

<div align="center">

[![stars](https://img.shields.io/github/stars/raed2180416/holt?style=for-the-badge&color=e2a154&labelColor=0a0b0d)](https://github.com/raed2180416/holt/stargazers)

<a href="https://star-history.com/#raed2180416/holt&Date">
  <img alt="Star history" width="600" src="https://api.star-history.com/svg?repos=raed2180416/holt&type=Date&theme=dark">
</a>

</div>
HOLT:SOCIAL-PROOF:END -->

> **Current status:** Get the latest published artifact and its checksums from
> [GitHub Releases](https://github.com/Raed2180416/holt/releases/latest). This source checkout
> may contain later, unreleased work; verify the version of the artifact you install.
> Team and Enterprise are not being sold or activated in this launch.

## The short version

Coding agents make parallel software work cheap. They also leave valuable state distributed
across commits, the index, unstaged edits, untracked files, ignored paths, branches, and linked
worktrees. Ordinary Git commands can inspect those pieces, but do not give one repository-wide
answer to the transaction question:

> **If this workspace is cleaned up or this change is landed now, what unique work could be lost or
> misintegrated, and what recovery path exists?**

Holt is the layer at that seam. It relates the real local state, separates exact evidence from
advisory intelligence, preserves work before a destructive action, re-checks the action boundary,
and emits a recovery receipt. It is complementary to Git, worktree managers, CI, editors, and
agent orchestrators; it is not a replacement for any of them.

The core loop is:

```text
observe → classify → protect → gate → act → verify/recover
```

[![Actual Holt TUI showing repository-wide worktree risk, unique-work evidence, and recovery guidance](docs/evidence/tui-graph/run-2026-08-05-final/controlled-tui-120x36.png)](docs/evidence/tui-graph/)

<sub>Actual <code>holt tui --snapshot</code> output from the real renderer against a controlled
real-Git fixture. The linked evidence packet contains the reproduction path and
checksum.</sub>

## Install for regular use

Holt currently requires Node `^22.22.2 || ^24.15.0 || >=26.0.0` and Git 2.45 or newer. Git 2.45
is the safety floor for the local-object checks Holt performs. The stable URL below installs the
latest version that has actually been published, which may differ from this checkout; verify
`holt --version`, the release notes, and the checksums for the exact artifact you install.

```bash
npm install -g https://github.com/Raed2180416/holt/releases/latest/download/holt.tgz --allow-remote=root
cd your-repository
holt --version
holt risk --strict-read-only --no-symbols --include-primary
```

After reviewing the first result, `holt setup` can configure supported project integrations and
`holt auto` can apply reversible protection. Those are optional next steps, not part of the first
read-only check. See [HOSTS.md](HOSTS.md) for the scope of each integration.

To replay the repository's smallest adversarial proof from source: one empty worktree with a
reassuring name beside a misleadingly named worktree holding modified, untracked, and ignored
content, run:

```bash
node scripts/run-preseed-demo.mjs --json
```

The demo creates an isolated temporary Git repository, exercises both `gate` exit-code contracts,
previews cleanup, applies quarantine only to the measured-empty worktree, inventories the recovery
copy, restores it, and independently checks its HEAD and byte digest. It removes its own restored
fixture after the proof; add `--keep` to inspect it.

`holt clean` is a dry run. `holt clean --apply` re-checks candidates immediately before moving
provably disposable worktrees into locked local quarantine; it does not delete files or branches
and returns the exact restore path. `holt purge` is a separately named, dry-run-first disk
reclamation action and requires an explicit apply step after review.

For a repository whose real landing branch is not the remote/default branch Holt detects, bind
that authority once in private Git-common state (not in a branch-controlled config file):

```bash
holt base                         # show the selected ref and why
holt base set origin/production   # persist an explicit, resolvable integration ref
holt base unset                   # return to conservative detection
```

`holt discard` is also dry-run capable and now records a durable transaction before moving any
selected path. If a process interruption or concurrent writer leaves work in physical quarantine,
list and resume it without re-selecting mutable pathnames:

```bash
holt recover-discard
holt recover-discard <transaction-id>
```

## What is available today

The current free/core boundary is local, Git-native, and single-repository. It does not require an
account, hosted code upload, telemetry, or a managed control plane.

| Job | Current surface | What the result means |
|---|---|---|
| See the repository-wide state | `status`, `risk`, `context`, TUI, offline relationship graph | A measured view of workstreams, unique content, collisions, duplicates, dependencies, and bounds. |
| Decide whether work is disposable | `gate`, `clean`, `protect`, `auto` | Exact path/content/reachability evidence can hold or permit an action. Unknown or unmeasured state stays unknown. |
| Preserve before acting | `rescue`, `discard`, `recover-discard`, `clean --apply`, `quarantines`, `restore` | Capture or quarantine is verified before release; interrupted state remains local and resumable. |
| Coordinate parallel work | `collisions`, `hotspots`, `duplicates`, `impact`, `order`, `partition`, `branches`, `stash`, `plan` | Relationship findings guide review and landing. They are not silently promoted into destructive authority. |
| Connect agents | Project-scoped MCP, `brief`, `integrate`, and host-specific hooks | Capability is reported per host as advisory, contract-tested, or live-observed; configuration on disk is not proof of a live deny. |
| Review incidents and provenance | `journal`, `forensics`, `audit` | Local receipts and package/runtime checks can be inspected offline on customer-controlled storage. |

The most important product rule is the boundary between proof and advice:

- Exact path, operation, mode, object type, object identity, and verified recovery evidence can
  influence destructive authority.
- Symbol overlap, clone similarity, dependency impact, family grouping, and landing order are
  useful review signals. They do not prove semantic equivalence or permission to delete.
- A failed instrument, an exceeded bound, or an unmeasured path lowers confidence. It does not
  become a clean-looking answer.

## A five-minute mental model

Imagine three agents working in linked Git worktrees:

```text
agent A: one local commit
agent B: staged edits plus an untracked migration
agent C: ignored generated output that is the only copy of a useful artifact
```

Branches alone do not describe that state. Holt builds a repository-wide evidence view, identifies
what is unique, and keeps a cleanup operation reversible:

```text
inspect → protect or rescue → re-check → quarantine → restore if needed
```

The same model applies before landing: show collisions, dependencies, and the evidence behind the
proposed order, then run the supplied combination test when a specific interaction needs empirical
verification. A clean supplied test means only that that test observed no combination-only failure;
it is not a universal compatibility certificate.

## Where Holt fits

| Existing tool or layer | Its job | Holt's boundary |
|---|---|---|
| Git and Git worktree | Version control and workspace primitives | Relate local state across worktrees before a lock, cleanup, or landing action. |
| Worktree managers | Create, move, and organize worktrees | Supply repository-wide content evidence and recovery-first disposition. |
| Agent orchestrators and editors | Dispatch and operate agents | Supply the transaction context and action seam; Holt does not choose the task or model. |
| CI and merge queues | Test and order committed changes | Protect valuable pre-PR state and investigate specific interactions before work is shared. |
| Hosted agent/cloud sandboxes | Run work away from a local machine | Local locks do not reach cloud or ephemeral agents by default; no cloud enforcement claim is made. |

**Holt is the local transaction and recoverability layer for parallel coding-agent work.**

## Integration coverage

`holt integrate` writes project-scoped files and preserves existing user configuration. Re-running it
repairs Holt-owned entries without duplicating them; `holt uninstall` removes only receipt-owned,
unchanged artifacts. Host configuration on disk is not evidence that a host loaded, trusted, or
enforced it.

- **MCP**: 18 tools in the executable schema, including live ownership and discard preview/recovery. The protocol
  path is exercised over stdio as `initialize → 18 tools → tools/call`; MCP remains reactive
  model-pull unless a host supplies a separate lifecycle context hook.
- **Implemented deterministic pre-tool blocking**: Claude Code, OpenCode, Cursor, Codex local clients, Qwen Code, Copilot CLI, Cline IDE, Goose, Devin CLI and Devin Desktop Cascade cover their documented local surfaces. Their current schemas are contract-tested, but none is currently claimed as a real-host enforcement run.
- **Hook-capable, not yet wired**: Gemini, Crush, Amp, Factory and Junie still receive MCP + advisory.
- **Cloud or ephemeral**: Codex cloud, Copilot cloud, Cursor cloud, Google Jules, Replit Agent do not receive local worktree enforcement by default.

### Structured local/MCP tools

A clean worktree can still belong to an agent that is thinking or preparing its next edit.
`holt ownership claim <id> --owner <session-id>` keeps that workspace out of cleanup and landing
plans until the session releases it. Renew with `heartbeat`, transfer with `handoff`, and finish
with `release`. [The ownership workflow](docs/LIVE-OWNERSHIP.md) explains expiry and recovery.

Codex project hooks use a broad `PreToolUse` matcher because MCP and other local functions are
part of the same host event stream. Holt never treats a convenient field such as `path` as proof
that a tool mutates the repository. Add exact contracts to `.holtrc.json` when a server's schema is
reviewed:

```json
{
  "toolContracts": [
    {
      "host": "codex",
      "tool": "mcp__filesystem__delete_file",
      "pathField": "path",
      "role": "delete",
      "kind": "filesystem delete"
    },
    {
      "host": "codex",
      "tool": "mcp__filesystem__read_file",
      "role": "ignore",
      "kind": "filesystem read"
    }
  ]
}
```

Tool names are exact (not regexes). `delete`, `overwrite`, and `move` feed Holt's existing
content-evidence gate; `ignore` is only for a reviewed read-only tool. An uncontracted Codex
structured tool is denied through Codex's fail-closed hook dialect by default. Repositories that
choose `"unknownToolPolicy": "audit"` explicitly accept an observable, journalled fail-open path;
that is an audit decision, not proof of mutation safety.

Holt describes nearly 30 distinct agent product surfaces, but support is deliberately split by
evidence grade. Current MCP/hook files for Cursor, Codex, Qwen Code, Copilot, Cline, Goose, Continue, Devin CLI, Cascade, Crush, Gemini CLI and VS Code are generated and parsed in schema fixtures. Gemini, Crush, Amp, Factory and Junie hooks are still unverified and unwired; their hosts remain MCP-capable rather than live-verified blockers. Run `holt providers`, `holt hosts`, and `holt doctor --json` for the machine-readable provider, configured-on-disk, trust, runtime, and live-proof boundaries.

## Evidence and limits

The repository contains deterministic unit, end-to-end, filesystem, Git, package, protocol, and
mutation checks for the shipped surface. It also records a CI matrix for the core safety and CLI
flows on Linux, macOS, and Windows. Read [the feature-proof matrix](docs/FEATURE-PROOF-MATRIX.md)
for the exact executable evidence, independent oracles, denominators, and remaining gaps.
No current test count or mutation score is published. A number becomes eligible only when the
complete, linked release and mutation evidence meets the repository's publication contract.



The full publication contract is in [BENCHMARKS.md](BENCHMARKS.md) and [eval/README.md](eval/README.md).
The security and data boundary is in [docs/SECURITY-QUESTIONNAIRE.md](docs/SECURITY-QUESTIONNAIRE.md);
`holt audit` provides an offline check of an installed package's declared capabilities and bytes.

### Important operational limits

- `rescue` and `discard` preserve captured bytes as ordinary unencrypted local Git objects under
  `refs/holt/*`. Holt does not classify those bytes as secrets. Use approved encrypted storage or
  whole-worktree quarantine when the Git object database is not an acceptable trust boundary.
- A local Git lock does not stop every filesystem path or every force override. Supported host
  hooks extend coverage, and their scope and failure modes are listed in [HOSTS.md](HOSTS.md).
- Ignored paths are included in destructive analysis, but Holt does not claim semantic understanding
  of ignored content. Unresolved ignored bytes keep a worktree out of the disposable set.
- Jujutsu is a different product boundary: auto-snapshots reduce the Git-specific “only uncommitted
  copy” problem, while collision, duplicate, order, and review-load signals remain useful.

## Try it in your own workflow

The free single-repository core is the current public offer. If you already use several local
worktrees, try the first check and [tell me how it went](https://github.com/Raed2180416/holt/issues/new?template=first_look.yml).
A short account of what helped, what was confusing, or why you do not need it is useful.

Team and Enterprise are not being sold or activated in this launch.

Holt is a product of [Contrare Research](https://github.com/Raed2180416). Product and research queries:
[research.contrare@outlook.com](mailto:research.contrare@outlook.com).

## Built on proven open source

Holt assembles mature instruments rather than asking teams to replace their stack:
[universal-ctags](https://github.com/universal-ctags/ctags) for measured symbols,
[enry](https://github.com/go-enry/go-enry) for content-based language resolution,
[jscpd](https://github.com/kucherenko/jscpd) for optional token-level clone detection,
`git merge-tree` for committed-delta evidence, and [jj](https://jj-vcs.dev/) as a first-class
backend. Optional backends have explicit degradation paths; absence never becomes deletion
authority.

## License

- The complete single-repository product is covered by **[FSL-1.1-MIT](LICENSE.md)**: free for
  every defined Permitted Purpose, including internal commercial use that is not a Competing Use.
- Each FSL-covered release converts to MIT on its own second anniversary.
- Team and Enterprise implementations under `src/team/` are source-available under their
  [commercial license](src/team/LICENSE). They are not part of the public free/core offer above.
