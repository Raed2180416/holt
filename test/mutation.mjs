#!/usr/bin/env node
/**
 * holt — targeted mutation testing.
 *
 * A green test suite proves the tests RAN. It does not prove they would have FAILED on a real
 * defect. This harness answers that directly: it deliberately breaks a specific, high-stakes
 * behaviour in the source, runs the tests that are supposed to cover it, and asserts they GO RED.
 *
 * A mutation that survives is a hole: the code could ship broken in exactly that way and every
 * test would still pass.
 *
 * Why hand-picked mutations rather than only Stryker: Stryker mutates everything, which is the
 * right tool for a coverage percentage but spends most of its time on mutants nobody cares about
 * (a flipped `<` in a sort comparator). The mutations below are the ones where being wrong is
 * DANGEROUS — a tool that authorises deleting work, or runs a command it promised never to run.
 * Both are worth having; this one runs in seconds and lives in CI.
 *
 *   node test/mutation.mjs           # run all
 *   node test/mutation.mjs --list    # show them
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * ISOLATION IS LOAD-BEARING. Every mutation is applied to a disposable COPY of this repo and
 * the tests run there — never in the live tree. Proven necessary the hard way: the
 * `allowlist-open` mutation disables holt's refusal layer, and the safety suite asserts
 * refusal by CALLING git() — so under that mutation, the command expected to be refused
 * actually executed. With tests running in the live repo, `git reset --hard` really ran here,
 * and erased uncommitted work three separate times before it was diagnosed (2026-07-31). The
 * pre-commit verification run was the destroyer. Defense in depth now: (1) tests point live
 * ammunition only at throwaway fixtures, (2) src/git.mjs refuses destroyers at a structurally
 * independent first gate, (3) this harness never lets a mutated holt near the real tree —
 * and the tripwire below proves (3) on every single run.
 */
const COPY_SKIP = new Set(['.git', 'node_modules']);

