/**
 * holt — TARGET RESOLUTION: the glob a command actually wrote.
 *
 * THE CLASS: holt resolved the wrong target, or no target, and called that an answer.
 *
 * Two measured halves, one root cause. `unquoteTarget` and the tokenizer both removed the shell
 * quoting from an operand and then the matcher re-derived "is this a glob" from the characters that
 * were left — characters that no longer carried the fact. And whatever bracket text survived was
 * copied VERBATIM into `new RegExp`, on the assumption that a POSIX bracket expression and a
 * JavaScript character class are the same language.
 *
 *   SILENT   rm '../wt/app/[id].tsx'  ->  /^app\/[id]\.tsx$/  matches app/i.tsx and app/d.tsx,
 *            two files that do not exist, and NEVER the file being deleted. Measured through the
 *            real hook on a fixture where that file held the only copy of its content:
 *                rm -rf ../wt/app              -> exit 2 deny
 *                rm '../wt/app/[id].tsx'       -> exit 0 ALLOW      (same bytes)
 *            That is every Next.js App Router / Remix / SvelteKit dynamic route file there is.
 *
 *   LOUD     rm -rf '../wt/x[z-a]'  ->  SyntaxError: Range out of order in character class,
 *            thrown out of the guard's critical path. holt exits 1, and in the PreToolUse contract
 *            exit 1 is a NON-BLOCKING error: the command runs. 43 of 160 hostile bracket shapes in
 *            target position crashed the guard this way.
 *
 * GROUND TRUTH IS THE SHELL, NOT HOLT'S OPINION. Every row below is also expanded by a real bash in
 * a throwaway directory, and the test fails if holt and bash disagree. That is the only way to
 * state a conformance claim that a skeptic can re-run — and it is what caught that picomatch and
 * micromatch both invert POSIX negation (`[!a]`), which is why this file compiles brackets itself
 * rather than adopting one of them. See the note in src/agent.mjs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assessCommand, globMatches, wordPattern } from '../../src/agent.mjs';
import {
  compileLinearGlobTokens, createGlobWorkBudget, DEFAULT_GLOB_WORK_BUDGET,
} from '../../src/linear-glob.mjs';

const exec = promisify(execFile);

/** Can this platform run the reference shell at all? */
let BASH = null;
try { await exec('bash', ['-c', 'exit 0']); BASH = 'bash'; } catch { BASH = null; }

/**
 * DOES A REAL BASH SELECT `name` WITH `pattern`?
 *
 * The file is created in an empty throwaway directory and the pattern expanded with `nullglob` ON,
 * so "expanded to nothing" is distinguishable from "passed through literally". The literal
 * fall-through (nullglob OFF, which is the default) is asserted separately below, because it is a
 * DIFFERENT question and conflating the two is how the second half of this defect was missed.
 */
