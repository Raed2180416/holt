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
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { standardFixture, newRepo } from '../fixtures.mjs';
import { BRIEF_REFRESH_AFTER, buildBrief, evictCacheFiles } from '../../src/agent.mjs';

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

function hookWithPayload(event, host, cwd, payload) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, 'hook', event, '--host', host, '--cwd', cwd], {
      cwd,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', LC_ALL: 'C' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

/** The context string a host would actually splice into the agent's transcript, or null. */
test('CACHE: eviction bounds holt cache files without touching unrelated scratch files', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-cache-evict-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (let i = 0; i < 5; i++) {
    await fs.writeFile(path.join(dir, `holt-cache-${String(i).padStart(16, '0')}.json`), '{}');
  }
  await fs.writeFile(path.join(dir, 'holt-cache-not-a-key.json'), '{}');
  await fs.writeFile(path.join(dir, 'keep.txt'), 'keep');

  const result = await evictCacheFiles(dir, { maxFiles: 2, maxAgeMs: Number.POSITIVE_INFINITY });
  assert.equal(result.removed, 3);
  const remaining = await fs.readdir(dir);
  assert.equal(remaining.filter((name) => name.startsWith('holt-cache-') && name.endsWith('.json')).length, 3,
    'two valid cache files plus the non-key control must remain');
  assert.ok(remaining.includes('keep.txt'), 'eviction must not touch unrelated scratch files');
});

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

