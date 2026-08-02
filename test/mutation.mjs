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
import { fileURLToPath } from 'node:url';

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

async function makeWorkCopy() {
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
const MUTATIONS = [
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
    "find": "    ({ report } = await cachedReport(cwd, { includePrimary: true }));",
    "replace": "    ({ report } = await cachedReport(cwd));",
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
    find: "      return { id: w.id, path: w.path, safe: false, confidence: 'unknown', reasons: [w.reason ?? 'not scanned'] };",
    replace: "      return { id: w.id, path: w.path, safe: true, confidence: 'unknown', reasons: [w.reason ?? 'not scanned'] };",
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
    replace: '    keep.add(k); if (false)',
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
    find: '    const line = { at: new Date().toISOString(), actor: actorOf({ env }), ...event };',
    replace: '    const line = { at: new Date().toISOString(), ...event };',
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
    find: '      if (!oid || oid === commit) break;',
    replace: '      break;',
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
];

function run(cmd, args, cwd, timeout = 600_000) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      cwd, timeout, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, HOLT_TMPDIR: process.env.HOLT_TMPDIR ?? undefined },
    }, (err, stdout, stderr) => resolve({
      code: err ? (err.code ?? 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''),
    }));
  });
}

async function applyMutation(work, m) {
  const file = path.join(work, m.file);
  const original = await fs.readFile(file, 'utf8');
  if (!original.includes(m.find)) {
    return { ok: false, original, error: `anchor not found in ${m.file}: ${m.find.slice(0, 70)}` };
  }
  await fs.writeFile(file, original.replace(m.find, m.replace), 'utf8');
  return { ok: true, original, file };
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
        const killed = r.code !== 0;
        console.log(killed ? 'killed  (tests caught it)' : 'SURVIVED  ← HOLE IN THE SUITE');
        results.push({ ...m, outcome: killed ? 'killed' : 'survived' });
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
  const scored = killed + survived.length;

  console.log(`\n  ${killed}/${scored} mutations killed`
    + (scored ? ` (${Math.round((killed / scored) * 100)}%)` : '')
    + (skipped.length ? `  ·  ${skipped.length} skipped (anchor drifted)` : ''));

  if (skipped.length) {
    console.log('\n  SKIPPED mutations prove NOTHING — their anchors no longer match the source:');
    for (const s of skipped) console.log(`    ${s.id}: ${s.detail}`);
  }

  if (survived.length) {
    console.log('\n  SURVIVORS — the code could ship broken this way and every test would pass:');
    for (const s of survived) console.log(`    ${s.id}: ${s.defect}`);
    process.exitCode = 1;
    return;
  }
  if (skipped.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
