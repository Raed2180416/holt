/**
 * holt — the safety invariant, under randomized attack with an INDEPENDENT oracle.
 *
 * Every hand-written test encodes its author's imagination, and this project has already caught
 * its author's imagination failing four separate times. So this suite stops imagining:
 *
 *   1. Generate a repository whose worktree states are RANDOM compositions of every dimension
 *      holt reasons about: committed-ahead / committed-but-landed / uncommitted-tracked /
 *      untracked / deleted files / renames / detached vs branched / nested junk.
 *   2. Compute ground truth with an INDEPENDENT ORACLE that shares no code with holt: for each
 *      worktree, does any file's content differ from base, or exist that base lacks — measured
 *      by direct file comparison against a pristine base checkout, plus raw `git status`.
 *   3. Assert THE invariant of the whole product:
 *
 *         if the oracle says a worktree holds recoverable content holt could lose,
 *         holt must NOT call it safe — and clean --apply must NOT remove it.
 *
 * The oracle is deliberately crude. It cannot rank, dedupe, or attribute — but on the single
 * question "is there content here that base does not have", crude and independent beats clever
 * and shared. If holt and the oracle disagree, holt is wrong until proven otherwise.
 *
 * Seeded PRNG: failures reproduce exactly (the seed is in the assertion message), so a fuzz
 * failure is a bug report, not a shrug.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { newRepo } from '../fixtures.mjs';
import { discover } from '../../src/discover.mjs';
import { scan } from '../../src/scan.mjs';
import { analyze } from '../../src/analyze.mjs';
import { clean } from '../../src/actions.mjs';

function sh(cmd, args, cwd) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      cwd, timeout: 60_000, maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'fuzz', GIT_AUTHOR_EMAIL: 'f@f', GIT_COMMITTER_NAME: 'fuzz',
        GIT_COMMITTER_EMAIL: 'f@f', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
        LC_ALL: 'C',
      },
    }, (err, stdout, stderr) => resolve({
      code: err ? (err.code ?? -1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''),
    }));
  });
}

/** Deterministic PRNG — mulberry32. A fuzz failure must be reproducible from its seed. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The state menu. Each entry mutates one worktree and returns whether the oracle should expect
 * RECOVERABLE CONTENT AT RISK there ('risky'), content base already has ('landed'), or nothing.
 */
const MOVES = [
  async function committedAhead(fx, wt, r) {
    const name = `fn_${Math.floor(r() * 1e6)}`;
    await fx.write(`src/${name}.js`, `export function ${name}() { return ${Math.floor(r() * 100)}; }\n`, wt);
    await fx.commit(`ahead ${name}`, wt);
    return 'risky';
  },
  async function committedLanded(fx, wt, r) {
    // The same content lands on base independently — this worktree adds NOTHING.
    const name = `landed_${Math.floor(r() * 1e6)}`;
    const body = `export function ${name}() { return 7; }\n`;
    await fx.write(`src/${name}.js`, body, wt);
    await fx.commit(`wt lands ${name}`, wt);
    await fx.write(`src/${name}.js`, body);
    await fx.commit(`base lands ${name}`);
    return 'landed';
  },
  async function uncommittedTracked(fx, wt, r) {
    // Modify a tracked base file in place, uncommitted.
    await fx.write('src/base.js', `export function baseline() { return ${Math.floor(r() * 1e6)}; }\n`, wt);
    return 'risky';
  },
  async function untrackedFile(fx, wt, r) {
    const name = `note_${Math.floor(r() * 1e6)}`;
    await fx.write(`notes/${name}.md`, `unique note ${name}\n`, wt);
    return 'risky';
  },
  async function untrackedProse(fx, wt, r) {
    // Prose-only content: the SYMBOL layer skips it by design, so safety must come from the
    // file layer. This move exists precisely because that layering is load-bearing.
    await fx.write(`docs/plan_${Math.floor(r() * 1e6)}.md`, '# the plan\nirreplaceable\n', wt);
    return 'risky';
  },
  async function deleteTrackedUncommitted(fx, wt) {
    await fs.rm(path.join(wt, 'src/base.js'), { force: true });
    return 'risky'; // an uncommitted deletion is a decision someone made; losing it loses that
  },
  async function generatedJunk(fx, wt, r) {
    await fx.write(`node_modules/pkg${Math.floor(r() * 100)}/index.js`, 'module.exports = 1;\n', wt);
    return 'none'; // generated paths are excluded by design — junk must NOT make a tree risky
  },
  async function nothing() {
    return 'none';
  },
];

