// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — workstream discovery.
 *
 * A "workstream" is one parallel line of work. Today that is a git worktree or a jj
 * workspace, but the model is deliberately VCS-agnostic: a workstream is
 * {id, path, head, base} plus content. Nothing downstream of this file knows what a
 * worktree is. That is what lets a jj (or future) backend drop in without a rewrite —
 * and it matters, because jj's automatic snapshotting eliminates the uncommitted layer
 * that git makes invisible.
 */

import { git, repoRoot, pmap } from './git.mjs';
import { discoverJjWorkspaces as _discoverJj } from './jj.mjs';
import { resolveBase } from './scan.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalPath, foldCase } from './paths.mjs';
import { screenOverrides, declinedMessage } from './saferegex.mjs';

/**
 * Build the error every "this call needed disc.root and it was null" call site throws.
 *
 * A BARE repository — a real git repository, just with no working tree — gets a message that
 * says so, instead of the "not a git repository" every one of these call sites used to print
 * unconditionally. That claim is simply false for a bare repo, and holt exists to give people
 * ACCURATE information about their repositories; a tool that misdiagnoses the one it is standing
 * in has already lost the argument for trusting anything else it says.
 *
 * @param {{bare?: boolean}|null} disc  the `discover()` (or `discoverGitWorktrees()`) result
 * @param {string} cwd
 */
export function repoAbsenceError(disc, cwd) {
  if (disc?.bare) {
    return Object.assign(
      new Error(`${cwd} is a bare repository (no working tree) — holt compares file content `
        + 'across worktrees and needs at least one checkout; run it from a normal clone instead'),
      { code: 'EBAREREPO', bare: true },
    );
  }
  return Object.assign(new Error(`not a git repository: ${cwd}`), { code: 'ENOTREPO' });
}

/**
 * The prefix every lock holt places carries, and the test for one.
 *
 * It lives HERE, beside the porcelain parser that reads lock reasons, rather than in actions.mjs,
 * because three layers need it and one of them must not import the mutating layer. The safety
 * verdict has to tell holt's OWN past verdict apart from a protection somebody else placed
 * deliberately: counting the former as evidence made the lock self-justifying, so a worktree holt
 * had ever locked stayed "not disposable" forever, citing the lock holt itself placed.
 *
 * A lock with no reason at all reads as FOREIGN, which is the conservative direction: holt only
 * ever releases what it can prove it placed.
 */
export const HOLT_LOCK_PREFIX = 'holt:';
export const isHoltLock = (reason) =>
  typeof reason === 'string' && reason.startsWith(HOLT_LOCK_PREFIX);

/**
 * Un-C-quote a porcelain value.
 *
 * MEASURED: when a lock reason contains a character git treats as special (newline, quote,
 * non-ASCII — and holt's own reasons embed symbol names, which can be non-ASCII), porcelain
 * emits it C-QUOTED: `locked "holt: …"`. Read naively, the quotes arrive in the string,
 * startsWith('holt:') fails, and holt's OWN lock is classified as foreign.
 *
 * IT LIVES HERE BECAUSE BOTH READERS OF THIS EVIDENCE NEED IT, and they drifted when it did not:
 * actions.mjs decoded it in lockState(), while this file — which feeds the SAFETY VERDICT — kept
 * the raw quoted string. isHoltLock() then saw a leading quote, called holt's own lock foreign,
 * and the lock could never be reconciled for exactly the reasons holt writes most often. The quoting is also what keeps a reason containing
 * `\nworktree /etc/passwd` from corrupting the porcelain stream (verified live) — a feature to
 * decode, not a quirk.
 */
export function unquotePorcelain(s) {
  if (!s.startsWith('"') || !s.endsWith('"') || s.length < 2) return s;
  const body = s.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') { out += ch; continue; }
    const next = body[++i];
    if (next === 'n') out += '\n';
    else if (next === 't') out += '\t';
    else if (next === '\\') out += '\\';
    else if (next === '"') out += '"';
    else if (/[0-7]/.test(next)) {
      let oct = next;
      while (oct.length < 3 && /[0-7]/.test(body[i + 1] ?? '')) oct += body[++i];
      out += String.fromCharCode(parseInt(oct, 8));
    } else out += next;
  }
  return out;
}

