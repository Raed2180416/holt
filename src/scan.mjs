// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — the scanner.
 *
 * Produces, for every workstream, the two deltas that matter:
 *
 *   committed   — what BASE LACKS from this workstream's HEAD.
 *                 Computed with `merge-tree --write-tree` then diffing base against the
 *                 merged tree. This is the ONLY correct instrument for the question.
 *                 `git diff base...head` answers "what did the branch do since divergence",
 *                 which over-reports the moment base acquires the same content by another
 *                 route — cherry-pick, re-implementation, a parallel landing. Using the
 *                 three-dot form here is a documented way to report work as stranded when
 *                 it is not.
 *
 *   uncommitted — tracked modifications plus untracked files.
 *                 THIS IS THE LAYER GIT CANNOT RELATE. No git command compares uncommitted
 *                 state across worktrees; merge-tree sees only commits. In the repo holt
 *                 was built against, the committed layer flagged 4 interesting worktrees
 *                 while the uncommitted layer held configuration keys absent from base.
 *                 A tool that scanned only the committed layer would have been confidently,
 *                 quietly wrong.
 *
 * Symbols are resolved in a second phase, because every workstream compares against the SAME
 * base: extracting base symbols once for the union of touched files turns an O(workstreams ×
 * files) problem into O(files) + one batched ctags run per workstream.
 *
 * Every field carries how it was obtained, so a caller can never mistake an approximation
 * for a measurement.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { git, catFileBatch, splitNul, pmap, resolveRef, GitRefused } from './git.mjs';
import { resolveBackend, symbolsOnDisk, symbolsAtBase, diffSymbols, symbolKey } from './symbols.mjs';
import { pathContentKey } from './content-identity.mjs';

const BASE_CANDIDATES = ['main', 'master', 'trunk', 'develop', 'default'];

/** Pick the base ref to compare everything against. */
export async function resolveBase(root, explicit) {
  if (explicit) {
    const oid = await resolveRef(root, explicit);
    if (!oid) throw new Error(`holt: base ref '${explicit}' does not resolve in ${root}`);
    return { ref: explicit, oid, how: 'explicit' };
  }

  // origin/HEAD is the correct source for "what is this project's default branch" and is the
  // documented best practice. But it answers a DIFFERENT question from the one holt asks.
  //
  // holt asks: what will this work be landed INTO? That is the local branch. Measured on a
  // real repository whose local `main` sat 363 commits ahead of `origin/main`: taking
  // origin/HEAD as the base made every one of 39 worktrees appear to carry ~1,700 files of
  // unique work, and reported ZERO as safe to delete. The tool was not wrong about the diff —
  // it was answering against a base nobody lands into. Local-ahead is the normal state for
  // anyone working offline, on a fork, or ahead of a slow remote.
  //
  // So: take origin/HEAD's branch NAME, then prefer the LOCAL branch of that name whenever it
  // is a strict descendant of the remote. Never prefer local when the two have diverged —
  // that would silently pick a base the user has not reconciled.
  const sym = await git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { cwd: root });
  if (sym.code === 0) {
    const remoteRef = sym.stdout.trim();
    const remoteOid = await resolveRef(root, remoteRef);
    if (remoteOid) {
      const localName = remoteRef.replace(/^origin\//, '');
      const localOid = await resolveRef(root, localName);
      if (localOid && localOid !== remoteOid) {
        const isDescendant = await git(
          ['merge-base', '--is-ancestor', remoteOid, localOid], { cwd: root },
        );
        if (isDescendant.code === 0) {
          const ahead = await git(['rev-list', '--count', `${remoteOid}..${localOid}`], { cwd: root });
          return {
            ref: localName,
            oid: localOid,
            how: 'local-ahead-of-origin',
            note: `local '${localName}' is ${ahead.stdout.trim()} commit(s) ahead of ${remoteRef}; using local because that is what work lands into`,
          };
        }
      }
      if (localOid === remoteOid) return { ref: localName, oid: localOid, how: 'origin/HEAD (local in sync)' };
      return { ref: remoteRef, oid: remoteOid, how: 'origin/HEAD' };
    }
  }

  for (const cand of BASE_CANDIDATES) {
    const oid = await resolveRef(root, cand);
    if (oid) return { ref: cand, oid, how: 'conventional-name' };
  }

  const oid = await resolveRef(root, 'HEAD');
  if (oid) return { ref: 'HEAD', oid, how: 'primary-head-fallback' };

  throw new Error(`holt: could not determine a base ref in ${root} (is this an empty repository?)`);
}

