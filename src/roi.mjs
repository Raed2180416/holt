// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — the number a champion shows a VP at renewal.
 *
 * A safety product churns without a countable outcome: "nothing bad happened" is invisible. The
 * append-only journal already records every prevented loss and every reclaim; this turns it into
 * a plain-English tally. Pure over the events array, so it is exhaustively testable and needs no
 * repository.
 *
 * The headline is DELIBERATELY conservative: it counts only events that actually happened
 * (blocks that fired, rescues that verified, worktrees reclaimed) — never a hypothetical. An
 * inflated safety number is worse than none, because the one time it is wrong destroys the trust
 * the whole product runs on.
 */

const HOURS_PER_RECLAIM = 0.25; // a reclaimed worktree saves ~15 min of manual verify-and-delete
const HOURS_PER_PREVENTED_LOSS = 2; // re-doing lost uncommitted work — a conservative floor

export function summarizeJournal(events, { now = null } = {}) {
  const list = Array.isArray(events) ? events.filter((e) => e && !e.corrupt) : [];
  const count = (a) => list.filter((e) => e.action === a).length;

  const blocked = count('blocked');                 // destructive commands the hook refused
  const protectedWt = count('protect');             // worktrees locked because they held unique work
  const rescued = count('rescue');                  // unique work captured to a verifiable ref
  const cleaned = count('clean-remove') + count('removed'); // disposable worktrees reclaimed
  const branchesDeleted = count('branch-delete');

  // "Prevented losses" = the events that stood between work and deletion: a refused destructive
  // command, or a verified rescue that let a locked tree be removed safely.
  const preventedLosses = blocked + rescued;

  const firstAt = list.length ? list[0].at : null;
  const lastAt = list.length ? list[list.length - 1].at : null;

  return {
    events: list.length,
    since: firstAt,
    latest: lastAt,
    preventedLosses,
    breakdown: {
      destructiveCommandsBlocked: blocked,
      workstreamsProtected: protectedWt,
      workstreamsRescued: rescued,
      worktreesReclaimed: cleaned,
      branchesDeleted,
    },
    // A conservative, clearly-labelled estimate — never presented as measured fact.
    estimatedHoursSaved: Math.round((preventedLosses * HOURS_PER_PREVENTED_LOSS
      + cleaned * HOURS_PER_RECLAIM) * 10) / 10,
    headline: preventedLosses > 0
      ? `holt refused ${blocked} destructive command(s) and preserved ${rescued} workstream(s) that existed nowhere else`
      : (protectedWt > 0
        ? `holt is protecting ${protectedWt} workstream(s) that hold work found nowhere else`
        : 'no prevented losses recorded yet — the record starts the first time something is protected, rescued, or refused'),
    note: 'estimatedHoursSaved is a conservative planning figure (2h per prevented loss, 15m per '
      + 'reclaim), not a measurement. preventedLosses counts events that actually fired.',
  };
}
