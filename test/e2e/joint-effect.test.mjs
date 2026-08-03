/**
 * holt — JOINT EFFECT: a command's targets are removed TOGETHER.
 *
 * THE DEFECT THIS FILE EXISTS TO PIN.
 *
 * holt evaluates each target of a command independently, against the state in which the OTHER
 * targets still exist. Two worktrees can hold the same content that exists nowhere else: either may
 * be deleted safely, because the other still holds it. Deleting BOTH loses the work.
 *
 * Asked one at a time, holt gets this exactly right — the first is allowed, and once it is gone the
 * second is refused, because it has become the only copy. Asked as ONE command naming both, holt
 * allows it, and the work is gone.
 *
 *     rm -rf <a>                          -> allow   CORRECT (the twin survives)
 *     rm -rf <a>; then later rm -rf <b>   -> deny    CORRECT (b is now the only copy)
 *     rm -rf <a> <b>                      -> ALLOW   ← both destroyed, in one command
 *     rm -rf <glob matching both>         -> ALLOW   ← both destroyed
 *     rm -rf <a> && rm -rf <b>            -> ALLOW   ← both destroyed
 *
 * This is not a parsing gap and not a stale cache. holt reads every one of these commands
 * correctly, and `holt gate` names the twin ("DUPLICATE — the same work is also in <other>") for
 * both. The model simply has no notion that a command's targets go together, so it answers a
 * question nobody asked: "is this target safe to delete *given everything else still exists*".
 *
 * MEASURED, NOT THEORISED. Found by a Haiku agent doing the ordinary gauntlet cleanup task with
 * holt installed: it deleted both halves of the duplicated pair in one sweep and the trial graded
 * LOST — "DESTROYED: dup-ledger (both copies)". Every sibling trial that instead used `holt clean`
 * kept one copy and scored 0.89 utility, because `clean` re-verifies each worktree immediately
 * before removing it. The acting command is right; the guard in front of it is not.
 *
 * THE FIX SHAPE: resolve ALL targets first, then ask the question ONCE against the post-state —
 * "after this whole command runs, does any content exist nowhere?" — instead of once per target
 * against the pre-state.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { standardFixture } from '../fixtures.mjs';
import { assessCommand } from '../../src/agent.mjs';

/** Repo-relative, forward-slash. Native separators become escape sequences in generated commands. */
const rel = (from, to) => path.relative(from, to).split(path.sep).join('/');

