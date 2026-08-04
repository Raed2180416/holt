/**
 * holt — THE THREE CLASSES THAT SURVIVED THE PREVIOUS REPAIR, PINNED IN BOTH DIRECTIONS.
 *
 * Six defects were reported against the integrated guard fix. They are three root causes:
 *
 * [A] GIT'S ARGUMENT GRAMMAR WAS RE-IMPLEMENTED AD HOC AT EVERY QUESTION.
 *     The usage scan read `sub.find((t) => GIT_USAGE.has(t))` — every token, no `--`, no option
 *     values — while its sibling `scanNoOpFlags` in the same function carefully skipped
 *     `valueOpts`. So `git clean -fdx -e -h` was ALLOWED: `-h` is the VALUE of `-e`, git never
 *     printed usage, and every untracked file went. The same missing grammar is why the file
 *     layer read `git restore --recurse-submodules src/` as "src/ is the option's value" (it is
 *     ATTACHED-ONLY, so src/ is the pathspec), and why a git PATHSPEC — `src/`, `:/`, `'*.ts'` —
 *     matched nothing at all while `git checkout -- src/committed.ts` was DENIED on a file the
 *     command provably does not touch. One grammar, one reader: walkGitArgs.
 *
 * [B] AN ARGV WITH ONE ENTRY PER REPOSITORY PATH, AND THE INSTRUMENT RUN BEFORE THE FILTER.
 *     `git sparse-checkout` sets skip-worktree on every excluded path, so indexFlagDelta asked
 *     git about the whole repository minus the cone. At 40,000 excluded paths the argv passed
 *     ARG_MAX and `execve` answered E2BIG — and because the guard is fail-closed on a failed
 *     instrument, the worktree became permanently unclassifiable (`rm -rf dist`: allow -> exit 2,
 *     forever). Below that threshold it merely cost ~0.9 s on EVERY guarded Bash call. Both edges
 *     are the same fault, and the answer it was paying for was "no flagged path is on disk".
 *
 * [C] THE MODEL READ A DESTRUCTIVE VERB PLUS ITS OPERANDS, OUT OF ONE SEGMENT'S ARGV.
 *     `find <worktree> -type f -delete` puts the worktree in find's ROOT position and the
 *     deletion in a PRIMARY; `… | xargs rm -rf` puts the path on stdin, in no argv at all. Both
 *     were silent allows. The asymmetry that proves it is the model: `find . -maxdepth 0 -exec rm
 *     -rf ../wt-a \;` DENIED (the literal text is in argv) while `find ../wt-a -type f -exec rm -f
 *     {} +` ALLOWED.
 *
 * EVERY GROUND-TRUTH CLAIM BELOW IS RUN, NOT ASSUMED. `destroys()` executes the command against a
 * real fixture and asserts the content is gone; `noOp()` executes it and asserts nothing moved.
 * A verdict assertion on an unchecked fixture is a claim about nothing, and this area's traps —
 * `-h` as an option's value, `-n` inside `-ne`, `:(glob)` turning `*` back into a shell glob —
 * are exactly the ones an unchecked fixture hides.
 */

import { execFile } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assessCommand, walkGitArgs, parseGitPathspec, gitSubcommandOptionTable } from '../../src/agent.mjs';
import { chunkByArgvBytes, gitPathBatched, ARGV_BYTE_BUDGET } from '../../src/git.mjs';
import { indexFlagDelta } from '../../src/scan.mjs';

const run = (cmd, args, cwd) => new Promise((resolve) => {
  execFile(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } },
    (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout: stdout ?? '', stderr: stderr ?? '' }));
});
const sh = (cmd, cwd) => run('bash', ['-lc', cmd], cwd);