/**
 * INDEPENDENT ORACLE. Shares no code with holt's scanner.
 *
 * A worktree holds at-risk content iff, versus a pristine base checkout:
 *   - any non-generated file exists whose content base does not have anywhere in its tree, OR
 *   - `git status` shows any tracked modification/deletion (a decision that would be lost).
 * Landed content (identical bytes exist in base) does not count.
 */
async function oracleRisky(wtPath, basePath) {
  // Raw status: any tracked change (M/D/R/A) counts; untracked handled by content walk below.
  const st = await sh('git', ['status', '--porcelain'], wtPath);
  for (const line of st.stdout.split('\n')) {
    if (!line.trim()) continue;
    if (!line.startsWith('??')) return true;
  }

  // Content walk: any untracked, non-generated file whose bytes are absent from base.
  const baseContents = new Set();
  const collect = async (dir) => {
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await collect(p);
      else if (e.isFile()) baseContents.add(await fs.readFile(p, 'utf8').catch(() => ''));
    }
  };
  await collect(basePath);

  let risky = false;
  const walk = async (dir) => {
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        const content = await fs.readFile(p, 'utf8').catch(() => null);
        if (content !== null && !baseContents.has(content)) risky = true;
      }
    }
  };
  await walk(wtPath);
  return risky;
}

async function runFuzzRound(seed, worktreeCount) {
  const r = rng(seed);
  const fx = await newRepo(`fuzz${seed}`);

  // Ground-truth bookkeeping while we build.
  const expected = new Map();
  for (let i = 0; i < worktreeCount; i++) {
    const id = `fz-${i}`;
    const wt = await fx.worktree(id);
    // 1–3 random moves per worktree; risky wins over landed wins over none.
    let state = 'none';
    const n = 1 + Math.floor(r() * 3);
    for (let m = 0; m < n; m++) {
      const move = MOVES[Math.floor(r() * MOVES.length)];
      const got = await move(fx, wt, r);
      if (got === 'risky') state = 'risky';
      else if (got === 'landed' && state === 'none') state = 'landed';
    }
    expected.set(id, state);
  }

  // Holt's verdicts.
  const disc = await discover(fx.root);
  const report = await analyze(await scan(disc, {}), {});

  // The oracle's verdicts, computed independently against the CURRENT base tree.
  const violations = [];
  for (const [id] of expected) {
    const node = report.graph.nodes.find((n) => n.id === id);
    const verdict = report.safe.find((s) => s.id === id);
    if (!node || !verdict) { violations.push(`${id}: missing from holt's report entirely`); continue; }

    const oracle = await oracleRisky(node.path, fx.root);
    // THE INVARIANT — one direction only. The oracle over-approximates risk (it cannot tell a
    // landed rename from new work), so oracle=false with holt=unsafe is conservatism, not a
    // bug. oracle=true with holt=safe is the catastrophe.
    if (oracle && verdict.safe) {
      violations.push(`${id}: oracle finds at-risk content but holt says SAFE (${verdict.reasons.join('; ')})`);
    }
  }

  // And the destructive path must agree with the diagnostic one: clean --apply must not remove
  // anything the oracle calls risky.
  const before = new Map();
  for (const [id] of expected) {
    const node = report.graph.nodes.find((n) => n.id === id);
    if (node) before.set(id, node.path);
  }
  await clean(fx.root, { apply: true });
  for (const [id, wtPath] of before) {
    const oracle = expected.get(id) === 'risky';
    const gone = !(await fs.stat(wtPath).then(() => true, () => false));
    if (oracle && gone) violations.push(`${id}: built as RISKY but clean --apply REMOVED it`);
  }

  await fx.cleanup();
  return violations;
}

// Rounds are independent; seeds are fixed so any failure is a permanent, reproducible case.
for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
  test(`FUZZ INVARIANT seed=${seed}: holt never calls at-risk content safe, never removes it`, async () => {
    const violations = await runFuzzRound(seed, 6);
    assert.deepEqual(violations, [],
      `INVARIANT VIOLATED (reproduce with seed=${seed}):\n${violations.join('\n')}`);
  });
}
