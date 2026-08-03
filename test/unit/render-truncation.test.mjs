/**
 * A LIST THAT STOPS WITHOUT SAYING SO READS AS THE WHOLE LIST.
 *
 * `holt risk` capped its UNIQUE WORK table at 40 rows with no overflow counter and no total in its
 * header ("UNIQUE WORK — what has no durable copy elsewhere"). On a repository with more than 40
 * workstreams holding work found nowhere else, the remainder were simply absent from a list that
 * looked complete — and this is the table a reader scans to decide what must NOT be deleted.
 *
 * It is the same defect commit 13dc53a13 fixed in the TUI and the session brief fixed after
 * counting 8 and naming 5. This was the third surface and the highest-stakes one, so it is pinned
 * here rather than left to be found a fourth time.
 *
 * The renderer is called directly with a synthetic report: building 41 real worktrees would take
 * minutes and prove nothing extra, and the truncation is a pure function of row count.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderRisk } from '../../src/render.mjs';

/** The smallest report shape renderRisk reads, with `n` workstreams holding unique work. */
function reportWith(n) {
  return {
    base: { ref: 'refs/heads/main', oid: 'a'.repeat(40), how: 'declared' },
    backend: { label: 'universal-ctags (test)', degraded: false },
    counts: { collisions: 0, duplicates: 0 },
    unique: Array.from({ length: n }, (_, i) => ({
      id: `wt-${String(i).padStart(3, '0')}`,
      uniqueSymbolCount: 3,
      uncommittedOnlyCount: 1,
      uncommittedFileCount: 1,
      committedFiles: 0,
      verdict: 'unique-work-uncommitted',
      byLayer: { uncommitted: [], untracked: [], committed: [] },
    })),
    safe: [],
    collisions: [],
    duplicates: [],
    skipped: [],
    stash: { atRisk: [], truncated: false },
  };
}

test('RENDER: the at-risk table says how many rows it did not show', () => {
  const shown = renderRisk(reportWith(41));

  // THE POSITIVE CONTROL FIRST: the table must actually be rendering rows, or an assertion about
  // its truncation notice is an assertion about an empty string.
  assert.match(shown, /wt-000/, 'the table must render its first row');
  assert.match(shown, /wt-039/, 'the table must render up to its cap');

  assert.doesNotMatch(shown, /wt-040/, 'the 41st row is beyond the cap and must not be printed');
  assert.match(shown, /… and 1 more workstream\(s\) hold work found nowhere else/,
    `41 at-risk workstreams were shown as 40 with no counter — a reader cannot act on work they `
    + `were never told exists:\n${shown}`);
});

test('RENDER: a list that fits is not labelled truncated', () => {
  // NEVER-WORSE. A counter that always fires is as useless as one that never does, and it would
  // teach a reader to ignore the line in exactly the case where it matters.
  const shown = renderRisk(reportWith(3));
  assert.match(shown, /wt-002/, 'all three rows must render');
  assert.doesNotMatch(shown, /… and \d+ more workstream\(s\)/,
    `a complete list must not claim it was truncated:\n${shown}`);
});