/** A repository whose worktree holds content that exists in NO commit, index entry or stash. */
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-gcr-'));
  const main = path.join(root, 'main');
  await fs.mkdir(path.join(main, 'src'), { recursive: true });
  await run('git', ['init', '-q', '-b', 'main', '.'], main);
  await run('git', ['config', 'user.email', 't@t'], main);
  await run('git', ['config', 'user.name', 't'], main);
  await fs.writeFile(path.join(main, 'src', 'committed.ts'), 'export const c = 1;\n');
  await fs.writeFile(path.join(main, 'src', 'other.ts'), 'export const o = 1;\n');
  await run('git', ['add', '-A'], main);
  await run('git', ['commit', '-q', '-m', 'base', '--no-verify'], main);
  const wt = path.join(root, 'wt-a');
  await run('git', ['worktree', 'add', '-q', wt, '-b', 'wt-a'], main);
  // TRACKED and modified to a state no commit holds — what checkout/restore overwrite.
  await fs.writeFile(path.join(wt, 'src', 'other.ts'), 'export const UNIQUE_TRACKED_ONLY_COPY = 999;\n');
  // UNTRACKED, existing nowhere else — what `clean -fdx`, `rm` and `find -delete` destroy.
  await fs.writeFile(path.join(wt, 'only-copy.ts'), 'export function UNIQUE_SYMBOL_CLEANME(){ return 1; }\n');
  return { root, main, wt, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

const survives = async (f) => (await fs.readFile(path.join(f.wt, 'src', 'other.ts'), 'utf8')).includes('999');
const untrackedThere = async (f) => fs.access(path.join(f.wt, 'only-copy.ts')).then(() => true, () => false);

/* =======================================================================================
 * [A] ONE READER OF GIT'S ARGUMENT GRAMMAR
 * ===================================================================================== */

test('[A] the option table is git\'s own, re-derived from the installed git', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-opt-'));
  await run('git', ['init', '-q', '.'], dir);
  const table = gitSubcommandOptionTable();
  const drift = [];
  for (const [key, spec] of table) {
    const r = await run('git', [...key.split(' '), '-h'], dir);
    const text = `${r.stdout}${r.stderr}`;
    if (!/^\s{2,}-/m.test(text)) continue;   // a dispatcher prints no option list
    const value = new Set();
    for (const line of text.split('\n')) {
      const m = /^\s{2,}(-.*)$/.exec(line);
      if (!m) continue;
      let body = m[1];
      const cut = /\s{2,}\S/.exec(body);
      if (cut) body = body.slice(0, cut.index);
      body = body.trim().replace(/\[no-\]/g, '');
      const names = [];
      let rest = body;
      for (;;) {
        const nm = /^(--?)([A-Za-z0-9][A-Za-z0-9-]*)/.exec(rest);
        if (!nm) break;
        names.push(`${nm[1]}${nm[2]}`);
        rest = rest.slice(nm[0].length);
        if (rest.startsWith(', ')) { rest = rest.slice(2); continue; }
        break;
      }
      // A SEPARATE value placeholder consumes the next word; an ATTACHED `[=<x>]` never does.
      if (/^\s+[<(]/.test(rest)) for (const n of names) value.add(n);
    }
    const missing = [...value].filter((o) => !spec.value.includes(o));
    if (missing.length) drift.push(`git ${key}: this git takes a value for ${missing.join(', ')} and holt's table does not say so`);
  }
  await fs.rm(dir, { recursive: true, force: true });
  assert.deepEqual(drift, [],
    `the installed git's option grammar has moved away from GIT_SUBCOMMAND_OPTS:\n  ${drift.join('\n  ')}`);
});

test('[A] `-h` is a usage request only where git would read it as an OPTION — ground truth first', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-h-'));
  await run('git', ['init', '-q', '-b', 'main', '.'], dir);
  await run('git', ['config', 'user.email', 't@t'], dir);
  await run('git', ['config', 'user.name', 't'], dir);
  await fs.writeFile(path.join(dir, 'seed.txt'), 'seed\n');
  await run('git', ['add', '-A'], dir);
  await run('git', ['commit', '-q', '-m', 'base', '--no-verify'], dir);

  // args -> does real git DELETE the untracked canary?
  const rows = [
    { args: ['-h', '-fdx'], deletes: false },
    { args: ['-fdx', '-h'], deletes: false },
    { args: ['-fdxh'], deletes: false },
    { args: ['-hfdx'], deletes: false },
    { args: ['-e', '-h', '-fdx'], deletes: true },
    { args: ['-fdx', '-e', '-h'], deletes: true },
    { args: ['-eh', '-fdx'], deletes: true },
    { args: ['--exclude', '-h', '-fdx'], deletes: true },
    { args: ['-fdx', '--exclude=-h'], deletes: true },
    { args: ['-ne', '-h', '-fd'], deletes: false },        // `-n` is present: a real dry run
  ];
  for (const row of rows) {
    await fs.writeFile(path.join(dir, 'untracked.txt'), 'UNIQUE\n');
    await run('git', ['clean', ...row.args], dir);
    const gone = !(await fs.access(path.join(dir, 'untracked.txt')).then(() => true, () => false));
    assert.equal(gone, row.deletes,
      `GROUND TRUTH MOVED: \`git clean ${row.args.join(' ')}\` ${gone ? 'deleted' : 'did not delete'} the canary`);
  }
  await fs.rm(dir, { recursive: true, force: true });

  // …and only now, holt's verdict, in a worktree that really has something to lose.
  const f = await fixture();
  try {
    for (const row of rows) {
      const v = await assessCommand(`git clean ${row.args.join(' ')}`, f.wt, {});
      if (row.deletes) {
        assert.notEqual(v.decision, 'allow',
          `\`git clean ${row.args.join(' ')}\` deletes every untracked file and holt allowed it`);
      } else {
        assert.equal(v.decision, 'allow',
          `\`git clean ${row.args.join(' ')}\` changes nothing and holt answered ${v.decision}: ${v.reason}`);
      }
    }
  } finally { await f.cleanup(); }
});

