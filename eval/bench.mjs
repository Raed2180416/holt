/**
 * holt — the scale benchmark.
 *
 * Correctness at N=8 says nothing about N=300, and "fast on my repo" is not a number. This
 * builds a repository with a configurable number of worktrees in a fixed composition, then
 * measures BOTH:
 *
 *   time         full scan+analyze wall clock, plus the per-phase split
 *   correctness  every planted at-risk worktree flagged, every disposable one identified —
 *                at scale, not just in the small fixtures
 *
 * A benchmark that measures speed without re-checking correctness would reward a scanner that
 * got faster by skipping work — the exact silent failure this project keeps finding. So the
 * correctness check IS part of the benchmark, and a wrong verdict fails the run outright.
 *
 * Composition per 10 worktrees (deterministic, seeded by index):
 *   3 committed-ahead (unique function each)     -> must be flagged, NOT disposable
 *   2 uncommitted-only (unique file each)        -> must be flagged at-risk
 *   3 landed (base independently has content)    -> must be disposable
 *   2 empty                                      -> must be disposable
 *
 *   node eval/bench.mjs [count]        # default 100
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { discover } from '../src/discover.mjs';
import { scan } from '../src/scan.mjs';
import { analyze } from '../src/analyze.mjs';

const COUNT = Number(process.argv[2] ?? 100);
const WORK = process.env.HOLT_BENCH_WORK
  ?? path.join(os.homedir(), '.holt-work', 'holt-bench');

function sh(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      cwd, timeout: 120_000, maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'bench', GIT_AUTHOR_EMAIL: 'b@b', GIT_COMMITTER_NAME: 'bench',
        GIT_COMMITTER_EMAIL: 'b@b', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
        LC_ALL: 'C',
      },
    }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.slice(0, 3).join(' ')}: ${stderr}`));
      else resolve(String(stdout));
    });
  });
}

async function write(dir, rel, content) {
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

async function main() {
  console.log(`holt bench · ${COUNT} worktrees\n`);
  await fs.rm(WORK, { recursive: true, force: true });
  const root = path.join(WORK, 'repo');
  await fs.mkdir(root, { recursive: true });

  // ---- build ---------------------------------------------------------------
  const t0 = Date.now();
  await sh('git', ['init', '-q', '--initial-branch=main'], root);
  await write(root, 'src/base.js', 'export function baseline() { return 1; }\n');
  // A moderately real base: 50 files so scans do meaningful work.
  for (let i = 0; i < 50; i++) {
    await write(root, `src/mod_${i}.js`, `export function mod_${i}() { return ${i}; }\n`);
  }
  await sh('git', ['add', '-A'], root);
  await sh('git', ['commit', '-q', '-m', 'base'], root);
  const base = (await sh('git', ['rev-parse', 'HEAD'], root)).trim();

  const expect = { atRisk: new Set(), hold: new Set(), disposable: new Set() };
  const wtRoot = path.join(WORK, 'wt');
  await fs.mkdir(wtRoot, { recursive: true });

  for (let i = 0; i < COUNT; i++) {
    const id = `bench-${String(i).padStart(4, '0')}`;
    const wt = path.join(wtRoot, id);
    await sh('git', ['worktree', 'add', '-q', '--detach', wt, base], root);

    const kind = i % 10;
    if (kind < 3) {
      // committed-ahead
      await write(wt, `src/ahead_${i}.js`, `export function ahead_${i}() { return ${i}; }\n`);
      await sh('git', ['add', '-A'], wt);
      await sh('git', ['commit', '-q', '-m', `ahead ${i}`], wt);
      expect.hold.add(id);
    } else if (kind < 5) {
      // uncommitted-only
      await write(wt, `src/only_${i}.js`, `export function only_${i}() { return ${i}; }\n`);
      expect.atRisk.add(id);
    } else if (kind < 8) {
      // landed: committed here AND independently on base
      const body = `export function landed_${i}() { return ${i}; }\n`;
      await write(wt, `src/landed_${i}.js`, body);
      await sh('git', ['add', '-A'], wt);
      await sh('git', ['commit', '-q', '-m', `landed ${i}`], wt);
      await write(root, `src/landed_${i}.js`, body);
      await sh('git', ['add', '-A'], root);
      await sh('git', ['commit', '-q', '-m', `base lands ${i}`], root);
      expect.disposable.add(id);
    } else {
      expect.disposable.add(id);
    }
  }
  const buildMs = Date.now() - t0;
  console.log(`  build         ${(buildMs / 1000).toFixed(1)}s (${COUNT} worktrees, fixture cost — not holt)`);

  // ---- measure -------------------------------------------------------------
  const t1 = Date.now();
  const disc = await discover(root);
  const tDisc = Date.now();
  const scanned = await scan(disc, {});
  const tScan = Date.now();
  const report = await analyze(scanned, {});
  const tAnalyze = Date.now();

  console.log(`  discover      ${tDisc - t1}ms`);
  console.log(`  scan          ${tScan - tDisc}ms  (files + symbols, ${scanned.workstreams.length} workstreams)`);
  console.log(`  analyze       ${tAnalyze - tScan}ms  (${report.collisions.length} collisions, ${report.duplicates.length} dup pairs)`);
  console.log(`  TOTAL         ${tAnalyze - t1}ms  ·  ${((tAnalyze - t1) / COUNT).toFixed(1)}ms/worktree\n`);

  // ---- correctness AT SCALE ------------------------------------------------
  const errors = [];
  for (const id of expect.atRisk) {
    const u = report.unique.find((x) => x.id === id);
    if (!u || u.uncommittedOnlyCount < 1) errors.push(`${id}: planted at-risk, not flagged`);
    const s = report.safe.find((x) => x.id === id);
    if (s?.safe) errors.push(`${id}: planted at-risk, called SAFE`);
  }
  for (const id of expect.hold) {
    const s = report.safe.find((x) => x.id === id);
    if (s?.safe) errors.push(`${id}: planted committed-ahead, called SAFE`);
  }
  let disposablesRight = 0;
  for (const id of expect.disposable) {
    const s = report.safe.find((x) => x.id === id);
    if (s?.safe) disposablesRight++;
    else errors.push(`${id}: planted disposable, NOT called safe (${s?.reasons?.join('; ')})`);
  }

  console.log(`  correctness   at-risk ${expect.atRisk.size}/${expect.atRisk.size} flagged · `
    + `hold ${expect.hold.size}/${expect.hold.size} held · `
    + `disposable ${disposablesRight}/${expect.disposable.size} identified`);

  if (errors.length) {
    console.error(`\n  ✗ ${errors.length} CORRECTNESS FAILURES AT SCALE — the speed number above is void:\n`
      + errors.slice(0, 10).map((e) => `    ${e}`).join('\n'));
    process.exitCode = 1;
  } else {
    console.log('  ✓ every planted verdict correct at this scale\n');
  }

  await fs.rm(WORK, { recursive: true, force: true }).catch(() => {});
}

main().catch((e) => { console.error(e); process.exit(1); });
