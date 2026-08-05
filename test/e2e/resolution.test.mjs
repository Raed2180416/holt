/**
 * holt — COMMAND RESOLUTION: what holt can read, and what it must admit it cannot.
 *
 * THE SIGNATURE DEFECT THIS FILE EXISTS TO PIN, in both of its directions.
 *
 * Absence of evidence reported as evidence of absence is the failure this product keeps having to
 * unlearn, and it has two halves that are equally disqualifying:
 *
 *   UNDER-PROTECTION  a target holt COULD have resolved, resolved wrongly (or not at all), and the
 *                     command was ALLOWED. Measured, on a repo whose linked worktree held the only
 *                     copy of a symbol:
 *                         git -C ../feature     reset --hard   -> deny   (control)
 *                         git -C ../feature/src reset --hard   -> ALLOW  ← destroys the only copy
 *                     `git -C` pointing at a SUBDIRECTORY of a worktree was judged against the
 *                     CALLER's worktree, because the only question asked of it was "does this path
 *                     EQUAL a workstream's path" — which a subdirectory never does.
 *
 *   OVER-REFUSAL      a target holt CAN see, refused anyway. Measured, and it blocked the fixture
 *                     setup for the investigation above:
 *                         X=/tmp/scratch; cd "$X"; rm -rf junk   -> ASK
 *                     `X` is assigned a literal in the same command. Its value is sitting right
 *                     there. A guard that interrupts work it can read is a guard that gets
 *                     switched off, which costs all of the protection, not some of it.
 *
 * Every test below carries its NEVER-WORSE twin: the anti-vacuity case that fails if the fix was
 * implemented by widening or by silencing rather than by resolving.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newRepo } from '../fixtures.mjs';
import { assessCommand, resolveCommand, parseIncomplete } from '../../src/agent.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'holt.mjs');

/**
 * A worktree path relative to the repo root, in FORWARD-SLASH space.
 *
 * Every path this file produces is interpolated into generated source — shell commands, and JS and
 * Python program text inside heredocs. `path.relative` returns NATIVE separators, so on Windows the
 * result is `..\wt\holds`, and interpolating that raw into `rmSync('..\wt\holds')` makes `\w` and
 * `\h` escape sequences: the program under test is corrupted before it is ever parsed, and the
 * assertion then passes or fails for a reason that has nothing to do with the guard.
 *
 * That is the Windows defect class this project has already shipped four times, and it is invisible
 * on Linux, where `path.sep` is already `/`. Forward slashes are accepted by git, by Node's `fs`,
 * and by the guard's own normalisation on every platform, so the conversion happens ONCE, here,
 * rather than being escaped correctly at nineteen interpolation sites and forgotten at the
 * twentieth.
 */
const rel = (from, to) => path.relative(from, to).split(path.sep).join('/');

/**
 * THROUGH THE REAL HOOK, not through assessCommand.
 *
 * The headline cases below are asserted against the binary an agent host actually executes, with a
 * host-shaped JSON payload on stdin, because that is the only path that proves the verdict survives
 * argument parsing, payload reading, adapter formatting and the exit-code contract. A test that
 * calls the library proves the library; it says nothing about whether the guard is reachable.
 */
function hookVerdict(command, cwd) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [BIN, 'hook', 'pre-tool-use', '--host', 'generic'], {
      cwd, timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1' },
    }, (err, stdout) => {
      const code = err ? (err.code ?? 1) : 0;
      let decision = code === 0 ? 'allow' : `exit${code}`;
      try { decision = JSON.parse(String(stdout)).decision ?? decision; } catch { /* keep the code */ }
      resolve({ decision, stdout: String(stdout ?? ''), code });
    });
    child.stdin.end(JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }));
  });
}

/**
 * A repo with a linked worktree holding the ONLY copy of a symbol, plus subdirectories inside it,
 * and a second, provably disposable worktree.
 */
async function resolutionFixture() {
  const fx = await newRepo('resolution');
  await fx.worktree('spent');
  const holds = await fx.worktree('holds');
  await fx.write('src/only_here.js', 'export function RESOLUTION_ONLY_SYMBOL() { return 1; }\n', holds);
  await fx.write('src/deep/deeper.js', 'export function RESOLUTION_DEEP_SYMBOL() { return 2; }\n', holds);
  return fx;
}

/* ---------------------------------------------------------------- G1: the -C subdirectory ---- */

test('G1: `git -C <subdirectory of a worktree>` is judged against the worktree that CONTAINS it', async (t) => {
  const fx = await resolutionFixture();
  t.after(() => fx.cleanup());
  const wt = rel(fx.root, fx.wt('holds'));

  // The control already worked: the path EQUALLED a workstream's path.
  const control = await hookVerdict(`git -C ${wt} reset --hard`, fx.root);
  assert.equal(control.decision, 'deny', `control must deny: ${control.stdout}`);

  // These did not, and each one destroys the only copy of a symbol.
  for (const sub of ['src', 'src/deep']) {
    const r = await hookVerdict(`git -C ${wt}/${sub} reset --hard`, fx.root);
    assert.equal(r.decision, 'deny',
      `a reset in ${sub} discards the whole worktree's uncommitted work: ${r.stdout}`);
    assert.match(r.stdout, /RESOLUTION_ONLY_SYMBOL|holds/,
      `the refusal must name what is at risk, not just refuse: ${r.stdout}`);
  }
});

