// SPDX-License-Identifier: LicenseRef-holt-Commercial
// Commercial license — see src/team/LICENSE. NOT covered by the repository FSL-1.1-MIT grant.
/**
 * holt Team — cross-repository, cross-agent incident correlation.
 *
 * WHERE THE FREE/PAID LINE IS, argued rather than asserted.
 *
 * One repository's timeline is the developer's own data and stays free — `holt forensics` and
 * `holt journal --json` print all of it, and gating a view of a file the user already owns
 * would be a gate in name only. What a SOLO developer cannot have, by construction, is the
 * thing this module computes: a single agent session does not stay inside one repository. It
 * is dispatched across a fleet, and its journal lines land in N different `.git/holt/journal.jsonl`
 * files that no single-repo command can see at once. Correlating them is only meaningful when
 * there are many repositories and many agents — which is the definition of a team.
 *
 * THE FINDING THAT ONLY EXISTS UP HERE, and the reason this is not a report-generator:
 *
 *   A session refused in repo A and then successful in repo B is invisible to both repos. Repo
 *   A sees a block and no damage. Repo B sees a removal with no antecedent. Only the join says
 *   "the same agent session, having been refused once, went and did it somewhere holt was not
 *   installed the same way" — which is the single most important sentence in an incident review
 *   and cannot be derived from either repository alone.
 *
 * NO NETWORK. This reads local journals; it is aggregation, not telemetry. holt's promise of
 * zero outbound calls is not weakened by a paid tier.
 *
 * NEVER INVENTS A CORRELATION. Events with no session are counted as unattributed and are never
 * joined to anything — not by time proximity, not by repo, not by "probably the same agent". A
 * fabricated link in an incident review gets someone blamed for something they did not do.
 */

import path from 'node:path';
import { checkEntitlement } from '../license.mjs';
import { readVerifiedJournal } from '../journal.mjs';
import { actorKey, UNKNOWN } from '../actor.mjs';
import { findRepos, EntitlementError, journalEvidenceState, hasTrustedJournalEvidence } from './fleet.mjs';

const DESTRUCTIVE_ACTIONS = new Set(['clean-purge', 'clean-remove', 'removed', 'branch-delete']);
const QUARANTINE_ACTIONS = new Set(['clean-quarantine']);

/**
 * Correlate every repository's journal by agent session.
 *
 * @param {string[]} roots
 * @param {object} [o]
 * @param {number} [o.maxDepth]
 * @param {string|null} [o.since] ISO date filter
 * @param {string|null} [o.agent] restrict to one agent id
 * @param {Record<string, string|undefined>} [o.env]
 * @param {string|null} [o.publicKeyB64]
 */
