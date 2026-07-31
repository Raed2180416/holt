#!/usr/bin/env node
/**
 * grove — targeted mutation testing.
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
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

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
    defect: 'the git allowlist permits everything — grove could run any command',
    file: 'src/git.mjs',
    find: "  return { allowed: false, reason: `'git ${sub}' is not on grove's allowlist` };",
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
];

function run(cmd, args, cwd, timeout = 600_000) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      cwd, timeout, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GROVE_TMPDIR: process.env.GROVE_TMPDIR ?? undefined },
    }, (err, stdout, stderr) => resolve({
      code: err ? (err.code ?? 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''),
    }));
  });
}

async function applyMutation(m) {
  const file = path.join(ROOT, m.file);
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

  console.log(`grove mutation testing — ${MUTATIONS.length} deliberate defects\n`);
  console.log('Each one must make the tests GO RED. A survivor is a hole in the suite.\n');

  const results = [];
  for (const m of MUTATIONS) {
    process.stdout.write(`  ${m.id.padEnd(24)} `);

    const applied = await applyMutation(m);
    if (!applied.ok) {
      console.log(`SKIP  (${applied.error})`);
      results.push({ ...m, outcome: 'skipped', detail: applied.error });
      continue;
    }

    try {
      const r = await run(process.execPath, ['--test', ...m.tests], ROOT);
      const killed = r.code !== 0;
      console.log(killed ? 'killed  (tests caught it)' : 'SURVIVED  ← HOLE IN THE SUITE');
      results.push({ ...m, outcome: killed ? 'killed' : 'survived' });
    } finally {
      await fs.writeFile(path.join(ROOT, m.file), applied.original, 'utf8');
    }
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