async function pathUsable(p) {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

/** COMMITTED delta: what does base lack from head? */
export async function committedDelta(root, baseOid, headOid, { strictReadOnly, timeout }) {
  if (!headOid || headOid === baseOid) {
    return { files: [], how: 'identical-to-base', conflicted: false };
  }

  if (strictReadOnly) {
    const r = await git(['diff', '--name-only', '-z', `${baseOid}...${headOid}`], { cwd: root, timeout });
    if (r.code !== 0) return { files: [], how: 'three-dot-failed', conflicted: false, error: r.stderr.trim() };
    return {
      files: splitNul(r.stdout),
      how: 'three-dot-approximate',
      conflicted: false,
      caveat: 'strictReadOnly: over-reports content base already acquired by another route',
    };
  }

  const mt = await git(['merge-tree', '--write-tree', baseOid, headOid], { cwd: root, timeout });
  // exit 0 = clean, 1 = conflicts (tree still on line 1), >1 = error.
  if (mt.code > 1) {
    return { files: [], how: 'merge-tree-failed', conflicted: false, error: mt.stderr.trim() };
  }
  const tree = mt.stdout.split('\n')[0].trim();
  if (!/^[0-9a-f]{40,64}$/.test(tree)) {
    return { files: [], how: 'merge-tree-no-tree', conflicted: mt.code === 1, error: 'unparseable merge-tree output' };
  }

  // A RENAME TOUCHES TWO PATHS, AND THE OLD ONE IS THE ONE THAT COLLIDES.
  //
  // `--name-only` reports only the destination when git detects a rename, so a worktree that
  // renamed shared.js -> alpha.js reported touching ONLY alpha.js. The collision prefilter pairs
  // workstreams by shared touched path, so against a sibling that renamed the same file to
  // beta.js there was no intersection, no pair, and merge-tree — which proves conflicts — was
  // never run on them. git says `CONFLICT (rename/rename)` and holt printed "No collisions. No two
  // workstreams contest the same content."
  //
  // That is the worst shape of wrong: not noise, but an active all-clear on a proven conflict.
  //
  // `--name-status -M` gives both sides of a rename, so the ORIGINAL path is recorded too. The
  // prefilter's job is "which pairs might conflict", where a false positive costs one merge-tree
  // run and a false negative costs a broken landing — so it should be generous, and now is.
  const names = await git(['diff', '--name-status', '-M', '-z', baseOid, tree], { cwd: root, timeout });
  const files = [];
  if (names.code === 0) {
    const parts = splitNul(names.stdout);
    for (let i = 0; i < parts.length; i++) {
      const status = parts[i];
      if (!status) continue;
      // R and C carry TWO paths: source then destination. Everything else carries one.
      if (/^[RC]\d*$/.test(status)) {
        if (parts[i + 1]) files.push(parts[i + 1]);
        if (parts[i + 2]) files.push(parts[i + 2]);
        i += 2;
      } else {
        if (parts[i + 1]) files.push(parts[i + 1]);
        i += 1;
      }
    }
  }
  return {
    files: [...new Set(files)],
    how: 'merge-tree',
    conflicted: mt.code === 1,
    mergedTree: tree,
  };
}

/**
 * Normalise CRLF and lone CR to LF, at the byte level. Never applied to binary content — see
 * `lineEndingOnlyVsBase` below, which decides binary-ness with git's own instrument BEFORE this
 * ever runs on a file's bytes.
 */
function normalizeEol(buf) {
  const out = Buffer.alloc(buf.length);
  let j = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0x0d) {
      out[j++] = 0x0a;
      if (buf[i + 1] === 0x0a) i++; // CRLF collapses to one LF, not two
    } else {
      out[j++] = b;
    }
  }
  return out.subarray(0, j);
}

/**
 * Parse `git diff --raw --no-renames -z`'s output into path -> {oldMode, newMode, status}.
 * Format, repeated per changed file: `:<oldmode> <newmode> <oldsha> <newsha> <status>\0<path>\0`.
 */
function parseRawDiff(stdout) {
  const parts = splitNul(stdout);
  const byPath = new Map();
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = /^:(\d+) (\d+) [0-9a-f]+ [0-9a-f]+ ([A-Z])/.exec(parts[i]);
    if (!meta) continue; // unparseable entry — simply absent from the map, which fails closed
    byPath.set(parts[i + 1], { oldMode: meta[1], newMode: meta[2], status: meta[3] });
  }
  return byPath;
}

/** Parse `git diff --numstat -z`'s output into path -> {binary: boolean}. */
function parseNumstat(stdout) {
  const byPath = new Map();
  for (const rec of splitNul(stdout)) {
    const [added, deleted, ...rest] = rec.split('\t');
    const p = rest.join('\t'); // a path could itself contain a tab
    if (!p) continue;
    byPath.set(p, { binary: added === '-' || deleted === '-' });
  }
  return byPath;
}

/**
 * Is the WHOLE committed delta line-ending noise — every file identical to base once CRLF/CR is
 * normalised, and nothing else different?
 *
 * MEASURED, on the 50-language independent-oracle benchmark: 50 of 150 disposable misses were
 * one worktree per repository whose entire committed delta was the SAME FILE(S), re-saved with
 * CRLF line endings. `merge-tree` correctly reports "base lacks this exact tree" — a CRLF byte
 * and an LF byte are different bytes to git — but base holds the identical TEXT, so nothing here
 * is work a human or agent produced. This is `redundantWith`'s sibling-redundancy reasoning
 * (src/analyze.mjs) applied to base itself instead of a living worktree.
 *
 * A CONJUNCTION, not a majority vote, over every file in `files`: any ONE that this cannot prove
 * is line-ending-only disqualifies the ENTIRE workstream. Disqualifying cases:
 *   - missing from base or from `tree` (an add, a delete, or either half of a rename —
 *     `--no-renames` forces a rename's two halves to read as plain add/delete, rather than
 *     depending on this repo's diff.renames config)
 *   - a file-mode change (chmod +x with byte-identical content is still "another kind of change")
 *   - BINARY CONTENT — never normalised. `--numstat` is git's OWN binary call, the same
 *     instrument that decides whether to write a binary patch, so this defers to git rather than
 *     re-deriving a heuristic. A `.png` that happens to contain the byte pair 0x0D 0x0A is not a
 *     line ending, and treating it as one could call a real image change "nothing base lacks".
 *   - a git failure or unparseable output on any instrument — refusing is FAIL-CLOSED: an
 *     unproven file counts as a real change, never as line-ending noise.
 *
 * THREE GIT PROCESSES TOTAL, regardless of file count — one `--raw` (status+mode), one
 * `--numstat` (binary), one `catFileBatch` (content) — not three per file. A per-file loop here
 * would repeat exactly the spawn-per-file cost `catFileBatch` (see its doc comment in git.mjs)
 * was built to eliminate, for a check that runs on every workstream in every scan.
 *
 * Deliberately narrow to the instruments that can actually prove it: only runs when `committed`
 * came from a clean (non-conflicted) `merge-tree`, so there is one unambiguous merged tree to
 * compare files against. `strictReadOnly`'s three-dot approximation has no merged tree and is
 * already labelled approximate everywhere it surfaces — this does not try to extend it.
 */
