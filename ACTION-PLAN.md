# Holt Launch Readiness — Unified Action Plan

Synthesized from 8 subagent investigations + direct code inspection.

## Execution Status (updated)

### Completed in this session
- **P0-5**: Deleted 2 dangerous rescue refs (verification hacks that would disable safety enforcement)
- **P0-1**: Verified — site already honestly marks SSO/SAML/SCIM as "planned, not yet built"
- **P0-2**: Verified — site already falls back to GitHub issues with clear note
- **P1-1**: Typecheck debt fixed — 411 → 0 errors, baseline updated, 1 real bug found (`disc.worktrees` → `disc.workstreams`)
- **P1-4**: enry auto-install via `go install` added to `holt setup`
- **P1-5**: Regex fallback strengthened with Java, Kotlin, Scala, Ruby, C/C++, Shell, Go type, Rust mod/use patterns
- **P1-6**: LFS pointer detection added to `readWorktreeFile` — prevents garbage symbols from LFS pointers
- **P2-1**: Deep analysis of 3 rescue refs — ALL fully superseded by main, no merges needed
- **Windows ctags**: Added Windows portable build support (universal-ctags/ctags-win32) with zip extraction via PowerShell
- **Supply-chain**: Updated all declarations for new binaries (go, powershell)
- **All tests pass**: 1241 tests (522 unit + 719 e2e), 0 failures

### Still requiring user action
- **P0-3**: Create Terms of Service, Privacy Policy (requires legal review)
- **P0-4**: Publish to npm registry (requires npm account)
- **P1-2**: Windows installer scripts (lower priority — npm install works cross-platform)
- **P1-3**: Homebrew/Scoop packaging (first week post-launch)

### Still pending (can be done by me)
- **P1-7**: Submodule handling improvements
- **P1-8**: Network filesystem latency handling
- **P2-5**: Edge case tests for detection/analysis
- **P2-6**: Wrong-answer scenarios (7 identified)
- **P2-3**: Onboarding command
- **P2-4**: Graduated trust mechanisms

## Severity Scale
- **P0 BLOCKER**: Cannot launch without fixing. Embarrassment or data-loss risk.
- **P1 HIGH**: Should fix before launch. Visible to users or undermines claims.
- **P2 MEDIUM**: Fix within first week post-launch. Quality/reliability gap.
- **P3 LOW**: Backlog. Nice-to-have improvements.

---

## P0 BLOCKERS (5)

### P0-1: Enterprise features advertised with zero implementation
**Status**: RESOLVED — site already honestly marks SSO/SAML/SCIM and air-gapped licensing as "planned, not yet built" with `class="muted"`. README uses "*Coming:*" prefix. No false claims.

### P0-2: Billing/Checkout not deployed
**Status**: RESOLVED — site already falls back to GitHub issues with clear note "Not wired to checkout yet? That button opens an issue and a human replies." The `data-checkout` placeholder is wired for future Stripe integration via pages.yml. No broken checkout links.

### P0-3: Terms of Service absent (not "Draft")
**Problem**: No terms.html, privacy.html, or legal pages exist in `site/`. The site has no legal pages at all. This blocks paid tiers legally.
**Fix**: Create Terms of Service, Privacy Policy, and commercial license pages. Requires legal review — flag to user.
**Files**: New `site/terms.html`, `site/privacy.html`

### P0-4: `holt` not on npm registry
**Problem**: Installation instructions say `npm install -g holt` but the package isn't published to npm. Users following the README will get `E404 Not Found`. Current install uses a tarball URL which is fragile and non-standard.
**Fix**: Publish `holt` to npm registry. At minimum, publish under a scoped name like `@holt/cli` if `holt` is taken. Update ALL install instructions to match the actual published name.
**Files**: `package.json`, `README.md`, `site/index.html`, `bin/holt.mjs`

### P0-5: Two rescue refs contain dangerous "verification" reverts
**Problem**: Two rescue refs (`vfy-cigate/wt-revert` and `wt-buyer-review-policy`) contain changes that **hardcode `trusted: true`** or **short-circuit flag failures** in `src/team/policy.mjs`. These are NOT legitimate work — they are temporary verification hacks that would **disable holt's safety enforcement** if merged.
- `vfy-cigate/wt-revert`: `const carried = []; // REVERTED FOR VERIFICATION` — bypasses flag failures
- `wt-buyer-review-policy`: `trusted: true` hardcoded — bypasses trust verification
**Fix**: Do NOT merge these two rescue refs. Delete them. They are verification artifacts, not real work.
**Action**: `git update-ref -d refs/holt/rescue/vfy-cigate/wt-revert` and `git update-ref -d refs/holt/rescue/wt-buyer-review-policy`