test('G1 NEVER-WORSE: a subdirectory of a worktree with nothing to lose is still allowed', async (t) => {
  const fx = await resolutionFixture();
  t.after(() => fx.cleanup());
  const spent = rel(fx.root, fx.wt('spent'));

  // Resolving the CONTAINING worktree must not become "any -C path near a worktree is refused":
  // `spent` is byte-clean, so there is nothing to destroy and the honest answer is silence.
  for (const cmd of [`git -C ${spent} reset --hard`, `git -C ${spent}/src reset --hard`,
    `git -C ${spent} status`, `git -C ${spent}/src log`]) {
    const v = await assessCommand(cmd, fx.root);
    assert.equal(v.decision, 'allow', `${cmd} destroys nothing: ${v.reason}`);
  }
});

test('G1: repeated `git -C` are applied cumulatively, as git applies them', async (t) => {
  const fx = await resolutionFixture();
  t.after(() => fx.cleanup());

  // git-config(1): each `-C` is relative to the previous one, so the LAST one is where the command
  // runs. Reading only the first placed the verb in a directory git never enters — here /tmp, which
  // is not a repository, so the answer was an unactionable "could not verify" about the wrong tree.
  const v = await assessCommand(`git -C ${path.resolve('/tmp')} -C ${fx.wt('holds')} reset --hard`, fx.root);
  assert.equal(v.decision, 'deny', `the LAST -C is where this runs: ${v.reason}`);

  // NEVER-WORSE, the mirror: a second `-C` that walks back OUT to the clean main tree must not
  // inherit the first one's verdict.
  const out = await assessCommand(`git -C ${fx.wt('holds')} -C ${fx.root} reset --hard`, fx.root);
  assert.equal(out.decision, 'allow', `the reset runs in the clean root: ${out.reason}`);
});

test('G1: `cd` into a subdirectory of a worktree resolves the same containing worktree', async (t) => {
  const fx = await resolutionFixture();
  t.after(() => fx.cleanup());
  const wt = rel(fx.root, fx.wt('holds'));

  // The same containment question, reached through `cd` rather than `-C`. One model, both spellings.
  const v = await assessCommand(`cd ${wt}/src/deep && git clean -fd`, fx.root);
  assert.equal(v.decision, 'deny', `a clean run inside the worktree acts on all of it: ${v.reason}`);
});

/* ------------------------------------------------------- the cwd active AT EACH MATCH ---- */

test('COMPOUND: each destructive match is judged in the directory active AT THAT MATCH', async (t) => {
  const fx = await resolutionFixture();
  t.after(() => fx.cleanup());
  const wt = rel(fx.root, fx.wt('holds'));

  // ONE cwd for the whole command meant the LAST `cd` decided where every verb was judged. Here the
  // reset runs in the worktree and the command then walks away to /tmp; the old model assessed the
  // reset against /tmp, found no repository there, and asked about a command that destroys work.
  const v = await assessCommand(`cd ${wt} && git reset --hard && cd ${path.resolve('/tmp')}`, fx.root);
  assert.equal(v.decision, 'deny', `the reset runs in the worktree, not where the command ends: ${v.reason}`);
  assert.match(v.reason, /RESOLUTION_ONLY_SYMBOL|holds/, `and it must name what is lost: ${v.reason}`);
});

test('SUBSHELL: a `cd` inside `( … )` moves the verbs inside it', async (t) => {
  const fx = await resolutionFixture();
  t.after(() => fx.cleanup());
  const wt = rel(fx.root, fx.wt('holds'));

  // FOUND IN THE ATTACK PHASE. `(` and `)` were ordinary path characters to the tokenizer, so
  // `( cd <wt> && git reset --hard )` produced the word `(cd` — the cd was never recognised as one,
  // the reset was judged in the caller's clean tree, and the command was ALLOWED while it discarded
  // the only copy of a symbol. A subshell is a command list; its parens bound it.
  const v = await assessCommand(`( cd ${wt} && git reset --hard )`, fx.root);
  assert.equal(v.decision, 'deny', `a subshell still runs the reset in the worktree: ${v.reason}`);

  // The same gluing truncated a target written against the closing paren, which is the silent-allow
  // half of the identical defect: `../holds)` matches no worktree at all.
  const glued = await assessCommand(`(rm -rf ${wt})`, fx.root);
  assert.equal(glued.decision, 'deny', `the target is the path, not the path plus a paren: ${glued.reason}`);
});

