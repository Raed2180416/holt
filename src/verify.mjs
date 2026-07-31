// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — differential verification of a suspected interaction.
 *
 * ============================================================================================
 * THE QUESTION THIS ANSWERS, AND THE ONE IT DOES NOT
 * ============================================================================================
 * `holt impact` reports a FACT: A defines symbol X, B references X, and they share no file, so
 * collision detection cannot see the relationship. That is checkable and true, and it is where
 * holt stopped — leaving the user with "these two interact" and no way to find out whether the
 * interaction is a problem.
 *
 * This module closes that gap for a SPECIFIC pair, empirically:
 *
 *     does the project's own test suite still pass when A and B are both applied?
 *
 * WHY THIS IS TRACTABLE WHEN GENERAL SEMANTIC-CONFLICT DETECTION IS NOT.
 * The state of the art generates tests to act as partial specifications — SAM (JSS 2024) invokes
 * Randoop/EvoSuite on the changed classes and reports interference from the results, scoring
 * precision 0.65 / recall 0.88, and it is Java-only because the generators are. Generating a
 * specification is the hard, language-bound, imprecise part.
 *
 * holt does not need to generate one. Real repositories already ship a specification: their
 * test suite. So instead of inventing tests, holt runs the ones that already exist, against a
 * speculative merge. That is language-agnostic (any test command), needs no generator, and
 * inherits the project's own quality bar.
 *
 * THE DIFFERENTIAL IS THE WHOLE DESIGN. Running the suite on A+B and reporting failures would be
 * useless: most real repositories have failures already, and a change may legitimately break a
 * test on its own. So holt runs THREE times — A alone, B alone, A+B — and reports only what the
 * COMBINATION breaks:
 *
 *     failed in A+B  AND  passed in A alone  AND  passed in B alone   ->  the interaction broke it
 *
 * Anything failing in A or B individually is that change's own problem, not an interaction, and
 * saying otherwise would be the false-positive flood the static literature is full of.
 *
 * TWO PROPERTIES THAT LINE DEPENDS ON, EACH OF WHICH WAS ONCE MISSING:
 *
 *   1. IT IS READ FROM WHAT THE RUNS DID, NOT FROM WHAT holt COULD PARSE. "passed" is the
 *      runner's exit status. Deriving it instead from failure names matched by regex meant an
 *      unrecognised output format was indistinguishable from a green suite, and holt answered
 *      "nothing wrong", exit 0, on a combination it had just watched break.
 *   2. ALL THREE ARMS SHARE ONE BASE. A differential is only readable when the arms differ by
 *      the thing under test. Building A and B against the current base while building A+B from
 *      the pair's own merge base made every commit the base gained after they branched look
 *      like an interaction between two changes that had never met.
 *
 * WHAT IT STILL CANNOT DO. Recall is bounded by the existing suite: an interaction no test
 * exercises is invisible here, exactly as it is to the developers. So a clean result is reported
 * as "the existing tests did not catch anything", never as "these are compatible". P4 remains
 * unsolved; this makes a specific, suspected pair decidable.
 *
 * ============================================================================================
 * SAFETY — THIS EXECUTES THE PROJECT'S CODE
 * ============================================================================================
 * Every other holt command reads. This one runs a command the user supplies, so it is gated:
 *
 *   - the command must be given EXPLICITLY (--run) or via holtTest in package.json. holt never
 *     guesses a test command and never auto-executes one it inferred;
 *   - it runs in a SCRATCH worktree built from the speculative merge, never in the user's
 *     worktrees, so a destructive test cannot touch real work;
 *   - the scratch worktree is created and removed by holt and lives outside the repo;
 *   - it is never invoked by `holt status`, by the MCP tools, or by any hook. A user or an agent
 *     has to ask for it by name.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { git, gitOk, authorEnv } from './git.mjs';
import { scratchDir } from './symbols.mjs';
import { discover } from './discover.mjs';
import { scan } from './scan.mjs';