async function lineEndingOnlyVsBase(root, baseOid, committed, files, { timeout }) {
  if (committed.how !== 'merge-tree' || committed.conflicted || !committed.mergedTree) return false;
  if (files.length === 0) return false;
  const tree = committed.mergedTree;

  const [raw, num] = await Promise.all([
    git(['diff', '--raw', '--no-renames', '-z', baseOid, tree, '--', ...files], { cwd: root, timeout }),
    git(['diff', '--numstat', '-z', baseOid, tree, '--', ...files], { cwd: root, timeout }),
  ]);
  if (raw.code !== 0 || num.code !== 0) return false;
  const statuses = parseRawDiff(raw.stdout);
  const stats = parseNumstat(num.stdout);

  for (const f of files) {
    const st = statuses.get(f);
    if (!st || st.status !== 'M' || st.oldMode !== st.newMode) return false;
    const ns = stats.get(f);
    if (!ns || ns.binary) return false;
  }

  // Content comparison, batched: one `git cat-file --batch` process for every base/tree blob
  // this workstream needs, instead of `files.length * 2` separate `git show` spawns.
  const specs = files.flatMap((f) => [`${baseOid}:${f}`, `${tree}:${f}`]);
  const blobs = new Map();
  await catFileBatch(specs, { cwd: root, timeout }, (spec, content) => {
    blobs.set(spec, content);
  });
  for (const f of files) {
    const baseBlob = blobs.get(`${baseOid}:${f}`);
    const headBlob = blobs.get(`${tree}:${f}`);
    if (!baseBlob || !headBlob) return false; // missing content — refuse, don't guess
    if (!normalizeEol(baseBlob).equals(normalizeEol(headBlob))) return false;
  }
  return true;
}

/** UNCOMMITTED delta: the layer no git relationship command can see. */
async function uncommittedDelta(wtPath, { timeout }) {
  const status = await git(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { cwd: wtPath, timeout },
  );
  if (status.code !== 0) {
    return { files: [], untracked: [], how: 'status-failed', error: status.stderr.trim() };
  }

  const files = [];
  const untracked = [];
  const parts = status.stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    const xy = entry.slice(0, 2);
    const p = entry.slice(3);
    if (!p) continue;
    if (xy[0] === 'R' || xy[0] === 'C') i++; // consume rename source
    if (xy === '??') untracked.push(p);
    else files.push(p);
  }

  return { files, untracked, how: 'status+diff-HEAD' };
}

/**
 * Paths that are noise in every repo. Small and conservative on purpose.
 *
 * DIRECTORIES ARE DECLARED AS NAMES, NOT AS HAND-WRITTEN REGEXES, because the anchor is where
 * the bug was. Every entry here used to read `(^|\/)node_modules\//` — anchored on a trailing
 * slash, so it matched paths INSIDE the directory and never the directory entry itself. Git
 * prints the bare entry whenever what it found is not a directory it can descend into: a SYMLINK
 * (`node_modules -> ../../node_modules`, what pnpm and every linked monorepo produce) or a plain
 * file of that name. `.gitignore` carries the identical trailing-slash rule, so `node_modules/`
 * does not match the symlink either, git reports it untracked, and holt counted a 29-byte pointer
 * as work found nowhere else. Measured on holt's own repository: 8 of 10 worktrees were reported
 * "AT RISK — delete these and the work is gone" on that basis alone.
 *
 * Compiling the anchor in ONE place makes the mistake unavailable rather than merely corrected —
 * a name added to this list cannot be written with the wrong anchor, and the guard test named
 * 'at-risk set: every generated DIRECTORY is recognised bare' walks every name in every form.
 */
/**
 * THE RULE FOR THIS LIST, stated because getting it wrong destroys work.
 *
 * A directory belongs here only if its contents are REPRODUCIBLE BY A COMMAND from something else
 * in the repository — `npm ci` rebuilds node_modules, `cargo build` rebuilds target, a bundler
 * rebuilds dist. Losing them costs a rebuild. Nothing else qualifies, because everything on this
 * list is INVISIBLE to gate, rescue, risk, clean and the pre-tool-use guard: a worktree whose only
 * content sits here reads as byte-identical to an empty one.
 *
 * `vendor` WAS ON THIS LIST AND IS NOT REPRODUCIBLE. Go's `go mod vendor` regenerates it; a PHP
 * project's composer vendor is regenerable; but hand-vendored and hand-PATCHED dependencies are
 * the reason `vendor/` exists in most repositories that have one, and holt cannot tell which kind
 * it is looking at. Reproduced end to end: a worktree whose only content was
 * `vendor/patch.txt` reported "✓ disposable", `rescue` reported "nothingToRescue", the guard
 * ALLOWED `git worktree remove --force`, and after the removal the content existed in no git
 * object anywhere — permanently gone, with holt having said three times that there was nothing
 * there. That is the single catastrophic output this product exists to prevent.
 *
 * When in doubt a directory does NOT belong here. The cost of leaving one off is that a worktree
 * carrying only build output is not auto-reclaimed; the cost of putting one on wrongly is the
 * paragraph above.
 */
const GENERATED_DIRS = [
  'node_modules', '.git', 'target', 'dist', 'build', '__pycache__', '.venv', 'venv',
  '.next', 'coverage', '.pytest_cache', '.AppleDouble', '.idea', '.turbo',
  '.parcel-cache', '.gradle', '.terraform', '.tox',
  '.mypy_cache', '.ruff_cache',
];

/*
 * REMOVED, AND WHY — the rule above, applied to itself a second time.
 *
 * `tmp`, `temp`, `log`, `logs` and `.cache` were on this list and NONE of them is reproducible by
 * a command. They are conventional scratch names, and conventional scratch is exactly where people
 * put things that are not scratch. Both were reproduced end to end, with the loss verified rather
 * than assumed:
 *
 *   a hand-written logs/incident-postmortem.md   -> gate said "✓ disposable", the hook said allow,
 *                                                   `rm -rf` destroyed it, and `git fsck
 *                                                   --unreachable` found nothing, because the
 *                                                   content had never been a git object at all
 *   services/billing/tmp/reconciliation-notes.txt -> same, and `holt rescue` — the documented
 *                                                   escape hatch — returned nothingToRescue and
 *                                                   exited 0, inviting the deletion
 *
 * `.log` came off GENERATED_FILES for the same reason and by the same evidence (a top-level
 * decision.log was destroyed in the second reproduction).
 *
 * THE COST IS ACKNOWLEDGED: a worktree whose only content is a stray build log is no longer
 * auto-reclaimed. That is the correct trade. A worktree carrying only node_modules or dist is
 * still reclaimed, which is what keeps `clean` useful, and those two ARE reproducible — `npm ci`
 * and a build rebuild them. Losing a rebuild costs minutes; the paragraph above costs the work.
 *
 * This is the second time this list has destroyed real data (the first was `vendor`). The rule is
 * not "does this look like noise", it is "can a command in this repository recreate it".
 */