export async function makeWorkCopy() {
  const base = process.env.HOLT_TMPDIR ?? os.tmpdir();
  await fs.mkdir(base, { recursive: true });
  const work = await fs.mkdtemp(path.join(base, 'holt-mutation-'));
  await fs.cp(ROOT, work, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(ROOT, src);
      if (rel === '') return true;
      return !COPY_SKIP.has(rel.split(path.sep)[0]);
    },
  });
  try {
    await fs.symlink(path.join(ROOT, 'node_modules'), path.join(work, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    await fs.cp(path.join(ROOT, 'node_modules'), path.join(work, 'node_modules'), { recursive: true });
  }
  return work;
}

/** Byte-level state of the REAL repo: HEAD + full porcelain status. Any drift = isolation broken. */
async function repoFingerprint() {
  const head = await run('git', ['rev-parse', 'HEAD'], ROOT);
  if (head.code !== 0) return null; // not a git checkout (e.g. unpacked tarball) — tripwire unavailable
  const st = await run('git', ['status', '--porcelain=v2', '--untracked-files=all'], ROOT);
  return `${head.stdout}\n${st.stdout}`;
}

/**
 * Each mutation states the DEFECT it simulates, so a survivor reads as a missing test rather
 * than a puzzle.
 */
export const MUTATIONS = [
  {
    "id": "collisions-head-only",
    "defect": "collisions fall back to committed heads, so a conflict in UNCOMMITTED work — the flagship case — is reported as no collision",
    "file": "src/analyze.mjs",
    "find": "    if (!dirty || scanResult.strictReadOnly) return w.head ?? null;",
    "replace": "    return w.head ?? null; // mutated: uncommitted sides invisible again",
    "tests": [
      "test/e2e/detection.test.mjs"
    ]
  },
  {
    "id": "primary-is-disposable",
    "defect": "the main-working-tree gate is removed — a clean solo repository's ONLY worktree is reported disposable, gate exits 0, and the chain `holt gate $id && rm -rf $id` deletes the repository including .git",
    "file": "src/analyze.mjs",
    "find": "    if (w.isPrimary) {",
    "replace": "    if (false) { // mutated: main working tree offered as a deletion candidate",
    "tests": [
      "test/e2e/integration.test.mjs"
    ]
  },
  {
    "id": "for-loop-body-unseen",
    "defect": "a for-loop over a glob is not decomposed, so `for d in ../wt-*; do rm -rf $d; done` — the mergify incident verbatim — runs its destroyer body unseen and is ALLOWED",
    "file": "src/agent.mjs",
    "find": "  for (const body of expandForLoops(command)) {",
    "replace": "  for (const body of []) { void expandForLoops; // mutated: loop bodies unseen",
    "tests": [
      "test/e2e/integration.test.mjs"
    ]
  },
  {
    "id": "worktree-glob-target-dropped",
    "defect": "the worktree layer resolves only ONE exact path, so `git worktree remove -f ../wt-*` (the literal mergify verb) matches no workstream and is allowed",
    "file": "src/agent.mjs",
    "find": "      : await targetWorkstreams(report, hit.pattern ?? hit.target, cwd);",
    "replace": "      : [await findWorkstream(report, hit.target, cwd)].filter(Boolean); // mutated: glob target dropped",
    "tests": [
      "test/e2e/integration.test.mjs"
    ]
  },
  {
    "id": "containment-ancestor-dropped",
    "defect": "a target that CONTAINS the worktrees (rm -rf .., rm -rf ../wt-*) is dropped as not-holt's-to-defend instead of destroying them — the mergify 29-worktree incident, in the spelling it took",
    "file": "src/agent.mjs",
    "find": "      for (const reached of rootsReachedFromAbove(roots, abs, suffix)) {",
    "replace": "      for (const reached of []) { void rootsReachedFromAbove; // mutated: ancestor targets dropped",
    "tests": [
      "test/e2e/integration.test.mjs"
    ]
  },
  {
    "id": "primary-removability-read-as-content",
    "defect": "the content verbs read the primary's `safe` flag (which means \"not removable\") instead of contentReproducible, so in a single-clone repo — the layout almost every repository has — `git reset --hard`, `git clean -fdx` and `git checkout -- .` are DENIED FOREVER, even on a byte-clean tree, with no escape hatch",
    "file": "src/agent.mjs",
    "find": "    : targets.filter((s) => (s.isPrimary ? s.contentReproducible === false : !s.safe));",
    "replace": "    : targets.filter((s) => !s.safe); // mutated: removability read as content",
    "tests": [
      "test/e2e/integration.test.mjs"
    ]
  },
  {
    "id": "windows-path-not-unescaped",
    "defect": "inline strings are taken as raw source, so a Windows path spelled correctly in JS (`'C:\\\\p\\\\wt'`) resolves to nothing and holt ALLOWS the removal — a silent under-refusal on Windows only",
    "file": "src/agent.mjs",
    "find": "    .map((m) => m[1].replace(/\\\\\\\\/g, '\\\\'))",
    "replace": "    .map((m) => m[1]) // mutated: source spelling used as the path",
    "tests": [
      "test/e2e/integration.test.mjs"
    ]
  },
  {
    "id": "proxy-targets-every-string",
    "defect": "the `rm -rf <str>` targeting proxy is applied to every quoted string again, so a path named only as a shelled-out command's cwd is read as a deletion target — `node -e \"execSync('git log',{cwd:'<repo>'})\"` is denied as rm -rf of the repository",
    "file": "src/agent.mjs",
    "find": "          : (namesADestroyer ? await viaWorktree(`rm -rf ${str}`) : null);",
    "replace": "          : await viaWorktree(`rm -rf ${str}`); // mutated: proxy applied to every string",
    "tests": [
      "test/e2e/integration.test.mjs"
    ]
  },
  {
    "id": "inline-shellout-misses-argv-forms",
    "defect": "execFile/spawn/spawnSync drop out of the inline shell-out detector, so `node -e \"execFile('rm',['-rf','<repo>'])\"` matches no rule at all and is silently allowed",
    "file": "src/agent.mjs",
    "find": "\\b(?:execSync|execFile|execFileSync|spawn|spawnSync|system|popen|qx)\\s*\\(|%x[({[]/",
    "replace": "\\bexecSync\\s*\\(/",
    "tests": [
      "test/e2e/integration.test.mjs"
    ]
  },
  {
    "id": "ownership-inferred-not-recorded",
    "defect": "uninstall goes back to inferring ownership from the residue instead of the install receipt — it either leaves .cursor/.claude/.junie behind (so a fully-uninstalled repo self-detects 13 agent hosts) or deletes a user's own file that merely looks like holt's default",
    "file": "src/integrate/adapters.mjs",
    "find": "      const ours = await holtOwnsFile(repoRoot, 'AGENTS.md', receipt);",
    "replace": "      const ours = false; // mutated: ownership inferred from residue again",
    "tests": [
      "test/e2e/integrate-upgrade.test.mjs"
    ]
  },
  {
    "id": "hook-retirement-blind",
    "defect": "uninstall walks holt's table of known events again — a hook holt wired on an event it has since retired is never looked at, so `holt uninstall` leaves it pointing at a binary the user is about to delete",
    "file": "src/integrate/adapters.mjs",
    "find": "      for (const event of Object.keys(cfg.hooks ?? {})) {\n        if (!Array.isArray(cfg.hooks?.[event])) continue;\n        const isMine = (entry) => {",
    "replace": "      for (const event of Object.keys(CLAUDE_EVENT_SUBCOMMAND)) { // mutated: retirement blind spot\n        if (!Array.isArray(cfg.hooks?.[event])) continue;\n        const isMine = (entry) => {",
    "tests": [
      "test/e2e/integrate-upgrade.test.mjs"
    ]
  },
  {
    "id": "user-regex-runs-unbounded",
    "defect": "familyOverrides are matched on the main thread again — a `.holtrc.json` regex with catastrophic backtracking hangs every holt command including the blocking guard, and nothing in JS can interrupt it",
    "file": "src/discover.mjs",
    "find": "  const safeOverrides = await screenOverrides(familyOverrides, workstreams.map((w) => w.id), {",
    "replace": "  const safeOverrides = familyOverrides; const _unused = ((x) => x)({ // mutated: user regex run unscreened",
    "tests": [
      "test/unit/saferegex.test.mjs"
    ]
  },
  {
    "id": "stash-cap-reads-as-all-clear",
    "defect": "past MAX_ENTRIES the guard reports 'nothing at risk among the 25 I scanned' as a clean allow — `git stash clear` and a drop of stash@{30} destroy a sole copy holt never examined",
    "file": "src/agent.mjs",
    "find": "    if (reachesUnscanned) {",
    "replace": "    if (false) { // mutated: the unscanned tail is treated as an all-clear",
    "tests": [
      "test/e2e/stash-evidence.test.mjs"
    ]
  },
  {
    "id": "mutation-verbs-uncovered",
    "defect": "the reset --hard rule is removed — holt blocks worktree DELETION but allows the command that destroys the same work in place",
    "file": "src/agent.mjs",
    "find": "  { re: new RegExp(`\\\\bgit\\\\s+${GIT_GLOBALS}reset\\\\s+(?:${TARGET}\\\\s+)*--hard\\\\b`), kind: 'git reset --hard (discards uncommitted work)', cwdTarget: true },",
    "replace": "  // mutated: mutation verb uncovered",
    "tests": [
      "test/e2e/integration.test.mjs"
    ]
  },
  {
    "id": "file-granularity-unwatched",
    "defect": "the file layer is switched off — holt blocks worktree destruction but allows `rm <file>`, `git rm -f`, `truncate`, `shred`, `mv` and `> <file>` against the only copy of a file",
    "file": "src/agent.mjs",
    "find": "  const fileVerdict = fileTargets.length ? await assessFileTargets(fileTargets, cwd, ctx) : null;",
    "replace": "  const fileVerdict = null; void fileTargets; // mutated: file granularity unwatched",
    "tests": [
      "test/e2e/integration.test.mjs"
    ]
  },
  {
    "id": "file-gate-trigger-happy",
    "defect": "the file layer stops excluding regenerable output, so `rm -rf node_modules` and `> app.log` are refused — the shape that gets a guard uninstalled",
    "file": "src/scan.mjs",
    "find": "      if (looksGenerated(p) || SCRATCH_WHEN_IGNORED.test(p)) continue;",
    "replace": "      // mutated: generated output is defended like source",
    "tests": [
      "test/e2e/integration.test.mjs"
    ]
  },
  {
    "id": "primary-tree-unwatched",
    "defect": "the hook stops scanning the primary worktree — the one tree git REFUSES to lock, so the hook is its only protection",
    "file": "src/agent.mjs",
    "find": "    ({ report } = await cachedReport(cwd, { includePrimary: true }));\n  } catch (err) {",
    "replace": "    ({ report } = await cachedReport(cwd));\n  } catch (err) {",
    "tests": [
      "test/e2e/integration.test.mjs"
    ]
  },
  {
    id: 'safe-always',
    defect: 'safeToDelete() calls every workstream disposable — the catastrophic failure',
    file: 'src/analyze.mjs',
    find: '      safe: reasons.length === 0,',
    replace: '      safe: true,',
    tests: ['test/e2e/break-it.test.mjs', 'test/e2e/detection.test.mjs'],
  },
  {
    id: 'unique-loose',
    defect: 'uniqueWork() treats a symbol shared by several workstreams as unique to each',
    file: 'src/analyze.mjs',
    find: '        if (symbolOwners.get(k).length === 1) return true;',
    replace: '        if (symbolOwners.get(k).length >= 1) return true; // mutated: every symbol is "unique"',
    tests: ['test/e2e/detection.test.mjs'],
  },
  {
    id: 'ignore-uncommitted',
    defect: 'safeToDelete() ignores the uncommitted layer — the layer git cannot see',
    file: 'src/analyze.mjs',
    find: "    if (uncommittedCount > 0) reasons.push(`${uncommittedCount} uncommitted file(s)`);",
    replace: '    // mutated: uncommitted layer ignored',
    tests: ['test/e2e/break-it.test.mjs'],
  },
  {
    // THE DEFECT THIS ANCHOR WAS WRITTEN FOR: `gate` counted the gitignored layer and `rescue`
    // did not, so one product gave two opposite answers to "would deleting this lose work?" —
    // and the one that exited 0 was the one a `rescue && worktree remove` chain trusts. Dropping
    // the layer HERE now breaks BOTH commands at once, which is exactly the property the fix
    // bought: they can no longer be wrong independently.
    id: 'atrisk-drops-ignored',
    defect: 'contentAtRisk() forgets the gitignored layer — gate and rescue silently disagree again',
    file: 'src/analyze.mjs',
    find: '  const ignored = (w?.ignored?.files ?? []).filter(Boolean);',
    replace: '  const ignored = [];',
    tests: ['test/e2e/actions.test.mjs', 'test/e2e/break-it.test.mjs'],
  },
  {
    id: 'atrisk-blind-reads-empty',
    defect: 'a probe that FAILED reports as an empty worktree — absence of evidence becomes a green light',
    file: 'src/analyze.mjs',
    find: "  if (w?.ignored?.how === 'ignored-probe-failed') {",
    replace: '  if (false) {',
    tests: ['test/e2e/actions.test.mjs'],
  },
  {
    id: 'rescue-builds-own-fileset',
    defect: 'rescue re-derives its own content set instead of sharing the gate — the drift that caused the defect',
    file: 'src/actions.mjs',
    find: '  const files = risk.files;',
    replace: '  const files = [...new Set([...ws.uncommitted.files, ...ws.uncommitted.untracked])].filter(Boolean);',
    tests: ['test/e2e/actions.test.mjs', 'test/e2e/cli.test.mjs'],
  },
  {
    id: 'fail-open-unknown',
    defect: 'an unscannable workstream is reported SAFE instead of unknown (fail-open)',
    file: 'src/analyze.mjs',
    find: "      return { id: w.id, path: w.path, safe: false, confidence: 'unknown', prunable: !!w.prunable, reasons: [w.reason ?? 'not scanned'] };",
    replace: "      return { id: w.id, path: w.path, safe: true, confidence: 'unknown', prunable: !!w.prunable, reasons: [w.reason ?? 'not scanned'] };",
    tests: ['test/e2e/detection.test.mjs', 'test/e2e/break-it.test.mjs'],
  },
  {
    id: 'allowlist-open',
    defect: 'the git allowlist permits everything — holt could run any command',
    file: 'src/git.mjs',
    find: "  return { allowed: false, reason: `'git ${sub}' is not on holt's allowlist` };",
    replace: "  return { allowed: true, tier: 'SAFE' };",
    tests: ['test/unit/safety.test.mjs'],
  },
  {
    id: 'mutation-default-on',
    defect: 'mutating git commands are reachable WITHOUT an explicit opt-in',
    file: 'src/git.mjs',
    find: 'export function classify(argv, { allowMutation = false } = {}) {',
    replace: 'export function classify(argv, { allowMutation = true } = {}) {',
    tests: ['test/e2e/actions.test.mjs', 'test/unit/safety.test.mjs'],
  },
  {
    id: 'no-positional-check',
    defect: 'write forms that differ from reads only by positional count slip through',
    file: 'src/git.mjs',
    find: '  const limit = POSITIONAL_LIMITS[sub];',
    replace: '  const limit = undefined; const _unused = POSITIONAL_LIMITS[sub];',
    tests: ['test/unit/safety.test.mjs'],
  },
  {
    id: 'rescue-unverified',
    defect: 'rescue reports success without checking the capture is complete',
    file: 'src/actions.mjs',
    find: '    if (missing.length) {',
    replace: '    if (false) {',
    tests: ['test/e2e/actions.test.mjs'],
  },
  {
    id: 'clean-no-recheck',
    defect: 'clean deletes on a stale verdict instead of re-verifying (TOCTOU)',
    file: 'src/actions.mjs',
    find: '    if (!still?.safe) {',
    replace: '    if (false) {',
    tests: ['test/e2e/actions.test.mjs'],
  },
  {
    id: 'protect-nothing',
    defect: 'protect() locks nothing, so --force destroys work again',
    file: 'src/actions.mjs',
    find: "  const shouldProtect = report.safe.filter((s) => !s.safe && s.confidence !== 'unknown');",
    replace: '  const shouldProtect = [];',
    tests: ['test/e2e/actions.test.mjs'],
  },
  {
    id: 'three-dot-instrument',
    defect: 'the committed delta uses `diff base...head`, which over-reports stranded work',
    file: 'src/scan.mjs',
    find: '  const mt = await git([\'merge-tree\', \'--write-tree\', baseOid, headOid], { cwd: root, timeout });',
    replace: '  const mt = { code: 2, stdout: \'\', stderr: \'mutated\' };',
    tests: ['test/e2e/detection.test.mjs'],
  },
  {
    id: 'no-discriminative-filter',
    defect: 'boilerplate symbols are not filtered, so every pair looks related',
    file: 'src/analyze.mjs',
    find: '    if (n <= limit) keep.add(k);',
    replace: '    keep.add(k); if (false) keep.delete(k);',
    tests: ['test/e2e/break-it.test.mjs'],
  },
  {
    id: 'license-signature-blind',
    defect: 'the Ed25519 check always passes — any forged or edited license is accepted',
    file: 'src/license.mjs',
    find: "  if (!ok) return { valid: false, code: 'bad-signature', reason: 'signature does not match — this license was edited or forged' };",
    replace: '  ok = true;',
    tests: ['test/unit/license.test.mjs'],
  },
  {
    id: 'license-entitle-all',
    defect: 'every entitlement check returns true — paid features are ungated for everyone',
    file: 'src/license.mjs',
    find: "  const need = FEATURE_TIER[feature];\n  if (!need) return { entitled: true, tier: 'free', feature, reason: 'this feature is free' };",
    replace: "  const need = FEATURE_TIER[feature];\n  return { entitled: true, tier: 'enterprise', feature, reason: 'mutated' };",
    tests: ['test/unit/license.test.mjs'],
  },
  {
    id: 'license-never-expires',
    defect: 'expiry is ignored, so a lapsed license works forever',
    file: 'src/license.mjs',
    find: '  if (expired && !inGrace) {',
    replace: '  if (false) {',
    tests: ['test/unit/license.test.mjs'],
  },
  {
    id: 'policy-silent-pass',
    defect: 'an unparseable policy file is ignored instead of refusing — the team believes rules ran',
    file: 'src/team/policy.mjs',
    find: "        throw Object.assign(",
    replace: "        if (true) { doc = { version: 1, rules: [] }; } else throw Object.assign(",
    tests: ['test/unit/policy.test.mjs'],
  },
  {
    id: 'policy-reads-symbol-keys',
    defect: 'protected-paths matches globs against symbol IDENTITIES again (callable:foo), so the '
      + 'rule silently passes on every real repository — a green build from a rule that never ran',
    file: 'src/team/policy.mjs',
    find: "        const files = pathsCarriedBy(u, ['uncommitted', 'untracked']);",
    replace: "        const files = [...(u.byLayer?.uncommitted ?? []), ...(u.byLayer?.untracked ?? [])]\n"
      + "          .map((x) => x.path ?? x.key ?? '').filter(Boolean);",
    tests: ['test/e2e/team.test.mjs', 'test/unit/policy.test.mjs'],
  },
  {
    id: 'fleet-counts-worktrees',
    defect: 'the fleet keys repositories by directory path again, so every linked worktree counts '
      + 'as another repository and every total it reports is inflated',
    file: 'src/team/fleet.mjs',
    find: '    const id = await repoIdentity(p);',
    replace: '    const id = null; // mutated: no repository identity, one row per directory',
    tests: ['test/e2e/team.test.mjs'],
  },
  {
    id: 'unprotect-unjournalled',
    defect: 'releasing protection leaves no audit line, so the journal asserts a safer state than '
      + 'the repository is in — a hole exactly where the risky action is',
    file: 'src/actions.mjs',
    find: '    if (r.code === 0) {',
    replace: '    if (false) {',
    tests: ['test/e2e/team.test.mjs'],
  },
  {
    id: 'journal-anonymous',
    defect: 'journal entries lose their actor, so an audit trail records what and when but never who',
    file: 'src/journal.mjs',
    find: '    const line = { at: new Date().toISOString(), actor: actorOf({ env }), ...clipEventDeep(event) };',
    replace: '    const line = { at: new Date().toISOString(), ...clipEventDeep(event) };',
    tests: ['test/e2e/team.test.mjs'],
  },
  {
    id: 'actor-invented',
    defect: 'an absent identity is guessed at instead of recorded as unknown — a fabricated actor '
      + 'in an audit log is indistinguishable from a real one',
    file: 'src/journal.mjs',
    find: "    source: override ? 'HOLT_ACTOR' : (agent?.source ?? 'unknown'),",
    replace: "    source: override ? 'HOLT_ACTOR' : (agent?.source ?? 'probably-a-human'),",
    tests: ['test/unit/journal.test.mjs'],
  },
  {
    id: 'webhook-signature-blind',
    defect: 'Stripe webhook signatures are not checked — anyone can POST an event and mint a license',
    file: 'server/index.mjs',
    find: "      if (a.length === b.length && timingSafeEqual(a, b)) return { ok: true, timestamp: t };",
    replace: "      return { ok: true, timestamp: t };",
    tests: ['test/unit/server.test.mjs'],
  },
  {
    id: 'webhook-replay-open',
    defect: 'the replay window is gone — a captured genuine event can be replayed forever',
    file: 'server/index.mjs',
    find: '  if (age > toleranceSec) return { ok: false, reason: `event timestamp is ${Math.round(age)}s old — outside the ${toleranceSec}s replay window` };',
    replace: '  // mutated: no replay window',
    tests: ['test/unit/server.test.mjs'],
  },
  {
    id: 'price-defaults-to-paid',
    defect: 'an unknown Stripe price silently issues a team license instead of refusing',
    file: 'server/index.mjs',
    find: "  return { tier: null, via: null, reason: price ? `price ${price} is not in HOLT_PRICE_MAP` : 'no price or tier metadata on the event' };",
    replace: "  return { tier: 'team', via: 'mutated-default' };",
    tests: ['test/unit/server.test.mjs'],
  },
  {
    id: 'checkout-price-injection',
    defect: 'a raw price id in the checkout query is honoured instead of resolving by plan name',
    file: 'server/index.mjs',
    find: "  const price = [...priceMap.entries()].find(([, tier]) => tier === plan)?.[0];\n  if (!price) return { ok: false, reason: `no price configured for plan '${plan}'` };",
    replace: "  const price = plan;\n  if (!price) return { ok: false, reason: 'x' };",
    tests: ['test/unit/server.test.mjs'],
  },
  {
    id: 'roi-inflates',
    defect: 'the ROI summary counts protects as prevented losses, inflating the safety number',
    file: 'src/roi.mjs',
    find: '  const preventedLosses = blocked + rescued;',
    replace: '  const preventedLosses = blocked + rescued + protectedWt;',
    tests: ['test/unit/roi.test.mjs'],
  },
  {
    id: 'order-loses-colocated',
    defect: 'landing order reverts to the human-filtered collisions, so co-located workstreams sequence in parallel and break on apply',
    file: 'src/order.mjs',
    find: '  for (const c of report.collisionsAll ?? report.collisions ?? []) {',
    replace: '  for (const c of report.collisions ?? []) {',
    tests: ['test/unit/order.test.mjs'],
  },
  {
    id: 'rescue-ref-clobber',
    defect: 'a reused worktree id silently overwrites an earlier rescue ref — destroying a capture',
    file: 'src/actions.mjs',
    find: "git(['update-ref', '--create-reflog', ref, commit, ''],",
    replace: "git(['update-ref', '--create-reflog', ref, commit],",
    tests: ['test/e2e/actions.test.mjs'],
  },
  {
    id: 'idempotency-race',
    defect: 'the event lock is bypassed, so concurrent deliveries of one payment can mint two licenses',
    file: 'server/index.mjs',
    find: '        const outcome = await withEventLock(event.id, dataFile, async () => {',
    replace: '        const outcome = await (async () => {',
    tests: ['test/e2e/purchase-path.test.mjs'],
  },
  {
    id: 'resend-rate-limit-open',
    defect: 'the resend endpoint loses its rate limit — a mail-sending endpoint becomes a spam cannon at our own customers',
    file: 'server/index.mjs',
    find: "        const rl = resendLimiter.take(clientIp(req));\n        if (!rl.allowed) return send(429, { ok: false, reason: 'slow down' }, { ...cors, 'Retry-After': String(rl.retryAfterSec) });",
    replace: "        const rl = { allowed: true };",
    tests: ['test/e2e/purchase-path.test.mjs'],
  },
  {
    id: 'forbidden-open',
    defect: 'the destructive first gate is dead — reset/stash/checkout rely on the allowlist fallthrough alone',
    file: 'src/git.mjs',
    find: '  if (DESTRUCTIVE_ALWAYS.has(sub)) {',
    replace: '  if (false) {',
    tests: ['test/unit/safety.test.mjs'],
  },
  {
    id: 'stash-sweep-uncovered',
    defect: 'the pathspec exemption swallows EVERY stash push, not only scoped ones — bare `git stash` '
      + 'goes back to an unconditional allow, the exact incident this rule exists to stop',
    file: 'src/agent.mjs',
    find: '    unless: (c) => stashHasPathspec(c),',
    replace: '    unless: () => true, // mutated: stash sweep rule never fires',
    tests: ['test/e2e/integration.test.mjs'],
  },
  {
    id: 'stash-ask-cap-removed',
    defect: '`git stash pop` (the recovery action) goes back to a flat deny, and a bare sweeping '
      + '`git stash` on dirty work escalates from ask to deny — over-refusal replacing the honest answer',
    file: 'src/agent.mjs',
    find: "  if (hit.verdict === 'ask') {",
    replace: '  if (false) {',
    tests: ['test/e2e/integration.test.mjs'],
  },
  {
    id: 'redundancy-ignores-durability',
    defect: 'redundancy is claimed against UNCOMMITTED siblings (durableOnly:false), authorising '
      + 'deletion of a worktree whose only twin has not committed the work — the twin can be erased '
      + 'by a git checkout, editor revert or agent write that holt never sees or gates, and the work '
      + 'is lost. The durability bar (durableOnly:true) is the entire reason redundancy can authorise '
      + 'a deletion without losing work.',
    file: 'src/analyze.mjs',
    find: 'const committedCoverage = siblingCoverage(w, committedFiles, { durableOnly: true });',
    replace: 'const committedCoverage = siblingCoverage(w, committedFiles, { durableOnly: false });',
    tests: ['test/e2e/detection.test.mjs', 'test/e2e/actions.test.mjs'],
  },
  {
    id: 'cache-ignores-ignored-bytes',
    defect: 'the safety cache fingerprints ignored paths but not their bytes, so changing a gitignored secret reuses an old answer',
    file: 'src/agent.mjs',
    find: "const st = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'], { cwd: p })",
    replace: "const st = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: p })",
    tests: ['test/e2e/integration.test.mjs'],
  },
  {
    id: 'shell-comment-destroyer-visible',
    defect: 'a destroyer mentioned after an unquoted shell comment is treated as executable command text',
    file: 'src/agent.mjs',
    find: "    if (ch === '#' && (i === 0 || /[\\s;&|(]/.test(s[i - 1]))) {",
    replace: '    if (false) { // mutated: shell comments are scanned as commands',
    tests: ['test/e2e/integration.test.mjs'],
  },
  {
    id: 'bom-command-trusted',
    defect: 'a BOM-prefixed hook command bypasses the parser and is allowed or misclassified instead of asking',
    file: 'src/agent.mjs',
    find: "  if (/^[\\uFEFF\\uFFFE]/.test(command)) {",
    replace: '  if (false) { // mutated: BOM is treated as ordinary input',
    tests: ['test/e2e/integration.test.mjs'],
  },
  {
    id: 'brace-target-allowed',
    defect: 'an unresolved shell brace expansion is treated as a literal path and silently allowed',
    file: 'src/agent.mjs',
    find: "  if (/(?<!\\\\)\\{[^{}\\n]*,[^{}\\n]*\\}/.test(value)) {",
    replace: '  if (false) { // mutated: brace expansion is silently accepted',
    tests: ['test/e2e/integration.test.mjs'],
  },
  {
    id: 'compound-second-match-unseen',
    defect: 'only the first destructive match in a compound command is assessed, so an ask or allow can disarm a later deny',
    file: 'src/agent.mjs',
    find: '  for (const hit of structure.matches) {',
    replace: '  for (const hit of structure.matches.slice(0, 1)) {',
    tests: ['test/e2e/integration.test.mjs'],
  },
  {
    id: 'malformed-hook-allowed',
    defect: 'a malformed or empty pre-tool hook payload falls through to the allow path',
    file: 'bin/holt.mjs',
    find: '    if (payloadError) {',
    replace: '    if (false) { // mutated: malformed hook payload is treated as an empty allow',
    tests: ['test/e2e/cli.test.mjs'],
  },
  {
    // RE-ANCHORED, because the behaviour moved. The command-wide `cwd = commandCwd` no longer
    // decides anything for a matched verb: each match is resolved against the `cd` AND `git -C` in
    // effect at ITS OWN position (matchWorkingDirectory), so deleting the old line stopped
    // simulating the defect and the mutant went green while the code was still guarded. The defect
    // is the same one — "the verb is judged in the caller's directory instead of its own" — pinned
    // at the line that now owns it, which also covers the `git -C <subdir>` half.
    id: 'cd-worktree-layer-ignored',
    defect: 'content verbs ignore the cd / git -C in effect at their own position and are judged in the caller directory instead',
    file: 'src/agent.mjs',
    find: '    const { dir, cUnresolved } = matchWorkingDirectory(command, callerCwd, hit.index ?? 0);',
    replace: '    const { dir, cUnresolved } = { dir: callerCwd, cUnresolved: false }; // mutated: the verb runs where the caller stands',
    tests: ['test/e2e/integration.test.mjs', 'test/e2e/resolution.test.mjs'],
  },
  {
    id: 'c-flag-subdir-not-contained',
    defect: 'a path-less verb redirected into a SUBDIRECTORY of a worktree resolves by exact path only, finds nothing, and is allowed',
    file: 'src/agent.mjs',
    find: '      ? [await containingWorkstream(report, cwd)].filter(Boolean)',
    replace: '      ? [await findWorkstream(report, cwd, cwd)].filter(Boolean) // mutated: exact path, never containment',
    tests: ['test/e2e/resolution.test.mjs'],
  },
  {
    id: 'unterminated-quote-allowed',
    defect: 'a command that ends inside an unterminated quote or heredoc is reported as harmless instead of unread',
    file: 'src/agent.mjs',
    find: '  if (parseIncomplete(command)) {',
    replace: '  if (false) { // mutated: an unparsed tail is treated as data',
    tests: ['test/e2e/resolution.test.mjs'],
  },
  {
    id: 'heredoc-swallows-next-command',
    defect: 'skipping a heredoc body does not close the segment, so the command AFTER the terminator is absorbed and its target dropped',
    file: 'src/agent.mjs',
    find: "      if (sk.kind === 'heredoc') flushSeg(sk.end); else flushWord();",
    replace: '      flushWord(); // mutated: the heredoc body merges with what follows it',
    tests: ['test/e2e/resolution.test.mjs'],
  },
  {
    id: 'live-expansion-read-as-literal',
    defect: 'a live $VAR is treated as a literal filename, so an unresolvable target resolves to a bogus path that matches no worktree and is allowed',
    file: 'src/agent.mjs',
    find: 'function looksLikeExpansion(rawTarget) {\n  if (rawTarget == null) return false;',
    replace: 'function looksLikeExpansion(rawTarget) {\n  if (rawTarget != null) return false; // mutated: every dollar is a literal character',
    tests: ['test/e2e/resolution.test.mjs', 'test/e2e/integration.test.mjs'],
  },
  {
    id: 'unresolved-variable-not-reported',
    defect: 'an unbounded target still carrying a shell expansion is resolved literally instead of reported, turning an ask into a silent allow',
    file: 'src/agent.mjs',
    find: '    if (!GLOBBY.test(value)) {',
    replace: '    if (false) { // mutated: a residual expansion is never reported as unresolved',
    tests: ['test/e2e/resolution.test.mjs', 'test/e2e/integration.test.mjs'],
  },
  {
    id: 'subshell-parens-glued-to-words',
    defect: 'subshell parens are read as ordinary path characters, so a `cd` inside `( … )` is invisible and its target is truncated — both silent allows',
    file: 'src/agent.mjs',
    find: "    if (ch === '(' || ch === ')') { flushSeg(i); continue; }",
    replace: '    if (false) { continue; } // mutated: parens are ordinary path characters',
    tests: ['test/e2e/resolution.test.mjs'],
  },
  {
    id: 'git-c-only-first-applied',
    defect: 'only the first `git -C` is applied, so a command with repeated -C is judged in a directory git never enters',
    file: 'src/agent.mjs',
    find: '      dir = dir === null ? v : combinePath(dir, v);',
    replace: '      dir = dir === null ? v : dir; // mutated: later -C values are dropped',
    tests: ['test/e2e/resolution.test.mjs'],
  },
  {
    id: 'comment-boundary-paren-ignored',
    defect: '`#` after `(` is not read as a comment, so an apostrophe inside it opens a quote that masks the destroyer on the next line',
    file: 'src/agent.mjs',
    find: "    if (ch === '#' && (i === 0 || /[\\s;&|(]/.test(s[i - 1]))) {",
    replace: "    if (ch === '#' && (i === 0 || /[\\s;&|]/.test(s[i - 1]))) { // mutated: ( is not a word boundary",
    tests: ['test/e2e/resolution.test.mjs'],
  },
  {
    // THE MUTANT THE PREVIOUS ROUND WAS MISSING. `heredoc-swallows-next-command` pins the segment
    // BOUNDARY; reverting it never surfaced the case where the body itself is a script. So the
    // silent allow shipped: `. /dev/stdin <<'EOF' … rm -rf ../wt-a … EOF` came back allow with an
    // empty target list, while the identical rm typed on one line denied.
    id: 'heredoc-executor-read-as-prose',
    defect: 'a heredoc body is masked as a document even when its consumer EXECUTES it, so a destroyer written into a shell on stdin is invisible',
    file: 'src/agent.mjs',
    find: '        const consumer = heredocConsumesCode(s.slice(cmdStart, bodyStart));',
    replace: '        const consumer = null; // mutated: every body is prose, whoever receives it',
    tests: ['test/e2e/resolution.test.mjs'],
  },
  {
    // ONE CLASSIFICATION, EVERY READER. The tokenizer would still read an unmasked body, so this
    // mutant is only killable by a verb the FILE layer cannot see — `git reset --hard`,
    // `git worktree remove`, `git clean` — which is exactly what the test asserts.
    id: 'executed-heredoc-masked-from-verb-layer',
    defect: 'the verb layer masks a heredoc its own scanner classified as code, so a worktree-only destroyer inside it never matches a rule',
    file: 'src/agent.mjs',
    find: "    .filter((r) => r[2] !== 'heredoc-code')",
    replace: '    .filter(() => true) // mutated: an executed body is masked from the verb layer anyway',
    tests: ['test/e2e/resolution.test.mjs'],
  },
  {
    id: 'heredoc-consumer-ignores-pipeline',
    defect: 'only the stage the heredoc operator is written against is read, so `cat <<EOF | bash` is judged by the cat and its body is treated as a document',
    file: 'src/agent.mjs',
    find: "    if (c === '|') { stage(); if (text[i + 1] === '|') i++; continue; }",
    replace: '    if (c === \'|\') { break; } // mutated: the rest of the pipeline is not a consumer',
    tests: ['test/e2e/resolution.test.mjs'],
  },
  {
    // TWO READERS OF ONE RULE IS THE DEFECT ITSELF. The tokenizer honours `\` and the mask scanner
    // did not, which cost in both directions at once: ordinary `sed 's/it'\''s/its/'` became
    // "unparseable", and an EVEN number of escaped quotes masked a real `git -C … reset --hard`.
    id: 'escaped-quote-opens-a-mask',
    defect: 'the mask scanner reads a backslash-escaped quote as an opening quote, masking whatever follows it and refusing valid shell',
    file: 'src/agent.mjs',
    find: '      if (backslashEscapes(next, word, hasWord)) { word += next; hasWord = true; i += 2; continue; }',
    replace: '      if (false) { word += next; hasWord = true; i += 2; continue; } // mutated: no escapes for the scanner',
    tests: ['test/e2e/resolution.test.mjs'],
  },
  {
    id: 'interpreter-heredoc-program-unread',
    defect: 'an interpreter reads its program from a heredoc and holt reads only the -e/-c form, so `node <<X … rmSync(worktree) … X` is a silent allow',
    file: 'src/agent.mjs',
    find: '      for (const [how, code] of [...flagged, ...bodies]) {',
    replace: '      for (const [how, code] of flagged) { // mutated: only an inline flag carries a program',
    tests: ['test/e2e/resolution.test.mjs'],
  },
  {
    id: 'read-heredoc-still-called-unseen',
    defect: 'a shell whose program is a heredoc holt has already READ is still reported as executing input holt cannot see — absence of evidence sold as evidence of absence',
    file: 'src/agent.mjs',
    find: '      const literalProgram = readable.some(([a]) => a >= seg.start && a <= seg.end);',
    replace: '      const literalProgram = false; // mutated: a body holt read is still called unseen',
    tests: ['test/e2e/resolution.test.mjs'],
  },
  {
    id: 'cd-ambiguity-allowed',
    defect: 'cd - and popd are guessed instead of asking when the prior directory is not statically known',
    file: 'src/agent.mjs',
    find: "  if (hasAmbiguousDirectoryChange(command)) unresolved.push('ambiguous shell working-directory change');",
    replace: "  if (false) unresolved.push('ambiguous shell working-directory change');",
    tests: ['test/e2e/integration.test.mjs'],
  },
  {
    id: 'guard-allowlist-ignored',
    defect: 'a human-reviewed guardAllow entry is ignored, so the explicit escape hatch does not work',
    file: 'src/agent.mjs',
    find: '  if (allowlistPattern) {',
    replace: '  if (false) { // mutated: guardAllow is ignored',
    tests: ['test/e2e/integration.test.mjs'],
  },
  {
    id: 'claude-allow-bypasses-native-permissions',
    defect: 'Claude allow output emits permissionDecision:allow and bypasses the host native permission flow',
    file: 'src/integrate/adapters.mjs',
    find: "    if (verdict.decision === 'allow') return {};",
    replace: "    if (verdict.decision === 'allow') return { hookSpecificOutput: { hookEventName: eventName, permissionDecision: 'allow' } };",
    tests: ['test/e2e/integration.test.mjs'],
  },
];

export function run(cmd, args, cwd, timeout = 600_000) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      cwd, timeout, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, HOLT_TMPDIR: process.env.HOLT_TMPDIR ?? undefined },
    }, (err, stdout, stderr) => resolve({
      code: err ? (err.code ?? 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''),
    }));
  });
}