test('SUBSHELL NEVER-WORSE: a bracket inside a QUOTED path is still part of the path', async (t) => {
  const fx = await resolutionFixture();
  t.after(() => fx.cleanup());

  // Splitting on parens must not reach a path that legitimately contains one — a quoted paren is
  // consumed as part of the word long before the separator logic sees it.
  for (const cmd of ['rm -rf "build (old)"', "rm -rf 'dist (copy)'", 'echo "a (b) c"']) {
    const v = await assessCommand(cmd, fx.root);
    assert.equal(v.decision, 'allow', `${cmd} names ordinary build output: ${v.reason}`);
  }
});

test('COMPOUND NEVER-WORSE: a `cd` AFTER a verb never moves that verb', async (t) => {
  const fx = await resolutionFixture();
  t.after(() => fx.cleanup());
  const wt = rel(fx.root, fx.wt('holds'));

  // The mirror image, and the one that would turn the fix into an over-refusal: a delete of build
  // output in the ROOT, followed by a `cd` into the worktree, must not inherit the later cd.
  const v = await assessCommand(`rm -rf ./build && cd ${wt}`, fx.root);
  assert.equal(v.decision, 'allow', `the rm runs before the cd: ${v.reason}`);
});

/* ------------------------------------------------------ a variable holt can actually read ---- */

test('OVER-REFUSAL: a `cd` through a variable assigned a literal in the same command resolves', async (t) => {
  const fx = await resolutionFixture();
  t.after(() => fx.cleanup());

  // Through the real hook: this exact command was ASKED about while it was being used to build a
  // fixture. Nothing here is ambiguous — the value is in the string holt was handed.
  const r = await hookVerdict('X=/tmp/scratch; cd "$X"; rm -rf junk', fx.root);
  assert.equal(r.decision, 'allow', `a resolvable cd is not an ambiguous one: ${r.stdout}`);
});

test('OVER-REFUSAL NEVER-WORSE: resolving the variable FEEDS the check, it does not silence it', async (t) => {
  const fx = await resolutionFixture();
  t.after(() => fx.cleanup());

  // THE BYPASS THIS FIX COULD HAVE BEEN. If `cd "$X"` merely stopped being reported as ambiguous,
  // every destructive command behind one would become a silent ALLOW. So the resolved value has to
  // be USED: pointed at the worktree holding the only copy, the same shape must deny.
  const into = await assessCommand(`X=${fx.wt('holds')}; cd "$X"; rm -rf src`, fx.root);
  assert.equal(into.decision, 'deny', `the resolved directory must be the one judged: ${into.reason}`);
  assert.match(into.reason, /RESOLUTION_ONLY_SYMBOL|only_here/, `naming the loss: ${into.reason}`);

  // And a variable with NO known value is still unresolvable — this narrows, it does not weaken.
  const unknown = await assessCommand('cd "$NOT_SET_ANYWHERE"; rm -rf junk', fx.root);
  assert.equal(unknown.decision, 'ask', `an unknown cd target is still an ask: ${unknown.reason}`);

  // `cd -` is the shell's own OLDPWD. No pre-execution reader can know it, and pretending otherwise
  // is exactly the fabrication this whole file is against.
  const back = resolveCommand('cd - && git reset --hard');
  assert.ok(back.unresolved.some((u) => /working-directory|directory/i.test(u)),
    `cd - must stay unresolved: ${JSON.stringify(back.unresolved)}`);
});

/* ------------------------------------------------ a literal dollar is not an expansion ---- */

test('LITERAL $: single-quoted and backslash-escaped dollars are filenames, not unknowns', async (t) => {
  const fx = await resolutionFixture();
  t.after(() => fx.cleanup());

  // POSIX: inside single quotes, and after a backslash, `$` is an ordinary character. `rm -rf '$WT'`
  // deletes a file named `$WT`. Reading those as unresolvable expansions asked about a path holt
  // could see perfectly well.
  for (const cmd of ["rm -rf '$WT'", 'rm -rf \\$WT', "rm -rf 'literal$dir/x'"]) {
    const v = await assessCommand(cmd, fx.root);
    assert.equal(v.decision, 'allow', `${cmd} names a literal path: ${v.reason}`);
  }

  // ANTI-VACUITY: the same name UNQUOTED is a live expansion and stays an ask. If this passes too,
  // the fix was "stop asking about dollars" rather than "read the quoting".
  const live = await assessCommand('rm -rf $WT', fx.root);
  assert.equal(live.decision, 'ask', `a live expansion is still unknown: ${live.reason}`);
  const quoted = await assessCommand('rm -rf "$WT"', fx.root);
  assert.equal(quoted.decision, 'ask', `double quotes still expand: ${quoted.reason}`);

  // AND AT WORKTREE GRANULARITY, WHICH IS WHERE THE QUOTING IS READ OFF THE REGEX MATCH. `rm` is
  // seen by BOTH layers, and the file layer reads liveness from the tokenizer — so an `rm` test
  // alone still passes if the worktree layer's half is broken. `git worktree remove` has no file
  // layer at all, so it is the only shape that pins that half on its own.
  const wtLive = await assessCommand("git worktree remove '$WT'", fx.root);
  assert.equal(wtLive.decision, 'allow', `a single-quoted target is a literal path: ${wtLive.reason}`);
  for (const cmd of ['git worktree remove $WT', 'git worktree remove "$WT"', 'git worktree unlock $WT']) {
    const v = await assessCommand(cmd, fx.root);
    assert.equal(v.decision, 'ask', `${cmd} names a worktree holt cannot see: ${v.reason}`);
  }
});

