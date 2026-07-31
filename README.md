# grove

**The landing layer for parallel agent work.**

You ran N agents. Now: what did they actually produce, what's redundant, what collides, what's
safe to delete, and what are you about to lose?

```bash
npx grovekit status
```

```
grove · /home/you/project
  base      main (local-ahead-of-origin) d71852f1
  symbols   universal-ctags 6.2.1 + enry (content-based language detection)
  scanned   39/39 workstreams in 14 families

DECISIONS

     9  at risk        unique work that exists ONLY uncommitted — git cannot see this
    10  hold           unique committed work base lacks
   307  collisions     workstream pairs that will fight over the same content
   459  duplicates     pairs that built the same thing
     2  disposable     provably nothing to lose
```

---

## The problem

Seven problems are documented in parallel-agent development. **Five of them are the same query** —
*what is the content relationship between N parallel workstreams?* — so grove answers all five
from one graph.

| | Problem | grove |
|---|---|---|
| **P0** | Work invisible to git's own relationship commands | `grove risk` |
| **P1** | Hotspot collisions (routes, configs, registries) | `grove collisions` |
| **P2** | Context blindness — agents can't see siblings | `grove context <id>` |
| **P3** | Redundant work — N agents building one thing | `grove duplicates` |
| **P5** | Review bottleneck | `grove plan` |
| **P6** | Nothing knows what's safe to delete | `grove gate <id>` |

P4 (semantic conflict) is **deliberately not attempted**. It is unresolved research, and a
confident wrong answer there is worse than no answer.

### The finding that justifies the tool

Git has no primitive that relates **uncommitted** work across worktrees. `merge-tree` sees only
commits. On the repository grove was built against, the committed layer flagged **4** interesting
worktrees — while the uncommitted layer held **52 registry keys absent from base**.

A tool that scanned only the committed layer would have been confidently, quietly wrong.

---

## Install

```bash
npm install -g grovekit
```

Optional, and grove says which are missing rather than degrading silently:

