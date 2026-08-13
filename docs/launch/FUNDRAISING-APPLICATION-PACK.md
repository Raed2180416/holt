# Holt investor diligence brief

**Evidence date:** 2026-08-13
**Stage:** working product; distribution has not begun
**Category:** local transaction and recoverability layer for parallel coding-agent work

This is the public, sanitized diligence surface. It deliberately omits application routing,
unverified founder biography, cap-table and entity details, prospect names, private incidents, and
negotiating strategy. Those should be shared privately only after founder verification and mutual
context.

## The claim

Parallel coding agents create valuable state before a pull request exists: commits, staged and
unstaged edits, untracked files, relevant ignored files, stashes, and linked worktrees. A cleanup,
handoff, or landing decision can therefore lose or misintegrate work that a branch-only view does
not describe.

Holt builds one local evidence view across that state. Exact path, content, mode, reachability, and
recovery evidence drive its action verdicts; collision, similarity, dependency, and landing-order
signals remain advisory. On Holt-mediated cleanup paths, a measured candidate is re-verified,
moved into locked local quarantine, and returned with an explicit restore route rather than being
physically deleted.

## Current artifact boundary

- The latest public artifact is **v0.3.1**.
- Source after v0.3.1 contains later work. Until a new tagged release passes its release contract,
  current-source demos are candidate evidence rather than v0.3.1 capability claims.
- The official distribution is the signed GitHub release tarball. The bare npm registry name is
  not an official Holt distribution.
- Holt requires a supported Node 22/24/26 runtime and Git 2.45 or newer.
- Repository analysis is local. There is no account, hosted source upload, telemetry, paid
  checkout, production SLA, DPA, SSO/SCIM offer, or hosted control plane in the current launch.

## What exists now

| Surface | Current evidence | Boundary |
|---|---|---|
| Cross-worktree inventory | CLI, TUI, graph, context, and risk views over committed and local in-flight state | Repository shapes and host integrations are graded, not universal |
| Exact cleanup authority | `gate`, `protect`, `auto`, and `clean` use content and recoverability evidence | Arbitrary filesystem actions and unconfigured/cloud hosts remain outside Holt authority |
| Recovery-first actions | Rescue refs, reversible clean quarantine, restore, journal, and forensics paths | Each acting path has its own preconditions; no general rollback claim is made |
| Coordination intelligence | Collision, duplicate, impact, order, partition, branch, and stash signals | Advisory unless exact evidence independently authorizes an action |
| Agent access | MCP, brief, GitHub Action, and contract-tested host adapters | Contract-tested does not mean live enforcement on every host |
| Supply-chain inspection | Offline manifest audit, detached release signature, SBOM assets, and immutable-release checks | v0.3.1 has no discoverable SLSA provenance |

The [feature-proof matrix](../FEATURE-PROOF-MATRIX.md) maps each declared surface to executable
evidence, an independent oracle, and a remaining gap. A test or fixture is product evidence, not
customer adoption evidence.

## Reproducible product proof

From a source checkout, the isolated demo creates a temporary real Git repository and two
misleadingly named worktrees:

```console
node scripts/run-preseed-demo.mjs --json
```

The proof requires all of the following:

1. the alarming name holds modified, untracked, and ignored work and receives gate exit `1`;
2. the reassuring name is measured empty and receives gate exit `0`;
3. preview keeps the unique work and selects only the measured-empty worktree;
4. apply moves only that worktree into locked quarantine and returns restore argv;
5. quarantine inventory observes the recovery copy;
6. restore returns the worktree to its original path; and
7. HEAD, byte digest, clean status, and gate verdict match the pre-transaction state.

The demo proves a bounded local transaction on a controlled fixture. It does not prove demand,
productivity lift, universal enforcement, or enterprise readiness.

## Market and buyer hypothesis

The initial user is an engineer running several coding agents or worktrees in one active
repository. The initial buyer hypothesis is the engineering-platform or developer-productivity
owner responsible for scaling agent throughput without accepting opaque cleanup and recovery risk.

Native Git, GitHub/GitLab, worktree managers, agent orchestrators, and editors are credible
alternatives and future entrants. Holt's proposed wedge is the provider-neutral local transaction
state they do not publicly prove end to end: dirty, untracked, relevant ignored, and recovery
evidence across concurrent worktrees, with exact action authority kept separate from advisory
coordination signals. This is a wedge to validate, not a claim that incumbents cannot build it.

## Commercial hypothesis

The FSL source-available local core is the current trust and distribution surface. Shared policy,
signed aggregation checkpoints, supported integrations, incident collaboration, and fleet
governance are possible paid-team surfaces. Pricing and value metric are unvalidated. Existing
seat-based entitlement code is test infrastructure, not a commercial offer; repository-, fleet-,
support-, or seat-based packaging must follow repeated buyer evidence.

## Traction disclosure

Distribution has not begun. As of the evidence date, Holt claims no customers, revenue, paid
pilot, repeat use, reference customer, productivity rate, or avoided-loss rate. A 54-worktree
snapshot is founder-use problem evidence, not customer traction.

## Twelve-week validation funnel

The funnel has one meaning throughout this packet:

```text
qualified conversation -> trial approved -> installed -> consequential incident
-> changed action -> repeated weekly use -> paid evaluation
```

The proposed 12-week pass conditions are:

- 10 qualified conversations and 3 approved outside installations;
- 5 witnessed consequential incidents and 3 cases where Holt changes the selected action;
- 1 outside team repeating the workflow weekly;
- 1 paid evaluation with a written acceptance test; and
- 1 permissioned reference.

These are future validation targets, not current funnel numbers. A separate 18-month financing
hypothesis may target 10 design-partner teams and 3 paid evaluations; the different horizon must
not be presented as a 12-week commitment.

## Primary risks

| Risk | Falsifier or acceptance test |
|---|---|
| Native tools are sufficient | Qualified teams repeatedly decline Holt after comparing the same consequential workflow |
| False holds make the product unusable | Partner-agreed negative controls exceed the allowed false-hold threshold |
| The seam is rare or low-value | Outside installations do not produce witnessed consequential incidents |
| Product proof does not become repeat use | No outside team repeats the workflow weekly after a bounded campaign |
| Team governance is not a budgeted problem | No buyer accepts a written paid-evaluation boundary |
| Host/OS claims outrun evidence | Exact artifact-linked tests fail on an ordinary declared path or require founder repair |

## Diligence links

- [README and authority boundary](../../README.md)
- [90-second demo script](PRESEED-DEMO-SCRIPT.md)
- [Design-partner program](DESIGN-PARTNER-PROGRAM.md)
- [Feature-proof matrix](../FEATURE-PROOF-MATRIX.md)
- [Security questionnaire](../SECURITY-QUESTIONNAIRE.md)
- [Supply-chain verification](../../SUPPLY-CHAIN.md)
- [Post-v0.3.1 55-commit audit](../research/2026-08-13-post-v0.3.1-55-commit-audit.md)
- [Market, technical-gap, and future-direction sweep](../research/2026-08-13-holt-market-and-future-gap-sweep.md)

Founder identity, company/entity status, intellectual-property ownership, cap table, financing
history, location, full-time commitment, references, and round terms require current founder
verification before an application or investment document is submitted.