/* --------------------------------------------- the variables holt genuinely knows ---- */

test('KNOWN VARS: $PWD and $HOME are substituted, and the target is then judged for real', async (t) => {
  const fx = await resolutionFixture();
  t.after(() => fx.cleanup());
  const wt = rel(fx.root, fx.wt('holds'));

  // `$PWD` is, by definition, the directory the segment runs in. Treating it as opaque meant an
  // entirely ordinary way of naming a worktree came back `ask`, naming no file, while the identical
  // absolute path was denied with evidence.
  const v = await assessCommand(`rm -rf $PWD/${wt}`, fx.root);
  assert.equal(v.decision, 'deny', `$PWD is not an unknown: ${v.reason}`);
  assert.match(v.reason, /RESOLUTION_ONLY_SYMBOL|holds/, `and the evidence must survive it: ${v.reason}`);

  // $HOME likewise: substituted, so the resulting path is resolved rather than reported as opaque.
  assert.deepEqual(resolveCommand('rm -rf $HOME/definitely-not-a-worktree-here').unresolved, [],
    'a known variable is not an unresolved one');

  // ANTI-VACUITY: a variable holt does NOT know stays unresolved. Substituting the two it knows
  // must not become substituting nothing and shrugging.
  assert.ok(resolveCommand('rm -rf $WORKTREE').unresolved.some((u) => /WORKTREE/.test(u)),
    'an unknown variable must still be named');
});

test('KNOWN VARS: a same-command literal assignment is resolved and then JUDGED', async (t) => {
  const fx = await resolutionFixture();
  t.after(() => fx.cleanup());
  const wt = rel(fx.root, fx.wt('holds'));
  const v = await assessCommand(`WT=${wt}; rm -rf $WT`, fx.root);
  assert.equal(v.decision, 'deny', `an assigned literal resolves to the worktree it names: ${v.reason}`);
});

test('KNOWN VARS: later assignments may compose an earlier proven literal', async (t) => {
  const fx = await resolutionFixture();
  t.after(() => fx.cleanup());
  const holds = fx.wt('holds');
  const parent = path.dirname(holds);
  const leaf = path.basename(holds);

  const command = 'WT_ROOT=' + parent + '; TARGET="$WT_ROOT/' + leaf
    + '"; git worktree remove "$TARGET"';
  const resolved = resolveCommand(command);
  assert.deepEqual(resolved.unresolved, [],
    'a left-to-right literal assignment chain is fully readable: ' + JSON.stringify(resolved));
  const v = await assessCommand(command, fx.root);
  assert.equal(v.decision, 'deny',
    'the composed target must be judged against the worktree it actually names: ' + v.reason);
  assert.match(v.reason, /RESOLUTION_ONLY_SYMBOL|holds/);

  const unknown = resolveCommand('ROOT=$NOT_KNOWN; TARGET="$ROOT/holds"; git worktree remove "$TARGET"');
  assert.ok(unknown.unresolved.some((u) => /NOT_KNOWN|ROOT|TARGET/.test(u)),
    'composition must substitute only values already proven literal, never unknown input');
});

/* ------------------------------------------------------- a bounded glob is not an unknown ---- */

test('BOUNDED GLOB: `$BUILD_DIR/*` stays on the never-worse ALLOW path', async (t) => {
  const fx = await resolutionFixture();
  t.after(() => fx.cleanup());

  // Whatever `$BUILD_DIR` turns out to be, the `*` selects entries INSIDE one directory — it cannot
  // name a worktree ROOT. That is the shape of every ordinary build-output wipe there is, and
  // asking about it is friction with nothing behind it.
  for (const cmd of ['rm -rf $BUILD_DIR/*', 'rm -rf "$BUILD_DIR"/*', 'rm -rf $OUT/dist/*']) {
    const v = await assessCommand(cmd, fx.root);
    assert.equal(v.decision, 'allow', `${cmd} is bounded below a directory: ${v.reason}`);
  }

  // ANTI-VACUITY: drop the glob and the same variable is an unbounded unknown again — it could be
  // an absolute worktree path — so the verdict goes back to ask.
  const unbounded = await assessCommand('rm -rf $BUILD_DIR', fx.root);
  assert.equal(unbounded.decision, 'ask', `an unglobbed unknown is still unknown: ${unbounded.reason}`);
});

/* ------------------------------------------------------------------ unread is not harmless ---- */