| Tool | Gives you | Without it |
|---|---|---|
| [universal-ctags](https://github.com/universal-ctags/ctags) ≥6.0 | 164 languages of symbol extraction | regex fallback, reduced coverage |
| [enry](https://github.com/go-enry/enry) | content-based language detection for `.fs` `.m` `.h` `.pl` … | extension mapping — wrong for ambiguous files |
| [jscpd](https://github.com/kucherenko/jscpd) | token-level clone detection (`--deep`) | symbol-identity duplicates only |

```bash
grove doctor      # what's available, and the live safety contract
```

---

## Agent integration

```bash
grove integrate
```

Wires grove into every agent it finds, on three levels:

1. **AGENTS.md** — universal awareness. The [Linux Foundation AAIF](https://agentsmd.net) standard
   read by 30+ agents (Codex, Cursor, Copilot, Gemini CLI, Aider, Zed, Windsurf, Jules, Devin…).
2. **MCP** — universal tools. One command writes the server entry into every host config present.
3. **Hooks** — deterministic enforcement where supported (Claude Code, OpenCode, git hooks).

The point of the hook layer: an agent about to destroy work is **stopped**, not warned.

```
$ echo '{"tool_name":"Bash","tool_input":{"command":"git worktree remove wt/feature-x"}}' \
    | grove hook pre-tool-use --host claude-code

{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
 "permissionDecisionReason":"grove blocked this: git worktree remove would destroy work that
  exists nowhere else.\n  • feature-x: 3 uncommitted file(s); 12 symbol(s) found nowhere else
      e.g. callable:parseManifest, value:ARC_RETRY_BUDGET"}}
```

Any agent that can run a subprocess gets the same thing:

```bash
grove gate <id>     # exit 0 disposable · 1 holds unique work · 2 could not verify
grove brief         # sibling-workstream context as plain text
```

---

## Commands

```
grove status              decisions, not an inventory                    (default)
grove risk                unique work + what's provably disposable       (P0, P6)
grove collisions          pairs that will fight                          (P1)
grove duplicates [--deep] pairs that built the same thing                (P3)
grove context <id>        what your siblings are doing                   (P2)
grove plan                drop / collapse / land-in-this-order           (P5)
grove graph --html g.html interactive relationship graph
grove gate <id>           pre-delete gate, exit-code contract
grove integrate           wire into every agent found here
grove doctor              environment + live safety contract
grove mcp                 run as an MCP server over stdio
```

`--json` on everything. `--base <ref>`, `--cwd <path>`, `--strict-read-only`, `--no-symbols`.

---

## Safety

**grove never modifies the repository it inspects.** That is enforced, not asserted:

- every git invocation passes an allowlist classifier (`src/git.mjs`);
- mutating subcommands, mutating *flags*, and mutating *positional forms*
  (`git config k v`, `git symbolic-ref HEAD ref`, `git branch name`) are refused before spawn;
- repo-redirecting global flags (`--git-dir`, `-c`, `--work-tree`) are refused;
- no command is ever built by string interpolation — `execFile` with an argv array, so a file
  named `--force` is data, not an option;
- `test/unit/safety.test.mjs` runs a full scan against a repo with uncommitted work and asserts
  **byte-for-byte** that nothing changed.

One qualification, stated rather than hidden: `merge-tree --write-tree` writes *unreferenced*
objects into `.git/objects` (git GCs them). It touches no ref, index, worktree or config. It is
the only correct way to answer "what does base LACK from this branch" — `git diff base...head`
answers a different question and over-reports whenever base already acquired the content another
way. `--strict-read-only` avoids the object write and labels its output approximate.

---

## How it decides

| Question | Instrument |
|---|---|
| What does base lack? | `git merge-tree --write-tree`, then diff base against the merged tree |
| What's uncommitted? | `git status` + `git diff HEAD`, **per worktree** — the layer git can't relate |
| What did this ADD? | symbols(worktree file) − symbols(base file), via ctags |
| Which language? | enry (Linguist's classifier) for ambiguous extensions, else extension |
| Will these two fight? | file-overlap prefilter → `merge-tree` on the pair → symbol overlap |
| Is this boilerplate? | inverse document frequency — a symbol in >25% of workstreams carries no pair information |

**Fail-closed everywhere.** A workstream grove could not scan is reported `unknown`, never `safe`.
A cleanup tool that says "safe" because it failed to look is the worst possible defect.

**Nothing is filtered silently.** `report.filtering` states the rule, the count dropped, and
examples.

---

## Review load: the honest number

Counting workstreams was measuring the wrong thing. A reviewer does not read workstreams, they
read *changes* — and the same change appears in many workstreams. `grove plan` reports both:

```
39 workstreams  ->  -2 disposable  -0 duplicate  ->  37 to land

reviewing PR-by-PR:  351 file-reviews, 6999 symbol-reviews
actually distinct:   151 files (-57%), 2931 symbols (-58%)
of those symbols: 1017 novel (need real review) · 1914 corroborated (read once, then compare)
```

That is a measurement, not a promise: it says what the redundancy **is**. The saving is realised
by a reviewer who uses the grouping.

## Testing

```bash
npm test                          # 121 tests
scripts/clone-fixtures.sh         # 4 real upstream repos
npm run test:e2e
```

Two rules govern the suite:

**1. Prove the instrument can detect presence before trusting its silence.** Every detector is
asserted first on a case that must be found, then on a negative control. A suite that only
checked "no false positives" would pass with every detector returning `[]`.

**2. Attack it.** `test/e2e/break-it.test.mjs` is not written to confirm grove works — it is
written to force the one catastrophic failure: *grove says safe to delete, and it is not.*
14 attacks, each from a real thing agents do: commit-only-deletions, uncommitted deletions,
symbol renames, file moves, reverts, mutation *during* a scan, stale-cache authorisation,
coincidental name collisions, a one-line change buried under 12 noisy workstreams, and seven
disguised forms of the destroy command. Plus the inverse — a gate that blocks harmless commands
gets switched off and protects nothing.

Also covered:

- **33 languages**, each asserted by name, including the 12 universal-ctags 6.2.1 does not ship
  (Swift, Scala, Dart, Groovy, Solidity, Zig, Nim, Crystal, F#, Prolog, Dockerfile, GraphQL) —
  covered by `src/optlib/grove.ctags`.
- **Ambiguous extensions by content**: `.fs` resolves to F# *or* Forth, `.m` to Objective-C *or*
  MATLAB, by what the file actually contains.
- **Adversarial git states**: filenames with spaces/quotes/unicode, a file literally named
  `--force`, vanished worktrees, detached HEAD, merge-in-progress, empty repos, symlink loops,
  submodules, binary/huge/generated files, 24-workstream load.
- **Real repositories** in Python, Go, Rust and JavaScript, with planted multi-agent damage.
- **MCP over the real wire protocol** — a spawned server, hand-rolled JSON-RPC client,
  initialize → tools/list → tools/call, including recovery from bad input.
- **The OpenCode plugin driven as OpenCode drives it**, and `opencode debug config` asserted to
  actually discover it.
- **jj**: workspaces discovered with resolved paths, and the operation log asserted unchanged —
  grove must not snapshot a jj repo just by reading it.
- **The instrument check**: a worktree whose content base *already has* must be reported
  disposable. `--strict-read-only` is asserted to get that case *wrong*, proving the two
  instruments genuinely differ and the documented caveat is real.

### Known limits, stated rather than hidden

- **Gitignored content is invisible.** git cannot see it, so neither can grove. Pinned by a test
  so it is a documented boundary, not a surprise.
- **jj workstreams are analysed as of their last snapshot.** grove passes
  `--ignore-working-copy` everywhere, because letting jj snapshot would be a *write*.
- **Semantic conflicts (P4) are not attempted.** Two changes that merge cleanly and break at
  runtime are unresolved research; a confident wrong answer there is worse than none.

---

## What exists already, and what doesn't

Verified against the tools themselves, not their marketing:

| Tool | What it does | Relates N worktrees by content? |
|---|---|---|
| [gwq](https://github.com/d-kuro/gwq) | per-worktree status dashboard | no |
| [treehouse-worktree](https://github.com/mark-hingston/treehouse-worktree) | create/list/status/remove/lock via MCP | no |
| [agent-worktree](https://github.com/nekocode/agent-worktree) | `wt clean` removes worktrees with no diff from base; **skips dirty ones** | no |
| WorktreeWise | pairwise diff viewer for humans | no |
| Vibe Kanban · Conductor · Superset · Nimbalyst | session orchestration; card = worktree = agent | no |
| [jscpd](https://github.com/kucherenko/jscpd) | clone detection within a tree | no (grove uses it) |

The category is crowded at the **management** layer and empty at the **relationship** layer.
grove does not compete with any of the above — it answers the question they all leave open.

## License

MIT