/**
 * Files, matched on their own terms.
 *
 * OS and editor droppings, and plainly regenerable output. Without these, a single .DS_Store —
 * created by merely opening a folder in Finder — would make every worktree on a Mac permanently
 * unclearable, which is the "safety that freezes the tool" failure mode.
 *
 * Dependency manifests are here too. A lockfile records what a resolver decided, not what an
 * agent wrote. Left in, they contribute thousands of package-name "symbols" — measured on a real
 * repo, producing findings like `object:node_modules/@ts-morph/common` presented as unique work.
 */
const GENERATED_FILES = [
  // `*.log` STAYS, and the split from the directory names above is deliberate rather than
  // inconsistent. A path SEGMENT named `logs` or `tmp` says nothing about provenance — people put
  // postmortems in logs/ and drafts in tmp/, which is how a hand-written
  // logs/incident-postmortem.md was destroyed. A file EXTENSION of `.log` is conventionally
  // machine-written, and the never-worse test pins the cost of pretending otherwise: `rm app.log`
  // became a refusal, which is daily friction on a daily action and exactly how a guard gets
  // uninstalled.
  //
  // The residual risk is named rather than hidden: content deliberately saved as `notes.log` is
  // invisible to holt. That is a worse trade to fix than to accept.
  /\.min\.(js|css)$/, /\.log$/,
  /(^|\/)\.DS_Store$/, /(^|\/)Thumbs\.db$/, /(^|\/)desktop\.ini$/,
  /\.lock$/, /(^|\/)package-lock\.json$/, /(^|\/)yarn\.lock$/, /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)Cargo\.lock$/, /(^|\/)poetry\.lock$/, /(^|\/)composer\.lock$/, /(^|\/)Gemfile\.lock$/,
  /(^|\/)go\.sum$/, /(^|\/)Pipfile\.lock$/, /(^|\/)gradle\.lockfile$/, /(^|\/)packages\.lock\.json$/,
];

/** A directory matches as the entry ITSELF (`x`, `a/x`) and as everything under it (`x/y`). */
const dirPattern = (name) =>
  new RegExp(`(^|/)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/|$)`);

const GENERATED = [...GENERATED_DIRS.map(dirPattern), ...GENERATED_FILES];

export { GENERATED_DIRS };

/**
 * THE COMMAND THAT RECREATES A GENERATED DIR, AS EVIDENCE IT EXISTS.
 *
 * The comment block above GENERATED_DIRS states the rule this list has now violated three times
 * (`vendor/`, then `logs/`+`tmp/`, now `build/`): "The rule is not 'does this look like noise',
 * it is 'can a command in this repository recreate it'" — and nothing ever checked for the
 * command. Reproduced end to end: a repo with NO build system, a hand-placed
 * `build/only.js`, `gate` printing "✓ disposable", `clean --apply` removing the worktree, and
 * `git fsck` finding nothing, because the content was never a git object. The directory's NAME
 * was the entire verdict, and names are exactly what this product exists to distrust.
 *
 * So each conditional name earns disposal from the MANIFEST whose install/build step recreates
 * it, checked per worktree root. `node_modules` is reproducible where package.json exists;
 * `target` where Cargo.toml (or a JVM build file) does; a bare `build/` in a repo with no build
 * system is just a directory somebody named build. `null` marks the unconditional entries —
 * `.git` (structural), OS/IDE droppings — which are machine-managed wherever they appear.
 *
 * THE NEVER-WORSE HALF IS PINNED TOO: with the manifest present, everything here stays
 * reclaimable — the monster fixture's worktree full of real build junk still cleans. Losing a
 * rebuild costs minutes; the alternative costs the work.
 */
const JS_MANIFESTS = ['package.json'];
const PY_MANIFESTS = ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile'];
const JVM_MANIFESTS = ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'];
const GENERATOR_MANIFESTS = {
  '.git': null,
  '.AppleDouble': null,
  '.idea': null,
  node_modules: JS_MANIFESTS,
  '.next': JS_MANIFESTS,
  '.turbo': JS_MANIFESTS,
  '.parcel-cache': JS_MANIFESTS,
  dist: [...JS_MANIFESTS, ...PY_MANIFESTS],
  build: [...JS_MANIFESTS, ...JVM_MANIFESTS, 'CMakeLists.txt', 'Makefile', 'meson.build'],
  target: ['Cargo.toml', ...JVM_MANIFESTS],
  coverage: [...JS_MANIFESTS, ...PY_MANIFESTS],
  __pycache__: PY_MANIFESTS,
  '.venv': PY_MANIFESTS,
  venv: PY_MANIFESTS,
  '.pytest_cache': PY_MANIFESTS,
  '.mypy_cache': PY_MANIFESTS,
  '.ruff_cache': PY_MANIFESTS,
  '.tox': ['tox.ini', ...PY_MANIFESTS],
  '.gradle': JVM_MANIFESTS,
  '.terraform': ['*.tf'],
};

/**
 * Which generated-dir names have their recreating command PRESENT in this worktree.
 * One readdir of the worktree root answers every manifest question at once.
 */
export async function generatedEvidence(wtPath) {
  let names = [];
  try { names = await fs.readdir(wtPath); } catch { /* unreadable root: no evidence, keep all conditional dirs protected */ }
  const present = new Set(names);
  const anyTf = names.some((n) => n.endsWith('.tf'));
  const active = new Set();
  for (const [dir, manifests] of Object.entries(GENERATOR_MANIFESTS)) {
    if (manifests === null) { active.add(dir); continue; }
    if (manifests.some((m) => (m === '*.tf' ? anyTf : present.has(m)))) active.add(dir);
  }
  return active;
}

const UNCONDITIONAL_DIR_RES = Object.entries(GENERATOR_MANIFESTS)
  .filter(([, m]) => m === null).map(([d]) => dirPattern(d));
const CONDITIONAL_DIR_RE = new Map(Object.entries(GENERATOR_MANIFESTS)
  .filter(([, m]) => m !== null).map(([d]) => [d, dirPattern(d)]));
/**
 * Scratch-named directories, treated as noise ONLY when the repository has gitignored them.
 *
 * These are deliberately NOT in GENERATED_DIRS. A path segment called `logs` or `tmp` proves
 * nothing about what is inside it — that assumption destroyed a hand-written incident postmortem.
 * But when the project's own .gitignore names the path, someone has stated it is not source, and
 * that statement is evidence in a way the folder name never was. See ignoredContent().
 */