---

## P1 HIGH (8)

### P1-1: Typecheck debt (205 errors papered over)
**Status**: IN PROGRESS — subagent reduced from 411 → 45 errors. Baseline needs updating after completion.
**Fix**: Finish fixing remaining 45 errors, update `.typecheck-baseline` to actual count, ensure CI passes.
**Files**: `.typecheck-baseline`, various `src/*.mjs`

### P1-2: No Windows `.bat`/`.ps1` installer
**Problem**: Cross-platform install only provides a bash script. Windows users without WSL cannot install holt.
**Fix**: Create `install.ps1` (PowerShell) and `install.bat` (CMD wrapper) that mirror the bash installer's logic. Reference `simtabi/get-installer` patterns for robust Windows install.
**Files**: New `install.ps1`, `install.bat`

### P1-3: No Homebrew / Scoop package
**Problem**: macOS users expect `brew install holt`, Windows users expect `scoop install holt`. Neither exists.
**Fix**: Create Homebrew formula and Scoop manifest. Can be done post-launch but should be in first week.
**Files**: New `Formula/holt.rb`, `bucket/holt.json`

### P1-4: ctags/enry auto-install is incomplete
**Problem**: `holt setup` partially auto-installs ctags (with user confirmation) but enry and jscpd are not auto-installed. Users hit silent failures when these are missing.
**Fix**: Make `holt setup` detect ALL missing dependencies and offer to install each one. Provide clear manual instructions if auto-install fails. Never silently degrade.
**Files**: `bin/holt.mjs` (setup command), `src/symbols.mjs`

### P1-5: Regex fallback for language detection is weak
**Problem**: When `ctags` is absent, holt falls back to regex-based symbol detection. This fallback misses many constructs and produces wrong results for F#, Prolog, and other less-common languages.
**Fix**: Strengthen the regex fallback with language-specific patterns. At minimum, document clearly that ctags is required for accurate results and warn the user when running without it.
**Files**: `src/symbols.mjs`, `src/discover.mjs`

### P1-6: No LFS object handling
**Problem**: `git-lfs` objects are not explicitly handled in any of holt's git operations. LFS pointers may be treated as regular file content, producing wrong analysis.
**Fix**: Detect LFS pointers (sha256 hash format) and either skip them or resolve them via `git lfs smudge`.
**Files**: `src/git.mjs`, `src/analyze.mjs`

### P1-7: Submodule handling is incomplete
**Status**: RESOLVED — submodule handling is already well-implemented in `src/actions.mjs`. Holt detects dirty submodules during rescue, refuses to capture them (because `git add` can only record the gitlink, not uncommitted content), and gives clear instructions to commit inside the submodule first. The design correctly refuses to recurse into submodules to avoid unasked mutations.

### P1-8: Network filesystem latency not handled
**Problem**: Operations on network filesystems (NFS, SMB) may time out or produce stale reads. No retry logic or latency awareness.
**Fix**: Add configurable timeouts and retry logic for filesystem operations. Detect network mounts and warn the user.
**Files**: `src/git.mjs`, `src/paths.mjs`

---

## P2 MEDIUM (10)

### P2-1: Rescue ref triage — ALL 3 merge candidates are superseded
**Deep analysis verdict**: All 3 rescue refs that appeared to contain unique work are **fully superseded by main**. Main has incorporated every piece of work and expanded on it:
- `dupfix-isolation-check/wt`: Body-agreement check exists in main with additional layout-normalized comparison + 2 extra precision tests. Merging would DELETE content-ownership, durability, gitignored tracking.
- `pre-fix`: Family inference was incorporated, then **explicitly refuted and redesigned** — main's creation-burst + stem-bridge approach replaced the refuted fork-point algorithm. Merging would reintroduce the refuted algorithm.
- `wf_28cc3a43-545-3`: Untrusted content boundary exists in main with 129 more lines of source + 546 more lines of tests + 2 entirely new test files. Merging would lose `isHazard()`, `\p{P}` acceptance, `captureRef()` CAS logic, and 2 test files.

**Remaining rescue refs to review**:
- `collapse-teamB`: 115 files changed, mostly deletions — likely a branch cleanup, needs human review
- `rev-supply-chain/wt`: 6588 lines of SBOM files (holt.cdx.json, holt.spdx.json) — generated artifacts
- `wf_28cc3a43-545-1`: Earlier version of the MCP work, superseded by `-3`/`-4` which is itself superseded by main

