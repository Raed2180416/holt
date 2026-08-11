# Holt design-partner program

**Status:** Proposed validation program
**Audience:** Engineering/platform leads and teams running several coding agents in real Git
repositories
**Commitment:** A bounded, evidence-led trial—not a production support or security certification

## Why participate

Parallel coding agents are useful when work can be inspected, handed off, and recovered. The
hardest failures often occur before a pull request exists: a workspace is cleaned up because its
branch looks disposable, an untracked or ignored artifact is the only copy, or two agents produce
overlapping changes with no clear landing order.

Holt is building the transaction and recoverability layer for that seam. Design partners help test
whether the problem is recurring and consequential enough to own, which evidence changes a real
decision, and where installation or host integration breaks.

This is not a request to endorse an idea. The useful output is a reproducible incident, a changed
action, or a clear reason the intervention did not earn a place in the workflow.

## Who should apply

### Strong fit

- An engineering or platform team already running at least three coding agents or Git worktrees in
  parallel.
- A repository where cleanup, handoff, merge, or landing decisions carry meaningful cost.
- A technical contact who can approve a local CLI and spend roughly 30 minutes each week on review.
- A willingness to run the trial in a repository or branch scope approved by the team, with no
  expectation that Holt is the sole backup or production safety control.

### Not a fit yet

- A team that only runs one agent and has no repeated multi-worktree workflow.
- A request for hosted orchestration, cloud-agent enforcement, SSO/SCIM, procurement paperwork, or
  a production SLA. Those are not public launch offers.
- A benchmark request that supplies no real workflow or action seam.
- A need to upload source code or telemetry to a vendor. The current core is local; partners retain
  control of repository bytes.

## What partners get now

- Guided installation and a short baseline walkthrough of the free/core local product.
- A bounded incident protocol using the team's own approved repository or a disposable reproduction.
- Direct review of evidence, recovery receipts, false holds, missed cases, and confusing output.
- A say in which transaction loop, GitHub/CI path, editor, or agent-host path is worth hardening
  next.
- Early access to partner-driven changes when they are clearly labelled as experimental.
- A written summary of observed results, including failures and unresolved boundaries.

There is no implied logo, testimonial, paid contract, reference, uptime promise, or production
certification. A paid evaluation may be discussed only after the scope and acceptance test are
written down; no public paid SKU or checkout is active in this launch.

## What we ask from a partner

1. Name one recurring multi-agent workflow and the action seam where trust is lost.
2. Provide a safe repository, branch, or disposable fixture. Do not expose secrets merely to test
   recovery; Holt's local rescue/discard refs are ordinary unencrypted Git objects.
3. Run the baseline and at least one Holt-assisted workflow without changing the acceptance test
   after seeing the result.
4. Join one short weekly review or send an equivalent written report for two consecutive weeks.
5. Record whether Holt changed the selected action, what evidence was missing, and whether the team
   would run it again.
6. Permit anonymised incident classes to be discussed publicly only if the partner approves. Raw
   repository content and private identifiers remain out of the public corpus.

## The trial protocol

### 1. Define the seam

Before installation, write a one-paragraph hypothesis:

> When **[team]** runs **[agents/worktrees]** against **[repository/workflow]**, **[cleanup,
> handoff, merge, or landing action]** can lose or misintegrate work because **[specific missing
> evidence]**. Holt should change **[decision]** by exposing **[evidence/recovery path]**.

Capture the current process, the person who makes the decision, and the cost of a false allow or a
false hold. Do not use a generic “developer productivity” outcome.

### 2. Establish a baseline

Run the ordinary team workflow on an approved fixture or repository and record:

- worktree and agent count;
- committed, staged, unstaged, untracked, and ignored state involved;
- the action the team would normally take;
- what evidence was available at decision time; and
- the independent oracle for whether work was lost, duplicated, conflicted, or safely preserved.

The baseline is not a benchmark score. It is the control needed to tell whether Holt changed a
decision rather than merely produced an interesting report.

### 3. Install and observe

Use the official stable GitHub release, verify what was installed, then keep Holt's repository
integration project-scoped unless the partner explicitly approves a broader scope:

```bash
npm install -g https://github.com/Raed2180416/holt/releases/latest/download/holt.tgz
holt --version
holt setup
holt status
holt risk
holt context <workstream-id>
```

Inspect `holt hosts` and `holt doctor` separately. A generated or configured file is not evidence
that a host loaded the integration or enforced a deny.

### 4. Exercise one protected transaction

Use the smallest workflow that can produce the named failure:

