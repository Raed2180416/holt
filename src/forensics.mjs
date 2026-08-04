// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — "which agent destroyed what, and when".
 *
 * THE QUESTION THIS ANSWERS is the one asked after an incident, and nothing else answered it.
 * `holt journal` prints a flat list of actions with no actor and no subject; `holt risk` shows
 * the present and has no memory. Neither reconstructs a workstream's life: who created it, what
 * it wrote, what was attempted against it, what was BLOCKED, what survived.
 *
 * WHAT MAKES THIS DIFFERENT FROM A LOG VIEWER, and why it is not a checkbox:
 *
 *   1. It joins three independent sources that do not know about each other — git's own record
 *      (reflogs, refs, worktree list), holt's action journal, and the live content analysis —
 *      and reports where they DISAGREE rather than picking one.
 *   2. It reports ATTEMPTS. A completed action is in git; a refused one exists nowhere except
 *      here. The most valuable line in an incident review is the `rm -rf` that did not run, and
 *      it is invisible to every tool that reads repository state.
 *   3. It never merges agent identity with git identity. `git log` tells you the configured
 *      author, which in an agent fleet is the same string for every agent on the machine. Those
 *      are different facts about different subjects and conflating them is how "who did it"
 *      gets a confident wrong answer.
 *
 * HONESTY RULES, each of which costs coverage on purpose:
 *   - holt does not observe worktree CREATION (there is no git hook for it), so creation is
 *     reconstructed from git's reflog and labelled with how it was derived. It is never
 *     attributed to an agent, because no agent identity was observed at that moment.
 *   - An event that carries no actor is reported as unattributed and counted separately. It is
 *     never folded into a neighbouring actor because the timestamps are close.
 *   - Absence of blocked attempts is reported as "no attempts recorded", never "none occurred":
 *     holt only sees what passed through its hook, and a repo whose hook was never installed
 *     produces the same silence as a repo where nothing happened. Those are different facts.
 */

import path from 'node:path';
import { git } from './git.mjs';
import { discover } from './discover.mjs';
import { scan } from './scan.mjs';
import { analyze } from './analyze.mjs';
import { readJournal } from './journal.mjs';
import { actorLabel, actorKey, UNKNOWN } from './actor.mjs';

/** Actions that took something away, versus actions that were refused, versus everything else. */
const DESTRUCTIVE_ACTIONS = new Set(['clean-remove', 'removed', 'branch-delete']);
const REFUSED_ACTIONS = new Set(['blocked', 'unverified']);
const PROTECTIVE_ACTIONS = new Set(['protect', 'rescue']);

/**
 * Does this journal event concern workstream `id`?
 *
 * Deliberately explicit rather than a substring sweep over the whole record. Matching `id`
 * anywhere in the JSON made a `blocked` line about worktree `api` claim every event mentioning
 * `api` in a path or a reason — an incident timeline that includes unrelated events is worse
 * than a short one, because a reviewer cannot tell which lines are load-bearing.
 */
export function eventConcerns(event, id) {
  if (!id) return true;
  if (!event || event.corrupt) return false;
  if (event.id === id || event.name === id) return true;
  if (Array.isArray(event.targets) && event.targets.includes(id)) return true;
  // A refused command names its target as a PATH; that path's basename is the workstream id.
  if (REFUSED_ACTIONS.has(event.action) && typeof event.command === 'string') {
    // Word-boundary on path separators so `api` does not match `api-v2`.
    const re = new RegExp(`(^|[\\s/\\\\'"])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\s/\\\\'"]|$)`);
    if (re.test(event.command)) return true;
  }
  return false;
}

/**
 * git's own record of when a branch came into existence. No agent identity exists here.
 *
 * READ VIA `git log -g`, NOT `git reflog`, AND THAT IS DELIBERATE. holt's git wrapper enforces a
 * read-only allowlist, `reflog` is not on it (its `expire`/`delete` forms rewrite history), and a
 * refused command returns a non-zero code rather than throwing. The first version of this
 * function therefore reported "no reflog for this branch" on EVERY repository — a silent degrade
 * that read as a fact about the repo when it was a fact about holt's own gate.
 *
 * `git log -g` walks the same reflog and `log` is already permitted, so the fix is to use the
 * door that exists rather than to widen the allowlist for a read.
 *
 * The two failure modes are now distinguished, because they are different facts: the instrument
 * was refused, versus the reflog is genuinely empty.
 */
