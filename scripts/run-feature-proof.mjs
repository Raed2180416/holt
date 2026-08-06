#!/usr/bin/env node
// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * Holt feature-proof runner.
 *
 * This is deliberately stricter than `npm test`:
 *   - every test file is enumerated by path (a zero-match glob cannot pass);
 *   - every command is mandatory and runs without a harness timeout;
 *   - a TAP skip/todo/cancellation invalidates the artifact;
 *   - the source identity is measured before and after the run;
 *   - stdout/stderr are retained in full, not summarized away;
 *   - the artifact is write-once and receives a SHA-256 sidecar.
 *
 * A valid artifact is bounded evidence for the exact source, runtime, fixtures, and platform it
 * names. It is never a claim that Holt is universally correct or live-verified in every host.
 *
 * Usage:
 *   node scripts/run-feature-proof.mjs --plan
 *   node scripts/run-feature-proof.mjs --out ~/.cache/holt-feature-proof/proof.json
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { HOSTS } from '../src/integrate/hosts.mjs';
import { __test as mcp } from '../src/mcp/server.mjs';
import { discover } from '../src/discover.mjs';
import { scan } from '../src/scan.mjs';
import { deepDuplicates, detectJscpd } from '../src/deep.mjs';
import { backdateWorktreeCreation, newRepo } from '../test/fixtures.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE_ENV_OVERRIDES = Object.freeze({
  NO_COLOR: '1', FORCE_COLOR: '0', LC_ALL: 'C', LANG: 'C', TZ: 'UTC',
  GIT_TERMINAL_PROMPT: '0',
});

/** Commands printed in the COMMANDS, ACTING, and AGENT INTEGRATION sections of `holt --help`. */
export const CLI_COMMANDS = [
  'status', 'risk', 'collisions', 'hotspots', 'duplicates', 'context', 'plan', 'impact',
  'order', 'partition', 'branches', 'journal', 'forensics', 'fleet', 'license', 'managed-policy', 'ci', 'graph',
  'stash', 'gate', 'tui', 'setup', 'doctor', 'audit', 'auto', 'protect', 'unprotect', 'rescue',
  'rescued', 'clean', 'quarantines', 'restore', 'purge', 'discard', 'verify', 'hosts', 'providers',
  'integrate', 'uninstall', 'brief', 'mcp', 'hook',
];

const T = (pathName, title) => ({ path: pathName, title });

/**
 * User-visible feature inventory. `tests` names the closest independent executable oracle, not
 * merely a file that imports the implementation. `gap` is mandatory: absence of a known gap is
 * not evidence that no gap exists.
 */
