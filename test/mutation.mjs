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
    find: '.filter((k) => symbolOwners.get(k).length === 1)',
    replace: '.filter((k) => symbolOwners.get(k).length >= 1)',
    tests: ['test/e2e/detection.test.mjs'],
  },
  {
    id: 'ignore-uncommitted',
    defect: 'safeToDelete() ignores the uncommitted layer — the layer git cannot see',
    file: 'src/analyze.mjs',
    find: "    if (w.uncommitted.count > 0) reasons.push(`${w.uncommitted.count} uncommitted file(s)`);",
    replace: '    // mutated: uncommitted layer ignored',
    tests: ['test/e2e/break-it.test.mjs'],
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
    find: "      throw Object.assign(new Error(`${rel} is not valid JSON (${e.message}) — refusing to run with a policy nobody can read`), { code: 'POLICY_PARSE' });",
    replace: '      continue;',
    tests: ['test/unit/policy.test.mjs'],
  },
  {
    id: 'forbidden-open',
    defect: 'the destructive first gate is dead — reset/stash/checkout rely on the allowlist fallthrough alone',
    file: 'src/git.mjs',
    find: '  if (DESTRUCTIVE_ALWAYS.has(sub)) {',
    replace: '  if (false) {',
    tests: ['test/unit/safety.test.mjs'],
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
