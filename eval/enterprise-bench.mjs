#!/usr/bin/env node
// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — the enterprise-scale benchmark.
 *
 * Tests holt against REAL repositories at scale, with messy worktrees, noise, and
 * full command verification. See BENCHMARKS.md for results.
 *
 * Usage:
 *   node eval/enterprise-bench.mjs [repo-name] [--worktrees N] [--noise-level L]
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { discover } from '../src/discover.mjs';
import { scan } from '../src/scan.mjs';
import { analyze } from '../src/analyze.mjs';

const WORK = path.join(os.homedir(), '.holt-work', 'enterprise-bench');
const CACHE = path.join(WORK, 'cache');
const HOLT_BIN = path.resolve(path.join(import.meta.dirname, '..', 'bin/holt.mjs'));

const REPOS = {
  'holt-self': {
    url: null, local: '/home/raed/grove',
    desc: 'holt itself — 20K lines, the dogfooding case',
  },
  'redis': {
    url: 'https://github.com/redis/redis.git',
    desc: 'Redis — ~1,858 C files, the benchmark from BENCHMARKS.md',
  },
  'postgres': {
    url: 'https://github.com/postgres/postgres.git',
    desc: 'PostgreSQL — large C codebase, diverse file types',
  },
};

const args = process.argv.slice(2);
let repoName = 'holt-self';
let worktreeCount = 50;
let noiseLevel = 1;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--worktrees') worktreeCount = Number(args[++i]);
  else if (args[i] === '--noise-level') noiseLevel = Number(args[++i]);
  else if (args[i] === '--all') repoName = 'all';
  else if (args[i] === '--list') { console.log('Available repos:', Object.keys(REPOS).join(', ')); process.exit(0); }
  else if (!args[i].startsWith('-')) repoName = args[i];
}

function sh(cmd, args, cwd, timeout = 300_000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      cwd, timeout, maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, GIT_AUTHOR_NAME: 'bench', GIT_AUTHOR_EMAIL: 'b@b',
        GIT_COMMITTER_NAME: 'bench', GIT_COMMITTER_EMAIL: 'b@b',
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', LC_ALL: 'C' },
    }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.slice(0, 5).join(' ')}: ${stderr || err.message}`));
      else resolve(String(stdout));
    });
  });
}

function peakRSS() { try { return Math.round(process.memoryUsage().rss / 1024 / 1024); } catch { return 0; } }
async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

async function prepareRepo(name, spec) {
  const cacheDir = path.join(CACHE, name);
  if (await exists(path.join(cacheDir, '.git'))) {
    console.log(`  using cached clone: ${cacheDir}`);
    return cacheDir;
  }
  await fs.mkdir(CACHE, { recursive: true });
  if (spec.local) {
    console.log(`  cloning local repo ${spec.local}...`);
    await sh('git', ['clone', spec.local, cacheDir], CACHE, 120_000);
  } else {
    console.log(`  shallow-cloning ${name} from ${spec.url}...`);
    const t0 = Date.now();
    await sh('git', ['clone', '--depth', '1', spec.url, cacheDir], CACHE, 600_000);
    console.log(`  clone took ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  return cacheDir;
}