export const FEATURES = [
  {
    id: 'discovery-and-source-layers', area: 'core-analysis',
    interfaces: ['cli:status', 'cli:scan'],
    tests: [T('test/e2e/detection.test.mjs', 'discovery: finds every worktree, and the primary is excluded by default'), T('test/e2e/adversarial.test.mjs', 'ADVERSARIAL: detached HEAD is scanned normally')],
    oracle: 'Git porcelain plus independently planted committed, uncommitted, untracked, ignored, detached, deleted, and moved states.',
    gap: 'No finite fixture set proves every Git layout, filesystem, object store, or future Git version.',
    evidence: ['complete-test-corpus', 'git-runtime'],
  },
  {
    id: 'risk-and-content-identity', area: 'core-analysis',
    interfaces: ['cli:risk', 'mcp:holt_at_risk'],
    tests: [T('test/e2e/destructive-authority.test.mjs', 'AUTHORITY: identical bytes at different paths are different work'), T('test/e2e/break-it.test.mjs', 'ATTACK: work hidden ONLY inside a .gitignore-d path')],
    oracle: 'Exact path, Git mode/type, object identity, and direct byte manifests independent of symbol extraction.',
    gap: 'Unsupported or unmeasured semantic equivalence is retained as risk; it is not inferred away.',
    evidence: ['complete-test-corpus', 'mutation-fingerprint'],
  },
  {
    id: 'disposition-gate', area: 'core-analysis',
    interfaces: ['cli:gate', 'mcp:holt_check_workstream'],
    tests: [T('test/e2e/cli.test.mjs', 'CLI: `gate` exit codes are the documented contract'), T('test/e2e/break-it.test.mjs', 'ATTACK: a stale cache must not authorise a deletion')],
    oracle: 'Fresh report lookup with exact exit-code assertions and planted sole-copy/redundant/unknown states.',
    gap: '`gate` cannot re-verify a later unrelated rm invocation; recoverable `clean --apply` is the rechecking action path.',
    evidence: ['complete-test-corpus', 'guard-corpus'],
  },
  {
    id: 'collision-analysis', area: 'core-analysis',
    interfaces: ['cli:collisions', 'mcp:holt_collisions'],
    tests: [T('test/e2e/detection.test.mjs', 'P1 PRESENCE: a real registry conflict is detected AND proven by merge-tree'), T('test/e2e/detection.test.mjs', 'P1 PRECISION: a pair git PROVES merges cleanly is not a conflict')],
    oracle: 'Git merge-tree for committed combinations plus independently planted uncommitted same-hunk conflicts.',
    gap: 'Predicted uncommitted overlap is evidence, not a merge-conflict certificate; runtime interactions need `verify`.',
    evidence: ['complete-test-corpus', 'mutation-fingerprint'],
  },
  {
    id: 'hotspot-analysis', area: 'core-analysis',
    interfaces: ['cli:hotspots', 'mcp:holt_hotspots'],
    tests: [T('test/e2e/detection.test.mjs', 'P1 HOTSPOT: merge-unknown shared files remain visible as an aggregate'), T('test/unit/partition.test.mjs', 'partition: full collision evidence feeds hotspots even when the visible list is filtered')],
    oracle: 'Set intersection over independently planted changed-file manifests.',
    gap: 'A shared file is deliberately not called a conflict; hotspots rank review attention only.',
    evidence: ['complete-test-corpus'],
  },
  {
    id: 'duplicate-analysis', area: 'core-analysis',
    interfaces: ['cli:duplicates', 'mcp:holt_duplicates'],
    tests: [T('test/e2e/detection.test.mjs', 'P3 RECALL: the same function reformatted in two worktrees is still duplicate work'), T('test/e2e/detection.test.mjs', 'P3 PRECISION: two workstreams that coincidentally pick the same name for unrelated work are not duplicates')],
    oracle: 'Planted same-body and same-name/different-body controls across independently timed dispatch families.',
    gap: 'Symbol/body and optional token-clone evidence do not prove semantic equivalence for all languages.',
    evidence: ['complete-test-corpus', 'mutation-fingerprint'],
  },
  {
    id: 'deep-token-clone-analysis', area: 'core-analysis',
    interfaces: ['option:--deep', 'mcp-option:holt_duplicates.deep', 'backend:jscpd'],
    tests: [T('scripts/run-feature-proof.mjs', 'DEEP BACKEND: renamed added-line clone is found, unrelated work stays absent, and same-workstream clones stay excluded'), T('test/unit/package-contents.test.mjs', 'package: every shipped bare import is declared and optional imports are load-time degradable')],
    oracle: 'Three real worktrees with planted renamed cross-dispatch clone, unrelated negative control, and same-workstream clone, graded from jscpd output ownership.',
    gap: 'The mandatory proof needs the optional jscpd backend; token clones remain review candidates and do not prove semantic equivalence.',
    evidence: ['deep-runtime', 'complete-test-corpus'],
  },
  {
    id: 'language-and-parser-backends', area: 'core-analysis',
    interfaces: ['backend:universal-ctags', 'backend:enry', 'backend:regex-fallback', 'cli:doctor'],
    tests: [T('test/unit/languages.test.mjs', 'language coverage: every case yields its named symbols'), T('test/unit/languages.test.mjs', 'COMPAT: every pack is loadable by this ctags and defines what it claims'), T('test/e2e/adversarial.test.mjs', 'ADVERSARIAL: same extension, different languages, resolved by CONTENT')],
    oracle: 'Named source declarations across the measured language corpus plus ambiguous-extension files whose content selects different parsers.',
    gap: 'Coverage is the named corpus on the installed backend versions; generated syntax, future grammars, and every language construct remain outside it.',
    evidence: ['complete-test-corpus', 'git-runtime'],
  },
  {
    id: 'strict-read-only-analysis', area: 'core-analysis',
    interfaces: ['option:--strict-read-only'],
    tests: [T('test/e2e/strict-read-only.test.mjs', 'STRICT-READ-ONLY: writes zero objects, on a fixture proven to write objects otherwise'), T('test/e2e/strict-read-only.test.mjs', 'STRICT-READ-ONLY: degraded verdicts are labelled approximate, never presented as measured')],
    oracle: 'Git object counts before/after strict and non-strict positive-control scans plus confidence labels on planted committed deltas.',
    gap: 'Strict mode intentionally over-reports some committed deltas and is not an equivalence-preserving substitute for the normal instrument.',
    evidence: ['complete-test-corpus', 'git-runtime'],
  },
  {
    id: 'bounded-analysis-and-honest-degradation', area: 'core-analysis',
    interfaces: ['contract:analysis-bounds', 'option:--limit', 'option:--no-symbols'],
    tests: [T('test/e2e/no-symbols.test.mjs', '--no-symbols: safety decisions and Git-proven conflicts equal a full scan while symbol findings are explicitly absent'), T('test/e2e/no-symbols.test.mjs', '--no-symbols: a fresh CLI scan bypasses the planted symbol backend; the positive control reaches it'), T('test/e2e/break-it.test.mjs', 'ATTACK: a file too large to tag reads as "no symbols" instead of "not measured"'), T('test/e2e/stash-evidence.test.mjs', 'STASH: more than MAX_ENTRIES entries → truncated flag is set and describeStash warns'), T('test/e2e/mcp.test.mjs', 'MCP: every list-returning tool SAYS when it capped the list')],
    oracle: 'Paired full/file-only scans over planted disposable, at-risk, duplicate, and conflicting work, plus a fresh-process symbol-backend boundary trap and fixtures that cross every named bound.',
    gap: '`--no-symbols` deliberately omits unique-symbol, semantic-overlap, duplicate, and impact evidence; the backend-bypass control proves avoided extraction work, not a universal wall-clock or token saving.',
    evidence: ['no-symbols-contract', 'complete-test-corpus'],
  },
  {
    id: 'sibling-context', area: 'core-analysis',
    interfaces: ['cli:context', 'mcp:holt_context'],
    tests: [T('test/e2e/detection.test.mjs', 'P2 PRESENCE: the digest names the sibling contesting the same file'), T('test/e2e/cli.test.mjs', 'SCRIPTABILITY: context exits non-zero for an unknown id, zero for a real one')],
    oracle: 'Fixture workstream identity plus known sibling file/symbol overlap.',
    gap: 'Context is a measured snapshot; it cannot predict writes made after the call.',
    evidence: ['complete-test-corpus'],
  },
  {
    id: 'dependency-impact', area: 'core-analysis',
    interfaces: ['cli:impact', 'mcp:holt_impact'],
    tests: [T('test/e2e/impact.test.mjs', 'IMPACT PRESENCE: finds a producer/consumer pair that shares NO file'), T('test/e2e/real-repos.test.mjs', 'REAL REPOS: the exact pinned four-repository corpus was exercised')],
    oracle: 'A producer defines and a separate consumer references a planted symbol while sharing no file.',
    gap: 'Static symbol references cannot see every reflective, generated, data-driven, or runtime dependency.',
    evidence: ['complete-test-corpus'],
  },
  {
    id: 'review-plan', area: 'coordination',
    interfaces: ['cli:plan', 'mcp:holt_landing_plan'],
    tests: [T('test/e2e/detection.test.mjs', 'P5: the plan drops disposables, collapses duplicates, and orders the rest'), T('test/e2e/detection.test.mjs', 'P5 COLLAPSE: exact fan-out copies collapse only when every copy is durable')],
    oracle: 'Known disposable, exact durable duplicate, unique, and entangled workstreams in one fixture.',
    gap: 'The plan is advisory and cannot know product priority or reviewer intent.',
    evidence: ['complete-test-corpus'],
  },
  {
    id: 'landing-order', area: 'coordination',
    interfaces: ['cli:order', 'mcp:holt_landing_order'],
    tests: [T('test/unit/order.test.mjs', 'SEQUENCING: co-located pairs entangle the ORDER even though triage hides them'), T('test/unit/order.test.mjs', 'order: deterministic across runs on identical input')],
    oracle: 'Synthetic evidence graphs with known connected components and deterministic tie breaks.',
    gap: 'Least-entangled-first is a heuristic, never a proof that the resulting software is correct.',
    evidence: ['complete-test-corpus'],
  },
  {
    id: 'agent-partition', area: 'coordination',
    interfaces: ['cli:partition', 'mcp:holt_partition'],
    tests: [T('test/unit/partition.test.mjs', 'partition: buckets are disjoint and cover every top-level segment'), T('test/unit/partition.test.mjs', 'partition: PROPERTY — no two conflicting workstreams land in different buckets')],
    oracle: 'Seeded random graphs checked for disjoint coverage, ownership, and conflict co-location.',
    gap: 'Without explicit task paths/components, Holt returns `insufficient_task_context` and labels the output as an advanced structural view; even an anchored map does not infer a complete task decomposition or developer expertise.',
    evidence: ['complete-test-corpus'],
  },
  {
    id: 'branch-graveyard', area: 'coordination',
    interfaces: ['cli:branches', 'mcp:holt_branches'],
    tests: [T('test/e2e/branches.test.mjs', 'BRANCHES: landed vs content-landed vs unlanded, classified by content not ancestry'), T('test/e2e/actions.test.mjs', 'CLEAN ATTACK: an unmerged branch must not be silently deleted')],
    oracle: 'Git ancestry and tree-content comparisons against planted merge, squash, unique, and checked-out branches.',
    gap: 'Content-landed and unknown branches are review findings; Holt does not auto-delete them.',
    evidence: ['complete-test-corpus'],
  },
  {
    id: 'stash-risk', area: 'core-analysis',
    interfaces: ['cli:stash'],
    tests: [T('test/e2e/stash-evidence.test.mjs', 'TREE ENTRY AUTHORITY: an exact reachable path/mode/type/object relaxes drop and clear'), T('test/e2e/actions.test.mjs', 'CATASTROPHIC: stash drop/clear are destructive; pop remains recovery')],
    oracle: 'Planted stash trees compared directly with reachable Git trees.',
    gap: 'Corrupt or unreadable stash objects remain unknown rather than receiving an all-clear.',
    evidence: ['complete-test-corpus'],
  },
  {
    id: 'status-risk-and-brief', area: 'core-analysis',
    interfaces: ['cli:brief'],
    tests: [T('test/e2e/brief-cadence.test.mjs', 'BRIEF: the per-prompt hook speaks once, then stays quiet until something changes'), T('test/e2e/cli.test.mjs', 'FIRST RUN: `holt brief` never fabricates a clean bill when the scan could not answer')],
    oracle: 'Repository fingerprint changes and explicit unknown/at-risk fixtures.',
    gap: 'Concise output necessarily omits lower-priority rows; full JSON/status retains the denominator.',
    evidence: ['complete-test-corpus'],
  },
  {
    id: 'relationship-graph', area: 'visualization',
    interfaces: ['cli:graph'],
    tests: [T('test/e2e/graph-html.test.mjs', 'GRAPH LEGIBILITY: no label is drawn on top of another'), T('test/e2e/graph-html.test.mjs', 'HTML INJECTION: EVERY string in the report is inert'), T('test/unit/ascii-graph.test.mjs', 'render: stays BOUNDED at scale')],
    oracle: 'DOM-level hostile-string checks, geometric label intersection checks, and graph-edge/node invariants.',
    gap: 'Automated geometry and injection checks are not a broad human usability study or every-browser run.',
    evidence: ['complete-test-corpus'],
  },
  {
    id: 'interactive-tui', area: 'visualization',
    interfaces: ['cli:tui'],
    tests: [T('test/e2e/tui.test.mjs', 'TUI: the frame shows the story a human needs'), T('test/e2e/tui.test.mjs', 'TUI: the overflow counter is never negative, never zero, and never exceeds the total')],
    oracle: 'Exact terminal frames at bounded dimensions plus keyboard-action state transitions.',
    gap: 'Snapshot/PTY coverage does not prove rendering in every terminal emulator or assistive technology.',
    evidence: ['complete-test-corpus', 'portable-denominator'],
  },
  {
    id: 'pair-verification', area: 'coordination',
    interfaces: ['cli:verify'],
    tests: [T('test/e2e/verify.test.mjs', 'VERIFY: reports the interaction, attributed to the COMBINATION'), T('test/e2e/verify.test.mjs', 'VERIFY: an already-red suite is NOT reported as an interaction')],
    oracle: 'A/B/A+B Git merges executing a planted user test whose failure exists only in the combination.',
    gap: 'It executes user code and only observes the supplied test command; an incomplete suite remains incomplete.',
    evidence: ['complete-test-corpus'],
  },
  {
    id: 'protect-auto-unprotect', area: 'actions-recovery',
    interfaces: ['cli:protect', 'cli:auto', 'cli:unprotect', 'mcp:holt_protect'],
    tests: [T('test/e2e/actions.test.mjs', 'PROTECT ATTACK: does a locked worktree actually survive --force?'), T('test/e2e/actions.test.mjs', 'PROTECT ATTACK: -f -f still overrides, and we must not pretend otherwise'), T('test/e2e/actions.test.mjs', 'AUTO: does every lossless thing by itself, and refuses to delete anything'), T('test/e2e/unprotect-force.test.mjs', 'UNPROTECT --force CLI: bare --force (no --reason, no --yes) is refused before anything changes')],
    oracle: 'Real Git worktree locks challenged by force removal, foreign lock ownership, and landing convergence.',
    gap: 'Git documents double-force override; Holt reports this and relies on host guards for covered commands.',
    evidence: ['complete-test-corpus', 'guard-corpus', 'mutation-fingerprint'],
  },
  {
    id: 'rescue-and-inventory', area: 'actions-recovery',
    interfaces: ['cli:rescue', 'cli:rescued', 'mcp:holt_rescue'],
    tests: [T('test/e2e/actions.test.mjs', 'RESCUE ATTACK: the work is restorable AFTER the worktree is destroyed'), T('test/e2e/git-execution-boundary.test.mjs', 'GIT BOUNDARY: rescue captures pre-filter bytes exactly without starting the configured program')],
    oracle: 'Independent read-back of every captured path, Git type, mode, object id, and byte digest from the rescue ref.',
    gap: 'Dirty submodules are refused rather than falsely captured; recovery then needs explicit user handling.',
    evidence: ['complete-test-corpus', 'guard-corpus', 'mutation-fingerprint'],
  },
  {
    id: 'clean-quarantine-restore', area: 'actions-recovery',
    interfaces: ['cli:clean', 'cli:quarantines', 'cli:restore', 'mcp:holt_clean'],
    tests: [T('test/e2e/actions.test.mjs', 'CLEAN ATTACK (TOCTOU): work appearing DURING the run must abort that delete'), T('test/e2e/actions.test.mjs', 'CLEAN RECOVERY: first-class restore preserves protection that predated quarantine'), T('test/e2e/cli.test.mjs', 'CLI: `clean --apply` reports recoverable quarantine and explicit zero deletion')],
    oracle: 'Real registered worktree identity, late-write races, lock continuity, byte survival, and exact restore argv.',
    gap: 'Quarantine retains disk usage by design until a separately proven physical purge is exposed and chosen.',
    evidence: ['complete-test-corpus', 'guard-corpus', 'mutation-fingerprint'],
  },
  {
    id: 'guarded-discard', area: 'actions-recovery',
    interfaces: ['cli:discard'],
    tests: [T('test/e2e/actions.test.mjs', 'DISCARD: nested empty directories do not dead-end recoverable cleanup'), T('test/e2e/actions.test.mjs', 'DISCARD: a many-leaf generated tree is captured without exhausting object writers'), T('test/e2e/actions.test.mjs', 'DISCARD: binary content is captured byte-for-byte before removal'), T('test/e2e/actions.test.mjs', 'DISCARD RACE: a same-name replacement created after capture is never erased'), T('test/e2e/actions.test.mjs', 'DISCARD: restoring a tracked executable proves content, type, and executable mode')],
    oracle: 'Pre-removal ref capture independently compared by bytes/type/mode/path across empty-directory shape, 384 sole-copy leaves, binary data, and post-capture replacement races.',
    gap: 'Platform-specific ACLs and extended attributes are not represented by the Git object model.',
    evidence: ['complete-test-corpus', 'guard-corpus', 'mutation-fingerprint'],
  },
  {
    id: 'quarantine-purge', area: 'actions-recovery',
    interfaces: ['cli:purge', 'mcp:holt_purge', 'api:purgeQuarantine'],
    tests: [T('test/e2e/actions.test.mjs', 'CLEAN PURGE: preview is inert; apply anchors exact HEAD and reclaims a clean quarantine'), T('test/e2e/actions.test.mjs', 'CLEAN PURGE RACE: Git independently refuses late work and Holt restores the lock')],
    oracle: 'Exact HEAD recovery ref, dirty-state refusal, lock-authority tamper, and late-write race checks.',
    gap: 'Purge is intentionally irreversible after re-verification; it retains the exact HEAD and branch, not uncommitted bytes introduced after a refused check.',
    evidence: ['complete-test-corpus', 'mutation-fingerprint'],
  },
  {
    id: 'shell-command-guard', area: 'agent-integration',
    interfaces: ['cli:hook'],
    tests: [T('test/e2e/shell-grammar.test.mjs', 'GRAMMAR: a destroyer is seen through every construct that can carry it'), T('test/e2e/shell-grammar.test.mjs', 'GRAMMAR NEVER-WORSE: the same constructs carrying ordinary work stay out of the way'), T('test/e2e/guard-classes-repair.test.mjs', '[C] find primaries, -exec utilities and stdin-fed xargs destroy, and are refused')],
    oracle: 'Host payloads drive real hook subprocesses against destructive and ordinary shell grammar controls.',
    gap: 'Only documented wired host events are intercepted; arbitrary external processes remain outside the host hook.',
    evidence: ['complete-test-corpus', 'guard-corpus', 'mutation-fingerprint'],
  },
  {
    id: 'native-file-tool-guard', area: 'agent-integration',
    interfaces: ['hook:claude-code:Write', 'hook:claude-code:Edit', 'hook:codex:apply_patch'],
    tests: [T('test/e2e/native-tool-hooks.test.mjs', 'Codex apply_patch delete reaches fresh file evidence while Update File remains seamless'), T('test/unit/native-tool-hooks.test.mjs', 'arbitrary local-function and MCP inputs are not reinterpreted as filesystem contracts')],
    oracle: 'Current documented structured tool envelopes with path/content state independently inspected before the action.',
    gap: 'Coverage is intentionally exact: incremental edits and unknown MCP/local-function schemas are not guessed.',
    evidence: ['complete-test-corpus', 'host-manifest-sync', 'mutation-fingerprint'],
  },
  {
    id: 'proactive-lifecycle-context', area: 'agent-integration',
    interfaces: ['hook:session-start', 'hook:user-prompt-submit', 'hook:session-end', 'hook:stop'],
    tests: [T('test/e2e/brief-cadence.test.mjs', 'CODEX BRIEF: UserPromptSubmit uses additionalContext once, then emits no unchanged prompt noise'), T('test/e2e/brief-cadence.test.mjs', 'BRIEF: SessionStart is never suppressed'), T('test/e2e/brief-cadence.test.mjs', 'CURSOR STOP: followup_message is completed-only, one-loop-bounded'), T('test/e2e/autoprotect.test.mjs', 'AUTOPROTECT: session-start with --autoprotect locks at-risk worktrees before the agent moves')],
    oracle: 'Repeated lifecycle envelopes against unchanged and changed repository fingerprints.',
    gap: 'Proactivity exists only on hosts with a documented wired lifecycle event; MCP alone remains model-invoked.',
    evidence: ['complete-test-corpus', 'host-manifest-sync'],
  },
  {
    id: 'integration-install-upgrade-uninstall', area: 'agent-integration',
    interfaces: ['cli:integrate', 'cli:uninstall'],
    tests: [T('test/e2e/integration.test.mjs', 'INSTALL: integrate() wires AGENTS.md + MCP + detected hosts only'), T('test/e2e/integrate-upgrade.test.mjs', 'UPGRADE: a stale hook entry from a prior version is RECONCILED, never duplicated'), T('test/unit/host-hook-contracts.test.mjs', 'shared hook upgrades and uninstall preserve sibling user commands')],
    oracle: 'Byte comparison of pre-existing host configs before install, repeated upgrade, and uninstall.',
    gap: 'A correct config on disk does not prove a host loaded it, trusted it, or drove an enforcement event.',
    evidence: ['complete-test-corpus', 'host-manifest-sync', 'mutation-fingerprint'],
  },
  {
    id: 'host-compatibility-report', area: 'agent-integration',
    interfaces: ['cli:hosts'],
    tests: [T('test/unit/host-manifest.test.mjs', 'host config fixtures: file path + top-level key match each host'), T('test/unit/readme-hosts-sync.test.mjs', 'README: no config/source smoke is claimed as a real-host enforcement run'), T('test/e2e/opencode-plugin.test.mjs', 'OPENCODE: opencode itself loads the plugin (skips if opencode is absent)')],
    oracle: 'Executable host manifest, config writers, source/CLI config probes, and explicit verifiedLive flags.',
    gap: 'Most hosts are contract-tested rather than driven live; an adapter entry is not proof that the host loaded or executed it.',
    evidence: ['complete-test-corpus', 'host-manifest-sync', 'portable-denominator'],
  },
  {
    id: 'provider-adapter-status', area: 'agent-integration',
    interfaces: ['cli:providers'],
    tests: [T('test/e2e/providers-cli.test.mjs', 'PROVIDERS CLI: human output separates implemented, contract-verified, live-verified, and framework-only'), T('test/e2e/providers-cli.test.mjs', 'PROVIDERS CLI: JSON exposes install scope and reactive versus proactive capability contracts'), T('test/e2e/providers-cli.test.mjs', 'PROVIDERS CLI: read-only command works outside a Git repository'), T('test/unit/provider-profiles.test.mjs', 'adapter inventory separates shipped installation from provider capability and reports activation semantics')],
    oracle: 'Human and JSON CLI reports are compared with strict provider profiles, install scopes, capability initiation semantics, and an outside-repository read-only control.',
    gap: 'Contract verification is not a live provider run; framework-only profiles install nothing, and no profile may claim blocking until its live allow/deny/failure matrix passes.',
    evidence: ['complete-test-corpus'],
  },
  {
    id: 'antigravity-context-and-mcp-adapter', area: 'agent-integration',
    interfaces: ['host:antigravity', 'hook:antigravity:PreInvocation', 'mcp-config:antigravity'],
    tests: [T('test/unit/antigravity-adapter.test.mjs', 'Antigravity installs proactive context without an authority-granting PreToolUse hook'), T('test/unit/antigravity-adapter.test.mjs', 'Antigravity MCP, hook detection, activation diagnostics and uninstall are symmetric'), T('test/unit/antigravity-adapter.test.mjs', 'Antigravity PreInvocation enters model context and unchanged later invocations stay quiet')],
    oracle: 'Isolated JSONC configs plus a real repository with planted sibling-only work, first/later invocation controls, activation inspection, and uninstall read-back.',
    gap: 'The adapter is MCP plus proactive context, not blocking: no PreToolUse hook is installed, loaded/live state is unknown, and no real Antigravity process has been driven.',
    evidence: ['complete-test-corpus', 'host-manifest-sync'],
  },
  {
    id: 'mcp-decision-tools', area: 'agent-integration',
    interfaces: ['cli:mcp', 'mcp:holt_status', 'mcp:holt_collisions', 'mcp:holt_hotspots', 'mcp:holt_duplicates', 'mcp:holt_context', 'mcp:holt_impact', 'mcp:holt_landing_order', 'mcp:holt_branches', 'mcp:holt_partition', 'mcp:holt_landing_plan'],
    tests: [T('test/e2e/mcp.test.mjs', 'MCP holt_status: returns the decision surface, not an inventory'), T('test/e2e/mcp-protocol.test.mjs', 'MCP PROTOCOL: tools/list returns the full, well-formed tool set')],
    oracle: 'Real stdio JSON-RPC plus direct comparison with planted repository truth.',
    gap: 'MCP is reactive: the model/host must invoke a tool unless a separate lifecycle hook injects context.',
    evidence: ['complete-test-corpus'],
  },
  {
    id: 'mcp-action-tools', area: 'agent-integration',
    interfaces: ['mcp:holt_clean', 'mcp:holt_rescue', 'mcp:holt_protect'],
    tests: [T('test/e2e/mcp.test.mjs', 'MCP: holt_clean declares the reversible quarantine contract'), T('test/e2e/mcp-protocol.test.mjs', 'MCP PROTOCOL: the acting tools ACT — the full loop an agent needs, over the wire')],
    oracle: 'Protocol calls followed by independent Git refs, locks, quarantine paths, and restore-state inspection.',
    gap: 'The host approval policy still decides whether non-read-only MCP calls may execute.',
    evidence: ['complete-test-corpus', 'guard-corpus'],
  },
  {
    id: 'mcp-security-boundary', area: 'agent-integration',
    interfaces: ['mcp:boundary'],
    tests: [T('test/e2e/mcp-hostile.test.mjs', 'HOSTILE: `repo` cannot point holt at another repository — reading OR removing'), T('test/e2e/mcp-hostile.test.mjs', 'HOSTILE: not one control, bidi or invisible character reaches the model, and ordinary names are untouched'), T('test/e2e/mcp.test.mjs', 'MCP: limit is honoured and clamped')],
    oracle: 'Two unrelated real repositories, hostile identifiers, schema-invalid arguments, and full wire responses.',
    gap: 'Transport/security behavior beyond the shipped stdio server and supported SDK version is not claimed.',
    evidence: ['complete-test-corpus', 'mutation-fingerprint'],
  },
  {
    id: 'activation-integrity-diagnostics', area: 'agent-integration',
    interfaces: ['cli:doctor'],
    tests: [T('test/unit/activation-integrity.test.mjs', 'full current Codex config is configured on disk while trust/runtime/live remain unknown'), T('test/e2e/cli.test.mjs', 'DOCTOR: a worktree created after integrate is reported as unwired')],
    oracle: 'Isolated homes with separately planted advisory, hook, and MCP files.',
    gap: 'Trust, loaded state, runtime state, and live proof remain unknown without a real host event.',
    evidence: ['complete-test-corpus', 'host-manifest-sync'],
  },
  {
    id: 'configuration-and-policy-escape-hatch', area: 'core-analysis',
    interfaces: ['config:.holtrc.json'],
    tests: [T('test/e2e/config-authority.test.mjs', 'CONFIG AUTHORITY: a repository cannot grant itself permission'), T('test/e2e/config-cli.test.mjs', 'config: an unparseable .holtrc.json fails LOUDLY — exit 2, never a silent default'), T('test/unit/saferegex.test.mjs', 'SAFEREGEX: an unbounded pattern is declined inside the budget instead of hanging')],
    oracle: 'Malformed, unknown-key, authority-downgrade, safe-regex, and compound-command controls.',
    gap: 'A human allow rule records intent but cannot make an intrinsically destructive command safe.',
    evidence: ['complete-test-corpus'],
  },
  {
    id: 'journal-integrity-and-proofs', area: 'audit-team',
    interfaces: ['cli:journal'],
    tests: [T('test/e2e/audit-chain.test.mjs', 'CLI: --prove emits an offline RFC 6962 inclusion proof that verifies'), T('test/unit/journal.test.mjs', 'JOURNAL: inside a repository it still writes, and under the COMMON git dir')],
    oracle: 'Independent hash recomputation, planted line tamper, append/rewrite races, and proof verification.',
    gap: 'The journal sees Holt and wired-hook events; it cannot attest to unobserved external actions.',
    evidence: ['complete-test-corpus', 'mutation-fingerprint'],
  },
  {
    id: 'journal-exports-and-summary', area: 'audit-team',
    interfaces: ['journal:verify', 'journal:prove', 'journal:export', 'journal:summary'],
    tests: [T('test/unit/siem.test.mjs', 'ATTACK: a hostile value cannot forge an extra record in ANY line-oriented format'), T('test/unit/siem.test.mjs', 'a journal that does not VERIFY refuses to export, in every format'), T('test/unit/roi.test.mjs', 'roi: prevented losses count blocks and verified rescues, and only those')],
    oracle: 'Known event ledger transformed into OCSF, ECS, CEF, JSON, CSV, and in-toto with schema/line controls.',
    gap: 'Format conformance tests are not a live ingestion run against every downstream SIEM product.',
    evidence: ['complete-test-corpus'],
  },
  {
    id: 'forensics-timeline', area: 'audit-team',
    interfaces: ['cli:forensics'],
    tests: [T('test/e2e/forensics.test.mjs', 'FORENSICS: `holt forensics <id>` reconstructs created / wrote / attempted / survived'), T('test/e2e/forensics.test.mjs', 'FORENSICS: a host that says nothing produces `unknown`, NOT the human running the shell')],
    oracle: 'Planted journal events correlated with Git reflog/worktree state and explicit actor/session controls.',
    gap: 'Forensics cannot reconstruct events no available evidence source recorded.',
    evidence: ['complete-test-corpus'],
  },
  {
    id: 'fleet-policy-and-ci', area: 'audit-team',
    interfaces: ['cli:fleet', 'cli:ci', 'journal:fleet', 'forensics:fleet'],
    tests: [T('test/e2e/team.test.mjs', 'FLEET NEVER-WORSE: distinct repositories are never merged, and an unidentifiable directory is still reported'), T('test/e2e/policy-authority.test.mjs', 'BYPASS 1: a candidate that DELETES the policy is still judged by the base policy'), T('test/e2e/ci-gate.test.mjs', 'CI GATE: a branch that DELETES .holt/policy.json is still gated by the base policy')],
    oracle: 'Multiple real repositories, linked-worktree identity controls, base-authoritative policy, and exact CI exits.',
    gap: 'Team fleet mechanics and reviewed repository policy do not provide Enterprise identity provisioning or signed central-policy distribution by themselves.',
    evidence: ['complete-test-corpus', 'ci-hardening'],
  },
  {
    id: 'managed-policy-authority', area: 'enterprise-policy',
    interfaces: ['cli:managed-policy', 'cli:ci'],
    tests: [T('test/e2e/managed-policy-cli.test.mjs', 'managed-policy is a real Enterprise entitlement with a reachable command surface'), T('test/e2e/managed-policy-tuf.test.mjs', 'real Updater verifies and activates policy with a root-bound sorted receipt, then offline authority load performs zero fetches'), T('test/e2e/managed-policy-authority.test.mjs', 'system-enrolled active policy resolves by exact trusted identity and evaluates every layer additively without fetch')],
    oracle: 'Real tuf-js signatures/rotation/delegation, root-owned out-of-repository authority, inode-bound repository identity, crash receipts, and byte-identical last-good state.',
    gap: 'SSO/SCIM, Windows system ACL authority, signed offline-media update workflow, and a hosted macOS root-ownership run are not shipped or proven.',
    evidence: ['complete-test-corpus', 'mutation-fingerprint'],
  },
  {
    id: 'continuous-siem-sink', area: 'audit-team',
    interfaces: ['journal:sink'],
    tests: [T('test/e2e/audit-chain.test.mjs', 'PAID: the sink emits once, then is idempotent — a SIEM is not double-billed for a re-run'), T('test/unit/siem.test.mjs', 'every exported record carries its RFC 6962 leaf hash as the de-duplication id')],
    oracle: 'Append/restart/tamper fixtures with independent cursor and record-id checks.',
    gap: 'The shipped sink writes a configured path; live vendor transport, credentials, retry, and backpressure integrations are not proven.',
    evidence: ['complete-test-corpus'],
  },
  {
    id: 'actor-attribution', area: 'audit-team',
    interfaces: ['journal:actor'],
    tests: [T('test/unit/actor.test.mjs', 'actor: with no evidence at all, everything is unknown and nothing is fabricated'), T('test/e2e/team.test.mjs', 'JOURNAL: every recorded action names WHO, and never invents one')],
    oracle: 'Controlled environment/session combinations with hostile values and absent-identity negatives.',
    gap: 'Environment-derived identity is reported or inferred, not cryptographic human identity.',
    evidence: ['complete-test-corpus'],
  },
  {
    id: 'supply-chain-audit-and-offline-runtime', area: 'supply-release',
    interfaces: ['cli:audit'],
    tests: [T('test/unit/supply-chain.test.mjs', 'the shipped package passes its own audit'), T('test/unit/supply-chain.test.mjs', 'RED: one flipped byte in one shipped file is caught and named'), T('test/unit/no-network.test.mjs', 'NO NETWORK: analysis, hooks, MCP and CI stay offline; only explicit managed-policy sync is in src')],
    oracle: 'Manifest byte flips/add/delete, pinned signature controls, executable capability scan, and planted network calls.',
    gap: 'An unsigned development checkout proves integrity against its local manifest, not publisher authenticity.',
    evidence: ['complete-test-corpus', 'mutation-fingerprint', 'release-contract'],
  },
  {
    id: 'package-and-installed-artifact', area: 'supply-release',
    interfaces: ['package:npm-tarball', 'install:omit-optional'],
    tests: [T('test/unit/package-contents.test.mjs', 'package: every module the shipped code imports is inside the tarball'), T('test/unit/supply-chain.test.mjs', 'THE REAL TARBALL SELF-VERIFIES — the manifest must describe what npm actually packs'), T('test/unit/install-url.test.mjs', 'every covered file advertises an npm install command for the GitHub release tarball'), T('test/unit/omit-optional-install.test.mjs', 'OMIT OPTIONAL PROOF CLI: absence exits zero and a planted optional root exits nonzero')],
    oracle: 'Fresh npm pack contents, import closure, manifest verification, isolated-prefix optional-root inspection, and installed CLI smoke.',
    gap: 'Local candidate proof does not make the currently published registry/release asset identical or current.',
    evidence: ['complete-test-corpus', 'release-contract'],
  },
  {
    id: 'release-and-ci-contract', area: 'supply-release',
    interfaces: ['release:github', 'ci:github-actions'],
    tests: [T('test/unit/release-contract.test.mjs', 'release contract: the real action, workflow, package and locks are green'), T('test/unit/release-body.test.mjs', 'RELEASE BODY: the body checked into this repository passes its own gate'), T('test/unit/published-numbers-gate.test.mjs', 'gate: the checker PASSES on the real synchronized claim-or-withholding state')],
    oracle: 'Workflow parser with planted mutable refs, permission widening, evidence reordering, asset clobber, and false claims.',
    gap: 'Static/local contract proof is not a successful protected remote release on Linux, macOS, and Windows.',
    evidence: ['complete-test-corpus', 'ci-hardening', 'release-contract', 'release-bodies'],
  },
  {
    id: 'platform-and-path-portability', area: 'compatibility',
    interfaces: ['runtime:linux', 'runtime:macos', 'runtime:windows'],
    tests: [T('test/unit/native-path-class.test.mjs', 'NATIVE PATHS: the lint FIRES on every historical defect — proven, not assumed'), T('test/unit/cat-file-batch-newline-paths.test.mjs', 'catFileBatch: a newline in one path does not shift every LATER record onto the wrong spec'), T('test/e2e/moved-repo.test.mjs', 'moved repo: step 3 — after `git worktree repair`, the answers are EQUIVALENT to the original')],
    oracle: 'Native path APIs, hostile filenames, protocol framing, and explicitly named cross-platform guard corpus.',
    gap: 'One local run proves only its named platform; macOS/Windows require separate zero-skip artifacts.',
    evidence: ['complete-test-corpus', 'portable-denominator', 'path-boundary', 'guard-corpus'],
  },
  {
    id: 'git-repository-shape-compatibility', area: 'compatibility',
    interfaces: ['compat:submodules', 'compat:sparse-checkout', 'compat:git-lfs'],
    tests: [T('test/e2e/adversarial.test.mjs', 'ADVERSARIAL: a submodule does not derail the parent scan'), T('test/e2e/actions.test.mjs', 'CATASTROPHIC: rescue REFUSES a dirty submodule instead of reporting it verified'), T('test/e2e/index-flag-blindness.test.mjs', 'index flags: the flag ALONE is not the evidence — an absent path is not at risk (sparse checkout)'), T('test/e2e/guard-classes-repair.test.mjs', '[B] a sparse checkout is classifiable and cheap — no E2BIG, no per-call second')],
    oracle: 'Real populated and dirty submodules plus sparse worktrees with Git index flags and independently inspected on-disk paths.',
    gap: 'Submodule and sparse-checkout paths are exercised, but Git LFS has no dedicated fixture; filters, missing LFS objects, and every promisor configuration remain unproven.',
    evidence: ['complete-test-corpus', 'git-runtime', 'guard-corpus'],
  },
  {
    id: 'jujutsu-backend', area: 'compatibility',
    interfaces: ['backend:jj'],
    tests: [T('test/e2e/jj.test.mjs', 'jj: end-to-end, holt finds the work in a jj workspace'), T('test/e2e/jj-backend.test.mjs', 'jj-backend: the working copy is snapshotted (snapshotBased: true, no uncommitted layer)')],
    oracle: 'A real colocated jj repository/workspace checked with jj operation-log immutability and Git cat-file.',
    gap: 'A run without jj is rejected as a skip; one installed jj version does not prove every past/future version.',
    evidence: ['complete-test-corpus'],
  },
  {
    id: 'pinned-real-repository-corpus', area: 'adversarial-proof',
    interfaces: ['harness:real-repos'],
    tests: [T('test/e2e/real-repos.test.mjs', 'exact pinned four-repository corpus was exercised')],
    oracle: 'Pinned Click, Gin, ripgrep, and Express commits with planted duplicate/collision/risk/disposable/impact truth.',
    gap: 'Four repositories and languages are a named corpus, not universal ecosystem coverage.',
    evidence: ['complete-test-corpus'],
  },
  {
    id: 'monster-and-randomized-invariants', area: 'adversarial-proof',
    interfaces: ['harness:monster', 'harness:fuzz'],
    tests: [T('test/e2e/monster.test.mjs', 'MONSTER: 40 worktrees of every trap at once — full loop, every byte graded'), T('test/e2e/fuzz-invariant.test.mjs', 'FUZZ INVARIANT seed=${seed}: holt never calls at-risk content safe, never removes it')],
    oracle: 'Direct filesystem/base comparison and retained-byte checks share no verdict code with Holt.',
    gap: 'Seeded randomized and synthetic worst cases remain finite; passing them is not proof against every possible race.',
    evidence: ['complete-test-corpus', 'mutation-fingerprint'],
  },
  {
    id: 'benchmark-evidence-protocol', area: 'adversarial-proof',
    interfaces: ['harness:enterprise', 'harness:hook-latency', 'harness:agent-ab'],
    tests: [T('test/unit/benchmark-evidence.test.mjs', 'BENCH EVIDENCE: missing numeric samples stay in the denominator'), T('test/unit/benchmark-evidence.test.mjs', 'BENCH EVIDENCE: enterprise smoke preserves warmups, repetitions, grading, commands, and source identity'), T('test/unit/eval-validity.test.mjs', 'EVAL VALIDITY: invalid trials are EXCLUDED from rates, not counted as successes')],
    oracle: 'Pinned source identity, planted ground truth, retained warmups/samples, complete denominators, and checksum sidecars.',
    gap: 'Harness validity is not product-effectiveness evidence; smoke or low-repetition A/B results are not publishable.',
    evidence: ['complete-test-corpus'],
  },
  {
    id: 'offline-license-and-entitlements', area: 'commerce',
    interfaces: ['cli:license'],
    tests: [T('test/unit/license.test.mjs', 'ATTACK: payload edited to upgrade the tier, original signature kept'), T('test/e2e/purchase-path.test.mjs', 'E2E: the full happy path — signed webhook mints a license the CLIENT accepts')],
    oracle: 'Throwaway Ed25519 keys, forged/malformed/expired tokens, and real CLI activation/status/deactivation.',
    gap: 'SSO/SCIM and customer-controlled offline licence issuance/renewal remain unshipped; managed policy is proved separately and does not erase those gaps.',
    evidence: ['complete-test-corpus'],
  },
  {
    id: 'purchase-and-license-service', area: 'commerce',
    interfaces: ['server:checkout', 'server:webhook', 'server:resend', 'server:health'],
    tests: [T('test/unit/server.test.mjs', 'ATTACK: forged signature, wrong secret, and tampered body are all refused'), T('test/unit/server.test.mjs', 'ledger: a torn final line is COUNTED, never silently dropped'), T('test/e2e/purchase-path.test.mjs', 'E2E CONCURRENCY: many simultaneous deliveries of one event mint exactly one license')],
    oracle: 'In-process HTTP server, raw webhook HMAC, throwaway signing key, append-only ledger, and mocked provider responses.',
    gap: 'Provider APIs are mocked in the repository suite; a deployed live Stripe/Resend purchase and support drill is still required. The source comments mention a billing portal, but no portal route ships.',
    evidence: ['complete-test-corpus'],
  },
  {
    id: 'pricing-and-public-claims', area: 'commerce',
    interfaces: ['site:pricing', 'readme:claims'],
    tests: [T('test/unit/pricing-cta.test.mjs', 'free/core launch exposes one honest install path and no paid-tier checkout'), T('test/unit/published-numbers.test.mjs', 'published numbers: test count is synchronized or explicitly withheld everywhere'), T('test/unit/site-layout.test.mjs', 'site: anything legitimately wider than a phone scrolls inside its OWN container')],
    oracle: 'Static surfaces parsed against the free-only CTA, executable entitlements, and measured-number gates.',
    gap: 'Copy/CTA consistency does not prove buyer comprehension or adoption; paid checkout is intentionally outside this launch.',
    evidence: ['complete-test-corpus', 'release-bodies'],
  },
  {
    id: 'setup-doctor-and-cli-contract', area: 'developer-experience',
    interfaces: ['cli:setup', 'cli:doctor', 'cli:help', 'cli:version'],
    tests: [T('test/e2e/cli.test.mjs', 'CLI: every command is REACHABLE and exits 0'), T('test/e2e/cli.test.mjs', 'FIRST RUN: a repo with no commits gets a one-line message, never a stack trace'), T('test/unit/git-runtime-contract.test.mjs', 'runtime contract: selected Git is >=2.45 and implements --no-lazy-fetch')],
    oracle: 'Real subprocess exits/stdout/stderr across first-run repository states and live Git capability probes.',
    gap: 'Backend installation needs explicit consent and network; supported host setup still needs host trust/load verification.',
    evidence: ['complete-test-corpus', 'git-runtime', 'host-manifest-sync'],
  },
  {
    id: 'machine-output-and-analysis-scope', area: 'developer-experience',
    interfaces: ['option:--json', 'option:--include-primary', 'option:--all', 'option:--base', 'option:--family-window'],
    tests: [T('test/e2e/cli.test.mjs', 'CLI: --json output is parseable for every command that claims it'), T('test/e2e/cli.test.mjs', 'FIRST RUN: the solo-repo caveat — a dirty, unscanned primary is NAMED beside every all-clear'), T('test/e2e/cli.test.mjs', 'CLI: a numeric flag is parsed and never silently coerced')],
    oracle: 'Subprocess JSON parsing, planted dirty-primary scope controls, and malformed/boundary numeric option cases.',
    gap: 'Parseable JSON is not a versioned schema guarantee for every nested field; consumers must pin a Holt version.',
    evidence: ['complete-test-corpus'],
  },
];

