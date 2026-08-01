// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — the stash, read as a STORE OF WORK rather than as a place work goes to disappear.
 *
 * THE HOLE THIS CLOSES. Every other evidence path in holt answers "does this content exist
 * anywhere else" by looking at worktrees: uncommitted files, the index, committed deltas. A
 * stash is none of those. The moment `git stash push -u` succeeds the working tree and the
 * index are byte-clean, so `scan`/`analyze` report the workstream safe, `gate` prints
 * "✓ disposable", and every stash rule in src/agent.mjs evaluates `holding.length === 0` and
 * returns a flat silent allow. Measured end to end, with the ONLY copy of real content inside
 * the stash: `git stash pop` -> allow, `git stash drop` -> allow, `git stash clear` -> allow.
 *
 * The earlier fix that put drop/pop/clear rules in the guard's table at all resolved them
 * against WORKSTREAM evidence — and post-sweep the workstreams are exactly what is NOT holding
 * the work. The stash is the workstream now. So the evidence has to come from the stash itself.
 *
 * WHAT A STASH ENTRY IS. A commit. `stash@{n}` has two or three parents:
 *   ^1  the HEAD commit at stash time         (the base — carries nothing new)
 *   ^2  the index as it stood                 (staged content)
 *   ^3  the untracked files, when -u/-a used  (content in NO commit anywhere)
 * and the entry's own tree is the working tree as it stood. Nothing chains entries together:
 * `refs/stash` names stash@{0} only, and every older entry is reachable through the reflog of
 * that ref and nothing else. Which is precisely why `drop` and `clear` are final — they rewrite
 * that reflog, and the commits they unlink become unreachable in the same breath.
 *
 * WHAT "UNIQUE" MEANS HERE, AND WHY IT MUST BE PER-BLOB. The honest question is not "is this
 * stash commit reachable from a branch" — it never is, by construction, so answering that way
 * would refuse every drop forever and teach people to switch the guard off. The question is
 * whether the CONTENT it carries is reachable: the blobs. That distinction is the whole
 * difference between a guard that relaxes when you do the right thing and one that nags. Run
 * `git stash apply` and commit, and the identical blob is now in a ref's history — the entry
 * holds nothing unique, and `drop` goes back to being allowed. Nothing about the stash commit
 * changed; the content's reachability did.
 *
 * READ-ONLY. `git stash list` cannot be used: `stash` sits in src/git.mjs's DESTRUCTIVE_ALWAYS
 * gate, refused unconditionally, and rightly so. It is also only a wrapper — git implements
 * `stash list` as a reflog walk of refs/stash — so this module reads the same reflog with
 * `git log -g`, which is Tier SAFE. Every command below is Tier SAFE. Nothing here writes.
 */

import { git } from './git.mjs';

/** Entries examined. A repository with more stashes than this has a bigger problem than a cap. */
export const MAX_ENTRIES = 25;

/** Paths carried into the reachability walk's pathspec, per entry. */
export const MAX_PATHS = 400;

/**
 * `git stash list`, without `git stash`.
 *
 * @param {string} cwd
 * @returns {Promise<Array<{selector: string, message: string, oid: string}>>}
 *   Newest first, exactly as `git stash list` orders them. EMPTY when there is no refs/stash —
 *   which is the overwhelmingly common case and costs one failed rev walk.
 */
