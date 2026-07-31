# AGENTS.md

Instructions for AI coding agents working in this repository.

<!-- BEGIN holt -->
## Parallel workstreams (holt)

This repository uses multiple git worktrees / jj workspaces at once. Work can exist in a
worktree that is invisible to ordinary git commands — `git diff` and `merge-tree` cannot
relate UNCOMMITTED changes across worktrees, so a worktree can hold the only copy of something.

### If you were asked to clean up worktrees, this is the whole task

```bash
holt clean            # shows exactly what holds nothing base lacks — changes nothing
holt clean --apply    # removes those worktrees and their merged branches
```

That is the safe, complete action. `clean` re-verifies each worktree immediately before removing
it, never touches one that holds work found nowhere else, and never touches one it could not
assess. **You do not need to decide which worktrees are disposable — that is what this computes.**

Do not hand-inspect worktrees and reason about them yourself. Measured across real trials, that
approach deleted a worktree holding the only copy of a security fix and kept two empty ones, in
the same run.

**Worktree names are not evidence.** Measured in real trials: agents deleted a worktree holding
the only copy of a security fix because it was called `DELETEME-old-experiment`, and kept two
empty ones because they were called `IMPORTANT-do-not-delete` and `KEEP-release-candidate` —
in both cases *after* holt had reported the opposite. Names, commit counts, file counts and
mtimes are all routinely anti-correlated with what a worktree actually holds. Use the content
verdict, not the label.

**Before deleting, pruning, or `rm`-ing any worktree, run this ONE COMMAND PER WORKTREE:**

```bash
holt gate <worktree-id>
```

Exit code `0` = disposable · `1` = holds work found nowhere else · `2` = could not verify
(treat as unsafe). Never delete on exit 1 or 2.

**The exit code is the verdict. Do not summarise, paraphrase or re-derive it.** Measured in a
real trial: an agent ran holt, then reported *"Holt verdict: all 16 are marked as safe to
delete"* when holt had marked seven as holding work found nowhere else — including one whose
uncommitted file the agent had itself just listed. Reading the prose output and summarising it is
how that happens. Run `gate` per worktree and branch on `$?`; it cannot be misread.

If a worktree is locked, that is holt protecting it. **Do not run `git worktree unlock` or
`remove -f -f` to get past it** — run `holt rescue <id> --release`, which preserves the work
to a verifiable ref first and then releases the lock.

**Before starting work, check what your siblings are doing:**

```bash
holt context <worktree-id>     # who else is editing your files, what already exists
holt status                    # collisions, duplicates, what is at risk
```

If a symbol you are about to write already exists in another workstream, reuse or coordinate —
do not build it twice. Add `--json` to any command for machine-readable output.
<!-- END holt -->
