/**
 * holt — TARGET RESOLUTION, END TO END, THROUGH THE REAL HOOK.
 *
 * ONE CLASS, SEEN FOUR TIMES: holt resolved the wrong target, or no target, and called that an
 * answer. Every one of these was measured as an ALLOW on a fixture where the target held the only
 * copy of its content, against a control spelling of the SAME destruction that was denied:
 *
 *     rm -rf ../wt/app                       deny        rm '../wt/app/[id].tsx'          ALLOW
 *     rm -rf ../wt/plain.tsx                 deny        rm -rf '../wt/x[z-a]'            exit 1
 *     bash -c  "rm -rf ../wt"                deny        bash -lc "rm -rf ../wt"          ALLOW
 *     git -C ../wt checkout -- .             deny        git --work-tree=../wt checkout -- .  ALLOW
 *     git checkout -- notes.md               deny        git checkout notes.md            ALLOW
 *
 * The shared fault: the target was decided by matching the raw text against a list of spellings —
 * of glob characters, of option words, of git globals — rather than by parsing the command the way
 * the shell and git parse it. A list is why `bash -lc` got through.
 *
 * The exit code matters as much as the verdict. In the Claude Code PreToolUse contract only exit 2
 * blocks; exit 1 is a non-blocking error and THE TOOL CALL PROCEEDS. So a crash in the analyser is
 * an allow, and the bracket cases below assert `code !== 1` as well as the decision.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newRepo, creatableNames } from '../fixtures.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'holt.mjs');
const rel = (from, to) => path.relative(from, to).split(path.sep).join('/');

/** THROUGH THE BINARY AN AGENT HOST ACTUALLY EXECUTES, with a host-shaped payload on stdin. */
function hookVerdict(command, cwd) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [BIN, 'hook', 'pre-tool-use', '--host', 'generic'], {
      cwd, timeout: 60_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1' },
    }, (err, stdout, stderr) => {
      const code = err ? (err.code ?? 1) : 0;
      let decision = code === 0 ? 'allow' : `exit${code}`;
      try { decision = JSON.parse(String(stdout)).decision ?? decision; } catch { /* keep the code */ }
      resolve({ decision, code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
    child.stdin.end(JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }));
  });
}

/**
 * A repo with a linked worktree holding three at-risk files whose names exercise the class:
 * a plain one (the control), a dynamic-route file whose name CONTAINS a bracket expression, and a
 * file whose name is an INVALID bracket expression.
 */
async function fixture() {
  const fx = await newRepo('targetres');
  const holds = await fx.worktree('holds');
  await fx.write('app/plain.tsx', 'export function TARGETRES_PLAIN() { return 1; }\n', holds);
  await fx.write('app/[id].tsx', 'export function TARGETRES_ROUTE() { return 2; }\n', holds);
  await fx.write('notes.md', 'TARGETRES_NOTES only copy\n', holds);
  // `[` and `]` are legal in a filename on every platform holt supports; `creatableNames` is the
  // project's own guard for the ones that are not, and is used here so a hostile name can never
  // fail the test for a reason that is about the filesystem rather than the guard.
  return fx;
}

/* ------------------------------------------------------------ [B] the bracket, both halves ---- */

test('[B] SILENT: a QUOTED bracket filename is one exact file, not a character class', async (t) => {
  const fx = await fixture();
  t.after(() => fx.cleanup());
  const wt = rel(fx.root, fx.wt('holds'));

  const control = await hookVerdict(`rm -rf ${wt}/app`, fx.root);
  assert.equal(control.decision, 'deny', `control: the directory must deny: ${control.stdout}`);

  // Every spelling of "exactly that file". Each one deletes the only copy of TARGETRES_ROUTE.
  for (const cmd of [
    `rm '${wt}/app/[id].tsx'`,
    `rm "${wt}/app/[id].tsx"`,
    `rm ${wt}/app/\\[id\\].tsx`,
    `rm ${wt}/app/[id].tsx`,        // unquoted: nothing on disk matches, so the shell passes it through
  ]) {
    const r = await hookVerdict(cmd, fx.root);
    assert.equal(r.decision, 'deny', `${cmd} deletes the only copy: ${r.stdout}${r.stderr}`);
    assert.notEqual(r.code, 1, `${cmd} must not CRASH the guard (exit 1 = the command runs)`);
  }
});

