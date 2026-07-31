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
import { git, gitOk } from './git.mjs';
import { scratchDir } from './symbols.mjs';
import { discover } from './discover.mjs';
import { scan } from './scan.mjs';

/** Run the user's test command. Never shell-interpolated: argv array, no shell. */
function runCommand(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    // A test command is naturally a string ("npm test", "pytest -q"). Split on whitespace rather
    // than handing it to a shell — no shell means no injection surface from a config file.
    const [cmd, ...args] = command.trim().split(/\s+/);
    execFile(cmd, args, {
      cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, CI: '1', GIT_TERMINAL_PROMPT: '0' },
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
      { cwd: root, allowMutation: true });
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
    return { label, ran: true, ...res };
  } finally {
    if (wt) await git(['worktree', 'remove', '--force', wt], { cwd: root, allowMutation: true }).catch(() => {});
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/** Extract failing-test identifiers from output, best-effort and framework-agnostic. */
export function extractFailures(text) {
  const out = new Set();
  const patterns = [
    /(?:^|\n)\s*(?:FAIL|FAILED|✖|✗|not ok \d+)\s+[-–]?\s*(.+?)(?:\n|$)/g,  // node:test, tap, jest
    /(?:^|\n)FAILED\s+(\S+)/g,                                              // pytest
    /(?:^|\n)---\s*FAIL:\s*(\S+)/g,                                         // go test
    /(?:^|\n)\s*\d+\)\s+(.+?)(?:\n|$)/g,                                    // mocha
  ];
  for (const re of patterns) {
    for (const m of String(text).matchAll(re)) {
      const name = (m[1] ?? '').trim().slice(0, 200);
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

  // Speculative merge. A textual conflict is P1's answer, not this module's.
  const mt = await git(['merge-tree', '--write-tree', a.head, b.head], { cwd: disc.root });
  if (mt.code > 1) {
    return { ok: false, error: `merge-tree failed: ${mt.stderr.trim()}` };
  }
  if (mt.code === 1) {
    return {
      ok: true, textualConflict: true, a: idA, b: idB,
      verdict: 'these two conflict TEXTUALLY — resolve that first; there is nothing to run yet',
    };
  }
  const merged = mt.stdout.split('\n')[0].trim();

  // Each side alone, against base, so a pre-existing failure is attributed correctly.
  const treeA = (await git(['merge-tree', '--write-tree', base, a.head], { cwd: disc.root }));
  const treeB = (await git(['merge-tree', '--write-tree', base, b.head], { cwd: disc.root }));
  if (treeA.code > 1 || treeB.code > 1) {
    return { ok: false, error: 'could not build the single-side trees' };
  }

  const runs = {
    a: await runAgainstTree(disc.root, treeA.stdout.split('\n')[0].trim(), command, { timeoutMs: timeout, label: 'a' }),
    b: await runAgainstTree(disc.root, treeB.stdout.split('\n')[0].trim(), command, { timeoutMs: timeout, label: 'b' }),
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

  const failA = new Set(extractFailures(runs.a.stdout + runs.a.stderr));
  const failB = new Set(extractFailures(runs.b.stdout + runs.b.stderr));
  const failAB = extractFailures(runs.ab.stdout + runs.ab.stderr);

  // THE DIFFERENTIAL: only what the COMBINATION breaks.
  const interactionFailures = failAB.filter((f) => !failA.has(f) && !failB.has(f));

  const aPassed = runs.a.ok;
  const bPassed = runs.b.ok;
  const abPassed = runs.ab.ok;

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
    interactionFailures,
    verdict: interactionFailures.length
      ? 'INTERACTION BREAKS THE SUITE — these tests pass with either change alone and fail with both'
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