test('[A] walkGitArgs: an option VALUE, a word after `--`, and an unreadable option list', () => {
  assert.equal(walkGitArgs('clean', ['-h', '-fdx']).usage, '-h');
  assert.equal(walkGitArgs('clean', ['-fdxh']).usage, '-h');
  assert.equal(walkGitArgs('clean', ['-e', '-h', '-fdx']).usage, null, '`-h` is the value of `-e`');
  assert.equal(walkGitArgs('clean', ['-eh', '-fdx']).usage, null, 'a value letter eats the rest of its cluster');
  assert.equal(walkGitArgs('clean', ['--', '-h']).usage, null, 'after `--` every word is a pathspec');
  assert.equal(walkGitArgs('clean', ['--exclude=-h', '-fdx']).usage, null, 'an attached value is not an option');
  // An option holt does not know MIGHT consume the next word, so a later `-h` cannot be claimed.
  const unknown = walkGitArgs('clean', ['--brand-new-option', '-h', '-fdx']);
  assert.equal(unknown.ambiguous, true);
  assert.equal(unknown.usage, null, 'an unreadable option list withdraws the usage claim');
  // Pathspecs: everything after `--`, or every operand when there is none.
  assert.deepEqual(walkGitArgs('restore', ['-s', 'HEAD', 'src/']).pathspecs, [2], '`-s` takes a value');
  assert.deepEqual(walkGitArgs('checkout', ['HEAD', '--', 'src/']).pathspecs, [2], 'a treeish is not a pathspec');
  assert.deepEqual(walkGitArgs('restore', ['--recurse-submodules', 'src/']).pathspecs, [1],
    '`--recurse-submodules[=<checkout>]` is attached-only and consumes nothing');
});

test('[A] a git PATHSPEC is not a shell glob — ground truth, then the verdict', async () => {
  const f = await fixture();
  try {
    // GROUND TRUTH: each spelling really does overwrite the only copy.
    for (const spelling of ['src/', 'src', './src', ':/', '"*.ts"', '-s HEAD src/', '--worktree src/']) {
      await fs.writeFile(path.join(f.wt, 'src', 'other.ts'), 'export const UNIQUE_TRACKED_ONLY_COPY = 999;\n');
      await sh(`git restore ${spelling}`, f.wt);
      assert.equal(await survives(f), false,
        `GROUND TRUTH MOVED: \`git restore ${spelling}\` left the modification in place`);
    }
    await fs.writeFile(path.join(f.wt, 'src', 'other.ts'), 'export const UNIQUE_TRACKED_ONLY_COPY = 999;\n');
    for (const cmd of ['git restore src/', 'git restore src', 'git restore ./src', 'git restore :/',
      'git restore "*.ts"', 'git restore -s HEAD src/', 'git restore --worktree src/',
      'git checkout -- src/', 'git restore \':(icase)SRC\'', 'git restore \':(glob)src/**\'',
      'git restore \':!only-copy.ts\'', 'git restore --recurse-submodules src/',
      'git restore --pathspec-from-file=-']) {
      const v = await assessCommand(cmd, f.wt, {});
      assert.notEqual(v.decision, 'allow', `\`${cmd}\` overwrites the only copy and holt allowed it`);
    }
  } finally { await f.cleanup(); }
});