/**
 * Family inference — PROVENANCE, NOT NAMING.
 *
 * "Family" means: came from the same dispatch. That is what makes duplicate detection
 * meaningful — 5 siblings solving the same task is expected fan-out; 2 strangers solving it
 * independently is waste worth flagging — and it is what an agent gets told about its
 * neighbours. Grouping by directory/branch NAMING PATTERN alone (the previous approach here)
 * gets this backwards in both directions: `feat/auth-1` and `feat/auth-2` LOOK related and can
 * be forked from different commits days apart; `alpha`, `zebra`, `quux` look like three
 * singletons and can be the exact same fan-out. A human-readable name is not evidence of a
 * shared dispatch. Git's own history is:
 *
 *   CREATION TIME  when the workstream came into existence. VERIFIED empirically (see
 *                  creationTimeMs below) on Linux: the mtime of a linked worktree's private
 *                  `gitdir` file and the worktree's own per-worktree HEAD reflog entry agree
 *                  to the second, and BOTH correctly track the moment the worktree was
 *                  created — not the moment its branch was, which can be much older when a
 *                  worktree is later added for a pre-existing branch. mtime is used as the
 *                  primary signal for exactly that reason (it is a direct, single-purpose
 *                  measurement); the reflog read is the fallback when mtime is unavailable.
 *
 * FORK POINT WAS TRIED AS THE PRIMARY SIGNAL AND IS GONE. `git merge-base <base> <head>` reads
 * like the perfect witness — "workstreams dispatched together all fork from the same commit" —
 * and adversarial review refuted it in both directions on ordinary repositories. Every worktree
 * cut from an unchanged trunk shares a fork point whether or not it shares a dispatch, so a busy
 * repo collapses into one enormous family; and a fan-out dispatched while trunk is MOVING (the
 * normal case when agents run for hours and anything lands) forks from three different commits
 * and splits into three. Requiring a shared fork point before clustering therefore both
 * over-merged and under-merged, and the second is the expensive one: a real fan-out split into
 * halves turns every duplicate pair between them from 'expected-fanout' into a confidently wrong
 * 'cross-dispatch-waste'.
 *
 * CLUSTERING is therefore creation-burst first: single-linkage over creation time within
 * FAMILY_WINDOW_MS, across the whole repository, so a fan-out dispatched over a couple of minutes
 * (agents do not all start in the same millisecond) lands in one family however trunk moved
 * underneath it. A shared fan-out naming STEM then bridges two bursts up to
 * STEM_BRIDGE_WINDOW_MS apart — a second, independent witness, and the one thing that can span
 * the gap a long stagger opens.
 *
 * NAMING IS A FALLBACK, used only when history genuinely cannot answer (no branch, no
 * reflog, no worktree metadata — e.g. some jj layouts, or a worktree whose metadata was lost).
 * When it is used, `familyRule` says so (`name-fallback:<pattern>`), so nothing downstream
 * mistakes a naming guess for a proven relationship.
 *
 * An explicit human override (regex on the name) still wins over everything — a human
 * assertion about grouping is not something history gets to overrule.
 */

/**
 * The creation-burst window: how far apart two workstreams may have been created and still
 * count as one dispatch.
 *
 * 60 minutes. The first version of this was 5 minutes, justified by how fast a scripted
 * fan-out loop runs — and adversarial review refuted it with an entirely ordinary fixture: a
 * genuine two-worktree dispatch staggered by 20 minutes (a human reviewing between spawns, a
 * rate-limited API, CI provisioning in waves) was split into two "families", and a duplicate
 * pair between its halves flipped from the correct 'expected-fanout' to a confidently wrong
 * 'cross-dispatch-waste'. The boundary that matters is not "how fast is a tight loop" but
 * "what gap separates one staggered dispatch from two unrelated efforts" — and that gap is
 * hours-to-days, not minutes. 60 minutes of single-linkage keeps every ordinary stagger in one
 * family (a chain of creations each within an hour of the previous stays whole, however long
 * the chain) while day-apart efforts still split. Clusters whose members share a fan-out naming
 * stem merge across even this window, bounded by STEM_BRIDGE_WINDOW_MS — see the corroboration
 * step in assignFamilies. Configurable via `discover(cwd, { familyWindowMs })` for repositories
 * where this default is wrong.
 */