async function createWorktrees(root, count, noise) {
  const wtRoot = path.join(WORK, 'wt');
  await fs.rm(wtRoot, { recursive: true, force: true }).catch(() => {});
  // Prune stale worktree registrations from previous runs
  await sh('git', ['worktree', 'prune'], root).catch(() => {});
  await fs.mkdir(wtRoot, { recursive: true });
  const head = (await sh('git', ['rev-parse', 'HEAD'], root)).trim();
  const planted = { atRisk: [], hold: [], disposable: [], gitignored: [], binary: [], huge: [] };
  for (let i = 0; i < count; i++) {
    const id = `ent-${String(i).padStart(4, '0')}`;
    const wt = path.join(wtRoot, id);
    const kind = i % 10;
    try { await sh('git', ['worktree', 'add', '-q', '--detach', wt, head], root); }
    catch (e) { console.log(`  WARN: could not create worktree ${id}: ${e.message}`); continue; }
    if (kind < 2) {
      await fs.writeFile(path.join(wt, `src/ent_${i}.js`), `// UNIQUE ${id}\nexport function ent_${i}() { return ${i}; }\n`).catch(() => {});
      try { await sh('git', ['add', '-A'], wt); await sh('git', ['commit', '-q', '-m', `ent ${i}`], wt); } catch {}
      planted.hold.push(id);
    } else if (kind < 4) {
      await fs.writeFile(path.join(wt, `src/uncommitted_${i}.js`), `// ONLY COPY ${id}\nexport function ent_only_${i}() { return ${i}; }\n`).catch(() => {});
      planted.atRisk.push(id);
    } else if (kind < 5 && noise >= 1) {
      await fs.writeFile(path.join(wt, '.gitignore'), `secret_${i}.env\n`).catch(() => {});
      await fs.writeFile(path.join(wt, `secret_${i}.env`), `API_KEY=unique_to_${id}\n`).catch(() => {});
      planted.gitignored.push(id);
    } else if (kind < 6 && noise >= 2) {
      const buf = Buffer.alloc(1024); buf[0] = 0; buf[1] = 0x89;
      await fs.writeFile(path.join(wt, `data/binary_${i}.png`), buf).catch(() => {});
      planted.binary.push(id);
    } else if (kind < 7 && noise >= 2) {
      await fs.writeFile(path.join(wt, `vendor/huge_${i}.js`), Buffer.alloc(3 * 1024 * 1024, 0x41)).catch(() => {});
      planted.huge.push(id);
    } else if (kind < 8) {
      const body = `export function ent_landed_${i}() { return ${i}; }\n`;
      await fs.writeFile(path.join(wt, `src/landed_${i}.js`), body).catch(() => {});
      try { await sh('git', ['add', '-A'], wt); await sh('git', ['commit', '-q', '-m', `landed ${i}`], wt); } catch {}
      planted.disposable.push(id);
    } else { planted.disposable.push(id); }
  }
  return { wtRoot, planted };
}

async function runPipeline(root) {
  const results = { phases: {}, errors: [] };
  const t0 = Date.now();
  let disc;
  try { disc = await discover(root); } catch (e) { results.errors.push(`discover: ${e.message}`); return results; }
  results.phases.discover = Date.now() - t0;
  results.workstreamCount = disc.worktrees?.length ?? 0;
  const t1 = Date.now();
  let scanned;
  try { scanned = await scan(disc, {}); } catch (e) { results.errors.push(`scan: ${e.message}`); results.phases.scan = Date.now() - t1; return results; }
  results.phases.scan = Date.now() - t1;
  const t2 = Date.now();
  let report;
  try { report = await analyze(scanned, {}); } catch (e) { results.errors.push(`analyze: ${e.message}`); results.phases.analyze = Date.now() - t2; return results; }
  results.phases.analyze = Date.now() - t2;
  results.total = Date.now() - t0;
  results.peakRSS = peakRSS();
  results.report = report;
  results.collisions = report.collisions?.length ?? 0;
  results.duplicates = report.duplicates?.length ?? 0;
  results.safeCount = report.safe?.filter((s) => s.safe).length ?? 0;
  results.atRiskCount = report.unique?.length ?? 0;
  results.skippedCount = report.skipped?.length ?? 0;
  return results;
}