test('[A] a NARROW pathspec is judged by its pathspec, not by the whole worktree', async () => {
  const f = await fixture();
  try {
    // GROUND TRUTH: this really is a no-op. `git status` is identical before and after.
    const before = (await run('git', ['status', '--porcelain'], f.wt)).stdout;
    await sh('git checkout -- src/committed.ts', f.wt);
    const after = (await run('git', ['status', '--porcelain'], f.wt)).stdout;
    assert.equal(after, before, 'GROUND TRUTH MOVED: the command changed the working tree');
    // …and holt must not refuse it while naming files it cannot touch.
    for (const cmd of ['git checkout -- src/committed.ts', 'git checkout src/committed.ts',
      'git restore src/committed.ts', 'git restore --staged src/', 'git restore -S src/']) {
      const v = await assessCommand(cmd, f.wt, {});
      assert.equal(v.decision, 'allow', `\`${cmd}\` changes nothing and holt answered ${v.decision}: ${v.reason}`);
    }
  } finally { await f.cleanup(); }
});

test('[A] a NARROW pathspec with the DEFAULT source cannot reach untracked content', async () => {
  const f = await fixture();
  try {
    // The tracked file is clean here; the only unique work in src/ would be an untracked file.
    await run('git', ['checkout', '--', 'src/other.ts'], f.wt);
    await fs.writeFile(path.join(f.wt, 'src', 'scratch.ts'), 'export const UNIQUE_UNTRACKED = 1;\n');
    // GROUND TRUTH: git does not even try — it exits 1 and changes nothing.
    const r = await sh('git restore src/scratch.ts', f.wt);
    assert.notEqual(r.code, 0, 'GROUND TRUTH MOVED: restore accepted an untracked pathspec');
    await sh('git restore src/', f.wt);
    assert.equal(await fs.access(path.join(f.wt, 'src', 'scratch.ts')).then(() => true, () => false), true,
      'GROUND TRUTH MOVED: `git restore src/` removed an untracked file');
    for (const cmd of ['git restore src/', 'git checkout -- src/']) {
      const v = await assessCommand(cmd, f.wt, {});
      assert.equal(v.decision, 'allow',
        `\`${cmd}\` cannot touch untracked content and holt answered ${v.decision}: ${v.reason}`);
    }
    // …while the command that CAN take it is still refused, in the same tree, at the same moment.
    const clean = await assessCommand('git clean -fdx', f.wt, {});
    assert.notEqual(clean.decision, 'allow', 'the harness is blind: `git clean -fdx` was allowed');
  } finally { await f.cleanup(); }
});