async function bashSelects(name, pattern) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-globtruth-'));
  try {
    await fs.writeFile(path.join(dir, name), '');
    const { stdout } = await exec(BASH, ['-c',
      `cd ${JSON.stringify(dir)}; shopt -s nullglob; printf "%s\\n" ${pattern}`]);
    return stdout.split('\n').filter(Boolean).includes(name);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * Rows are [subject, pattern]. `pattern` is written as it would be typed UNQUOTED in the shell, so
 * bash and holt are asked exactly the same question. Names are single path components with no `/`
 * and no character Windows forbids, so the fixture is creatable everywhere.
 */
const CONFORMANCE = [
  ['xb', 'x[ab]'],          ['xc', 'x[ab]'],
  ['xb', 'x[!a]'],          ['xa', 'x[!a]'],        ['x!', 'x[!a]'],
  ['xb', 'x[^a]'],          ['xa', 'x[^a]'],
  ['x]', 'x[]]'],           ['xa', 'x[]a]'],
  ['x-', 'x[a-]'],          ['xa', 'x[a-]'],
  ['x5', 'x[0-9]'],         ['xa', 'x[0-9]'],
  ['xb', 'x[z-a]'],         ['xz', 'x[z-a]'],
  ['xq', 'x[[:alpha:]]'],   ['x4', 'x[[:alpha:]]'],
  ['x4', 'x[[:digit:]]'],   ['xq', 'x[[:digit:]]'],
  ['x_', 'x[[:alnum:]_]'],  ['x%', 'x[[:alnum:]_]'],
  ['xa', 'x[a'],            ['x[a', 'x[a'],
  ['xa', 'x?'],             ['xab', 'x?'],
  ['xab', 'x*'],            ['x', 'x*'],
];

test('GLOB CONFORMANCE: holt agrees with a real bash on every bracket form', { skip: BASH ? false : 'bash unavailable' }, async () => {
  const disagreements = [];
  for (const [subject, pattern] of CONFORMANCE) {
    const truth = await bashSelects(subject, pattern);
    const mine = globMatches(pattern, subject);
    if (mine !== truth) disagreements.push(`  ${JSON.stringify(pattern)} vs ${JSON.stringify(subject)}: bash=${truth} holt=${mine}`);
  }
  assert.equal(disagreements.length, 0,
    `holt's glob must mean what the shell means:\n${disagreements.join('\n')}`);
});

test('GLOB CONFORMANCE: negation is not inverted — the failure that makes a guard protect the wrong files', () => {
  // picomatch 4.0.5 and micromatch 4.0.8 both answer these BACKWARDS (measured). A guard that gets
  // `[!a]` inverted does not protect less, it protects the complement — exactly the wrong files.
  assert.equal(globMatches('x[!a]', 'xb'), true, '[!a] excludes a, so b matches');
  assert.equal(globMatches('x[!a]', 'xa'), false, '[!a] excludes a');
  assert.equal(globMatches('x[!a]', 'x!'), true, 'the ! is the operator, not a member');
});

test('NO BRACKET EXPRESSION CAN CROSS A PATH SEPARATOR', () => {
  // `*` was already confined with [^/]; a bracket was not, so `a[/]b` matched `a/b` and a pattern
  // reached into a directory it never named.
  assert.equal(globMatches('a[/]b', 'a/b'), false);
  assert.equal(globMatches('a[.-9]b', 'a/b'), false, 'a RANGE that spans / must not admit it either');
  assert.equal(globMatches('a[!x]b', 'a/b'), false, 'nor may a negated class');
  assert.equal(globMatches('a?b', 'a/b'), false);
});

test('NEVER THROWS: no bracket expression, however malformed, escapes as an exception', () => {
  // Every one of these came out of `new RegExp` as a SyntaxError, which the hook turned into exit 1
  // — a NON-BLOCKING error under the PreToolUse contract, so the command ran.
  const hostile = [
    'x[z-a]', 'x[a', 'x[]', 'x[!]', 'x[^]', 'x[[:bogus:]]', 'x[[:alpha:]', 'x[\\]', 'x[a-\\]',
    'x[/]y', 'x[9-0]', 'x[é-a]', 'x[]a]', 'x[!a-]', 'x[[.ch.]]', 'x[[=a=]]', 'x[[=abc=]]',
    'x[--]', 'x[---]', 'x[[[[', 'x]]]]', 'x[[:]]', '[', ']', '[]', '[!', '**[z-a]**',
    'a/[z-a]/b', '*[z-a]*', '?[z-a]?', `x[${'a'.repeat(500)}-A]`, '['.repeat(200), 'x[😀-a]',
  ];
  for (const p of hostile) {
    for (const s of ['x', 'xa', 'x[z-a]', 'a/b', '']) {
      assert.doesNotThrow(() => globMatches(p, s), `${JSON.stringify(p)} vs ${JSON.stringify(s)}`);
    }
  }
});

test('TOTAL GLOB BUDGET: one meter spans multiple candidate subjects and overflows conservatively', () => {
  // Four stars keep the whole prefix active; the trailing z makes `aa` an exact non-match. The
  // first candidate fits: initial state costs 11 units and two characters cost 16 each = 43.
  // Only seven units remain, so the next candidate cannot even initialise its 11-cell state and
  // must take the destructive matcher’s conservative `true` result.
  const tokens = [
    ...Array.from({ length: 4 }, () => ({ kind: 'star', crossSlash: true })),
    { kind: 'literal', value: 'z' },
  ];
  const budget = createGlobWorkBudget(50);
  const matcher = compileLinearGlobTokens(tokens, {
    workBudget: budget,
    overflowMatches: true,
  });

  assert.equal(matcher.test('aa'), false, 'the exact result is retained while work fits');
  assert.equal(budget.used, 43);
  assert.equal(budget.exhausted, false);
  assert.equal(matcher.test('aa'), true, 'the second candidate exhausts the shared destructive budget');
  assert.equal(budget.exhausted, true);
  const usedAtOverflow = budget.used;
  assert.equal(matcher.test(''), true, 'all later candidates stay conservatively matched');
  assert.equal(budget.used, usedAtOverflow, 'exhaustion is terminal and deterministic');

  const advisoryBudget = createGlobWorkBudget(10);
  const advisory = compileLinearGlobTokens(tokens, {
    workBudget: advisoryBudget,
    overflowMatches: false,
  });
  assert.equal(advisory.test('aa'), false, 'generic/advisory matching conservatively selects nothing');
  assert.equal(advisoryBudget.exhausted, true);
});

test('TOTAL GLOB BUDGET: the largest admitted pattern and subject cannot restart pattern×subject work', () => {
  const pattern = `${'a*'.repeat(4095)}b?`;
  const subject = 'a'.repeat(32_768);
  assert.equal(pattern.length, 8192, 'exercise the path matcher at its exact admitted maximum');

  const tokens = [
    ...Array.from({ length: 8191 }, () => ({ kind: 'star', crossSlash: true })),
    { kind: 'literal', value: 'z' },
  ];
  const budget = createGlobWorkBudget();
  const matcher = compileLinearGlobTokens(tokens, {
    workBudget: budget,
    overflowMatches: true,
  });
  assert.equal(matcher.test(subject), true,
    'an exact non-match becomes a conservative match when deterministic work is exhausted');
  assert.equal(budget.exhausted, true);
  assert.ok(budget.used <= DEFAULT_GLOB_WORK_BUDGET, 'executed work never crosses the total cap');
  assert.equal(globMatches(pattern, subject), true,
    'the destructive path matcher carries the same conservative overflow contract');
});

test('TOTAL GLOB BUDGET: candidate-set exhaustion reaches the destructive refusal path', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-glob-budget-refusal-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await exec('git', ['init', '-q', '-b', 'main', '.'], { cwd: root });
  await exec('git', ['config', 'user.email', 'glob-budget@example.invalid'], { cwd: root });
  await exec('git', ['config', 'user.name', 'Glob Budget'], { cwd: root });
  await fs.writeFile(path.join(root, 'base.txt'), 'base\n');
  await exec('git', ['add', 'base.txt'], { cwd: root });
  await exec('git', ['commit', '-q', '-m', 'base', '--no-verify'], { cwd: root });

  // Each long candidate is an exact non-match for the trailing `b?`. The first spends most of the
  // operation-wide meter; the second cannot restart it and is conservatively treated as reached.
  const first = `${'a'.repeat(239)}x`;
  const second = `${'a'.repeat(239)}y`;
  await fs.writeFile(path.join(root, first), 'unique one\n');
  await fs.writeFile(path.join(root, second), 'unique two\n');
  // Leave room for the absolute worktree prefix used by the separate worktree-layer matcher, so
  // this exercises cumulative candidate work rather than the already-covered 8,192 length guard.
  const pattern = `${'a*'.repeat(3999)}b?`;
  assert.equal(pattern.length, 8000);
  const verdict = await assessCommand(`rm ${pattern}`, root);

  assert.equal(verdict.decision, 'deny', verdict.reason);
  assert.ok(verdict.files?.includes(second) || verdict.files?.includes(first),
    'the exhausted matcher must carry a concrete at-risk candidate into the refusal');
});

