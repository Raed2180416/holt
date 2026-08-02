// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — the static-analysis ratchet, graded on the cases where it used to lie.
 *
 * WHY THIS FILE EXISTS. scripts/typecheck.mjs is the gate behind the `static analysis (ratchet)`
 * CI job, and that job was green while the gate could not distinguish "the code is clean" from
 * "the check did not happen". Two reproductions, both against the shipped script:
 *
 *   tsc absent      `node scripts/typecheck.mjs` printed "0 diagnostics — down from 230. Ceiling
 *                   lowered.", REWROTE .typecheck-baseline to 0, and exited 0. One run in an
 *                   environment without the shim — `npm ci --omit=dev`, a corporate mirror, a
 *                   Windows .cmd resolution difference — permanently zeroes the ceiling, and
 *                   every later run passes against it while measuring nothing.
 *
 *   tsc misconfigured  A tsconfig tsc cannot read is reported as `error TS5083`, which matched the
 *                   /error TS\d+/ the script counted diagnostics with. So "the project failed to
 *                   load" was counted as ONE unit of code debt, the ceiling was lowered to 1, and
 *                   the build went green.
 *
 * The class is a gate that treats ABSENCE OF EVIDENCE as EVIDENCE OF ABSENCE, which is the same
 * failure this project's published-numbers gate and its "prove presence before trusting silence"
 * fixture rule exist to prevent. Every case below is one the gate must fail, plus the two it must
 * still pass — because a gate rewritten to fail on everything is not a fix either.
 *
 * The checker is FAKED here, deliberately. Driving the real tsc would test TypeScript; what needs
 * pinning is how the script interprets a checker's exit code and output, and the interesting
 * interpretations are of runs that cannot be produced on demand from a healthy toolchain.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'scripts', 'typecheck.mjs');

/** The fake checker: prints whatever scenario.json says, exits with whatever code it says. */
const FAKE_TSC = `import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const s = JSON.parse(fs.readFileSync(path.join(here, 'scenario.json'), 'utf8'));
// ONE WRITE, AND EXIT ONLY AFTER IT HAS FLUSHED. process.exit() abandons pending asynchronous
// stdout writes, and stdout IS asynchronous when it is a pipe — which it always is here. Writing
// 240 lines in a loop and exiting immediately delivered 172 of them on a CI runner, the gate read
// 172 diagnostics as debt PAID DOWN from 230, and this test failed for a reason that had nothing
// to do with the code under test. Which is, with some irony, the exact truncation class the test
// exists to catch.
process.stdout.write(s.lines.map((l) => l + '\\n').join(''), () => process.exit(s.exit));
`;

/**
 * A scratch project holding a COPY of the real script (its ROOT is derived from its own location,
 * so it has to live beside the fixture) and a fake tsc on the path it looks for.
 */
