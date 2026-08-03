#!/usr/bin/env node
// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — the static-analysis ratchet.
 *
 * WHY A RATCHET AND NOT A PASS/FAIL GATE. This repository shipped 20,749 lines of JavaScript with
 * no linter, no type checker and no gate of any kind. Turning on `tsc --checkJs` produces 1,220
 * diagnostics on the first run. A gate that fails from the moment it is added is a gate somebody
 * deletes within a week, and then the codebase is back where it started with an extra dead file.
 *
 * So the rule is the only one that works on an existing codebase: THE COUNT MAY NEVER GO UP.
 * Every commit is free to leave the debt alone, and no commit may add to it. The number in
 * .typecheck-baseline is the current ceiling and it only ever moves down — this script rewrites it
 * when the count improves, so paying debt down is automatic and regressing is loud.
 *
 * This is deliberately NOT a "warnings" mode. A warning nobody must act on is a warning nobody
 * reads, and this project has a written history of exactly that failure — a CI check that could
 * pass vacuously forever is the thing its own published-numbers gate was built to replace.
 *
 * Exit 0 = at or below the ceiling. Exit 1 = the debt grew, with the new diagnostics printed.
 *
 * A RATCHET THAT CANNOT TELL "CLEAN" FROM "DID NOT RUN" IS NOT A RATCHET. Two ways this one could
 * not, both reproduced:
 *
 *   1. tsc failed to SPAWN. The old code decided "not installed" by grepping the tool's OUTPUT for
 *      'Cannot find module', but a spawn failure produces no output at all, so that branch was
 *      skipped, zero lines matched /error TS/, and the script concluded zero diagnostics. It then
 *      rewrote .typecheck-baseline to 0, printed "down from 230 — ceiling lowered", and exited 0.
 *      One green run in an environment without the shim (`npm ci --omit=dev`, a mirror that skips
 *      optional installs, a Windows .cmd path) permanently destroys the ceiling, and every later
 *      run passes against it. Installation is now decided from the FILESYSTEM, and a run that
 *      produced no diagnostics while exiting non-zero is a tool failure, not a clean bill.
 *
 *   2. tsc RAN BUT COULD NOT SEE NODE. tsconfig omitted `types`, so every `node:*` import failed
 *      to resolve; 133 of the 362 diagnostics were `Cannot find name 'node:fs/promises'` and the
 *      rest were mostly `Property 'x' does not exist on type 'never'` cascading from them. The
 *      ratchet only forbids GROWTH, so this was green for as long as it existed while the checker
 *      was reading a codebase in which nothing had a type. TS2591 is now fatal on its own.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = path.join(ROOT, '.typecheck-baseline');

const tsc = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');

function run() {
  return new Promise((resolve) => {
    execFile(tsc, ['--noEmit'], {
      cwd: ROOT,
      timeout: 600_000,
      maxBuffer: 64 * 1024 * 1024,
      shell: process.platform === 'win32',
    }, (err, stdout, stderr) => resolve({
      out: `${stdout ?? ''}${stderr ?? ''}`,
      // execFile's `err` carries `code` for a non-zero exit and an errno string for a spawn
      // failure. Both were discarded before, which is how a spawn failure read as a clean run.
      code: err ? (typeof err.code === 'number' ? err.code : null) : 0,
      signal: err?.signal ?? null,
      spawnError: err && typeof err.code !== 'number' && !err.signal ? String(err.code ?? err.message) : null,
    }));
  });
}

// INSTALLED-OR-NOT IS A QUESTION ABOUT THE FILESYSTEM. Asking it of the tool's output means a
// tool that produced no output — the exact shape of a spawn failure — answers "installed".
try {
  await fs.access(tsc);
} catch {
  console.log('typecheck: typescript is not installed here — run `npm install` to enable it.');
  console.log('           (this is a devDependency; it is never shipped and never runs at runtime)');
  process.exit(0);
}

const { out, code, signal, spawnError } = await run();

// tsc's OWN exit codes: 0 = nothing to report, 1 and 2 = diagnostics reported. ANYTHING ELSE —
// a signal, an OOM kill (137), a timeout's SIGTERM (143), a crash — means the run was cut short,
// and a run cut short emits a TRUNCATED list of diagnostics.
//
// This one was found the hard way. This machine OOM-killed a test run mid-flight, the fake
// checker in test/unit/typecheck-gate.test.mjs died partway through writing 240 diagnostics, and
// the ratchet read the surviving 100-odd as debt PAID DOWN and lowered the ceiling. The earlier
// guard only caught a truncation that lost EVERY line; losing most of them looked like progress,
// which is worse, because it is silent and it sticks.
const EXPECTED_EXITS = new Set([0, 1, 2]);
const cutShort = signal !== null || (code !== null && !EXPECTED_EXITS.has(code));

// A CODE DIAGNOSTIC NAMES A PLACE IN THE CODE. tsc reports its OWN failures — an unreadable
// tsconfig (TS5083), no inputs matched (TS18003), a bad flag — in the same `error TSxxxx` form but
// with no `file(line,col):` prefix, and counting those as debt is how a tool that never looked at
// the codebase reported "1 diagnostic — down from 230, ceiling lowered" and exited 0. The prefix
// is the discriminator: a global error is a failure to measure, not a measurement.
const errorLines = out.split('\n').filter((l) => /error TS\d+/.test(l));
const lines = errorLines.filter((l) => /^\s*\S.*\(\d+,\d+\):\s*error TS\d+/.test(l));
const globalErrors = errorLines.filter((l) => !lines.includes(l));
const count = lines.length;