test('[B] LOUD: an invalid bracket expression is a filename, not a SyntaxError out of the guard', async (t) => {
  const fx = await fixture();
  t.after(() => fx.cleanup());
  const holds = fx.wt('holds');
  const wt = rel(fx.root, holds);
  const name = creatableNames(['x[z-a]'])[0];
  if (!name) return t.skip('this filesystem forbids the name');
  await fx.write(name, 'TARGETRES_WEIRD only copy\n', holds);

  for (const cmd of [`rm -rf '${wt}/${name}'`, `rm -rf ${wt}/${name}`, `rm -rf '${name}' ${wt}`]) {
    const r = await hookVerdict(cmd, fx.root);
    assert.notEqual(r.code, 1,
      `exit 1 is a NON-BLOCKING error: the command would run. ${cmd}: ${r.stderr}`);
    assert.equal(r.decision, 'deny', `${cmd}: ${r.stdout}${r.stderr}`);
  }
});

test('[B] NEVER-WORSE: ordinary build-output globs are still silent', async (t) => {
  const fx = await fixture();
  t.after(() => fx.cleanup());
  // If the bracket fix were implemented by treating every glob as a literal, or by widening the
  // matcher, these would start interrupting — which is the failure that gets a guard switched off.
  for (const cmd of [
    'rm -rf node_modules', 'rm -rf dist', 'rm -rf dist/*', 'rm -rf build/[0-9]*',
    "rm -rf 'coverage/[!a-z]*'", 'rm -rf .next/cache', 'rm -f *.log',
    'ls src/[ab]*.js', 'grep -rn TODO src/', 'npm run build',
  ]) {
    const r = await hookVerdict(cmd, fx.root);
    assert.equal(r.decision, 'allow', `${cmd} destroys nothing holt is guarding: ${r.stdout}`);
  }
});

/* ------------------------------------------------------- [E] spelling versus effect: shells ---- */

test('[E] a clustered shell option hides nothing: -lc is -c', async (t) => {
  const fx = await fixture();
  t.after(() => fx.cleanup());
  const wt = rel(fx.root, fx.wt('holds'));

  const control = await hookVerdict(`bash -c "rm -rf ${wt}"`, fx.root);
  assert.equal(control.decision, 'deny', `control: ${control.stdout}`);

  for (const opts of ['-lc', '-xc', '-cx', '-euxc', '-e -c', '-o pipefail -c', '--login -c']) {
    const r = await hookVerdict(`bash ${opts} "rm -rf ${wt}"`, fx.root);
    assert.equal(r.decision, 'deny', `bash ${opts} runs the identical deletion: ${r.stdout}`);
  }
  for (const sh of ['sh -ec', 'sh -euc']) {
    const r = await hookVerdict(`${sh} "rm -rf ${wt}"`, fx.root);
    assert.equal(r.decision, 'deny', `${sh} runs the identical deletion: ${r.stdout}`);
  }
});

test('[E] a shell wrapper is transparent to BOTH layers, or it is a bypass', async (t) => {
  const fx = await fixture();
  t.after(() => fx.cleanup());
  const wt = rel(fx.root, fx.wt('holds'));

  // Reading `-lc` correctly closed the WORKTREE-granular hole and left the FILE-granular one, and
  // the two then disagreed about the same bytes. Measured on the unpatched build and on the
  // half-patched one:
  //     rm <wt>/notes.md               -> deny   (the file layer sees the path)
  //     bash -c "rm <wt>/notes.md"     -> ALLOW  (only the worktree layer looked, and a file is
  //                                               not a worktree, so its rule short-circuits)
  const control = await hookVerdict(`rm ${wt}/notes.md`, fx.root);
  assert.equal(control.decision, 'deny', `control: ${control.stdout}`);

  for (const cmd of [
    `bash -c "rm ${wt}/notes.md"`,
    `bash -lc "rm ${wt}/notes.md"`,
    `sh -ec "rm ${wt}/app/plain.tsx"`,
    `bash -lc "rm '${wt}/app/[id].tsx'"`,
  ]) {
    const r = await hookVerdict(cmd, fx.root);
    assert.equal(r.decision, 'deny', `${cmd} destroys the only copy: ${r.stdout}`);
  }
});

