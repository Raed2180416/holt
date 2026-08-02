#!/usr/bin/env node
// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — what the guard costs an agent, per tool call.
 *
 * THE NUMBER THAT DECIDES WHETHER holt SURVIVES CONTACT WITH A REAL SESSION. The PreToolUse hook
 * runs before every Bash command an agent issues. If it is slow it does not matter how correct it
 * is: it gets uninstalled, and an uninstalled guard protects nothing. This was the one cost never
 * measured, while a defect that stalled every call for as long as the host held stdin — 27
 * seconds, measured — sat in the hook untouched.
 *
 * Four regimes, because they answer different questions:
 *
 *   A steady state          an ordinary command, nothing changing. The common case.
 *   B active fan-out        an ordinary command while a SIBLING writes between every call, so the
 *                           report cache is cold every single time. This is the shape of a real
 *                           overnight fan-out and the one a cache-based design has to survive.
 *   C destructive + churn   the expensive path: a command that COULD lose work, cache always cold.
 *   D destructive, warm     the same command with the cache hot, to separate scan from spawn.
 *
 * A and B alone would flatter the tool: `git status` short-circuits before the scan (there is
 * nothing destructive to weigh), so they measure the cheap gate and not the analysis.
 *
 * Usage: node eval/hook-latency.mjs [worktrees=12] [calls=12]
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const run = promisify(execFile);
const HOLT = path.resolve(import.meta.dirname, '..', 'bin', 'holt.mjs');
const BASE = path.join(process.env.HOLT_TMPDIR || os.tmpdir(), 'holt-hook-latency');

const N_WT = Number(process.argv[2] ?? 12);
const N_CALLS = Number(process.argv[3] ?? 12);

await fs.rm(BASE, { recursive: true, force: true }).catch(() => {});
await fs.mkdir(BASE, { recursive: true });
const repo = path.join(BASE, 'repo');
await fs.mkdir(repo);
const g = (a, cwd = repo) => run('git', a, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }, maxBuffer: 64 * 1024 * 1024 });
await g(['init', '-q', '-b', 'main', '.']);
await g(['config', 'user.email', 'p@p.test']);
await g(['config', 'user.name', 'p']);
await fs.mkdir(path.join(repo, 'src'), { recursive: true });
for (let i = 0; i < 60; i++) await fs.writeFile(path.join(repo, 'src', `f${i}.js`), `export function base${i}(){return ${i};}\n`);
await g(['add', '-A']); await g(['commit', '-qm', 'base']);

const wts = [];
for (let i = 0; i < N_WT; i++) {
  const p = path.join(BASE, `wt${i}`);
  await g(['worktree', 'add', '-q', '--detach', p]);
  await fs.writeFile(path.join(p, 'src', `agent${i}.js`), `export function agent${i}(){return ${i};}\n`);
  wts.push(p);
}

function hook(cwd, command) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = execFile(process.execPath, [HOLT, 'hook', 'pre-tool-use', '--cwd', cwd], {
      cwd, timeout: 300_000, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, HOLT_TMPDIR: BASE },
    }, (error, stdout, stderr) => {
      const code = error ? (error.code ?? 1) : 0;
      const text = String(stdout ?? '').trim();
      let decision = null;
      if (text) {
        try {
          const parsed = JSON.parse(text);
          decision = parsed.decision ?? parsed.hookSpecificOutput?.permissionDecision ?? null;
        } catch {
          decision = 'invalid-json';
        }
      } else if (code === 0) {
        decision = 'allow';
      }
      resolve({ elapsed: Date.now() - started, code, decision, stdout: text, stderr: String(stderr ?? '') });
    });
    child.stdin.end(JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }));
  });
}

async function checkedHook(cwd, command, expected) {
  const result = await hook(cwd, command);
  const valid = expected === 'allow'
    ? result.code === 0 && (result.decision === null || result.decision === 'allow')
    : result.code !== 0 && result.decision === expected;
  if (!valid) {
    throw new Error(`hook verdict mismatch for ${JSON.stringify(command)}: expected ${expected}, got ${JSON.stringify(result)}`);
  }
  return result.elapsed;
}

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)]; };

// ---- A: STEADY STATE — nothing changes between calls (best case, cache always hits) ----
const cold = await checkedHook(repo, 'git status', 'allow');
const warm = [];
for (let i = 0; i < N_CALLS; i++) warm.push(await checkedHook(repo, 'git status', 'allow'));

// ---- B: ACTIVE FAN-OUT — a different worktree writes a file before every call ----
const churn = [];
for (let i = 0; i < N_CALLS; i++) {
  const w = wts[i % wts.length];
  await fs.writeFile(path.join(w, 'src', `churn${i}.js`), `export function churn${i}(){return ${i};}\n`);
  churn.push(await checkedHook(repo, 'git status', 'allow'));
}

// ---- C: THE EXPENSIVE PATH — a DESTRUCTIVE command targeting a worktree, under churn.
// `git status` short-circuits before the scan (nothing destructive to weigh), so A and B only
// prove the cheap gate is cheap. This is the call that actually costs a scan.
const destructive = [];
for (let i = 0; i < N_CALLS; i++) {
  const w = wts[i % wts.length];
  await fs.writeFile(path.join(w, 'src', `churn2_${i}.js`), `export function c2_${i}(){return ${i};}\n`);
  destructive.push(await checkedHook(repo, `rm -rf ${wts[(i + 1) % wts.length]}`, 'deny'));
}

// ---- D: the same destructive command with NOTHING changing — pure cache-hit path ----
const destructiveWarm = [];
for (let i = 0; i < N_CALLS; i++) destructiveWarm.push(await checkedHook(repo, `rm -rf ${wts[0]}`, 'deny'));

console.log(JSON.stringify({
  worktrees: N_WT,
  calls: N_CALLS,
  coldFirstCallMs: cold,
  steadyState: { p50: pct(warm, 50), p90: pct(warm, 90), max: pct(warm, 100), samples: warm },
  activeFanOut: { p50: pct(churn, 50), p90: pct(churn, 90), max: pct(churn, 100) },
  destructiveUnderChurn: { p50: pct(destructive, 50), p90: pct(destructive, 90), max: pct(destructive, 100), samples: destructive },
  destructiveCacheHit: { p50: pct(destructiveWarm, 50), p90: pct(destructiveWarm, 90), max: pct(destructiveWarm, 100) },
}, null, 1));