export async function fleetForensics(roots, {
  maxDepth = 3, since = null, agent = null, env = process.env, publicKeyB64 = null,
} = {}) {
  // Gated at the FEATURE, not only at the CLI — importing this module directly is entitled the
  // same way the command is. Same posture as fleetScan: tamper-evident, not tamper-proof.
  //
  // `publicKeyB64` follows license.mjs's own rule: overridable as an ARGUMENT and never from the
  // environment, so the suite can exercise the ENTITLED path with a throwaway keypair. An
  // entitlement whose granted branch is never executed is a gate nobody has proven works — and
  // `fleet`, the paid feature that shipped before this one, has no such test at all.
  const ent = checkEntitlement('forensics-fleet', { env, publicKeyB64 });
  if (!ent.entitled) throw new EntitlementError(ent);

  const sinceMs = since ? Date.parse(since) : null;
  if (since && Number.isNaN(sinceMs)) {
    const e = Object.assign(new Error(`--since is not a date holt can parse: ${since}`), { code: 'EBADDATE' });
    throw e;
  }

  const repos = await findRepos(roots, { maxDepth });
  const sessions = new Map();
  const failures = [];
  const untrustedRepositories = [];
  const repoRows = [];
  let unattributed = 0;
  let totalEvents = 0;

  for (const repo of repos) {
    let events;
    try {
      const { verification, entries } = await readVerifiedJournal(repo);
      const journalState = journalEvidenceState(verification);
      if (!hasTrustedJournalEvidence(verification)) {
        // A cross-repository correlation is an attribution claim.  Never build one from a
        // missing, empty, legacy-partial, or unverifiable journal and merely hide it in totals.
        // The row is retained as an explicit coverage gap, with no derived action/actor counts.
        const observedEntries = verification.entries ?? 0;
        untrustedRepositories.push({
          repo, name: path.basename(repo), journalState, code: verification.code,
          reason: verification.reason, observedEntries,
        });
        repoRows.push({
          repo, name: path.basename(repo), trusted: false, journalState,
          events: 0, blocked: 0, quarantined: 0, destroyed: 0, observedEntries,
        });
        continue;
      }
      events = entries;
    } catch (e) {
      // A repository whose journal cannot be read is reported as a FAILURE, never as a quiet
      // zero. A fleet report that silently drops a repo is the "partial coverage looks like
      // clean coverage" defect this project refuses everywhere else.
      failures.push({ repo, error: e.message });
      continue;
    }

    let repoEvents = 0;
    let repoBlocked = 0;
    let repoQuarantined = 0;
    let repoDestroyed = 0;

    for (const e of events) {
      if (e.corrupt) continue;
      if (sinceMs != null && Date.parse(e.at ?? '') < sinceMs) continue;
      const a = e.actor ?? {};
      if (agent && (a.agent ?? UNKNOWN) !== agent) continue;

      totalEvents++;
      repoEvents++;
      if (e.action === 'blocked') repoBlocked++;
      if (QUARANTINE_ACTIONS.has(e.action)) repoQuarantined++;
      if (DESTRUCTIVE_ACTIONS.has(e.action)) repoDestroyed++;

      const key = actorKey(a);
      if (!key) { unattributed++; continue; }

      const row = sessions.get(key) ?? {
        key,
        agent: a.agent ?? UNKNOWN,
        agentVersion: a.agentVersion ?? null,
        session: a.session ?? null,
        confidence: a.confidence ?? 'unknown',
        repos: new Map(),
        first: e.at, last: e.at,
        events: 0, blocked: 0, couldNotVerify: 0, quarantined: 0, destroyed: 0, protected: 0,
      };
      row.events++;
      if (e.action === 'blocked') row.blocked++;
      if (e.action === 'unverified') row.couldNotVerify++;
      if (QUARANTINE_ACTIONS.has(e.action)) row.quarantined++;
      if (DESTRUCTIVE_ACTIONS.has(e.action)) row.destroyed++;
      if (e.action === 'protect' || e.action === 'rescue') row.protected++;
      if (!row.first || e.at < row.first) row.first = e.at;
      if (!row.last || e.at > row.last) row.last = e.at;

      const per = row.repos.get(repo) ?? { repo, name: path.basename(repo), events: 0, blocked: 0, quarantined: 0, destroyed: 0, first: e.at, last: e.at, subjects: new Set() };
      per.events++;
      if (e.action === 'blocked') per.blocked++;
      if (QUARANTINE_ACTIONS.has(e.action)) per.quarantined++;
      if (DESTRUCTIVE_ACTIONS.has(e.action)) per.destroyed++;
      if (!per.first || e.at < per.first) per.first = e.at;
      if (!per.last || e.at > per.last) per.last = e.at;
      for (const s of [e.id, e.name, ...(Array.isArray(e.targets) ? e.targets : [])]) if (s) per.subjects.add(s);
      row.repos.set(repo, per);

      sessions.set(key, row);
    }

    repoRows.push({
      repo, name: path.basename(repo), trusted: true, journalState: 'valid-populated',
      events: repoEvents, blocked: repoBlocked, quarantined: repoQuarantined, destroyed: repoDestroyed,
    });
  }

  const rows = [...sessions.values()].map((r) => ({
    ...r,
    repos: [...r.repos.values()].map((p) => ({ ...p, subjects: [...p.subjects].slice(0, 12) }))
      .sort((x, y) => y.events - x.events),
    repoCount: r.repos.size,
  })).sort((a, b) => b.destroyed - a.destroyed || b.blocked - a.blocked
    || b.quarantined - a.quarantined || b.events - a.events);

  /* ---- the findings only the join can produce ------------------------------------ */

  const crossRepo = rows.filter((r) => r.repoCount > 1);

  // The headline correlation: refused somewhere, destructive somewhere else, same session.
  const refusedThenDestroyed = rows
    .filter((r) => r.blocked > 0 && r.destroyed > 0)
    .map((r) => {
      // Compared on the repository PATH, never on its display name. Two repositories under one
      // fleet root are routinely called the same thing (`api/service`, `web/service`), and
      // comparing basenames silently answers "same repository" for two that are not — which
      // turns the one finding this feature exists for into a false negative.
      const blockedPaths = new Set(r.repos.filter((p) => p.blocked > 0).map((p) => p.repo));
      const destroyedPaths = r.repos.filter((p) => p.destroyed > 0).map((p) => p.repo);
      const differentRepo = destroyedPaths.some((d) => !blockedPaths.has(d));
      const nameOf = (full) => r.repos.find((p) => p.repo === full)?.name ?? full;
      const blockedIn = [...blockedPaths].map(nameOf);
      const destroyedIn = destroyedPaths.map(nameOf);
      return {
        key: r.key, agent: r.agent, session: r.session,
        blockedIn, destroyedIn, differentRepo,
        blockedInPaths: [...blockedPaths], destroyedInPaths: destroyedPaths,
        why: differentRepo
          ? 'this session was REFUSED in one repository and completed a destructive action in a DIFFERENT one — '
            + 'neither repository can see this on its own'
          : 'this session was refused and later completed a destructive action in the same repository',
      };
    })
    .sort((a, b) => Number(b.differentRepo) - Number(a.differentRepo));

  return {
    scannedAt: new Date().toISOString(),
    roots: roots.map((r) => path.resolve(r)),
    filters: { since: since ?? null, agent: agent ?? null },
    repositories: repos.length,
    repositoriesWithEvents: repoRows.filter((r) => r.events > 0).length,
    totals: {
      events: totalEvents,
      sessions: rows.length,
      crossRepoSessions: crossRepo.length,
      blocked: rows.reduce((n, r) => n + r.blocked, 0),
      quarantined: rows.reduce((n, r) => n + r.quarantined, 0),
      destroyed: rows.reduce((n, r) => n + r.destroyed, 0),
      unattributedEvents: unattributed,
    },
    sessions: rows,
    crossRepoSessions: crossRepo,
    refusedThenDestroyed,
    repos: repoRows.sort((a, b) => b.events - a.events),
    untrustedRepositories,
    failures,
    note: [
      untrustedRepositories.length
        ? `${untrustedRepositories.length} repository(ies) supplied no trusted populated journal evidence and are excluded from every attribution and total above — they are not clean, they are unaccounted for.`
        : null,
      failures.length
        ? `${failures.length} repository(ies) could not be read and are excluded from every total above — they are not clean, they are unknown`
        : null,
      unattributed
        ? `${unattributed} event(s) carry no agent session and are NOT correlated to any row above. `
          + 'They are counted, never guessed at — joining them on time or repository would fabricate '
          + 'an attribution holt did not observe.'
        : null,
      'clean-quarantine is counted separately from destruction: it retains the registered, locked '
      + 'worktree and branch and carries exact restore argv. Explicit clean-purge and historical '
      + 'clean-remove/removed events remain destructive evidence and are never rewritten.',
      'holt sees only what its hook and its own commands recorded; a repository where holt was never '
      + 'installed contributes silence, which is not the same as safety.',
    ].filter(Boolean).join(' '),
  };
}

export { EntitlementError };
