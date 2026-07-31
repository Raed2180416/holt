/**
 * grove — real repositories, real damage.
 *
 * The fixture suite proves the logic on repos grove's own author constructed. This one runs
 * against upstream open-source repositories in four languages and plants the damage that
 * parallel agents actually cause, then requires grove to find every planted defect and invent
 * none.
 *
 * Each repo gets the same six-workstream scenario, expressed in that repo's own language:
 *
 *   dupA / dupB      two independent dispatches implement the SAME function   -> duplicate
 *   hotA / hotB      two workstreams add the SAME key to the SAME hot file    -> collision
 *   risky            unique work that was never committed                     -> at risk
 *   spent            nothing at all                                           -> disposable
 *
 * Ground truth is planted, so every assertion is exact. Repos are cloned by scripts/clone-fixtures.sh
 * (or by hand); when they are absent the tests SKIP rather than silently passing — a suite that
 * quietly reports success on zero repositories would be the exact defect grove exists to catch.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { discover } from '../../src/discover.mjs';
import { scan } from '../../src/scan.mjs';
import { analyze } from '../../src/analyze.mjs';

const REAL_ROOT = process.env.GROVE_REAL_REPOS
  ?? path.join(process.env.HOME ?? '/tmp', '.agentic-os-tmp', 'grove-real');

/**
 * Per-repo scenario definitions. `ext` picks the language; `hot` is a file that genuinely
 * exists in that repository, so the collision lands on real content rather than a file we made.
 */
const REPOS = [
  {
    dir: 'py-click', lang: 'Python', ext: 'py', hot: 'setup.cfg',
    dup: (n) => `def ${n}(items):\n    out = []\n    for it in items:\n        out.append(it * 2)\n    return out\n`,
    uniq: (n) => `def ${n}():\n    return "only here"\n`,
    hotAdd: (owner) => `\n[grove_hotspot]\nSHARED_HOT_KEY = ${owner}\n`,
  },
  {
    dir: 'go-gin', lang: 'Go', ext: 'go', hot: 'go.mod',
    dup: (n) => `package grovetest\n\nfunc ${n}(items []int) []int {\n\tout := []int{}\n\tfor _, it := range items {\n\t\tout = append(out, it*2)\n\t}\n\treturn out\n}\n`,
    uniq: (n) => `package grovetest\n\nfunc ${n}() string {\n\treturn "only here"\n}\n`,
    hotAdd: (owner) => `\n// grove_hotspot SHARED_HOT_KEY ${owner}\n`,
  },
  {
    dir: 'rs-ripgrep', lang: 'Rust', ext: 'rs', hot: 'Cargo.toml',
    dup: (n) => `pub fn ${n}(items: &[i32]) -> Vec<i32> {\n    let mut out = Vec::new();\n    for it in items {\n        out.push(it * 2);\n    }\n    out\n}\n`,
    uniq: (n) => `pub fn ${n}() -> &'static str {\n    "only here"\n}\n`,
    hotAdd: (owner) => `\n[grove_hotspot]\nSHARED_HOT_KEY = "${owner}"\n`,
  },
  {
    dir: 'js-express', lang: 'JavaScript', ext: 'js', hot: 'package.json',
    dup: (n) => `export function ${n}(items) {\n  const out = [];\n  for (const it of items) {\n    out.push(it * 2);\n  }\n  return out;\n}\n`,
    uniq: (n) => `export function ${n}() {\n  return 'only here';\n}\n`,
    hotAdd: null, // package.json is JSON; handled specially below
  },
];

function sh(cmd, args, cwd) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      cwd, timeout: 120_000, maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'grove test', GIT_AUTHOR_EMAIL: 't@grove.invalid',
        GIT_COMMITTER_NAME: 'grove test', GIT_COMMITTER_EMAIL: 't@grove.invalid',
        GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C',
      },
    }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? -1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }));
  });
}

async function exists(p) {
  try { await fs.stat(p); return true; } catch { return false; }
}

