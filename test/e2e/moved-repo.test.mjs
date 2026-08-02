// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — THE REPOSITORY MOVED.
 *
 * A repository at a different absolute path is not an edge case. It arrives by `mv`, by a
 * renamed home directory, by a laptop migration, by a CI runner that checks out under a
 * different workspace root every job, by a container that bind-mounts the same tree at
 * `/workspace` instead of `/home/you/src`. And holt writes absolute paths in three places that
 * outlive the move: the worktree paths in every scan, the install receipt, and the action
 * journal — both of the latter under the git COMMON dir.
 *
 * WHAT GIT ITSELF DOES, AND WHY IT IS NOT HOLT'S BUG. `git worktree` records absolute paths in
 * two files per linked worktree: `<worktree>/.git` points at the admin dir, and
 * `<common>/worktrees/<name>/gitdir` points back at the worktree. Move the tree and both are
 * stale; git's documented remedy is `git worktree repair <path>...` run from the main worktree.
 * Until it is run, git reports every linked worktree as unusable, and NOTHING holt can do makes
 * those worktrees readable.
 *
 * So this file draws the line the product has to hold on both sides of it:
 *
 *   BEFORE repair — holt may not crash, and it may not ANSWER. Zero at-risk worktrees because
 *     zero could be read is the signature defect this project exists to kill: absence of
 *     evidence reported as evidence of absence. The verdicts must come back as REFUSALS —
 *     `gate` exits 2 (unknown), `clean` proposes nothing, and the summary says out loud that
 *     nothing was scanned rather than printing a green "nothing at risk".
 *
 *   AFTER repair — the answers must be EQUIVALENT to the ones the same repository gave at its
 *     old path. Not "similar": the same ids, the same verdicts, the same unique symbols, the
 *     same gate exit codes, and no trace of the old absolute path anywhere in the output. A
 *     cached absolute path would show up here as either a stale string or a changed verdict.
 *
 * A DIFFERENT $HOME is covered too, because holt reads user-scoped agent config out of the home
 * directory: the repository's own verdicts must not depend on whose home is mounted.
 *
 * ONE FIXTURE, FOUR ORDERED STEPS. The steps share state deliberately — the baseline recorded
 * before the move is the thing every later step is compared against — and each one asserts that
 * the previous step actually ran, so a failure early on can never present as a later test
 * quietly passing on empty data.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { newRepo } from '../fixtures.mjs';

const CLI = fileURLToPath(new URL('../../bin/holt.mjs', import.meta.url));

/**
 * `/dev/null` as a LITERAL, not `os.devNull`. Git for Windows is an MSYS build and resolves
 * `NUL` as a relative path under the repo, so `GIT_CONFIG_GLOBAL=NUL` makes git read a config
 * that is not there and, worse, differs per working directory. The POSIX spelling is what MSYS
 * understands on every platform this suite runs on — the same choice test/fixtures.mjs makes.
 */
const NULL_CONFIG = '/dev/null';

function run(cmd, args, cwd, env = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      cwd,
      timeout: 180_000,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'holt test', GIT_AUTHOR_EMAIL: 'test@holt.invalid',
        GIT_COMMITTER_NAME: 'holt test', GIT_COMMITTER_EMAIL: 'test@holt.invalid',
        GIT_CONFIG_GLOBAL: NULL_CONFIG, GIT_CONFIG_SYSTEM: NULL_CONFIG,
        GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C',
        ...env,
      },
    }, (err, stdout, stderr) => resolve({
      code: err ? (err.code ?? -1) : 0,
      stdout: String(stdout ?? ''),
      stderr: String(stderr ?? ''),
    }));
  });
}

const holt = (args, cwd, env = {}) => run(process.execPath, [CLI, ...args], cwd, env);
const git = (args, cwd) => run('git', args, cwd);

/**
 * A home directory of our own for every invocation. holt reads USER-SCOPED agent config from the
 * home dir, and a test that inherited the developer's real one would measure their machine.
 * Windows resolves the home directory from USERPROFILE, POSIX from HOME; both are set, so
 * "a different $HOME" means the same thing on every platform this runs on.
 */
function homeEnv(dir) {
  return { HOME: dir, USERPROFILE: dir, XDG_CONFIG_HOME: path.join(dir, '.config') };
}

/** Parse JSON from a holt run, failing with the actual output rather than a bare SyntaxError. */
function json(res, what) {
  assert.equal(res.code, 0, `${what} exited ${res.code}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  try {
    return JSON.parse(res.stdout);
  } catch (e) {
    assert.fail(`${what} did not emit JSON (${e.message})\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  }
}

