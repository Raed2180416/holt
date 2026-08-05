/**
 * holt — real repositories, real damage.
 *
 * The fixture suite proves the logic on repos holt's own author constructed. This one runs
 * against upstream open-source repositories in four languages and plants the damage that
 * parallel agents actually cause, then requires holt to find every planted defect and invent
 * none.
 *
 * Each repo gets the same six-workstream scenario, expressed in that repo's own language:
 *
 *   dupA / dupB      two independent dispatches implement the SAME function   -> duplicate
 *   hotA / hotB      two workstreams add the SAME key to the SAME hot file    -> collision
 *   risky            unique work that was never committed                     -> at risk
 *   spent            nothing at all                                           -> disposable
 *
 * Ground truth is planted, so every assertion is exact. Repos are cloned by scripts/clone-fixtures.sh.
 * The corpus is an all-or-nothing gate: every repository must exist at its pinned commit and every
 * scenario must complete. Missing or moving fixtures fail rather than degrading to a smaller test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { discover } from '../../src/discover.mjs';
import { scan } from '../../src/scan.mjs';
import { analyze } from '../../src/analyze.mjs';
import { impact } from '../../src/impact.mjs';
import { backdateWorktreeCreation } from '../fixtures.mjs';

const REAL_ROOT = process.env.HOLT_REAL_REPOS
  ?? path.join(process.env.HOME ?? '/tmp', '.holt-work', 'holt-real');

/**
 * Per-repo scenario definitions. `ext` picks the language; `hot` is a file that genuinely
 * exists in that repository, so the collision lands on real content rather than a file we made.
 */
const REPOS = [
  {
    dir: 'py-click', lang: 'Python', ext: 'py', hot: 'setup.cfg',
    commit: '00e592cea702e0b2caa0dee42489fdb1c22cd845',
    dup: (n) => `def ${n}(items):\n    out = []\n    for it in items:\n        out.append(it * 2)\n    return out\n`,
    consumes: (n) => `def holt_consumer(xs):\n    return ${n}(xs)\n`,
    uniq: (n) => `def ${n}():\n    return "only here"\n`,
    hotAdd: (owner) => `\n[holt_hotspot]\nSHARED_HOT_KEY = ${owner}\n`,
  },
  {
    dir: 'go-gin', lang: 'Go', ext: 'go', hot: 'go.mod',
    commit: '34dac209ffb6ef85cc78c5d217bbb7ad001d68fd',
    dup: (n) => `package holttest\n\nfunc ${n}(items []int) []int {\n\tout := []int{}\n\tfor _, it := range items {\n\t\tout = append(out, it*2)\n\t}\n\treturn out\n}\n`,
    consumes: (n) => `package holttest\n\nfunc holtConsumer(xs []int) []int {\n\treturn ${n}(xs)\n}\n`,
    uniq: (n) => `package holttest\n\nfunc ${n}() string {\n\treturn "only here"\n}\n`,
    hotAdd: (owner) => `\n// holt_hotspot SHARED_HOT_KEY ${owner}\n`,
  },
  {
    dir: 'rs-ripgrep', lang: 'Rust', ext: 'rs', hot: 'Cargo.toml',
    commit: '435f59fc4b43af3ab32f34d53fa34978f393fe52',
    dup: (n) => `pub fn ${n}(items: &[i32]) -> Vec<i32> {\n    let mut out = Vec::new();\n    for it in items {\n        out.push(it * 2);\n    }\n    out\n}\n`,
    consumes: (n) => `pub fn holt_consumer(xs: &[i32]) -> Vec<i32> {\n    ${n}(xs)\n}\n`,
    uniq: (n) => `pub fn ${n}() -> &'static str {\n    "only here"\n}\n`,
    hotAdd: (owner) => `\n[holt_hotspot]\nSHARED_HOT_KEY = "${owner}"\n`,
  },
  {
    dir: 'js-express', lang: 'JavaScript', ext: 'js', hot: 'package.json',
    commit: 'a3714473feb3d2908add734d340e7755fd85e0a3',
    dup: (n) => `export function ${n}(items) {\n  const out = [];\n  for (const it of items) {\n    out.push(it * 2);\n  }\n  return out;\n}\n`,
    consumes: (n) => `export function holtConsumer(xs) {\n  return ${n}(xs);\n}\n`,
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
        GIT_AUTHOR_NAME: 'holt test', GIT_AUTHOR_EMAIL: 't@holt.invalid',
        GIT_COMMITTER_NAME: 'holt test', GIT_COMMITTER_EMAIL: 't@holt.invalid',
        GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C',
      },
    }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? -1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }));
  });
}