export async function stashEntries(cwd, { timeout = 10_000 } = {}) {
  const r = await git(['log', '-g', '--format=%gd%x00%gs%x00%H', 'refs/stash'], { cwd, timeout })
    .catch(() => null);
  // Exit 128 with "unknown revision" IS the answer "this repository has no stash". A throw here
  // would be indistinguishable from "holt could not look", and those must never be conflated.
  if (!r || r.code !== 0) return [];
  const out = [];
  let truncated = false;
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [selector, message, oid] = line.split('\0');
    if (!selector || !oid) continue;
    out.push({ selector, message: message ?? '', oid });
    if (out.length >= MAX_ENTRIES) { truncated = true; break; }
  }
  // LOUD BREAK: if the repo has more stash entries than MAX_ENTRIES, holt stops scanning at the
  // cap — and entries beyond the cap might hold the only copy of real work. Silently stopping
  // is the exact "silence that loses work" this module exists to end. The `truncated` flag is
  // surfaced to the caller so the guard and the brief can say "there are MORE entries holt did
  // not check — review them manually before dropping anything."
  if (truncated) {
    out.push({ selector: '...', message: `(holt scanned ${MAX_ENTRIES} of more stash entries — review the rest manually)`, oid: null, truncated: true });
  }
  return out;
}

/**
 * Split `git diff --raw -z` output into records.
 *
 * The -z form emits `:<srcmode> <dstmode> <srcsha> <dstsha> <status>\0<path>\0`, and for renames
 * and copies a SECOND path follows. Parsed positionally rather than by regex over the whole
 * stream, because a path may contain anything at all including newlines — which is the reason
 * -z exists and the reason the non-z form must not be used here.
 */
function parseRawZ(stdout) {
  const toks = stdout.split('\0');
  const recs = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!t.startsWith(':')) continue;
    const fields = t.slice(1).split(' ');
    const dstSha = fields[3];
    const status = (fields[4] ?? '').trim();
    const takesTwo = status.startsWith('R') || status.startsWith('C');
    const p1 = toks[++i];
    const p2 = takesTwo ? toks[++i] : null;
    if (p1 === undefined) break;
    recs.push({ dstSha, status, src: takesTwo ? p1 : null, path: takesTwo ? p2 : p1 });
  }
  return recs;
}

const NULL_OID = /^0+$/;

/**
 * Every blob a single stash entry carries that its base did not, plus every path either side
 * touched.
 *
 * THREE SOURCES, because the entry stores three different states and losing any one of them is
 * losing work:
 *   - the entry's own tree vs base   — the working tree as it stood
 *   - the index commit vs base       — staged content, which can DIFFER from the working tree
 *                                      (stage a change, edit further, stash: both versions are
 *                                      in there, and both die with the entry)
 *   - the untracked commit's tree    — files in no commit anywhere, the most final loss of all
 *
 * `paths` collects BOTH sides of every record, deletes and rename sources included. Those are not
 * candidates — nothing new is at `src` — but they scope the reachability walk below, and a
 * rename's content lives at the source path in history. Leaving them out reported a stashed
 * rename as unique content.
 */
async function entryContent(cwd, oid, { timeout }) {
  const candidates = new Map(); // `${sha}\0${path}` -> {sha, path, layer}
  const paths = new Set();

  const add = (sha, path, layer) => {
    if (!sha || NULL_OID.test(sha) || !path) return;
    const key = `${sha}\0${path}`;
    if (!candidates.has(key)) candidates.set(key, { sha, path, layer });
  };

  const diffInto = async (from, to, layer) => {
    const r = await git(['diff', '--raw', '--no-abbrev', '-z', from, to], { cwd, timeout })
      .catch(() => null);
    if (!r || r.code !== 0) return false;
    for (const rec of parseRawZ(r.stdout)) {
      if (rec.path) paths.add(rec.path);
      if (rec.src) paths.add(rec.src);
      // A deletion carries no new content; everything else has a destination blob.
      if (!rec.status.startsWith('D')) add(rec.dstSha, rec.path, layer);
    }
    return true;
  };

  let ok = await diffInto(`${oid}^1`, oid, 'working tree');

  const hasParent = async (n) => {
    const r = await git(['rev-parse', '--verify', '--quiet', `${oid}^${n}^{commit}`], { cwd, timeout })
      .catch(() => null);
    return !!r && r.code === 0 && r.stdout.trim().length > 0;
  };

  if (await hasParent(2)) ok = (await diffInto(`${oid}^1`, `${oid}^2`, 'staged')) && ok;

  if (await hasParent(3)) {
    // The untracked commit has no meaningful base to diff against — every blob in it is a file
    // git had never tracked, so the whole tree is candidate content.
    const r = await git(['ls-tree', '-r', '-z', '--full-tree', `${oid}^3`], { cwd, timeout })
      .catch(() => null);
    if (!r || r.code !== 0) ok = false;
    else {
      for (const rec of r.stdout.split('\0')) {
        if (!rec) continue;
        const tab = rec.indexOf('\t');
        if (tab < 0) continue;
        const [, type, sha] = rec.slice(0, tab).split(/\s+/);
        const path = rec.slice(tab + 1);
        if (type === 'blob') { add(sha, path, 'untracked'); paths.add(path); }
      }
    }
  }

  return { candidates: [...candidates.values()], paths: [...paths], ok };
}

