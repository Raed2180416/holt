/**
 * grove — ground-truth fixture builder.
 *
 * Every fixture is a real git repository with a KNOWN, hand-constructed answer. Tests assert
 * against that answer, never against "whatever grove printed last time".
 *
 * The governing rule here: PROVE THE INSTRUMENT CAN DETECT PRESENCE BEFORE TRUSTING ITS
 * SILENCE. Every empty result has two explanations — the thing is absent, or the detector is
 * blind — and they are indistinguishable from the output alone. So each fixture plants a case
 * that MUST be found, and the negative controls sit beside it in the same repository.
 *
 * The subtlest fixture is `alreadyLanded`: a worktree whose content base ALREADY HAS, acquired
 * by an independent commit rather than by merging. `git diff base...head` reports that worktree
 * as carrying work; `merge-tree` correctly reports it as carrying none. Any regression that
 * swaps the instrument back to the three-dot form fails that test and only that test.
 */
// @ts-nocheck


import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      cwd,
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'grove test', GIT_AUTHOR_EMAIL: 'test@grove.invalid',
        GIT_COMMITTER_NAME: 'grove test', GIT_COMMITTER_EMAIL: 'test@grove.invalid',
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C',
      },
    }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.join(' ')} failed in ${cwd}: ${stderr || err.message}`));
      else resolve(String(stdout));
    });
  });
}

export class Fixture {
  constructor(root) {
    this.root = root;
    this.worktrees = new Map();
  }

  git(args, cwd = this.root) { return run('git', args, cwd); }

  async write(relPath, content, cwd = this.root) {
    const abs = path.join(cwd, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
    return abs;
  }

  async commit(message, cwd = this.root) {
    await run('git', ['add', '-A'], cwd);
    await run('git', ['commit', '-m', message, '--no-verify'], cwd);
    return (await run('git', ['rev-parse', 'HEAD'], cwd)).trim();
  }

  /** Create a worktree on a new branch off `from`. */
  async worktree(name, from = 'main') {
    const wtPath = path.join(this.root, '..', 'wt', name);
    await fs.mkdir(path.dirname(wtPath), { recursive: true });
    await run('git', ['worktree', 'add', '-b', `wt/${name}`, wtPath, from], this.root);
    this.worktrees.set(name, wtPath);
    return wtPath;
  }

  wt(name) {
    const p = this.worktrees.get(name);
    if (!p) throw new Error(`fixture: no worktree '${name}'`);
    return p;
  }

  async cleanup() {
    await fs.rm(path.dirname(this.root), { recursive: true, force: true }).catch(() => {});
  }
}

/** A bare-minimum repo with a main branch and one base commit. */
export async function newRepo(label = 'repo') {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `grove-fx-${label}-`));
  const root = path.join(tmp, 'repo');
  await fs.mkdir(root, { recursive: true });

  await run('git', ['init', '--initial-branch=main', '-q'], root);
  await run('git', ['config', 'user.name', 'grove test'], root);
  await run('git', ['config', 'user.email', 'test@grove.invalid'], root);
  await run('git', ['config', 'commit.gpgsign', 'false'], root);

  const fx = new Fixture(root);
  await fx.write('README.md', '# fixture\n');
  await fx.write('src/base.js', 'export function baseline() { return 1; }\n');
  await fx.write('config/registry.mjs',
    'export const REGISTRY = {\n  EXISTING_KEY: { gate: "eq1" },\n};\n');
  await fx.commit('base');
  return fx;
}

/**
 * THE MAIN FIXTURE. Ground truth is returned alongside, and the tests assert on it.
 *
 * Workstreams:
 *   uniqueUncommitted  — adds UNCOMMITTED_ONLY_SYMBOL, never committed.   [P0: at risk]
 *   uniqueCommitted    — commits COMMITTED_ONLY_SYMBOL.                    [P0: hold]
 *   dupA / dupB        — BOTH add SHARED_DUP_SYMBOL, different families.   [P3: duplicate]
 *   collideA/collideB  — both edit registry.mjs, same key, conflicting.    [P1: collision]
 *   empty              — untouched.                                        [P6: disposable]
 *   alreadyLanded      — commits a change base independently ALSO has.     [instrument check]
 */
export async function standardFixture() {
  const fx = await newRepo('std');

  // --- P0: unique work that exists only as an uncommitted edit -------------------
  await fx.worktree('uniqueUncommitted');
  await fx.write('src/only_uncommitted.js',
    'export function UNCOMMITTED_ONLY_SYMBOL() { return "at risk"; }\n',
    fx.wt('uniqueUncommitted'));

  // --- P0: unique work, committed ------------------------------------------------
  await fx.worktree('uniqueCommitted');
  await fx.write('src/only_committed.js',
    'export function COMMITTED_ONLY_SYMBOL() { return "held"; }\n',
    fx.wt('uniqueCommitted'));
  await fx.commit('add committed-only symbol', fx.wt('uniqueCommitted'));

  // --- P3: two different dispatches building the same thing ----------------------
  // Names deliberately lack a shared prefix so family inference keeps them apart.
  await fx.worktree('alpha-1');
  await fx.write('src/dup_a.js',
    'export function SHARED_DUP_SYMBOL(x) {\n  const acc = [];\n  for (const item of x) { acc.push(item * 2); }\n  return acc;\n}\n',
    fx.wt('alpha-1'));
  await fx.commit('alpha implements shared', fx.wt('alpha-1'));

  await fx.worktree('beta-1');
  await fx.write('src/dup_b.js',
    'export function SHARED_DUP_SYMBOL(x) {\n  const acc = [];\n  for (const item of x) { acc.push(item * 2); }\n  return acc;\n}\n',
    fx.wt('beta-1'));
  await fx.commit('beta implements the same thing', fx.wt('beta-1'));

  // --- P1: hotspot collision on a registry file ----------------------------------
  await fx.worktree('collideA');
  await fx.write('config/registry.mjs',
    'export const REGISTRY = {\n  EXISTING_KEY: { gate: "eq1" },\n  HOTSPOT_KEY: { gate: "eq1", owner: "A" },\n};\n',
    fx.wt('collideA'));
  await fx.commit('A claims the hotspot key', fx.wt('collideA'));

  await fx.worktree('collideB');
  await fx.write('config/registry.mjs',
    'export const REGISTRY = {\n  EXISTING_KEY: { gate: "eq1" },\n  HOTSPOT_KEY: { gate: "ne0", owner: "B" },\n};\n',
    fx.wt('collideB'));
  await fx.commit('B claims the same hotspot key differently', fx.wt('collideB'));

  // --- P6: nothing at all ---------------------------------------------------------
  await fx.worktree('empty');

  // --- instrument check: content base ALREADY has, via an independent commit -------
  // The worktree's own history diverges from base, so `git diff base...head` shows a
  // change — but base already contains that exact content, so merge-tree shows nothing.
  await fx.worktree('alreadyLanded');
  await fx.write('src/landed.js', 'export function LANDED_SYMBOL() { return 7; }\n', fx.wt('alreadyLanded'));
  await fx.commit('worktree adds landed.js', fx.wt('alreadyLanded'));
  await fx.write('src/landed.js', 'export function LANDED_SYMBOL() { return 7; }\n');
  await fx.commit('base independently adds the identical file');

  return {
    fx,
    truth: {
      atRisk: ['uniqueUncommitted'],
      uniqueCommitted: ['uniqueCommitted'],
      // Keys use coarse kind buckets (see normalizeKind): ctags reports capitalised JS
      // functions as "class", so raw kinds are not a stable identity across workstreams.
      duplicatePair: ['alpha-1', 'beta-1'],
      duplicateSymbol: 'callable:SHARED_DUP_SYMBOL',
      collisionPair: ['collideA', 'collideB'],
      collisionSymbol: 'value:HOTSPOT_KEY',
      disposable: ['empty', 'alreadyLanded'],
      uncommittedOnlySymbol: 'callable:UNCOMMITTED_ONLY_SYMBOL',
      committedOnlySymbol: 'callable:COMMITTED_ONLY_SYMBOL',
      allWorktrees: [
        'uniqueUncommitted', 'uniqueCommitted', 'alpha-1', 'beta-1',
        'collideA', 'collideB', 'empty', 'alreadyLanded',
      ],
    },
  };
}

/** A repo with worktrees but nothing to find — the negative control. */
export async function emptyFixture() {
  const fx = await newRepo('empty');
  await fx.worktree('quiet-1');
  await fx.worktree('quiet-2');
  return fx;
}
