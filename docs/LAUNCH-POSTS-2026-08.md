# Holt launch posts — current founder set

Use these drafts after the release URL and site checks are green. Each one is written for its
community; do not paste the same opening into every subreddit, and do not ask for votes.

## Reddit — r/AgentsOfAI

**Title**

`I built Holt after a coding-agent project turned into a forest of worktrees`

**Post**

I hit a failure mode that felt very specific to coding agents.

I was using Claude Code on a complex project. I had several worktrees, several agents,
half-finished changes, and implementations being recreated because nobody had a reliable view of
what already existed elsewhere. I could not tell which work was unique, which was redundant, or
what would disappear if I cleaned up an old workspace. Eventually, starting over felt safer than
trusting the repository.

That is why I built Holt.

Holt is a local, Git-native integrity layer for parallel agent work. It relates the state that is
usually scattered across worktrees:

- commits and branches;
- staged and unstaged edits;
- untracked and relevant ignored files;
- overlapping symbols and dependencies;
- collisions, landing relationships and recovery state.

The useful distinction is between proof and advice. Exact content, paths, modes, object types and
durable recovery evidence can influence a destructive decision. Similarity, symbol overlap and
dependency findings help you decide what to inspect, but they never become silent permission to
delete.

The normal loop is:

```text
inspect → protect → recover or discard → re-check → clean
```

`holt clean` previews. `holt clean --apply` rechecks each candidate and moves verified-disposable
work into locked local quarantine instead of immediately deleting it, then gives you the exact
restore command. The same evidence is available through the CLI, a TUI, an interactive graph,
project-scoped MCP and supported host hooks.

Holt is not an orchestrator and does not pretend to launch a managed fleet of agents. It protects
and explains the repository state that your existing tools already create. That is the gap I could
not find another tool filling.

I used Holt while building Holt. The free core is local, has no account or hosted code upload, and
is source-available under FSL-1.1-MIT. The benchmark protocol is public and open to independent
counterexamples; I am not claiming a made-up percentage of saved time or tokens.

The next direction is deeper recovery capsules, external checkpoint providers, more host
conformance, team views and enterprise governance. Those priorities will follow real demand and
feedback.

Install/source: https://github.com/Raed2180416/holt

What is the nastiest failure mode you have seen when multiple agents share a repository?

*Holt is part of Contrare Research. Product and research queries: research.contrare@outlook.com.*

## Reddit — r/SideProject

**Title**

`I built a recovery-first layer for the mess parallel coding agents leave in Git`

**Post**

I started Holt after a Claude Code project got out of hand.

I had a complex project split across a growing pile of Git worktrees. Agents were redoing work,
changes were living in different places, and a workspace that looked disposable could still
contain the only copy of something useful. I had no dependable answer to “what am I about to
lose?” so restarting from zero felt safer.

Holt is my answer to that problem.

It gives a repository-wide view of committed, staged, unstaged, untracked and relevant ignored
work across linked worktrees. It shows what is unique, duplicated, conflicting, dependent or
still unverified.

The part I care about most is the cleanup boundary. Holt keeps exact recovery evidence separate
from useful-but-heuristic signals. Similar code can tell you where to look; it cannot authorize
deletion. `holt clean --apply` verifies a candidate immediately before moving it into locked local
quarantine and returns an exact restore command. Permanent purge is a separate, explicit decision.

There is also a CLI, TUI, interactive graph, project-scoped MCP and supported host hooks, so the
information can fit both a beginner’s workflow and an agent-heavy one. It is local and does not
require an account or uploading a repository.

I used Holt while building Holt. The free core is available now, source-available under FSL-1.1-MIT.
The public benchmark contract is there for people who want to challenge it on their own
repositories. I am deliberately not pretending a small pilot proves universal time or token
savings.

Team and Enterprise are future tracks, not part of this launch. The roadmap includes portable
recovery capsules, stronger external checkpoints, deeper host coverage and shared governance,
with priorities shaped by users.

Try it here: https://raed2180416.github.io/holt/

Source: https://github.com/Raed2180416/holt

If you use multiple worktrees, I would love one real cleanup or collision case that you think Holt
should handle.

*Holt is part of Contrare Research. Questions: research.contrare@outlook.com.*

## Hacker News

**Title**

`Show HN: Holt – recovery-first integrity for parallel coding-agent worktrees`

**Submission text / first comment**

I built Holt after a Claude Code project became a forest of worktrees.

I thought I had made massive progress, but agents were recreating parts of the project, changes
were split across several worktrees, and I could no longer answer a basic question: if I remove
this workspace now, what exactly does the project lose? Starting over felt safer than trusting
the repository.

Holt is a local Git-native layer for that pre-PR state. It relates the state ordinary Git commands
expose separately: committed and branch state; staged and unstaged edits; untracked and relevant
ignored paths; overlapping symbols and dependencies; and collisions, landing relationships and
recovery status.

The design has two evidence classes. Exact paths, bytes, modes, object types and durable Git
evidence can support deletion authority. Similarity, symbol overlap, dependency impact and
suggested landing order remain advisory. A heuristic can tell you where to inspect; it cannot
silently become permission to destroy work.

The operating loop is:

```text
holt status
holt protect
holt rescue or discard
holt clean
```

`holt clean` is a preview. `holt clean --apply` re-verifies each candidate and moves a
verified-disposable worktree into locked local quarantine rather than immediately deleting it.
Holt prints exact restore argv. Unknown or unverifiable work stays put.

The same evidence is available in the CLI, TUI, interactive graph, project-scoped MCP and
supported host hooks. The MCP and hooks are integration surfaces for supported flows, not a claim
that every agent host is automatically covered.