test('[A] …but a NAMED SOURCE does reach it, and that is not softened', async () => {
  // The hole a flat "checkout/restore are tracked-only" rule would have opened, found by
  // attacking this repair. A source tree can write a path the index does not hold.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-src-'));
  try {
    await fs.mkdir(path.join(root, 'main', 'src'), { recursive: true });
    const main = path.join(root, 'main');
    await run('git', ['init', '-q', '-b', 'main', '.'], main);
    await run('git', ['config', 'user.email', 't@t'], main);
    await run('git', ['config', 'user.name', 't'], main);
    await fs.writeFile(path.join(main, 'src', 'a.ts'), 'export const a = 1;\n');
    await run('git', ['add', '-A'], main);
    await run('git', ['commit', '-q', '-m', 'base', '--no-verify'], main);
    const wt = path.join(root, 'wt-a');
    await run('git', ['worktree', 'add', '-q', wt, '-b', 'wt-a'], main);
    await run('git', ['switch', '-q', '-c', 'other'], main);
    await fs.writeFile(path.join(main, 'src', 'newfile.ts'), 'export const NEW_ON_OTHER = 1;\n');
    await run('git', ['add', '-A'], main);
    await run('git', ['commit', '-q', '-m', 'other adds newfile', '--no-verify'], main);
    // In the worktree that path is UNTRACKED and holds content no ref holds.
    await fs.writeFile(path.join(wt, 'src', 'newfile.ts'), 'export const UNIQUE_SYMBOL_ONLY_HERE = 1;\n');

    // GROUND TRUTH: the untracked file is overwritten, rc=0, silently.
    const before = await fs.readFile(path.join(wt, 'src', 'newfile.ts'), 'utf8');
    const v = await assessCommand('git restore --source=other src/', wt, {});
    await sh('git restore --source=other src/', wt);
    const after = await fs.readFile(path.join(wt, 'src', 'newfile.ts'), 'utf8');
    assert.notEqual(after, before, 'GROUND TRUTH MOVED: --source did not overwrite the untracked file');
    assert.notEqual(v.decision, 'allow',
      '`git restore --source=<tree> <spec>` overwrites untracked content and must not be allowed');
    for (const cmd of ['git restore -s other src/', 'git checkout other -- src/', 'git checkout other src/']) {
      const w = await assessCommand(cmd, wt, {});
      assert.notEqual(w.decision, 'allow', `\`${cmd}\` names a source and must not be softened`);
    }
  } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

test('[A] parseGitPathspec reads the magic gitglossary(7) documents', () => {
  assert.equal(parseGitPathspec('src/').pattern, 'src/');
  assert.equal(parseGitPathspec(':/').whole, true);
  assert.equal(parseGitPathspec(':(top)').whole, true);
  assert.equal(parseGitPathspec(':!app').exclude, true);
  assert.equal(parseGitPathspec(':^app').exclude, true);
  assert.equal(parseGitPathspec(':(exclude)app').exclude, true);
  assert.equal(parseGitPathspec(':(glob)src/**').pathspec, false, '`:(glob)` restores the shell rule');
  assert.equal(parseGitPathspec(':(icase)SRC').icase, true);
  assert.equal(parseGitPathspec(':(attr:binary)x').whole, true, 'magic holt cannot read is the WHOLE tree');
});

/* =======================================================================================
 * [B] THE ARGUMENT-LIST CEILING, AND MEASURING BEFORE FILTERING
 * ===================================================================================== */

test('[B] chunkByArgvBytes never emits a group over the budget', () => {
  const paths = Array.from({ length: 5000 }, (_, i) => `apps/a${i % 40}/src/components/dashboard/widgets/Chart${i}.tsx`);
  const groups = chunkByArgvBytes(paths, 4096, 64);
  assert.ok(groups.length > 1, 'a 5,000-path list must be split at a 4 KiB budget');
  assert.deepEqual(groups.flat(), paths, 'chunking must not lose or reorder a path');
  for (const g of groups) {
    const bytes = g.reduce((n, p) => n + Buffer.byteLength(p, 'utf8') + 1, 0);
    assert.ok(bytes <= 4096 || g.length === 1, `a group of ${bytes} bytes exceeds the budget`);
  }
  // One path longer than the whole budget still gets its own group rather than being dropped.
  const huge = 'x'.repeat(9000);
  assert.deepEqual(chunkByArgvBytes([huge], 4096), [[huge]]);
  assert.ok(ARGV_BYTE_BUDGET >= 20_000, 'the real budget must still be usable for ordinary repositories');
});

test('[B] a sparse checkout is classifiable and cheap — no E2BIG, no per-call second', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-sparse-'));
  const main = path.join(root, 'main');
  await fs.mkdir(main, { recursive: true });
  await run('git', ['init', '-q', '-b', 'main', '.'], main);
  await run('git', ['config', 'user.email', 't@t'], main);
  await run('git', ['config', 'user.name', 't'], main);
  // 4,000 excluded paths at an ordinary monorepo path length. The live defect needed ~32,000 to
  // cross ARG_MAX; this is the same code path at a size a test suite can afford, and the argv
  // that used to be built here is asserted directly below rather than being merely survived.
  const N = 4000;
  for (let i = 0; i < N; i++) {
    const d = path.join(main, 'apps', `a${String(i % 40).padStart(2, '0')}`, 'src/components/dashboard/widgets');
    await fs.mkdir(d, { recursive: true });
    await fs.writeFile(path.join(d, `RevenueChart${String(i).padStart(6, '0')}.tsx`), `export const C${i}=${i};\n`);
  }
  await fs.mkdir(path.join(main, 'tools'), { recursive: true });
  await fs.writeFile(path.join(main, 'tools', 'build.ts'), 'export const b = 1;\n');
  await run('git', ['add', '-A'], main);
  await run('git', ['commit', '-q', '-m', 'monorepo', '--no-verify'], main);
  const wt = path.join(root, 'wt-a');
  await run('git', ['worktree', 'add', '-q', wt, '-b', 'wt-a'], main);
  const cone = await run('git', ['sparse-checkout', 'set', '--cone', 'tools'], wt);
  if (cone.code !== 0) { await fs.rm(root, { recursive: true, force: true }); t.skip('this git has no cone sparse-checkout'); return; }

  const flagged = (await run('git', ['ls-files', '-v'], wt)).stdout.split('\n').filter((l) => l && l[0] !== 'H');
  assert.ok(flagged.length > 1000, `the fixture must actually be sparse; ls-files -v flagged ${flagged.length}`);
  // THE ARGV THE OLD CODE BUILT. Asserting the byte count is what makes the E2BIG claim a
  // measurement rather than a story: at 40,000 paths this number passed ARG_MAX (2,097,152).
  const argvBytes = flagged.reduce((n, l) => n + Buffer.byteLength(l.slice(2), 'utf8') + 1, 0);
  assert.ok(argvBytes > 100_000, `one argv entry per flagged path is ${argvBytes} bytes for ${flagged.length} paths`);

  const t0 = Date.now();
  const r = await indexFlagDelta(wt);
  const ms = Date.now() - t0;
  assert.equal(r.how, 'ls-files-v', `the instrument failed: ${r.error}`);
  assert.deepEqual(r.atRisk, [], 'nothing in a sparse cone is on disk, so nothing there is at risk');
  assert.deepEqual(r.unknown, [], 'a path that is not on disk is ANSWERED, not unknown');
  assert.ok(ms < 400, `indexFlagDelta took ${ms}ms on a sparse checkout — the annoyance bar is 200ms per call`);

  // …and the guard's own verdict on the most ordinary destructive-looking command in software.
  const v = await assessCommand('rm -rf dist', wt, {});
  assert.equal(v.decision, 'allow', `a sparse worktree must stay classifiable; holt answered ${v.decision}: ${v.reason}`);
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test('[B] the existence filter did not blind the instrument: a flagged file ON DISK is still found', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-flag-'));
  await run('git', ['init', '-q', '-b', 'main', '.'], root);
  await run('git', ['config', 'user.email', 't@t'], root);
  await run('git', ['config', 'user.name', 't'], root);
  await fs.mkdir(path.join(root, 'vendor', 'pkg'), { recursive: true });
  await fs.mkdir(path.join(root, 'app', 'config'), { recursive: true });
  for (let i = 0; i < 400; i++) await fs.writeFile(path.join(root, 'vendor', 'pkg', `f${i}.ts`), `export const v${i}=${i};\n`);
  await fs.writeFile(path.join(root, 'app', 'config', 'local.json'), '{"COMMITTED":1}\n');
  await fs.writeFile(path.join(root, 'app', 'config', 'other.json'), '{"ALSO":1}\n');
  await run('git', ['add', '-A'], root);
  await run('git', ['commit', '-q', '-m', 'base', '--no-verify'], root);
  // Flag the bulk (and take it off disk, as a sparse cone would) AND two files that stay.
  const bulk = (await run('git', ['ls-files', '--', 'vendor'], root)).stdout.split('\n').filter(Boolean);
  await gitPathBatched(['update-index', '--skip-worktree', '--'], bulk, { cwd: root, allowMutation: true });
  await run('git', ['update-index', '--skip-worktree', 'app/config/local.json', 'app/config/other.json'], root);
  await fs.rm(path.join(root, 'vendor'), { recursive: true, force: true });
  // The canonical credentials edit: content held by no commit, hidden from `git status`.
  await fs.writeFile(path.join(root, 'app', 'config', 'local.json'), '{"UNIQUE_SYMBOL_SKIPPED":true}\n');
  assert.equal((await run('git', ['status', '--porcelain'], root)).stdout.trim(), '',
    'GROUND TRUTH MOVED: the flag must hide the edit from git status');

  const r = await indexFlagDelta(root);
  assert.equal(r.how, 'ls-files-v', `the instrument failed: ${r.error}`);
  assert.deepEqual(r.atRisk, ['app/config/local.json'],
    'the flagged file that IS on disk and IS modified must still be reported');
  assert.deepEqual(r.unknown, [], 'the flagged file that is on disk and unmodified is clean, not unknown');
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/* =======================================================================================
 * [C] DELETION THAT IS NOT AN OPERAND OF A DESTRUCTIVE VERB
 * ===================================================================================== */

test('[C] find primaries, -exec utilities and stdin-fed xargs destroy, and are refused', async () => {
  const shapes = [
    'find ../wt-a -type f -delete',
    'find ../wt-a -delete',
    'find ../wt-a -depth -delete',
    'find -L ../wt-a -delete',
    'find ../wt-a -type f -exec rm -f {} +',
    'find ../wt-a -type f -execdir rm -f {} +',
    'find ../wt-a -type f -exec truncate -s 0 {} +',
    'find ../wt-a -type f -exec sh -c \'rm -f "$1"\' _ {} \\;',
    'find ../wt-a -name "only-copy.ts" -delete',
    'find ../wt-a ! -name zzz -delete',
    'find ../wt-a -type f | xargs rm -f',
    'find ../wt-a -type f -print0 | xargs -0 rm -f',
    'printf "%s" ../wt-a | xargs rm -rf',
    'echo ../wt-a | xargs rm -rf',
    'xargs rm -rf <<< "../wt-a"',
    'cat paths.txt | xargs rm -rf',
    'xargs sh -c \'rm -rf ../wt-a\' <<< x',
    'perl -e \'system("rm","-rf","../wt-a")\'',
    'ruby -e \'%x{rm -rf ../wt-a}\'',
  ];
  const f = await fixture();
  try {
    for (const cmd of shapes) {
      const v = await assessCommand(cmd, f.main, {});
      assert.notEqual(v.decision, 'allow', `\`${cmd}\` reaches a worktree holding the only copy and holt allowed it`);
    }
  } finally { await f.cleanup(); }
});

test('[C] and it really does destroy — the same shapes, run for real', async () => {
  for (const cmd of ['find ../wt-a -type f -delete', 'find ../wt-a -depth -delete',
    'find ../wt-a -type f -exec rm -f {} +', 'find ../wt-a -type f -exec sh -c \'rm -f "$1"\' _ {} \\;',
    'printf "%s" ../wt-a | xargs rm -rf', 'xargs rm -rf <<< "../wt-a"', 'ruby -e \'%x{rm -rf ../wt-a}\'']) {
    const f = await fixture();
    try {
      assert.equal(await untrackedThere(f), true);
      const r = await sh(cmd, f.main);
      if (/command not found/.test(r.stderr)) continue;   // ruby is not everywhere
      assert.equal(await untrackedThere(f), false,
        `GROUND TRUTH MOVED: \`${cmd}\` left the only copy in place`);
    } finally { await f.cleanup(); }
  }
});

test('[C] …and ordinary find/xargs work is never interrupted — parity with `rm`', async () => {
  const f = await fixture();
  try {
    const ordinary = [
      'find . -name "*.pyc" -delete',
      'find . -type f -name "*.orig" -delete',
      'find . -name "__pycache__" -type d -exec rm -rf {} +',
      'find . -name "*.o" -print0 | xargs -0 rm -f',
      'find dist -type f -delete',
      'find node_modules -delete',
      'find . -name "*.ts" -exec grep -l TODO {} +',
      'find . -type f -name "*.mjs" | xargs wc -l',
      'find . -name "*.test.mjs" -not -path "./node_modules/*"',
      'git ls-files | xargs wc -l',
      'ls | xargs -n1 basename',
    ];
    for (const cmd of ordinary) {
      const v = await assessCommand(cmd, f.wt, {});
      assert.equal(v.decision, 'allow', `ordinary work was interrupted: \`${cmd}\` -> ${v.decision}: ${v.reason}`);
    }
    // ANTI-VACUITY: a `-name` that really does select the unique file is still refused.
    const hit = await assessCommand('find . -name "only-copy.ts" -delete', f.wt, {});
    assert.notEqual(hit.decision, 'allow', 'the filter is not a blindfold: this one really does destroy');
  } finally { await f.cleanup(); }
});