/**
 * Variables by which a test runner recognises that it is a CHILD of another test runner, and
 * so reports upward over a private channel instead of exiting honestly.
 *
 * The whole verdict now rests on the runner's exit status, so anything that stops that status
 * from meaning "the suite passed" is a false-crown vector. This one is not hypothetical: run
 * `holt verify --run "node --test"` from inside a node:test process and the child inherits
 * NODE_TEST_CONTEXT, switches to the serialized reporter, prints nothing holt can read AND
 * EXITS 0 WITH FAILING TESTS. holt would report every arm green. holt's own e2e suite is exactly
 * such a parent, which is how this surfaced.
 *
 * holt already curates this environment (it sets CI, it disables terminal prompts). The rule is
 * that the user's suite runs in the user's environment, never in holt's harness state.
 */
const PARENT_HARNESS_ENV = ['NODE_TEST_CONTEXT', 'NODE_TEST_PIPE', 'JEST_WORKER_ID', 'VITEST_POOL_ID'];

/** Run the user's test command. Never shell-interpolated: argv array, no shell. */
function runCommand(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    // A test command is naturally a string ("npm test", "pytest -q"). Split on whitespace rather
    // than handing it to a shell — no shell means no injection surface from a config file.
    const [cmd, ...args] = command.trim().split(/\s+/);
    const env = { ...process.env, CI: '1', GIT_TERMINAL_PROMPT: '0' };
    for (const k of PARENT_HARNESS_ENV) delete env[k];
    execFile(cmd, args, {
      cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env,
    }, (err, stdout, stderr) => resolve({
      ok: !err,
      timedOut: !!err?.killed,
      code: err ? (err.code ?? 1) : 0,
      ms: Date.now() - started,
      stdout: String(stdout ?? ''),
      stderr: String(stderr ?? ''),
    }));
  });
}

/**
 * Materialise a tree into a scratch directory and run the command there.
 * Uses `git worktree add --detach` on a temporary commit so the checkout is real and complete.
 */
