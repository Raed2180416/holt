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
 * WHAT "UNIQUE" MEANS HERE, AND WHY IT MUST BE PER TREE ENTRY. The honest question is not "is
 * this stash commit reachable from a branch" — it never is, by construction, so answering that
 * way would refuse every drop forever and teach people to switch the guard off. The question is
 * whether the exact Git change it carries is durably reachable: operation + path + mode + object
 * type + object id. A blob alone is not authority to delete an entry. The same bytes at
 * `docs/deploy.sh` do not preserve `bin/deploy.sh`; mode 100644 does not preserve its executable
 * 100755 counterpart; and a regular file does not preserve a symlink whose target string happens
 * to hash to the same blob. Deletion is work too: a tombstone for `obsolete.js` is not preserved
 * merely because the old blob remains in base. Run `git stash apply` and commit, and that exact
 * change is now in a ref's history — the stash then holds nothing unique, and `drop` goes back to
 * being allowed. Nothing about the stash commit changed; the change's reachability did.
 *
 * READ-ONLY. `git stash list` cannot be used: `stash` sits in src/git.mjs's DESTRUCTIVE_ALWAYS
 * gate, refused unconditionally, and rightly so. It is also only a wrapper — git implements
 * `stash list` as a reflog walk of refs/stash — so this module reads the same reflog with
 * `git log -g`, which is Tier SAFE. Every command below is Tier SAFE. Nothing here writes.
 */

import { git, chunkByArgvBytes, ARGV_BYTE_BUDGET } from './git.mjs';

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
  if (!r || r.code !== 0) {
    // A failed reflog walk is empty evidence, not evidence of an empty stash. Prove the one benign
    // failure separately with show-ref's tri-state contract: 0 = present, 1 = absent, anything
    // else = the ref could not be inspected. A broken refs/stash must therefore fail closed too.
    const probe = await git(['show-ref', '--verify', '--quiet', 'refs/stash'], { cwd, timeout })
      .catch(() => null);
    if (probe?.code === 1) return [];
    const detail = r?.stderr?.trim() || probe?.stderr?.trim() || 'stash reflog probe failed';
    throw new Error(detail);
  }
  const out = [];
  let truncated = false;
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [selector, message, oid] = line.split('\0');
    if (!selector || !oid) throw new Error('stash reflog returned a malformed entry');
    // Read ONE PAST THE CAP so "holt stopped at 25" stays distinguishable from "there are exactly
    // 25". Concluding "there must be more" from "I hit the limit" is the same absence-of-evidence
    // mistake this module exists to end, one scope down: it makes the guard hedge about a stash it
    // did in fact read in full, and a hedge on a provably safe drop is over-refusal.
    if (out.length >= MAX_ENTRIES) { truncated = true; break; }
    out.push({ selector, message: message ?? '', oid });
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
    // `git log --raw --format=` may place a record separator newline before the raw header. A path
    // may itself begin with a newline, so normalise only the token in header position, never paths.
    const t = toks[i].replace(/^(?:\r?\n)+/, '');
    if (!t.startsWith(':')) continue;
    const fields = t.slice(1).split(' ');
    const srcMode = fields[0];
    const dstMode = fields[1];
    const srcSha = fields[2];
    const dstSha = fields[3];
    const status = (fields[4] ?? '').trim();
    const takesTwo = status.startsWith('R') || status.startsWith('C');
    const p1 = toks[++i];
    const p2 = takesTwo ? toks[++i] : null;
    if (p1 === undefined) break;
    recs.push({
      srcMode, dstMode, srcSha, dstSha, status,
      src: takesTwo ? p1 : null,
      path: takesTwo ? p2 : p1,
    });
  }
  return recs;
}

const NULL_OID = /^0+$/;

/**
 * Git tree-entry type implied by a valid tree mode. `ls-tree` reports symlinks as type `blob`;
 * mode 120000 is therefore essential to distinguish them from regular 100644/100755 files.
 * Unknown modes withdraw the check instead of being guessed into an identity.
 *
 * @param {string} mode
 * @returns {'blob'|'tree'|'commit'|null}
 */
function entryTypeForMode(mode) {
  if (/^100[0-7]{3}$/.test(mode) || mode === '120000') return 'blob';
  if (mode === '040000' || mode === '40000') return 'tree';
  if (mode === '160000') return 'commit';
  return null;
}

/**
 * The authority key. Every field is part of what deletion would erase.
 *
 * @param {{operation?: 'present'|'delete', path: string, mode: string, type: string, sha: string}} entry
 */
function entryIdentity(entry) {
  return `${entry.operation ?? 'present'}\0${entry.path}\0${entry.mode}\0${entry.type}\0${entry.sha}`;
}