/**
 * The comparable shape of an answer. Absolute paths are deliberately EXCLUDED — they are
 * expected to change, and are checked separately (they must be the NEW ones, and the old ones
 * must appear nowhere). Symbols are sorted because ordering is not part of the contract.
 *
 * `family` is excluded from the row and asserted as a GROUPING instead: family ids are derived
 * from worktree creation time, and `git worktree repair` rewrites the very `gitdir` file that
 * timestamp is read from. The label legitimately changes; which worktrees share a label must
 * not.
 */
function answerShape(report) {
  return {
    counts: report.counts,
    unique: report.unique.map((u) => ({
      id: u.id,
      verdict: u.verdict,
      uniqueSymbols: [...u.uniqueSymbols].sort(),
      uncommittedOnlyCount: u.uncommittedOnlyCount,
      committedFiles: u.committedFiles,
    })).sort((a, b) => a.id.localeCompare(b.id)),
    safe: report.safe.map((s) => ({
      id: s.id, safe: s.safe, confidence: s.confidence,
      redundantWith: [...(s.redundantWith ?? [])].sort(),
    })).sort((a, b) => a.id.localeCompare(b.id)),
    /** ids grouped by family, as a canonical partition — labels dropped, membership kept. */
    families: [...report.unique.reduce((m, u) => {
      m.set(u.family, [...(m.get(u.family) ?? []), u.id]);
      return m;
    }, new Map()).values()].map((ids) => ids.sort().join('+')).sort(),
  };
}

/** Every id in the fixture, so gate is exercised on the whole surface rather than one sample. */
const IDS = ['risky', 'held', 'spent'];

async function gateCodes(cwd, env) {
  const codes = {};
  for (const id of IDS) {
    // eslint-disable-next-line no-await-in-loop -- three ids, and the point is the exit code
    codes[id] = (await holt(['gate', id], cwd, env)).code;
  }
  return codes;
}

/**
 * The fixture: unique UNCOMMITTED work (the thing holt exists to protect), unique COMMITTED
 * work, and a worktree that holds nothing. Every verdict class the move could corrupt is
 * present, so "equivalent after the move" is a statement about all three, not about a repo that
 * happens to be empty.
 */
async function movableFixture() {
  const fx = await newRepo('moved');
  const risky = await fx.worktree('risky');
  await fx.write('src/only_uncommitted.js',
    'export function MOVED_ONLY_UNCOMMITTED_SYMBOL() { return "at risk"; }\n', risky);

  const held = await fx.worktree('held');
  await fx.write('src/only_committed.js',
    'export function MOVED_ONLY_COMMITTED_SYMBOL() { return "held"; }\n', held);
  await fx.commit('held commits work base lacks', held);

  await fx.worktree('spent');

  return { fx, base: path.dirname(fx.root) };
}

/** Both spellings of a path, because holt prints native separators and JSON escapes them. */
function pathSpellings(p) {
  return [p, p.replace(/\\/g, '/'), JSON.stringify(p).slice(1, -1)];
}

/**
 * The destination of a move. It is a SIBLING with an unrelated name, never `<old>-suffix`:
 * a destination that merely extends the old path contains the old path as a substring, and the
 * "no stale absolute path survived" check below — which is the whole detector for a cached path
 * — would then be unable to fire at all. It is also a DIFFERENT LENGTH, which is what catches
 * code that patches paths by offset rather than by re-reading them.
 */
function relocationOf(base) {
  return path.join(path.dirname(base), `relocated-${path.basename(base)}-at-a-longer-absolute-path`);
}

/* ------------------------------------------------------------------ the four steps ---- */

let fixture = null;
let oldBase = null;
let newBase = null;
let newRoot = null;
let newWorktrees = null;
let baseline = null;
let baselineGates = null;
let homeA = null;

