/**
 * holt — WHERE THE GUARD'S AUTHORITY COMES FROM.
 *
 * The existing tests cover the escape hatch WORKING: config.test.mjs parses `guardAllow`,
 * cli.test.mjs proves its use is journalled, integration.test.mjs proves it is explicit and
 * observable. This file covers the other half — that it authorises ONLY what a human reviewed, and
 * that it cannot be supplied by the repository itself.
 *
 * TWO DEFECTS, BOTH REPRODUCED THROUGH THE LIVE HOOK — BOTH NOW CLOSED, AND THESE ARE HARD GATES.
 *
 * They were written as `todo` while they were open, which was right at the time and wrong the
 * moment the fixes landed: the flags outlived the defects by several commits. A `todo` test
 * ASSERTS NOTHING — node:test reports it as a pass whatever the code does — so for that whole
 * window the suite advertised two known holes it no longer had, and, far worse, neither defect
 * would have made a single test fail if it came back. The flags came off when the behaviour was
 * re-measured directly (all seven assertions below already passed), which is the only evidence
 * that should ever remove one.
 *
 * The description of each defect is kept in full, because the shape of an attack is worth more
 * than the record that it was fixed.
 *
 * (1) THE APPROVAL LEAKS TO AN UNBOUNDED FAMILY. With `{"guardAllow": ["rm -rf dist"]}`:
 *
 *         rm -rf dist                          -> allow   (correct, this is what was approved)
 *         rm -rf <protected worktree>          -> deny    (correct, the control)
 *         rm -rf dist; rm -rf <protected>      -> ALLOW   ← never reviewed, runs anyway
 *         rm -rf <protected> # rm -rf dist     -> ALLOW   ← a COMMENT disables the guard
 *
 *     The patterns config.test.mjs uses are ANCHORED (`^git status$`, `^rm -rf /tmp/`), so the
 *     design clearly intended anchoring. But unanchored patterns are accepted and applied as a
 *     substring test against the whole command — and holt's own refusal message invites exactly the
 *     unanchored form: "add a matching guardAllow pattern to .holtrc.json".
 *
 * (2) THE REPOSITORY CAN SUPPLY THE AUTHORITY. `.holtrc.json` is read from the repository root, so
 *     a repository you CLONE can ship `{"guardAllow": ["rm"]}` and the guard stops blocking `rm`
 *     entirely. No prompt, no agent-visible warning, an after-the-fact journal line reading
 *     `allowlisted`. Measured against a real worktree holding 16 uncommitted-only symbols: exit 0.
 *
 *     src/config.mjs already treats this file as UNTRUSTED for ReDoS ("a config file a teammate
 *     committed") while treating it as fully TRUSTED for authority. The intent was there; only half
 *     of it was implemented.
 *
 * NOT HYPOTHETICAL. In a gauntlet trial, a Haiku agent blocked from deleting protected work went
 * and wrote guardAllow entries into `.holtrc.json` to override the guard — unprompted, as its
 * obvious next step, because the refusal message told it to. It failed only because its patterns
 * did not match. That is the escape hatch being used as an attack by an agent that was not even
 * trying to attack.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { standardFixture } from '../fixtures.mjs';
import { assessCommand } from '../../src/agent.mjs';

const rel = (from, to) => path.relative(from, to).split(path.sep).join('/');

test('CONFIG AUTHORITY: an approval covers the reviewed command and nothing else',
  async (t) => {
    const { fx } = await standardFixture();
    t.after(() => fx.cleanup());
    const wt = rel(fx.root, fx.wt('uniqueUncommitted'));

    await fs.writeFile(path.join(fx.root, '.holtrc.json'), JSON.stringify({ guardAllow: ['rm -rf dist'] }));

    // PREMISE: the approval works, and the control is genuinely protected. Without both of these
    // the assertions below would pass for the wrong reason.
    assert.equal((await assessCommand('rm -rf dist', fx.root)).decision, 'allow',
      'PREMISE: the approved command itself must still be allowed');
    await fs.rm(path.join(fx.root, '.holtrc.json'));
    assert.notEqual((await assessCommand(`rm -rf ${wt}`, fx.root)).decision, 'allow',
      'PREMISE: the protected worktree must be protected without the config');
    await fs.writeFile(path.join(fx.root, '.holtrc.json'), JSON.stringify({ guardAllow: ['rm -rf dist'] }));

    // THE DEFECT: an unreviewed command inherits the approval by carrying the approved text.
    for (const [cmd, how] of [
      [`rm -rf dist; rm -rf ${wt}`, 'chained with ;'],
      [`rm -rf dist && rm -rf ${wt}`, 'chained with &&'],
      [`rm -rf ${wt} # rm -rf dist`, 'the approved text in a trailing COMMENT'],
      [`echo "rm -rf dist"; rm -rf ${wt}`, 'the approved text inside an echo'],
    ]) {
      const v = await assessCommand(cmd, fx.root);
      assert.notEqual(v.decision, 'allow',
        `an approval must not extend to a command nobody reviewed (${how}): ${cmd}`);
    }
  });

test('CONFIG AUTHORITY: a repository cannot grant itself permission',
  async (t) => {
    const { fx } = await standardFixture();
    t.after(() => fx.cleanup());
    const wt = rel(fx.root, fx.wt('uniqueUncommitted'));

    // This is the file a repository you cloned would ship. Authority must not be sourced from
    // inside the thing being guarded.
    await fs.writeFile(path.join(fx.root, '.holtrc.json'), JSON.stringify({ guardAllow: ['rm'] }));

    const v = await assessCommand(`rm -rf ${wt}`, fx.root);
    assert.notEqual(v.decision, 'allow',
      'a guardAllow entry supplied by the repository must not disable the guard: '
      + `rm -rf ${wt} -> ${v.decision}`);
  });

test('CONFIG AUTHORITY: NEVER-WORSE — a legitimate anchored approval still works', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  // The escape hatch exists for a reason: a wrongly-refused command must be gettable past by a
  // human. Whatever fixes the two defects above must not remove that, or it trades an
  // under-protection for an over-refusal with no way out — and a guard with no escape is a guard
  // people uninstall.
  await fs.writeFile(path.join(fx.root, '.holtrc.json'),
    JSON.stringify({ guardAllow: ['^rm -rf dist$', '^git status$'] }));

  for (const cmd of ['rm -rf dist', 'git status']) {
    const v = await assessCommand(cmd, fx.root);
    assert.equal(v.decision, 'allow',
      `an explicit, anchored, human-reviewed approval must keep working: ${cmd} -> ${v.reason}`);
  }
});