async function project(t, { withTsc = true } = {}) {
  const dir = await fs.mkdtemp(path.join(process.env.HOLT_TMPDIR || os.tmpdir(), 'holt-ratchet-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));

  await fs.mkdir(path.join(dir, 'scripts'), { recursive: true });
  await fs.mkdir(path.join(dir, 'node_modules', '.bin'), { recursive: true });
  await fs.copyFile(SCRIPT, path.join(dir, 'scripts', 'typecheck.mjs'));

  if (withTsc) {
    const bin = path.join(dir, 'node_modules', '.bin');
    await fs.writeFile(path.join(bin, 'fake-tsc.mjs'), FAKE_TSC);
    // Both shims, always — the script picks tsc.cmd on win32 and tsc elsewhere, and a fixture that
    // only works on the grader's platform is how the cross-platform defects in this repo survived.
    await fs.writeFile(path.join(bin, 'tsc'), '#!/bin/sh\nexec node "$(dirname "$0")/fake-tsc.mjs" "$@"\n', { mode: 0o755 });
    await fs.writeFile(path.join(bin, 'tsc.cmd'), '@node "%~dp0fake-tsc.mjs" %*\r\n');
    await fs.chmod(path.join(bin, 'tsc'), 0o755).catch(() => {});
  }

  return {
    dir,
    async scenario(lines, exit) {
      await fs.writeFile(path.join(dir, 'node_modules', '.bin', 'scenario.json'),
        JSON.stringify({ lines, exit }));
    },
    async setBaseline(n) { await fs.writeFile(path.join(dir, '.typecheck-baseline'), `${n}\n`); },
    async baseline() { return (await fs.readFile(path.join(dir, '.typecheck-baseline'), 'utf8')).trim(); },
    run() {
      return new Promise((resolve) => {
        execFile(process.execPath, [path.join(dir, 'scripts', 'typecheck.mjs')], {
          cwd: dir, timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
        }, (err, stdout, stderr) => resolve({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          out: `${stdout}${stderr}`,
        }));
      });
    },
  };
}

const REAL = (n) => Array.from({ length: n }, (_, i) => `src/a.mjs(${i + 1},1): error TS2339: Property 'x' does not exist on type 'never'.`);

/* -------------------------------------------------- must FAIL, must not rewrite ---- */

test('RATCHET: a tsc that cannot be spawned is UNMEASURED, never clean', async (t) => {
  const p = await project(t, { withTsc: false });
  await p.setBaseline(230);
  // No shim on disk at all: the honest answer is "typescript is not installed", which is a real
  // and benign contributor state — but it must never be confused with "zero diagnostics".
  const r = await p.run();
  assert.equal(await p.baseline(), '230', 'the ceiling must not move when nothing was measured');
  assert.match(r.out, /not installed/i, r.out);
  assert.doesNotMatch(r.out, /Ceiling lowered/, `a check that did not run must not claim progress: ${r.out}`);
});

test('RATCHET: tsc failing to load the project is UNMEASURED, never a debt of 1', async (t) => {
  const p = await project(t);
  await p.setBaseline(230);
  await p.scenario(['error TS5083: Cannot read file tsconfig.json.'], 3);
  const r = await p.run();
  assert.equal(r.code, 1, `a failure to measure must fail the build: ${r.out}`);
  assert.equal(await p.baseline(), '230', 'and must not rewrite the ceiling');
  assert.match(r.out, /UNMEASURED/, r.out);
});

test('RATCHET: "no inputs were found" is a failure to measure, not a clean codebase', async (t) => {
  const p = await project(t);
  await p.setBaseline(230);
  // The shape a broken `include` glob produces — and the one that would zero the ceiling the
  // instant someone moved src/ or renamed a directory.
  await p.scenario(['error TS18003: No inputs were found in config file.'], 1);
  const r = await p.run();
  assert.equal(r.code, 1, r.out);
  assert.equal(await p.baseline(), '230');
});

test('RATCHET: exit non-zero with NO diagnostics at all is a failure to measure', async (t) => {
  const p = await project(t);
  await p.setBaseline(230);
  await p.scenario([], 137); // OOM-killed
  const r = await p.run();
  assert.equal(r.code, 1, r.out);
  assert.equal(await p.baseline(), '230');
  assert.match(r.out, /UNMEASURED/, r.out);
});

test('RATCHET: a checker that cannot resolve its imports is blind, and blind is fatal', async (t) => {
  const p = await project(t);
  await p.setBaseline(230);
  // TS2591 means the module did not resolve, so everything imported from it is `never` and every
  // diagnostic underneath is that one failure echoing. This shipped: tsconfig had no `types`
  // field, 133 of 362 diagnostics were this, and the ratchet was green because a blind checker's
  // count is perfectly stable.
  await p.scenario([
    "src/a.mjs(1,10): error TS2591: Cannot find name 'node:fs/promises'.",
    ...REAL(5),
  ], 2);
  const r = await p.run();
  assert.equal(r.code, 1, r.out);
  assert.equal(await p.baseline(), '230', 'a blind run must not rewrite the ceiling');
  assert.match(r.out, /blind/i, r.out);
  assert.match(r.out, /types.*node|@types\/node/, `the message must name the fix: ${r.out}`);
});

test('RATCHET: a checker cut short mid-output is TRUNCATED, not progress', async (t) => {
  // FOUND BY THE MACHINE, NOT BY REVIEW. An OOM killed a full test run here; the fake checker
  // below died partway through writing 240 diagnostics; the ratchet counted the ~100 that reached
  // stdout, called it "down from 230", and lowered the ceiling permanently. The earlier guard
  // only caught a truncation that lost EVERY line — losing MOST of them read as progress, which
  // is the worse failure because it is silent and it sticks.
  //
  // tsc exits 0, 1 or 2. A signal or any other code means the run was cut short, whatever it
  // managed to print first.
  const p = await project(t);
  await p.setBaseline(230);
  await p.scenario(REAL(100), 137); // 137 = SIGKILL, the OOM killer's signature
  const r = await p.run();
  assert.equal(r.code, 1, `a truncated run must fail, not ratchet: ${r.out}`);
  assert.equal(await p.baseline(), '230', 'and must not adopt the truncated count as the new ceiling');
  assert.match(r.out, /TRUNCATED/, r.out);
});

test('RATCHET: growth still fails — the original contract', async (t) => {
  const p = await project(t);
  await p.setBaseline(230);
  await p.scenario(REAL(240), 2);
  const r = await p.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /added 10/, r.out);
  assert.equal(await p.baseline(), '230', 'a failing run must not adopt the worse number as the new ceiling');
});

/* ---------------------------------------------- must still PASS (never-worse) ---- */

test('RATCHET: ANTI-VACUITY — real debt paid down still lowers the ceiling', async (t) => {
  // Without this, every assertion above is satisfied by a script that exits 1 unconditionally.
  const p = await project(t);
  await p.setBaseline(230);
  await p.scenario(REAL(3), 2);
  const r = await p.run();
  assert.equal(r.code, 0, r.out);
  assert.equal(await p.baseline(), '3', 'paying debt down must still ratchet');
  assert.match(r.out, /down from 230/, r.out);
});

test('RATCHET: ANTI-VACUITY — a genuinely clean run at exit 0 is accepted', async (t) => {
  const p = await project(t);
  await p.setBaseline(230);
  await p.scenario([], 0); // tsc's own success shape: no output, exit 0
  const r = await p.run();
  assert.equal(r.code, 0, r.out);
  assert.equal(await p.baseline(), '0', 'zero diagnostics from a checker that RAN is real progress');
});

test('RATCHET: holding at the ceiling is neither progress nor regression', async (t) => {
  const p = await project(t);
  await p.setBaseline(4);
  await p.scenario(REAL(4), 2);
  const r = await p.run();
  assert.equal(r.code, 0, r.out);
  assert.equal(await p.baseline(), '4');
  assert.match(r.out, /at the ceiling/, r.out);
});