async function branchOrigin(root, branch) {
  if (!branch) return { at: null, how: 'unknown', detail: 'this workstream has no branch' };
  const r = await git(['log', '-g', '--date=iso-strict', '--format=%gs%x09%gd%x09%cI', branch], { cwd: root })
    .catch((e) => ({ code: -1, stdout: '', stderr: e.message }));

  if (r.code !== 0) {
    return {
      at: null,
      how: 'instrument-refused',
      detail: `holt could not read the reflog for '${branch}' (${(r.stderr || '').trim().slice(0, 160) || `exit ${r.code}`}) `
        + '— creation time is UNKNOWN, which is not the same as "this branch is new"',
    };
  }
  const lines = r.stdout.split('\n').filter(Boolean);
  if (!lines.length) {
    // No reflog: fall back to the branch's own oldest commit, labelled as the weaker evidence it
    // is (a commit date is when work was committed, not when the branch was made).
    const c = await git(['log', '--date=iso-strict', '--format=%cI', '--reverse', '--max-count=1', branch], { cwd: root })
      .catch(() => null);
    const at = (c && c.code === 0) ? c.stdout.split('\n').filter(Boolean)[0] ?? null : null;
    return at
      ? { at, how: 'first-commit', detail: 'no reflog; this is the branch\'s oldest commit date, which is a LOWER BOUND on creation' }
      : { at: null, how: 'unknown', detail: 'no reflog and no commits — nothing in git dates this branch' };
  }
  const oldest = lines[lines.length - 1].split('\t');
  return {
    at: oldest[2] ?? null,
    how: 'git-reflog',
    detail: (oldest[0] ?? '').trim() || null,
  };
}

/**
 * The git authors on this workstream's own commits.
 *
 * REPORTED SEPARATELY FROM `actor`, and the separation is the point: this is the identity git
 * was configured with, which across an agent fleet is one string for every agent on the box. It
 * is evidence, but it is evidence about the machine's configuration, not about which agent ran.
 */
async function gitAuthors(root, workstreamPath, base) {
  if (!workstreamPath) return [];
  const range = base ? `${base}..HEAD` : 'HEAD';
  const r = await git(['log', '--format=%an <%ae>%x09%cI', '-n', '50', range], { cwd: workstreamPath })
    .catch(() => null);
  if (!r || r.code !== 0) return [];
  const seen = new Map();
  for (const line of r.stdout.split('\n').filter(Boolean)) {
    const [who, when] = line.split('\t');
    const cur = seen.get(who);
    if (!cur) seen.set(who, { author: who, commits: 1, first: when, last: when });
    else { cur.commits++; cur.first = when; }
  }
  return [...seen.values()];
}