export const DEFAULT_FAMILY_WINDOW_MS = 60 * 60 * 1000;

/**
 * The name-stem bridge window: how far apart two creation-burst clusters may be and still merge
 * when their members share a fan-out naming stem (`auth-1`/`auth-2`).
 *
 * 6 hours. The stem is a second, independent witness that two clusters are one dispatch — but
 * a witness that can bridge ACROSS fork points (the whole point of the redesign) needs a tighter
 * outer bound than the unbounded single-linkage chain the old design produced. Six hours covers
 * a staggered dispatch with a long pause (lunch, a meeting, CI retry) while keeping day-apart
 * efforts with coincidentally similar names separate. The burst window above handles the tight
 * case; this handles the stretched one, and only when names corroborate.
 */
export const STEM_BRIDGE_WINDOW_MS = 6 * 60 * 60 * 1000;

const FAMILY_PATTERNS = [
  // wf_11177c4b-466-1  ->  wf_11177c4b-466      (Claude Code / workflow fan-out)
  { re: /^(.*?)-\d+$/, name: 'numeric-suffix' },
  // agent-aa19e5803c75700cb -> agent            (generic agent-<hash>)
  { re: /^(agent|task|job|run|session)[-_][0-9a-f]{6,}$/i, name: 'agent-hash' },
  // feature/foo-1 -> feature/foo
  { re: /^(.*)\.\d+$/, name: 'dotted-suffix' },
];

/**
 * Name-based inference: checks an explicit user override first (returns rule 'user-override'
 * when one matches — this always wins, regardless of what provenance would say), then falls
 * through to the naming patterns. Used directly for the override check; used as the FALLBACK,
 * with its result relabelled `name-fallback:<rule>`, when provenance cannot answer. Exported
 * standalone (rather than folded into assignFamilies) because it needs no git access at all —
 * useful on its own, and it is what the safety net degrades to when everything else fails.
 */
export function inferFamily(name, overrides = []) {
  for (const o of overrides) {
    try {
      const re = o instanceof RegExp ? o : new RegExp(o);
      const m = name.match(re);
      if (m) return { family: m[1] ?? m[0], rule: 'user-override' };
    } catch {
      /* a bad user regex must not take down the scan */
    }
  }
  for (const { re, name: rule } of FAMILY_PATTERNS) {
    const m = name.match(re);
    if (m) return { family: m[1], rule };
  }
  return { family: name, rule: 'singleton' };
}

// forkPoint() lived here — `git merge-base <base> <head>`, the original primary family signal.
// It is deleted rather than kept "in case", because it had been dead since the burst-clustering
// redesign landed and a dead implementation of a REFUTED idea is worse than no implementation:
// the next reader finds a plausible helper, the module header still described it as the primary
// signal (it did, until this commit), and the refutation lives nowhere near either. The reasoning
// for dropping it is now in the family-inference header above, which is where it is load-bearing.

/**
 * When a workstream's worktree came into existence, in epoch milliseconds, or null if holt
 * cannot determine it at all.
 *
 * PRIMARY: the mtime of the linked worktree's private `gitdir` file
 * (`<root>/.git/worktrees/<name>/gitdir`), located via `git rev-parse --git-dir` rather than by
 * guessing the metadata directory's name (git disambiguates it on a collision). Written once,
 * at `git worktree add` time, and VERIFIED not to be touched again by ordinary use (a commit
 * inside the worktree changes `HEAD`/`index`, not `gitdir`).
 *
 * FALLBACK (used when the worktree has no such metadata — the primary worktree, or a backend
 * without linked-worktree files): the worktree's own per-worktree HEAD reflog, oldest entry,
 * read via `git log -g` — NOT `git reflog`, which is on holt's permanently-refused command list
 * (see git.mjs DESTRUCTIVE_ALWAYS) because it can rewrite the ref it reads from; `log -g` reads
 * the identical data through the allowlisted, read-only `log` machinery. This is read from
 * WITHIN the worktree (`HEAD`, not the branch name), because each worktree has its own private
 * HEAD reflog: reading the BRANCH's reflog instead would report when the branch was created,
 * which is a different and often much older moment when a worktree is later added for a
 * pre-existing branch — verified live, see the file-level comment above.
 */