test('UNTERMINATED: a command that ends inside a quote or heredoc is ASKED about, never allowed', async (t) => {
  const fx = await resolutionFixture();
  t.after(() => fx.cleanup());
  const wt = rel(fx.root, fx.wt('holds'));

  // An unterminated quote masked to the END of the string, so "no verb matched" meant "holt stopped
  // parsing", and that was reported as allow.
  for (const cmd of [`echo "oops ; rm -rf ${wt}`, `echo 'oops ; rm -rf ${wt}`,
    `cat <<EOF\nrm -rf ${wt}\n`]) {
    assert.ok(parseIncomplete(cmd), `must be detected as unparsed: ${JSON.stringify(cmd)}`);
    const v = await assessCommand(cmd, fx.root);
    assert.equal(v.decision, 'ask', `unread is not harmless: ${JSON.stringify(cmd)} -> ${v.reason}`);
  }
});

test('UNTERMINATED NEVER-WORSE: closed quoting is ordinary, and a readable destroyer still DENIES', async (t) => {
  const fx = await resolutionFixture();
  t.after(() => fx.cleanup());
  const wt = rel(fx.root, fx.wt('holds'));

  for (const cmd of ['echo "all fine here"', "echo 'quoted rm -rf x'", 'git commit -m "wip"',
    `cat <<EOF > notes.md\njust prose\nEOF`]) {
    assert.equal(parseIncomplete(cmd), false, `properly closed: ${JSON.stringify(cmd)}`);
    const v = await assessCommand(cmd, fx.root);
    assert.equal(v.decision, 'allow', `${JSON.stringify(cmd)} is ordinary: ${v.reason}`);
  }

  // The ask must be a FLOOR under the silent allow, never a ceiling over a real deny: a destroyer
  // holt CAN read, in a command that later runs away into an unterminated quote, still denies.
  const v = await assessCommand(`rm -rf ${wt} && echo "unterminated`, fx.root);
  assert.equal(v.decision, 'deny', `a readable destroyer is not softened by later junk: ${v.reason}`);
});

/* ------------------------------------------------------------------ a heredoc body is prose ---- */

test('HEREDOC: the BODY is a document, so a path inside it is not a deletion target', async (t) => {
  const fx = await resolutionFixture();
  t.after(() => fx.cleanup());
  const wt = rel(fx.root, fx.wt('holds'));

  // The verb layer already masked heredocs; the TOKENIZER did not, so the file layer read the body
  // as commands. Writing documentation about a delete was refused as the delete.
  const v = await assessCommand(`cat <<'EOF' > runbook.md\nrm -rf ${wt}/src/only_here.js\nEOF`, fx.root);
  assert.equal(v.decision, 'allow', `prose about a command is not the command: ${v.reason}`);
});

test('HEREDOC NEVER-WORSE: a real destroyer after the terminator is still seen', async (t) => {
  const fx = await resolutionFixture();
  t.after(() => fx.cleanup());
  const wt = rel(fx.root, fx.wt('holds'));

  // Skipping the body must not swallow what follows it — that would turn a false positive into a
  // silent allow, which is the trade this project must never make.
  const v = await assessCommand(`cat <<'EOF' > runbook.md\njust prose\nEOF\nrm -rf ${wt}`, fx.root);
  assert.equal(v.decision, 'deny', `the command after the heredoc is real: ${v.reason}`);

  // AND at FILE granularity, which is the half only the tokenizer can see. The worktree layer
  // recognises `rm -rf <a worktree root>` straight off the raw string, so it would still deny the
  // case above even if the tokenizer dropped the command entirely — a single file INSIDE the
  // worktree is invisible to that layer by design, so this is what actually pins the segment
  // boundary at the heredoc terminator.
  const file = await assessCommand(
    `cat <<'EOF' > runbook.md\njust prose\nEOF\nrm -rf ${wt}/src/only_here.js`, fx.root);
  assert.equal(file.decision, 'deny', `the file layer must still see the command: ${file.reason}`);
  assert.match(file.reason, /only_here/, `naming the file: ${file.reason}`);
});

/* ------------------------------------------------- a heredoc body is prose only if it is READ ---- */

