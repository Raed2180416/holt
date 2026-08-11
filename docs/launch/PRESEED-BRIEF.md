# Holt pre-seed brief

**Date:** 2026-08-11
**Status:** Application and design-partner narrative; not a funding forecast, traction report, or
production-readiness certificate.

## The company in one sentence

**Holt is the transaction and recoverability layer for parallel coding agents: it makes in-flight
repository work observable, recoverable, and safe to act on before cleanup, merge, or landing.**

## The change in the environment

Coding agents make it inexpensive to run several implementation threads at once. The repository
state they create is not one branch per agent:

- one agent may have committed work;
- another may have staged or unstaged edits;
- another may hold the only untracked or ignored copy of a useful artifact;
- two agents may have changed the same file or symbol for different reasons; and
- a dependency or integration may exist only before either change reaches a pull request.

The failure happens before ordinary CI or a merge queue sees the work. A workspace can look
disposable by name, branch, or commit history while still holding the only durable copy of
something valuable. Conversely, relationship heuristics can make two workstreams look related
without proving that either one should be deleted.

## The wedge

Holt sits at the local transaction boundary around agent work:

```text
observe → classify exact content and relationships → protect → gate the action
         → execute reversibly where possible → verify or recover with a receipt
```

The category is deliberately narrower than orchestration or DevOps. Holt does not choose an
agent's task, replace Git, run a hosted fleet, or claim semantic certainty from a symbol match. It
owns the integrity decision and the recovery path; it integrates with the tools that already create,
test, and land code.

### Positioning statement

> For engineering and platform teams running multiple coding agents in real Git repositories,
> Holt is the transaction and recoverability layer that shows what a cleanup or landing action can
> lose, preserves unique work, and returns evidence for the next decision. Unlike a worktree
> manager, merge queue, or agent orchestrator, Holt relates committed and uncommitted repository
> state across worktrees and keeps exact destructive authority separate from advisory coordination
> signals.

The initial buyer hypothesis is an AI-native engineering or platform lead whose team already runs
three or more concurrent coding agents or worktrees. An individual developer can use the core,
but the repeatable company problem is a team repeatedly making consequential handoff, cleanup, or
landing decisions.

## What exists now

The current public offer is the free, local, single-repository core in the v0.3.1 source boundary.
It requires Node 22/24/26-compatible runtime versions and Git 2.45+, and it runs on
customer-controlled storage without an account, hosted code upload, or telemetry.

| Current capability | Evidence boundary |
|---|---|
| Repository-wide view of linked worktrees and in-flight state | `status`, `risk`, `context`, TUI, and relationship graph relate committed, staged, unstaged, untracked, and relevant ignored paths. |
| Exact cleanup authority | `gate`, `protect`, `auto`, and `clean` use exact path/content/reachability evidence; unknown or unmeasured state stays non-disposable. |
| Recovery-first actions | `rescue`, `discard`, quarantine, `restore`, and the separate `purge` path capture or re-check before mutation and return a recovery route. |
| Coordination signals | Collisions, hotspots, duplicates, impact, order, partition, branches, stash, and plan help review and landing; they are advisory unless exact evidence says otherwise. |
| Agent access | Project-scoped MCP, `brief`, `integrate`, and host-specific hooks expose capabilities with explicit advisory/contract/live labels. |
| Local evidence and integrity | Journal, forensics, audit, automated suites, and retained evaluation artifacts make the product inspectable offline. |

The repository's [feature-proof matrix](../FEATURE-PROOF-MATRIX.md) names the exact test or
harness evidence, independent oracle, and remaining gap for each surface. It is the authority for
what a feature proof means; this brief does not promote a fixture into customer adoption proof.

## What the evidence does—and does not—show