async function creationTimeMs(root, wPath) {
  const gd = await git(['rev-parse', '--git-dir'], { cwd: wPath }).catch(() => null);
  if (gd && gd.code === 0) {
    const raw = gd.stdout.trim();
    const abs = path.isAbsolute(raw) ? raw : path.resolve(wPath, raw);
    try {
      const st = await fs.stat(path.join(abs, 'gitdir'));
      return st.mtimeMs;
    } catch {
      /* not a linked worktree (e.g. primary) — fall through to the reflog */
    }
  }

  const lg = await git(['log', '-g', '--date=iso-strict', '--format=%gd', 'HEAD'], { cwd: wPath })
    .catch(() => null);
  if (lg && lg.code === 0) {
    const lines = lg.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    // `log -g` lists newest-first; the OLDEST entry is the worktree's creation moment.
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/@\{([^}]+)\}/);
      const t = m ? Date.parse(m[1]) : NaN;
      if (!Number.isNaN(t)) return t;
    }
  }
  return null;
}

/** Single-linkage clustering of {id, t} by time: a new cluster starts whenever the gap to the
 *  previous (sorted) entry exceeds `windowMs`. */
function clusterBySingleLink(items, windowMs) {
  const sorted = [...items].sort((a, b) => a.t - b.t);
  const clusters = [];
  let cur = [];
  let prevT = null;
  for (const it of sorted) {
    if (prevT !== null && it.t - prevT > windowMs) {
      clusters.push(cur);
      cur = [];
    }
    cur.push(it.id);
    prevT = it.t;
  }
  if (cur.length) clusters.push(cur);
  return clusters;
}

/**
 * Assign `family`/`familyRule` to every workstream: user override, then creation-burst
 * clustering with name-stem corroboration, then name as a last resort.
 *
 * THE REDESIGN (refutation wbllbr27p finding 1-2). The first provenance design grouped by
 * fork point, then single-linked by creation time within each fork group. On a stable trunk
 * — the overwhelmingly common case, where main does not move between dispatches — EVERY
 * worktree shares the same fork point, so the fork-point grouping provided zero discrimination
 * and the 60-minute single-linkage chain merged unrelated efforts hours apart into one family.
 * Cross-dispatch waste was silently downgraded to "expected fan-out", `holt plan` lost its
 * collapse recommendation, and `holt context` returned an empty sibling list for a genuine
 * 17ms-apart fan-out separated by one intervening commit.
 *
 * The redesign drops fork point as a signal entirely and uses TWO independent witnesses:
 *
 *   CREATION-BURST (primary)   Single-link cluster ALL non-primary worktrees by creation time
 *                              within `familyWindowMs` (default 60min). A burst is a tight
 *                              cluster of worktrees created close together — the shape of a
 *                              real fan-out, staggered by minutes not hours.
 *
 *   NAME-STEM BRIDGE (secondary)  When two burst-clusters carry the same fan-out naming stem
 *                              (`auth-1`/`auth-2`), merge them — ACROSS fork points — up to
 *                              `STEM_BRIDGE_WINDOW_MS` (default 6h) between the clusters'
 *                              nearest members. The stem is a second, independent witness that
 *                              two clusters are one stretched dispatch, and 6h is the outer
 *                              bound on a paused-but-same-dispatch fan-out (lunch, a meeting,
 *                              a CI retry). Day-apart efforts with coincidentally similar names
 *                              stay separate.
 *
 * Fork point is no longer computed or used. A stable trunk makes it non-discriminating, and
 * an intervening commit on main makes it confidently wrong (two worktrees created 17ms apart
 * get different fork points and lose their sibling relationship). Creation time + naming are
 * the two signals that survive both cases.
 */