const SCRATCH_WHEN_IGNORED = /(^|\/)(tmp|temp|log|logs|\.cache)(\/|$)/;

/**
 * @param {string} p
 * @param {Set<string>} [activeDirs]  the generated-dir names whose recreating manifest exists in
 *   the worktree under judgment (from generatedEvidence()). WITHOUT it, every name counts — the
 *   pre-evidence behaviour, kept for callers with no worktree in hand. WITH it, a conditional
 *   name matches only when its manifest was seen: `build/only.js` in a repo with no build system
 *   is not noise, it is the only copy of somebody's work wearing a noisy name.
 */
export function looksGenerated(p, activeDirs) {
  if (activeDirs === undefined) return GENERATED.some((re) => re.test(p));
  if (GENERATED_FILES.some((re) => re.test(p))) return true;
  if (UNCONDITIONAL_DIR_RES.some((re) => re.test(p))) return true;
  for (const d of activeDirs) {
    const re = CONDITIONAL_DIR_RE.get(d);
    if (re && re.test(p)) return true;
  }
  return false;
}

/**
 * THE AT-RISK FILE SET, in one place.
 *
 * The files in a scanned workstream whose content exists ONLY on disk: nothing in git holds them,
 * so removing or emptying the file destroys the only copy. Three layers, and the reason each is
 * in and `committed` is out:
 *
 *   uncommitted.files      tracked, modified — the MODIFICATION exists nowhere else
 *   uncommitted.untracked  untracked        — the whole file exists nowhere else
 *   ignored.files          gitignored       — git cannot see it, so holt cannot prove anything
 *                                             about it, and `clean --apply` already learned what
 *                                             deleting it costs
 *   committed.files        EXCLUDED         — a commit holds the content; `rm` of one is
 *                                             recoverable, so denying it would be pure noise
 *
 * Every layer here has already been filtered through looksGenerated() by scanFiles(), which is
 * why node_modules/, dist/, build/, coverage/, *.log, logs/, tmp/ and lockfiles can never appear
 * in it — the never-worse property of anything that intersects with this set is inherited, not
 * re-implemented.
 */
export function atRiskFiles(ws) {
  if (!ws || !ws.ok) return [];
  // THE FILE GATE'S AT-RISK SET IS UNCONDITIONAL ON GITIGNORED CONTENT.
  //
  // `contentAtRisk()` (analyze.mjs) reads `w.ignored.files` directly to feed the DISPOSABLE
  // verdict, and there a gitignored `build/` with no build manifest correctly REFUSES — holt
  // cannot verify it, and the owner's .gitignore entry is not proof the content is regenerable.
  // But `atRiskFiles()` feeds the FILE GATE: "would `rm build/out.js` destroy the only copy?"
  // A .gitignore entry declaring `build/` disposable IS the owner's answer to that question —
  // `rm -rf node_modules` on a gitignored `node_modules/` must stay allowed, or the guard
  // becomes the "safety that freezes the tool" the product exists not to be. So gitignored
  // entries are filtered with the unconditional GENERATED list here, while the disposable
  // verdict keeps the manifest-gated set from `contentAtRisk()`. The two answer different
  // questions and are right to use different evidence.
  const uncommitted = (ws.uncommitted?.files ?? []).filter(Boolean);
  const untracked = (ws.uncommitted?.untracked ?? []).filter(Boolean);
  const ignored = (ws.ignored?.files ?? []).filter((f) => Boolean(f) && !looksGenerated(f) && !SCRATCH_WHEN_IGNORED.test(f));
  return [...new Set([...uncommitted, ...untracked, ...ignored])];
}

/**
 * The same set, read straight from one `git status --porcelain=v1 -z --untracked-files=all
 * --ignored=matching` run instead of from a completed scan.
 *
 * WHY BOTH EXIST. atRiskFiles() is the authority and carries the full analysis with it, but
 * producing it costs a scan. A pre-tool hook runs in the agent's critical path on every single
 * shell command, so the guard needs a way to answer "is this path even interesting?" for the
 * common case — `rm -rf node_modules` — without paying for one. This parses the identical
 * evidence with the identical looksGenerated() filter, so the two cannot drift apart on what
 * counts as at risk — and the test named 'FILE GATE: the fast probe and scan.mjs agree on what
 * is at risk' walks every file atRiskFiles() reports and asserts the guard refuses to lose it,
 * because a probe that saw LESS than the scan would silently re-open the hole.
 *
 * @returns {Map<string,'uncommitted'|'untracked'|'gitignored'>} path -> which layer it is in
 */
export function atRiskFromStatus(stdoutZ, activeDirs) {
  const out = new Map();
  const parts = String(stdoutZ ?? '').split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry || entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const p = entry.slice(3);
    if (!p) continue;
    // A rename entry is followed by its source path; consume it so it is not read as an entry.
    if (xy[0] === 'R' || xy[0] === 'C') i++;
    // THE MANIFEST GATE IS FOR UNTRACKED/UNCOMMITTED CONTENT, NOT GITIGNORED.
    // A `!!` entry is gitignored — the .gitignore entry IS the provenance signal, so the
    // unconditional GENERATED list (no activeDirs) is the right filter. An untracked `??`
    // entry has no .gitignore declaration, so the manifest gate correctly applies: a
    // `node_modules/` with no package.json might be a hand-copied dependency patch.
    if (xy === '!!') {
      if (looksGenerated(p) || SCRATCH_WHEN_IGNORED.test(p)) continue;
      out.set(p, 'gitignored');
    } else {
      if (looksGenerated(p, activeDirs)) continue;
      if (xy === '??') out.set(p, 'untracked');
      else out.set(p, 'uncommitted');
    }
  }
  return out;
}


/**
 * Gitignored content a worktree is carrying.
 *
 * holt's analysis is built on git's view, and git deliberately does not track ignored files — so
 * holt cannot prove anything about them. That is fine for ANALYSIS, and it is stated as a limit.
 * It is NOT fine for DELETION: a worktree whose only extra content is a `.env` full of live
 * credentials, or a node_modules with a hand-applied patch, was being called "provably nothing to
 * lose" and removed. Absence of evidence is not evidence of absence — the same rule the rest of
 * this file follows.
 *
 * Recognisable build output (node_modules, dist, target, caches — the GENERATED list) is excluded,
 * because refusing to clean a worktree merely for having a dist/ would make the command useless.
 * What remains is content a human plausibly cares about, and its presence downgrades the verdict
 * from "provably disposable" to "holt cannot verify this".
 */