// The four steps share ONE repository — the whole point is that it is the same repository before
// and after the move — so cleanup belongs to the file, not to any single step. A per-test hook
// here would delete the fixture between step 1 and step 2 and leave every later comparison
// measuring a repo that no longer exists.
after(async () => {
  for (const dir of [oldBase, newBase]) {
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('moved repo: step 1 — the answers at the ORIGINAL path, recorded as the ground truth', async () => {
  fixture = await movableFixture();
  oldBase = fixture.base;
  homeA = path.join(oldBase, 'home-a');
  await fs.mkdir(homeA, { recursive: true });

  const report = json(await holt(['status', '--json'], fixture.fx.root, homeEnv(homeA)), 'status --json');
  baseline = answerShape(report);
  baselineGates = await gateCodes(fixture.fx.root, homeEnv(homeA));

  // The fixture is only a control if it actually reproduces the states it claims to. A move that
  // preserves "nothing was found anywhere" proves nothing at all.
  assert.equal(baseline.counts.scanned, 3, 'all three worktrees must scan at the original path');
  assert.equal(baseline.counts.skipped, 0);
  assert.equal(baselineGates.risky, 1, 'risky holds uncommitted-only work — gate must refuse it');
  assert.equal(baselineGates.spent, 0, 'spent holds nothing — gate must clear it');
  assert.ok(
    baseline.unique.find((u) => u.id === 'risky')?.uniqueSymbols
      .includes('callable:MOVED_ONLY_UNCOMMITTED_SYMBOL'),
    'the at-risk symbol must be found at the original path');
});

test('moved repo: step 2 — moved but NOT repaired: holt refuses to answer, and never invents one', async () => {
  assert.ok(baseline, 'step 1 must have run');
  newBase = relocationOf(oldBase);
  await fs.rename(oldBase, newBase);
  newRoot = path.join(newBase, 'repo');
  newWorktrees = IDS.map((id) => path.join(newBase, 'wt', id));

  // Precondition, asserted rather than assumed: this is git's own breakage, not holt's. If a
  // future git repaired itself on the fly this assertion fails LOUDLY and the whole step is
  // revealed as testing nothing — which is the correct outcome, not a silent pass.
  const listed = await git(['worktree', 'list', '--porcelain'], newRoot);
  assert.equal(listed.code, 0);
  assert.match(listed.stdout, /^prunable/m,
    'precondition: git itself must report the moved worktrees as unusable before repair');

  // 1. It does not crash. Exit 0 and no stack trace on stderr.
  const statusText = await holt(['status'], newRoot, homeEnv(homeA));
  assert.equal(statusText.code, 0, `status crashed after the move:\n${statusText.stderr}`);
  assert.doesNotMatch(statusText.stderr, /at .*\.mjs:\d+|ERR_[A-Z_]+/,
    'status must not emit a stack trace for a moved repository');
  const riskText = await holt(['risk'], newRoot, homeEnv(homeA));
  assert.equal(riskText.code, 0, `risk crashed after the move:\n${riskText.stderr}`);

  // 2. It says what happened, in words, in the default output. THE LOAD-BEARING ASSERTION:
  //    "Nothing unique anywhere" is a verdict about a repository that was READ. Printing it over
  //    a repository where nothing could be read is the exact defect — a green all-clear produced
  //    by a failed measurement.
  for (const [label, res] of [['status', statusText], ['risk', riskText]]) {
    assert.doesNotMatch(res.stdout, /Nothing unique anywhere/,
      `${label} claimed an all-clear over a repository it could not scan`);
    assert.match(res.stdout, /none of the \d+ workstream\(s\) could be scanned/,
      `${label} must say out loud that nothing was scanned`);
  }
  assert.match(statusText.stdout, /SKIPPED \(3\)/, 'every unscannable worktree must be listed as skipped');

  // 3. The machine-readable answer agrees with the words: nothing scanned, nothing at risk,
  //    NOTHING SAFE. `atRisk: 0` is only acceptable next to `scanned: 0` and `safeToDelete: 0`.
  const report = json(await holt(['status', '--json'], newRoot, homeEnv(homeA)), 'status --json (moved)');
  assert.equal(report.counts.workstreams, 3, 'the worktrees are still known to exist');
  assert.equal(report.counts.scanned, 0);
  assert.equal(report.counts.skipped, 3);
  assert.equal(report.counts.atRisk, 0);
  assert.equal(report.counts.safeToDelete, 0, 'a repository holt could not read holds nothing it may delete');
  assert.deepEqual(report.skipped.map((s) => s.id).sort(), [...IDS].sort());
  for (const s of report.skipped) {
    assert.ok(s.reason && s.reason.length > 0, `skip of '${s.id}' must carry a reason`);
  }

  // 4. gate is the contract a script chains a `rm -rf` onto. Every id must come back UNKNOWN (2).
  //    An exit 0 here — including for 'spent', which really was disposable one directory ago —
  //    would authorise deleting a worktree holt cannot currently see.
  const gates = await gateCodes(newRoot, homeEnv(homeA));
  for (const id of IDS) {
    assert.equal(gates[id], 2, `gate ${id} must exit 2 (unknown) on a moved, unrepaired repository`);
  }

  // 5. Nothing is proposed for removal.
  const clean = json(await holt(['clean', '--dry-run', '--json'], newRoot, homeEnv(homeA)), 'clean --dry-run');
  assert.deepEqual(clean.wouldRemove, [], 'clean must propose nothing it could not verify');
  assert.deepEqual(clean.unknown.map((u) => u.id).sort(), [...IDS].sort(),
    'clean must report the unverifiable worktrees as unknown, not omit them');
});

test('moved repo: step 3 — after `git worktree repair`, the answers are EQUIVALENT to the original', async () => {
  assert.ok(newRoot, 'step 2 must have run');

  // git's documented remedy when BOTH the main worktree and its linked worktrees moved: run
  // repair from the main worktree and name each linked worktree's new path.
  const repaired = await git(['worktree', 'repair', ...newWorktrees], newRoot);
  assert.equal(repaired.code, 0, `git worktree repair failed:\n${repaired.stderr}`);

  const report = json(await holt(['status', '--json'], newRoot, homeEnv(homeA)), 'status --json (repaired)');
  const after = answerShape(report);
  const gates = await gateCodes(newRoot, homeEnv(homeA));

  assert.deepEqual(after, baseline,
    'the same repository at a new absolute path must produce the same answers');
  assert.deepEqual(gates, baselineGates, 'gate verdicts must survive the move unchanged');

  // The paths in the answer must be the NEW ones...
  assert.equal(report.root, newRoot);
  for (const u of report.unique) {
    assert.ok(u.path.startsWith(newBase), `'${u.id}' reported at ${u.path}, outside the moved tree`);
  }

  // ...and the OLD path must appear nowhere. This is what a cached absolute path looks like:
  // a string holt kept from before the move and handed back as if it were a measurement.
  //
  // BUT FIRST, PROVE THE DETECTOR CAN FIRE. A substring search that matches nothing looks
  // identical whether the output is clean or the needle is wrong — a typo in `oldBase`, a
  // separator holt spells differently, a destination path that happens to CONTAIN the source
  // path — and every one of those turns this check into a permanent green that measures
  // nothing. So plant a leak in a synthetic payload and require the check to catch it.
  const planted = JSON.stringify({ id: 'risky', path: path.join(oldBase, 'wt', 'risky') });
  assert.ok(pathSpellings(oldBase).some((spelling) => planted.includes(spelling)),
    'positive control failed: the stale-path detector cannot even see a planted stale path');

  const surfaces = {
    'status --json': report,
    'risk --json': json(await holt(['risk', '--json'], newRoot, homeEnv(homeA)), 'risk --json'),
    'plan --json': json(await holt(['plan', '--json'], newRoot, homeEnv(homeA)), 'plan --json'),
    'graph --json': json(await holt(['graph', '--json'], newRoot, homeEnv(homeA)), 'graph --json'),
  };
  for (const [label, payload] of Object.entries(surfaces)) {
    const text = JSON.stringify(payload);
    for (const spelling of pathSpellings(oldBase)) {
      assert.ok(!text.includes(spelling),
        `${label} still carries the pre-move path ${spelling} — holt cached an absolute path`);
    }
  }
});

test('moved repo: step 4 — a different $HOME changes no verdict', async () => {
  assert.ok(baseline, 'step 1 must have run');
  const homeB = path.join(newBase, 'home-b');
  await fs.mkdir(homeB, { recursive: true });

  const report = json(await holt(['status', '--json'], newRoot, homeEnv(homeB)), 'status --json (new home)');
  assert.deepEqual(answerShape(report), baseline,
    'the repository\'s verdicts must not depend on which home directory is mounted');
  assert.deepEqual(await gateCodes(newRoot, homeEnv(homeB)), baselineGates);
});

/* --------------------------------------- what holt itself wrote, at an absolute path ---- */

test('moved repo: the install receipt is content-keyed, not path-keyed — uninstall still owns its files', async (t) => {
  const fx = await newRepo('moved-receipt');
  const base = path.dirname(fx.root);
  const moved = relocationOf(base);
  t.after(async () => {
    await fs.rm(base, { recursive: true, force: true }).catch(() => {});
    await fs.rm(moved, { recursive: true, force: true }).catch(() => {});
  });
  const home = path.join(base, 'home');
  await fs.mkdir(home, { recursive: true });
  const env = homeEnv(home);

  const installed = await holt(['integrate', '--install', '--yes', '--json'], fx.root, env);
  assert.equal(installed.code, 0, `integrate failed:\n${installed.stderr}`);

  const created = (await git(['status', '--porcelain'], fx.root)).stdout
    .split('\n').filter((l) => l.startsWith('?? ')).map((l) => l.slice(3).trim()).sort();
  assert.ok(created.length > 0, 'integrate must have created something for this test to mean anything');

  const movedRoot = path.join(moved, 'repo');
  await fs.rename(base, moved);

  // The receipt lives under the git COMMON dir and keys its entries by repo-RELATIVE path plus
  // content hash, so nothing about it is tied to where the repository sits. If it had recorded
  // absolute paths, uninstall would find no file it recognised and leave every one behind.
  const removed = await holt(['uninstall', '--yes', '--json'], movedRoot, env);
  assert.equal(removed.code, 0, `uninstall failed after the move:\n${removed.stderr}`);

  const left = (await git(['status', '--porcelain'], movedRoot)).stdout
    .split('\n').filter((l) => l.startsWith('?? ')).map((l) => l.slice(3).trim()).sort();
  assert.deepEqual(left, [],
    `uninstall left files behind after the move: ${left.join(', ')} (created: ${created.join(', ')})`);
});

test('moved repo: the journal survives the move, keeps appending, and does not rewrite history', async (t) => {
  const fx = await newRepo('moved-journal');
  const base = path.dirname(fx.root);
  const moved = relocationOf(base);
  const movedRoot = path.join(moved, 'repo');
  t.after(async () => {
    await fs.rm(base, { recursive: true, force: true }).catch(() => {});
    await fs.rm(moved, { recursive: true, force: true }).catch(() => {});
  });
  const home = path.join(base, 'home');
  await fs.mkdir(home, { recursive: true });
  const env = homeEnv(home);

  const before = await fx.worktree('before-move');
  await fx.write('src/before.js', 'export function JOURNAL_BEFORE_SYMBOL() { return 1; }\n', before);

  const first = await holt(['protect'], fx.root, env);
  assert.equal(first.code, 0, `protect failed before the move:\n${first.stderr}`);

  // The journal lives under the git COMMON dir — `<common>/holt/journal.jsonl` — so it travels
  // with the repository and never appears in `git status`. Read it as a file AND through
  // `holt journal`, because "the bytes are still there" and "holt can still find them" are two
  // different claims and the move could break either.
  const readFile = async (root) => {
    const raw = await fs.readFile(path.join(root, '.git', 'holt', 'journal.jsonl'), 'utf8');
    return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  };
  const early = await readFile(fx.root);
  assert.equal(early.length, 1, 'the pre-move action must be journalled');
  assert.ok(early[0].path.startsWith(base + path.sep), 'the pre-move entry records the pre-move path');

  await fs.rename(base, moved);
  const repaired = await git(['worktree', 'repair', path.join(moved, 'wt', 'before-move')], movedRoot);
  assert.equal(repaired.code, 0, `git worktree repair failed:\n${repaired.stderr}`);

  // A NEW worktree, created after the move, holding work nothing else has: the next protect has
  // something to do, so the journal has something new to record at the new location.
  const afterWt = path.join(moved, 'wt', 'after-move');
  const added = await git(['worktree', 'add', '-b', 'wt/after-move', afterWt, 'main'], movedRoot);
  assert.equal(added.code, 0, `git worktree add failed after the move:\n${added.stderr}`);
  await fs.writeFile(path.join(afterWt, 'src', 'after.js'),
    'export function JOURNAL_AFTER_SYMBOL() { return 2; }\n', 'utf8');

  const second = await holt(['protect'], movedRoot, env);
  assert.equal(second.code, 0, `protect failed after the move:\n${second.stderr}`);

  const late = await readFile(movedRoot);
  assert.equal(late.length, 2, 'the journal must keep appending at the new location, not start over');
  // HISTORY IS NOT REWRITTEN. The first entry still says where that action happened, because
  // that is what was true when it happened; an audit trail retro-fitted to the current layout
  // would be an audit trail that cannot be trusted about anything else either.
  assert.deepEqual(late[0], early[0], 'the historical entry must be untouched by the move');
  assert.equal(late[1].id, 'after-move');
  assert.ok(late[1].path.startsWith(moved + path.sep), 'the new entry must record the NEW path');

  const shown = json(await holt(['journal', '--json'], movedRoot, env), 'journal --json');
  assert.equal(shown.events.length, 2, 'holt must still find its own journal after the move');
});