export async function assignFamilies(root, workstreams, {
  familyOverrides = [],
  familyWindowMs = DEFAULT_FAMILY_WINDOW_MS,
  stemBridgeWindowMs = STEM_BRIDGE_WINDOW_MS,
  base = null,
} = {}) {
  // USER REGEXES ARE SCREENED BEFORE THEY RUN ON THIS THREAD. A pattern that backtracks without
  // bound cannot be interrupted once `match` has entered it, so it is first run against these
  // exact names in a worker that CAN be killed; only what completes there is used here. Costs
  // nothing when there are no overrides, which is the usual case. See src/saferegex.mjs.
  const safeOverrides = await screenOverrides(familyOverrides, workstreams.map((w) => w.id), {
    onDeclined: (declined) => process.stderr.write(declinedMessage(declined)),
  });

  const results = new Map();
  const pending = [];
  for (const w of workstreams) {
    const named = inferFamily(w.id, safeOverrides);
    if (named.rule === 'user-override') {
      results.set(w.id, { family: named.family, familyRule: 'user-override' });
    } else if (w.isPrimary) {
      // The primary worktree is the repository root — it was never DISPATCHED, so it has no
      // dispatch-mates by definition. Left in the clustering, its reflog-derived "creation time"
      // (really the repo's) routinely falls inside some dispatch's window and sweeps the root
      // into that family — a relationship class the old naming heuristic could essentially never
      // produce (roots are not named `agent-3`), found live by adversarial review.
      results.set(w.id, { family: w.id, familyRule: 'primary-worktree' });
    } else {
      pending.push(w);
    }
  }

  if (pending.length) {
    // Creation time is the primary signal. No fork point is computed — see the redesign note
    // above for why it was dropped.
    const timed = await pmap(pending, async (w) => {
      const t = await creationTimeMs(root, w.path);
      return { id: w.id, t };
    });

    // Worktrees WITH a creation time: cluster by burst, then bridge by stem.
    const withTime = timed.filter((p) => p.t != null);
    // Worktrees WITHOUT a creation time: fall through to naming fallback below.
    const withoutTime = timed.filter((p) => p.t == null).map((p) => p.id);

    if (withTime.length) {
      // STEP 1: CREATION-BURST CLUSTERING (primary).
      // Single-link by creation time across ALL worktrees (not grouped by fork point). A tight
      // burst of creations is the shape of a real fan-out; the window is a guess about
      // orchestration speed, and 60min covers a staggered dispatch while keeping day-apart
      // efforts separate.
      let clusters = clusterBySingleLink(withTime, familyWindowMs);

      // STEP 2: NAME-STEM BRIDGE (secondary, ACROSS fork points).
      // When two burst-clusters carry the same fan-out naming stem, merge them — up to
      // STEM_BRIDGE_WINDOW_MS between the clusters' nearest members. The stem is a second,
      // independent witness that two clusters are one stretched dispatch. Singleton name-rules
      // (no fan-out pattern) contribute nothing — a name like `karl` is not evidence of a
      // shared dispatch.
      if (clusters.length > 1) {
        const stemOf = (id) => {
          const n = inferFamily(id, []);
          return n.rule !== 'singleton' ? n.family : null;
        };
        // For each cluster, compute its time span [min, max] and the set of stems it carries.
        const clusterInfo = clusters.map((ids) => {
          const members = withTime.filter((p) => ids.includes(p.id));
          const minT = Math.min(...members.map((m) => m.t));
          const maxT = Math.max(...members.map((m) => m.t));
          const stems = new Set();
          for (const id of ids) {
            const stem = stemOf(id);
            if (stem) stems.add(stem);
          }
          return { ids, minT, maxT, stems };
        });

        // Merge clusters that share a stem AND whose FARTHEST members are within
        // stemBridgeWindowMs. Iterative pairwise merging with updated time spans — NOT union-find
        // — because union-find is transitive: A-B within 6h and B-C within 6h merges A-C even
        // when A-C are 10h apart, which is the same unbounded-chain problem the redesign dropped
        // fork-point grouping to fix. Iterative merging with span updates ensures the ENTIRE
        // span of a merged cluster is considered before another cluster joins it.
        let merged = clusterInfo.map((c) => ({ ...c, ids: [...c.ids] }));
        let changed = true;
        while (changed) {
          changed = false;
          for (let i = 0; i < merged.length && !changed; i++) {
            for (let j = i + 1; j < merged.length && !changed; j++) {
              const a = merged[i], b = merged[j];
              let sharedStem = false;
              for (const s of a.stems) { if (b.stems.has(s)) { sharedStem = true; break; } }
              if (!sharedStem) continue;
              // FARTHEST-MEMBERS gap: the max distance between any member of one cluster and any
              // member of the other. This ensures the merged cluster's total span stays within
              // the window — a chain of 3h gaps cannot span 10h through transitive merges.
              const gap = Math.max(
                Math.abs(a.maxT - b.minT),
                Math.abs(b.maxT - a.minT),
              );
              if (gap <= stemBridgeWindowMs) {
                merged[i] = {
                  ids: [...a.ids, ...b.ids],
                  minT: Math.min(a.minT, b.minT),
                  maxT: Math.max(a.maxT, b.maxT),
                  stems: new Set([...a.stems, ...b.stems]),
                };
                merged.splice(j, 1);
                changed = true;
              }
            }
          }
        }
        clusters = merged.map((c) => c.ids);
      }

      // STEP 3: LABEL. The family label is a stable, opaque identifier derived from the
      // earliest creation time in the cluster — not from a fork commit (which is no longer
      // computed) and not from a name (which is the fallback, not the primary). The timestamp
      // makes it stable across re-runs and distinguishable from name-fallback labels.
      clusters.forEach((ids) => {
        const members = withTime.filter((p) => ids.includes(p.id));
        const minT = Math.min(...members.map((m) => m.t));
        const label = `burst:${new Date(minT).toISOString().replace(/[:.]/g, '')}`;
        for (const id of ids) results.set(id, { family: label, familyRule: 'creation-burst' });
      });
    }

    // Worktrees without a creation time fall through to the naming fallback.
  }

  return workstreams.map((w) => {
    if (results.has(w.id)) return { ...w, ...results.get(w.id) };
    // Creation time could not be determined: fall back to naming, and say so honestly.
    const named = inferFamily(w.id, []); // overrides already resolved in the pass above
    return { ...w, family: named.family, familyRule: `name-fallback:${named.rule}` };
  });
}

