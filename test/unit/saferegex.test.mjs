/*
 * A USER REGEX MUST NOT BE ABLE TO FREEZE HOLT.
 *
 * `.holtrc.json`'s `familyOverrides` are regexes matched against worktree names. Catastrophic
 * backtracking inside `String.match` is an uninterruptible loop — no timeout, no signal, no
 * try/catch reaches it — so a pattern a teammate committed hangs every holt command, including
 * the PreToolUse guard that blocks destructive commands. An agent frozen forever, by a config file.
 *
 * `hasNestedQuantifier` refuses the textbook `(a+)+` shape and is kept, but it is a heuristic over
 * a question with no complete syntactic answer, and its bypasses are ordinary. These tests pin the
 * REAL guarantee: whatever the pattern, the match happens somewhere that can be killed.
 *
 * The over-refusal control matters as much as the hang test. Declining every pattern would pass a
 * "does not hang" assertion while breaking every user who has a working config.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { screenOverrides, SCREEN_TIMEOUT_MS } from '../../src/saferegex.mjs';
import { hasNestedQuantifier } from '../../src/config.mjs';
import { assignFamilies } from '../../src/discover.mjs';

// A 41-character subject with a failing tail. Nothing exotic — an ordinary long worktree name.
const ADVERSARIAL_NAME = `${'a'.repeat(40)}X`;
// Bypasses hasNestedQuantifier (its group body holds no quantifier) and measured at ~10s inline.
const UNBOUNDED = '^(a|a?)+$';

test('SAFEREGEX: the static check alone does NOT catch this pattern (so the thread is the guarantee)', () => {
  // If this ever starts returning true the static check improved, which is welcome — but then this
  // test file is measuring the wrong thing and needs a pattern that still slips through.
  assert.equal(hasNestedQuantifier(UNBOUNDED), false,
    'premise: this test only proves anything while the pattern bypasses the static check');
});

test('SAFEREGEX: an unbounded pattern is declined inside the budget instead of hanging', async () => {
  const declined = [];
  const t0 = Date.now();
  const safe = await screenOverrides([UNBOUNDED], [ADVERSARIAL_NAME], {
    onDeclined: (d) => declined.push(...d),
  });
  const elapsed = Date.now() - t0;

  assert.deepEqual(safe, [], 'a pattern that did not finish must never be handed back to run inline');
  assert.deepEqual(declined, [UNBOUNDED], 'the declined pattern must be reported, not dropped silently');
  // Inline this same match took ~10s. The budget is 2s; allow generous slack for a loaded CI box
  // while still failing loudly if the screen is actually running to completion.
  assert.ok(elapsed < SCREEN_TIMEOUT_MS * 3,
    `screening must be bounded by the budget, took ${elapsed}ms`);
});

test('SAFEREGEX: a legitimate override survives screening untouched', async () => {
  const declined = [];
  const patterns = ['^(a+)X$', '^(feat|fix)-', '^agent-(\\d+)$'];
  const safe = await screenOverrides(patterns, [ADVERSARIAL_NAME, 'agent-3', 'feat-login'], {
    onDeclined: (d) => declined.push(...d),
  });
  assert.deepEqual(safe, patterns, 'ordinary patterns must all survive — over-refusal is its own bug');
  assert.deepEqual(declined, [], 'nothing may be reported as declined when nothing was');
});

test('SAFEREGEX: no overrides costs nothing and spawns nothing', async () => {
  const t0 = Date.now();
  assert.deepEqual(await screenOverrides([], ['whatever']), []);
  assert.deepEqual(await screenOverrides(undefined, ['whatever']), []);
  // A worker spawn is ~30ms+. This path must not reach one at all.
  assert.ok(Date.now() - t0 < 25, 'the common path must not start a thread');
});

test('SAFEREGEX: with no names to match, patterns pass through unscreened', async () => {
  // Nothing to hang ON. Screening an empty subject set would spawn a thread to prove nothing.
  assert.deepEqual(await screenOverrides([UNBOUNDED], []), [UNBOUNDED]);
});

/* --------------------------------------------------------------- end to end ---- */

const gitIn = (args, cwd) => new Promise((res) => {
  execFile('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'holt test', GIT_AUTHOR_EMAIL: 'test@holt.invalid',
      GIT_COMMITTER_NAME: 'holt test', GIT_COMMITTER_EMAIL: 'test@holt.invalid',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', LC_ALL: 'C',
    },
  }, (e, so, se) => res({ code: e?.code ?? 0, out: String(so ?? ''), err: String(se ?? '') }));
});

test('SAFEREGEX: assignFamilies does not hang on an unbounded override', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-redos-e2e-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }).catch(() => {}));
  await gitIn(['init', '-q', '-b', 'main'], root);
  await fs.writeFile(path.join(root, 'a.js'), 'export const a = 1;\n');
  await gitIn(['add', '-A'], root);
  await gitIn(['commit', '-qm', 'base'], root);

  const t0 = Date.now();
  const out = await assignFamilies(root, [{ id: ADVERSARIAL_NAME, path: root, isPrimary: false }], {
    familyOverrides: [UNBOUNDED],
  });
  const elapsed = Date.now() - t0;

  assert.equal(out.length, 1, 'the scan must still produce a result for every workstream');
  assert.notEqual(out[0].familyRule, 'user-override',
    'a declined pattern must not be reported as having matched');
  // THE BOUND MUST SIT BELOW THE INLINE COST, or removing the screen would still pass. Matching
  // this pattern on this name inline measured ~10s; the screen caps at SCREEN_TIMEOUT_MS and the
  // rest is git. Anything in between separates "screened" from "ran it on this thread".
  assert.ok(elapsed < SCREEN_TIMEOUT_MS * 2.5,
    `assignFamilies must bound the user regex, took ${elapsed}ms`);
});