export async function applyMutation(work, m) {
  const file = path.join(work, m.file);
  const original = await fs.readFile(file, 'utf8');
  if (!original.includes(m.find)) {
    return { ok: false, original, error: `anchor not found in ${m.file}: ${m.find.slice(0, 70)}` };
  }
  await fs.writeFile(file, original.replace(m.find, m.replace), 'utf8');
  return { ok: true, original, file };
}

export function classifyMutationResult(result) {
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (/SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find module|Cannot use import statement outside a module/i.test(output)) {
    return { outcome: 'invalid', detail: 'mutation caused a syntax or module-loading error' };
  }
  if (result.code === 0) return { outcome: 'survived', detail: 'all tests passed' };
  if (/\bnot ok\b|# fail [1-9]\d*|\n✖\s|\bAssertionError\b.*\bat TestContext\b/is.test(output)) {
    return { outcome: 'killed', detail: 'the test suite reported a failing test' };
  }
  return { outcome: 'invalid', detail: 'test runner exited without reporting a failing test' };
}

async function main() {
  if (process.argv.includes('--list')) {
    for (const m of MUTATIONS) console.log(`${m.id.padEnd(24)} ${m.defect}`);
    return;
  }

  console.log(`holt mutation testing — ${MUTATIONS.length} deliberate defects\n`);
  console.log('Each one must make the tests GO RED. A survivor is a hole in the suite.\n');

  const before = await repoFingerprint();
  if (!before) console.log('  (tripwire unavailable: not running from a git checkout)\n');

  const work = await makeWorkCopy();
  const results = [];
  try {
    for (const m of MUTATIONS) {
      process.stdout.write(`  ${m.id.padEnd(24)} `);

      const applied = await applyMutation(work, m);
      if (!applied.ok) {
        console.log(`SKIP  (${applied.error})`);
        results.push({ ...m, outcome: 'skipped', detail: applied.error });
        continue;
      }

      try {
        const r = await run(process.execPath, ['--test', ...m.tests], work);
        const classified = classifyMutationResult(r);
        const label = classified.outcome === 'killed'
          ? 'killed  (tests caught it)'
          : classified.outcome === 'survived'
            ? 'SURVIVED  ← HOLE IN THE SUITE'
            : 'INVALID  (runner did not execute a failing test)';
        console.log(label);
        results.push({ ...m, ...classified });
      } finally {
        await fs.writeFile(path.join(work, m.file), applied.original, 'utf8');
      }

      // The tripwire: after EVERY mutation, the real repo must be byte-identical to how this
      // run found it. If it is not, isolation is broken and nothing else this harness prints
      // can be trusted — name the mutation and stop the world.
      if (before) {
        const now = await repoFingerprint();
        if (now !== before) {
          console.error(`\n  ✖ TRIPWIRE: the LIVE repository changed during mutation '${m.id}'.`);
          console.error('    A mutated holt reached outside its scratch copy. Fix that before anything else;');
          console.error('    every result above is suspect and uncommitted work may have been altered.');
          process.exitCode = 2;
          return;
        }
      }
    }
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }

  const killed = results.filter((r) => r.outcome === 'killed').length;
  const survived = results.filter((r) => r.outcome === 'survived');
  const skipped = results.filter((r) => r.outcome === 'skipped');
  const invalid = results.filter((r) => r.outcome === 'invalid');
  const scored = killed + survived.length;

  console.log(`\n  ${killed}/${scored} mutations killed`
    + (scored ? ` (${Math.round((killed / scored) * 100)}%)` : '')
    + (skipped.length ? `  ·  ${skipped.length} skipped (anchor drifted)` : '')
    + (invalid.length ? `  ·  ${invalid.length} invalid (runner did not execute a failing test)` : ''));

  if (skipped.length) {
    console.log('\n  SKIPPED mutations prove NOTHING — their anchors no longer match the source:');
    for (const s of skipped) console.log(`    ${s.id}: ${s.detail}`);
  }

  if (invalid.length) {
    console.log('\n  INVALID MUTATIONS — the runner did not execute a failing test:');
    for (const item of invalid) console.log(`    ${item.id}: ${item.detail}`);
    process.exitCode = 1;
    return;
  }

  if (survived.length) {
    console.log('\n  SURVIVORS — the code could ship broken this way and every test would pass:');
    for (const s of survived) console.log(`    ${s.id}: ${s.defect}`);
    process.exitCode = 1;
    return;
  }
  if (skipped.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
