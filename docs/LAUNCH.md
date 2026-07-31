# grove — launch, growth, and monetisation plan

*Working document. Everything here is a plan, not a promise; the measured numbers it cites are
in the README and eval/.*

---

## 1. Positioning — one sentence per audience

| Audience | The sentence |
|---|---|
| Dev running agents | *"Your agents create worktrees faster than you can safely delete them. Grove knows which ones hold the only copy of something — and locks them so `--force` bounces."* |
| Team lead | *"The landing layer for parallel agent work: what N agents produced, what's redundant, what collides, what can go."* |
| Agent-framework author | *"A content-level safety oracle your tool can call: `gate` exit codes, MCP tools, a PreToolUse hook."* |
| HN reader | *"An AI agent deleted 13 of 16 worktrees including the only copy of a security fix — because of their names. We measured it, then built the thing that makes it impossible."* |

**What grove is NOT positioned as:** another worktree manager (saturated, free), or "AI safety"
(vague). It is the missing *relationship layer* — git has no primitive that relates uncommitted
work across worktrees, and neither does anything else. Claude Code now locks worktrees *by
session*; grove locks *by content*. That contrast is the moat sentence.

## 2. The launch story (this is the marketing asset)

The A/B trials write the launch post themselves. The narrative arc that lands:

1. **The measured catastrophe.** A naked agent deleted 13/16 worktrees including all five
   irreplaceable ones, reasoning from names — and kept two empty decoys named
   `IMPORTANT-do-not-delete`. Verbatim transcripts exist.
2. **The failed obvious fix.** We added warnings (AGENTS.md). Agents froze: 100% safety, 0%
   utility. Warnings are not a mechanism.
3. **The mechanism.** `git worktree lock`, applied *by content*, with a reason git itself prints
   to whoever tries. Plus rescue-to-a-verified-ref so refusal has a resolution.
4. **The receipts.** 190+ tests, 12/12 mutation kills, an invariant fuzzer with an independent
   oracle, a 150-worktree monster round, 4.4 ms/worktree at N=300 — and the four times our own
   instruments lied to us, documented, because that's why the suite looks like this.

Content pipeline from that arc:
- **Show HN**: "Grove — an AI agent deleted the only copy of a security fix, so we built the
  layer git is missing" (post = condensed README, lead with the transcript).
- **Blog series** (each is already written in commit messages): the fabricated eval result; the
  answer-key leak; "availability is not adoption"; ls-tree quotes unicode; the freeze.
- **r/git, r/ClaudeAI, r/LocalLLaMA, lobste.rs**: tailored angle each.
- **Directories**: MCP registries (Smithery, mcp.so, PulseMCP), awesome-claude-code,
  awesome-git, agent-tool lists. `grove integrate` supporting 8+ hosts is the hook.

## 3. Built-in traction loops (the product markets itself)

- **The lock reason is an ad.** Every time anyone — agent or human — hits a protected worktree,
  *git itself* prints `grove: holds work found nowhere else… Run 'grove rescue <id>'`. That line
  travels in screenshots, CI logs, and bug reports.
- **AGENTS.md blocks are public.** Repos that `grove integrate` carry a visible grove section;
  every reader of that repo learns the tool exists.
- **Rescue refs are discoverable.** `refs/grove/rescue/*` in a repo is a breadcrumb months later.
- **The gauntlet as a public benchmark** (see §5) invites other tools to compete — every
  submission is marketing.

## 4. Monetisation — free core, paid coordination

The FSL license enforces the boundary: anyone can *use* grove, nobody can *sell* grove.
What we sell is what teams need above the single-repo CLI:

| Tier | What | Price signal |
|---|---|---|
| **grove (CLI/MCP/TUI)** | everything in this repo, forever | free (FSL → MIT after 2y) |
| **grove Fleet** | one dashboard over N repos × M machines: org-wide at-risk view, who-holds-what, rescue browser, Slack alerts | per-seat SaaS |
| **grove CI** | GitHub/GitLab app: PR check that fails when a merge would orphan work; scheduled `clean` with audit trail; policy (e.g. "no worktree older than 14 days unprotected") | per-org |
| **grove Enterprise** | SSO, on-prem fleet, support SLA, custom policy engines | contract |
| **Sponsorship** | GitHub Sponsors from day one for individuals who just want to support | goodwill |

Sequencing: CLI free forever → Fleet waitlist at launch (gauge demand before building) → CI app
first paid product (smallest build, clearest value: "your PR orphans work in worktree X").

## 5. "Official" benchmarking

Two instruments, both already in-repo, both reproducible by anyone:

1. **Correctness+scale**: `node eval/bench.mjs 300` — planted ground truth, verdicts re-graded
   at scale, speed voided if any verdict is wrong. Publish the table (N=39/100/300/1000) per
   release in BENCHMARKS.md; CI regression-gates the 40-tree monster.
2. **Agent A/B**: `eval/prep.mjs` (build) + any agent + `grade`. Manifest isolated from trials
   (answer-key leak is a tested regression). Publish per-model results with Wilson CIs and n;
   invite PRs adding models. **Rule we never break: no headline number without n and CI.**

## 6. Risks, named

- **Platform absorption** (Claude Code/Cursor building content-aware locking): our counter is
  neutrality — grove works across *all* agents, and the relationship layer (impact/duplicates/
  verify) is much deeper than a lock.
- **FSL scares some contributors**: mitigated by MIT-after-2-years and plain-English license
  section; monitor and revisit if it measurably costs adoption.
- **Small-N evals get quoted as proof**: every published number carries n and CI; the README
  says "pilot" where it is one.

## 7. Pre-publish checklist (the npm gate)

- [ ] macOS + Windows CI matrix green (config landed; needs a push to GitHub to run)
- [ ] A/B at n≥10/arm for the headline table
- [ ] `npm pack` audit: no eval/, no test/, no fixtures in the tarball (CI-checked already)
- [ ] Version pinned, CHANGELOG started, `grove --version`
- [ ] Name check: `grovekit` free on npm (verified); decide final name once
- [ ] Security pass: no telemetry, no network calls anywhere in src/ (grep-verified per release)
- [ ] The rollback guard: release builds only from committed HEAD; `git status --porcelain`
      must be empty and the CLI reachability test green *on the tag*