/**
 * The complete attribute vocabulary of a `git worktree list --porcelain` record. Closed on
 * purpose: it is what lets a raw newline inside the WORKTREE PATH be told apart from the start of
 * the next attribute — see the framing note in parseWorktreePorcelain().
 */
const WORKTREE_ATTR_KEYS = new Set(['HEAD', 'branch', 'detached', 'bare', 'locked', 'prunable']);

/**
 * Parse `git worktree list --porcelain`.
 * Records are blank-line separated; each is a set of "key value" lines, with bare
 * keys (bare, detached, locked, prunable) having no value.
 *
 * THE PATH IS NOT QUOTED, AND THAT USED TO TRUNCATE IT. Unlike a LOCK REASON — which git C-quotes,
 * and which unquotePorcelain() above exists to decode — this command emits the worktree path as
 * RAW BYTES. A directory name may legally contain a newline on POSIX, so one record then spans two
 * physical lines, and reading line-by-line kept only the first. REPRODUCED against production:
 *
 *   created:    ".../wt/weird\nwt"
 *   discovered: ".../wt/weird"
 *
 * That is worse than dropping the worktree. holt reported the workstream as PRESENT at a path
 * nothing is at, so every scan, rescue and at-risk check aimed at a directory that does not exist
 * while the real one — which may hold uncommitted work existing nowhere else — was never read.
 *
 * FIXED HERE, IN THE PARSER, not at the five call sites that run this command: a continuation line
 * is one that arrives while the record has seen `worktree` and NO attribute yet, and is not itself
 * an attribute key. Since the vocabulary above is closed and git always emits `HEAD` (or `bare`)
 * immediately after the path, that boundary is exact rather than heuristic — and it needs no
 * `git version` gate, unlike `worktree list -z` which only landed in git 2.36.
 *
 * WHAT THIS STILL CANNOT SEE, stated rather than glossed: a path whose bytes after a newline spell
 * an attribute key exactly — a directory literally named `weird\nbare`. Line framing cannot carry
 * that at all, so no reader of THIS stream can recover it; only `-z` can, and requiring git 2.36
 * to read an ordinary repository is the worse trade. The realistic case — any other newline —
 * is now correct, where before every one of them silently truncated.
 *
 * Same defect class as the batched object reader (`catFileBatch`, src/git.mjs) and as
 * `listTrackedFiles()`: a legal-but-unusual byte in a path silently re-frames a git protocol.
 * Pinned by test/unit/git-path-framing.test.mjs.
 */
