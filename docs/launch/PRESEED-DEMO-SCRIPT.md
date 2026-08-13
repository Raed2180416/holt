# Holt 90-second pre-seed demo script

**Purpose:** founder-led application video and live diligence opener
**Evidence command (source checkout):** `node scripts/run-preseed-demo.mjs --json`
**Rule:** record from the exact public candidate artifact; do not splice output from an older tag

The demo is intentionally narrow. It proves that Holt follows repository content rather than a
worktree's reassuring or alarming name, keeps preview non-mutating, moves only the measured-empty
fixture into locked quarantine, returns restore argv, and restores the same HEAD and byte digest.
It does **not** prove customer demand, universal host enforcement, productivity lift, or enterprise
readiness.

## Before recording

1. Show the exact candidate version and source/tag SHA.
2. Run `node scripts/run-preseed-demo.mjs --json` once without recording and require `"passed": true`.
3. Confirm all checks pass. The script applies and restores only inside its newly created temporary
   fixture; never point the demo at a user repository.
4. Use a large terminal font and keep the founder's face/voice primary for accelerator videos that
   ask to meet the founder rather than watch a polished product reel.

## Shot-by-shot narration

### 0-12 seconds — the problem

> Coding agents made it cheap to run several implementation threads at once. But Git state is not
> one clean branch per agent: the only copy of useful work may be modified, untracked, ignored, or
> sitting in another worktree before CI ever sees it.

On screen: two worktree labels only:

- `DELETEME-old-experiment`
- `IMPORTANT-do-not-delete`

### 12-28 seconds — the negative control

> Names, timestamps, and branch counts are seductive but unsafe. In this isolated real Git
> repository, the scary-looking worktree holds a tracked edit, an untracked note, and an ignored
> `.env`. The important-looking worktree is actually empty.

On screen: the `plantedLayers` list from the JSON output.

### 28-52 seconds — exact action authority

> Holt inspects the bytes across the repository. `gate` exits one for the worktree that holds work
> and zero for the one proven removable. The exit code is the action verdict; advisory collision or
> similarity signals never get promoted into destructive authority.

On screen, reveal only:

```text
DELETEME-old-experiment     exit 1     holds_work
  modified: src/base.js
  untracked: notes/only-copy.md
  ignored: .env

IMPORTANT-do-not-delete    exit 0     removable_now
```

### 52-76 seconds — recovery-first cleanup

> The preview keeps the unique work and selects only the measured-empty worktree. Then the isolated
> fixture executes the real transaction: Holt re-verifies, moves that worktree into locked local
> quarantine, returns exact restore argv, and restores it. The HEAD and byte digest match before,
> during, and after. No file or branch is deleted.

On screen: `cleanPreview`, `transaction.restoreArgv`, the three matching digests, and `restored`.

### 76-90 seconds — company and honest gap

> Holt is the transaction and recoverability layer for parallel coding agents: local,
> provider-independent, and inspectable. The product exists, but I have not marketed it and I do
> not claim customer traction. This round funds the proof that matters next—outside installations,
> witnessed action changes, repeat use, and a paid evaluation boundary.

End card:

```text
Holt
transaction + recoverability for parallel coding agents
[current public demo URL]  [repository/release URL]
```

## Two-minute live follow-up

If an investor asks for more, show these in order:

1. `status --json`: one repository-wide evidence view.
2. Both `gate` exit codes: exact destructive decision.
3. `clean --json`: dry-run quarantine plan.
4. `clean --apply`, `quarantines`, and `restore` evidence from the isolated fixture.
5. The limitation ledger: no adoption claim, no universal cloud-agent enforcement, and current
   public-release SHA/version stated explicitly.

Do not spend the follow-up on command count, line count, test count, or speculative dashboard
mockups. The demo's value is one counterintuitive, independently rerunnable decision.