export const MCP_TOOLS = mcp.TOOLS.map((tool) => tool.name).sort();
export const HOST_IDS = HOSTS.map((host) => host.id).sort();

const DEEP_RUNTIME_TITLE = 'DEEP BACKEND: renamed added-line clone is found, unrelated work stays absent, and same-workstream clones stay excluded';

async function deepRuntimeEvidence() {
  const cloneBody = (name) => `export function ${name}(records) {\n`
    + '  const output = [];\n'
    + '  for (const record of records) {\n'
    + '    const normalized = String(record.value).trim().toLowerCase();\n'
    + "    const fingerprint = normalized.split('').reverse().join('');\n"
    + '    output.push({ id: record.id, normalized, fingerprint, active: record.enabled === true });\n'
    + '  }\n'
    + '  return output.filter((entry) => entry.active).sort((x, y) => x.id.localeCompare(y.id));\n'
    + '}\n';
  const localClone = 'export function gammaOnly(matrix) {\n'
    + '  let diagonalProduct = 1;\n'
    + '  for (let rowIndex = 0; rowIndex < matrix.length; rowIndex += 1) {\n'
    + '    const diagonalValue = Number(matrix[rowIndex][rowIndex] ?? 1);\n'
    + '    diagonalProduct *= diagonalValue === 0 ? 1 : diagonalValue;\n'
    + '  }\n'
    + "  const octalDigest = diagonalProduct.toString(8).padStart(24, '0');\n"
    + '  return { diagonalProduct, octalDigest, matrixRows: matrix.length };\n'
    + '}\n';

  const fx = await newRepo('feature-proof-deep');
  try {
    const alpha = await fx.worktree('alpha');
    await fx.write('src/alpha.js', cloneBody('renamedAlpha'), alpha);
    await fx.commit('alpha adds normalizer', alpha);
    await backdateWorktreeCreation(alpha, 180 * 60 * 1000);

    const beta = await fx.worktree('beta');
    await fx.write('lib/beta.js', cloneBody('renamedBeta'), beta);
    await fx.commit('beta independently adds normalizer', beta);
    await backdateWorktreeCreation(beta, 90 * 60 * 1000);

    // Positive control for the ownership filter: jscpd must see this clone, but Holt must not
    // report two files owned by one workstream as cross-workstream duplication.
    const gamma = await fx.worktree('gamma');
    await fx.write('one/gamma.js', localClone, gamma);
    await fx.write('two/gamma-copy.js', localClone, gamma);
    await fx.commit('gamma contains a local clone', gamma);

    const result = await deepDuplicates(await scan(await discover(fx.root)));
    assert.equal(result.ran, true,
      `feature proof requires the optional jscpd backend to run: ${result.reason ?? 'unknown failure'}`);
    assert.match(String(result.tool), /^jscpd \d+\.\d+\.\d+/);
    assert.equal(result.filesCompared, 4, 'all four planted added-line files must reach jscpd');
    assert.ok(result.clones >= 2, 'the cross-worktree and same-workstream positive controls must both be detected');
    assert.equal(result.pairs.length, 1,
      `only the planted cross-workstream clone may surface: ${JSON.stringify(result.pairs)}`);
    const [pair] = result.pairs;
    assert.deepEqual([pair.a, pair.b].sort(), ['alpha', 'beta']);
    assert.equal(pair.sameFamily, false);
    assert.equal(pair.classification, 'cross-dispatch-waste');
    assert.ok(pair.duplicatedLines >= 5 && pair.duplicatedTokens >= 50);
    assert.equal(result.pairs.some((candidate) => candidate.a === candidate.b), false,
      'same-workstream clones are not cross-worktree duplication');
    assert.equal(result.pairs.some((candidate) => candidate.a === 'gamma' || candidate.b === 'gamma'), false,
      'the unrelated negative-control workstream must stay absent');
  } finally {
    await fx.cleanup();
  }
}