/** Every rescue capture holt holds for this repo, so "what survived" can cite a real ref. */
async function rescueRefs(root) {
  const r = await git(['for-each-ref', '--format=%(refname)%09%(objectname)%09%(creatordate:iso-strict)', 'refs/holt/rescue'], { cwd: root })
    .catch(() => null);
  if (!r || r.code !== 0) return [];
  return r.stdout.split('\n').filter(Boolean).map((l) => {
    const [refname, oid, at] = l.split('\t');
    return { ref: refname, commit: oid, at, id: refname.replace(/^refs\/holt\/rescue\//, '').replace(/-\d+$/, '') };
  });
}

/**
 * Reconstruct the timeline.
 *
 * @param {string} cwd
 * @param {object} [o]
 * @param {string|null} [o.id]     one workstream, or null for the whole repository
 * @param {string|null} [o.since]  ISO date; events before it are excluded
 * @param {string|null} [o.agent]  only this agent's events
 */
export async function forensics(cwd, { id = null, since = null, agent = null, ...opts } = {}) {
  const disc = await discover(cwd, opts);
  if (!disc.root) {
    const e = Object.assign(new Error(`not a git repository: ${cwd}`), { code: 'ENOTREPO' });
    throw e;
  }
  const root = disc.root;

  const [events, refs] = await Promise.all([readJournal(root), rescueRefs(root)]);

  const sinceMs = since ? Date.parse(since) : null;
  if (since && Number.isNaN(sinceMs)) {
    const e = Object.assign(new Error(`--since is not a date holt can parse: ${since}`), { code: 'EBADDATE' });
    throw e;
  }

  const relevant = events.filter((e) => {
    if (e.corrupt) return false;
    if (!eventConcerns(e, id)) return false;
    if (sinceMs != null && Date.parse(e.at ?? '') < sinceMs) return false;
    if (agent && (e.actor?.agent ?? UNKNOWN) !== agent) return false;
    return true;
  });

  // Live state. The scan is what makes "what survived" a verified claim rather than a guess:
  // the journal says a worktree was removed, the scan says whether one by that id exists now,
  // and a disagreement between them is itself a finding.
  /** @type {any} */
  let report = null;
  let scanError = null;
  try {
    const scanned = await scan(disc, { ...opts, includePrimary: true });
    report = await analyze(scanned, opts);
  } catch (e) {
    scanError = e.message;
  }

  const live = report ? report.safe.find((s) => s.id === id) ?? null : null;
  const uniqueNow = report ? report.unique.find((u) => u.id === id) ?? null : null;

  const origin = id && live?.path
    ? await branchOrigin(root, await branchOf(root, live.path))
    : { at: null, how: 'unknown', detail: id ? 'this workstream is no longer present' : 'repository-wide timeline' };

  const authors = id && live?.path ? await gitAuthors(root, live.path, report?.base?.ref ?? null) : [];

  /* ---- actor roll-up ------------------------------------------------------------- */

  const byActor = new Map();
  let unattributed = 0;
  for (const e of relevant) {
    const key = actorKey(e.actor);
    if (!key) { unattributed++; continue; }
    const row = byActor.get(key) ?? {
      key,
      agent: e.actor?.agent ?? UNKNOWN,
      agentVersion: e.actor?.agentVersion ?? null,
      session: e.actor?.session ?? null,
      confidence: e.actor?.confidence ?? 'unknown',
      events: 0, blocked: 0, unverified: 0, destroyed: 0, protected: 0,
      first: e.at, last: e.at,
    };
    row.events++;
    if (e.action === 'blocked') row.blocked++;
    if (e.action === 'unverified') row.unverified++;
    if (DESTRUCTIVE_ACTIONS.has(e.action)) row.destroyed++;
    if (PROTECTIVE_ACTIONS.has(e.action)) row.protected++;
    if (!row.first || e.at < row.first) row.first = e.at;
    if (!row.last || e.at > row.last) row.last = e.at;
    byActor.set(key, row);
  }

  const timeline = relevant.map((e) => ({
    at: e.at ?? null,
    action: e.action ?? UNKNOWN,
    actor: actorLabel(e.actor),
    agent: e.actor?.agent ?? UNKNOWN,
    session: e.actor?.session ?? null,
    confidence: e.actor?.confidence ?? 'unknown',
    subject: e.id ?? e.name ?? (Array.isArray(e.targets) && e.targets.length ? e.targets.join(', ') : null),
    outcome: REFUSED_ACTIONS.has(e.action)
      ? (e.action === 'blocked' ? 'REFUSED' : 'COULD-NOT-VERIFY — the host decided')
      : (DESTRUCTIVE_ACTIONS.has(e.action) ? 'removed' : 'recorded'),
    detail: e.command ?? e.ref ?? (Array.isArray(e.evidence) ? e.evidence.join('; ') : e.evidence) ?? e.reason ?? null,
  }));

  const blocked = relevant.filter((e) => e.action === 'blocked');
  const unverifiedAttempts = relevant.filter((e) => e.action === 'unverified');
  const removals = relevant.filter((e) => DESTRUCTIVE_ACTIONS.has(e.action));
  const captures = refs.filter((r) => !id || r.id === id);

  /* ---- what survived ------------------------------------------------------------- */

  let survived;
  if (!id) {
    survived = null;
  } else if (live) {
    survived = {
      status: 'present',
      path: live.path,
      holdsUniqueWork: !live.safe,
      uncommittedOnly: uniqueNow?.uncommittedOnlyCount ?? 0,
      evidence: live.reasons ?? [],
    };
  } else if (scanError) {
    survived = { status: UNKNOWN, evidence: [`the repository could not be scanned: ${scanError}`] };
  } else {
    survived = {
      status: removals.length ? 'removed' : 'absent',
      capturedAs: captures.map((c) => c.ref),
      evidence: removals.length
        ? removals.map((r) => `${r.at} ${r.action} by ${actorLabel(r.actor)}`)
        : ['no worktree with this id is present, and holt recorded no removal of it — '
          + 'it was removed by something holt was not wired into, or it never existed'],
    };
  }

  return {
    repo: root,
    workstream: id,
    generatedAt: new Date().toISOString(),
    filters: { since: since ?? null, agent: agent ?? null },
    created: origin,
    gitAuthors: authors,
    wrote: uniqueNow
      ? {
          uniqueSymbols: uniqueNow.uniqueSymbolCount,
          uncommittedFiles: uniqueNow.uncommittedFileCount,
          committedFiles: uniqueNow.committedFiles,
          verdict: uniqueNow.verdict,
          sample: [...uniqueNow.byLayer.uncommitted, ...uniqueNow.byLayer.untracked, ...uniqueNow.byLayer.committed]
            .slice(0, 8).map((s) => s.key),
        }
      : null,
    attempts: {
      blocked: blocked.length,
      couldNotVerify: unverifiedAttempts.length,
      removals: removals.length,
      note: relevant.length === 0
        ? 'holt has no record for this subject. That is not evidence nothing happened: holt only '
          + 'sees commands routed through its hook, so an uninstalled hook and a quiet repository '
          + 'look identical from here. Run `holt hosts` to see what is actually wired.'
        : null,
    },
    survived,
    actors: [...byActor.values()].sort((a, b) => b.events - a.events),
    unattributedEvents: unattributed,
    timeline,
    scanError,
    note: unattributed
      ? `${unattributed} event(s) carry no agent identity and are counted separately — they are `
        + 'NOT attributed to any actor above. An event predating identity capture, or a host that '
        + 'passes no session, lands here.'
      : 'every recorded event carries an actor',
  };
}

/** The branch checked out in a worktree path. */
async function branchOf(root, wtPath) {
  const r = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: wtPath }).catch(() => null);
  if (!r || r.code !== 0) return null;
  const b = r.stdout.trim();
  return (!b || b === 'HEAD') ? null : b;
}