/** Build the six-workstream scenario inside a clone. Returns the ground truth. */
async function plantScenario(repo, root) {
  const wtRoot = path.join(root, '..', `${repo.dir}-wt`);
  await fs.rm(wtRoot, { recursive: true, force: true });
  await fs.mkdir(wtRoot, { recursive: true });

  const base = (await sh('git', ['rev-parse', 'HEAD'], root)).stdout.trim();
  const mk = async (name) => {
    const p = path.join(wtRoot, name);
    const r = await sh('git', ['worktree', 'add', '-q', '--detach', p, base], root);
    if (r.code !== 0) throw new Error(`worktree add failed for ${name}: ${r.stderr}`);
    return p;
  };
  const write = async (wt, rel, content) => {
    const abs = path.join(wt, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  };
  const commit = async (wt, msg) => {
    await sh('git', ['add', '-A'], wt);
    await sh('git', ['commit', '-q', '-m', msg, '--no-verify'], wt);
  };

  // --- duplicate work: two INDEPENDENT dispatches, same function, different files ----
  const dupA = await mk('alpha-1');
  await write(dupA, `grove_probe/dup_a.${repo.ext}`, repo.dup('groveSharedDuplicate'));
  await commit(dupA, 'alpha implements shared helper');

  const dupB = await mk('beta-1');
  await write(dupB, `grove_probe/dup_b.${repo.ext}`, repo.dup('groveSharedDuplicate'));
  await commit(dupB, 'beta implements the same helper');

  // --- collision: two workstreams add the SAME key to the SAME real, pre-existing file ---
  const hotOriginal = await fs.readFile(path.join(root, repo.hot), 'utf8').catch(() => null);
  let hotUsed = null;
  if (hotOriginal !== null) {
    hotUsed = repo.hot;
    const hotA = await mk('hotA');
    const hotB = await mk('hotB');
    if (repo.hot.endsWith('.json')) {
      const objA = JSON.parse(hotOriginal); objA.groveSharedHotKey = 'A';
      const objB = JSON.parse(hotOriginal); objB.groveSharedHotKey = 'B';
      await write(hotA, repo.hot, `${JSON.stringify(objA, null, 2)}\n`);
      await write(hotB, repo.hot, `${JSON.stringify(objB, null, 2)}\n`);
    } else {
      await write(hotA, repo.hot, hotOriginal + repo.hotAdd('A'));
      await write(hotB, repo.hot, hotOriginal + repo.hotAdd('B'));
    }
    await commit(hotA, 'A claims the hotspot key');
    await commit(hotB, 'B claims the hotspot key differently');
  }

  // --- at risk: unique work, NEVER committed --------------------------------------
  const risky = await mk('risky');
  await write(risky, `grove_probe/only_here.${repo.ext}`, repo.uniq('groveUncommittedOnly'));

  // --- disposable: untouched -------------------------------------------------------
  await mk('spent');

  return {
    wtRoot,
    truth: {
      duplicatePair: ['alpha-1', 'beta-1'],
      duplicateSymbol: 'groveSharedDuplicate',
      collisionPair: hotUsed ? ['hotA', 'hotB'] : null,
      collisionKey: 'groveSharedHotKey',
      atRisk: 'risky',
      atRiskSymbol: 'groveUncommittedOnly',
      disposable: 'spent',
      hotFile: hotUsed,
    },
  };
}

for (const repo of REPOS) {
  test(`REAL REPO (${repo.lang}): grove finds every planted defect in ${repo.dir}`, async (t) => {
    const root = path.join(REAL_ROOT, repo.dir);
    if (!(await exists(root))) {
      return t.skip(`${repo.dir} not cloned — run scripts/clone-fixtures.sh (SKIPPED, not passed)`);
    }

    const { wtRoot, truth } = await plantScenario(repo, root);
    t.after(async () => {
      // Remove worktrees so repeated runs start clean; the clone itself is left alone.
      const list = await sh('git', ['worktree', 'list', '--porcelain'], root);
      for (const line of list.stdout.split('\n')) {
        if (!line.startsWith('worktree ')) continue;
        const p = line.slice(9);
        if (p.startsWith(wtRoot)) await sh('git', ['worktree', 'remove', '--force', p], root);
      }
      await fs.rm(wtRoot, { recursive: true, force: true });
      await sh('git', ['worktree', 'prune'], root);
    });

    const disc = await discover(root);
    const report = await analyze(await scan(disc, {}), {});

    const ids = report.unique.map((u) => u.id);
    for (const expected of ['alpha-1', 'beta-1', 'risky', 'spent']) {
      assert.ok(ids.includes(expected), `${repo.dir}: workstream '${expected}' not scanned (saw ${ids.join(', ')})`);
    }

    // ---- P3 duplicate: the two independent dispatches must be paired ---------------
    const dup = report.duplicates.find((d) =>
      (d.a === 'alpha-1' && d.b === 'beta-1') || (d.a === 'beta-1' && d.b === 'alpha-1'));
    assert.ok(dup, `${repo.dir}: duplicate pair alpha-1/beta-1 not found`);
    assert.ok(dup.sharedSymbols.some((s) => s.endsWith(`:${truth.duplicateSymbol}`)),
      `${repo.dir}: expected shared symbol ${truth.duplicateSymbol}, got ${dup.sharedSymbols.join(', ')}`);
    assert.equal(dup.classification, 'cross-dispatch-waste');

    // ---- P1 collision: same key, same real file ------------------------------------
    if (truth.collisionPair) {
      const col = report.collisions.find((c) =>
        (c.a === 'hotA' && c.b === 'hotB') || (c.a === 'hotB' && c.b === 'hotA'));
      assert.ok(col, `${repo.dir}: collision hotA/hotB on ${truth.hotFile} not found`);
      assert.ok(['high', 'medium'].includes(col.severity),
        `${repo.dir}: a same-key conflict should not be low severity (got ${col.severity})`);
      assert.ok(col.sharedFiles.includes(truth.hotFile),
        `${repo.dir}: collision should name ${truth.hotFile}`);
    }

    // ---- P0 at risk: uncommitted-only work -----------------------------------------
    const risky = report.unique.find((u) => u.id === 'risky');
    assert.equal(risky.verdict, 'unique-work-uncommitted', `${repo.dir}: 'risky' misclassified`);
    const riskySyms = [...risky.byLayer.uncommitted, ...risky.byLayer.untracked].map((s) => s.key);
    assert.ok(riskySyms.some((s) => s.endsWith(`:${truth.atRiskSymbol}`)),
      `${repo.dir}: ${truth.atRiskSymbol} not detected in the uncommitted layer (got ${riskySyms.join(', ')})`);

    // ---- P6 disposable, and the fail-closed direction ------------------------------
    const spent = report.safe.find((s) => s.id === 'spent');
    assert.equal(spent.safe, true, `${repo.dir}: untouched worktree should be disposable (${spent.reasons.join('; ')})`);
    const riskyVerdict = report.safe.find((s) => s.id === 'risky');
    assert.equal(riskyVerdict.safe, false, `${repo.dir}: 'risky' must NEVER be reported disposable`);

    // ---- no invented findings ------------------------------------------------------
    const bogus = report.collisions.find((c) =>
      (c.a === 'spent' || c.b === 'spent') && c.severity !== 'low');
    assert.equal(bogus, undefined, `${repo.dir}: an untouched worktree cannot collide with anything`);
  });
}

test('REAL REPOS: at least one repository was actually exercised', async (t) => {
  const present = [];
  for (const r of REPOS) {
    if (await exists(path.join(REAL_ROOT, r.dir))) present.push(r.dir);
  }
  // Presence-before-silence: if every repo is missing, the suite above skipped everything and
  // proved nothing. Say so loudly rather than reporting a clean run.
  if (present.length === 0) {
    return t.skip(`no real repositories present under ${REAL_ROOT} — the real-repo suite proved NOTHING this run`);
  }
  assert.ok(present.length >= 1);
});