async function exists(p) {
  try { await fs.stat(p); return true; } catch { return false; }
}

/** Prove this scenario is running against the declared corpus object, not a moving branch. */
async function verifyPinnedFixture(repo, root) {
  assert.equal(await exists(root), true,
    `${repo.dir}: required real-repository fixture is missing under ${REAL_ROOT}; ` +
    'run scripts/clone-fixtures.sh before the real-repo gate');

  const top = await sh('git', ['rev-parse', '--show-toplevel'], root);
  assert.equal(top.code, 0,
    `${repo.dir}: fixture is not a readable Git worktree: ${top.stderr.trim()}`);
  const [fixtureRoot, gitRoot] = await Promise.all([
    fs.realpath(root),
    fs.realpath(top.stdout.trim()),
  ]);
  assert.equal(gitRoot, fixtureRoot,
    `${repo.dir}: fixture path is not its Git root (resolved ${gitRoot})`);

  const head = await sh('git', ['rev-parse', '--verify', 'HEAD^{commit}'], root);
  assert.equal(head.code, 0,
    `${repo.dir}: fixture is not a readable Git worktree: ${head.stderr.trim()}`);
  assert.equal(head.stdout.trim(), repo.commit,
    `${repo.dir}: fixture HEAD drifted; expected ${repo.commit}, got ${head.stdout.trim() || '<none>'}. ` +
    'Re-run scripts/clone-fixtures.sh to restore the pinned corpus.');

  const status = await sh('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], root);
  assert.equal(status.code, 0,
    `${repo.dir}: fixture working-tree state could not be read: ${status.stderr.trim()}`);
  assert.equal(status.stdout, '',
    `${repo.dir}: fixture has local changes; re-run scripts/clone-fixtures.sh with a clean cache`);
  return head.stdout.trim();
}

// Filled only after a repository's complete planted scenario passes. The final test asserts the
// exact set, so deleting one per-repo test or returning early cannot turn a partial corpus green.
const exercised = new Map();

/** Build the six-workstream scenario inside a clone. Returns the ground truth. */
async function plantScenario(repo, root) {
  const wtRoot = path.join(root, '..', `${repo.dir}-wt`);
  await fs.rm(wtRoot, { recursive: true, force: true });
  // Removing the DIRECTORIES does not remove the REGISTRATIONS. The clone is cached between runs,
  // so `.git/worktrees/<name>` survives and the next `worktree add` fails with "missing but
  // already registered" — the suite passed on a clean CI runner and failed for anyone who ran it
  // twice. Pruning is the actual counterpart to deleting the directory, and it is the same stale
  // registration hazard holt exists to detect (the monster fixture plants it deliberately).
  await sh('git', ['worktree', 'prune'], root);
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
  //
  // Family comes from git provenance (fork point + creation time; see assignFamilies in
  // src/discover.mjs), not from naming — so "two independent dispatches" must be given
  // genuinely different provenance, not just names the old naming heuristic would have kept
  // apart. Both worktrees fork from the identical `base` (mk() always uses the one pinned oid),
  // so the only lever left to make them a different family is creation time: dupA is backdated
  // four days, far outside the 5-minute clustering window, so it cannot cluster with dupB
  // (or anything else created "now" in this same test run) even though they share a fork point.
  const dupA = await mk('alpha-1');
  await write(dupA, `holt_probe/dup_a.${repo.ext}`, repo.dup('holtSharedDuplicate'));
  await commit(dupA, 'alpha implements shared helper');
  await backdateWorktreeCreation(dupA, 4 * 24 * 60 * 60 * 1000);

  const dupB = await mk('beta-1');
  await write(dupB, `holt_probe/dup_b.${repo.ext}`, repo.dup('holtSharedDuplicate'));
  await commit(dupB, 'beta implements the same helper');

  // --- collision: two workstreams add the SAME key to the SAME real, pre-existing file ---
  const hotOriginal = await fs.readFile(path.join(root, repo.hot), 'utf8').catch(() => null);
  let hotUsed = null;
  if (hotOriginal !== null) {
    hotUsed = repo.hot;
    const hotA = await mk('hotA');
    const hotB = await mk('hotB');
    if (repo.hot.endsWith('.json')) {
      const objA = JSON.parse(hotOriginal); objA.holtSharedHotKey = 'A';
      const objB = JSON.parse(hotOriginal); objB.holtSharedHotKey = 'B';
      await write(hotA, repo.hot, `${JSON.stringify(objA, null, 2)}\n`);
      await write(hotB, repo.hot, `${JSON.stringify(objB, null, 2)}\n`);
    } else {
      await write(hotA, repo.hot, hotOriginal + repo.hotAdd('A'));
      await write(hotB, repo.hot, hotOriginal + repo.hotAdd('B'));
    }
    await commit(hotA, 'A claims the hotspot key');
    await commit(hotB, 'B claims the hotspot key differently');
  }

  // --- impact: a producer/consumer pair sharing NO file ----------------------------
  // producer defines holtProducedHelper in producer.<ext>; consumer CALLS it from a different
  // file and never touches producer.<ext>. Collision detection works by file overlap, so this
  // pair must be invisible to it — and visible to `holt impact`.
  const producer = await mk('producer-1');
  await write(producer, `holt_probe/producer.${repo.ext}`, repo.dup('holtProducedHelper'));
  await commit(producer, 'producer defines the helper');

  const consumer = await mk('consumer-1');
  await write(consumer, `holt_probe/consumer.${repo.ext}`, repo.consumes('holtProducedHelper'));
  await commit(consumer, 'consumer calls the helper it does not define');

  // --- at risk: unique work, NEVER committed --------------------------------------
  const risky = await mk('risky');
  await write(risky, `holt_probe/only_here.${repo.ext}`, repo.uniq('holtUncommittedOnly'));

  // --- disposable: untouched -------------------------------------------------------
  await mk('spent');

  return {
    wtRoot,
    truth: {
      duplicatePair: ['alpha-1', 'beta-1'],
      duplicateSymbol: 'holtSharedDuplicate',
      collisionPair: hotUsed ? ['hotA', 'hotB'] : null,
      collisionKey: 'holtSharedHotKey',
      atRisk: 'risky',
      impactPair: ['producer-1', 'consumer-1'],
      impactSymbol: 'holtProducedHelper',
      atRiskSymbol: 'holtUncommittedOnly',
      disposable: 'spent',
      hotFile: hotUsed,
    },
  };
}

for (const repo of REPOS) {
  test(`REAL REPO (${repo.lang}): holt finds every planted defect in ${repo.dir}`, async (t) => {
    const root = path.join(REAL_ROOT, repo.dir);
    const verifiedHead = await verifyPinnedFixture(repo, root);

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

    // Keep the comparison base pinned too. A fresh shallow clone still has origin/HEAD pointing
    // at today's upstream tip even after HEAD is detached at the fixture commit; allowing normal
    // base inference here therefore made the warmed cache and a fresh clone produce different
    // answers from the same checked-out bytes. This corpus measures holt against this exact tree.
    const disc = await discover(root, { base: repo.commit });
    const scanned = await scan(disc, { base: repo.commit });
    const report = await analyze(scanned, {});

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

    // ---- P4-adjacent: cross-workstream impact, invisible to collision detection -----
    const [prod, cons] = truth.impactPair;

    // Establish the premise first: these two share no file, so P1 CANNOT see them.
    const asCollision = report.collisions.find((c) =>
      (c.a === prod && c.b === cons) || (c.a === cons && c.b === prod));
    assert.equal(asCollision, undefined,
      `${repo.dir}: premise broken — P1 now catches the producer/consumer pair, so impact adds nothing`);

    const imp = await impact(scanned, {});
    const pair = imp.pairs.find((p) => p.producer === prod && p.consumer === cons);
    assert.ok(pair,
      `${repo.dir}: impact missed the planted producer/consumer pair. ` +
      `Found: ${JSON.stringify(imp.pairs.map((p) => [p.producer, p.consumer]))}`);
    assert.ok(pair.symbols.includes(truth.impactSymbol),
      `${repo.dir}: expected ${truth.impactSymbol} as evidence, got ${pair.symbols.join(', ')}`);

    // And it must not invent a dependency on the workstream that touched nothing.
    assert.equal(imp.pairs.find((p) => p.consumer === 'spent' || p.producer === 'spent'), undefined,
      `${repo.dir}: an untouched worktree cannot participate in a dependency`);

    // ---- no invented findings ------------------------------------------------------
    const bogus = report.collisions.find((c) =>
      (c.a === 'spent' || c.b === 'spent') && c.severity !== 'low');
    assert.equal(bogus, undefined, `${repo.dir}: an untouched worktree cannot collide with anything`);

    exercised.set(repo.dir, verifiedHead);
  });
}

test('REAL REPOS: the exact pinned four-repository corpus was exercised', () => {
  assert.equal(REPOS.length, 4, 'the declared real-repository corpus must contain exactly four fixtures');
  assert.deepEqual(
    [...exercised.entries()].sort(([a], [b]) => a.localeCompare(b)),
    REPOS.map((repo) => [repo.dir, repo.commit]).sort(([a], [b]) => a.localeCompare(b)),
    'the gate must complete all four pinned scenarios; a partial corpus proves nothing',
  );
});