/* ------------------------------------------------------------------- rendering ---- */

export function renderForensics(f, paint = (_c, s) => s) {
  const c = paint;
  const lines = [];
  const subject = f.workstream ? `workstream '${f.workstream}'` : 'this repository';
  lines.push(c('bold', `holt forensics — ${subject}`), c('grey', `  ${f.repo}`), '');

  lines.push(c('bold', '  CREATED'));
  lines.push(`    ${f.created.at ?? c('grey', 'unknown')}  ${c('grey', `(${f.created.how})`)}`);
  if (f.created.detail) lines.push(c('grey', `    ${f.created.detail}`));
  if (f.gitAuthors.length) {
    lines.push(c('grey', '    git authors on its commits (the machine\'s configured identity, NOT the agent):'));
    for (const a of f.gitAuthors.slice(0, 4)) lines.push(c('grey', `      ${a.author}  ${a.commits} commit(s)`));
  }

  if (f.wrote) {
    lines.push('', c('bold', '  WROTE'));
    lines.push(`    ${f.wrote.uniqueSymbols} unique symbol(s) · ${f.wrote.uncommittedFiles} uncommitted file(s) · ${f.wrote.committedFiles} committed file(s)`);
    if (f.wrote.sample.length) lines.push(c('grey', `    e.g. ${f.wrote.sample.slice(0, 5).join(', ')}`));
  }

  lines.push('', c('bold', '  ATTEMPTED AGAINST IT'));
  const a = f.attempts;
  lines.push(`    ${c(a.blocked ? 'red' : 'grey', String(a.blocked).padStart(4))}  destructive command(s) REFUSED`);
  lines.push(`    ${c(a.couldNotVerify ? 'yellow' : 'grey', String(a.couldNotVerify).padStart(4))}  could not be verified — holt handed the decision back to the host`);
  lines.push(`    ${c(a.removals ? 'yellow' : 'grey', String(a.removals).padStart(4))}  removal(s) holt performed itself`);
  if (a.note) lines.push(c('grey', `    ${a.note}`));

  if (f.survived) {
    lines.push('', c('bold', '  SURVIVED'));
    lines.push(`    ${f.survived.status}${f.survived.path ? `  ${c('grey', f.survived.path)}` : ''}`);
    for (const e of (f.survived.evidence ?? []).slice(0, 4)) lines.push(c('grey', `      ${e}`));
    if (f.survived.capturedAs?.length) lines.push(c('green', `      captured as: ${f.survived.capturedAs.join(', ')}`));
  }

  lines.push('', c('bold', `  WHO  (${f.actors.length} identified actor(s), ${f.unattributedEvents} unattributed event(s))`));
  if (!f.actors.length) lines.push(c('grey', '    no event carried an agent identity'));
  for (const act of f.actors) {
    lines.push(`    ${c('bold', act.agent)}${act.agentVersion ? c('grey', ` ${act.agentVersion}`) : ''} ${c('grey', `session ${String(act.session).slice(0, 16)}`)}`);
    lines.push(c('grey', `      ${act.events} event(s) · ${act.blocked} refused · ${act.destroyed} removed · ${act.protected} protected · identity ${act.confidence}`));
  }

  lines.push('', c('bold', `  TIMELINE  (${f.timeline.length} event(s))`));
  for (const t of f.timeline) {
    const mark = t.outcome === 'REFUSED' ? c('red', 'REFUSED') : t.outcome === 'removed' ? c('yellow', 'removed') : c('grey', t.outcome);
    lines.push(`    ${c('grey', String(t.at).slice(0, 19))}  ${c('bold', t.action.padEnd(12))} ${t.actor}  ${mark}`);
    if (t.detail) lines.push(c('grey', `        ${String(t.detail).slice(0, 110)}`));
  }
  if (f.scanError) lines.push('', c('red', `  the live scan FAILED (${f.scanError}) — "survived" is unknown, not clean`));
  lines.push('', c('grey', `  ${f.note}`), '');
  return lines.join('\n');
}

export const __test = { eventConcerns, DESTRUCTIVE_ACTIONS, REFUSED_ACTIONS };
