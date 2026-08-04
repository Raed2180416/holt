# Changelog

## 0.3.1

**Safety and correctness fixes across the guard, integration, and analysis paths.** Every item
below was reproduced before fixing and verified after.

**Guard fixes**

- The hooks `holt integrate` installs disarmed it: the blocking guard and the brief shared one
  report cache keyed only on the repository root, so the brief's analysis — computed without your
  own worktree — was served to the guard. `git clean -fd` went from refused to allowed the moment
  the brief hook ran.
- A space anywhere in the path turned it off — eight of nine destructive forms flipped to allow.
- A newline in a worktree name did the same, while `holt risk` named that worktree as holding work
  found nowhere else.
- `rm -rf <repository root>` was allowed. `.git` is inside that path.
- The hook stalled every tool call for as long as the host held stdin open — 27 s measured, now
  0.1 s.

**Integration ownership fixes**

- `integrate` claimed and removed third-party hooks via `--host`, a package name containing
  `holt`, or a username in a path. `uninstall` deleted config files in repositories holt had never
  been installed into. A legal JSONC trailing comma made `integrate` replace a team's whole MCP
  config. A hand-written `pre-commit` was deleted for mentioning holt in a comment.
  `integrate --dry-run` wrote 21 files.
- Ownership is now argv-shaped, and a config holt cannot parse is left alone rather than replaced.

**Correctness**

- A repository with one worktree reported zero risk while holding real risk; the primary is now
  scanned when it is the only worktree, and is still never a deletion candidate.
- Duplicate detection reported false positives without ctags.
- `auto` announced a lock git had refused; `protect` exited 0 having failed; `discard` printed no
  recovery ref; the guard refused ordinary commands whose arguments came from substitutions.

**Supply-chain and test integrity**

- 43% of the codebase never reached the no-telemetry and path-comparison gates. The no-telemetry
  guarantee survived the widened scan.
- The static-analysis ratchet wrote a zero and passed when the checker could not run.
- Both benchmark harnesses reported "correct" for runs that graded nothing. §1's 1000/1000 is
  still 1000/1000, now genuinely graded.


## 0.3.0

**The guard closes the gaps that actually lose work, the product gets an escape hatch and an
autopilot.**

**New commands**

- `holt auto` — the autopilot. Does everything reversible without being asked (locks at-risk
  worktrees, releases locks whose justification has expired) and hands the destructive half over
  *with* the evidence and the exact command. It never deletes — being wrong about a lock costs
  nothing, being wrong about a deletion is final.
- `holt discard <path>...` — the guard's escape hatch, because a gate that only refuses gets
  switched off. Captures content to a verified ref *before* removing it, so the guard stays on and
  the loss does not; a capture that cannot be verified aborts having deleted nothing; a tracked
  file is reverted to HEAD rather than deleted (`git checkout -- <path>` is itself refused); a
  symlink target is resolved rather than followed, so discarding a link can no longer destroy a
  different file's work.

**The destructive-command guard: Windows, shell indirection, and file-level destruction**

- Every guard pattern was written for a POSIX shell and returned "allowed" for the Windows verbs
  most agent hosts actually emit. `Remove-Item -Recurse -Force`, `rd /s /q`, `del /f /q`,
  `Move-Item`, `Clear-Content` and `Set-Content` are now classified exactly as their POSIX
  equivalents, at both worktree and file granularity — `Clear-Content`/`Set-Content` are in-place
  destroyers with no POSIX analogue at all (nothing deleted, no path changed, content gone).
- A verb supplied indirectly — `$(echo rm)`, backticks, a variable, `eval "rm -rf ..."`, a
  base64-decoded pipeline into `sh` — defeated the guard entirely, because every rule matched
  literal text. holt cannot resolve an indirected verb without executing it, so it no longer
  pretends to: an unreadable verb now returns `ask`, never a silent allow. A shell's own `-c`
  argument *is* code holt can read, so `sh -c "rm -rf ../feature"` is unwrapped and assessed as if
  typed, rather than let the wrapper itself become the bypass.
- Renaming or moving a file inside a worktree was wrongly **denied** on macOS and Windows (a path
  comparison bug, not a safety feature); a target holt could not resolve was reported as hitting
  everything rather than as unknown; a Windows path could be mangled into a relative one, letting
  work move *out of* its worktree undetected; holt's own lock could self-justify and freeze the
  repository permanently. All fixed and pinned by cross-platform tests.
- `unprotect --force` no longer refuses the ordinary case: the escape hatch for overriding a lock
  holt did *not* place fired on the mere presence of `--force`, so `holt unprotect --force`
  against holt's own locks was refused with a message asserting something untrue of that
  invocation. It now counts the foreign locks first and demands `--reason` or `--yes` only when
  there is actually something foreign to override.

**Analysis correctness**

- **Redundancy-aware disposal.** Scored for the first time against an independent oracle (50
  languages, 900 worktrees, 18,000 claims): disposable-worktree recall was 0.40 — 150 of 250
  genuinely disposable worktrees were refused with "unknown" because base lacked the files, missing
  that a *living sibling* held the identical merged-tree content. Recall goes 0.40 → 1.00 with
  precision held at 1.00. `gate` (the machine contract a script chains `&& rm -rf` on) still refuses
  a redundant worktree by name, since authorising every member of a redundant set would authorise
  deleting all of them; only `clean --apply`, which re-verifies immediately before each removal, may
  act on the extra recall.