test('HEREDOC CONSUMER: a body fed to a shell is CODE, and destroying a worktree in one denies', async (t) => {
  const fx = await resolutionFixture();
  t.after(() => fx.cleanup());
  const wt = rel(fx.root, fx.wt('holds'));

  // "A heredoc body is prose" is true of `cat > file <<EOF` and FALSE of every line below. Each of
  // these was verified in a real shell to delete the target, and each was ALLOWED with an empty
  // evidence list — the guard handing its own blindfold to the attacker, because the one thing that
  // tells a document from a script (the CONSUMER) was never consulted.
  for (const cmd of [
    `. /dev/stdin <<'EOF'\nrm -rf ${wt}\nEOF`,
    `source /dev/stdin <<'EOF'\nrm -rf ${wt}\nEOF`,
    `bash /dev/stdin <<'EOF'\nrm -rf ${wt}\nEOF`,
    `bash <<'EOF'\nrm -rf ${wt}\nEOF`,
    `bash -s <<EOF\nrm -rf ${wt}\nEOF`,
    `cat <<'EOF' | bash\nrm -rf ${wt}\nEOF`,
    `sh <<'X'\nrm -rf ..\nX`,
    // SHORT OPTIONS BUNDLE, and `-euo pipefail` is how every hardened script opens. Reading
    // `pipefail` as the shell's script operand made the body a document again — the same silent
    // allow one layer down, found by attacking this rule rather than by assuming it held.
    `bash -euo pipefail <<'EOF'\nrm -rf ${wt}\nEOF`,
    `bash -O extglob <<'EOF'\nrm -rf ${wt}\nEOF`,
    `sh -s -- arg <<'EOF'\nrm -rf ${wt}\nEOF`,
  ]) {
    const r = await hookVerdict(cmd, fx.root);
    assert.equal(r.decision, 'deny', `an executed heredoc is code: ${JSON.stringify(cmd)} -> ${r.stdout}`);
  }

  // AT FILE GRANULARITY TOO, which is the half the worktree layer cannot see: the only copy of a
  // symbol, named, inside a body that a shell is about to run.
  const file = await hookVerdict(`. /dev/stdin <<'EOF'\nrm -rf ${wt}/src/only_here.js\nEOF`, fx.root);
  assert.equal(file.decision, 'deny', `the file layer must read an executed body: ${file.stdout}`);
  assert.match(file.stdout, /only_here|RESOLUTION_ONLY_SYMBOL/, `naming what is at risk: ${file.stdout}`);

  // AND THE WORKTREE-ONLY VERBS, which never reach the file layer at all — so this is what proves
  // the classification is honoured by the VERB layer (maskedRegions) and not just by the tokenizer.
  for (const verb of ['git -C ' + wt + ' reset --hard', 'git worktree remove -f ' + wt,
    'git -C ' + wt + ' clean -fdx']) {
    const r = await hookVerdict(`. /dev/stdin <<'EOF'\n${verb}\nEOF`, fx.root);
    assert.equal(r.decision, 'deny', `${verb} inside an executed heredoc: ${r.stdout}`);
  }
});

test('HEREDOC CONSUMER NEVER-WORSE: a body a WRITER receives is still prose, and a benign script is allowed', async (t) => {
  const fx = await resolutionFixture();
  t.after(() => fx.cleanup());
  const wt = rel(fx.root, fx.wt('holds'));

  // The false positive this classification must not reintroduce. A document ABOUT a destroyer is
  // still a document, and refusing it is what gets a guard switched off.
  for (const cmd of [
    `cat <<'EOF' > runbook.md\nrm -rf ${wt}\nEOF`,
    `cat > runbook.md <<'EOF'\nrm -rf ${wt}/src/only_here.js\nEOF`,
    `tee runbook.md <<'EOF'\ngit worktree remove -f ${wt}\nEOF`,
    // The shell is running a SCRIPT SOMEBODY WROTE; the heredoc is that script's stdin, not its
    // text. Reading it as the program would refuse an ordinary invocation.
    `bash tools/release.sh <<'EOF'\nrm -rf ${wt}\nEOF`,
    // `-c` carries the program in argv, so the body is again just input.
    `bash -c 'wc -l' <<'EOF'\nrm -rf ${wt}\nEOF`,
    // …and the option table must not eat the script operand either, in the other direction.
    `bash -euo pipefail tools/release.sh <<'EOF'\nrm -rf ${wt}\nEOF`,
  ]) {
    const r = await hookVerdict(cmd, fx.root);
    assert.equal(r.decision, 'allow', `prose is not a command: ${JSON.stringify(cmd)} -> ${r.stdout}`);
  }

  // AND THE OVER-REFUSAL HALF OF THE SAME RULE. holt has READ this body, so reporting that it
  // "cannot see" the shell's input is the signature defect: absence of evidence sold as evidence
  // of absence, about text sitting in the very string under inspection.
  for (const cmd of [`bash <<'EOF'\necho building\nrm -rf ./build\nEOF`,
    `cat <<'EOF' | sh\ngit status\nEOF`]) {
    const r = await hookVerdict(cmd, fx.root);
    assert.equal(r.decision, 'allow', `a readable benign script is ordinary work: ${JSON.stringify(cmd)} -> ${r.stdout}`);
  }

  // ANTI-VACUITY: input holt genuinely CANNOT read is still unknown, and unknown is still ask.
  const piped = await assessCommand('echo cm0gLXJm | base64 -d | sh', fx.root);
  assert.equal(piped.decision, 'ask', `assembled code stays unknown: ${piped.reason}`);
});

