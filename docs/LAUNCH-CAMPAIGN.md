# Holt free/core launch campaign

This is publication copy for the free single-repository product. Publish it after the exact release
artifact and links below are public, and when the maintainer can stay present to answer replies.
Team and Enterprise are not part of this launch.

The copy intentionally makes no adoption, time-saved, token-saved, or universal-host claim. The
free core is **free and source-available under FSL-1.1-MIT**, not presently OSI open source. Do not
replace that wording with "open source" unless the licence actually changes.

Canonical links:

- Product and install docs: https://raed2180416.github.io/holt/
- Source: https://github.com/Raed2180416/holt
- Benchmark contract and evidence: https://github.com/Raed2180416/holt/blob/main/BENCHMARKS.md
- Host capability matrix: https://github.com/Raed2180416/holt/blob/main/HOSTS.md
- Product and research queries: research.contrare@outlook.com

## Hacker News

Submit the GitHub repository URL with this title:

```text
Show HN: Holt – preserve in-flight work across parallel coding-agent worktrees
```

Post this as the first comment:

```text
I built Holt after a Claude Code project became a bloated forest of worktrees. I thought I had made
massive progress, but agents were recreating and duplicating work and I could no longer tell what
was unique or safe to clean up. Starting over felt safer than trusting the state I had.

Holt does not try to be an agent orchestrator or invent a task plan. It solves the repository-side
problem: it gives every human and agent one shared, evidence-backed view of the work that already
exists across linked Git worktrees before that work is duplicated, conflicted, or cleaned up.

One agent may have committed work. Another may have staged edits. A third may have the only copy of an untracked or ignored file. Two agents may have independently changed the same symbol. Git can inspect those pieces, but ordinary porcelain does not give one repository-wide answer to the destructive question: if this worktree disappears now, what is the project actually losing?

Holt builds that decision surface locally. It inventories committed, staged, unstaged, untracked and relevant ignored state across linked worktrees, then keeps two kinds of evidence separate:

- exact path, bytes, object type, mode and durable Git-object evidence can authorize a destructive action;
- symbol overlap, clone similarity, dependency impact and landing order stay advisory.

That separation matters. A heuristic can tell you where to look; it should not be allowed to delete work.

The normal loop is:

    npm install -g https://github.com/Raed2180416/holt/releases/latest/download/holt.tgz
    cd your-repo
    holt setup
    holt auto

`holt status` gives the cross-worktree view. `holt setup` can wire project-scoped MCP and supported host hooks. `holt tui` and `holt graph --html holt.html` expose the same evidence interactively. `holt clean` is only a preview; `holt clean --apply` rechecks each candidate and moves a disposable worktree into locked local quarantine instead of deleting it. It returns exact restore argv. Unknown stays put.

There is no account, hosted control plane, or code upload in the free core. Host support is graded in a public capability matrix rather than flattened into “works everywhere.” The core is free and source-available under FSL-1.1-MIT for its defined Permitted Purposes, including internal commercial use that is not a Competing Use, and each release converts to MIT after two years.

One important boundary: `rescue` and `discard` preserve captured bytes as unencrypted local Git objects under `refs/holt/*`. They are integrity captures, not encrypted secret backups. Whole-worktree quarantine avoids importing ignored secrets into Git objects.

I am also publishing an open adversarial benchmark contract and retained evidence, so teams can
independently evaluate Holt on their own repositories and agent hosts. I do not turn an incomplete
pilot into a made-up saved-hours or token-savings claim.

I would especially value hostile tests from people who use multiple worktrees: a case Holt allows but should block, a case it blocks but should allow, or a workflow where the information arrives too late to be useful.

Source and install: https://github.com/Raed2180416/holt

Holt is part of Contrare Research. Product and research queries: research.contrare@outlook.com
```

Do not ask anyone to upvote or comment. Be available in the thread for the rest of the day.

## Product Hunt

Use these exact submission fields:

```text
Name
Holt

Tagline
Keep parallel coding-agent work visible and recoverable

Description
Holt maps commits, staged edits, local files, conflicts and dependencies across Git worktrees. It warns agents before destructive actions, quarantines cleanup by default, and returns exact restore commands—locally, with no account.

Pricing
Free

Topics
Developer Tools
AI Coding Agents
Productivity
```

Use the website as the product URL. Use the final TUI screenshot and final graph screenshot as the
first two gallery images. A video is not required for this launch.

Post this first comment:

```text
Hi Product Hunt — I built Holt because parallel coding agents create a blind spot before code reaches a pull request.

Work can be spread across commits, the index, unstaged edits, untracked files, ignored paths and several Git worktrees. The risky question is not just “which branch is ahead?” It is “if this workspace is cleaned up now, does the project lose the last copy of anything?”

Holt gives humans and agents one local decision surface for that question. It can:

• show unique, redundant, conflicting and dependent work across worktrees;
• inject timely project context through supported hooks and expose 16 decision-oriented MCP tools;
• keep exact deletion authority separate from similarity and code-relationship heuristics;
• preview cleanup, then use locked local quarantine rather than immediate deletion;
• restore a quarantine with an exact command;
• show the same evidence through a CLI, TUI and interactive graph.

There is no account or hosted code upload. The free single-repository core is source-available under FSL-1.1-MIT for its defined Permitted Purposes, including internal commercial use that is not a Competing Use.

I am most interested in rigorous feedback: what real multi-agent or multi-worktree failure should Holt handle that it does not handle today? If it produces either a false “safe” or an annoying false block, please send me the smallest reproduction.
```

Do not ask for upvotes. Ask people to try it and leave technical feedback.

## Indie Hackers

```text
Title: I nearly lost the only copy of an agent's work, so I built a local integrity layer for Git worktrees

I have been using multiple coding agents in parallel, each in its own Git worktree. The speed is real, but so is a less obvious failure mode: Git branches are only part of the state.

One agent can have commits, another can have staged edits, another can have the only untracked file, and two can unknowingly implement overlapping work. By the time everything becomes a PR, the dangerous part may already have happened: a workspace was cleaned up because its name or branch looked disposable.

I built Holt to answer one concrete question before that action:

If this worktree disappears now, what exactly would the project lose?

Holt scans linked worktrees and relates committed, staged, unstaged, untracked and relevant ignored state. It separates exact evidence that may authorize cleanup from advisory evidence such as symbol overlap, clone similarity, dependency impact and landing order.

The cleanup design changed while I was testing it. `holt clean --apply` now moves a verified-disposable worktree into locked local quarantine and returns an exact restore command. Permanent reclamation is a separate explicit operation.

It also has project-scoped MCP, supported host hooks, a TUI and an interactive relationship graph, because a safety tool that only works when a human remembers to ask is not enough.

I am not launching the Team or Enterprise tiers today, and I am not publishing a “saved X hours” number from a tiny pilot. The free single-repository product is the launch. Its benchmark contract, host capability levels and known limits are public.

Install and source: https://github.com/Raed2180416/holt

I would love feedback from people actually running parallel agents or many worktrees. What is the nastiest real cleanup, collision or landing-order case you have seen? I would rather get a reproducible counterexample than a compliment.
```

## MLOps Community / Agentic AI Foundation

MLOps Community is now the official Agentic AI Foundation user group. Do not duplicate this in two
places and do not drop it into a general channel as an advertisement. Post it once in a coding-agent,
evaluation, reliability, or project-feedback channel after checking with the moderators.

```text
Technical feedback request: how should we prove a local integrity layer for parallel coding agents?

Disclosure: I build Holt. I am looking for adversarial practitioners, not launch votes.

The failure mode is local and pre-PR: several agents work in Git worktrees, while valuable state is split across commits, the index, unstaged edits, untracked files and ignored paths. A cleanup decision can remove the last useful copy before CI, a merge queue or repository policy ever sees it.

The design rule I am testing is:

Every action Holt authorizes must leave a durable recovery path for every protected content unit, while ordinary safe work must not be blocked.

The evaluator therefore needs both sides:

1. false-safe cases: unique bytes, path changes, modes, symlinks, concurrent writes, parent-directory removal and multi-target effects;
2. false-block cases: genuinely redundant work, already durable Git objects, generated-looking names that are not evidence, and commands unrelated to protected content;
3. delivery cases: did the agent receive useful context before the decision, through a real host hook or MCP call, or was the evidence merely available somewhere?

The benchmark grades filesystem and Git state rather than the agent's explanation, retains random seeds and artifacts, and keeps blocking hooks, instructions-plus-MCP and Git locks as separate treatments.

Method and current evidence contract: https://github.com/Raed2180416/holt/blob/main/BENCHMARKS.md
Source: https://github.com/Raed2180416/holt

What counterexample would you add before trusting this in a real agent workflow? I am especially interested in cases that distinguish useful intervention from safety theatre.
```

## MCP community

First publish Holt to the official MCP Registry. Use this exact registry description:

```text
Protect in-flight work across parallel coding-agent Git worktrees.
```

Do not advertise in the official MCP contributor Discord: its published guidance asks contributors
to keep discussion vendor-neutral and avoid service or product marketing. If an MCP community has
an explicit project-showcase channel, use this exact post there:

```text
Disclosure: I maintain Holt, a local integrity layer for parallel coding-agent Git worktrees.

I am sharing it here for feedback on one MCP design choice. Holt exposes twelve read-only evidence tools and four acting tools. The acting tools preserve, quarantine, restore or explicitly reclaim work, and destructive authority is kept separate from advisory similarity and dependency analysis.

MCP is model-pull, so Holt does not pretend the server is proactive by itself. On hosts with documented lifecycle or pre-tool hooks, project integration uses those hooks for timely context or blocking and uses MCP for the richer decision surface. The public host matrix says which path is live-verified, contract-tested, advisory or unsupported.

Registry listing: https://registry.modelcontextprotocol.io/?q=io.github.raed2180416%2Fholt
Source and schemas: https://github.com/Raed2180416/holt

I would value two kinds of feedback: are the read-versus-act boundaries discoverable enough for MCP clients, and which real client conformance case would you add before trusting the acting tools?
```

## Reddit: r/AgentsOfAI

This subreddit currently removes direct links in titles and post bodies. Submit this text post
without a URL.

```text
Title: I built a local integrity layer for parallel coding agents because branches were not the whole state

I kept running into a problem once I had several coding agents working in Git worktrees at the same time.

The obvious state is the branches. The dangerous state is everything around them: staged edits, unstaged edits, untracked files, ignored paths, and two agents independently changing the same part of the system.

That creates a question Git can help investigate but does not answer as one repository-wide verdict:

If this agent workspace disappears now, what exactly would the project lose?

So I built Holt. It relates the in-flight state across linked worktrees and gives the same evidence to a human through CLI/TUI/graph and to agents through project-scoped MCP plus supported host hooks.

The most important design rule is that heuristics do not authorize deletion. Symbol overlap, clone similarity, dependencies and landing order can recommend review. Destructive authority requires exact content and recovery evidence.

Cleanup is reversible by default: the apply step rechecks the candidate, moves the whole worktree into locked local quarantine, preserves its branch and returns exact restore argv. Unknown stays where it is.

I am launching only the free single-repository core, not a Team or Enterprise story. I also have not turned a small pilot into a fake “X% more productive” claim. The evaluator grades the resulting filesystem and Git state, including false blocks as defects.

I will put the source and install link in the first comment because direct links in post bodies are not allowed here.

For people running real agent swarms: what is the worst collision, accidental cleanup or duplicate-work case you have seen? I am looking for cases that break the model, not generic feature requests.
```

Immediately add this first comment:

```text
Disclosure: I built it.

Source and install: https://github.com/Raed2180416/holt
Host capability matrix: https://github.com/Raed2180416/holt/blob/main/HOSTS.md
Benchmark contract: https://github.com/Raed2180416/holt/blob/main/BENCHMARKS.md
```

## Reddit: r/devops

Post this only as a comment in the current Weekly Self Promotion Thread:

```text
Disclosure: I built Holt, a free local integrity and coordination tool for teams running coding agents in parallel Git worktrees.

The problem it targets happens before a PR or merge queue can help: important state may be split across commits, staged and unstaged edits, untracked files, ignored paths and several worktrees. A workspace can look disposable while holding the only useful copy of something.

Holt gives operators and agents one repository-wide view of unique, redundant, conflicting and dependent work. Exact content evidence drives cleanup authority; symbol/clone/dependency analysis stays advisory. `holt clean --apply` rechecks each candidate and moves it into locked local quarantine instead of deleting it, then returns exact restore argv.

It runs locally with no account or hosted code upload. There is a CLI, TUI, interactive graph, project-scoped MCP, supported host hooks, inline CI gate and a hash-chained local journal. Host enforcement levels and known gaps are published rather than hidden behind a generic compatibility claim.

Source and install: https://github.com/Raed2180416/holt

I would appreciate feedback from people operating many worktrees or coding agents: what would you need to see before allowing this in a real repository, and which failure case should be in the adversarial suite?
```

## Reddit: r/SideProject

Use the self-promotion/project flair if the submit form offers one.

```text
Title: I built a safety net for the uncommitted work left across parallel coding-agent worktrees

I am building Holt with the same multi-agent workflow it is meant to protect.

The problem showed up quickly: one agent's work was committed, another had staged edits, another had an untracked file, and ordinary branch names made the wrong workspace look safe to remove. The state I cared about was distributed across Git worktrees, but the cleanup decision was being made one directory at a time.

Holt creates a repository-wide decision surface before cleanup or landing. It shows unique, redundant, conflicting and dependent work; separates exact deletion evidence from advisory code similarity; and can give the result to agents through MCP and supported host hooks.

The feature I care about most is intentionally boring: cleanup is quarantine-first. `holt clean --apply` rechecks a disposable worktree, moves it into locked local quarantine, preserves the branch and returns the exact restore command. Permanent purge is separate.

There is also a terminal dashboard and an interactive graph because once several agents are active, a list of branches is a poor mental model of the work.

I am launching the free single-repository core only. It is local, needs no account, and is source-available under FSL-1.1-MIT for its defined Permitted Purposes, including internal commercial use that is not a Competing Use.

Source, screenshots and install: https://github.com/Raed2180416/holt

I would love blunt feedback on the first-run experience and the decision output. If you have a repository with several worktrees, does Holt tell you something useful quickly, or does it create noise?
```

## Peerlist Launchpad

Use these exact project fields:

```text
Project name
Holt

Tagline
Know what every coding agent changed before cleanup or landing

Project URL
https://raed2180416.github.io/holt/

Description
Parallel coding agents leave work across commits, staged and unstaged edits, untracked files, ignored paths and multiple Git worktrees. Holt turns that in-flight state into one local decision surface for humans and agents.

See which work is unique, redundant, conflicting or dependent. Keep exact deletion authority separate from advisory similarity and landing analysis. Wire project-scoped MCP and supported host hooks. Inspect the same evidence through a CLI, terminal dashboard or interactive graph.

Cleanup is reversible by default: Holt rechecks eligible worktrees, moves them into locked local quarantine, preserves their branches and returns exact restore commands. Unknown work stays put.

The free single-repository core requires no account or hosted code upload and is source-available under FSL-1.1-MIT.
```

Do not ask for upvotes in DMs, comments, or external posts. Ask for specific feedback.

## DEV Community technical article

```markdown
---
title: The destructive question Git worktrees do not answer for parallel coding agents
published: true
description: A practical model for protecting committed, staged, untracked and ignored work before an agent workspace is cleaned up.
tags: git, ai, devops, tooling
---

Running several coding agents in parallel changes the shape of a repository.

The obvious model is “one agent, one branch.” The real model is messier:

- one worktree has commits that have not been pushed;
- another has staged and unstaged edits;
- another contains the only copy of an untracked file;
- an ignored path may be a cache, a generated artifact, a local database, or a credential;
- two agents may have changed the same file for completely different reasons;
- a third agent may depend on code that has not landed anywhere yet.

Git gives us excellent primitives for inspecting each part. What ordinary porcelain does not give us is one repository-wide destructive verdict:

> If this worktree disappears now, which useful content units lose their last durable copy?

That distinction matters because the dangerous moment often happens before a pull request exists. CI, review rules and merge queues cannot protect state they never receive.

## A branch is not the complete unit of work

Consider three worktrees:

```text
agent-auth/       two local commits
agent-api/        staged edits plus one untracked migration
agent-tests/      unstaged tests that import agent-api's new symbol
```

A branch-only view says all three branches exist. It does not tell us that the migration exists only as an untracked file, that the tests depend on an unlanded symbol, or that removing `agent-api/` would destroy the only copy of a required path.

The first engineering lesson is simple:

> Inventory the state that can be lost, not just the refs that are easy to list.

For a Git worktree, that includes at least:

1. committed objects and their reachability;
2. index entries;
3. tracked working-tree bytes;
4. untracked paths;
5. policy-relevant ignored paths;
6. file type, mode and symlink target;
7. the worktree and branch identity needed to put it back.

## Proof and heuristics are different products

Once the inventory exists, it is tempting to use code similarity to decide whether a worktree is redundant. That is unsafe.

Two shell scripts with similar text can have different executable modes. Two templates can contain the same tokens at different paths and serve different roles. Two functions with the same name can implement different behavior. A renamed file can be content-identical while its path is the entire point of the change.

Similarity is still useful. It can identify duplicate effort, collision risk and review candidates. It simply belongs in a different evidence class.

I use this split:

**Deletion authority**

- exact path and operation;
- exact bytes or a durable Git object;
- file type and mode;
- symlink target;
- a verified recovery reference.

**Advisory intelligence**

- symbol overlap;
- token or clone similarity;
- dependency impact;
- likely landing order;
- work partitioning suggestions.

The invariant is that advisory evidence may request review but may not silently become permission to destroy work.

## Reversibility changes the cleanup design

“Safe to delete” is an unnecessarily strong first action. A safer workflow is:

```text
inspect -> recheck -> quarantine -> restore or explicitly purge
```

Quarantine buys three useful properties:

1. the default action remains reversible;
2. the user can verify that normal work continues before reclaiming disk;
3. an interrupted operation has a state that can be inspected and resumed.

The recheck immediately before mutation is important. A report can become stale between display and execution because another agent writes to the worktree. Authority must be based on the state at the action boundary, not on a screenshot from thirty seconds earlier.

## “Available to the agent” is not the same as “delivered in time”

An MCP server can expose excellent tools and still have no effect if the model never calls them.

MCP is model-pull. Proactive delivery requires a host surface such as a session, prompt or pre-tool hook. Those surfaces differ by client, version, action schema and failure behavior. Some can block a shell command. Some can inject context but cannot deny. Some fail open. Some require explicit trust.

That means a credible compatibility table needs grades such as:

- live enforced;
- contract-tested;
- observed but advisory;
- configuration only;
- unsupported.

“Supports thirty agents” is not useful if it hides those distinctions.

## Benchmark the result, not the explanation

An agent can confidently say it preserved everything while deleting the only useful file. The evaluator must inspect the resulting filesystem and Git graph.

A useful adversarial suite includes both false-safe and false-block cases:

- staged, unstaged, untracked and ignored state;
- duplicate content where either copy may go but both may not;
- paths with spaces, newlines and shell metacharacters;
- file-mode and symlink differences;
- concurrent writes between analysis and action;
- parent-directory and multi-target removal;
- interrupted capture and restoration;
- ordinary commands that should remain silent.

The last item matters. A guard that blocks everything can report perfect recall while being unusable. False positives train users to bypass the next warning.

The benchmark should retain its corpus, seed, exact tool version, exact artifact checksum and independent oracle. It should also keep different mechanisms separate: a blocking host hook, instructions plus MCP, and a Git lock do not measure the same intervention.

## The tool I built around this model

I built [Holt](https://github.com/Raed2180416/holt) to apply these ideas to parallel coding-agent worktrees.

It relates committed, staged, unstaged, untracked and relevant ignored state across a repository; exposes exact and advisory evidence separately; and presents the result through a CLI, terminal dashboard, interactive graph, project-scoped MCP and supported host hooks.

Its cleanup apply step rechecks each candidate and moves the complete worktree into locked local quarantine rather than deleting it. It preserves the branch and returns exact restore argv. Permanent reclamation is a separate explicit command.

The free single-repository core runs locally with no account or hosted code upload. It is source-available under FSL-1.1-MIT for its defined Permitted Purposes, including internal commercial use that is not a Competing Use. The [host capability matrix](https://github.com/Raed2180416/holt/blob/main/HOSTS.md) and [benchmark contract](https://github.com/Raed2180416/holt/blob/main/BENCHMARKS.md) are public.

The most useful response is a counterexample: a workflow the model misses, a false block that would make you disable it, or a host path that looks protected but is not. Those are the cases that make this category of tool trustworthy.
```

## X

Post this six-part thread. Do not add hashtags.

```text
1/ I built Holt because parallel coding agents create valuable local state before a PR exists—and branch names do not tell you whether a worktree is safe to remove.

Holt shows what is unique, duplicated, conflicting or dependent across Git worktrees.

2/ The state spans commits, the index, unstaged edits, untracked files and ignored paths.

The question is not “is this branch ahead?”

It is: “if this workspace disappears now, what exactly does the project lose?”

3/ Holt keeps exact deletion authority separate from heuristics.

Paths, bytes, modes, file types and durable Git objects can authorize an action.

Symbol overlap, clone similarity, dependency impact and landing order can only advise.

4/ Cleanup is reversible by default.

`holt clean --apply` rechecks the candidate, moves the whole worktree into locked local quarantine, preserves its branch and returns exact restore argv. Permanent purge is separate. Unknown stays put.

5/ Humans get CLI, TUI and an interactive graph. Agents get project-scoped MCP plus supported host hooks.

The host matrix says which paths are enforced, contract-tested, advisory or unsupported. MCP alone is reactive; Holt does not market it as magic proactivity.

6/ The free single-repository core is local, needs no account, and is source-available under FSL-1.1-MIT.

I want hostile real-world cases more than applause: false-safe, false-block, collision or cleanup reproductions.

https://github.com/Raed2180416/holt
```

## LinkedIn

```text
Parallel coding agents create a new kind of pre-PR risk.

The work is not only in branches. It is spread across commits, staged and unstaged edits, untracked files, ignored paths and multiple Git worktrees. A workspace can look disposable while holding the only useful copy of something.

I built Holt to answer one concrete question before cleanup or landing:

If this worktree disappears now, what exactly would the project lose?

Holt turns the repository's in-flight work into one local decision surface for humans and agents:

• unique, redundant, conflicting and dependent work across worktrees;
• exact content evidence separated from advisory symbol, clone and dependency analysis;
• project-scoped MCP and supported host hooks;
• CLI, terminal dashboard and interactive relationship graph;
• quarantine-first cleanup with exact restore commands.

The distinction between proof and advice is the core of the product. Similar-looking code can be worth reviewing, but a heuristic should never silently become permission to delete work.

I am launching the free single-repository core first. Team and Enterprise are not part of this release. The core runs locally, needs no account or hosted code upload, and is source-available under FSL-1.1-MIT for its defined Permitted Purposes, including internal commercial use that is not a Competing Use.

I am also publishing the host capability matrix and adversarial benchmark contract. I would rather state an unsupported boundary than hide it behind a broad compatibility logo.

If you run parallel coding agents or maintain many Git worktrees, I would value a real counterexample: a cleanup Holt should block, an ordinary action it should allow, or information that arrives too late to change the decision.

Source and install are in the first comment.
```

Add this first comment:

```text
Source and install: https://github.com/Raed2180416/holt
Product docs: https://raed2180416.github.io/holt/
Benchmark contract: https://github.com/Raed2180416/holt/blob/main/BENCHMARKS.md
```

## GitHub

Use this release title:

```text
Holt v0.3.1 — local integrity for parallel coding-agent worktrees
```

The full release body remains `.github/releases/v0.3.1.md` because it records the exact fixes,
artifact install command, evidence status and honest limits. After publishing the release, pin this
GitHub Discussion:

```text
Title: Holt is ready for adversarial free/core testing

Holt v0.3.1 is the first release I am asking people to attack in real parallel coding-agent workflows.

The free single-repository core relates committed, staged, unstaged, untracked and relevant ignored work across Git worktrees. It gives humans and agents one evidence model for cleanup, collisions, dependencies and landing decisions.

The design boundaries are deliberate:

- exact content and recovery evidence may authorize an action;
- symbol, clone and dependency heuristics remain advisory;
- `clean --apply` uses locked local quarantine, not deletion;
- MCP is model-pull, while supported hooks provide the proactive or blocking path;
- every host is graded by evidence level in HOSTS.md;
- no saved-time or token-savings rate is published without a retained release-bound artifact.

Install:

    npm install -g https://github.com/Raed2180416/holt/releases/latest/download/holt.tgz
    cd your-repo
    holt setup
    holt auto

Please open an issue with a minimal reproduction if Holt makes either class of mistake:

1. false safe — it allows an action that can lose the last useful copy;
2. false block — it interrupts an ordinary action without actionable evidence.

Source and docs: https://github.com/Raed2180416/holt
Benchmark contract: https://github.com/Raed2180416/holt/blob/main/BENCHMARKS.md
```

## Launch order

1. Publish the GitHub release and verify the anonymous install from the release artifact.
2. Publish the official MCP Registry entry and verify it resolves to the same package version.
3. Publish the GitHub Discussion and website.
4. Submit Show HN while the maintainer can answer throughout the day.
5. Launch Product Hunt at 12:01 AM Pacific on the selected day; do not ask for upvotes.
6. Submit Peerlist on Monday from a verified, 100%-complete personal profile; do not ask for upvotes.
7. Publish the Indie Hackers, Reddit, X and LinkedIn versions with their channel-specific copy.
8. Publish the DEV article as a technical article, not a shortened advertisement.
9. Post the MLOps/AAIF and MCP community messages only in explicitly appropriate channels.

### Attribution footnote

Add this short footnote where a channel supports it, or place it in the first reply when it does
not: **Holt is part of Contrare Research. Product and research queries:
research.contrare@outlook.com.**