async function printDeepRuntimeTap() {
  process.stdout.write('TAP version 13\n');
  try {
    await deepRuntimeEvidence();
    process.stdout.write(`ok 1 - ${DEEP_RUNTIME_TITLE}\n1..1\n# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`);
  } catch (error) {
    const detail = String(error?.stack ?? error?.message ?? error).replace(/^/gm, '# ');
    process.stdout.write(`not ok 1 - ${DEEP_RUNTIME_TITLE}\n${detail}\n1..1\n# tests 1\n# suites 0\n# pass 0\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n`);
    process.exitCode = 1;
  }
}

async function walkTests(dir, out = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) await walkTests(absolute, out);
    else if (entry.isFile() && entry.name.endsWith('.test.mjs')) {
      out.push(path.relative(ROOT, absolute).split(path.sep).join('/'));
    }
  }
  return out;
}

export function focusedTestMarkers(source) {
  const patterns = [
    /\b(?:test|it|describe|suite)\s*\.\s*only\s*\(/g,
    /\bonly\s*:\s*true\b/g,
  ];
  return patterns.flatMap((pattern) => [...String(source).matchAll(pattern)].map((match) => match[0]));
}

export async function buildEvidenceCommands() {
  const testFiles = await walkTests(path.join(ROOT, 'test'));
  if (testFiles.length === 0) throw new Error('feature proof enumerated zero test files');
  for (const file of testFiles) {
    const markers = focusedTestMarkers(await fs.readFile(path.join(ROOT, file), 'utf8'));
    if (markers.length) throw new Error(`${file}: focused test marker would omit the full denominator: ${markers.join(', ')}`);
  }
  return [
    {
      id: 'complete-test-corpus', kind: 'test', description: 'Every *.test.mjs file, named explicitly',
      command: process.execPath, args: ['--test', '--test-reporter=tap', ...testFiles], testFiles,
    },
    {
      id: 'deep-runtime', kind: 'test', description: 'Real jscpd renamed-clone lane with positive and negative ownership controls',
      command: process.execPath, args: [fileURLToPath(import.meta.url), '--internal-deep-runtime'],
    },
    {
      id: 'no-symbols-contract', kind: 'test', description: 'File-level safety equivalence and deterministic symbol-backend bypass',
      command: process.execPath,
      args: ['--test', '--test-reporter=tap', 'test/e2e/no-symbols.test.mjs'],
      testFiles: ['test/e2e/no-symbols.test.mjs'],
    },
    {
      id: 'mutation-fingerprint', kind: 'gate', description: 'Full mutation fingerprint corpus',
      command: process.execPath, args: ['test/mutation.mjs'],
    },
    {
      id: 'guard-corpus', kind: 'test', description: 'Explicit destructive-authority corpus',
      command: process.execPath, args: ['scripts/run-guard-corpus.mjs'],
    },
    {
      id: 'git-runtime', kind: 'gate', description: 'Live Git version and inert-hook capability',
      command: process.execPath, args: ['scripts/check-git-runtime.mjs', '--verify-inert-hooks'],
    },
    {
      id: 'typecheck', kind: 'gate', description: 'Static type contract',
      command: process.execPath, args: ['scripts/typecheck.mjs'],
    },
    {
      id: 'path-boundary', kind: 'gate', description: 'Native-path boundary lint with positive controls',
      command: process.execPath, args: ['scripts/lint-native-paths.mjs'],
    },
    {
      id: 'host-manifest-sync', kind: 'gate', description: 'Generated host documentation/config contract',
      command: process.execPath, args: ['scripts/generate-hosts.mjs', '--check'],
    },
    {
      id: 'portable-denominator', kind: 'gate', description: 'Cross-platform file denominator and sole owned exclusion',
      command: process.execPath, args: ['scripts/run-crossplat-suite.mjs', '--check'],
    },
    {
      id: 'ci-hardening', kind: 'gate', description: 'CI hardening plus planted red controls',
      command: process.execPath, args: ['scripts/check-ci-hardening.mjs', '--self-test'],
    },
    {
      id: 'release-contract', kind: 'gate', description: 'Release workflow plus planted red controls',
      command: process.execPath, args: ['scripts/check-release-contract.mjs', '--self-test'],
    },
    {
      id: 'release-bodies', kind: 'gate', description: 'Every checked-in release body',
      command: process.execPath, args: ['scripts/check-release-body.mjs', '--all'],
    },
  ];
}

function countBy(values) {
  const out = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

export async function buildPlan() {
  const commands = await buildEvidenceCommands();
  return {
    schemaVersion: 1,
    claimBoundary: 'Bounded proof for this exact source/runtime/platform/fixture set; never universal proof.',
    universalProof: false,
    executionEnvironment: { inherited: true, overrides: { ...EVIDENCE_ENV_OVERRIDES } },
    inventories: {
      features: { count: FEATURES.length, byArea: countBy(FEATURES.map((feature) => feature.area)) },
      cliCommands: { count: CLI_COMMANDS.length, names: [...CLI_COMMANDS] },
      mcpTools: { count: MCP_TOOLS.length, names: [...MCP_TOOLS] },
      hosts: { count: HOST_IDS.length, ids: [...HOST_IDS] },
      testFiles: { count: commands[0].testFiles.length, paths: [...commands[0].testFiles] },
      evidenceCommands: { count: commands.length, ids: commands.map((command) => command.id) },
    },
    features: FEATURES,
    commands: commands.map(({ id, kind, description, command, args, testFiles }) => ({
      id, kind, description, command, args, testFiles: testFiles ?? [],
    })),
  };
}

function integerSummary(text, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...text.matchAll(new RegExp(`(?:^|\\n)\\s*(?:#|ℹ)?\\s*${escaped}\\s+(\\d+)\\s*(?=\\n|$)`, 'gi'))];
  return matches.length ? Number(matches.at(-1)[1]) : null;
}

export function parseTap(stdout, stderr = '') {
  const text = `${stdout}\n${stderr}`;
  return {
    tests: integerSummary(text, 'tests'),
    suites: integerSummary(text, 'suites'),
    pass: integerSummary(text, 'pass'),
    fail: integerSummary(text, 'fail'),
    cancelled: integerSummary(text, 'cancelled'),
    skipped: integerSummary(text, 'skipped'),
    todo: integerSummary(text, 'todo'),
    containsSkipDirective: /(?:^|\n)\s*(?:ok|not ok)\b[^\n]*#\s*SKIP\b/i.test(text),
    containsTodoDirective: /(?:^|\n)\s*(?:ok|not ok)\b[^\n]*#\s*TODO\b/i.test(text),
  };
}

export function gradeCommand(result) {
  const reasons = [];
  if (result.exitCode !== 0) reasons.push(`exit ${result.exitCode ?? result.signal ?? 'unknown'}`);
  if (result.kind === 'test') {
    const tap = result.tap ?? parseTap(result.stdout, result.stderr);
    if (!(tap.tests > 0)) reasons.push('test command reported no positive test denominator');
    if ((tap.fail ?? 0) > 0) reasons.push(`${tap.fail} failed test(s)`);
    if ((tap.cancelled ?? 0) > 0) reasons.push(`${tap.cancelled} cancelled test(s)`);
    if ((tap.skipped ?? 0) > 0 || tap.containsSkipDirective) reasons.push(`${tap.skipped ?? 'unknown'} skipped test(s)`);
    if ((tap.todo ?? 0) > 0 || tap.containsTodoDirective) reasons.push(`${tap.todo ?? 'unknown'} todo test(s)`);
  }
  return { pass: reasons.length === 0, reasons };
}

async function runProcess(spec) {
  const startedAt = new Date().toISOString();
  const start = performance.now();
  return new Promise((resolve) => {
    const child = spawn(spec.command, spec.args, {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...EVIDENCE_ENV_OVERRIDES,
      },
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    let spawnError = null;
    child.once('error', (error) => { spawnError = error; });
    child.once('close', (exitCode, signal) => {
      const result = {
        id: spec.id, kind: spec.kind, description: spec.description,
        command: spec.command, args: [...spec.args], cwd: ROOT,
        startedAt, finishedAt: new Date().toISOString(),
        durationMs: Number((performance.now() - start).toFixed(3)),
        exitCode, signal: signal ?? null,
        spawnError: spawnError ? String(spawnError.stack ?? spawnError.message ?? spawnError) : null,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (spec.kind === 'test') result.tap = parseTap(result.stdout, result.stderr);
      result.grade = gradeCommand(result);
      resolve(result);
    });
  });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function hashFile(file) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('end', resolve);
    stream.once('error', reject);
  });
  return hash.digest('hex');
}

async function runBuffer(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...EVIDENCE_ENV_OVERRIDES },
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', (code, signal) => {
      const out = Buffer.concat(stdout);
      const err = Buffer.concat(stderr);
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(' ')} exited ${code ?? signal}: ${err.toString('utf8') || out.toString('utf8')}`));
      } else {
        resolve(out);
      }
    });
  });
}

async function gitBytes(args) {
  return runBuffer('git', args);
}

async function gitFileManifest(args) {
  const raw = await gitBytes(args);
  const names = [];
  let start = 0;
  for (let index = 0; index < raw.length; index++) {
    if (raw[index] !== 0) continue;
    if (index > start) names.push(raw.subarray(start, index));
    start = index + 1;
  }
  names.sort(Buffer.compare);
  const entries = [];
  for (const nameBytes of names) {
    // Buffer paths preserve POSIX filename bytes that are not valid UTF-8. On Windows, filenames
    // are Unicode and a string path is the native representation.
    const name = nameBytes.toString('utf8');
    const absolute = process.platform === 'win32'
      ? path.join(ROOT, name)
      : Buffer.concat([Buffer.from(`${ROOT}${path.sep}`), nameBytes]);
    const stat = await fs.lstat(absolute);
    let type = 'other'; let digest = sha256('');
    if (stat.isFile()) { type = 'file'; digest = await hashFile(absolute); }
    else if (stat.isSymbolicLink()) {
      const target = await fs.readlink(absolute, { encoding: 'buffer' });
      digest = sha256(target); type = 'symlink';
    }
    else if (stat.isDirectory()) type = 'directory';
    entries.push({
      path: name.split(path.sep).join('/'), pathBytesBase64: nameBytes.toString('base64'),
      type, mode: (stat.mode & 0o777777).toString(8), size: stat.size, sha256: digest,
    });
  }
  return entries;
}

async function untrackedManifest() {
  return gitFileManifest(['ls-files', '--others', '--exclude-standard', '-z']);
}

async function ignoredRuntimeManifest() {
  // Ignored bytes can still execute. In this checkout that includes the MCP SDK and jscpd in
  // node_modules plus host-plugin dependencies. A lockfile/version list cannot detect a locally
  // modified installed file, so the proof identity hashes Git's complete ignored-file inventory.
  // Nested repositories are not traversed by Git and are not runtime inputs of this checkout.
  return gitFileManifest(['ls-files', '--others', '--ignored', '--exclude-standard', '-z']);
}

async function sourceIdentityOnce() {
  const [commit, status, diff, untracked, ignoredRuntime] = await Promise.all([
    gitBytes(['rev-parse', '--verify', 'HEAD^{commit}']).then((value) => value.toString('ascii').trim()),
    gitBytes(['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    gitBytes(['diff', '--binary', '--no-ext-diff', 'HEAD', '--', '.']),
    untrackedManifest(),
    ignoredRuntimeManifest(),
  ]);
  const dirtyState = {
    statusSha256: sha256(status),
    trackedDiffSha256: sha256(diff),
    untracked,
    ignoredRuntime,
  };
  return {
    commit,
    dirty: status.length > 0,
    dirtyStateSha256: sha256(JSON.stringify(dirtyState)),
    dirtyState,
  };
}

export async function sourceIdentity() {
  // One status/diff/hash pass can straddle an editor write and describe a source state that never
  // existed as a whole. Two consecutive identical passes make that visible. We retain both sample
  // hashes in the artifact rather than retrying until a moving checkout happens to look quiet.
  const first = await sourceIdentityOnce();
  const second = await sourceIdentityOnce();
  const captureStable = first.commit === second.commit
    && first.dirtyStateSha256 === second.dirtyStateSha256;
  return {
    ...second,
    captureStable,
    captureSamples: [
      { commit: first.commit, dirtyStateSha256: first.dirtyStateSha256 },
      { commit: second.commit, dirtyStateSha256: second.dirtyStateSha256 },
    ],
  };
}

async function commandVersion(command, args = ['--version']) {
  const result = await runProcess({ id: `version:${command}`, kind: 'gate', description: 'runtime version', command, args });
  if (result.exitCode !== 0) return { available: false, error: (result.stderr || result.stdout || result.spawnError || '').trim() };
  return { available: true, version: (result.stdout || result.stderr).trim().split(/\r?\n/)[0] };
}

function environmentIdentity() {
  const affectsRuntime = /^(?:HOLT_|GIT_|JJ_|NODE_|NPM_|XDG_|CI$|PATH$|HOME$|USERPROFILE$|LOCALAPPDATA$|APPDATA$|TMPDIR$|TMP$|TEMP$|PATHEXT$|SYSTEMROOT$|WINDIR$|COMSPEC$|LC_|LANG$|TZ$|TERM$|NO_COLOR$|FORCE_COLOR$|GITHUB_HEAD_REF$)/;
  const sensitive = /(?:TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|COOKIE|AUTH|LICENSE|SIGNING|WEBHOOK|API_KEY|ACCESS_KEY)/i;
  return Object.keys(process.env).filter((name) => affectsRuntime.test(name)).sort().map((name) => {
    const value = String(process.env[name] ?? '');
    return {
      name, present: Object.hasOwn(process.env, name), utf8Bytes: Buffer.byteLength(value),
      ...(sensitive.test(name) ? { valueRedacted: true } : { valueSha256: sha256(value) }),
    };
  });
}

async function npmDependencyIdentity() {
  const result = await runProcess({
    id: 'runtime:npm-ls', kind: 'gate', description: 'installed dependency identity',
    command: 'npm', args: ['ls', '--all', '--json'],
  });
  let parsed = null;
  try { parsed = JSON.parse(result.stdout); } catch { /* retained by hashes below */ }
  const packages = new Set();
  const visit = (dependencies) => {
    for (const [name, value] of Object.entries(dependencies ?? {})) {
      const version = value && typeof value === 'object' ? value.version : null;
      packages.add(`${name}@${version ?? 'unknown'}`);
      if (value && typeof value === 'object') visit(value.dependencies);
    }
  };
  if (parsed) visit(parsed.dependencies);
  return {
    command: ['npm', 'ls', '--all', '--json'], exitCode: result.exitCode, signal: result.signal,
    parseable: parsed !== null, rootName: parsed?.name ?? null, rootVersion: parsed?.version ?? null,
    packageCount: packages.size, packages: [...packages].sort(),
    problems: Array.isArray(parsed?.problems) ? [...parsed.problems].sort() : [],
    stdoutBytes: Buffer.byteLength(result.stdout), stdoutSha256: sha256(result.stdout),
    stderrBytes: Buffer.byteLength(result.stderr), stderrSha256: sha256(result.stderr),
    spawnError: result.spawnError,
  };
}

export async function runtimeIdentity() {
  const cpus = os.cpus();
  const [git, ctags, enry, jscpd, jj, opencode, npm, holt, dependencies] = await Promise.all([
    commandVersion('git'), commandVersion('ctags'), commandVersion('enry'), detectJscpd(),
    commandVersion('jj'), commandVersion('opencode'), commandVersion('npm'),
    commandVersion(process.execPath, [path.join(ROOT, 'bin', 'holt.mjs'), '--version']),
    npmDependencyIdentity(),
  ]);
  return {
    platform: process.platform, arch: process.arch,
    os: { type: os.type(), release: os.release(), version: os.version() },
    cpu: {
      logicalCount: cpus.length, models: [...new Set(cpus.map((cpu) => cpu.model))].sort(),
      reportedSpeedMHz: [...new Set(cpus.map((cpu) => cpu.speed))].sort((a, b) => a - b),
    },
    memory: { totalBytes: os.totalmem() },
    node: { version: process.version, execPath: process.execPath, versions: { ...process.versions } },
    tools: { git, ctags, enry, jscpd, jj, opencode, npm, holt },
    dependencies,
    environment: environmentIdentity(),
    evidenceEnvironmentOverrides: { ...EVIDENCE_ENV_OVERRIDES },
  };
}

export function gradeRun(plan, results, source) {
  const byId = new Map(results.map((result) => [result.id, result]));
  const missingCommands = plan.commands.map((command) => command.id).filter((id) => !byId.has(id));
  const failedCommands = results.filter((result) => !result.grade.pass).map((result) => ({ id: result.id, reasons: result.grade.reasons }));
  const skippedTests = results.filter((result) => result.kind === 'test')
    .reduce((sum, result) => sum + (result.tap?.skipped ?? 0), 0);
  const todoTests = results.filter((result) => result.kind === 'test')
    .reduce((sum, result) => sum + (result.tap?.todo ?? 0), 0);
  const observedTests = results.filter((result) => result.kind === 'test')
    .reduce((sum, result) => sum + (result.tap?.tests ?? 0), 0);
  const featureRows = FEATURES.map((feature) => {
    const commands = feature.evidence.map((id) => byId.get(id));
    const missing = feature.evidence.filter((id) => !byId.has(id));
    const failed = commands.filter(Boolean).filter((result) => !result.grade.pass).map((result) => result.id);
    const observedPassingTestIds = feature.tests.flatMap((proof) => commands
      .filter((result) => result?.kind === 'test' && result.grade.pass)
      .filter((result) => `${result.stdout}\n${result.stderr}`.includes(proof.title))
      .map((result) => `${result.id}:${proof.title}`));
    const unobservedTests = feature.tests
      .filter((proof) => !observedPassingTestIds.some((id) => id.endsWith(`:${proof.title}`)))
      .map((proof) => `${proof.path}:${proof.title}`);
    return {
      id: feature.id, area: feature.area,
      boundedPass: missing.length === 0 && failed.length === 0 && unobservedTests.length === 0,
      missing, failed, observedPassingTestIds, unobservedTests, declaredGap: feature.gap,
    };
  });
  const sourceStable = source.before.captureStable === true && source.after.captureStable === true
    && source.before.commit === source.after.commit
    && source.before.dirtyStateSha256 === source.after.dirtyStateSha256;
  const resultShapeFailures = results.filter((result) => (
    typeof result.id !== 'string' || !result.id || !Number.isFinite(result.durationMs)
    || typeof result.stdout !== 'string' || typeof result.stderr !== 'string'
    || !result.grade || typeof result.grade.pass !== 'boolean'
    || (result.kind === 'test' && (!result.tap || !Number.isFinite(result.tap.tests)))
  )).map((result) => result.id ?? '<missing-id>');
  const sourceClean = source.before.dirty === false && source.after.dirty === false;
  const tokenClaims = {
    claimed: false,
    eligible: false,
    reason: 'feature proof makes no model-token or cost claim; any future claim requires finite per-result token fields and complete coverage',
  };
  const valid = missingCommands.length === 0 && failedCommands.length === 0 && skippedTests === 0
    && todoTests === 0 && sourceStable && sourceClean && resultShapeFailures.length === 0
    && featureRows.every((row) => row.boundedPass);
  return {
    valid,
    universalProof: false,
    conclusion: valid
      ? 'All declared evidence passed without skips for this exact source/runtime/platform/fixture set. This is bounded proof, not universal proof.'
      : 'Feature proof is incomplete or invalid; inspect failed commands, skips/todos, and source stability. No all-clear is claimed.',
    denominators: {
      featuresDeclared: FEATURES.length,
      featuresBoundedPass: featureRows.filter((row) => row.boundedPass).length,
      featuresWithDeclaredGaps: featureRows.filter((row) => row.declaredGap).length,
      cliCommandsDeclared: CLI_COMMANDS.length,
      mcpToolsDeclared: MCP_TOOLS.length,
      hostsDeclared: HOST_IDS.length,
      testFilesPlanned: plan.inventories.testFiles.count,
      evidenceCommandsPlanned: plan.commands.length,
      evidenceCommandsExecuted: results.length,
      evidenceCommandsPassed: results.filter((result) => result.grade.pass).length,
      evidenceCommandsFailed: failedCommands.length,
      observedTestsIncludingRepeatedCorpus: observedTests,
      skippedTests,
      todoTests,
      resultShapeFailures: resultShapeFailures.length,
    },
    sourceStable,
    sourceClean,
    resultShapeFailures,
    tokenClaims,
    missingCommands,
    failedCommands,
    features: featureRows,
  };
}

function isWithin(parent, candidate) {
  const rel = path.relative(parent, candidate);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

async function canonicalFuturePath(candidate) {
  let cursor = path.resolve(candidate);
  const missing = [];
  for (;;) {
    try {
      const real = await fs.realpath(cursor);
      return path.resolve(real, ...missing.reverse());
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

export async function safeArtifactPath(out) {
  const absolute = path.resolve(out);
  const canonicalRoot = await fs.realpath(ROOT);
  const canonicalOutput = await canonicalFuturePath(absolute);
  const rel = path.relative(ROOT, absolute);
  if (rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel))) {
    throw new Error(`--out must be outside the source tree: ${absolute}`);
  }
  if (isWithin(canonicalRoot, canonicalOutput)) {
    throw new Error(`--out resolves through a symlink into the source tree: ${absolute} -> ${canonicalOutput}`);
  }
  for (const candidate of [absolute, `${absolute}.sha256`]) {
    if (await fs.lstat(candidate).then(() => true, () => false)) {
      throw new Error(`refusing to overwrite existing feature-proof evidence: ${candidate}`);
    }
  }
  return absolute;
}

async function writeArtifact(artifact, out) {
  let absolute = await safeArtifactPath(out);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  // `mkdir` may have created previously missing parents, and an existing parent may have been a
  // symlink. Resolve again at the last boundary before the two write-once opens.
  absolute = await safeArtifactPath(absolute);
  const encoded = `${JSON.stringify(artifact, null, 2)}\n`;
  await fs.writeFile(absolute, encoded, { encoding: 'utf8', flag: 'wx' });
  const digest = sha256(encoded);
  await fs.writeFile(`${absolute}.sha256`, `${digest}  ${path.basename(absolute)}\n`, { encoding: 'utf8', flag: 'wx' });
  return { path: absolute, sha256Path: `${absolute}.sha256`, sha256: digest, bytes: Buffer.byteLength(encoded) };
}

function parseArgs(argv) {
  const opts = { plan: false, out: null, help: false, internalDeepRuntime: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--plan' || arg === '--list') opts.plan = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--internal-deep-runtime') opts.internalDeepRuntime = true;
    else if (arg === '--out') {
      if (!argv[index + 1]) throw new Error('--out needs a path');
      opts.out = argv[++index];
    } else {
      throw new Error(`unknown argument ${JSON.stringify(arg)}; partial/skip filters are intentionally unsupported`);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.internalDeepRuntime) {
    if (opts.plan || opts.out || opts.help) throw new Error('internal deep runtime evidence cannot be combined with public modes');
    await printDeepRuntimeTap();
    return;
  }
  if (opts.help) {
    console.log('usage: node scripts/run-feature-proof.mjs --plan | --out <outside-repo.json>');
    console.log('There are no skip/only/timeout flags: a partial run is not a feature-proof artifact.');
    return;
  }
  const plan = await buildPlan();
  if (opts.plan) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  const out = opts.out ?? path.join(os.homedir(), '.cache', 'holt-feature-proof', `feature-proof-${process.platform}-${process.arch}.json`);
  await safeArtifactPath(out); // refuse before doing hours of work

  const startedAt = new Date().toISOString();
  const before = await sourceIdentity();
  const runtime = await runtimeIdentity();
  const results = [];
  for (let index = 0; index < plan.commands.length; index++) {
    const spec = plan.commands[index];
    process.stderr.write(`[${index + 1}/${plan.commands.length}] ${spec.id}: ${spec.description}\n`);
    results.push(await runProcess(spec));
  }
  const after = await sourceIdentity();
  const source = { before, after };
  const grade = gradeRun(plan, results, source);
  const artifact = {
    schemaVersion: 1,
    kind: 'holt-feature-proof',
    startedAt,
    finishedAt: new Date().toISOString(),
    protocol: plan,
    source,
    runtime,
    results,
    ...grade,
  };
  const written = await writeArtifact(artifact, out);
  process.stdout.write(`${JSON.stringify({ ...written, valid: grade.valid, denominators: grade.denominators, conclusion: grade.conclusion }, null, 2)}\n`);
  process.exitCode = grade.valid ? 0 : 1;
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) main().catch((error) => {
  process.stderr.write(`feature-proof: ${error?.stack ?? error?.message ?? String(error)}\n`);
  process.exitCode = 2;
});
