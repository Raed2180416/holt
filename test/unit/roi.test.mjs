/**
 * The ROI summary turns the audit journal into the number a champion shows a VP. Its one hard
 * rule: it must be CONSERVATIVE — count only events that fired, never a hypothetical, because an
 * inflated safety claim that is once wrong destroys the trust the product runs on.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeJournal } from '../../src/roi.mjs';

test('roi: an empty journal reports nothing prevented, not a fabricated number', () => {
  const s = summarizeJournal([]);
  assert.equal(s.preventedLosses, 0);
  assert.match(s.headline, /no prevented losses recorded yet/);
});

test('roi: prevented losses count blocks and verified rescues, and only those', () => {
  const events = [
    { at: '2026-07-01T00:00:00Z', action: 'protect' },
    { at: '2026-07-02T00:00:00Z', action: 'blocked', command: 'git worktree remove --force x' },
    { at: '2026-07-02T00:01:00Z', action: 'blocked', command: 'git worktree unlock x' },
    { at: '2026-07-03T00:00:00Z', action: 'rescue', id: 'wt1' },
    { at: '2026-07-03T00:01:00Z', action: 'clean-quarantine', id: 'junk0',
      quarantinePath: '/r/.holt-quarantine/junk0', restoreArgv: [['git', 'worktree', 'unlock', '/r/.holt-quarantine/junk0']] },
    { at: '2026-07-04T00:00:00Z', action: 'clean-remove', id: 'junk1' },
    { at: '2026-07-04T00:01:00Z', action: 'removed', id: 'junk2' },
    { at: '2026-07-05T00:00:00Z', action: 'branch-delete', name: 'landed' },
    { at: '2026-07-05T00:01:00Z', action: 'unprotect', id: 'wt1' },
    { at: '2026-07-05T00:02:00Z', action: 'skipped' }, // must not count toward anything
  ];
  const s = summarizeJournal(events);
  // Protections RELEASED are reported beside protections applied. A tally showing only the guards
  // holt put up, never the ones taken down, overstates the protection actually standing.
  assert.equal(s.breakdown.protectionsReleased, 1);
  assert.equal(s.preventedLosses, 3, 'releasing a protection is not a prevented loss');
  assert.equal(s.breakdown.destructiveCommandsBlocked, 2);
  assert.equal(s.breakdown.workstreamsRescued, 1);
  assert.equal(s.breakdown.workstreamsProtected, 1);
  assert.equal(s.breakdown.worktreesQuarantined, 1,
    'a reversible quarantine is useful activity, but not a physical reclaim or prevented loss');
  assert.equal(s.breakdown.worktreesReclaimed, 2);
  assert.equal(s.breakdown.branchesDeleted, 1);
  assert.equal(s.preventedLosses, 3, 'blocks(2) + rescues(1); protects/cleans are not "prevented losses"');
  assert.match(s.headline, /refused 2 destructive command/);
  assert.match(s.note, /count of events that actually fired/);
  assert.match(s.note, /branches retained/);
});

test('roi: quarantine never inflates historical physical cleanup', () => {
  const s = summarizeJournal([
    { at: '2026-08-05T00:00:00Z', action: 'clean-quarantine', id: 'spent' },
  ]);
  assert.equal(s.breakdown.worktreesQuarantined, 1);
  assert.equal(s.breakdown.worktreesReclaimed, 0);
  assert.equal(s.preventedLosses, 0);
});

test('roi: explicit purge is counted as physical reclamation, not prevented loss', () => {
  const s = summarizeJournal([
    { at: '2026-08-05T00:00:00Z', action: 'clean-quarantine', id: 'spent' },
    { at: '2026-08-05T00:01:00Z', action: 'clean-purge', id: 'spent' },
  ]);
  assert.equal(s.breakdown.worktreesQuarantined, 1);
  assert.equal(s.breakdown.worktreesReclaimed, 1);
  assert.equal(s.preventedLosses, 0,
    'reclaiming proved-disposable storage is useful but is not a prevented loss');
});

test('roi: a corrupt journal line is ignored, never counted', () => {
  const s = summarizeJournal([{ corrupt: 'garbage' }, { at: 'x', action: 'blocked' }]);
  assert.equal(s.breakdown.destructiveCommandsBlocked, 1);
  assert.equal(s.events, 1);
});

test('roi: no fabricated hours figure is published', () => {
  // This module used to return `estimatedHoursSaved = preventedLosses * 2h + reclaimed * 0.25h`.
  // Both multipliers were invented — holt cannot know what an hour of your time is worth or how
  // long the lost work would have taken to redo — and an indefensible number is precisely the
  // gotcha this project refuses to ship. The counts stay because every one is a journal row.
  const s = summarizeJournal([
    { at: '2026-07-02T00:00:00Z', action: 'blocked', command: 'git worktree remove --force x' },
    { at: '2026-07-03T00:00:00Z', action: 'rescue', id: 'wt1' },
    { at: '2026-07-04T00:00:00Z', action: 'clean-remove', id: 'junk1' },
  ]);
  assert.equal(s.estimatedHoursSaved, undefined,
    'holt must not publish an hours-saved figure it cannot defend');
  assert.doesNotMatch(JSON.stringify(s), /hours?Saved|hours saved/i,
    'no field or note may reintroduce an hours estimate under another name');
  assert.ok(Number.isInteger(s.preventedLosses),
    'the real, auditable counts must survive the removal');
});
