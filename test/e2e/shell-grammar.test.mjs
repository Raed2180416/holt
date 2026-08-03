/**
 * holt — A COMMAND CARRIED BY SHELL GRAMMAR IS STILL THE COMMAND.
 *
 * THE DEFECT CLASS THIS FILE EXISTS TO PIN.
 *
 * holt reads the TEXT of a command before it runs. Its tokenizer is not a shell and does not need
 * to be — but every shell construct that CARRIES a command is a place the destructive verb can sit
 * where a non-recursive reader never looks. When that happened the verb was never seen, nothing
 * matched, and the hook allowed the command. Not a near miss: the work was gone.
 *
 * Measured across the false-negative corpus, 49 of 424 destructive commands (11.6%) were allowed,
 * and every single one was this class in a different spelling:
 *
 *     for x in <wt>; do rm -rf <wt>/src/f.js; done    the body never mentions the loop variable
 *     { rm -rf <wt>/src/f.js ; }                      a brace group, where `( … )` already worked
 *     timeout 30 rm -rf <wt>/src/f.js                 a wrapper with an operand of its own
 *     while true; do rm -rf <wt>/src/f.js; done       a keyword-introduced body
 *     if true; then rm -rf <wt>/src/f.js; fi          the same
 *     sudo -u root rm -rf <wt>/src/f.js               a wrapper with an option
 *     ( git -C <wt> restore . )                       a rule anchored to the END OF THE STRING
 *     trap "rm -rf <wt>/src/f.js" EXIT                a program held as a string, run later
 *
 * FOUR CAUSES, ONE SHAPE — an unknown answered as "safe":
 *
 *  1. expandForLoops emitted a body only when binding the variable CHANGED the text. A body naming
 *     a constant path was dropped, because "I found nothing to substitute" was read as "there is
 *     nothing dangerous here". A loop body runs on every iteration either way.
 *  2. `{` and `}` are reserved WORDS, not punctuation. `(` and `)` were already segment separators
 *     in lexSegments and braces were not, so the segment's first word was the literal `{`.
 *  3. The wrapper-skip predicate was written inline at TWELVE call sites. `timeout` cannot be
 *     taught by adding a word to a set — its DURATION has to be consumed too — and doing that
 *     twelve times is how twelve copies drift. SHELL_KEYWORDS was passed at exactly one of them,
 *     which is why `do` and `then` bodies were invisible to the other eleven readers.
 *  4. One destructive rule was anchored with `$`, so it fired only when the command STOPPED at the
 *     pathspec. A subshell, a redirect or a heredoc — one byte after it — walked straight through.
 *
 * WHY BOTH HALVES ARE IN ONE FILE. Closing this class the first time cost 95 of 183 FALSE
 * POSITIVES: once loop bodies became visible to the file layer, `for f in ./build/*; do rm -rf $f;
 * done` started asking about `$f` — a variable the command itself binds. The verb layer already
 * knew it was bound and the file layer did not, because that rule ALSO lived in one reader. A fix
 * for this class that is not measured against ordinary work is not a fix; over-refusal and
 * under-protection are equally disqualifying, so the never-worse half is a hard gate here, not a
 * courtesy.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { standardFixture } from '../fixtures.mjs';
import { assessCommand } from '../../src/agent.mjs';

/** Repo-relative, forward-slash. Native separators become escape sequences in generated commands. */
const rel = (from, to) => path.relative(from, to).split(path.sep).join('/');