```text
start work → observe siblings → protect/rescue → perform or refuse action
             → re-check at the action boundary → recover or land → retain receipt
```

For cleanup, prefer `holt clean --apply` because it moves a fresh-checked candidate into locked,
recoverable quarantine. For a specific file or generated tree, use `holt discard` only after the
partner has reviewed the fact that recovery refs are local Git objects. For a suspected interaction,
use `holt verify A B --run "<team test>"` and record exactly what the supplied test observed.

### 5. Run a counterexample

Every positive incident needs a nearby negative control:

- a genuinely disposable worktree that should not be blocked;
- a duplicate-looking pair where one copy can be safely retained;
- an ordinary command that should proceed; or
- a host/configuration path where evidence is unavailable and Holt must say so.

The goal is not maximum refusal. A false hold is a product defect when it prevents normal work
without a recoverability reason.

### 6. Review the receipt

The partner and Holt record the action, evidence class, observed outcome, recovery path, and any
unmeasured boundary. Mark the result using the repository evidence ladder:

```text
exists → reachable → default-live → observed → causal → product-proven
```

An automated fixture can prove a class of behavior. It does not prove a partner's workflow until
that workflow is independently observed.

## What counts as progress

The following are proposed program gates, not existing traction:

| Gate | Proposed acceptance test |
|---|---|
| Install | A new partner reaches a useful baseline on the declared OS/repository shape without founder repair. |
| First value | The first intervention names a concrete unique, conflicting, duplicate, or recovery-relevant state. |
| Causal change | In at least three of five observed incidents, Holt changes the action the team selects. |
| Repeat use | At least three teams run the workflow weekly for two consecutive weeks. |
| Trust | Two teams agree to a written reference or a scoped paid-evaluation conversation after reviewing the evidence. |
| Cross-platform | Each declared OS passes the same user-visible transaction contract; degraded or unresolved paths are labelled rather than hidden. |
| Product boundary | No partner-facing material calls a host, cloud path, performance number, production readiness, or ROI lift proven without the corresponding observation. |

The program can still succeed without every gate if it identifies a sharper buyer or a narrower
transaction seam. A failed gate should change the plan; it should not be buried in a launch metric.

## Evidence ledger template

Partners can copy this table into an issue or shared note:

| Field | Entry |
|---|---|
| Team / workflow |  |
| OS, Node, Git, repository shape |  |
| Agent/worktree count |  |
| Action seam |  |
| Baseline decision |  |
| Holt command or host path |  |
| Exact evidence observed |  |
| Advisory evidence observed |  |
| Independent oracle |  |
| Holt changed the action? | yes / no / unresolved |
| Recovery receipt or refusal |  |
| False hold / missed case |  |
| Repeat-use decision |  |
| Partner-approved public summary |  |

## Privacy and safety boundaries

- The current core performs analysis and enforcement locally. It has no hosted code upload, account,
  telemetry, or model call in the ordinary path.
- Setup may download approved analysis tools or use an explicit package-manager path; inspect
  [`holt audit`](../../README.md#evidence-and-limits) and [SUPPLY-CHAIN.md](../../SUPPLY-CHAIN.md)
  before a restricted environment trial.
- `rescue` and `discard` preserve bytes in local Git objects, including bytes that may be secrets.
  Partners must use an approved repository or whole-worktree quarantine and must not treat Holt as a
  secret manager.
- The trial does not replace independent backups, code review, CI, branch protection, or a team's
  incident process.
- Cloud and ephemeral agent paths are not protected by a local Git lock by default.

## Invitation copy

> Holt is looking for a small number of engineering/platform teams that already run several coding
> agents in parallel. We are not asking for a launch quote. We want one real cleanup, handoff, or
> landing case where the branch view is not enough. We will run a bounded local trial, preserve the
> control case, record whether Holt changed the decision, and publish nothing without approval. If
> the workflow does not repeat, that is useful evidence too.

To propose a trial, send the workflow, approximate agent/worktree count, OS mix, and the action seam
to [research.contrare@outlook.com](mailto:research.contrare@outlook.com). Do not send repository
contents or credentials in the first message.

## What comes after the trial

Only repeated evidence should promote roadmap items:

- a stable `start → watch → finish/recover` transaction loop;
- cross-platform conformance and installer paths;
- one GitHub/CI integration and one editor or agent-host notification path;
- portable recovery capsules or approved external checkpoints;
- team governance, signed policy, identity, and support commitments shaped by actual buyer needs.

These are design-partner hypotheses. They do not make Team, Enterprise, cloud enforcement, SSO,
SCIM, or a production SLA available today.