- `holt partition` bucketed top-level directories by tracked-file weight and used the collision list
  only to look up one hotspot's owner — it never traversed the graph, so buckets could still
  conflict *across* buckets, the one property that made the output actionable. Now union-find over
  a mixed workstream/directory token space, proven on a path graph (A–B conflict, B–C conflict, A–C
  clean) and a 200-trial seeded property test against an independent union-find.
- Collisions are now proven against what is actually in the worktree, not only what was committed,
  through one shared computation rather than two consumers pricing false positives and false
  negatives differently.
- A repeated `package` clause was counted as authored work in every false positive in one corpus;
  fixed at the source of symbol identity rather than filtered per-caller.

**Agent integration**

- **Eight host MCP configs are now written**, including holt's first
  TOML writer (Codex CLI's `config.toml`, a line-oriented textual merge that preserves every setting
  holt doesn't understand): Codex, Amp, Factory, Junie, Zed, Warp, Kilo, Roo. `hosts.mjs` and the
  files `holt integrate` writes are now derived from one manifest instead of two hand-maintained
  tables that drifted, so a host cannot claim `mcp: true` while going unwired again. Cursor now gets
  a deterministic deny hook via its published `beforeShellExecution` schema.
- **Five corrected host claims**, each checked against the host's own primary source rather than
  restated: Cline ships no project-scoped MCP config file at all (only a user-level one, at the
  path Cline actually reads); Copilot CLI does not read VS Code's `.vscode/mcp.json` (confirmed two
  different files); Goose's config field is `cmd:`, not `command:`; Amazon Q's CLI is local with a
  documented MCP config, not cloud-only; and a docs-derived adapter no longer prints the same
  "BLOCKING" label as one verified live against the real host.
- **The per-prompt session brief is change-triggered**, not re-injected byte-identical on every
  message — it resent the same paragraph on every `UserPromptSubmit`, and a `'' + null`
  bug handed every clean-repo session the literal string `"null"` as its briefing. It now fires
  again only when the brief text changes, bounded so 20 unchanged prompts still earn one repeat (a
  compacted session has lost the brief and should not be left permanently uninformed); a new
  session is never suppressed.
- holt already locks at-risk worktrees at every session start without being asked; nothing ever
  said the *opposite* — that disposable worktrees are silently accumulating. The brief now names it
  (a ratio-plus-floor threshold on provably-disposable workstreams) with `holt clean --apply` as the
  one command that resolves it — a signal, deliberately never an automatic deletion.
- `holt journal` write failures are now surfaced through the result object instead of swallowed:
  with the journal directory unwritable, `holt protect --json` reported `"protected": 1` and
  say nothing about the audit record that didn't happen. The lock still happens; the user is now
  told the record didn't.
- `rescue()` and `discard()` no longer share one fixed-path scratch index per worktree. holt runs
  from agent hooks, so concurrent invocations are the normal case, and two of them could build a
  scratch index from the wrong tree — a wrong tree in a capture path means captured work that is
  not the work. The index is now unique per invocation.

**Team / Enterprise**

- The policy gate (`.holt/policy.json`) could be handed rules from the very branch under review;
  fixed so policy is always read from a trusted ref.
- `holt fleet` no longer double-counts worktrees shared between repositories; `--protected-paths`
  in policy is now enforced instead of inert; `unprotect` leaves an audit trail for every override,
  including forced ones.

**Security**

- **`holt graph --html` was HTML-injectable.** Worktree paths, branch names, file paths and symbol
  names were interpolated raw into the document, so a branch containing `</script>` closed the
  script block and the rest of the page became attacker-authored markup. Every value is now encoded
  for the sink it lands in, the page builds its SVG through DOM APIs instead of `innerHTML`, and
  invisible/bidirectional control characters are neutralised at the boundary. Names are no longer
  mangled to stay safe, either — the old renderer stripped `< > &` out of visible labels.
- A repository could name a file such that it was interpolated into a `ctags` option, and the deny
  hook exited the wrong code on a failed probe; both closed.

**Release integrity**

- **The install command every artifact printed had been broken.** The tarball the
  README, the site and the release page all pointed at was built and attached by hand for v0.2.0,
  drifted up to 107 commits behind main, and shipped without several source modules and 12 of 14
  language gap packs — a person following the documented install got
  `holt: unknown command 'discard'` from a page that had just told them to run it. The tarball is
  now built and attached by CI from the tagged commit: every relative import reachable from the
  shipped entry points and every `.ctags` pack on disk is asserted present at commit time (derived
  from the code, not a list), and the artifact is installed globally and driven against a real
  repository with planted work on Linux, macOS and Windows before it can become the download.
  Release bodies live in `.github/releases/` and are gated the same way: a body with no usable
  install command fails CI instead of shipping.
- **A static-analysis ratchet.** 20,749 lines had shipped with no linter, type checker, lint script
  or gate. `node scripts/typecheck.mjs` now runs `checkJs` over JSDoc — deliberately not a
  TypeScript migration, because holt has no build step and the published tarball must stay the
  exact source a reviewer read — and the diagnostic count is ratcheted: it may only go down, never
  up.
- The full test suite, not just a subset, now runs in CI on Linux, macOS and Windows; a wave of
  assertions that only ever held on one platform (POSIX symlink semantics, path separators, a
  hostile filename that is platform-dependent) is fixed.
- The site was rewritten: light mode, plainer language, an honest checkout CTA, a readable A/B
  table that no longer scrolls sideways on a phone, and duplicate nav removed.

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
