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

// THERE IS NO HOURS FIGURE HERE, DELIBERATELY. This module used to publish
// `estimatedHoursSaved = preventedLosses * 2h + reclaimed * 0.25h`, labelled "a conservative,
// clearly-labelled estimate". Both multipliers were invented. holt cannot know what an hour of
// your time is worth, how long the lost work would have taken to redo, or whether you would have
// redone it at all — and a number that cannot be defended is exactly the gotcha this project
// refuses to ship. The COUNTS below are real: every one is a row in the journal, stamped with who
// did it and when, and a reader can audit them with `holt journal --export json`.

export function summarizeJournal(events, { now = null } = {}) {
  const list = Array.isArray(events) ? events.filter((e) => e && !e.corrupt) : [];
  const count = (a) => list.filter((e) => e.action === a).length;

  const blocked = count('blocked');                 // destructive commands the hook refused
  const protectedWt = count('protect');             // worktrees locked because they held unique work
  const rescued = count('rescue');                  // unique work captured to a verifiable ref
  const cleaned = count('clean-remove') + count('removed'); // disposable worktrees reclaimed
  const branchesDeleted = count('branch-delete');
  // Protections RELEASED, reported beside protections applied. A safety tally that shows only
  // the guards it put up, never the ones taken down, overstates the standing protection — the
  // same one-sided record the journal itself had while `unprotect` went unwritten.
  const released = count('unprotect');

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
      protectionsReleased: released,
    },
    headline: preventedLosses > 0
      ? `holt refused ${blocked} destructive command(s) and preserved ${rescued} workstream(s) that existed nowhere else`
      : (protectedWt > 0
        ? `holt is protecting ${protectedWt} workstream(s) that hold work found nowhere else`
        : 'no prevented losses recorded yet — the record starts the first time something is protected, rescued, or refused'),
    note: 'Every figure here is a count of events that actually fired, taken from the journal. '
      + 'Audit them with `holt journal --export json`.',
  };
}