test('GRAMMAR: a destroyer is seen through every construct that can carry it', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const wt = rel(fx.root, fx.wt('uniqueUncommitted'));
  const only = `${wt}/src/only_uncommitted.js`;
  const del = `${'r'}m -rf`;

  // ANTI-VACUITY FIRST. Every assertion below is worthless if the PLAIN command is not refused —
  // a fixture where nothing is at risk would pass the whole file while measuring nothing. This is
  // the mistake an earlier version of the corpus made, and it reported a clean sweep for weeks.
  const plain = await assessCommand(`${del} ${only}`, fx.root);
  assert.notEqual(plain.decision, 'allow',
    `PREMISE BROKEN — the plain command must be refused or this file tests nothing: `
    + `${del} ${only} -> ${plain.decision} (${plain.reason})`);

  const carried = [
    ['for-loop body that never mentions the loop variable', `for x in ${wt}; do ${del} ${only}; done`],
    ['for-loop over a glob, constant body', `for x in ${wt}*; do ${del} ${only}; done`],
    ['for-loop binding the variable', `for x in ${only}; do ${del} "$x"; done`],
    ['brace group', `{ ${del} ${only} ; }`],
    ['brace group, newline-terminated', `{ ${del} ${only}\n}`],
    ['subshell', `( ${del} ${only} )`],
    ['brace group inside a subshell', `( { ${del} ${only}; } )`],
    ['brace group inside a loop body', `for x in a; do { ${del} ${only}; }; done`],
    ['timeout with a duration operand', `timeout 30 ${del} ${only}`],
    ['timeout with an option and a duration', `timeout -k 5 30 ${del} ${only}`],
    ['timeout inside a brace group', `{ timeout 30 ${del} ${only}; }`],
    ['while body', `while true; do ${del} ${only}; done`],
    ['until body', `until false; do ${del} ${only}; done`],
    ['if branch', `if true; then ${del} ${only}; fi`],
    ['case branch', `case $x in a) ${del} ${only};; esac`],
    ['function body, then called', `cleanup(){ ${del} ${only}; }; cleanup`],
    ['sudo with an option that takes a value', `sudo -u root ${del} ${only}`],
    ['env with a flag', `env -i ${del} ${only}`],
    ['a chain of wrappers', `sudo env FOO=1 nohup nice -n5 ${del} ${only}`],
    ['trap, double-quoted', `trap "${del} ${only}" EXIT`],
    ['trap, single-quoted', `trap '${del} ${only}' EXIT`],
    ['output discarded', `${del} ${only} >/dev/null 2>&1`],
    ['backgrounded', `${del} ${only} &`],
    ['after a brace group', `{ echo hi; } && ${del} ${only}`],
    // The end-of-string anchor: identical effect, one byte after the pathspec.
    ['git restore . in a subshell', `( git -C ${wt} restore . )`],
    ['git restore . in a brace group', `{ git -C ${wt} restore . ; }`],
    ['git restore . with output discarded', `git -C ${wt} restore . >/dev/null 2>&1`],
  ];

  for (const [why, cmd] of carried) {
    const v = await assessCommand(cmd, fx.root);
    assert.notEqual(v.decision, 'allow',
      `WORK THAT EXISTS NOWHERE ELSE WOULD BE DESTROYED — ${why}: ${cmd} -> allow`);
  }
});

test('GRAMMAR NEVER-WORSE: the same constructs carrying ordinary work stay out of the way', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const disposable = rel(fx.root, fx.wt('empty'));

  // Commands a developer or an agent writes every day. A guard that stops these is a guard people
  // switch off, which protects nothing at all — so each of these is as load-bearing as the
  // assertions above.
  const ordinary = [
    // The loop-binding regression, verbatim: 95 of 183 false positives, on a clean-your-build loop.
    'for f in ./build/*; do rm -rf $f; done',
    'for f in src/*.js; do echo "$f"; done',
    'for i in 1 2 3; do npm test; done',
    'for t in node npm git; do command -v $t && echo "  y: $t" || echo "  n: $t"; done',
    '{ echo building; npm run build; }',
    '{ echo a; echo b; } > out.log',
    'timeout 30 npm test',
    'timeout -k 5 30 npm run build',
    'timeout 5m cargo build --release',
    // `command -v X` only PRINTS a path. Skipping `-v` would read every feature-detection line in
    // every script as running the thing it is testing for.
    'command -v rg',
    'command -v jq >/dev/null 2>&1 || echo missing',
    'while read -r l; do echo "$l"; done < list.txt',
    'if [ -f package.json ]; then npm ci; fi',
    // `{` that is not a command group: expansion, parameter, and find's placeholder.
    'cp app.{js,ts} dist/',
    'echo ${HOME}',
    "awk '{print $1}' data.txt",
    "find . -name '*.log' -exec echo {} \\;",
    'grep -r "{" src/',
    // trap forms that run nothing, or run something harmless.
    'trap - EXIT',
    "trap '' EXIT",
    'trap "echo done" EXIT',
    'trap "npm run teardown" INT TERM',
    'trap "rm -rf /tmp/scratch-$$" EXIT',
    'nice -n 10 npm run build',
    'env NODE_ENV=production npm run build',
    'flock /tmp/lock.file npm test',
    // A worktree that provably holds nothing base lacks stays disposable through the same shapes.
    `rm -rf ${disposable}`,
    `{ rm -rf ${disposable} ; }`,
    `timeout 30 rm -rf ${disposable}`,
  ];

  for (const cmd of ordinary) {
    const v = await assessCommand(cmd, fx.root);
    assert.equal(v.decision, 'allow',
      `ORDINARY WORK MUST NOT BE REFUSED: ${cmd} -> ${v.decision} (${v.reason})`);
  }
});