/**
 * Every ref that is not the stash, plus every worktree's HEAD.
 *
 * `--all` cannot be used: it INCLUDES refs/stash, so the stash's own blobs would come back
 * "reachable" and this whole module would report nothing, ever — the exact silence it exists to
 * break. Detached worktree HEADs are added explicitly because they are not under refs/ at all,
 * and in a repository full of worktrees that is not an edge case.
 *
 * refs/holt/rescue/* and refs/holt/discard/* are ordinary refs and are therefore counted. That
 * is deliberate: content captured by `holt rescue` or `holt discard` genuinely IS reachable, and
 * a guard that ignored its own escape hatch would refuse the cleanup it just made safe.
 */
async function reachableTips(cwd, { timeout }) {
  const tips = new Set();
  const refs = await git(['for-each-ref', '--format=%(objectname) %(refname)'], { cwd, timeout })
    .catch(() => null);
  if (!refs || refs.code !== 0) return null;
  for (const line of refs.stdout.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const oid = line.slice(0, sp);
    const name = line.slice(sp + 1).trim();
    if (name === 'refs/stash') continue;
    if (oid) tips.add(oid);
  }
  const wts = await git(['worktree', 'list', '--porcelain'], { cwd, timeout }).catch(() => null);
  if (wts && wts.code === 0) {
    for (const line of wts.stdout.split('\n')) {
      if (line.startsWith('HEAD ')) tips.add(line.slice(5).trim());
    }
  }
  const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd, timeout }).catch(() => null);
  if (head && head.code === 0 && head.stdout.trim()) tips.add(head.stdout.trim());
  return [...tips].filter(Boolean);
}

/**
 * Which of these blobs are reachable from a real ref?
 *
 * `--full-history` is not optional. Default history simplification prunes commits whose change to
 * a path is "uninteresting" relative to a simplified parent, so a version of a file that only
 * ever existed on a merged side branch can be walked straight past — and this function's whole
 * job is to prove content EXISTS somewhere, where a false negative means holt claims work is
 * unique when git could still hand it back.
 *
 * The pathspec is what keeps this affordable: without it the walk enumerates every tree and blob
 * in the repository. With it, only objects at the paths the stash actually touches.
 *
 * @returns {Promise<Set<string>|null>} reachable blob OIDs, or null when the walk could not be
 *   completed — which is NOT the same as "nothing is reachable" and is never treated as such.
 */
async function reachableBlobs(cwd, paths, { timeout }) {
  if (!paths.length) return new Set();
  const tips = await reachableTips(cwd, { timeout });
  if (!tips || !tips.length) return new Set(); // an unborn/ref-less repo reaches nothing
  if (paths.length > MAX_PATHS) return null;
  const r = await git(['rev-list', '--objects', '--full-history', ...tips, '--', ...paths],
    { cwd, timeout }).catch(() => null);
  if (!r || r.code !== 0) return null;
  const set = new Set();
  for (const line of r.stdout.split('\n')) {
    const oid = line.split(' ')[0];
    if (oid && oid.length >= 40) set.add(oid);
  }
  return set;
}