This is deliberately additive to existing tools. Git worktrees and vendor worktree features create
isolation. Worktree managers improve lifecycle ergonomics. PR queues handle already-committed work.
Holt is focused on the repository-wide destructive question before that work reaches a PR.

I used Holt while building Holt. The free core is local, has no account or hosted code upload, and
is source-available under FSL-1.1-MIT. The benchmark contract and evidence format are public so
people can test it against hostile cases. I am not publishing a universal “hours saved” or “tokens
saved” claim from a small pilot.

Future work is recovery capsules, external checkpoint providers, deeper host conformance, team
views and enterprise governance. Those are planned directions, subject to demand and feedback,
rather than features I am pretending are finished today.

Install/source: https://github.com/Raed2180416/holt

The most useful HN feedback would be a counterexample: a false safe, a false block, or a case where
the evidence arrived too late to matter.

*Holt is part of Contrare Research. Product and research queries: research.contrare@outlook.com.*

## Product Hunt

**Name**

`Holt`

**Tagline**

`Keep parallel coding-agent work visible and recoverable`

**Description**

Holt is a local, Git-native integrity layer for parallel coding-agent work.

It relates commits, staged edits, local files, ignored paths, conflicts and dependencies across
linked worktrees, then helps people and supported agent integrations decide what is unique,
redundant, conflicting, recoverable or safe to clean.

Cleanup is recovery-first: preview first, re-check immediately before acting, quarantine
verified-disposable work locally, and get an exact restore command.

Holt includes a CLI, TUI, interactive graph, project-scoped MCP and supported host hooks. It has
no account or hosted code upload.

Free core. Source-available under FSL-1.1-MIT.

**Maker note / first comment**

Hi Product Hunt. I built Holt after a Claude Code project became a bloated forest of worktrees.
Agents were duplicating work, useful changes were scattered across commits and local files, and I
could not tell what cleanup would actually remove. Starting over felt safer than trusting the
state I had.

Holt gives that repository state one decision surface.

What makes it different is the boundary between proof and advice. Exact content and recovery
evidence drive destructive decisions. Similarity, symbol overlap and dependency findings are
useful for coordination, but they never silently authorize deletion.

The free core is designed for both a beginner who wants `holt status` and an advanced workflow
using the TUI, graph, MCP and host hooks. I used Holt while building Holt.

I am launching the free core first. Portable recovery capsules, external checkpoints, deeper host
coverage, team views and enterprise governance are the next direction, shaped by demand and user
feedback. Team and Enterprise are not being presented as finished in this launch.

I would value a real counterexample more than a launch vote: a cleanup, collision or duplicated-
agent case that Holt should explain better.

Website: https://raed2180416.github.io/holt/  
Source: https://github.com/Raed2180416/holt

*Holt is part of Contrare Research. Questions: research.contrare@outlook.com.*

## DEV Community

**Title**

`Why parallel coding agents need a recovery-first Git layer`

**Tags**

`#ai #git #devtools #agents`

**Article**

I built Holt after a Claude Code project turned into a forest of Git worktrees.

The agents were not the only problem. The repository had become difficult to observe. One worktree
held commits, another held staged edits, another held an untracked file, and two agents were
independently changing related code. A branch name or file count was not evidence that a workspace
was disposable.

The question I needed answered was simple:

> If this worktree disappears now, what exactly does the project lose?

Git has all the ingredients, but not one repository-wide answer for that question. Git can inspect
a worktree, compare commits and remove paths. It does not automatically relate all in-flight state
across every linked worktree and then prove that a destructive action leaves a durable copy of
protected work.

That is the space Holt occupies.

### Proof and advice are separate

Holt treats exact recovery evidence differently from relationship intelligence.

Deletion authority can use exact paths, bytes, file types, modes, symlink targets and durable Git
objects. Similarity, symbol overlap, dependency impact and suggested landing order are still useful,
but they are advisory. They help a person or agent decide where to look; they do not become
permission to delete.

That distinction is important for agent workflows because a plausible explanation is not a recovery
proof.

### Recovery-first cleanup

The normal loop is:

```text
inspect → protect → recover or discard → re-check → clean
```

`holt clean` is a preview. `holt clean --apply` computes the candidate again immediately before
acting, then moves a verified-disposable worktree into locked local quarantine instead of
immediately deleting it. Holt returns the exact restore command. Unknown or unverifiable work stays
in place.

This is intentionally complementary to Git worktree managers and agent orchestrators. Those tools
create and coordinate workspaces. Holt explains the repository-wide state already created by them
and protects the boundary where cleanup can become irreversible.

### One evidence surface, several ways to use it

The core is local and Git-native. A beginner can start with:

```bash
holt setup
holt status
holt tui
```

Advanced users can inspect the interactive graph, use the project-scoped MCP surface, or connect
supported host hooks so useful repository context is available at the point where a decision is
being made. Support is documented by capability rather than flattened into “works everywhere.”

I used Holt while building Holt. The free core has no account or hosted code upload and is
source-available under FSL-1.1-MIT. The public benchmark contract is open for independent
evaluation. I am not claiming a universal percentage of saved time or tokens without a properly
controlled, reproducible campaign.

The next direction is positive and practical: portable recovery capsules, external checkpoint
providers, deeper host conformance, team workspaces and enterprise governance. The order is subject
to demand and user feedback.

Try the product: https://raed2180416.github.io/holt/  
Read the implementation: https://github.com/Raed2180416/holt

What invariant or failure case would you add to an adversarial benchmark for this kind of tool?

*Holt is part of Contrare Research. Product and research queries: research.contrare@outlook.com.*