/**
 * `find` SELECTS THE WORKTREE ITSELF — the mergify incident in its `find` spelling.
 *
 * The `-name` / `-path` filters exist so `find . -name '*.pyc' -delete` is not read as "deletes
 * everything under ." — the loudest false positive available. To stay honest for a RECURSIVE
 * remover, the filter is asked of every enclosing directory's name too, because `-exec rm -rf {} +`
 * matched on a directory takes everything beneath it.
 *
 * That ancestor walk ran over the dirty path, which is expressed RELATIVE TO THE WORKTREE ROOT — so
 * it could never reach the worktree's own directory name, which is the single component anyone
 * sweeping sibling worktrees actually matches on. Measured, against a worktree holding the only
 * copy of a symbol:
 *
 *     find <worktree> -name 'src'  -exec rm -rf {} +   ->  deny    (inside: always worked)
 *     find <parent> -name 'wt-precious' -exec rm -rf {} +  ->  ALLOW
 *     find <parent> -name 'wt-*'   -exec rm -rf {} +   ->  ALLOW
 *     find <parent> -path '*wt-p*' -exec rm -rf {} +   ->  ALLOW
 *
 * Found by an agent exercising the whole command surface, not by attacking this rule — which is why
 * it survived the repair that fixed the inside-the-worktree half and wrote a comment claiming the
 * class was closed.
 *
 * `-delete` IS DELIBERATELY NOT DENIED HERE. find's `-delete` implies `-depth` and removes
 * directories with rmdir, which fails on a non-empty one — verified with real find: `find . -name
 * 'wt-*' -delete` reports "Directory not empty" and the content survives. Refusing it would be an
 * over-refusal on a command that cannot do the damage, and the whole point of the filter is to be
 * exactly as tight as the truth allows.
 */
test('GRAMMAR: a find expression that selects the WORKTREE is not allowed to sweep it', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const wt = rel(fx.root, fx.wt('uniqueUncommitted'));
  const parent = wt.replace(/\/[^/]+$/, '');
  const name = wt.slice(parent.length + 1);
  const del = `${'r'}m -rf`;

  // ANTI-VACUITY: the plain containment case must already deny, or this fixture proves nothing.
  const control = await assessCommand(`${del} ${parent}`, fx.root);
  assert.notEqual(control.decision, 'allow',
    `PREMISE BROKEN — the parent directory must be protected: ${del} ${parent} -> ${control.decision}`);

  for (const [why, cmd] of [
    ['-name is the worktree directory itself', `find ${parent} -name '${name}' -exec ${del} {} +`],
    ['-name is a glob over the worktrees', `find ${parent} -name '${name.slice(0, 3)}*' -exec ${del} {} +`],
    ['-path selects the worktree', `find ${parent} -path '*${name.slice(0, 4)}*' -exec ${del} {} +`],
    ['-maxdepth does not exempt it', `find ${parent} -maxdepth 1 -name '${name}' -exec ${del} {} +`],
    ['the filter still works INSIDE a worktree', `find ${wt} -name 'src' -exec ${del} {} +`],
  ]) {
    const v = await assessCommand(cmd, fx.root);
    assert.notEqual(v.decision, 'allow',
      `a find sweep that selects a worktree holding the only copy must not be allowed (${why}): ${cmd}`);
  }

  // NEVER-WORSE: filters that select nothing holt protects stay silent. `find . -name '*.pyc'
  // -delete` being refused is the failure this whole filter exists to prevent.
  for (const cmd of [
    `find ${parent} -name 'node_modules' -exec ${del} {} +`,
    `find ${parent} -name '*.log' -delete`,
    `find ${parent} -name '*.pyc' -delete`,
    `find . -name '*.tmp' -exec ${del} {} +`,
    // -delete cannot remove a non-empty directory, so it is not a sweep and must not be treated as one.
    `find ${parent} -name '${name.slice(0, 3)}*' -delete`,
  ]) {
    const v = await assessCommand(cmd, fx.root);
    assert.equal(v.decision, 'allow',
      `ordinary find cleanup must stay allowed: ${cmd} -> ${v.decision} (${v.reason})`);
  }
});