test('TOTAL GLOB BUDGET: bracket member work is charged before the callback runs', () => {
  let calls = 0;
  const budget = createGlobWorkBudget(100);
  const matcher = compileLinearGlobTokens([{
    kind: 'class',
    work: 1000,
    matches: () => { calls++; return false; },
  }], { workBudget: budget, overflowMatches: true });

  assert.equal(matcher.test('x'), true);
  assert.equal(budget.exhausted, true);
  assert.equal(calls, 0, 'an oversized bracket scan is refused before hidden callback work begins');
});

test('TOTAL GLOB BUDGET: adversarial wildcard input stays bounded in an isolated process', async () => {
  // Timing is deliberately secondary to the exact counter assertions above. This child-process
  // ceiling catches accidental work outside the meter (module load included) without defining the
  // algorithmic contract in wall-clock terms.
  const pattern = `${'a*'.repeat(4095)}b?`;
  const subject = 'a'.repeat(32_768);
  const moduleUrl = new URL('../../src/agent.mjs', import.meta.url).href;
  const source = `import { globMatches } from ${JSON.stringify(moduleUrl)};`
    + `process.stdout.write(String(globMatches(${JSON.stringify(pattern)}, ${JSON.stringify(subject)})));`;
  // Keep the adversarial payload in a temporary module rather than argv. Windows rejects the
  // equivalent `node -e <source>` invocation with ENAMETOOLONG before Holt gets to execute it.
  const probeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-glob-budget-probe-'));
  const probe = path.join(probeDir, 'probe.mjs');
  try {
    await fs.writeFile(probe, source, 'utf8');
    const started = Date.now();
    const result = await exec(process.execPath, [probe], {
      timeout: 1500, maxBuffer: 1024 * 1024,
    });
    assert.equal(result.stdout, 'true', 'over-budget destructive globs must degrade to the conservative match');
    assert.ok(Date.now() - started < 1500, 'glob execution exceeded its isolated hard budget');
  } finally {
    await fs.rm(probeDir, { recursive: true, force: true });
  }
});

