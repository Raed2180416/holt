# Changelog

## Unreleased

**`holt ci` could go green on no evidence. Two ways, both fixed.** Both are behaviour changes
that can turn a previously-green build red — which is the point: in each case the green was the
bug.

- **A pull request could neutralise the policy that gates it.** The policy was read from the
  WORKING TREE, which in a PR is the candidate's own copy: a branch whose only change was
  `rm .holt/policy.json` turned a failing gate into a passing one. `.holt/policy.json` is now
  read from the BASE ref, the way GitHub reads CODEOWNERS — a change may propose rules, it may
  not enact them upon itself. The working tree remains the fallback when the base carries no
  policy (adopting one for the first time still works), but such a policy is marked untrusted
  and may only ADD failures: it can never switch off `--fail-on-unlanded`. A base that declares
  a policy whose content cannot be read is a refusal, never "no policy".
- **A shallow checkout made the gate pass on zero evidence.** `actions/checkout` defaults to
  `fetch-depth: 1`; with no history there is nothing to compare, so holt found no unlanded work
  and reported a pass — most reassuring exactly where it knew least. `holt ci` now detects a
  shallow or grafted repository and REFUSES with exit 2 and a message naming `fetch-depth: 0`.

## 0.2.0

**Landing and enforcement.** The analysis layer became something you can act on.

- `holt order` — landing order from the evidence graph: exact parallel lanes (connected
  components over proven and predicted interactions), a min-entanglement sequence within each
  entangled lane, and the specific later merges to watch at every step.
- `holt partition --agents N` — the pre-flight split. Disjoint, weight-balanced directory
  buckets with every already-contested file assigned exactly one owner.
- `holt branches` — the branch graveyard, classified by content rather than ancestry.
  Squash-merged branches (content landed, ancestry broken) are detected and reported with
  evidence; `--apply` deletes only the provably-landed bucket, with `-d`, never `-D`.
- `holt journal` — append-only audit of every protect, rescue, clean and branch deletion,
  stored in the common git directory so it survives worktree deletion.
- `holt ci` — the merge gate. Report-only by default; `--fail-on-unlanded`, `--max-age-days`
  and `--ignore` are explicit policy. A branch that could not be classified fails the gate
  rather than passing it. Ships with a reusable GitHub Action.
- **Zero-touch protection** — `holt integrate` now wires session-start hooks that lock at-risk
  worktrees before an agent's first tool call, so a repository is protected without anyone ever
  running the CLI.
- `holt license` and the Team tier: policy as code (`.holt/policy.json`), multi-repo fleet view,
  and journal export. Licenses verify offline against an Ed25519 public key; holt still makes no
  network calls, on any tier.
- Three new MCP tools: `holt_landing_order`, `holt_branches`, `holt_partition`.
- `holt doctor` prints per-platform install commands for optional backends.

**Internal:** the mutation harness now runs in an isolated copy of the repository with a
tripwire on the live tree, after a mutation was found to make a refusal-assertion test execute
the very command it was asserting would be refused.

## 0.1.0

First release. Content-relationship scanning across git worktrees and jj workspaces: risk,
collisions, duplicates, context digests, landing plans, impact pairs, the safety trio
(protect / rescue / clean), `verify`, the TUI, the MCP server, and `holt integrate`.