async function ignoredContent(wtPath, { timeout, activeDirs }) {
  const r = await git(['status', '--porcelain', '-z', '--ignored=matching', '--untracked-files=all'],
    { cwd: wtPath, timeout });
  if (r.code !== 0) return { files: [], how: 'ignored-probe-failed', error: r.stderr?.trim() };
  const files = [];
  for (const entry of r.stdout.split('\0')) {
    if (!entry || entry.length < 4) continue;
    if (entry.slice(0, 2) !== '!!') continue;      // '!!' marks an ignored path
    const p = entry.slice(3);
    // THE PROJECT'S OWN .gitignore IS THE PROVENANCE SIGNAL — the directory NAME is not.
    //
    // `logs/`, `tmp/` and `.cache/` came off GENERATED_DIRS because a hand-written
    // logs/incident-postmortem.md was reported disposable and destroyed. But that file was
    // UNTRACKED — nobody had declared it disposable. A path the repository has explicitly
    // gitignored is different in kind: someone wrote it down as not-source, and that is a far
    // stronger statement than a folder happening to be called `logs`.
    //
    // So the two cases are separated rather than traded off. Untracked content in a scratch-named
    // directory is protected (the gauntlet's loss). Gitignored content in one is noise (the
    // monster's `.cache/blob.bin` and `logs/`, planted precisely so that a worktree full of build
    // junk is still reclaimable — without this, "safety" freezes the tool it is protecting).
    // Evidence-aware: a generated-NAMED dir only counts as noise when the manifest that
    // recreates it exists in this worktree. See GENERATOR_MANIFESTS — the third data-loss
    // reproduction against this list, and the rule its own comment already stated.
    if (!p || looksGenerated(p, activeDirs) || SCRATCH_WHEN_IGNORED.test(p)) continue;
    // A TRAILING SLASH IS A DIRECTORY, AND SKIPPING IT DESTROYED REAL DATA.
    //
    // When .gitignore names a directory (`secrets/`), git's --ignored=matching collapses the whole
    // subtree to the ONE entry `secrets/` and never lists the files inside it. Dropping that entry
    // therefore erased the entire subtree from the verdict, and a worktree whose only unique
    // content was `secrets/prod.env` was reported as holding nothing base lacks — so
    // `holt clean --apply` deleted the only copy of live credentials. Reproduced 40/40.
    //
    // The directory IS the evidence. It is kept, with its slash, so the verdict downgrades to
    // "holt cannot verify this" exactly as it does for an ignored file. looksGenerated() above
    // still discards node_modules/, dist/, .cache/ and friends, so ordinary build output stays
    // disposable — verified, not assumed.
    files.push(p);
  }
  return { files: files.sort(), how: 'status --ignored' };
}