async function testCommands(root) {
  const results = {};
  const commands = [
    ['status', ['status', '--json']],
    ['risk', ['risk', '--json']],
    ['collisions', ['collisions', '--json']],
    ['graph', ['graph', '--html', path.join(WORK, 'graph-test.html')]],
    ['clean', ['clean']],
    ['doctor', ['doctor']],
    ['stash', ['stash', '--json']],
  ];
  for (const [name, cmd] of commands) {
    const t0 = Date.now();
    try {
      const out = await new Promise((resolve, reject) => {
        execFile('node', [HOLT_BIN, ...cmd], {
          cwd: root, timeout: 120_000, maxBuffer: 256 * 1024 * 1024,
          env: { ...process.env, HOME: os.homedir() },
        }, (err, stdout, stderr) => { if (err) reject({ err, stderr, stdout }); else resolve({ stdout, stderr }); });
      });
      results[name] = { ok: true, ms: Date.now() - t0, stdoutLen: out.stdout.length, stderrLen: out.stderr.length, stderr: out.stderr.slice(0, 500) };
      if (cmd.includes('--json')) { try { JSON.parse(out.stdout); results[name].validJson = true; } catch { results[name].validJson = false; results[name].error = 'invalid JSON'; } }
    } catch (e) {
      results[name] = { ok: false, ms: Date.now() - t0, error: e.err?.message || e.message, stderr: (e.stderr || '').slice(0, 500), exitCode: e.err?.code };
    }
  }
  return results;
}

function verifyCorrectness(report, planted) {
  const errors = [], warnings = [];
  for (const id of planted.atRisk) {
    const s = report.safe?.find((x) => x.id?.endsWith(id) || x.id === id);
    if (s?.safe) errors.push(`at-risk ${id}: called SAFE but has uncommitted-only content`);
  }
  for (const id of planted.hold) {
    const s = report.safe?.find((x) => x.id?.endsWith(id) || x.id === id);
    if (s?.safe) errors.push(`hold ${id}: called SAFE but has committed-ahead content`);
  }
  let disposableRight = 0;
  for (const id of planted.disposable) {
    const s = report.safe?.find((x) => x.id?.endsWith(id) || x.id === id);
    if (s?.safe) disposableRight++;
    else warnings.push(`disposable ${id}: not called safe`);
  }
  for (const id of planted.gitignored) {
    const s = report.safe?.find((x) => x.id?.endsWith(id) || x.id === id);
    if (s?.safe) errors.push(`gitignored ${id}: called SAFE but has gitignored-only content`);
  }
  return { errors, warnings, disposableRight, disposableTotal: planted.disposable.length };
}