test('[E] NEVER-WORSE: a login shell running ordinary work is still silent', async (t) => {
  const fx = await fixture();
  t.after(() => fx.cleanup());
  for (const cmd of [
    'bash -lc "ls"', 'bash -lc "npm run build"', 'bash -euxc "npm ci && npm test"',
    'bash -lc "cd /tmp && rm -rf junk"', 'bash build.sh', 'bash -x build.sh',
    'sh -ec "make"', 'bash -o pipefail -c "git status"',
  ]) {
    const r = await hookVerdict(cmd, fx.root);
    assert.equal(r.decision, 'allow', `${cmd} destroys nothing: ${r.stdout}`);
  }
});

/* --------------------------------------------------- [E] spelling versus effect: git globals ---- */

test('[E] `git --work-tree=<wt>` names the tree the verb acts on, exactly as `git -C` does', async (t) => {
  const fx = await fixture();
  t.after(() => fx.cleanup());
  const wt = rel(fx.root, fx.wt('holds'));

  const control = await hookVerdict(`git -C ${wt} checkout -- .`, fx.root);
  assert.equal(control.decision, 'deny', `control: ${control.stdout}`);

  for (const cmd of [
    `git --work-tree=${wt} checkout -- .`,
    `git --work-tree ${wt} checkout -- .`,
    `git --work-tree=${wt} reset --hard`,
    `git --work-tree=${wt} clean -fdx`,
  ]) {
    const r = await hookVerdict(cmd, fx.root);
    assert.equal(r.decision, 'deny', `${cmd} acts on ${wt}: ${r.stdout}`);
  }
});

test('[E] NEVER-WORSE: --work-tree pointing at a tree with nothing to lose is still silent', async (t) => {
  const fx = await fixture();
  t.after(() => fx.cleanup());
  await fx.worktree('spent');
  const spent = rel(fx.root, fx.wt('spent'));
  for (const cmd of [
    `git --work-tree=${spent} reset --hard`,
    `git --work-tree=${spent} checkout -- .`,
    `git --work-tree=. status`,
    `git --work-tree=${spent} status`,
  ]) {
    const r = await hookVerdict(cmd, fx.root);
    assert.equal(r.decision, 'allow', `${cmd} destroys nothing: ${r.stdout}`);
  }
});

/* ------------------------------------------ [E] spelling versus effect: the pathspec `--` ---- */

test('[E] `git checkout <file>` is the same loss as `git checkout -- <file>`', async (t) => {
  const fx = await fixture();
  t.after(() => fx.cleanup());
  const holds = fx.wt('holds');
  // A TRACKED file with an uncommitted edit: checkout/restore replaces it with the committed copy.
  await fx.write('src/base.js', 'export function TARGETRES_LOCAL_EDIT() { return 42; }\n', holds);

  const control = await hookVerdict('git checkout -- src/base.js', holds);
  assert.equal(control.decision, 'deny', `control: ${control.stdout}`);

  for (const cmd of ['git checkout src/base.js', 'git restore src/base.js',
    'git checkout HEAD src/base.js', 'git restore --worktree src/base.js']) {
    const r = await hookVerdict(cmd, holds);
    assert.equal(r.decision, 'deny', `${cmd} overwrites the only copy of the edit: ${r.stdout}`);
  }
});

test('[E] NEVER-WORSE: branch work is untouched — a rev is not a pathspec', async (t) => {
  const fx = await fixture();
  t.after(() => fx.cleanup());
  const holds = fx.wt('holds');
  await fx.write('src/base.js', 'export function TARGETRES_LOCAL_EDIT() { return 42; }\n', holds);

  // The ambiguity `git checkout <name>` carries is not guessed at: the DIRTY FILE SET decides, so a
  // branch name matches nothing and stays a silent allow even in a thoroughly dirty worktree.
  for (const cmd of [
    'git checkout main', 'git checkout -b feature/x', 'git checkout -B feature/y',
    'git checkout HEAD~1', 'git checkout --detach', 'git checkout --orphan fresh',
    'git checkout --track origin/main', 'git switch -c feature/z',
    'git restore --staged src/base.js', 'git restore --staged .',
  ]) {
    const r = await hookVerdict(cmd, holds);
    assert.equal(r.decision, 'allow', `${cmd} loses nothing: ${r.stdout}`);
  }
});