| Question | Current answer |
|---|---|
| Does a local product exist? | Yes, in the current source boundary and package manifest. |
| Is core behavior exercised? | Automated unit, end-to-end, filesystem, Git, protocol, and mutation evidence is retained in the repository and release/evaluation material. Re-run the relevant proof on the exact artifact being evaluated. |
| Is the core cross-platform? | Core safety and CLI flows have recorded Linux/macOS/Windows CI-matrix coverage. That is not evidence for every repository shape or every host integration. |
| Are all agent hosts protected? | No such claim is made. Host contracts and selected filesystem paths are tested; broad real-host destructive-deny, lifecycle, failure-injection, and upgrade evidence remains incomplete. |
| Do cloud agents inherit local protection? | No. Cloud and ephemeral agents do not receive local Git locks by default; their rows are advisory or Git-only unless separately provisioned. |
| Is there measured productivity or avoided-loss lift? | No universal rate is published. The retained six-trial agent run is a historical qualitative failure corpus, not a comparative rate. The open evaluator requires 20 valid trials per treatment before publishing a rate. |
| Is there customer traction, revenue, or a paid pilot? | Not claimed here. The next proof is repeated design-partner use and independently observed incidents. |
| Is this enterprise-ready? | No. There is no public paid checkout, SLA, DPA, SSO/SCIM offer, hosted control plane, or claim of production support in this launch. |

This distinction is a feature of the company thesis. A safety product that hides its unmeasured
boundaries is not demonstrating the behavior it sells.

## The 12-week proof route

This is a proposed operating route, not a promise of outcome or schedule.

| Window | Work | Pass condition | Falsifier or pivot |
|---|---|---|---|
| Days 0–14 | Repair the release gate and run the smallest cross-platform install/conformance slice. | One exact-head, artifact-linked run on Linux, macOS, and Windows with no known release bypass. | Any ordinary install needs manual repair, or the aggregate cannot identify exact commit/runtime/shard. |
| Days 7–28 | Exercise `start → watch → finish/recover` around real multi-agent incidents. | Five externally observed incidents, with at least three cases where Holt changed the selected action. | People inspect status but do not let Holt sit on a consequential action seam. |
| Days 21–49 | Recruit 5–10 design-partner teams running at least three agents/worktrees. | Three teams use Holt weekly for two consecutive weeks; two agree to a written reference or paid-evaluation conversation. | No repeated use, or false holds exceed a mutually acceptable threshold. |
| Days 35–63 | Add one GitHub/CI path and one editor/agent-host notification path with partners. | A new user installs and completes a protected transaction without founder intervention on each declared OS. | Permissions or lifecycle fail in ordinary repositories; make integration reliable before adding breadth. |
| Days 50–84 | Run targeted accelerator, angel, and infrastructure-fund conversations. | 30–50 targeted conversations, 8+ qualified follow-ups, 3+ partner/customer references, and at least one paid evaluation or signed pilot. | Weak conversion means refine the wedge or buyer; adding another subsystem is not the default response. |

The route is designed to generate a decision either way. If teams repeatedly place Holt on a
critical seam, the evidence supports a fundable infrastructure company. If they do not, the same
protocol should reveal that the problem is useful to an individual builder but not urgent to a
buying organization.

## Business model hypothesis

The free core is the current distribution and trust surface. A future paid offer is a hypothesis,
not an available SKU: design partners may help shape repository-scoped team governance, portable
recovery, signed policy, fleet evidence, and supported integrations. Pricing, support commitments,
identity, and data-processing terms should be set only after repeated usage identifies a budget
owner and an acceptance boundary.

The likely value metric is the number of active repositories where concurrent agent work creates
integrity risk—not seats—but this is a packaging hypothesis to validate, not a price card.

## Why this can become a company

Holt's potential moat is not command count. It is the combination of:

1. a transaction model that treats exact recovery as separate from heuristic coordination;
2. evidence that can be independently checked against real repository state;
3. provider-neutral identity across Git, worktrees, agents, CI, and developer machines; and
4. repeated placement on the action seam where cleanup or landing can cause irreversible loss.

Recent developer-infrastructure acquisitions and platform moves are directional evidence that
toolchains, secure execution, orchestration, and agent evaluation are strategic surfaces—not proof
that Holt is an acquisition target. The operating principle is to build a company that can survive
without acquisition while creating a capability a platform may prefer to integrate rather than
rebuild.

## Funding posture

Holt is eligible to apply before revenue; that does not imply that an idea alone closes a generic
venture round. The application should lead with one witnessable failure and the exact intervention:

```text
two agents edit one repository
        ↓
valuable state exists outside the branch view
        ↓
a cleanup or landing action risks loss or misintegration
        ↓
Holt names the evidence, preserves the work, and returns a receipt
```

The funding use is therefore specific: harden the transaction/recovery kernel, validate ordinary
Linux/macOS/Windows workflows, support a small design-partner cohort, and turn observed incidents
into a repeatable sales and trust story. It is not “add every integration” or “scale a hosted
platform” before the local wedge is proven.

See the [fundraising application pack](FUNDRAISING-APPLICATION-PACK.md) for application-ready
answers, target-program caveats, a diligence list, and the current no-traction language.

### Direct raise hypothesis (proposal, not a current fact)

A reasonable direct-raise proposal is **$1M for approximately 18 months**. The intended proof
milestones are 10 design-partner teams, 3 paid evaluations or pilots with written acceptance tests,
a real `start → watch → finish/recover` transaction loop, and an independently rerunnable
Linux/macOS/Windows release contract. The amount, instrument, valuation, runway model, and hiring
plan are not set by this brief and require founder-specific financial and legal review.

The capital would fund a narrow proof slice: transaction/recovery hardening and release evidence,
founder-led partner support, one GitHub/CI path, one editor or agent-host path, and the operational
capacity to investigate false holds. It is not a proposal to build a hosted control plane or a
large integration catalogue before the local wedge repeats.

## Investor objections, answered plainly

| Objection | Candid answer | Evidence that would change the answer |
|---|---|---|
| “There is no traction.” | Correct. Product and automated evidence exist; customer count, revenue, repeat use, and paid pilots are not claimed. | Three teams using Holt weekly, observed action changes, references, and paid evaluations. |
| “Git or GitHub can build this.” | They own credible primitives. Holt's narrower wedge is the local cross-worktree transaction state around agents, including uncommitted/ignored work and recovery-first action authority. | A customer repeatedly prefers Holt at an action seam native tools do not cover. |
| “False positives will block normal work.” | This is the central product risk. A refusal-only gate will be disabled; false holds are defects and need nearby negative controls. | Partner-level false-hold thresholds, counterexamples, and a declared rate on a complete corpus. |
| “The product depends on agent platforms.” | Holt integrates with hosts but its evidence model is provider-neutral. Cloud enforcement is not claimed. | A stable transaction contract plus observed integrations on the hosts partners actually use. |
| “Who is the team?” | The application must insert verified current team composition, roles, location, and commitment; this brief does not infer founder facts from historical documents. AI agents do not replace customer access, trust, procurement, or release ownership. | Current founder/team evidence and clear ownership of product, security, fundraising, and support. |
| “Cross-platform claims are too broad.” | Core CI-matrix evidence is not live host evidence on every OS. Holt must label observed, supported, degraded, and unresolved paths separately. | Exact artifact-linked OS runs plus partner-driven installer and host tests. |

The honest pre-seed case is therefore not “the market has already voted.” It is “the product has a
specific, witnessable integrity thesis, the core exists, and a bounded amount of capital can convert
that thesis into independent customer evidence—or falsify it quickly.”

## Decision rule

Continue only while the next proof slice can answer this question:

> **Did Holt become part of a team's recurring, consequential transaction seam—and can an
> independent observer verify what changed?**

If the answer is no after a bounded partner campaign, narrow the buyer or stop. Do not use public
launch attention, feature count, test count, or a speculative acquisition narrative as a substitute
for that evidence.

## Grounding links

- [Holt README and current boundaries](../../README.md)
- [Feature-proof matrix](../FEATURE-PROOF-MATRIX.md)
- [Provider adapter evidence](../PROVIDER-ADAPTERS.md)
- [Security questionnaire](../SECURITY-QUESTIONNAIRE.md)
- [Benchmark publication contract](../../BENCHMARKS.md)
- [YC FAQ](https://www.ycombinator.com/faq/?source=post_page---------------------------)
- [Techstars Founder Catalyst](https://www.techstars.com/founder-catalyst)
- [Sequoia Arc](https://sequoiacap.com/arc/)
- [First Round PMF Method](https://www.firstround.com/pmf)
