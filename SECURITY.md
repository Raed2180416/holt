# Security policy

## Reporting a vulnerability

Email **security@holt.dev**. Please do not open a public issue for a security report.

Include what you did, what happened, and what you expected. A proof of concept is welcome but
never required. You will get an acknowledgement within 72 hours and a substantive reply within
7 days.

We will credit you in the release notes unless you ask us not to.

## What is in scope

- The `holt` CLI, MCP server, hooks and analysis engine — in particular anything that causes
  holt to report a workstream as **safe to delete when it holds work found nowhere else**, or to
  execute a git command outside its allowlist.
- The license verification path — in particular anything that lets a forged or edited license
  verify.
- The license service (`server/`).

## What is not a vulnerability

- **Patching out the entitlement check.** The source is public; the check is tamper-evident, not
  tamper-proof. Removing it is a licensing matter, not a security one.
- `git worktree unlock` or `remove -f -f` defeating a lock. This is documented: those are git's
  own escape hatches, and holt's hook layer denies them where a hook layer exists.
- `rm -rf` deleting a protected worktree. A git lock is not a filesystem permission.


## Security review

Before its first paid release, holt's commercial surface (offline license verification, the
Stripe-webhook license service, the HTTP endpoints, CLI entitlement, and the supply chain) was
put through an adversarial audit covering token forgery, webhook replay, payment-event
confusion, terminal-escape injection, rate-limit bypass, and secret handling. Findings were
fixed and each is pinned by a regression test; the offline-verification and entitlement paths
carry deliberate-defect mutation tests that must fail the build if the check is ever weakened.

## Design properties we intend to hold

- holt makes **no network calls**, on any tier. If you observe one, that is a vulnerability report.
- Scanning is **read-only**: the only write the analysis path may perform is an unreferenced
  object via `git merge-tree --write-tree`. Mutating git verbs are unreachable without an
  explicit opt-in from a command that exists to mutate.
- **Fail-closed on missing evidence**: anything holt could not verify is reported as unknown and
  is never treated as safe.