// A RUN THAT DID NOT HAPPEN MUST NEVER REWRITE THE CEILING.
// tsc exits 0 with no diagnostics and non-zero when it reports some. Non-zero WITHOUT any per-file
// diagnostic means the tool itself failed — a bad tsconfig, an OOM, a killed process, a missing
// shim behind a wrapper — and the honest answer is "unknown", which for a gate means fail.
if (spawnError || cutShort || globalErrors.length || (code !== 0 && count === 0)) {
  console.error('typecheck: FAILED — the type checker did not run, so this build is UNMEASURED.');
  console.error(`           ${spawnError
    ? `spawn error: ${spawnError}`
    : cutShort
      ? `tsc was cut short (${signal ? `killed by ${signal}` : `exited ${code}`}) — the ${count} diagnostic(s) it managed to print are a TRUNCATED list, not a measurement`
      : globalErrors.length
        ? `tsc reported ${globalErrors.length} error(s) about its own invocation, not about the code`
        : `tsc exited ${code} with no diagnostics`}`);
  console.error('           The ceiling has NOT been changed. Refusing to report a clean bill for a check that did not happen.');
  for (const l of (globalErrors.length ? globalErrors : out.trim().split('\n')).slice(0, 20)) {
    if (l.trim()) console.error(`  ${l}`);
  }
  process.exit(1);
}

// A FILE THAT DOES NOT PARSE IS NOT A FILE WITH FEW DIAGNOSTICS. TS1xxx is tsc's SYNTAX range: a
// stray backtick or a missing brace stops the parse, everything after it in that file is never
// analysed, and the total COLLAPSES. The ratchet then reads the collapse as progress and writes the
// smaller number to the ceiling — permanently hiding every diagnostic the broken file was masking.
//
// Reproduced, not hypothesised: an edit put a backtick inside a template literal in bin/holt.mjs,
// tsc reported TS1005, the count went 206 -> 3, and this script printed "down from 206 — ceiling
// lowered" and exited 0. That is the THIRD instance of the class named at the top of this file
// (a ratchet that cannot tell "clean" from "did not run"), after the spawn failure and the blind
// checker — so it is closed the same way they were: fatal on its own, never ratcheted.
// NOT "the TS1xxx range" — that range also holds TYPE diagnostics that parse fine. This codebase
// carries four TS1064s ("the return type of an async function must be Promise<T>") as ordinary
// debt, and failing on those would be an over-refusal: the run IS valid, the file DID parse.
// These are the codes where tsc's parser gives up and stops reading the file.
const PARSE_STOPPERS = /error TS(1002|1003|1005|1109|1110|1127|1128|1131|1160|1161|1435):/;
const unparsed = lines.filter((l) => PARSE_STOPPERS.test(l));
if (unparsed.length) {
  console.error(`typecheck: FAILED — ${unparsed.length} syntax error(s). A file that does not parse is not analysed,`);
  console.error('           so this run\'s count is meaningless and the ceiling has NOT been moved.');
  console.error('');
  for (const l of unparsed.slice(0, 10)) console.error(`  ${l}`);
  if (unparsed.length > 10) console.error(`  … and ${unparsed.length - 10} more`);
  process.exit(1);
}

// THE CHECKER MUST BE ABLE TO SEE ITS OWN IMPORTS. TS2591 is "Cannot find name '<module>'" —
// the module did not resolve, so everything imported from it is typed `never` and every
// diagnostic downstream is that one failure echoing. A count measured through a blind checker is
// not a measurement, and the ratchet cannot notice because a blind checker's count is stable.
const blind = lines.filter((l) => /error TS2591/.test(l));
if (blind.length) {
  console.error(`typecheck: FAILED — ${blind.length} module(s) did not resolve, so the checker is blind.`);
  console.error('           Everything imported from them is typed `never`, and the diagnostics below it are noise.');
  console.error('           Usually this means tsconfig.json needs `"types": ["node"]`, or @types/node is not installed.');
  console.error('');
  for (const l of blind.slice(0, 10)) console.error(`  ${l}`);
  if (blind.length > 10) console.error(`  … and ${blind.length - 10} more`);
  process.exit(1);
}

let ceiling = Number.POSITIVE_INFINITY;
try {
  ceiling = Number((await fs.readFile(BASELINE, 'utf8')).trim());
} catch { /* first run */ }

if (!Number.isFinite(ceiling)) {
  await fs.writeFile(BASELINE, `${count}\n`);
  console.log(`typecheck: baseline established at ${count} diagnostic(s).`);
  console.log('           From here the count may go DOWN but never UP.');
  process.exit(0);
}

if (count > ceiling) {
  console.error(`typecheck: FAILED — ${count} diagnostics, ceiling is ${ceiling}.`);
  console.error(`           This change added ${count - ceiling}. The debt may be left alone; it may not grow.`);
  console.error('');
  for (const l of lines.slice(0, 40)) console.error(`  ${l}`);
  if (lines.length > 40) console.error(`  … and ${lines.length - 40} more`);
  process.exit(1);
}

if (count < ceiling) {
  await fs.writeFile(BASELINE, `${count}\n`);
  console.log(`typecheck: ${count} diagnostics — down from ${ceiling}. Ceiling lowered.`);
  process.exit(0);
}

console.log(`typecheck: ${count} diagnostics, at the ceiling. No regression.`);
