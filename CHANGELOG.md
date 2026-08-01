# Changelog

## Unreleased

- **Security — `holt graph --html` was HTML-injectable.** Worktree paths, branch names, file
  paths and symbol names were interpolated raw into the document, so a branch containing
  `</script>` closed the script block and the rest of the page became attacker-authored markup.
  Every value is now encoded for the sink it lands in, the page builds its SVG through DOM APIs
  instead of `innerHTML`, and invisible/bidirectional control characters are neutralised at the
  boundary. Names are no longer mangled to stay safe, either — the old renderer stripped
  `< > &` out of visible labels.
- Release bodies live in `.github/releases/` and are gated: a release whose body carries no
  usable install command now fails CI instead of shipping.

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