/** Phase 1: file-level deltas for one workstream. */
async function scanFiles(ws, ctx) {
  const { root, base, strictReadOnly, timeout } = ctx;

  const result = {
    ...ws,
    ok: false,
    reason: null,
    committed: { files: [], count: 0, how: 'not-run' },
    uncommitted: { files: [], untracked: [], count: 0, how: 'not-run' },
    touched: [],
    added: [],
    addedKeys: [],
    stats: { committedFiles: 0, uncommittedFiles: 0, untrackedFiles: 0, addedSymbols: 0 },
  };

  if (ws.prunable) {
    result.reason = `prunable: ${ws.prunableReason || 'working tree is gone'}`;
    return result;
  }
  if (!ws.path || !(await pathUsable(ws.path))) {
    result.reason = 'working directory missing or unreadable';
    return result;
  }

  // A jj workspace has no .git of its own, so `rev-parse HEAD` there fails. Its head arrives
  // pre-resolved from src/jj.mjs as the git commit id of `<name>@`.
  const headOid = ws.head ?? (ws.vcs === 'jj' ? null : await resolveRef(ws.path, 'HEAD'));
  if (!headOid) {
    result.reason = ws.vcs === 'jj'
      ? 'jj workspace commit could not be resolved (is this a colocated repo?)'
      : 'HEAD does not resolve (unborn branch?)';
    return result;
  }
  result.head = headOid;

  try {
    // Which generated-dir names have their recreating manifest in THIS worktree — one readdir,
    // shared by every layer below and carried on the result for downstream consumers, so the
    // scan and the guard cannot disagree about what counts as noise here.
    const activeDirs = await generatedEvidence(ws.path);
    result.generatedActive = [...activeDirs];

    const [committed, uncommitted, ignored] = await Promise.all([
      committedDelta(root, base.oid, headOid, { strictReadOnly, timeout }),
      // jj snapshots the working copy into `@` automatically, so under jj there IS no separate
      // uncommitted layer — the thing git cannot relate across worktrees simply does not exist.
      // Asking git for status inside a jj workspace would fail (no .git) and, worse, a failure
      // there would read as "clean".
      ws.vcs === 'jj'
        ? Promise.resolve({ files: [], untracked: [], how: 'jj-snapshot (working copy is part of @)' })
        : uncommittedDelta(ws.path, { timeout }),
      // Ignored content cannot be analysed, but it CAN be destroyed — so it must be seen.
      ws.vcs === 'jj'
        ? Promise.resolve({ files: [], how: 'n/a (jj)' })
        : ignoredContent(ws.path, { timeout, activeDirs }),
    ]);

    // FAIL-CLOSED ON INSTRUMENT FAILURE. Found by probing partial (blobless) clones: when
    // merge-tree cannot run — offline promisor remote, pruned objects, corrupt odb — it returns
    // an EMPTY file list, which is indistinguishable downstream from "no committed delta". A
    // worktree with committed-ahead work and a clean working tree would then be reported SAFE,
    // and clean --apply would delete it. An empty answer from a broken instrument is not an
    // answer (Law: prove the instrument can detect presence before trusting its silence).
    const committedFailed = ['merge-tree-failed', 'merge-tree-no-tree', 'three-dot-failed']
      .includes(committed.how);
    const statusFailed = uncommitted.how === 'status-failed';
    if (committedFailed || statusFailed) {
      result.reason = committedFailed
        ? `committed-delta instrument failed (${committed.how}: ${committed.error ?? 'unknown'}) — refusing to classify`
        : `status instrument failed (${uncommitted.error ?? 'unknown'}) — refusing to classify`;
      return result; // ok stays false -> UNKNOWN -> never safe, never cleaned
    }

    // Evidence-aware on every layer: a generated NAME only earns the noise filter when the
    // manifest that recreates it exists in this worktree (see GENERATOR_MANIFESTS). Without
    // this, untracked `dist/handmade.js` in a repo with no build system was dropped from the
    // at-risk set by its name alone — the same reasoning that destroyed logs/ content twice.
    const cFiles = committed.files.filter((f) => !looksGenerated(f, activeDirs));
    const uFiles = uncommitted.files.filter((f) => !looksGenerated(f, activeDirs));
    const uUntracked = (uncommitted.untracked ?? []).filter((f) => !looksGenerated(f, activeDirs));

    // THE SYMBOL-EXTRACTION SET IS UNCONDITIONAL, NOT MANIFEST-GATED.
    //
    // The manifest gate above protects at-risk FILES — a hand-placed `build/only.js` with no
    // build system is the only copy of somebody's work, and the at-risk set must not lose it.
    // But `touched` feeds SYMBOL EXTRACTION, and a generated-named directory is never source
    // code worth extracting symbols from — even a hand-copied `node_modules` patch is a
    // dependency, not authored work. ctags' own `--exclude=node_modules` only filters directory
    // traversal, not explicit file paths (verified: passing `node_modules/pkg/index.js` as an
    // explicit arg extracts its symbols despite `--exclude`). So `touched` is filtered with the
    // unconditional GENERATED list (no activeDirs), keeping the symbol layer clean while the
    // at-risk layers stay manifest-gated.
    const touchedFiles = [...new Set([
      ...committed.files.filter((f) => !looksGenerated(f)),
      ...uFiles.filter((f) => !looksGenerated(f)),
      ...uUntracked.filter((f) => !looksGenerated(f)),
    ])].sort();

    // BASE CAN BE THE "LIVING SIBLING" TOO. Measured on the 50-language independent-oracle
    // benchmark: one worktree per repository whose entire committed delta is the SAME FILE(S)
    // re-saved with CRLF line endings — merge-tree correctly says "base lacks this exact tree",
    // but base holds the identical text, so this holds no unique content. See
    // lineEndingOnlyVsBase()'s doc comment for the exact, conjunctive definition.
    const lineEndingOnlyVsBaseFlag = await lineEndingOnlyVsBase(
      root, base.oid, committed, cFiles, { timeout },
    );

    result.ok = true;
    result.committed = {
      files: cFiles, count: cFiles.length, how: committed.how,
      conflicted: committed.conflicted, caveat: committed.caveat ?? null,
      // CARRIED THROUGH, because it is a CONTENT IDENTITY and nothing else here is.
      //
      // merge-tree already computed it and it was being discarded one line later. Two worktrees
      // whose merged trees are the same oid carry byte-identical work relative to base — which is
      // exactly the question "does a living sibling already hold this", and answering it took
      // disposable recall from 0.40 to 1.00. File LISTS cannot answer it: two worktrees can touch
      // the same paths with different content, or different paths with the same content.
      mergedTree: committed.mergedTree ?? null,
      // See lineEndingOnlyVsBase() above: true only when the ENTIRE committed delta disappears
      // once CRLF/CR line endings are normalised against base. Consumed by src/analyze.mjs's
      // safeToDelete(), which is what actually turns it into a safe:true + redundantWith:['base']
      // verdict — this field is raw instrument output, not a verdict.
      lineEndingOnlyVsBase: lineEndingOnlyVsBaseFlag,
    };
    result.uncommitted = {
      files: uFiles, untracked: uUntracked, count: uFiles.length + uUntracked.length,
      how: uncommitted.how,
    };
    // THE FULL LIST, NOT A SAMPLE. This used to be `.slice(0, 50)` while `count` stayed the true
    // length — a list whose length disagreed with its own count. That is fine for a display
    // sample and fatal for an action: `holt rescue` has to CAPTURE every one of these paths and
    // then VERIFY each is in the resulting tree, and it cannot verify what it was never shown.
    // Callers that print take their own sample (safeToDelete slices to 3 and 10).
    result.ignored = {
      files: ignored?.files ?? [],
      count: ignored?.files?.length ?? 0,
      how: ignored?.how ?? 'not-run',
      error: ignored?.error,
    };
    result.touched = touchedFiles;
    result.stats = {
      committedFiles: cFiles.length,
      uncommittedFiles: uFiles.length,
      untrackedFiles: uUntracked.length,
      addedSymbols: 0,
    };

    // CONTENT IDENTITY, PER FILE — what `safeToDelete` needs to prove "a living sibling holds
    // this exact work" when the sibling holds it at a DIFFERENT PATH or in a different
    // indentation style. mergedTree (above) only catches the whole worktree matching another
    // byte-for-byte at the SAME paths; it cannot see the far more common case of one new file
    // renamed and reindented. See content-identity.mjs for what "identity" means here and why it
    // cannot be fooled by two unrelated files sharing a name or a shape.
    //
    // Keyed by path so a partial match (one of two committed files has a twin, the other does
    // not) is visible to the caller rather than forcing an all-or-nothing verdict. A file that
    // fails to read (race, permission, symlink loop) gets `null` — the safe direction, since it
    // can only make this file LESS likely to be matched, never falsely redundant.
    //
    // EVERY LAYER GOES THROUGH ONE READER, AND THAT READER NEVER FOLLOWS A SYMLINK. `result.touched`
    // is committed + uncommitted + untracked, so the single loop below is the whole content-identity
    // surface — there is no second, unfixed path for one of the layers. It used to be a bare
    // `fs.readFile`, which follows symlinks and hashes the RESOLVED TARGET: two worktrees each
    // committing an unrelated symlink to two DIFFERENT external files that happened to hold the same
    // bytes fingerprinted identically, `safeToDelete` called each redundantWith the other, and
    // `clean --apply` would have removed the only copy. `pathContentKey` (content-identity.mjs)
    // lstats first and keys a symlink by its TARGET STRING — which is exactly the blob git stores
    // for it — so identity is over what git tracks, not what the filesystem resolves.
    result.contentKeys = {};
    await pmap(result.touched, async (f) => {
      result.contentKeys[f] = await pathContentKey(path.join(ws.path, f));
    }, 6);
  } catch (err) {
    if (err instanceof GitRefused) throw err; // a refusal is a holt bug, never swallowed
    result.reason = `scan error: ${err.message}`;
  }

  return result;
}