async function benchmarkRepo(name, spec) {
  console.log(`\n${'═'.repeat(70)}\n  REPO: ${name} — ${spec.desc}\n  worktrees: ${worktreeCount}, noise: ${noiseLevel}\n${'═'.repeat(70)}\n`);
  const issues = [];
  console.log('  [1/5] Preparing repository...');
  let root;
  try { root = await prepareRepo(name, spec); }
  catch (e) { return { name, ok: false, error: `prepare: ${e.message}`, issues }; }
  try { const count = (await sh('git', ['ls-files', '--', '.'], root)).split('\n').filter(Boolean).length; console.log(`  tracked files: ${count}`); } catch {}
  console.log('  [2/5] Creating messy worktrees...');
  const t0 = Date.now();
  let wtInfo;
  try { wtInfo = await createWorktrees(root, worktreeCount, noiseLevel); console.log(`  created in ${((Date.now() - t0) / 1000).toFixed(1)}s`); }
  catch (e) { return { name, ok: false, error: `worktrees: ${e.message}`, issues }; }
  console.log('  [3/5] Running holt pipeline...');
  const pipe = await runPipeline(root);
  for (const e of pipe.errors) { console.log(`  ✗ PIPELINE: ${e}`); issues.push({ phase: 'pipeline', severity: 'critical', msg: e }); }
  console.log(`  discover: ${pipe.phases.discover ?? '?'}ms | scan: ${pipe.phases.scan ?? '?'}ms | analyze: ${pipe.phases.analyze ?? '?'}ms | TOTAL: ${pipe.total ?? '?'}ms | RSS: ${pipe.peakRSS ?? '?'}MB`);
  console.log(`  verdicts: ${pipe.safeCount} safe, ${pipe.atRiskCount} at-risk, ${pipe.skippedCount} skipped`);
  console.log('  [4/5] Verifying correctness...');
  const verify = verifyCorrectness(pipe.report, wtInfo.planted);
  for (const e of verify.errors) { console.log(`  ✗ ${e}`); issues.push({ phase: 'correctness', severity: 'critical', msg: e }); }
  for (const w of verify.warnings) { console.log(`  ⚠ ${w}`); issues.push({ phase: 'correctness', severity: 'medium', msg: w }); }
  console.log(`  disposable: ${verify.disposableRight}/${verify.disposableTotal} correct`);
  console.log('  [5/5] Testing commands...');
  const cmds = await testCommands(root);
  for (const [name, r] of Object.entries(cmds)) {
    if (!r.ok) { console.log(`  ✗ holt ${name}: ${r.error}`); issues.push({ phase: 'command', severity: 'critical', cmd: name, msg: r.error }); }
    else if (r.validJson === false) { console.log(`  ✗ holt ${name}: invalid JSON`); issues.push({ phase: 'command', severity: 'high', cmd: name, msg: 'invalid JSON' }); }
    else if (r.stderrLen > 0) { console.log(`  ⚠ holt ${name}: stderr (${r.stderrLen}b)`); issues.push({ phase: 'command', severity: 'low', cmd: name, msg: r.stderr?.slice(0, 200) }); }
    else { console.log(`  ✓ holt ${name}: ${r.ms}ms${r.validJson ? ', valid JSON' : ''}`); }
  }
  try { await sh('git', ['worktree', 'prune'], root); await fs.rm(wtInfo.wtRoot, { recursive: true, force: true }).catch(() => {}); } catch {}
  return { name, ok: issues.filter((i) => i.severity === 'critical').length === 0, issues,
    metrics: { total: pipe.total, discover: pipe.phases.discover, scan: pipe.phases.scan, analyze: pipe.phases.analyze, peakRSS: pipe.peakRSS, workstreams: pipe.workstreamCount, collisions: pipe.collisions, duplicates: pipe.duplicates, safe: pipe.safeCount, atRisk: pipe.atRiskCount, skipped: pipe.skippedCount, disposableRight: verify.disposableRight, disposableTotal: verify.disposableTotal } };
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════════════╗');
  console.log('║  holt enterprise benchmark — real repos, real mess, real scale    ║');
  console.log('╚════════════════════════════════════════════════════════════════════╝');
  console.log(`  date: ${new Date().toISOString()}`);
  console.log(`  platform: ${process.platform} ${process.arch}, Node ${process.version}`);
  const repos = repoName === 'all' ? Object.entries(REPOS) : [[repoName, REPOS[repoName]]];
  const allResults = [];
  for (const [name, spec] of repos) {
    if (!spec) { console.log(`  unknown repo: ${name}`); continue; }
    try { allResults.push(await benchmarkRepo(name, spec)); }
    catch (e) { console.log(`  FATAL: ${e.message}`); allResults.push({ name, ok: false, error: e.message, issues: [] }); }
  }
  console.log(`\n${'═'.repeat(70)}\n  SUMMARY\n${'═'.repeat(70)}\n`);
  console.log('  | repo | total | scan | RSS | workstreams | safe | at-risk | issues |');
  console.log('  |---|---|---|---|---|---|---|---|');
  for (const r of allResults) {
    const m = r.metrics || {};
    const crit = r.issues?.filter((i) => i.severity === 'critical').length ?? 0;
    console.log(`  | ${r.name} | ${m.total ?? '?'}ms | ${m.scan ?? '?'}ms | ${m.peakRSS ?? '?'}MB | ${m.workstreams ?? '?'} | ${m.safe ?? '?'} | ${m.atRisk ?? '?'} | ${crit}c, ${r.issues?.length ?? 0}t |`);
  }
  const allIssues = allResults.flatMap((r) => r.issues?.map((i) => ({ ...i, repo: r.name })) ?? []);
  if (allIssues.length) { console.log(`\n  ISSUES (${allIssues.length}):`); for (const i of allIssues) console.log(`  [${i.severity}] ${i.repo}/${i.phase}: ${i.msg}`); }
  else { console.log('\n  ✓ NO ISSUES FOUND'); }
  await fs.writeFile(path.join(WORK, 'enterprise-bench-results.json'), JSON.stringify(allResults, null, 2));
  process.exitCode = allIssues.filter((i) => i.severity === 'critical').length > 0 ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(1); });