test('HEREDOC CONSUMER: an INTERPRETER body is a program, read exactly as `node -e` is', async (t) => {
  const fx = await resolutionFixture();
  t.after(() => fx.cleanup());
  const wt = rel(fx.root, fx.wt('holds'));
  const file = `${wt}/src/only_here.js`;

  // The same class one punctuation mark over. `node -e "<code>"` was read and `node <<'X' … X` was
  // not, and the second deletes just as thoroughly — allowed with an empty target list on the base.
  for (const cmd of [
    `node <<'X'\nrequire('fs').rmSync('${wt}', {recursive:true, force:true})\nX`,
    `node <<X\nrequire('fs').rmSync('${wt}', {recursive:true, force:true})\nX`,
    `python3 <<'X'\nimport shutil; shutil.rmtree('${wt}')\nX`,
    `perl <<'X'\nunlink('${file}');\nX`,
    `cat <<'X' | node\nrequire('fs').rmSync('${wt}', {recursive:true, force:true})\nX`,
    `node /dev/stdin <<'X'\nrequire('fs').rmSync('${wt}', {recursive:true, force:true})\nX`,
  ]) {
    const r = await hookVerdict(cmd, fx.root);
    assert.equal(r.decision, 'deny', `an interpreter body is a program: ${JSON.stringify(cmd)} -> ${r.stdout}`);
  }

  // NEVER-WORSE, and this is why the body is NOT unmasked for the shell tables: Python is not
  // shell, and matching shell verbs against it manufactures false positives. `rm -rf` written into
  // a python heredoc is a SyntaxError, not a deletion, and refusing it is refusing nothing.
  for (const cmd of [
    `node <<'X'\nconsole.log('hello world')\nX`,
    `python3 <<'X'\nprint('hello')\nX`,
    `python3 <<'X'\nimport shutil; shutil.rmtree('./build')\nX`,
    `python3 <<'X'\nrm -rf ${wt}\nX`,
    // `-e` carries the program, and a script operand names one: the body is that program's INPUT.
    `node -e "console.log(1)" <<'X'\nrequire('fs').rmSync('${wt}', {recursive:true, force:true})\nX`,
    `node app.js <<'X'\nrequire('fs').rmSync('${wt}', {recursive:true, force:true})\nX`,
    `cat <<'X' > notes.md\nrequire('fs').rmSync('${wt}', {recursive:true, force:true})\nX`,
    // The `shell` proxy must still not read a cwd option as a deletion target.
    `node <<'X'\nexecSync('git log', {cwd: '/tmp'})\nX`,
  ]) {
    const r = await hookVerdict(cmd, fx.root);
    assert.equal(r.decision, 'allow', `ordinary work must not be refused: ${JSON.stringify(cmd)} -> ${r.stdout}`);
  }
});

/* --------------------------------------------- one backslash rule, both readers of the command ---- */

test('ESCAPED QUOTE: `\\\'` is a literal apostrophe to the MASK SCANNER, not the start of a region', async (t) => {
  const fx = await resolutionFixture();
  t.after(() => fx.cleanup());
  const wt = rel(fx.root, fx.wt('holds'));

  // OVER-REFUSAL. `'…'\''…'` is THE POSIX idiom for an apostrophe inside a single-quoted string and
  // `don\'t` is what bash's own `printf '%q'` emits. Reading the escaped quote as an OPENING quote
  // made every one of these "unparseable" and asked about ordinary work.
  for (const cmd of [
    String.raw`git commit -m 'don'\''t ship'`,
    String.raw`sed -i 's/it'\''s/its/' README.md`,
    String.raw`git commit -m don\'t\ ship`,
    String.raw`echo don\'t`,
    String.raw`echo \"hello\"`,
    String.raw`git log --pretty=format:\"%h %s\" -n 5`,
    String.raw`grep -rn can\'t src/`,
    String.raw`jq -r .items[].name < data.json && echo it\'s done`,
  ]) {
    assert.equal(parseIncomplete(cmd), false, `valid shell must parse: ${JSON.stringify(cmd)}`);
    const r = await hookVerdict(cmd, fx.root);
    assert.equal(r.decision, 'allow', `ORDINARY WORK MUST NOT BE REFUSED: ${JSON.stringify(cmd)} -> ${r.stdout}`);
  }

  // UNDER-REFUSAL, the same blindness in the other direction: an EVEN number of escaped quotes
  // closes the bogus region again, so everything between two of them was MASKED. The worktree-layer
  // verbs — the ones with no file-layer twin — were lost outright, which is what makes this the
  // proof that the two readers had drifted apart rather than a cosmetic parse difference.
  for (const cmd of [
    String.raw`echo don\'t ; git -C ${wt} reset --hard ; echo won\'t`,
    String.raw`git commit -m don\'t && git worktree remove -f ${wt} && echo it\'s done`,
    String.raw`echo don\'t; git -C ${wt} clean -fdx; echo won\'t`,
    String.raw`echo don\'t; cd ${wt} && git reset --hard; echo won\'t`,
    String.raw`echo don\'t; git -C ${wt} checkout -- .; echo won\'t`,
    String.raw`echo don\'t; rm -rf ${wt}; echo won\'t`,
  ]) {
    const r = await hookVerdict(cmd, fx.root);
    assert.equal(r.decision, 'deny', `a masked destroyer is still a destroyer: ${JSON.stringify(cmd)} -> ${r.stdout}`);
  }

  // NEVER-WORSE: a REAL quote still masks. `\` did not become a no-op — a destroyer genuinely
  // written inside quotes is still a mention, and a genuinely unterminated quote is still unread.
  const quoted = await assessCommand(`echo 'rm -rf ${wt}'`, fx.root);
  assert.equal(quoted.decision, 'allow', `a quoted mention is text: ${quoted.reason}`);
  assert.equal(parseIncomplete(`echo "oops ; rm -rf ${wt}`), true, 'a runaway quote is still unread');
});

