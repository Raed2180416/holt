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
  assert.equal(s.estimatedHoursSaved, 0);
  assert.match(s.headline, /no prevented losses recorded yet/);
});

test('roi: prevented losses count blocks and verified rescues, and only those', () => {
  const events = [
    { at: '2026-07-01T00:00:00Z', action: 'protect' },
    { at: '2026-07-02T00:00:00Z', action: 'blocked', command: 'git worktree remove --force x' },
    { at: '2026-07-02T00:01:00Z', action: 'blocked', command: 'git worktree unlock x' },
    { at: '2026-07-03T00:00:00Z', action: 'rescue', id: 'wt1' },
    { at: '2026-07-04T00:00:00Z', action: 'clean-remove', id: 'junk1' },
    { at: '2026-07-04T00:01:00Z', action: 'removed', id: 'junk2' },
    { at: '2026-07-05T00:00:00Z', action: 'branch-delete', name: 'landed' },
    { at: '2026-07-05T00:02:00Z', action: 'skipped' }, // must not count toward anything
  ];
  const s = summarizeJournal(events);
  assert.equal(s.breakdown.destructiveCommandsBlocked, 2);
  assert.equal(s.breakdown.workstreamsRescued, 1);
  assert.equal(s.breakdown.workstreamsProtected, 1);
  assert.equal(s.breakdown.worktreesReclaimed, 2);
  assert.equal(s.breakdown.branchesDeleted, 1);
  assert.equal(s.preventedLosses, 3, 'blocks(2) + rescues(1); protects/cleans are not "prevented losses"');
  assert.match(s.headline, /refused 2 destructive command/);
  assert.match(s.note, /not a measurement/);
});

test('roi: a corrupt journal line is ignored, never counted', () => {
  const s = summarizeJournal([{ corrupt: 'garbage' }, { at: 'x', action: 'blocked' }]);
  assert.equal(s.breakdown.destructiveCommandsBlocked, 1);
  assert.equal(s.events, 1);
});

test('roi: the hours estimate is conservative and labelled as an estimate', () => {
  const s = summarizeJournal([{ at: 'x', action: 'blocked' }, { at: 'y', action: 'clean-remove' }]);
  // 1 prevented loss * 2h + 1 reclaim * 0.25h = 2.25h, rounded to 1 decimal = 2.3
  assert.equal(s.estimatedHoursSaved, 2.3);
  assert.match(s.note, /conservative planning figure/);
});