export function parseWorktreePorcelain(stdout) {
  const out = [];
  /** @type {Record<string, any>|null} */
  let cur = null;
  // True between a `worktree` line and the first attribute of that record — the only window in
  // which a physical line can be a continuation of the path rather than a new field.
  let inPath = false;
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const sp = line.indexOf(' ');
    const key = sp === -1 ? line : line.slice(0, sp);
    const val = sp === -1 ? true : line.slice(sp + 1);

    if (inPath && cur && !WORKTREE_ATTR_KEYS.has(key)) {
      // Still inside the path — including an EMPTY line, which for a path containing "\n\n" is a
      // path byte and not the end of the record. The record can only end once an attribute has
      // been seen, which every real record emits.
      cur.path += `\n${line}`;
      continue;
    }
    if (line === '') {
      if (cur) { out.push(cur); cur = null; }
      inPath = false;
      continue;
    }
    if (key === 'worktree') {
      if (cur) out.push(cur);
      cur = { path: val === true ? '' : val, detached: false, bare: false, locked: false, prunable: false };
      inPath = true;
    } else if (cur) {
      inPath = false;
      if (key === 'HEAD') cur.head = val;
      else if (key === 'branch') cur.branch = val;
      else if (key === 'detached') cur.detached = true;
      else if (key === 'bare') cur.bare = true;
      else if (key === 'locked') { cur.locked = true; cur.lockReason = val === true ? '' : unquotePorcelain(val); }
      else if (key === 'prunable') { cur.prunable = true; cur.prunableReason = val === true ? '' : val; }
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Discover git worktrees from any path inside the repo. */
export async function discoverGitWorktrees(cwd) {
  const root = await repoRoot(cwd);
  if (!root) {
    // repoRoot() returns null for two situations that must not be reported the same way: no git
    // repository at all, and a BARE repository — a real repo, just with no working tree, which
    // makes `--show-toplevel` fail exactly the way it does outside any repo at all. Distinguish
    // them here, once, so every caller upstream can stop telling someone standing in a perfectly
    // real bare repo that they are not in a git repository. See repoAbsenceError() below.
    //
    // Same defensiveness as repoRoot() itself: a cwd that does not exist at all makes `git`
    // REJECT (ENOENT is not a numeric exit code, see git.mjs), not resolve with a failing code.
    // Uncaught, that turns "you're not in a repo" into an unhandled rejection instead of the
    // clean answer every other absent-repo path already gives.
    const bare = await git(['rev-parse', '--is-bare-repository'], { cwd })
      .then((r) => r.code === 0 && r.stdout.trim() === 'true')
      .catch(() => false);

    // A BARE REPOSITORY WITH LINKED WORKTREES IS THE CANONICAL WORKTREE LAYOUT, not a dead end.
    // `git worktree list` runs fine from the bare repo and enumerates every live checkout — the
    // record filter below already drops the bare entry itself. The old refusal here told a user
    // standing in `repo.git` beside two working checkouts that holt "needs at least one checkout;
    // run it from a normal clone instead" — both halves false, proven by adversarial review
    // driving holt's own exported functions from the bare side. Discovery re-roots at the first
    // live checkout; the refusal survives only for a bare repo with NO worktrees, where its
    // message is actually true.
    if (bare) {
      const wl = await git(['worktree', 'list', '--porcelain'], { cwd }).catch(() => null);
      if (wl && wl.code === 0) {
        const live = parseWorktreePorcelain(wl.stdout).filter((w) => !w.bare);
        if (live.length > 0) return discoverGitWorktrees(live[0].path);
      }
    }
    return { root: null, workstreams: [], vcs: null, bare };
  }

  const r = await git(['worktree', 'list', '--porcelain'], { cwd: root });
  if (r.code !== 0) {
    return { root, workstreams: [], vcs: 'git', error: r.stderr.trim() };
  }

  const records = parseWorktreePorcelain(r.stdout).filter((w) => !w.bare);
  // isPrimary is CANONICALISED, not string-compared. git reports the real path while the caller
  // may hold a symlinked or short-name one — on macOS /var vs /private/var, on Windows an 8.3
  // name — so a raw comparison marks NO worktree as primary. That silently disables the
  // primary-tree protection, which matters more than it looks: git REFUSES to lock the main
  // worktree, so the hook is its only defence, and it is selected by exactly this flag.
  const canonRoot = foldCase(await canonicalPath(root));
  const workstreams = await Promise.all(records.map(async (w) => ({
    id: path.basename(w.path),
    path: w.path,
    vcs: 'git',
    head: w.head ?? null,
    branch: w.branch ? w.branch.replace(/^refs\/heads\//, '') : null,
    detached: w.detached,
    locked: w.locked,
    lockReason: w.lockReason ?? null,
    prunable: w.prunable,
    prunableReason: w.prunableReason ?? null,
    isPrimary: foldCase(await canonicalPath(w.path)) === canonRoot,
  })));

  return { root, workstreams, vcs: 'git' };
}

/**
 * jj workspace discovery lives in src/jj.mjs — it needs real work to resolve paths, because
 * `jj workspace list` does not print them. Re-exported here so callers have one entry point.
 *
 * Absence of jj is not an error and must never be reported as "no workstreams" — that would be
 * exactly the fail-open-on-missing-evidence defect this tool exists to catch.
 */
export { discoverJjWorkspaces } from './jj.mjs';

/**
 * Full discovery. Returns every workstream holt can see, tagged by backend,
 * with families assigned.
 */
export async function discover(cwd, {
  familyOverrides = [], includeJj = true, familyWindowMs = DEFAULT_FAMILY_WINDOW_MS, base = null,
} = {}) {
  const g = await discoverGitWorktrees(cwd);
  if (!g.root) {
    return {
      root: null, vcs: null, workstreams: [], jj: null,
      error: g.bare ? 'bare-repository' : 'not-a-git-repository', bare: !!g.bare,
    };
  }

  let jj = null;
  if (includeJj) {
    try {
      jj = await _discoverJj(g.root);
    } catch (err) {
      jj = { available: false, workstreams: [], unresolved: [], reason: `jj-probe-threw: ${err.message}` };
    }
  }

  // Merge: a jj workspace whose path matches a git worktree is the same workstream.
  const byPath = new Map();
  for (const w of g.workstreams) byPath.set(path.resolve(w.path), w);
  if (jj?.workstreams?.length) {
    for (const w of jj.workstreams) {
      if (!w.path) continue;
      const key = path.resolve(w.path);
      if (byPath.has(key)) byPath.get(key).alsoJj = true;
      else byPath.set(key, w);
    }
  }

  const workstreams = await assignFamilies(g.root, disambiguate([...byPath.values()]), {
    familyOverrides, familyWindowMs, base,
  });

  return { root: g.root, vcs: g.vcs, workstreams, jj, error: null };
}

/**
 * Make workstream ids unique.
 *
 * FOUND ON A REAL REPOSITORY: six worktrees at
 *   .../landing/A-memory-core/stage, .../landing/B-context-compiler/stage, …
 * all had the basename `stage`. Everything downstream keys on id — unique work, collisions,
 * the delete gate — so six distinct workstreams silently became one. `holt gate stage` would
 * have answered about whichever happened to be found first, which for a tool that authorises
 * deletion is the worst possible kind of wrong.
 *
 * Only ambiguous ids get lengthened, so the common case stays readable.
 */
export function disambiguate(workstreams) {
  const counts = new Map();
  for (const w of workstreams) counts.set(w.id, (counts.get(w.id) ?? 0) + 1);

  const used = new Set();
  return workstreams.map((w) => {
    if (counts.get(w.id) === 1) { used.add(w.id); return w; }

    const segments = String(w.path ?? '').split(path.sep).filter(Boolean);
    // Walk up the path adding parent segments until the id is unique.
    for (let take = 2; take <= Math.min(segments.length, 5); take++) {
      const candidate = segments.slice(-take).join('/');
      if (!used.has(candidate)) {
        used.add(candidate);
        return { ...w, id: candidate, ambiguousBasename: w.id };
      }
    }
    // Pathological fallback: full path is always unique.
    const full = String(w.path);
    used.add(full);
    return { ...w, id: full, ambiguousBasename: w.id };
  });
}
