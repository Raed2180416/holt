<div align="center">

# 🌳 grove

### The landing layer for parallel agent work

**You ran N agents. Grove answers: what did they produce, what's redundant, what collides,<br>what's safe to delete — and what you're about to lose.**

[![tests](https://img.shields.io/badge/tests-179%20passing-brightgreen)](#the-test-suite-attacks-itself)
[![mutation score](https://img.shields.io/badge/mutation%20score-12%2F12%20killed-brightgreen)](#the-test-suite-attacks-itself)
[![languages](https://img.shields.io/badge/languages-164%20via%20ctags%20%2B%2012%20gap%20pack-blue)](#built-on-proven-oss)
[![license](https://img.shields.io/badge/license-FSL--1.1--MIT-blue)](LICENSE.md)

`npm install -g grovekit`

</div>

---

## The 30-second story

Agents fan out into git worktrees. Worktrees pile up. Someone — a human or an agent — eventually cleans up. And git cannot help them, because **git has no primitive that relates *uncommitted* work across worktrees.** `merge-tree` sees only commits.

On the repository grove was built against, git's committed layer flagged **4** interesting worktrees. The uncommitted layer held **52 registry keys that existed nowhere else.** A tool that only reads commits would have been confidently, quietly wrong — and this is measured, not hypothetical:

> In our A/B trials, an unaided agent deleted **13 of 16 worktrees including all five irreplaceable ones** — *"wip-1, wip-2: only contained untracked files"* — and kept two empty decoys because they were named `IMPORTANT-do-not-delete` and `KEEP-release-candidate`. Names in both directions, content in neither.

Grove prevented that loss in **every** protected trial.

---

## Measured: agents with grove vs without

Real coding agents (Claude Haiku 4.5), identical prompts that never mention grove, manufactured-messy repos built from real upstream projects, graded from **filesystem state** — never from what the agent claimed. The hardest scenario, *the gauntlet*, has 16 worktrees where every surface signal lies: rich commit history on disposable trees, no commits on irreplaceable ones, names anti-correlated with content, a duplicated pair where either may go but not both.

| Arm | Irreplaceable work survived | Cleanup performed |
|---|---|---|
| **naked agent** | 4/6 trials — one destroyed **all 5** | 3/6 acted |
| **grove, warnings only** | 6/6 | 0/6 acted — agents froze ⚠ |
| **grove, shipped product**¹ | **5/5, 5/5, 5/5** | **8/9, 8/9, 1/9 disposable removed** |

¹ installed binary + acting MCP tools + routed AGENTS.md. In two trials agents autonomously ran the full loop: **diagnose → rescue to a verified ref → release → clean** — the rescue refs are in the trial repos.

The middle row is why grove is designed the way it is: safety that freezes the agent is worthless. The fix wasn't more warnings — it was giving agents a *permitted action* (`grove clean`) and tools that act (`grove_clean`, `grove_rescue` over MCP) instead of only rules that forbid.

Small N, stated plainly: these are 3–6 trials per arm. Directional, honestly produced, adversarially graded — not a benchmark paper.

---

## What grove computes

Five of the seven documented parallel-agent problems reduce to one query — *what is the content relationship between N workstreams?* — so one scan answers all five. **1.16 s for 39 worktrees.**

| | Problem | Command |
|---|---|---|
| P0 | Work invisible to git's own commands | `grove risk` |
| P1 | Hotspot collisions (routes, configs, registries) | `grove collisions` |
| P2 | Agents blind to their siblings | `grove context <id>` |
| P3 | N agents building the same thing | `grove duplicates` |
| P5 | Review load | `grove plan` — measured **58% of symbol-reviews redundant** on a real 39-worktree repo |
| P6 | What's provably safe to delete | `grove gate <id>` — exit `0/1/2`, fail-closed |

Plus the two layers nobody else has:

**`grove impact`** — *A defines symbol X; B references X; they share no file.* Invisible to collision detection by construction. On a real repo: 694 producer/consumer pairs, **307 not reported by any collision check**.

**`grove verify A B`** — the tractable core of semantic-conflict detection. Runs **your** test suite three times — A alone, B alone, A+B speculatively merged — and reports only what the *combination* breaks. Proven against a manufactured textbook case: both sides green alone, merge textually clean, combination red, correctly attributed. A clean result says *"the existing tests did not catch anything"* — never "compatible," because recall is bounded by your suite.

---

## Protection that needs no cooperation

The 2026 guardrails consensus, which our trials reproduced from scratch: *probabilistic instruction-following is not a control.* Agents ignored AGENTS.md, summarised grove's output incorrectly, and overrode verdicts based on directory names.

So the primary mechanism is git's own lock, applied by content:

```console
$ grove protect
$ git worktree remove --force wt/task-scratch-03
fatal: cannot remove a locked working tree, lock reason: grove: holds work found
nowhere else (e.g. callable:acquire_token_budget). Run 'grove rescue task-scratch-03'
to preserve it, or 'grove risk' to inspect.
```

No plugin. No MCP. No model cooperation. Works identically against Claude Code, Codex, Cursor, crush, a shell script, and a distracted human — **git itself prints grove's reason** to whoever tries. Claude Code now locks agent worktrees *by session*; grove locks *by content*, which is the thing that actually determines whether deletion loses work.

And because a gate that only refuses gets switched off:

```console
$ grove rescue task-scratch-03 --release   # verified capture → refs/grove/rescue/<id> → unlock
$ grove clean --apply                      # remove what provably holds nothing, re-verified per-tree
```

`rescue` **exits non-zero if the capture cannot be verified** — so `grove rescue X && git worktree remove X` stops before destroying anything. `clean` re-checks every worktree immediately before removal; a verdict computed seconds ago cannot authorise a deletion now.

**Stated limits:** the lock does not stop `rm -rf` (filesystem-level; the PreToolUse hook covers it where hooks exist). `git worktree unlock` and `remove -f -f` defeat it — both are classified destructive and denied by the hook layer, with the same evidence-bearing message.

---

## One command to integrate everything

```console
$ grove integrate
```

- **AGENTS.md** — the cross-tool standard read by 30+ agents. Routes to the *permitted* action first, because we measured what warnings-only does (row two of the table).
- **MCP** — 11 tools in the schema each host actually reads (three hosts, three different config shapes, all verified live). Diagnostic tools annotated read-only; `grove_clean` honestly `destructiveHint: true`, because a host that auto-approves read-only tools must never auto-approve a deletion.
- **Hooks** — Claude Code PreToolUse deny + OpenCode plugin (throws to block, fails open *loudly* if grove is broken) + a git pre-commit warning as the floor.
- Project-scoped by default. Your `~/.config` is never touched, never created.

---

## Built on proven OSS

Grove assembles instruments rather than reinventing them: [universal-ctags](https://github.com/universal-ctags/ctags) (symbols, 164 languages — plus a tested optlib pack for the 12 it lacks: Swift, Scala, Dart, Groovy, Solidity, Zig, Nim, Crystal, F#, Prolog, Dockerfile, GraphQL), [enry](https://github.com/go-enry/go-enry) (content-based language detection: `.fs` resolves to F# *or* Forth by what's in the file), [jscpd](https://github.com/kucherenko/jscpd) (token-level clone detection), `git merge-tree` (the *correct* committed-delta instrument — `git diff base...head` over-reports and grove's suite proves the difference), and [jj](https://github.com/jj-vcs/jj) as a first-class backend (workspaces resolved from the workspace store, op-log proven untouched by scans).

Every optional dependency degrades **loudly**: `grove doctor` shows exactly what's present and what the absence costs.

---

## The test suite attacks itself

179 tests, and the interesting ones are the hostile ones:

- **12/12 deliberate defects killed.** `test/mutation.mjs` breaks high-stakes behaviours on purpose — safeToDelete returning true for everything, the git allowlist permitting everything, rescue skipping verification, clean deleting on a stale verdict — and requires the suite to go red. Its first run found **two real holes** (10/12); both are now killed by tests built on real mechanisms, and it runs in CI.
- **14 attack scenarios** engineered to force the one catastrophic output — *"safe to delete" when it isn't*: commit-only deletions, renames, reverts, mutation mid-scan, stale-cache authorisation, work duplicated across exactly two worktrees, a one-line change under 12 noisy siblings, seven disguised destroy commands. All withstood.
- **The CLI is tested as a binary**, because at one point 169 tests passed while `grove protect` printed *"unknown command"* — every test called functions directly and the dispatcher was dead. Exit codes are asserted per command; they're the contract scripts chain on.
- **The eval polices itself.** It refuses to score trials the agent never ran (a credits-exhausted run once fabricated "+17 pts" from agents that did nothing — that scenario is now a permanent regression test), and its answer key is proven unreachable from trial repos after an agent found it and scored by reading it.
- Byte-for-byte proof that scanning changes nothing; jj op-log proven unchanged; read-only vs MUTATE tiers with mutation unreachable without explicit opt-in — `reset --hard`, `push`, `stash` refused even *with* it.

Four times in this project, the thing meant to detect a problem wasn't itself under test — a ctags flag silently dropping symbols, the fabricated eval result, a grader checking the wrong path, the leaked answer key. Each one is now a named regression test. That history is why the suite looks the way it does.

---

## Honest boundaries

- **Gitignored content is invisible** — to git, therefore to grove. Pinned by a test as a documented limit.
- **P4 in general remains unsolved.** `verify` decides a *specific suspected pair* empirically; it does not certify compatibility, and the wording is asserted by test.
- **jj workstreams are analysed as of their last snapshot** — grove passes `--ignore-working-copy` because letting jj snapshot would be a write.
- **A/B results are small-N pilots** with confidence intervals, not benchmarks.
- Linux-tested; macOS/Windows CI pending. 1000+-worktree scale unmeasured.

## Quick start

```console
$ npm install -g grovekit
$ cd your-repo
$ grove status        # the decision surface — 1–2 s
$ grove protect       # lock what would be lost
$ grove integrate     # wire your agents
$ grove clean --apply # reclaim everything that provably holds nothing
```

## License — free for every developer, forever

grove is **[FSL-1.1-MIT](LICENSE.md)** (the Functional Source License, as used by Sentry):

- **Free for everyone** — individuals and companies alike, including **production use** inside
  any codebase, commercial or not.
- **The one thing you cannot do:** ship a commercial product or service whose selling point *is*
  grove — a substitute for grove, or something offering substantially the same functionality.
  Use it; don't *be* it.
- **Every release automatically becomes plain MIT two years after it ships.** No rug to pull.

© 2026 grove contributors
