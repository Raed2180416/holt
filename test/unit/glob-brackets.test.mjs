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
import { globMatches, wordPattern } from '../../src/agent.mjs';

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
