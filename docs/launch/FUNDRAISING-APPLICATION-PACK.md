# Holt fundraising application pack

**Date:** 2026-08-11
**Stage:** Pre-seed / no public traction claim
**Use:** Accelerator applications, specialist-investor outreach, and first diligence calls

This pack is a writing aid, not evidence that a round is open, committed, or likely to close.
Replace bracketed founder facts only from a current verified source. Do not copy historical company
documents that contain stale names, team composition, incorporation, education, or location claims.

## Canonical company narrative

### One line

**Holt is the transaction and recoverability layer for parallel coding agents.** It relates the
committed and uncommitted state across real Git worktrees, preserves unique work before cleanup,
and provides evidence for safe landing decisions.

### Thirty seconds

Coding agents make parallel implementation cheap, but they leave repository state in places a
branch list does not describe: commits, staged edits, dirty files, untracked files, ignored paths,
and linked worktrees. A cleanup or handoff can remove the only copy of useful work before CI or a
pull request ever sees it. Holt is the local transaction layer around that seam. It observes the
state, separates exact recovery evidence from advisory overlap signals, protects work, re-checks
the action boundary, and emits a recovery receipt. The free core exists today; the next proof is
repeated use by teams running several agents.

### Two minutes

The first wave of coding agents changed the cost of producing a patch. The next problem is making
parallel patches safe to coordinate. A team can have one agent commit, another stage a migration,
and a third create the only useful untracked artifact. Two agents can touch the same symbol without
either branch name revealing the relationship. Git remains the right version-control primitive,
but ordinary Git porcelain does not answer the repository-wide destructive question: if this
workspace is cleaned up or this change is landed now, what unique work can be lost or misintegrated?

Holt owns that transaction boundary. Exact path, mode, object, and recovery evidence drives a
fail-closed action decision. Symbol overlap, clone similarity, dependency impact, and landing order
remain advisory review intelligence. The local product can inspect, protect, rescue, quarantine,
restore, and explain a proposed landing without replacing Git, CI, an editor, or an agent
orchestrator.

The current source boundary is a free, local, single-repository core. Its tests and retained
artifacts show what has been exercised, while explicitly leaving broad real-host enforcement,
cloud-agent coverage, universal performance, and customer adoption unproven. The financing plan is
to turn one narrow `start → watch → finish/recover` loop into an independently observed workflow:
10 design partners, three paid evaluations, a repeatable recovery incident corpus, and a declared
Linux/macOS/Windows transaction contract. Those are proposed milestones, not current traction.

## Application answer bank

### What does the company do?

Holt is the transaction and recoverability layer for parallel coding agents. It builds one local
evidence view across linked Git worktrees, protects unique in-flight work before cleanup or handoff,
and keeps exact destructive authority separate from advisory coordination signals.

### What problem are you solving?

Parallel agents create valuable repository state before a pull request exists. That state may be a
commit, staged edit, dirty file, untracked file, ignored artifact, dependency, or overlapping
change in another worktree. Ordinary branch and CI views do not relate all of it at the action
boundary. Teams therefore choose between slow manual inspection and unsafe cleanup/landing. The
failure is not that Git lacks a command; it is that no transaction layer answers what the action can
lose and how to recover it.

### Who is the first customer?

**Buyer hypothesis:** an AI-native engineering or platform lead at a team already running at least
three coding agents or Git worktrees in parallel.

**User hypothesis:** the engineer or agent operator who must decide whether to clean, hand off,
merge, or land work while other workstreams are still active.

**Validation requirement:** name three actual teams that fit, interview them, and record their
current action seam. Do not turn the buyer hypothesis into a customer list until permission and
repeat use exist.

### Why now?

The marginal cost of running coding agents in parallel is falling faster than the repository
processes around them are changing. That creates a new pre-PR integrity seam: work is cheap to
start but expensive to explain, reconcile, and recover after a mistaken action. Secure execution,
agent orchestration, and agent evaluation are also becoming strategic platform surfaces. Those
signals support timing; they do not prove Holt's market size or acquisition value.

### What is the product today?