/* -------------------------------------------------------------- a comment after `(` ---- */

test('COMMENT: `#` straight after `(` is a comment, and its apostrophe masks nothing', async (t) => {
  const fx = await resolutionFixture();
  t.after(() => fx.cleanup());
  const wt = rel(fx.root, fx.wt('holds'));

  // `(` opens a subshell, so `#` after it starts a comment exactly as it does after a space. Until
  // it counted as a word boundary, the apostrophe in "agent's" opened a quote region that ran to
  // the end of the command and hid the destroyer on the next line.
  const v = await assessCommand(`(# tidy the agent's worktrees\nrm -rf ${wt}\n)`, fx.root);
  assert.equal(v.decision, 'deny', `the comment ends at the newline: ${v.reason}`);

  // NEVER-WORSE: the comment itself is still data. A destroyer written INSIDE one is a mention.
  const mention = await assessCommand(`(# note: rm -rf ${wt}\ngit status\n)`, fx.root);
  assert.equal(mention.decision, 'allow', `a comment is not executable: ${mention.reason}`);
});

/* ---------------------------------------------------------- overlapping matches ---- */

test('MATCHES: overlapping rules are deduplicated, and the list is in SOURCE order', () => {
  // `remove -f -f` is matched by the specific override rule AND by the generic remove rule. The
  // table is ordered most-specific-first precisely so the override wins; reporting both assessed
  // the same span twice and left the blunter label in the list.
  const dup = resolveCommand('git worktree remove -f -f ../wt-a').matches;
  assert.equal(dup.length, 1, `one span, one match: ${JSON.stringify(dup.map((m) => m.kind))}`);
  assert.match(dup[0].kind, /--force --force|override/, 'the more specific rule owns the span');

  // Order used to follow the RULE TABLE, so a command was described by whichever verb happened to
  // sit higher in it. With the working directory now resolved per match, positions are load-bearing.
  const both = resolveCommand('rm -rf ../wt-a && git worktree unlock ../wt-b').matches;
  assert.deepEqual(both.map((m) => m.kind),
    ['rm of a worktree path', 'git worktree unlock (disarms protection)'],
    `source order, not table order: ${JSON.stringify(both.map((m) => m.kind))}`);
  assert.ok(both[0].index < both[1].index, 'indices must be ascending');
});

/* ------------------------------------------------------------------ the whole corpus ---- */

test('CORPUS: every ordinary command is still allowed, and every incident spelling still denies', async (t) => {
  const fx = await resolutionFixture();
  t.after(() => fx.cleanup());
  const holds = rel(fx.root, fx.wt('holds'));
  const parent = rel(fx.root, path.dirname(fx.wt('holds')));   // the dir holding the worktrees

  const ordinary = [
    'rm -rf /tmp/x',
    'rm -rf ./build',
    'rm -rf $BUILD_DIR/*',
    'git status',
    'git worktree list',
    'git -C ../sibling log',
    'for f in ./build/*; do rm -rf $f; done',
    // JSON.stringify, not `'${…}'`: a native `C:\\Users\\x` pasted raw into generated source turns
    // `\\U` and `\\x` into escape sequences and the program under test is corrupt before it parses.
    `node -e "execSync('git log',{cwd:${JSON.stringify(fx.root)}})"`,
    'X=/tmp/scratch; cd "$X"; rm -rf junk',
    'cd /tmp && rm -rf /tmp/nothing',
    'git commit',
    'mv src/a.js src/b.js',
  ];
  for (const cmd of ordinary) {
    const v = await assessCommand(cmd, fx.root);
    assert.equal(v.decision, 'allow', `ORDINARY WORK MUST NOT BE REFUSED: ${cmd} -> ${v.reason}`);
  }

  const incident = [
    `rm -rf ${holds}`,
    `rm -rf ${parent}/*`,
    `rm -rf ${parent}`,
    `for d in ${parent}/*; do rm -rf $d; done`,
    `git worktree remove -f ${parent}/*`,
    `for d in ${parent}/*; do git worktree remove -f $d; done`,
  ];
  for (const cmd of incident) {
    const v = await assessCommand(cmd, fx.root);
    assert.equal(v.decision, 'deny', `THE INCIDENT MUST STILL BE REFUSED: ${cmd} -> ${v.reason}`);
  }
});