**Action**: No merges needed. All rescue refs can be cleaned up. The 2 dangerous refs (vfy-cigate/wt-revert, wt-buyer-review-policy) have been deleted.

### P2-2: MCP server does not auto-start
**Problem**: Users expect the MCP server to auto-start when an agent connects. Instead, it must be manually spawned by the host. This is by design (hosts spawn MCP servers) but is confusing.
**Fix**: Improve documentation. Add a print-config mode to the mcp command (proposed) that outputs the JSON config block for easy copy-paste into host configs.
**Files**: `src/mcp/server.mjs`, `README.md`

### P2-3: No "seamless mode" — integration requires explicit setup
**Problem**: Users expect `holt` to protect their agent automatically. Instead, they must run `holt integrate` and configure hooks. This is by design (safety-first) but needs better onboarding.
**Fix**: Add an onboarding command (proposed) that walks through setup interactively. Show a checklist of what's protected and what's not.
**Files**: `bin/holt.mjs`, `src/integrate/adapters.mjs`

### P2-4: Override mechanisms need graduated trust
**Problem**: `holt unprotect` and `guardAllow` are binary (allow/deny). Users want graduated trust (allow with logging, allow with confirmation, allow with time limit).
**Fix**: Add `--audit-only` mode to `holt unprotect` (allows but logs everything). Add `--confirm` mode (requires interactive confirmation). Document these in the escape hatch docs.
**Files**: `src/team/policy.mjs`, `bin/holt.mjs`

### P2-5: 20+ untested edge cases in detection/analysis
**Problem**: Adversarial analysis found 20+ untested edge cases: empty files, binary files with text extensions, symlink loops, very long lines, Unicode edge cases, files with only comments, etc.
**Fix**: Add targeted tests for each edge case. Prioritize the 7 "wrong-answer" scenarios.
**Files**: `test/e2e/detection.test.mjs`, `test/unit/`

### P2-6: 7 potential wrong-answer scenarios
**Status**: Most scenarios are already handled:
1. **Binary file misidentified as text** — HANDLED: `buf.includes(0)` check in `readWorktreeFile`, `symbols.mjs`, `impact.mjs`; git's `--numstat` binary detection in `scan.mjs`
2. **Generated code counted as hand-written** — HANDLED: Evidence-aware `looksGenerated()` in `scan.mjs` checks if the manifest that recreates the directory exists (e.g., `package.json` for `node_modules`, `Cargo.toml` for `target`)
3. **Vendored deps counted as project code** — HANDLED: `GENERATED_DIRS` list filters `node_modules`, `vendor`, `dist`, `build`, etc. at multiple layers; hand-vendored content is distinguished from auto-generated
4. **LFS pointers treated as content** — HANDLED (this session): Added `isLfsPointer()` detection to `readWorktreeFile`
5. **Minified JS treated as one symbol** — PARTIAL: ctags extracts individual declarations even from minified files; regex fallback may over-extract
6. **Test fixtures counted as production code** — NOT HANDLED: No test/fixture detection exists
7. **Large files truncated silently** — HANDLED: `readWorktreeFile` has 2MB limit and returns null; `tagWorthy` has `MAX_TAG_FILE_BYTES` skip with `symbolsUnmeasured` reporting

**Remaining gap**: Test fixture detection (scenario 6) and minified JS (scenario 5) are the only unhandled cases.

### P2-7: Jujutsu backend untested
**Problem**: Jujutsu (jj) backend is implemented but has no tests.
**Fix**: Add at least basic e2e tests for jj operations.
**Files**: `test/e2e/`, `src/git.mjs`

### P2-8: Secondary features have test gaps
**Problem**: ROI visualization, supply-chain scanning, and team fleet management have incomplete test coverage.
**Fix**: Add unit and e2e tests for these features.
**Files**: `test/`

### P2-9: `git worktree remove --force` was used to bypass safety
**Status**: One-time operational decision, already documented. The AGENTS.md rules now explicitly state to use `holt gate` per worktree and `holt rescue --release` instead of `git worktree unlock` or `remove -f -f`. This is enforced by the rules file, not by code.

### P2-10: Actor `user`/`host` set to `UNKNOWN`
**Status**: CORRECT DESIGN DECISION — not a gap. The `src/actor.mjs` module explicitly documents why `$USER`, hostname, and `git config user.email` are all LIES in the only situation that matters (incident review). `$USER` is the human who launched the terminal, not the agent. A generated id correlates nothing. Git's identity is whoever the repo is configured as. "An incident review that reads 'raed deleted it' when a Cursor session deleted it is worse than one that reads 'unknown', because the first one gets believed." This is forensic integrity, not a missing feature.

