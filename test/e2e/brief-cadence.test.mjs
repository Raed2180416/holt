// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — WHEN the brief speaks, not just what it says.
 *
 * `holt integrate` wires UserPromptSubmit, which fires on EVERY message a person sends to their
 * agent. Two defects lived there, and both were invisible from the source because the shape of the
 * output was correct in each case:
 *
 *   1. `protectLine + await buildBrief(cwd)` — buildBrief returns null when there is nothing to
 *      report, and `'' + null` is the four-character string "null". Every session started in a
 *      clean repository handed the agent `additionalContext: "null"` as its workstream briefing.
 *      Reproduced against the previous commit's binary:
 *        {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"null"}}
 *
 *   2. The same paragraph, byte for byte, was re-injected on every single turn. That is not a
 *      reminder — repetition with no new information is what teaches a reader to skip a source,
 *      and it spends context on every prompt of a long session.
 *
 * The fix for (2) has its own failure mode, so it is pinned too: a brief that goes silent forever
 * leaves a context-compacted session permanently unaware of work holt is actively protecting.
 * Silence is therefore bounded, never permanent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { standardFixture, newRepo } from '../fixtures.mjs';
import { BRIEF_REFRESH_AFTER } from '../../src/agent.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'holt.mjs');

function sh(cmd, args, cwd) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, {
      cwd, timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', LC_ALL: 'C' },
    }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? -1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }));
    child.stdin?.end();
  });
}

/** The context string a host would actually splice into the agent's transcript, or null. */
function contextOf(stdout) {
  const s = stdout.trim();
  if (!s) return null;
  const parsed = JSON.parse(s);
  return parsed.hookSpecificOutput?.additionalContext
    ?? parsed.additionalContext
    ?? parsed.context
    ?? null;
}

test('BRIEF: a repository with nothing to report says NOTHING, not the word "null"', async (t) => {
  const fx = await newRepo();
  t.after(() => fx.cleanup());

  for (const event of ['session-start', 'user-prompt-submit']) {
    const r = await sh(process.execPath, [BIN, 'hook', event, '--host', 'claude-code', '--cwd', fx.root], fx.root);
    assert.equal(r.code, 0, `${event} must exit 0: ${r.stderr}`);

    const ctx = contextOf(r.stdout);
    // The assertion that matters is the specific one: "null" is not a falsy value here, it is a
    // four-character string that reads as a briefing. A generic truthiness check passes it.
    assert.notEqual(ctx, 'null', `${event} handed the agent the literal string "null" as its briefing`);
    assert.ok(ctx === null || ctx.includes('holt'),
      `${event} emitted something that is neither silence nor a holt brief: ${JSON.stringify(ctx)}`);
  }
});

test('BRIEF: the per-prompt hook speaks once, then stays quiet until something changes', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const prompt = () => sh(process.execPath,
    [BIN, 'hook', 'user-prompt-submit', '--host', 'claude-code', '--cwd', fx.root], fx.root);

  const first = await prompt();
  const firstCtx = contextOf(first.stdout);
  // Anti-vacuity: if the fixture had nothing to say, every assertion below would pass for the
  // wrong reason. The suppression can only be observed against a brief that exists.
  assert.ok(firstCtx && firstCtx.includes('holt'),
    `the fixture must produce a brief for suppression to mean anything: ${JSON.stringify(firstCtx)}`);

  const second = await prompt();
  assert.equal(contextOf(second.stdout), null,
    'the identical brief was re-injected on the very next prompt with nothing changed');

  // ...and silence must be earned by sameness, not by having spoken once. Suppression is keyed on
  // the brief TEXT, so the change has to be one the brief actually reports: a new worktree holding
  // work that exists only as uncommitted changes is the headline line of the brief. (An EMPTY new
  // worktree correctly changes nothing here — it holds nothing base lacks, so there is nothing new
  // to say about it, and that is the design rather than a miss.)
  const extra = path.join(fx.root, '..', 'wt-brief-cadence');
  await sh('git', ['worktree', 'add', '-b', 'brief-cadence-new', extra, 'HEAD'], fx.root);
  await fs.writeFile(path.join(extra, 'only-here.txt'), 'exists nowhere else\n', 'utf8');
  const third = await prompt();
  const thirdCtx = contextOf(third.stdout);
  assert.ok(thirdCtx && thirdCtx !== firstCtx,
    'the repository changed and the brief stayed silent — suppression is hiding new information');
});

test('BRIEF: silence is bounded — an unchanged repository is re-briefed, never abandoned', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const prompt = () => sh(process.execPath,
    [BIN, 'hook', 'user-prompt-submit', '--host', 'claude-code', '--cwd', fx.root], fx.root);

  const first = contextOf((await prompt()).stdout);
  assert.ok(first && first.includes('holt'), 'the fixture must produce a brief');

  // A session whose context was compacted has lost the first brief. If holt never repeats itself,
  // that session is permanently unaware of worktrees holt is holding locks on.
  let spoke = 0;
  for (let i = 0; i < BRIEF_REFRESH_AFTER + 1; i++) {
    if (contextOf((await prompt()).stdout) !== null) spoke++;
  }
  assert.equal(spoke, 1,
    `over ${BRIEF_REFRESH_AFTER + 1} unchanged prompts the brief must repeat exactly once, spoke ${spoke} times`);
});

test('BRIEF: SessionStart is never suppressed — a new session has seen nothing', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const start = () => sh(process.execPath,
    [BIN, 'hook', 'session-start', '--host', 'claude-code', '--cwd', fx.root], fx.root);

  const a = contextOf((await start()).stdout);
  const b = contextOf((await start()).stdout);
  assert.ok(a && a.includes('holt'), 'the fixture must produce a brief');
  assert.equal(b, a, 'a second session was told nothing because a previous session had been told');
});