async function runAgainstTree(root, tree, command, { timeoutMs, label }) {
  const scratch = await fs.mkdtemp(path.join(scratchDir(), `holt-verify-${label}-`));
  const wt = path.join(scratch, 'wt');
  let commit = null;
  try {
    const c = await gitOk(['commit-tree', tree, '-m', `holt verify: ${label}`],
      { cwd: root, allowMutation: true, env: await authorEnv(root) });
    commit = c.stdout.trim();

    const add = await git(['worktree', 'add', '--detach', '--no-checkout', wt, commit],
      { cwd: root, allowMutation: true });
    if (add.code !== 0) {
      return { label, ran: false, reason: `could not materialise the tree: ${add.stderr.trim()}` };
    }
    // Populate the scratch checkout from the speculative tree. read-tree -u writes the files;
    // `reset --hard` would be the usual idiom and is deliberately not on holt's allowlist.
    const rt = await git(['read-tree', '-m', '-u', tree], { cwd: wt, allowMutation: true });
    if (rt.code !== 0) {
      return { label, ran: false, reason: `could not populate the scratch tree: ${rt.stderr.trim()}` };
    }

    const res = await runCommand(command, wt, timeoutMs);
    // `wt` is reported back because it is run-varying data that leaks into failure text — see
    // RUN_VARYING below. The directory is gone by the time anyone reads this; the string is what
    // the normaliser needs.
    return { label, ran: true, workdir: wt, ...res };
  } finally {
    if (wt) await git(['worktree', 'remove', '--force', wt], { cwd: root, allowMutation: true }).catch(() => {});
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * A failure IDENTITY MUST BE A FUNCTION OF THE TEST, NEVER OF THE RUN.
 *
 * The differential compares identifiers parsed out of three SEPARATE executions. Any part of an
 * identifier that varies between executions makes one test look like three different failures, so
 * every failure of an already-red suite is classified as combination-only — the differential
 * manufacturing exactly the false-positive flood it exists to prevent. (`node --test` prints
 * `✖ name (12.345678ms)`; that duration is never the same twice.)
 *
 * The rule is therefore general and not a list of frameworks: strip what varies with the RUN.
 * Each entry below removes one CLASS of run-varying data, and a newly discovered class is one
 * more entry rather than a new special case somewhere.
 */
const DURATION_UNIT = '(?:ns|µs|us|ms|millis(?:econds?)?|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)';
const TRAILING_DURATION = new RegExp(
  `[\\s(\\[{]*\\b\\d+(?:[.,]\\d+)?\\s*${DURATION_UNIT}\\b[\\s)\\]}]*$`, 'i');

const RUN_VARYING = [
  // (1) The directory the run happened in. Each arm executes in its own freshly-created scratch
  //     worktree, so an absolute path quoted in a failure name differs across all three BY
  //     CONSTRUCTION — there is no repository in which those paths could ever match.
  (s, workdir) => {
    if (!workdir) return s;
    let o = s;
    for (const p of [workdir, path.dirname(workdir)]) {
      if (p && p !== '.' && p !== path.sep) o = o.split(p).join('<workdir>');
    }
    return o;
  },
  // (2) TAP-style trailing metadata, which is where tap and node:test park the duration.
  (s) => s.replace(/\s*#\s*(?:time|duration|took)\b[^\n]*$/i, ''),
  // (3) A duration the runner measured and appended. Bounded to the TAIL of the identifier on
  //     purpose: that is where every runner puts its own measurements, and a wider sweep would
  //     start erasing digits that are part of the test's real name.
  (s) => s.replace(TRAILING_DURATION, ''),
];

/** Collapse one raw capture into a run-independent identity. */
function stableFailureId(raw, workdir) {
  let s = String(raw ?? '').trim();
  for (const scrub of RUN_VARYING) s = scrub(s, workdir);
  return s.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * Extract failing-test identifiers from output, best-effort and framework-agnostic.
 *
 * Best-effort is the operative word, and it is why these names are DETAIL and never the verdict:
 * a runner is free to word its failures any way it likes, and a name this cannot parse must not
 * change what holt concludes. See the verdict block in verifyPair.
 *
 * @param {string} text
 * @param {{workdir?: string|null}} [opts] the directory this particular run executed in
 */
export function extractFailures(text, { workdir = null } = {}) {
  const out = new Set();
  // Anchored with /m rather than by matching a literal newline. The literal form CONSUMED the
  // newline that ended each match, so the next line no longer had one in front of it and every
  // second failure in a consecutive run was silently dropped — "FAIL one/two/three" parsed as
  // one and three. A set that is missing half the failures makes both directions of the
  // differential wrong, and nothing about the output says anything was skipped.
  const patterns = [
    /^\s*(?:FAIL|FAILED|✖|✗|not ok \d+)\s+[-–]?\s*(.+?)\s*$/gm,  // node:test, tap, jest
    /^FAILED\s+(\S+)/gm,                                          // pytest
    /^---\s*FAIL:\s*(\S+)/gm,                                     // go test
    /^\s*\d+\)\s+(.+?)\s*$/gm,                                    // mocha
  ];
  for (const re of patterns) {
    for (const m of String(text).matchAll(re)) {
      const name = stableFailureId(m[1], workdir);
      if (name && !/^\d+$/.test(name)) out.add(name);
    }
  }
  return [...out];
}

/**
 * Differentially verify one suspected pair.
 *
 * @param {string} cwd
 * @param {string} idA
 * @param {string} idB
 * @param {object} opts
 * @param {string} opts.run      the test command. REQUIRED — holt never guesses one.
 * @param {number} opts.timeout  per-run timeout in ms (default 10 min)
 */
export async function verifyPair(cwd, idA, idB, { run = null, timeout = 600_000, ...opts } = {}) {
  const disc = await discover(cwd, opts);
  if (!disc.root) throw Object.assign(new Error(`not a git repository: ${cwd}`), { code: 'ENOTREPO' });

  const command = run ?? await testCommandFromConfig(disc.root);
  if (!command) {
    return {
      ok: false,
      error: 'no test command. Pass --run "<cmd>" or add "holtTest" to package.json.',
      why: 'holt never guesses a command to execute — running the wrong thing in your repo is '
        + 'a worse outcome than not answering.',
    };
  }

  const scanned = await scan(disc, opts);
  const a = scanned.workstreams.find((w) => w.id === idA);
  const b = scanned.workstreams.find((w) => w.id === idB);
  if (!a?.ok || !b?.ok) {
    return { ok: false, error: `could not scan ${!a?.ok ? idA : idB}`, known: scanned.workstreams.map((w) => w.id) };
  }

  const base = scanned.base.oid;

  // ============================================================================================
  // ONE BASE FOR ALL THREE ARMS.
  // ============================================================================================
  // A differential is only readable if the arms differ by the thing under test and nothing else.
  // A and B are each merged onto the CURRENT base, so every commit the base has is in them. A+B
  // used to be merge-tree(a.head, b.head), whose merge base is the PAIR'S OWN branch point — so
  // any commit the base gained after they branched was present in two arms and absent from the
  // third, and the resulting difference was scored as an interaction between A and B. Nothing
  // about A or B caused it; the base moving on did. It is the everyday case, not a corner one.
  //
  // So both sides are rebased onto the base first, then committed WITH THE BASE AS PARENT — which
  // makes the base their merge base by construction — and the combined arm is the merge of those.
  // All three arms are now `base + <the changes named in the arm>`.
  const treeA = await git(['merge-tree', '--write-tree', base, a.head], { cwd: disc.root });
  const treeB = await git(['merge-tree', '--write-tree', base, b.head], { cwd: disc.root });
  if (treeA.code > 1 || treeB.code > 1) {
    return { ok: false, error: 'could not build the single-side trees' };
  }
  // A side that conflicts with the BASE is a question about that side and the base, not about
  // the pair. Running a checkout full of conflict markers would fail every arm it appears in and
  // read as an interaction, so refuse and name the side instead.
  if (treeA.code === 1 || treeB.code === 1) {
    const which = treeA.code === 1 ? idA : idB;
    return {
      ok: true, textualConflict: true, conflictsWith: 'base', a: idA, b: idB,
      verdict: `${which} conflicts TEXTUALLY with the base — rebase it first; `
        + 'there is nothing to run yet',
    };
  }
  const sideA = treeA.stdout.split('\n')[0].trim();
  const sideB = treeB.stdout.split('\n')[0].trim();

  // Unreferenced commits, exactly like the trees merge-tree --write-tree already writes: they
  // exist to give the merge a common ancestor and are never pointed at by any ref.
  const env = await authorEnv(disc.root);
  const onBase = async (tree, label) => (await gitOk(
    ['commit-tree', tree, '-p', base, '-m', `holt verify: ${label} rebased onto base`],
    { cwd: disc.root, allowMutation: true, env })).stdout.trim();
  const commitA = await onBase(sideA, idA);
  const commitB = await onBase(sideB, idB);

  // Speculative merge. A textual conflict is P1's answer, not this module's.
  const mt = await git(['merge-tree', '--write-tree', commitA, commitB], { cwd: disc.root });
  if (mt.code > 1) {
    return { ok: false, error: `merge-tree failed: ${mt.stderr.trim()}` };
  }
  if (mt.code === 1) {
    return {
      ok: true, textualConflict: true, conflictsWith: 'pair', a: idA, b: idB,
      verdict: 'these two conflict TEXTUALLY — resolve that first; there is nothing to run yet',
    };
  }
  const merged = mt.stdout.split('\n')[0].trim();

  const runs = {
    a: await runAgainstTree(disc.root, sideA, command, { timeoutMs: timeout, label: 'a' }),
    b: await runAgainstTree(disc.root, sideB, command, { timeoutMs: timeout, label: 'b' }),
    ab: await runAgainstTree(disc.root, merged, command, { timeoutMs: timeout, label: 'ab' }),
  };

  for (const [k, r] of Object.entries(runs)) {
    if (!r.ran) return { ok: false, error: `run '${k}' could not execute: ${r.reason}` };
    if (r.timedOut) {
      return {
        ok: false, error: `run '${k}' timed out after ${timeout}ms`,
        why: 'a timeout is not a pass — holt will not report a clean result it did not observe',
      };
    }
  }

  const failA = new Set(extractFailures(runs.a.stdout + runs.a.stderr, { workdir: runs.a.workdir }));
  const failB = new Set(extractFailures(runs.b.stdout + runs.b.stderr, { workdir: runs.b.workdir }));
  const failAB = extractFailures(runs.ab.stdout + runs.ab.stderr, { workdir: runs.ab.workdir });

  // THE DIFFERENTIAL: only what the COMBINATION breaks.
  const interactionFailures = failAB.filter((f) => !failA.has(f) && !failB.has(f));

  const aPassed = runs.a.ok;
  const bPassed = runs.b.ok;
  const abPassed = runs.ab.ok;
  const bothSidesGreen = aPassed && bPassed;

  // ============================================================================================
  // THE VERDICT COMES FROM THE RUN RESULTS. NAMES ARE DETAIL.
  // ============================================================================================
  // Whether the suite passed is a fact the runner reported by exiting; whether holt could parse a
  // name out of its prose is a fact about holt's regexes. Deriving the verdict from the names made
  // an unrecognised output format indistinguishable from a green run: A green, B green, A+B RED,
  // no name matched, and holt answered that nothing was wrong and exited 0. That is a false crown
  // on the one command whose entire job is to decide this, and it fires on any runner whose
  // failure lines this module has not seen — which is most of them.
  //
  // So: the exit status decides, and it can only ever be missing if the run did not happen (which
  // is refused above). A name is a description of a failure, never the evidence one occurred.
  const brokeByExitStatus = bothSidesGreen && !abPassed;
  // One rung down, and only where exit status CANNOT decide: if a side is already red on its own,
  // every arm exits non-zero and "did the combination make it worse" is answerable from names
  // alone. This rung adds detections, never suppresses one — it is unreachable while both sides
  // are green, which is the case the rung above owns outright.
  const brokeByName = !bothSidesGreen && !abPassed && interactionFailures.length > 0;
  const interactionBreaks = brokeByExitStatus || brokeByName;

  return {
    ok: true,
    a: idA,
    b: idB,
    command,
    runs: {
      a: { passed: aPassed, exit: runs.a.code, ms: runs.a.ms, failures: [...failA].slice(0, 10) },
      b: { passed: bPassed, exit: runs.b.code, ms: runs.b.ms, failures: [...failB].slice(0, 10) },
      ab: { passed: abPassed, exit: runs.ab.code, ms: runs.ab.ms, failures: failAB.slice(0, 10) },
    },
    interactionBreaks,
    // What the verdict rests on. 'exit-status' is decisive; 'failure-names' is best-effort and
    // says so, so nobody has to infer the strength of the answer from its wording.
    evidence: brokeByExitStatus ? 'exit-status' : brokeByName ? 'failure-names' : null,
    interactionFailures,
    verdict: brokeByExitStatus
      ? 'INTERACTION BREAKS THE SUITE — the suite passes with either change alone and fails with both'
        + (interactionFailures.length ? `: ${interactionFailures.slice(0, 3).join(', ')}` : '')
      : brokeByName
        ? 'INTERACTION BREAKS THE SUITE — these tests fail only with both changes applied. A side '
          + 'was already red on its own, so this is attributed from failure names, not exit status.'
        : (aPassed && bPassed && abPassed)
          ? 'the existing tests did not catch anything. NOT a proof of compatibility: recall is '
            + 'bounded by the suite, and an interaction no test exercises is invisible here.'
          : 'at least one side fails on its own — fix that first; no interaction conclusion is possible',
    caveat: 'This runs YOUR test command in a scratch worktree. A clean result means the existing '
      + 'tests found nothing, not that the changes are compatible.',
  };
}

/** A project-declared test command. Opt-in by construction: holt never infers one. */
async function testCommandFromConfig(root) {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    // Deliberately NOT scripts.test — running `npm test` because it happens to exist is exactly
    // the kind of inference that executes something the user did not intend.
    return typeof pkg.holtTest === 'string' ? pkg.holtTest : null;
  } catch {
    return null;
  }
}