The v0.3.1 source boundary contains a free local core for a single repository: repository-wide
state inspection, exact cleanup authority, recovery-first actions, coordination views, a TUI and
offline graph, project-scoped MCP/host surfaces, local journal/forensics, and package audit. See the
[README](../../README.md), [feature-proof matrix](../FEATURE-PROOF-MATRIX.md),
[provider-adapter evidence](../PROVIDER-ADAPTERS.md), and [security questionnaire](../SECURITY-QUESTIONNAIRE.md).

### What is not shipped or proven?

There is no public claim of universal real-host blocking, cloud-agent enforcement, performance or
productivity lift, customer count, revenue, paid pilots, production SLA, hosted control plane,
SSO/SCIM, or enterprise readiness. Team and Enterprise code in the repository is not a public paid
offer in this launch. Design-partner milestones are proposed validation gates.

### Why is it different from Git or GitHub?

Git remains the substrate. Git worktrees isolate paths; GitHub, CI, and merge queues see shared
committed work; agent orchestrators dispatch work. Holt relates the state that exists around those
systems before a destructive action and makes recovery an explicit part of the transaction. It does
not claim to replace Git or to know semantic meaning that its evidence cannot establish.

### Why will it be hard to copy?

The potential moat is not a list of commands. It is a neutral, provider-independent transaction
model with exact content/recovery authority, evidence receipts, cross-worktree identity, and a
repeated position on the action seam. The moat is **not proven** until design partners use Holt in
consequential workflows and independent observers can verify changed decisions.

### What is the business model?

Free local core first. A future paid offer is a hypothesis around active repositories, shared
governance, portable recovery, signed policy, and supported integrations. Pricing, support, data
processing, and entitlement terms will be set after a budget owner and acceptance boundary emerge;
there is no public checkout or price card in this launch.

### What is the current traction?

Use this exact answer until new evidence exists:

> We do not claim customer traction or revenue yet. The repository has a working free/core product,
> automated and retained evidence for its declared surface, and a historical six-trial qualitative
> failure corpus. Those are product and research artifacts, not adoption or lift. We are recruiting
> design partners to observe five real incidents, repeat weekly use, and test whether Holt changes a
> consequential cleanup or landing decision.

### What will the next 12 weeks prove?

1. An exact-head release/conformance gate with declared Linux/macOS/Windows semantics.
2. Five externally observed multi-agent incidents, three with a changed selected action.
3. Ten design-partner teams approached, three using Holt weekly for two consecutive weeks.
4. Three scoped paid-evaluation conversations and at least two references if the evidence earns them.
5. One GitHub/CI path and one editor/agent-host path selected by repeated partner need.

These are operating targets, not achievements.

## Direct raise hypothesis

### Proposed ask (not a fact)

**Raise hypothesis: $1.0M for approximately 18 months** to reach:

- 10 design-partner teams recruited and instrumented;
- 3 paid evaluations or pilots with written acceptance tests;
- a real `start → watch → finish/recover` transaction loop;
- a declared, independently rerunnable Linux/macOS/Windows release contract; and
- a focused GitHub/CI and editor/agent-host integration path.

The amount, runway, instrument, valuation, and hiring plan require founder-specific financial and
legal review. They are intentionally not presented as committed terms or a forecast.

### Proposed capital allocation envelope

| Work | Planning envelope | Proof it should buy |
|---|---:|---|
| Transaction/recovery kernel and release/conformance | 45% | Exact action-boundary behavior, interruption/recovery, and reproducible OS artifacts. |
| Design-partner support and customer discovery | 30% | Repeated workflows, incident corpus, references, and paid-evaluation acceptance tests. |
| Integrations and distribution | 15% | One GitHub/CI path, one editor/host path, and installation without founder repair. |
| Security, operations, and contingency | 10% | Diligence answers, support capacity, and room for failed hypotheses. |

Percentages are a planning scaffold, not a budget already spent. If the first partner evidence does
not support the transaction wedge, capital should fund narrowing or stopping—not breadth for its own
sake.

## Investor objections, answered plainly