/**
 * Scan every workstream.
 *
 * @param {object} disc  result of discover()
 * @param {object} opts  {base, strictReadOnly, concurrency, timeout, symbols, includePrimary}
 */
export async function scan(disc, opts = {}) {
  if (!disc.root) {
    throw new Error(disc.bare
      ? 'holt: this is a bare repository (no working tree) — holt compares file content across '
        + 'worktrees and needs at least one checkout; run it from a normal clone instead'
      : 'holt: not a git repository');
  }

  const base = await resolveBase(disc.root, opts.base);
  const ctx = {
    root: disc.root,
    base,
    strictReadOnly: !!opts.strictReadOnly,
    timeout: opts.timeout ?? 60_000,
  };

  // THE PRIMARY IS EXCLUDED ONLY WHEN THERE IS SOMETHING ELSE TO TALK ABOUT.
  //
  // Excluding it is right in a fan-out: the human's own worktree is not a dispatched agent, and
  // reporting on it would bury the signal about the agents. That rationale is void when there are
  // no agents — and a repository with one worktree is the commonest shape there is, the shape of
  // every first run, and the shape a user is in on the day they install holt.
  //
  // MEASURED on a real repository belonging to another team, at one moment, two commands apart:
  //
  //   holt risk                    scanned 0/0 workstreams · nothing at risk
  //   holt risk --include-primary  ● interactive-textbook  9 uniq  24 uncomm  unique-work-uncommitted
  //
  // The default answered a question about worktrees that did not exist while 24 uncommitted
  // changes and 9 symbols that live nowhere else sat in the one worktree that did. The caveat WAS
  // printed — in grey, in parentheses, below a headline that read as an all-clear — and the
  // engineer reading it still concluded holt reported no risk, which is the only test of a
  // caveat that matters. Hiding a repository's real risk behind a flag the user has to know to
  // pass is not a default; it is a trap with documentation.
  //
  // So: if the primary is the ONLY workstream, it IS the workstream. Nothing changes for a repo
  // with siblings, where the original reasoning still holds and the caveat still prints.
  const soloPrimary = disc.workstreams.length === 1 && disc.workstreams[0]?.isPrimary;
  const includePrimary = opts.includePrimary || soloPrimary;
  const targets = disc.workstreams.filter((w) => !w.isPrimary || includePrimary);

  // WHAT HOLT IS NOT AUDITING MUST STILL BE NAMED. The primary worktree is excluded from the
  // scan by default — it is where the human lives, not a dispatched agent — but excluded is not
  // the same as nonexistent. Adversarial review built the commonest first-run shape there is: one
  // repository, no fan-out yet, uncommitted-only work sitting in the primary — and holt answered
  // "Nothing unique anywhere. Every workstream is reproducible from base." That sentence is true
  // of the zero workstreams scanned and false of the repository. One porcelain status call
  // records whether the unscanned primary is dirty, so every surface can say what holt is NOT
  // vouching for instead of implying it checked.
  let primaryUnscanned = null;
  const primary = disc.workstreams.find((w) => w.isPrimary);
  if (primary && !includePrimary) {
    const st = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: primary.path })
      .catch(() => null);
    const entries = st && st.code === 0 ? st.stdout.split('\0').filter(Boolean).length : null;
    primaryUnscanned = {
      id: primary.id,
      path: primary.path,
      dirtyFiles: entries, // null = even the status read failed; never reported as "clean"
    };
  }

  // ---- Phase 1: file-level deltas -------------------------------------------------
  const scanned = await pmap(targets, (ws) => scanFiles(ws, ctx), opts.concurrency ?? 8);

  // ---- Phase 2: symbols -----------------------------------------------------------
  let backend = { kind: 'disabled', label: 'symbols disabled', degraded: false };
  if (opts.symbols !== false) {
    backend = await resolveBackend({ force: opts.symbolBackend });

    const union = [...new Set(scanned.flatMap((w) => (w.ok ? w.touched : [])))];
    const baseSyms = await symbolsAtBase(disc.root, base.oid, union, backend);

    await pmap(
      scanned.filter((w) => w.ok && w.touched.length),
      async (w) => {
        const headSyms = await symbolsOnDisk(w.path, w.touched, backend);
        w.added = diffSymbols(headSyms, baseSyms);
        w.addedKeys = [...new Set(w.added.map(symbolKey))];
        w.stats.addedSymbols = w.addedKeys.length;
        // AN EXTRACTION THAT FAILED IS NOT AN EMPTY ANSWER. Measured: a file with a real symbol
        // comes back with zero under a timeout, byte-identical to a file that has none — so under
        // load, "could not look" became a confident "shares nothing with anyone", and a worktree
        // holding unique work looked disposable. Recording WHICH files could not be read lets the
        // verdict say unmeasured instead of nothing; silence must never read as a negative result.
        w.symbolsUnmeasured = headSyms.failed ?? [];
      },
      Math.min(opts.concurrency ?? 8, 6),
    );
  }

  return {
    root: disc.root,
    vcs: disc.vcs,
    base,
    jj: disc.jj,
    backend,
    workstreams: scanned,
    skipped: scanned.filter((w) => !w.ok).map((w) => ({ id: w.id, reason: w.reason })),
    primaryUnscanned,
    // The reader is in a repository with no fan-out yet. The risk verdict is now EARNED here (the
    // one worktree IS scanned), but every CROSS-worktree finding — collisions, duplicates,
    // families, landing order — is necessarily empty for a reason that has nothing to do with the
    // repository's health, and a reader who has simply not run `git worktree add` yet cannot tell
    // those two empty states apart from the output alone.
    soloPrimary,
    strictReadOnly: ctx.strictReadOnly,
  };
}