test('BRIEF: redundant uncommitted holders are unsafe without falsely claiming one deletion loses the bytes',
  async (t) => {
    const fx = await newRepo('brief-no-durable-copy');
    t.after(() => fx.cleanup());
    const a = await fx.worktree('holder-a');
    const b = await fx.worktree('holder-b');
    await fx.write('same-only.txt', 'same uncommitted bytes\n', a);
    await fx.write('same-only.txt', 'same uncommitted bytes\n', b);

    const brief = await buildBrief(fx.root);
    assert.match(brief ?? '', /no durable copy proven.*automatic deletion is unsafe/i,
      `the brief must state the actual authority boundary: ${brief}`);
    assert.doesNotMatch(brief ?? '', /deleting them loses it/i,
      'deleting either one leaves the identical bytes in its sibling; the brief must not overclaim immediate loss');
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

test('CODEX BRIEF: UserPromptSubmit uses additionalContext once, then emits no unchanged prompt noise',
  async (t) => {
    const { fx } = await standardFixture();
    t.after(() => fx.cleanup());

    const prompt = () => sh(process.execPath,
      [BIN, 'hook', 'user-prompt-submit', '--host', 'codex', '--cwd', fx.root], fx.root);

    const first = await prompt();
    assert.equal(first.code, 0, `Codex prompt hook must succeed: ${first.stderr}`);
    const parsed = JSON.parse(first.stdout);
    assert.equal(parsed.hookSpecificOutput?.hookEventName, 'UserPromptSubmit');
    assert.ok(parsed.hookSpecificOutput?.additionalContext?.includes('holt'),
      `Codex must receive proactive sibling context in its documented field: ${first.stdout}`);
    assert.ok(!('context' in parsed), 'Codex does not consume Holt\'s generic context envelope');

    const unchanged = await prompt();
    assert.equal(unchanged.code, 0, `unchanged Codex prompt hook must remain successful: ${unchanged.stderr}`);
    assert.equal(unchanged.stdout.trim(), '',
      'a repeated unchanged user prompt must not receive the same sibling briefing again');
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

/* --------------------------------------------------- Stop / SessionEnd hooks ---- */
//
// Claude Stop has no non-blocking model-context channel. Cursor Stop does, but its documented
// `followup_message` starts another loop rather than passively injecting context. The contract is
// therefore host-specific and bounded: completed loop zero + changed brief, once.
//
// SessionEnd is advisory-only — it cannot block, but it warns on stderr.

test('CLAUDE STOP: a stale/manual invocation cannot relabel continuation feedback as passive context',
  async (t) => {
    const { fx } = await standardFixture();
    t.after(() => fx.cleanup());

    const result = await hookWithPayload('stop', 'claude-code', fx.root, {
      cwd: fx.root, stop_hook_active: false,
    });
    assert.equal(result.code, 0, `retired Claude Stop must remain non-disruptive: ${result.stderr}`);
    assert.equal(result.stdout.trim(), '',
      'Claude Stop context continues the conversation; a stale hook must not force that continuation');
  });

test('CURSOR STOP: a clean repo returns the documented empty response', async (t) => {
  const fx = await newRepo();
  t.after(() => fx.cleanup());

  const result = await hookWithPayload('stop', 'cursor', fx.root, {
    cwd: fx.root, status: 'completed', loop_count: 0,
  });
  assert.equal(result.code, 0, `Cursor Stop must exit 0: ${result.stderr}`);
  assert.deepEqual(JSON.parse(result.stdout), {}, 'no actionable brief means no follow-up prompt');
});

test('CURSOR STOP: followup_message is completed-only, one-loop-bounded, and change-suppressed',
  async (t) => {
    const { fx } = await standardFixture();
    t.after(() => fx.cleanup());

    const stop = (payload) => hookWithPayload('stop', 'cursor', fx.root, { cwd: fx.root, ...payload });

    // These controls run before the eligible case. If either consumed the brief cache, the
    // eligible call below would be silent and expose the mistake.
    const aborted = await stop({ status: 'aborted', loop_count: 0 });
    assert.deepEqual(JSON.parse(aborted.stdout), {}, 'aborted turns must never restart the agent');
    const followupLoop = await stop({ status: 'completed', loop_count: 1 });
    assert.deepEqual(JSON.parse(followupLoop.stdout), {},
      'the Stop caused by Holt\'s own follow-up must not cause another follow-up');

    const eligible = await stop({ status: 'completed', loop_count: 0 });
    assert.equal(eligible.code, 0, `eligible Cursor Stop must succeed: ${eligible.stderr}`);
    const body = JSON.parse(eligible.stdout);
    assert.match(body.followup_message ?? '', /holt/i,
      `changed at-risk state must use Cursor's documented followup_message: ${eligible.stdout}`);
    assert.ok(!('context' in body) && !('additionalContext' in body),
      'Cursor does not consume Claude/generic context envelopes at Stop');

    const unchanged = await stop({ status: 'completed', loop_count: 0 });
    assert.deepEqual(JSON.parse(unchanged.stdout), {},
      'an identical brief must not restart the agent on every completed response');
  });

test('SESSION-END: at-risk work produces a warning on stderr (advisory, non-blocking)', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const { spawn } = await import('node:child_process');
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, 'hook', 'session-end', '--host', 'claude-code', '--cwd', fx.root], {
      cwd: fx.root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', LC_ALL: 'C' },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => stdout += d);
    child.stderr.on('data', (d) => stderr += d);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.write(JSON.stringify({ cwd: fx.root }));
    child.stdin.end();
  });

  // SessionEnd is advisory — it should not block (exit 0) but should warn on stderr.
  assert.equal(result.code, 0, `session-end must not block, got exit ${result.code}. stderr: ${result.stderr}`);
  assert.ok(result.stderr.length > 0, 'session-end with at-risk work should warn on stderr');
  assert.match(result.stderr, /holt/i, 'should mention holt in the warning');
});

test('SESSION-END: a clean repo produces no warning', async (t) => {
  const fx = await newRepo();
  t.after(() => fx.cleanup());

  const { spawn } = await import('node:child_process');
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, 'hook', 'session-end', '--host', 'claude-code', '--cwd', fx.root], {
      cwd: fx.root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', LC_ALL: 'C' },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => stdout += d);
    child.stderr.on('data', (d) => stderr += d);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.write(JSON.stringify({ cwd: fx.root }));
    child.stdin.end();
  });

  assert.equal(result.code, 0, `session-end on clean repo must exit 0, got exit ${result.code}`);
  assert.equal(result.stderr, '', 'session-end on a clean repo should produce no warning');
});