| Objection | Candid answer | What would change the answer |
|---|---|---|
| “There is no traction.” | Correct. The product exists, but customer count, revenue, repeat use, and paid pilots are not claimed. | Three teams using it weekly, observed incident-level action changes, references, and paid evaluations. |
| “Git or GitHub can build this.” | They own important primitives and are credible alternatives. Holt's wedge is the local, cross-worktree transaction state around agent work, including uncommitted and ignored content plus recovery-first action authority. | A customer must repeatedly prefer Holt at an action seam that native tools do not cover; otherwise the wedge is not a company. |
| “False positives will block normal work.” | This is the central product risk. A gate that only refuses will be disabled. Exact authority must be fail-closed when evidence is missing but reversible actions must remain available; false holds are measured as defects. | Counterexamples, false-hold rate by declared corpus, and partner acceptance thresholds from real workflows. |
| “The product depends on agent platforms.” | Holt integrates with hosts but does not need a model vendor to define its evidence model. Local Git locks and CLI/MCP remain useful across clients; cloud enforcement is not claimed. | A provider-neutral transaction contract plus observed integrations on the hosts partners actually use. |
| “Who is the team?” | Do not hide the answer or infer it from stale documents. Insert the verified current team, roles, location, and time commitment below. AI agents increase implementation throughput but do not replace customer access, trust, procurement, or release ownership. | Current founder/team evidence, customer references, and clear ownership of product, security, fundraising, and support. |
| “Cross-platform claims are too broad.” | Agreed. Core CI-matrix evidence is not the same as live host evidence on every OS. The product must publish `observed`, `supported`, `degraded`, and `unresolved` per contract. | Exact artifact-linked Linux/macOS/Windows runs plus partner-driven installer and host tests. |
| “Why fund a local tool instead of a hosted platform?” | Local custody is a trust and deployment advantage at the first transaction seam; it avoids asking teams to upload repository state before they trust the guard. Hosted coordination may be a later option, not today's premise. | Repeat teams paying for governance or support around repository-scoped evidence without weakening local custody. |

## Verified founder and company fields

Complete these from current records immediately before each application:

| Field | Verified answer |
|---|---|
| Legal/applicant name(s) | `[insert current verified answer]` |
| Current team composition and roles | `[insert current verified answer]` |
| Founder location and program eligibility | `[insert current verified answer]` |
| Time commitment | `[insert current verified answer]` |
| Relevant technical/customer history | `[insert links or concise verified facts]` |
| Incorporation/entity status | `[insert current verified answer]` |
| Current financing and commitments | `[insert current verified answer]` |

Do not copy these placeholders into a submission. They exist to prevent historical docs from
silently becoming present-tense claims.

## Current route map

Statuses below were checked for this pack on 2026-08-11. Application windows, terms, eligibility,
and check sizes can change; verify the linked official page immediately before sending.