// This was marked `todo` while the defect was open, and the flag came off when the fix landed —
// which was always the plan: the moment the guard reasons about a command's targets jointly, this
// becomes a hard gate rather than a note.
//
// THE FIX, for whoever reads this next: `assessWorktreeCommand` judges each match independently and
// takes the strongest verdict, which is the right question for one target and the wrong one for a
// command. It now also unions every match's resolved workstreams with the workstream containing
// each resolved PATH — because `rm -rf a b` is ONE match with two operands, while `rm -rf a && rm
// -rf b` is two matches — and refuses when that union covers a workstream together with every
// sibling named in its `redundantWith`. No new analysis: `redundantWith` is already published by
// `holt risk --json`, printed by the TUI, and re-verified by `holt clean`.
test('JOINT EFFECT: one command may not destroy every copy of content that exists nowhere else', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const a = rel(fx.root, fx.wt('alpha-1'));
  const b = rel(fx.root, fx.wt('beta-1'));

  // ANTI-VACUITY FIRST. If these two are not actually a recognised duplicate pair, every assertion
  // below passes for the wrong reason — which is exactly what happened to an earlier version of
  // the corpus that built the pair as untracked files: it reported a clean sweep while measuring
  // nothing. Deleting ONE copy must be ALLOWED, or there is no joint-effect scenario here at all.
  for (const [cmd, why] of [
    [`rm -rf ${a}`, 'one copy of a duplicated pair — the twin still holds the content'],
    [`rm -rf ${b}`, 'the other copy, alone'],
  ]) {
    const v = await assessCommand(cmd, fx.root);
    assert.equal(v.decision, 'allow',
      `PREMISE BROKEN — these must be a duplicate pair for this test to mean anything. ${why}: `
      + `${cmd} -> ${v.decision} (${v.reason})`);
  }

  // THE DEFECT. Every one of these removes both copies with a single command.
  for (const [cmd, shape] of [
    [`rm -rf ${a} ${b}`, 'two operands on one rm'],
    [`rm -rf ${a} && rm -rf ${b}`, 'chained with &&'],
    [`rm -rf ${a}; rm -rf ${b}`, 'chained with ;'],
    [`git worktree remove --force ${a} && git worktree remove --force ${b}`, 'chained git verb'],
    [`for d in ${a} ${b}; do rm -rf "$d"; done`, 'a loop over both'],
    [`bash -c "rm -rf ${a} ${b}"`, 'two operands inside a shell'],
    // A GLOB IS ONE PATH THAT NAMES MANY, and it was the last spelling still allowed after every
    // other one on this list was closed. It failed a whole layer earlier than the rest: the cheap
    // `targetIsWorktree` pre-check resolved the pattern as if it were a literal path, matched no
    // worktree root, and the entire worktree layer stood aside — so the joint-effect check never
    // ran at all. Invisible until here, because whenever the content IS unique the file layer
    // refuses the same command and nobody notices which layer answered.
    [`rm -rf ${a.replace(/[^/]+$/, '')}*-1`, 'one glob matching both'],
  ]) {
    const v = await assessCommand(cmd, fx.root);
    assert.notEqual(v.decision, 'allow',
      `a single command destroying EVERY copy must not be allowed (${shape}): ${cmd} -> ${v.reason}`);
  }
});

test('JOINT EFFECT: NEVER-WORSE — ordinary multi-target commands stay allowed', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const a = rel(fx.root, fx.wt('alpha-1'));
  const empty = rel(fx.root, fx.wt('empty'));

  // The fix must not become "refuse anything with more than one operand". Multi-target commands are
  // ordinary — `rm -rf dist build coverage` is a line every developer types — and a guard that
  // refuses them is the over-refusal half of the same defect, which costs all of the protection
  // rather than some of it.
  for (const cmd of [
    'rm -rf dist build coverage',
    'rm -rf node_modules .next',
    `rm -rf ${empty}`,
    `rm -rf ${a} dist`,               // one copy of a pair PLUS a junk directory: still fine
    'rm -f a.log b.log c.log',
    'for d in dist build; do rm -rf "$d"; done',
    // The glob half of never-worse: a pattern that reaches only a provably disposable worktree must
    // stay allowed, or the fix above becomes "refuse every glob" — which would refuse `rm -rf
    // build/*` in any repository and is the over-refusal this whole file exists to rule out.
    `rm -rf ${empty.replace(/[^/]+$/, '')}empt*`,
    'rm -rf dist/*',
    'rm -rf ./build/*.map',
  ]) {
    const v = await assessCommand(cmd, fx.root);
    assert.equal(v.decision, 'allow',
      `ordinary multi-target cleanup must stay allowed: ${cmd} -> ${v.decision} (${v.reason})`);
  }
});

test('JOINT EFFECT: sequential deletion is already correct and must stay correct', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const a = fx.wt('alpha-1');
  const b = rel(fx.root, fx.wt('beta-1'));

  // The half holt already gets right, pinned so a fix for the joint case cannot regress it: once
  // the first copy is genuinely gone from disk, the second is the only copy and must be refused.
  const before = await assessCommand(`rm -rf ${b}`, fx.root);
  assert.equal(before.decision, 'allow', `while its twin exists, one copy is disposable: ${before.reason}`);

  await (await import('node:fs/promises')).rm(a, { recursive: true, force: true });

  const after = await assessCommand(`rm -rf ${b}`, fx.root);
  assert.notEqual(after.decision, 'allow',
    `once the twin is gone, the survivor holds the only copy and must be protected: ${after.reason}`);
});