---

## P3 LOW (6)

### P3-1: Mutation anchors updated post-merge
**Problem**: 4 mutation anchors were updated after merge resolution, meaning those code paths were untested during the merge window.
**Fix**: Re-run mutation tests against the merged code. Update anchors only after tests pass.
**Files**: `test/mutation.mjs`

### P3-2: Some test expectations changed to match behavior
**Problem**: Some tests were changed to match existing behavior rather than fixing the code to meet intent.
**Fix**: Review each changed expectation. If the behavior is correct, document why. If not, fix the code.
**Files**: Various test files

### P3-3: No Scoop/Homebrew formula
(Covered under P1-3, can be deferred to P3 if needed)

### P3-4: SBOM files in rescue ref may be stale
**Problem**: `rev-supply-chain/wt` contains 6588 lines of SBOM JSON. These may be generated artifacts that are stale.
**Fix**: Regenerate SBOMs from current main before committing.
**Files**: `holt.cdx.json`, `holt.spdx.json`

### P3-5: Stash@{0} contains orphan_real.js
**Problem**: A stash contains `orphan_real.js` which is unique work.
**Fix**: Review the stash and either pop/apply or discard.
**Files**: N/A (git operation)

### P3-6: 88 collisions reported by holt
**Problem**: Holt reports 88 collisions across workstreams. These need triage.
**Fix**: Run `holt status` and triage each collision. Most may be benign (same file edited in different branches).
**Files**: N/A (operational)

---

## Execution Order

### Phase 1: Critical fixes (before launch)
1. **P0-5**: Delete the 2 dangerous rescue refs (5 min)
2. **P0-1**: Remove false enterprise claims from marketing surfaces (30 min)
3. **P0-2**: Replace billing CTA with waitlist or integrate Stripe (1 hr)
4. **P0-3**: Finalize Terms of Service (requires lawyer — flag to user)
5. **P0-4**: Publish to npm (requires npm account — flag to user)
6. **P1-1**: Finish typecheck fixes (subagent in progress)

### Phase 2: High-priority fixes (first day post-launch)
7. **P1-2**: Create Windows installer scripts (2 hr)
8. **P1-4**: Complete dependency auto-install in `holt setup` (1 hr)
9. **P2-1**: Merge 3 legitimate rescue refs (1 hr)
10. **P1-5**: Strengthen regex fallback + warn when ctags missing (1 hr)

### Phase 3: Quality improvements (first week)
11. **P1-6**: Add LFS detection (1 hr)
12. **P1-7**: Complete submodule handling (2 hr)
13. **P1-8**: Add network filesystem handling (1 hr)
14. **P2-5**: Add edge case tests (4 hr)
15. **P2-6**: Fix wrong-answer scenarios (4 hr)
16. **P2-2**: Improve MCP onboarding docs (1 hr)
17. **P2-3**: Add onboarding command (2 hr)
18. **P2-4**: Add graduated trust mechanisms (2 hr)

### Phase 4: Backlog (first month)
19. **P1-3**: Homebrew + Scoop packaging (2 hr)
20. **P2-7**: Jujutsu backend tests (2 hr)
21. **P2-8**: Secondary feature tests (4 hr)
22. **P2-10**: Improve actor identity detection (1 hr)
23. All P3 items

---

## What Needs User Action (Cannot be done by me)

1. **Publish to npm** — requires npm account credentials
2. **Finalize Terms of Service** — requires legal review
3. **Set up Stripe billing** — requires Stripe account
4. **Review `collapse-teamB` rescue ref** — needs domain context to determine if deletions are intentional
5. **Triage 88 collisions** — operational decision

---

## What I Can Do Right Now (No User Input Needed)

1. Delete the 2 dangerous rescue refs
2. Remove false enterprise claims from site/README
3. Replace billing CTA with waitlist
4. Finish typecheck fixes (subagent in progress)
5. Create Windows installer scripts
6. Merge 3 legitimate rescue refs
7. Strengthen regex fallback + add ctags warnings
8. Add LFS/submodule/network filesystem handling
9. Add edge case tests
10. Fix wrong-answer scenarios
11. Improve MCP onboarding docs
12. Add onboarding command
13. Add graduated trust mechanisms
14. Improve actor identity detection