| Route | Why it fits | Current caveat and next move |
|---|---|---|
| [Y Combinator application](https://www.ycombinator.com/apply) | Idea-stage and no-revenue applications are admissible; a sharp infrastructure thesis and witnessable demo are the asset. | The page says Fall 2026 late applications are still accepted after the July 27 on-time deadline, without a response-time promise. Apply immediately if the form accepts; do not imply selection or funding. |
| [South Park Commons India](https://www.southparkcommons.com/india/) / [Fall 2026 Fellowship](https://www.southparkcommons.com/founder-fellowship) | Strong fit for technically ambitious early builders and the -1-to-0 exploration around a new infrastructure category. | The Fellowship post listed an August 2 deadline while the official India landing still says Fall 2026 applications are open. Use the active form immediately if it accepts a submission; confirm Bengaluru residency and bootcamp logistics directly. |
| [Accel Atoms AI](https://atoms.accel.com/apply) | Official material says applications are rolling for Indian and Indian-origin founders building across the AI stack, including developer tools; pre-product/pre-revenue and solo applications are described as eligible. | Fit is thesis- and team-dependent; no acceptance is implied. Submit the sharp wedge, evidence boundary, and current verified founder fields. |
| [Grayscale Ventures](https://grayscale.vc/) | Closest direct thesis fit: official site describes a first-cheque pre-seed focus on India-to-world infrastructure/AI, including DevInfra/DevTools and AI Agentic, with stated $125k–$1M cheques. | This is an investor thesis, not a signal of interest. Send a concise incident/demo packet to [ventures@grayscale.vc](mailto:ventures@grayscale.vc) and ask whether the current stage fits. |
| [Heavybit](https://www.heavybit.com/) | Direct enterprise-infrastructure specialization; official site states $500k–$5M from inception to Series A. | Expect a high bar for a differentiated technical wedge and category potential. Treat as targeted outreach after the first observed partner evidence, not guaranteed pre-seed access. |
| [OSS Capital](https://oss.capital/contact-us/) | Direct fit only if Holt's source-available/free-core path becomes a clear commercial open-source company. | OSS Capital says it backs COSS founders globally. Holt's current FSL/core boundary is not proof of COSS economics; send only after the licensing and monetization thesis is explicit. |
| [Afore FIR / Afore Alpha](https://www.afore.vc/afore-alpha) | Potential early-stage relationship for a product-oriented builder; the program is designed around very early company formation. | Eligibility, location, timing, and current check/program terms need verification. Treat as conditional, not a primary route until the official form confirms fit. |
| [Together Fund](https://www.together.fund/about) | Strong thematic AI and India-to-world relationship; useful for a later seed conversation or introduction. | Current public positioning emphasizes roughly $1M–$10M Seed/Series A. Treat as relationship/start-now outreach, not the primary no-traction pre-seed path. |
| [Sequoia Arc](https://sequoiacap.com/arc/) | Pre-seed infrastructure thesis and customer/product/GTM support are directionally relevant. | Current page is notify-only rather than an immediate open application. Join the list and build proof; do not represent an active application window. |
| [Techstars Founder Catalyst](https://www.techstars.com/founder-catalyst) | Pre-funding, idea-stage program material is relevant to an early product. | Program timing and geography vary. Use the current signup/interest route only after verifying a live cohort; do not present it as a committed funding path. |

## Investor outreach sequence

1. Ask design-partner prospects and technical operators for one introduction to a team already
   running multiple agents.
2. Send the one-line thesis, one five-minute incident/recovery demo, and one evidence-boundary link.
3. Ask investors for a fit/no-fit conversation, not a generic “thoughts?” response.
4. Track target, thesis fit, date, response, next proof requested, and no-fit reason.
5. Re-contact only after a material proof change: a repeated incident, paid evaluation, OS contract,
   or customer reference.

The strategy memo proposes 30–50 targeted investor conversations, 8+ qualified follow-ups, 3+
partner/customer references, and at least one paid evaluation or signed pilot as a 12-week route.
Those are targets, not current funnel numbers.

## Demo and diligence packet

### Five-minute demo order

1. Show two agents/worktrees and the specific repository state ordinary Git views fragment.
2. Plant or replay one severe but safe-to-run cleanup/landing failure.
3. Show the exact evidence Holt uses and the distinction between authority and advice.
4. Let the risky action refuse or become recoverable; show the receipt and restore route.
5. Run the nearby negative control and name what remains unproven.

Never stage an outcome, claim a host deny that was not observed, or call a fixture a customer story.

### Data room links

- [Current README](../../README.md)
- [Feature-proof matrix](../FEATURE-PROOF-MATRIX.md)
- [Benchmark publication contract](../../BENCHMARKS.md)
- [Evaluation contract](../../eval/README.md)
- [Provider adapters and host boundaries](../PROVIDER-ADAPTERS.md)
- [Security questionnaire](../SECURITY-QUESTIONNAIRE.md)
- [Supply-chain disclosure](../../SUPPLY-CHAIN.md)
- [Design-partner program](DESIGN-PARTNER-PROGRAM.md)
- [Pre-seed brief](PRESEED-BRIEF.md)

### Application attachments

- Current founder video: `[record a direct, verified founder-only explanation; insert link]`
- Product demo: `[insert current, reproducible capture; retain raw artifact]`
- Incident corpus: `[insert only approved, independently observed partner incidents]`
- Current release artifact/checksum: `[insert exact tag and artifact evidence]`
- Financial model and runway: `[insert founder-verified model; do not infer from this pack]`

## Claims to avoid

- “Enterprise-ready,” “works with every agent,” or “protects cloud agents.”
- “Customers,” “revenue,” “paid pilots,” or “traction” before the named evidence exists.
- “X% productivity,” “X% fewer losses,” or a universal latency number from a small or historical run.
- “Git cannot do this” or “we replace GitHub.” State the narrower pre-PR transaction gap.
- “AI lets one person do everything.” AI accelerates bounded implementation; it does not replace
  customer discovery, support, trust, procurement, or final release authority.
- “Acquisition is the plan.” Strategic buyers are optionality created by adoption and adjacency.