/**
 * THE ANSWER THE GUARD AND THE REPORT BOTH ASK FOR: what does the stash hold that nothing else
 * does?
 *
 * Never throws. A repository with no stash, a git that failed, a path holt could not read — all
 * of them produce a shaped result with `entries: []` or `checked: false`, because the caller's
 * decision differs between "there is nothing there" and "holt could not look", and an exception
 * would erase that distinction at the one moment it matters.
 *
 * @param {string} cwd
 * @returns {Promise<{
 *   entries: Array<{selector: string, message: string, oid: string,
 *                   unique: Array<{path: string, sha: string, layer: string}>,
 *                   uniqueCount: number, checked: boolean}>,
 *   atRisk: Array<object>, total: number, checked: boolean,
 * }>}
 */
export async function stashState(cwd, { timeout = 10_000 } = {}) {
  const empty = { entries: [], atRisk: [], total: 0, checked: true, truncated: false };
  let entries;
  try {
    entries = await stashEntries(cwd, { timeout });
  } catch {
    return { ...empty, checked: false };
  }
  if (!entries.length) return empty;

  // The last entry may be the truncation marker — separate it from real entries.
  const truncated = entries.some((e) => e.truncated);
  const realEntries = entries.filter((e) => !e.truncated);

  const out = [];
  let allChecked = true;
  for (const e of realEntries) {
    let content;
    try {
      content = await entryContent(cwd, e.oid, { timeout });
    } catch {
      content = { candidates: [], paths: [], ok: false };
    }
    // `null` here means "the walk did not complete", which is NOT "nothing is reachable" — the
    // annotation keeps that union visible to the checker, which otherwise infers the initialiser's
    // type and loses the distinction the next ten lines depend on.
    /** @type {Set<string>|null} */
    let reachable = null;
    try {
      reachable = await reachableBlobs(cwd, content.paths, { timeout });
    } catch {
      reachable = null;
    }
    const checked = content.ok && reachable !== null;
    // Unverified entries report their content as unique, and say so through `checked:false`.
    // The alternative — treating "holt could not look" as "nothing here" — is the precise failure
    // this module exists to end, and it is the one shape of silence that loses work.
    const unique = reachable === null
      ? content.candidates
      : content.candidates.filter((cand) => !reachable.has(cand.sha));
    if (!checked) allChecked = false;
    out.push({ ...e, unique, uniqueCount: unique.length, checked });
  }

  return {
    entries: out,
    atRisk: out.filter((e) => e.uniqueCount > 0),
    total: out.length,
    checked: allChecked,
    truncated,
  };
}

/**
 * The stash half of a guard message: which entries die, and what dies with them.
 *
 * Kept here rather than in src/agent.mjs so the CLI, the brief and the guard cannot drift into
 * describing the same entries three different ways.
 */
export function describeStash(state, { max = 3 } = {}) {
  const lines = state.atRisk.slice(0, max).map((e) => {
    const sample = e.unique.slice(0, 3).map((u) => `${u.path} (${u.layer})`).join(', ');
    const more = e.uniqueCount > 3 ? `, +${e.uniqueCount - 3} more` : '';
    return `  • ${e.selector}: ${e.message}\n`
      + `      ${e.uniqueCount} file(s) whose content no ref holds: ${sample}${more}`
      + (e.checked ? '' : '\n      (holt could not complete the reachability check for this entry)');
  });
  // LOUD BREAK: if holt stopped scanning at MAX_ENTRIES, entries beyond the cap were NOT checked
  // and might hold the only copy of real work. This must be visible in every surface that uses
  // describeStash — the guard message, the brief, the CLI — so nobody drops a stash thinking
  // holt verified all entries when it did not.
  if (state.truncated) {
    lines.push(`  ⚠ holt scanned only the first ${MAX_ENTRIES} stash entries — there are more. `
      + 'Review the remaining entries manually before dropping anything.');
  }
  return lines.join('\n');
}