/**
 * Every exact tree entry a single stash entry carries that its base did not, plus every path
 * either side touched.
 *
 * THREE SOURCES, because the entry stores three different states and losing any one of them is
 * losing work:
 *   - the entry's own tree vs base   — the working tree as it stood
 *   - the index commit vs base       — staged content, which can DIFFER from the working tree
 *                                      (stage a change, edit further, stash: both versions are
 *                                      in there, and both die with the entry)
 *   - the untracked commit's tree    — files in no commit anywhere, the most final loss of all
 *
 * `paths` collects BOTH sides of every record, deletes and rename sources included, to keep the
 * history walk complete for every path the stash changed. Merely appearing at a rename's source
 * is not authority for its destination: the path remains part of `entryIdentity` below.
 */
async function entryContent(cwd, oid, { timeout }) {
  const candidates = new Map(); // entryIdentity -> {operation, sha, path, mode, type, layer}
  const paths = new Set();
  let identitiesValid = true;

  /**
   * @param {string} sha
   * @param {string} path
   * @param {string} mode
   * @param {string} type
   * @param {string} layer
   * @param {'present'|'delete'} [operation]
   */
  const add = (sha, path, mode, type, layer, operation = 'present') => {
    if (!sha || NULL_OID.test(sha) || !path || !mode || !type) {
      identitiesValid = false;
      return;
    }
    const candidate = { operation, sha, path, mode, type, layer };
    const key = entryIdentity(candidate);
    if (!candidates.has(key)) candidates.set(key, candidate);
  };

  const diffInto = async (from, to, layer) => {
    // Disable rename folding so a rename retains BOTH pieces of work: source-path deletion and
    // destination-path entry. A destination blob alone does not preserve the removal intent.
    const r = await git(['diff', '--raw', '--no-renames', '--no-abbrev', '-z', from, to], { cwd, timeout })
      .catch(() => null);
    if (!r || r.code !== 0) return false;
    for (const rec of parseRawZ(r.stdout)) {
      if (rec.path) paths.add(rec.path);
      if (rec.src) paths.add(rec.src);
      if (rec.status.startsWith('D')) {
        // Absence is an operative tree change. Bind it to the exact entry removed so a deletion
        // of different prior content at the same path cannot masquerade as the same work.
        const type = entryTypeForMode(rec.srcMode);
        if (!type) identitiesValid = false;
        else add(rec.srcSha, rec.path, rec.srcMode, type, layer, 'delete');
      } else {
        const type = entryTypeForMode(rec.dstMode);
        if (!type) identitiesValid = false;
        else add(rec.dstSha, rec.path, rec.dstMode, type, layer);
      }
    }
    return true;
  };

  // Read the parent vector once. A stash must have both a base and index parent. Treating a
  // failed parent probe as "that parent does not exist" silently omits staged/untracked states.
  const parentResult = await git(['rev-list', '--parents', '-n', '1', oid], { cwd, timeout })
    .catch(() => null);
  const parentFields = parentResult?.code === 0
    ? parentResult.stdout.trim().split(/\s+/).filter(Boolean)
    : [];
  const parentVectorValid = parentFields[0] === oid
    && parentFields.length >= 3 && parentFields.length <= 4;
  const baseParent = parentVectorValid ? parentFields[1] : null;
  const indexParent = parentVectorValid ? parentFields[2] : null;
  const untrackedParent = parentVectorValid ? (parentFields[3] ?? null) : null;

  let ok = parentVectorValid;
  if (baseParent) ok = (await diffInto(baseParent, oid, 'working tree')) && ok;
  if (baseParent && indexParent) ok = (await diffInto(baseParent, indexParent, 'staged')) && ok;

  if (untrackedParent) {
    // The untracked commit has no meaningful base to diff against — every blob in it is a file
    // git had never tracked, so the whole tree is candidate content.
    const r = await git(['ls-tree', '-r', '-z', '--full-tree', untrackedParent], { cwd, timeout })
      .catch(() => null);
    if (!r || r.code !== 0) ok = false;
    else {
      for (const rec of r.stdout.split('\0')) {
        if (!rec) continue;
        const tab = rec.indexOf('\t');
        if (tab < 0) continue;
        const [mode, reportedType, sha] = rec.slice(0, tab).split(/\s+/);
        const path = rec.slice(tab + 1);
        const type = entryTypeForMode(mode);
        if (!type || type !== reportedType) identitiesValid = false;
        else { add(sha, path, mode, type, 'untracked'); paths.add(path); }
      }
    }
  }

  return { candidates: [...candidates.values()], paths: [...paths], ok: ok && identitiesValid };
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
 * Which exact tree changes are reachable from a real ref?
 *
 * `--full-history` is not optional. Default history simplification prunes commits whose change to
 * a path is "uninteresting" relative to a simplified parent, so a version of a file that only
 * ever existed on a merged side branch can be walked straight past — and this function's whole
 * job is to prove content EXISTS somewhere, where a false negative means holt claims work is
 * unique when git could still hand it back.
 *
 * The pathspec is what keeps this affordable: without it the walk emits changed entries across the
 * whole repository. With it, only history at paths the stash actually touches is considered.
 *
 * `rev-list --objects` is deliberately insufficient: it emits object ids but discards the path,
 * mode and type that give those objects meaning. `git log --raw --root -m` emits every entry when
 * it is introduced or changed, including root entries and merge resolutions. `--full-history`
 * prevents path simplification from pruning a reachable side-branch version.
 *
 * @returns {Promise<Set<string>|null>} reachable change identities, or null when the walk could not
 *   be completed — which is NOT the same as "nothing is reachable" and is never treated as such.
 */
async function reachableEntries(cwd, paths, { timeout }) {
  if (!paths.length) return new Set();
  const tips = await reachableTips(cwd, { timeout });
  if (!tips || !tips.length) return new Set(); // an unborn/ref-less repo reaches nothing
  if (paths.length > MAX_PATHS) return null;
  // THE TIP LIST IS UNBOUNDED AND THE ARGUMENT LIST IS NOT. `paths` is capped at MAX_PATHS just
  // above; `tips` is one oid per ref, and a repository carrying tens of thousands of refs (every
  // PR ref in a busy monorepo) builds an argv past ARG_MAX, where `execve` answers E2BIG. Entries
  // reachable from a SET of tips are the union of the entries in each tip's history, so walking the
  // tips in argv-sized groups gives exactly the same set — see the ceiling note in git.mjs.
  const pathBytes = paths.reduce((n, p) => n + Buffer.byteLength(p, 'utf8') + 1, 0);
  const groups = chunkByArgvBytes(tips, ARGV_BYTE_BUDGET, pathBytes + 64);
  const set = new Set();
  for (const group of groups) {
    const r = await git([
      'log', '--raw', '--root', '-m', '--full-history', '--no-renames', '--no-abbrev', '-z',
      '--format=', ...group, '--', ...paths,
    ],
      { cwd, timeout }).catch(() => null);
    // A walk that could not be completed is NOT "nothing is reachable" — see this function's
    // contract. One failed group withdraws the whole answer rather than under-reporting it.
    if (!r || r.code !== 0) return null;
    for (const rec of parseRawZ(r.stdout)) {
      if (!rec.path) continue;
      if (rec.status.startsWith('D')) {
        if (!rec.srcSha || NULL_OID.test(rec.srcSha)) return null;
        const type = entryTypeForMode(rec.srcMode);
        if (!type) return null;
        set.add(entryIdentity({ operation: 'delete', path: rec.path, mode: rec.srcMode, type, sha: rec.srcSha }));
      } else {
        if (!rec.dstSha || NULL_OID.test(rec.dstSha)) return null;
        const type = entryTypeForMode(rec.dstMode);
        if (!type) return null;
        set.add(entryIdentity({ operation: 'present', path: rec.path, mode: rec.dstMode, type, sha: rec.dstSha }));
      }
    }
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
 *                   unique: Array<{operation: 'present'|'delete', path: string, mode: string,
 *                                  type: string, sha: string, layer: string}>,
 *                   uniqueCount: number, checked: boolean}>,
 *   atRisk: Array<object>, total: number, checked: boolean,
 *   truncated: boolean,
 * }>}
 *
 * `truncated` — the walk stopped at MAX_ENTRIES and there is at least one entry beyond it that
 * holt did NOT examine. It was already being returned and merely undeclared, which let callers
 * read it while the checker insisted it did not exist; the guard depends on it to tell "nothing
 * at risk" apart from "nothing at risk among the ones I read", so it is part of the contract.
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
      reachable = await reachableEntries(cwd, content.paths, { timeout });
    } catch {
      reachable = null;
    }
    const checked = content.ok && reachable !== null;
    // Unverified entries report their content as unique, and say so through `checked:false`.
    // The alternative — treating "holt could not look" as "nothing here" — is the precise failure
    // this module exists to end, and it is the one shape of silence that loses work.
    const unique = reachable === null
      ? content.candidates
      : content.candidates.filter((cand) => !reachable.has(entryIdentity(cand)));
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
    const noun = e.uniqueCount === 1 ? 'tree change' : 'tree changes';
    return `  • ${e.selector}: ${e.message}\n`
      + `      ${e.uniqueCount} exact ${noun} no ref holds: ${sample}${more}`
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