test('NULLGLOB IS OFF: a pattern that matches nothing is passed through LITERALLY', async (t) => {
  // Measured in a real shell, and this is the whole reason the literal reading is a second target:
  //   $ ls app        -> [id].tsx  plain.tsx
  //   $ rm app/[id].tsx        # unquoted; no app/i.tsx or app/d.tsx exists
  //   $ ls app        -> plain.tsx
  if (!BASH) return t.skip('bash unavailable');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-nullglob-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'app'));
  await fs.writeFile(path.join(dir, 'app', '[id].tsx'), 'only copy');
  await fs.writeFile(path.join(dir, 'app', 'plain.tsx'), 'other');

  await exec(BASH, ['-c', `cd ${JSON.stringify(dir)}; rm app/[id].tsx`]);
  const left = await fs.readdir(path.join(dir, 'app'));
  assert.deepEqual(left, ['plain.tsx'],
    'the shell deleted the literal file, so holt must treat the literal as a target');

  assert.equal(globMatches('app/[id].tsx', 'app/[id].tsx'), true,
    'the literal reading is a target holt must see');
  assert.equal(globMatches('app/[id].tsx', 'app/i.tsx'), true,
    'and the glob reading is still a target — both, because the shell picks by what is on disk');
});

/* ------------------------------------------------- quoting: the fact that was thrown away ---- */

test('QUOTING DECIDES: a quoted metacharacter is a literal, and holt now records that', () => {
  // These four spell the SAME file to the shell, and only the last one is a character class.
  for (const src of ["'app/[id].tsx'", '"app/[id].tsx"', 'app/\\[id\\].tsx']) {
    const p = wordPattern(src);
    assert.equal(globMatches(p, 'app/[id].tsx'), true, `${src} names exactly that file`);
    assert.equal(globMatches(p, 'app/i.tsx'), false, `${src} is NOT a character class`);
  }
  const bare = wordPattern('app/[id].tsx');
  assert.equal(globMatches(bare, 'app/i.tsx'), true, 'unquoted, it IS a class');
});

test('QUOTING NEVER-WORSE: a genuine glob still globs, and a partly-quoted word keeps its glob', () => {
  // The anti-vacuity half. If "preserve quoting" were implemented by treating everything as a
  // literal, every one of these would break and the containment rules with them.
  assert.equal(globMatches(wordPattern('../wt-*'), '../wt-a'), true);
  assert.equal(globMatches(wordPattern('dist/*.js'), 'dist/a.js'), true);
  assert.equal(globMatches(wordPattern('src/**'), 'src/a/b.js'), true);
  assert.equal(globMatches(wordPattern('"$DIR"/*.log'), '$DIR/x.log'), true,
    'only the quoted RUN is literal; the unquoted * still globs');
  assert.equal(globMatches(wordPattern("'my dir'/*.log"), 'my dir/x.log'), true);
  assert.equal(globMatches(wordPattern('?'), 'x'), true);
});

test('IDENTITY: a word with no quoted metacharacter is byte-identical to the old unquoting', () => {
  // The property that bounds the blast radius of this change: nothing can move for a word that did
  // not carry the fact being preserved.
  const untouched = ['../wt-a', 'dist', 'node_modules', '../wt-*', 'dist/*.js', 'src/**',
    'a b.txt', '$HOME/x', '~/x', './a/../b', '/abs/path', 'x[a-z].js'];
  for (const w of untouched) {
    assert.equal(wordPattern(w), w, `${JSON.stringify(w)} must pass through untouched`);
  }
});
