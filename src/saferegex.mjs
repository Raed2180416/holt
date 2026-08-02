/**
 * Running a user-supplied regular expression without being able to stop it.
 *
 * WHY THIS EXISTS. `.holtrc.json` accepts `familyOverrides` — regexes, matched against worktree
 * names. A pattern with catastrophic backtracking makes that match run for an unbounded time, and
 * because backtracking happens inside a single atomic `String.match` call there is nothing in
 * JavaScript that can interrupt it: no timeout, no signal, no try/catch. Every holt command that
 * reads config hangs, INCLUDING the blocking PreToolUse guard — so an agent freezes forever
 * because a teammate committed a config file.
 *
 * WHY THE STATIC CHECK IS NOT ENOUGH. `hasNestedQuantifier` (src/config.mjs) refuses the textbook
 * shape `(a+)+`, and that is worth keeping — it is free and it catches the common accident. But
 * it is a heuristic over a problem that has no complete syntactic answer, and the bypasses are
 * ordinary, not exotic. MEASURED, on this machine, against a 41-character worktree name:
 *
 *     ^(a+)+$      declined by the static check
 *     ^(a|aa)+$    NOT declined — the group body holds no quantifier for the check to see
 *     ^(a|a?)+$    NOT declined —          "                    "               10.1 s in
 *                                                                               inferFamily()
 *
 * Refusing "regexes that might be slow" is not available either: the interesting half of that
 * question is undecidable, and over-refusing a user's working config is its own bug.
 *
 * SO: STOP GUESSING WHETHER IT TERMINATES, AND MAKE IT INTERRUPTIBLE. A worker thread is a
 * separate V8 isolate, and `worker.terminate()` stops it mid-execution — including mid-regex,
 * which is the one thing the main thread cannot do to itself. Patterns are screened here, once,
 * against the exact names they will be matched against; whatever completes inside the budget is
 * then safe to run inline, because it has just been observed to complete on those very inputs.
 * Whatever does not is dropped with a loud warning, and holt carries on with its built-in naming
 * rules — the config gate's standing rule that a bad entry warns and never kills.
 *
 * COST: nothing at all when `familyOverrides` is absent, which is the overwhelmingly common case
 * — `screenOverrides` returns immediately without spawning anything.
 */

import { Worker } from 'node:worker_threads';

/** Budget for the whole screening pass. Generous: this runs once per scan, not per command. */
export const SCREEN_TIMEOUT_MS = 2000;

// Deliberately tiny, and deliberately NOT importing from the rest of holt: this body runs in a
// thread that may be terminated at any instant, so it must own nothing and hold no resource.
// It mirrors inferFamily's override loop exactly — same construction, same `match`, same order —
// because screening a DIFFERENT expression than the one that will run proves nothing.
const SCREEN_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { patterns, names } = workerData;
const survived = [];
for (const p of patterns) {
  let ok = true;
  try {
    const re = new RegExp(p);
    for (const n of names) n.match(re);
  } catch { ok = true; }  // an invalid regex is config's problem, not a hang
  if (ok) survived.push(p);
}
parentPort.postMessage(survived);
`;

/**
 * Screen `patterns` by running them against `names` in a thread that can be killed.
 *
 * @param {string[]} patterns  user-supplied regex sources
 * @param {string[]} names     the exact subjects they will later be matched against
 * @param {{timeoutMs?: number, onDeclined?: (declined: string[]) => void}} [opts]
 * @returns {Promise<string[]>} the subset observed to complete within the budget. On timeout the
 *   result is `[]` — holt cannot tell WHICH pattern was the slow one without re-running the
 *   others, and re-running them is the cost this function exists to bound.
 */
export async function screenOverrides(patterns, names, opts = {}) {
  const { timeoutMs = SCREEN_TIMEOUT_MS, onDeclined } = opts;
  // Nothing to screen is the common path and must cost nothing — no thread, no timer.
  if (!Array.isArray(patterns) || patterns.length === 0) return [];
  if (!Array.isArray(names) || names.length === 0) return patterns;

  let worker;
  try {
    worker = new Worker(SCREEN_WORKER, {
      eval: true,
      workerData: { patterns, names },
      // The screen reads two arrays and returns one. It has no business touching anything else,
      // and an inherited stdio/env is a surface this does not need.
      stdin: false, stdout: true, stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    });
  } catch {
    // Workers unavailable (a restricted embedder). Falling back to running the patterns inline is
    // exactly the hang this module prevents, so the honest degradation is to decline them all.
    onDeclined?.(patterns);
    return [];
  }

  return await new Promise((resolve) => {
    let settled = false;
    const finish = (result, declined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (declined?.length) onDeclined?.(declined);
      // terminate() is safe to call on an already-exited worker and is what actually stops a
      // spinning match. Its promise is ignored on purpose: the answer is already decided.
      worker.terminate().catch(() => {});
      resolve(result);
    };
    const timer = setTimeout(() => {
      const survived = [];
      finish(survived, patterns.filter((p) => !survived.includes(p)));
    }, timeoutMs);
    // Do not let a screening thread hold the process open if everything else has finished.
    timer.unref?.();

    worker.on('message', (survived) => {
      const kept = Array.isArray(survived) ? survived : [];
      finish(kept, patterns.filter((p) => !kept.includes(p)));
    });
    // A worker that dies (OOM from resourceLimits, a crash) has not proven anything safe.
    worker.on('error', () => finish([], patterns));
    worker.on('exit', () => finish([], patterns));
  });
}

/** The warning holt prints when a pattern is declined. Shared so the wording is stated once. */
export function declinedMessage(declined, filePath = '.holtrc.json') {
  return `holt: ignoring ${declined.length} "familyOverrides" `
    + `entr${declined.length === 1 ? 'y' : 'ies'} — `
    + `${declined.map((p) => JSON.stringify(p)).join(', ')} did not finish matching this `
    + `repository's worktree names within ${SCREEN_TIMEOUT_MS}ms. A regular expression that can `
    + 'backtrack without bound hangs every holt command, including the guard that blocks '
    + `destructive commands, so it is declined rather than run (${filePath}). holt's built-in `
    + 'naming rules are being used instead.\n';
}
