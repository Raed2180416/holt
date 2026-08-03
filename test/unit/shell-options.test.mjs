/**
 * holt — TARGET RESOLUTION: the verdict must be keyed on the EFFECT, not on the spelling.
 *
 * MEASURED, through the real hook, against a worktree holding the only copy of its content:
 *
 *     bash -c   "rm -rf ../wt-a"   -> exit 2  deny
 *     bash -lc  "rm -rf ../wt-a"   -> exit 0  ALLOW      <- the identical deletion
 *     bash -xc  "rm -rf ../wt-a"   -> exit 0  ALLOW
 *     sh   -ec  "rm -rf ../wt-a"   -> exit 0  ALLOW
 *     bash -euxc "rm -rf ../wt-a"  -> exit 0  ALLOW
 *     zsh  -lc  "rm -rf ../wt-a"   -> exit 0  ALLOW
 *
 * The cause was `w.indexOf('-c')`: a list of the option spellings someone happened to think of,
 * with exactly one entry. `-lc` is not exotic — it is what a login-shell wrapper, a Makefile
 * `SHELL`, and most CI runners emit.
 *
 * So the options are walked the way a shell walks them, and THE SHELL IS THE ORACLE: every row
 * below is executed by the real shell and the test fails if holt's reading disagrees with what the
 * shell actually ran.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { shellInlineProgram, lexSegments } from '../../src/agent.mjs';

const exec = promisify(execFile);

const have = async (bin) => {
  try { await exec(bin, ['-c', 'exit 0']); return true; } catch { return false; }
};
const HAVE_BASH = await have('bash');
const HAVE_SH = await have('sh');

/** What holt believes the inline program is, read off the same tokenizer the guard uses. */
function programOf(command) {
  const seg = lexSegments(command).find((s) => !s.nested);
  return seg ? shellInlineProgram(seg.words) : null;
}

/**
 * Rows are [argv-after-the-shell..., expected]. `expected` is `true` when the shell RUNS the
 * program, `false` when it does not — and it is verified by running it, never asserted from memory.
 */
const ROWS = [
  [['-c'], true],
  [['-lc'], true],
  [['-xc'], true],
  [['-cx'], true],
  [['-euxc'], true],
  [['-sc'], true],
  [['-cs'], true],
  [['-e', '-c'], true],
  [['-o', 'pipefail', '-c'], true],
  [['-eo', 'pipefail', '-c'], true],
  [['--norc', '--noprofile', '-c'], true],
  [['--login', '-c'], true],
  [['--'], false],            // `--` ends the options: what follows is a FILE, not a program
  [['--', '-c'], false],
];

test('SHELL OPTIONS: holt finds the inline program exactly when the shell runs one (bash)',
  { skip: HAVE_BASH ? false : 'bash unavailable' }, async () => {
    const wrong = [];
    for (const [opts, expectedRuns] of ROWS) {
      // GROUND TRUTH: does the real shell run it?
      let ran = false;
      try {
        const { stdout } = await exec('bash', [...opts, 'echo HOLT_RAN'], { timeout: 10_000 });
        ran = /HOLT_RAN/.test(stdout);
      } catch { ran = false; }
      assert.equal(ran, expectedRuns,
        `the fixture's own premise is wrong for bash ${opts.join(' ')} — it ${ran ? 'ran' : 'did not run'}`);

      const found = programOf(`bash ${opts.join(' ')} "echo HOLT_RAN"`);
      const holtSees = found === 'echo HOLT_RAN';
      if (holtSees !== ran) wrong.push(`  bash ${opts.join(' ')}: shell ran=${ran}, holt read=${JSON.stringify(found)}`);
    }
    assert.equal(wrong.length, 0, `holt must see the program the shell runs:\n${wrong.join('\n')}`);
  });

test('SHELL OPTIONS: the same holds for /bin/sh, which is not bash on every host',
  { skip: HAVE_SH ? false : 'sh unavailable' }, async () => {
    for (const opts of [['-c'], ['-ec'], ['-euc']]) {
      const { stdout } = await exec('sh', [...opts, 'echo HOLT_RAN'], { timeout: 10_000 });
      assert.match(stdout, /HOLT_RAN/, `sh ${opts.join(' ')} must run the program`);
      assert.equal(programOf(`sh ${opts.join(' ')} "echo HOLT_RAN"`), 'echo HOLT_RAN',
        `holt must read sh ${opts.join(' ')}`);
    }
  });

test('SHELL OPTIONS: value-taking options consume their value rather than being read as the program', () => {
  // `-o pipefail` and `-eo pipefail`: the program is the FIRST OPERAND, and `pipefail` is not it.
  assert.equal(programOf('bash -o pipefail -c "make"'), 'make');
  assert.equal(programOf('bash -eo pipefail -c "make"'), 'make');
  assert.equal(programOf('bash -O extglob -c "make"'), 'make');
  assert.equal(programOf('bash --rcfile /dev/null -c "make"'), 'make');
  assert.equal(programOf('bash --rcfile=/dev/null -c "make"'), 'make');
  // fish spells it long.
  assert.equal(programOf('fish --command="make"'), 'make');
  assert.equal(programOf('fish --command "make"'), 'make');
});

test('SHELL OPTIONS NEVER-WORSE: a shell running a SCRIPT still carries no inline program', () => {
  // `bash build.sh` is no more readable than `npm run build`. Reading a `-c` that is not in option
  // position — `bash script.sh -c foo` — would be inventing a program that is really an argument.
  assert.equal(programOf('bash build.sh'), null);
  assert.equal(programOf('bash -x build.sh'), null);
  assert.equal(programOf('bash script.sh -c foo'), null);
  assert.equal(programOf('bash -lc'), null, 'a -c with no operand carries nothing');
  assert.equal(programOf('bash'), null);
  assert.equal(programOf('npm run build'), null);
});
