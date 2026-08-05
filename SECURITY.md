# Security policy

## Reporting a vulnerability

Report privately through **[GitHub Security Advisories](https://github.com/Raed2180416/holt/security/advisories/new)** — it is private to the
maintainers, gives you a coordinated-disclosure thread, and needs no email address to be
trusted. Please do not open a public issue for a security report.

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

- Ordinary analysis, hooks, MCP calls, Git actions and offline licence verification make **no Holt-
  initiated network request**. The explicit, human-confirmed `setup` / `doctor --install` paths may
  download a pinned ctags asset or invoke a package manager, exactly as disclosed in
  [SUPPLY-CHAIN.md](SUPPLY-CHAIN.md). An undisclosed destination, credential leak, repository-data
  egress, telemetry, or network activity from an ordinary offline path is a vulnerability report.
- Scanning is **read-only**: the only write the analysis path may perform is an unreferenced
  object via `git merge-tree --write-tree`. Mutating git verbs are unreachable without an
  explicit opt-in from a command that exists to mutate.
- **Fail-closed on missing evidence**: anything holt could not verify is reported as unknown and
  is never treated as safe.
- `rescue` and `discard` are integrity captures, not secret vaults. They write every captured byte,
  including ignored or untracked credentials, as an unencrypted local Git object reachable from a
  `refs/holt/*` ref. Holt does not push those refs, classify secrets, or promise erasure when a ref
  is removed; Git may retain unreachable objects until garbage collection. Treat the repository
  object database and anything that backs up `.git` as part of the capture trust boundary.
