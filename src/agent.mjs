// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — agent integration CORE (agent-neutral).
 *
 * MCP gives an agent tools it must CHOOSE to call. That is not enough for this problem, because
 * the two failures holt exists to prevent both happen when nobody thought to ask:
 *
 *   - an agent deletes a worktree holding the only copy of some work;
 *   - an agent rebuilds something the worktree next door already built.
 *
 * So holt integrates on three levels, and only the third is agent-specific:
 *
 *   1. MCP server            — universal tool access (src/mcp/server.mjs)
 *   2. AGENTS.md             — universal awareness. The Linux Foundation AAIF standard read by
 *                              30+ agents (Codex, Cursor, Copilot, Gemini CLI, Aider, Zed,
 *                              Windsurf, Jules, Factory, Devin…). Any agent that reads the repo
 *                              learns holt exists and that it must check before deleting.
 *   3. Hooks                 — deterministic ENFORCEMENT, where the agent supports it. Every
 *                              agent's hook schema differs, so this file computes agent-neutral
 *                              VERDICTS and src/integrate/adapters/* translate them.
 *
 * Nothing below knows what Claude Code, OpenCode or Codex is. It answers two questions:
 *
 *   assessCommand()  — would running this command destroy work that exists nowhere else?
 *   buildBrief()     — what does an agent working here need to know about its siblings?
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { discover } from './discover.mjs';
import { scan, atRiskFiles, atRiskFromStatus } from './scan.mjs';
import { analyze, contextDigest } from './analyze.mjs';
import { scratchDir } from './symbols.mjs';
import { git } from './git.mjs';

/* ------------------------------------------------------------------ cache ---- */

/**
 * A pre-tool hook runs in the agent's critical path, so a cold 20 s scan on every call is not
 * acceptable. The cache is keyed on a FINGERPRINT of the thing being measured — the worktree
 * list plus every worktree's full status — so it invalidates the moment anything holt reports
 * on changes. A time-based TTL alone would be wrong: answering "safe to delete" from a stale
 * scan is exactly the failure this tool exists to prevent.
 */
async function fingerprint(root) {
  const wl = await git(['worktree', 'list', '--porcelain'], { cwd: root });
  const h = createHash('sha256').update(wl.stdout);

  const paths = wl.stdout.split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice(9));

  for (const p of paths) {
    const st = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: p })
      .catch(() => ({ code: 1, stdout: '' }));
    h.update(p).update(String(st.code)).update(st.stdout);
  }
  return h.digest('hex').slice(0, 32);
}

function cachePath(root) {
  const key = createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16);
  return path.join(scratchDir(), `holt-cache-${key}.json`);
}

export async function cachedReport(cwd, opts = {}) {
  const disc = await discover(cwd, opts);
  if (!disc.root) throw Object.assign(new Error(`not a git repository: ${cwd}`), { code: 'ENOTREPO' });

  const fp = await fingerprint(disc.root);
  const file = cachePath(disc.root);

  try {
    const cached = JSON.parse(await fs.readFile(file, 'utf8'));
    if (cached.fingerprint === fp && cached.version === 1) {
      return { report: cached.report, scanned: cached.scanned, fromCache: true };
    }
  } catch { /* no usable cache */ }

  const scanned = await scan(disc, opts);
  const report = await analyze(scanned, opts);
  await fs.writeFile(file, JSON.stringify({ version: 1, fingerprint: fp, report, scanned }), 'utf8')
    .catch(() => { /* an unwritable cache must never fail the scan */ });

  return { report, scanned, fromCache: false };
}

/* -------------------------------------------------- destructive-command match ---- */

/**
 * Commands that destroy a workstream.
 *
 * Matching is deliberately BROAD: a false positive costs an explained prompt, a false negative
 * costs destroyed work. `rm -rf <path>` is included because that is how worktrees actually get
 * deleted in practice, not just `git worktree remove`.
 */
/**
 * Global git options may take a VALUE (`git -C /repo …`, `git -c k=v …`, `--git-dir <p>`), so a
 * pattern that only skips flag tokens misses `git -C /repo worktree remove`. Found by test.
 */
const GIT_GLOBALS = '(?:-[cC]\\s+\\S+\\s+|--(?:git-dir|work-tree|namespace|exec-path)(?:=\\S+|\\s+\\S+)\\s+|-[a-zA-Z]+\\s+|--[a-z-]+\\s+)*';

// ORDER MATTERS: the first match wins, so the more specific patterns come first. The general
// `remove` pattern's `(?:--force|-f)*` also matches `-f -f`, which would mislabel the override.
const DESTRUCTIVE = [
  // DISARMING THE PROTECTION IS ITSELF A DESTRUCTIVE ACT.
  //
  // MEASURED: an agent hit `holt protect`, read the lock reason naming the exact symbol at
  // risk, ran `git worktree unlock`, and deleted the worktree anyway — justifying it from the
  // worktree's NAME ("DELETEME-old-experiment"), which is precisely the trap the scenario is
  // built from. A lock is one command away from being undone, so a gate that only watches
  // `remove` watches the wrong step.
  //
  // These are caught with the SAME evidence-bearing refusal as a delete, because by the time
  // someone is unlocking, the interesting question is already "do you know what is in there?".
  { re: new RegExp(`\\bgit\\s+${GIT_GLOBALS}worktree\\s+unlock\\s+(?<target>[^\\s;|&]+)`), kind: 'git worktree unlock (disarms protection)' },
  // `remove -f -f` is git's documented override for a locked worktree. Same treatment.
  { re: new RegExp(`\\bgit\\s+${GIT_GLOBALS}worktree\\s+remove\\s+(?:(?:--force|-f)\\s+){2,}(?<target>[^\\s;|&]+)`), kind: 'git worktree remove --force --force (overrides the lock)' },

  { re: new RegExp(`\\bgit\\s+${GIT_GLOBALS}worktree\\s+remove\\s+(?:(?:--force|-f)\\s+)*(?<target>[^\\s;|&]+)`), kind: 'git worktree remove' },
  { re: new RegExp(`\\bgit\\s+${GIT_GLOBALS}worktree\\s+prune\\b`), kind: 'git worktree prune', all: true },
  // MATCH ANY rm TARGET, then let resolution decide. This rule previously required the path to
  // contain 'worktree', '.worktrees' or 'wt' — so `rm -rf ../my-feature`, the most natural way to
  // delete a worktree, sailed straight through the one defence holt has against rm (git's lock
  // cannot stop a filesystem delete). Broadening is safe because the target is resolved against
  // the actual worktree list below: a path that is not a worktree finds nothing and is allowed,
  // so `rm -rf node_modules` and `rm -rf dist` are unaffected.
  { re: /\brm\s+(?:-[a-zA-Z]+\s+)*(?<target>[^\s;|&]+)/, kind: 'rm of a worktree path' },

  // ---- CONTENT-MUTATING VERBS ------------------------------------------------------------
  // A lock stops `git worktree remove`. It does NOT stop the commands that destroy the SAME
  // uncommitted work in place — and those are the ones that actually cost this project work
  // during its own development. Deleting a worktree and hard-resetting it are the same loss,
  // so covering only the deletion verb was a coverage gap, not a scope boundary.
  //
  // These carry no path argument: they act on the worktree they RUN IN, or wherever `git -C`
  // points. Resolution still decides — a clean worktree has nothing to lose, so the verdict is
  // allow and a developer never notices the rule exists.
  { re: new RegExp(`\\bgit\\s+${GIT_GLOBALS}reset\\s+(?:[^\\s;|&]+\\s+)*--hard\\b`), kind: 'git reset --hard (discards uncommitted work)', cwdTarget: true },
  { re: new RegExp(`\\bgit\\s+${GIT_GLOBALS}clean\\s+-[a-zA-Z]*[fd][a-zA-Z]*\\b`), kind: 'git clean -fd (deletes untracked files)', cwdTarget: true },
  // A TREEISH IS ALLOWED TO SIT BETWEEN THE VERB AND THE PATHSPEC, and the old pattern demanded
  // they be adjacent — so `git checkout other -- .`, `git checkout HEAD -- .` and
  // `git checkout main -- src/` all walked straight through a guard that caught `git checkout -- .`.
  // That is not a hypothetical spelling: it is the command reported in claude-code#55024 as having
  // overwritten fourteen unstaged files.
  //
  // Two shapes, and the discrimination matters as much as the catch: `--` FOLLOWED BY WHITESPACE is
  // git's unambiguous pathspec separator, and a trailing bare `.` is the whole working tree. Neither
  // matches `git checkout -b feature`, `git checkout main`, or `git restore --source=x` (where the
  // dashes belong to a long option, not a separator) — branch work stays untouched.
  { re: new RegExp(`\\bgit\\s+${GIT_GLOBALS}(?:checkout|restore)\\s+(?:[^\\s;|&]+\\s+)*--\\s`), kind: 'git checkout/restore of a pathspec (overwrites uncommitted changes)', cwdTarget: true },
  { re: new RegExp(`\\bgit\\s+${GIT_GLOBALS}(?:checkout|restore)\\s+(?:[^\\s;|&]+\\s+)*\\.\\s*$`), kind: 'git checkout/restore . (overwrites the whole working tree)', cwdTarget: true },
  // `--staged` ALONE only unstages: the content stays in the working tree and nothing is lost, so
  // denying it was a false positive on an operation people run all day. `--worktree` (with or
  // without --staged) is the one that overwrites files, and a bare pathspec defaults to it.
  { re: new RegExp(`\\bgit\\s+${GIT_GLOBALS}restore\\s+(?:[^\\s;|&]+\\s+)*--worktree\\b`), kind: 'git restore --worktree (discards changes)', cwdTarget: true },
];

export function classifyCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  for (const { re, kind, all, cwdTarget } of DESTRUCTIVE) {
    const m = command.match(re);
    if (m) {
      return {
        kind,
        target: m.groups?.target ? m.groups.target.replace(/^['"]|['"]$/g, '') : null,
        all: !!all,
        cwdTarget: !!cwdTarget,
      };
    }
  }
  return null;
}


/** `git -C <path> …` redirects which worktree a path-less verb acts on. */
function gitCFlag(command) {
  const m = /\bgit\s+(?:[^\s]+\s+)*?-C\s+([^\s;|&]+)/.exec(command);
  return m ? m[1].replace(/^['"]|['"]$/g, '') : null;
}

/** The worktree CONTAINING this directory — for verbs that act on wherever they are run. */
async function containingWorkstream(report, cwd) {
  const abs = await canonicalPath(cwd || process.cwd());
  let best = null;
  let bestLen = -1;
  for (const s of report.safe) {
    if (!s.path) continue;
    const p = await canonicalPath(s.path);
    if (underOrEqual(abs, p) && p.length > bestLen) { best = s; bestLen = p.length; } // deepest wins
  }
  return best;
}

async function findWorkstream(report, target, cwd) {
  if (!target) return null;
  const abs = await canonicalPath(path.resolve(cwd || process.cwd(), target));
  let byPath = null;
  for (const s of report.safe) {
    if (s.path && samePath(await canonicalPath(s.path), abs)) { byPath = s; break; }
  }
  if (byPath) return byPath;
  const base = path.basename(abs);
  return report.safe.find((s) => s.id === base || s.id.endsWith(`/${base}`)) ?? null;
}



/**
 * Path comparison that survives macOS and Windows.
 *
 * MEASURED FAILURE, on two of three platforms: `rm -rf <a worktree holding the only copy of
 * something>` was ALLOWED on macOS and Windows while correctly denied on Linux. The guard
 * compared `path.resolve()` output, and path.resolve does NOT resolve symlinks — on macOS
 * os.tmpdir() is /var/folders/... while git reports the real /private/var/folders/..., so the
 * target never matched any worktree and the destructive command sailed through. Windows adds
 * case-insensitivity and 8.3 short names to the same problem.
 *
 * So comparison is canonical (symlinks resolved) and case-folded where the filesystem is
 * case-insensitive. realpath fails on a path that does not exist yet — that is fine and
 * deliberate: fall back to resolve, because a target that does not exist cannot be a worktree.
 */
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

async function canonicalPath(p) {
  const abs = path.resolve(p);
  try { return await fs.realpath(abs); } catch { return abs; }
}

const foldCase = (p) => (CASE_INSENSITIVE_FS ? p.toLowerCase() : p);

/** a and b are the same directory. */
const samePath = (a, b) => foldCase(a) === foldCase(b);

/** `child` is `parent` or lives underneath it. */
const underOrEqual = (child, parent) => {
  const c = foldCase(child);
  const q = foldCase(parent);
  return c === q || c.startsWith(q.endsWith(path.sep) ? q : q + path.sep);
};

/**
 * Per-assessCommand scratch. `git worktree list` and one `git status` per worktree are asked for
 * by both the worktree layer and the file layer below; a hook in the agent's critical path must
 * not pay for either twice.
 */
function newProbeCtx(cwd) {
  const roots = new Map();  // 'roots' -> Promise<string[]|null>
  const dirty = new Map();  // rootPath -> Promise<Map|null>
  return {
    cwd,
    worktreeRoots() {
      if (!roots.has('roots')) {
        roots.set('roots', (async () => {
          const r = await git(['worktree', 'list', '--porcelain'], { cwd }).catch(() => null);
          if (!r || r.code !== 0) return null; // cannot tell — the caller must not read this as "none"
          const out = [];
          for (const line of r.stdout.split('\n')) {
            if (!line.startsWith('worktree ')) continue;
            out.push(await canonicalPath(line.slice('worktree '.length).trim()));
          }
          return out;
        })());
      }
      return roots.get('roots');
    },
    /** @returns {Promise<Map<string,string>|null>} at-risk path -> layer, or null if unmeasurable */
    dirtyFiles(root) {
      if (!dirty.has(root)) {
        dirty.set(root, (async () => {
          const r = await git(
            ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'],
            { cwd: root },
          ).catch(() => null);
          if (!r || r.code !== 0) return null;
          return atRiskFromStatus(r.stdout);
        })());
      }
      return dirty.get(root);
    },
  };
}

/**
 * Is this rm target actually a registered worktree? One `git worktree list` call, so the broad
 * rm rule costs nothing on the overwhelmingly common case of deleting build output.
 */
async function targetIsWorktree(target, cwd, ctx) {
  const abs = await canonicalPath(path.resolve(cwd || process.cwd(), target));
  const roots = await ctx.worktreeRoots();
  if (roots === null) return true; // cannot tell -> fall through to the full check, never skip silently
  for (const wt of roots) {
    // Dangerous iff the target IS a worktree root, or CONTAINS one (deleting a parent directory
    // takes the worktrees under it with it). Deleting something INSIDE a worktree — the common
    // `rm -rf node_modules` — is ordinary file work and must stay allowed; treating it as
    // destruction would flag every delete in the repo, since the repo root is itself a worktree.
    if (samePath(wt, abs) || underOrEqual(wt, abs)) return true;
  }
  return false;
}

/* ------------------------------------------------ file-granular destruction ---- */

/**
 * Everything above reasons about WORKTREES. The loss that actually happens is one file at a time.
 *
 * MEASURED, on holt's own standard fixture: `rm <file>`, `git rm -f <file>`, `truncate -s0 <file>`,
 * `shred <file>`, `mv <file> /tmp/x` and shell `> <file>` were ALL allowed against the exact file
 * holt itself reported as existing nowhere else — 9 spellings, 9 allows. The worktree rules could
 * not see them because nothing resolved a command to the PATHS it destroys; the broad `rm` rule
 * even short-circuits to ALLOW the moment the target turns out not to be a worktree root.
 *
 * The rule is the one the worktree layer already uses, applied one level down:
 *
 *     resolve the verb to its target paths -> intersect with the at-risk file set -> deny.
 *
 * NEVER-WORSE IS THE DESIGN CONSTRAINT, NOT A CAVEAT. A guard that denies `rm -rf node_modules`,
 * `rm build/out.js` or `> app.log` is uninstalled the same day, so nothing here decides safety by
 * inspecting a name. The intersection is with scan.mjs's `atRiskFiles()` — status(uncommitted +
 * untracked + gitignored) MINUS looksGenerated() — and that set already excludes node_modules/,
 * dist/, build/, target/, coverage/, .cache/, tmp/, logs/, *.log, lockfiles and OS droppings.
 * COMMITTED files are excluded by construction too: git still holds the content, so `rm` of one
 * is recoverable and stays allowed. An ordinary delete finds an empty intersection and the
 * developer never learns the rule exists.
 */

/**
 * Verbs that destroy a file's content at a path, and what each does to it.
 *
 * This is a TABLE, not a list of special cases, because the routes into the same loss are not
 * closed by naming six of them: `> f`, `truncate -s0 f`, `cp /dev/null f`, `tee f < /dev/null`
 * and `dd if=/dev/null of=f` are one act with five spellings, and a guard that stops the first
 * two teaches an agent to reach for the third. `role` is the whole semantics — adding a verb is
 * one row, and every row inherits the same resolution and the same intersection.
 *
 *   delete     the path stops existing
 *   truncate   the path survives, its content does not
 *   move       the source leaves this worktree; the destination is clobbered
 *   overwrite  the destination FILE is replaced (never a directory: cp/mv write INTO those)
 */
const FILE_VERBS = {
  rm: { role: 'delete', valueOpts: new Set() },
  unlink: { role: 'delete', valueOpts: new Set() },
  shred: { role: 'delete', valueOpts: new Set(['-n', '-s', '--iterations', '--size', '--random-source']) },
  truncate: { role: 'truncate', valueOpts: new Set(['-s', '-r', '--size', '--reference']) },
  mv: { role: 'move', valueOpts: new Set(['-t', '-S', '--target-directory', '--suffix']) },
  // `cp a b` and `install a b` read the source and replace the destination.
  cp: { role: 'dest-only', valueOpts: new Set(['-t', '-S', '--target-directory', '--suffix']) },
  install: { role: 'dest-only', valueOpts: new Set(['-t', '-m', '-o', '-g', '--mode', '--owner', '--group']) },
  // `tee f` truncates f; `tee -a f` does not.
  tee: { role: 'truncate', valueOpts: new Set(), skipIf: ['-a', '--append'] },
  dd: { role: 'dd', valueOpts: new Set() },
};

/** Transparent prefixes: they change how a command runs, never what it destroys. */
const WRAPPERS = new Set(['sudo', 'command', 'nohup', 'time', 'env', 'exec', 'nice', 'ionice', 'doas']);

/**
 * A shell-aware-enough tokenizer.
 *
 * It is NOT a shell, and does not need to be. It has to be right about exactly three things:
 * QUOTING (so `echo "a > b"` and `awk '{if ($1 > 2) …}'` are not redirects), SEGMENT SEPARATORS
 * (so `cd x && rm y` still resolves y), and TRUNCATING vs APPENDING redirects (`>` destroys,
 * `>>` and `2>&1` do not). Anything else it mis-parses yields a token that is not a path, and a
 * token that is not a path can never intersect the at-risk set — the intersection, not the
 * parser, is what keeps this quiet.
 *
 * @returns {Array<{words:string[], truncated:string[]}>}
 */
export function lexSegments(command) {
  const segments = [];
  let words = [];
  let truncated = [];
  let buf = '';
  let has = false;
  let pending = null; // 'trunc' | 'append' | 'input' — where the NEXT word goes

  const flushWord = () => {
    if (!has) return;
    if (pending === 'trunc') truncated.push(buf);
    else if (pending === null) words.push(buf);
    // 'append' and 'input' targets are read or extended, never destroyed: drop them.
    pending = null;
    buf = '';
    has = false;
  };
  const flushSeg = () => {
    flushWord();
    if (words.length || truncated.length) segments.push({ words, truncated });
    words = [];
    truncated = [];
  };

  for (let i = 0; i < command.length; i++) {
    let ch = command[i];

    if (ch === '\\') { buf += command[i + 1] ?? ''; has = true; i++; continue; }
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      buf += end === -1 ? command.slice(i + 1) : command.slice(i + 1, end);
      has = true;
      if (end === -1) break;
      i = end;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < command.length && command[j] !== '"') {
        if (command[j] === '\\') { buf += command[j + 1] ?? ''; j += 2; } else { buf += command[j]; j++; }
      }
      has = true;
      i = j;
      continue;
    }

    if (ch === '&' && command[i + 1] === '&') { flushSeg(); i++; continue; }
    if (ch === '&' && command[i + 1] === '>') { i++; ch = '>'; }  // `&>file` / `&>>file`

    if (ch === '>') {
      if (command[i + 1] === '(') { buf += ch; has = true; continue; } // process substitution
      // A bare fd number written against the operator belongs to the operator, not to argv.
      if (has && /^\d+$/.test(buf) && pending === null) { buf = ''; has = false; }
      flushWord();
      let mode = 'trunc';
      if (command[i + 1] === '>') { mode = 'append'; i++; } else if (command[i + 1] === '|') { i++; }
      // `>&2`, `2>&1`, `>&-` duplicate a descriptor. No file is involved.
      let j = i + 1;
      while (j < command.length && (command[j] === ' ' || command[j] === '\t')) j++;
      if (command[j] === '&') {
        i = j;
        while (i + 1 < command.length && !/[\s;|&]/.test(command[i + 1])) i++;
        continue;
      }
      pending = mode;
      continue;
    }

    if (ch === '<') {
      if (has && /^\d+$/.test(buf) && pending === null) { buf = ''; has = false; }
      flushWord();
      if (command[i + 1] === '<') i++;   // heredoc / herestring
      if (command[i + 1] === '(') continue; // process substitution
      pending = 'input';
      continue;
    }

    if (ch === '|') { flushSeg(); if (command[i + 1] === '|') i++; continue; }
    if (ch === ';' || ch === '\n' || ch === '&') { flushSeg(); continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r') { flushWord(); continue; }

    buf += ch;
    has = true;
  }
  flushSeg();
  return segments;
}

/** Positional operands of a verb: flags dropped, `--` honoured, value-taking options skipped. */
function operandsOf(tokens, valueOpts) {
  const out = [];
  let after = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!after && t === '--') { after = true; continue; }
    if (!after && t.length > 1 && t.startsWith('-')) {
      if (valueOpts.has(t)) i++;  // `-s 0`, `-t DIR` — the value is not a target
      continue;
    }
    out.push(t);
  }
  return out;
}

function optionValue(tokens, ...names) {
  for (let i = 0; i < tokens.length; i++) {
    for (const n of names) {
      if (tokens[i] === n) return tokens[i + 1] ?? null;
      if (tokens[i].startsWith(`${n}=`)) return tokens[i].slice(n.length + 1);
    }
  }
  return null;
}

/**
 * Every path a command would destroy, with what it would do to it.
 *
 * `role`:  delete | truncate | move-src (leaves its worktree) | overwrite (destination clobbered)
 * `baseDir`: relative paths resolve against it — `git -C <dir> rm x` targets <dir>/x, not ./x.
 */
export function resolveFileTargets(command) {
  if (typeof command !== 'string' || !command.trim()) return [];
  const out = [];

  // `cd elsewhere && rm notes.md` deletes elsewhere/notes.md, NOT the notes.md holt is guarding.
  // Ignoring the cd was a false positive on one of the most common agent idioms there is, so the
  // base directory is carried across segments. Where it cannot be resolved — `cd -`, `cd $DIR` —
  // the base is left as it was rather than guessed, which errs toward asking about the file holt
  // can actually see.
  const combine = (curr, next) => (path.isAbsolute(next) ? next : (curr ? path.join(curr, next) : next));
  let baseDir = null;

  for (const seg of lexSegments(command)) {
    for (const t of seg.truncated) {
      // `> file` empties it. `>> file` does not, and never reaches here.
      out.push({ raw: t, role: 'truncate', kind: 'shell > redirection (truncates the file)', baseDir });
    }

    let w = seg.words;
    let cut = 0;
    while (cut < w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[cut]) || WRAPPERS.has(w[cut]))) cut++;
    w = w.slice(cut);
    if (!w.length) continue;

    if (w[0] === 'cd' || w[0] === 'pushd') {
      const to = operandsOf(w.slice(1), new Set())[0];
      if (!to) baseDir = os.homedir();
      else if (to !== '-' && !/[$`]/.test(to)) baseDir = combine(baseDir, to);
      continue;
    }

    if (w[0] === 'git') {
      // Global options may take a value, and `-C` moves the base directory for every path below.
      let i = 1;
      let gitBase = baseDir;
      while (i < w.length && w[i].startsWith('-')) {
        if (w[i] === '-C') { gitBase = w[i + 1] ? combine(baseDir, w[i + 1]) : gitBase; i += 2; continue; }
        if (w[i] === '-c') { i += 2; continue; }
        if (/^--(git-dir|work-tree|namespace|exec-path)$/.test(w[i])) { i += 2; continue; }
        i++;
      }
      if (w[i] !== 'rm') continue;
      const rest = w.slice(i + 1);
      // `--cached` unstages and LEAVES THE FILE ON DISK; `-n/--dry-run` does nothing at all.
      if (rest.some((t) => t === '--cached' || t === '-n' || t === '--dry-run')) continue;
      for (const p of operandsOf(rest, new Set(['--pathspec-from-file']))) {
        out.push({ raw: p, role: 'delete', kind: 'git rm (removes the working-tree file)', baseDir: gitBase });
      }
      continue;
    }

    const spec = FILE_VERBS[w[0]];
    if (!spec) continue;
    const rest = w.slice(1);
    if (spec.skipIf?.some((f) => rest.includes(f))) continue;   // `tee -a` appends
    const ops = operandsOf(rest, spec.valueOpts);

    if (spec.role === 'move' || spec.role === 'dest-only') {
      const dir = optionValue(rest, '-t', '--target-directory');
      const dest = dir ?? (ops.length >= 2 ? ops[ops.length - 1] : null);
      if (!dest) continue;
      if (spec.role === 'move') {
        // Only the SOURCES of a move lose their location. A copy leaves them where they are.
        for (const p of dir ? ops : ops.slice(0, -1)) {
          out.push({ raw: p, role: 'move-src', dest, kind: 'mv (moves the file out of its worktree)', baseDir });
        }
      }
      // `mv a b` and `cp a b` both replace b — but writing INTO a directory is not replacing it,
      // which is why 'overwrite' matches a file exactly and never an enclosing path.
      out.push({ raw: dest, role: 'overwrite', kind: `${w[0]} (overwrites the destination)`, baseDir });
      continue;
    }

    if (spec.role === 'dd') {
      const of = optionValue(rest, 'of') ?? rest.find((t) => t.startsWith('of='))?.slice(3);
      if (of) out.push({ raw: of, role: 'truncate', kind: 'dd of= (rewrites the file)', baseDir });
      continue;
    }

    for (const p of ops) {
      out.push({
        raw: p,
        role: spec.role,
        kind: spec.role === 'truncate' ? `${w[0]} (empties the file)` : `${w[0]} (deletes the file)`,
        baseDir,
      });
    }
  }
  return out;
}

const GLOBBY = /[*?[\]]/;

/**
 * A path or glob as written, compiled to a matcher over worktree-relative paths.
 * `*` does not cross a separator, `**` does — the shell's own rule.
 */
function pathMatcher(rel) {
  if (!GLOBBY.test(rel)) {
    const lit = rel.replace(/\/+$/, '');
    return { literal: lit, re: new RegExp(`^${lit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) };
  }
  let src = '';
  for (let i = 0; i < rel.length; i++) {
    const c = rel[i];
    if (c === '*') {
      if (rel[i + 1] === '*') { src += '.*'; i++; } else src += '[^/]*';
    } else if (c === '?') src += '[^/]';
    else if (c === '[') {
      const end = rel.indexOf(']', i + 1);
      if (end === -1) { src += '\\['; } else { src += rel.slice(i, end + 1); i = end; }
    } else src += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return { literal: null, re: new RegExp(`^${src}$`) };
}

/**
 * Does this target destroy `dirty`?
 *
 * Three shapes, all of them real:
 *   - the target IS the file;
 *   - the target is a DIRECTORY the file lives under (`rm -rf notes` takes notes/todo.md);
 *   - `dirty` is a collapsed ignored DIRECTORY (git reports `secrets/`, never its contents) and
 *     the target names something inside it — the same collapse that once let `clean --apply`
 *     delete the only copy of secrets/prod.env.
 */
function destroys(item, dirty) {
  const { matcher, role } = item;
  // A destination is REPLACED only when it is a file. `cp x logs` and `mv x logs` write into the
  // directory `logs`, they do not delete it — so 'overwrite' never matches an enclosing path.
  if (role === 'overwrite') return !dirty.endsWith('/') && matcher.re.test(dirty);

  const d = dirty.endsWith('/') ? dirty.slice(0, -1) : dirty;
  const parts = d.split('/');
  for (let i = parts.length; i > 0; i--) {
    if (matcher.re.test(parts.slice(0, i).join('/'))) return true;
  }
  if (dirty.endsWith('/') && matcher.literal !== null && `${matcher.literal}/`.startsWith(dirty)) return true;
  return false;
}

function deepestRoot(roots, abs) {
  let best = null;
  for (const r of roots) if (underOrEqual(abs, r) && (!best || r.length > best.length)) best = r;
  return best;
}

/** The glob-free directory prefix of a pattern — where ownership of a glob target is decided. */
function globFreePrefix(p) {
  if (!GLOBBY.test(p)) return p;
  const parts = p.split('/');
  const keep = [];
  for (const seg of parts) { if (GLOBBY.test(seg)) break; keep.push(seg); }
  return keep.join('/') || '.';
}

/**
 * Would this command destroy the only copy of a file?
 *
 * @returns {Promise<object|null>} a verdict, or null when there is nothing to say
 */
async function assessFileTargets(targets, cwd, ctx) {
  const roots = await ctx.worktreeRoots();
  if (roots === null) {
    return {
      decision: 'ask',
      kind: targets[0].kind,
      targets: [],
      files: [],
      reason: 'holt could not list this repository\'s worktrees, so it cannot tell whether this '
        + 'command destroys the only copy of a file. Confirm manually before proceeding.',
    };
  }
  if (!roots.length) return null;

  // Resolve each target to the worktree that owns it. Anything outside every worktree — /tmp,
  // a sibling project, $HOME — is not holt's to defend and is dropped here, which is also what
  // keeps `rm -rf /tmp/scratch` off the expensive path entirely.
  const items = [];
  for (const t of targets) {
    const base = t.baseDir ? path.resolve(cwd, t.baseDir) : cwd;
    const abs = await canonicalPath(path.resolve(base, globFreePrefix(t.raw)));
    const root = deepestRoot(roots, abs);
    if (!root) continue;

    if (t.role === 'move-src') {
      // A move INSIDE the same worktree is a rename: the content does not go anywhere, and
      // denying it would break ordinary refactoring. Only a move OUT of the worktree loses it.
      const destAbs = await canonicalPath(path.resolve(base, globFreePrefix(t.dest)));
      const destRoot = deepestRoot(roots, destAbs);
      if (destRoot && samePath(destRoot, root)) continue;
    }

    const relPrefix = path.relative(root, abs).split(path.sep).join('/');
    const suffix = GLOBBY.test(t.raw) ? t.raw.slice(globFreePrefix(t.raw).length).replace(/^\/+/, '') : '';
    const rel = suffix ? `${relPrefix ? `${relPrefix}/` : ''}${suffix}` : relPrefix;
    items.push({ ...t, root, rel, matcher: pathMatcher(rel || '**') });
  }
  if (!items.length) return null;

  // ---- the cheap gate ------------------------------------------------------------------
  // One `git status` per involved worktree decides whether the full analysis is worth paying
  // for. The overwhelmingly common case — every target is build output, or committed, or does
  // not exist — stops here, having cost two git reads and no scan.
  const hits = [];
  let unmeasurable = false;
  for (const it of items) {
    const dirty = await ctx.dirtyFiles(it.root);
    if (dirty === null) { unmeasurable = true; continue; }
    for (const [file, layer] of dirty) {
      if (destroys(it, file)) hits.push({ ...it, file, layer });
    }
  }

  if (!hits.length) {
    if (!unmeasurable) return null;
    return {
      decision: 'ask',
      kind: items[0].kind,
      targets: [],
      files: [],
      reason: 'holt could not read the working-tree state, so it cannot tell whether this command '
        + 'destroys the only copy of a file. Confirm manually before proceeding.',
    };
  }

  // ---- the authority -------------------------------------------------------------------
  // Now that a refusal is on the table, take holt's own computed at-risk set and say WHICH
  // workstream and WHAT is in the file. The scan can only ever be a subset of the probe (an
  // unscannable workstream contributes nothing, and `ignored.files` is capped at 50), so the
  // probe's hits stand on their own: a scan that cannot see the file is a reason to refuse,
  // never a reason to allow.
  let report = null;
  let scanned = null;
  try {
    ({ report, scanned } = await cachedReport(cwd, { includePrimary: true }));
  } catch { /* keep the direct file evidence; absence of the scan never downgrades a refusal */ }

  const wsFor = (root) => scanned?.workstreams.find((w) => w.path && foldCase(path.resolve(w.path)) === foldCase(root))
    ?? scanned?.workstreams.find((w) => w.path && samePath(path.resolve(w.path), root))
    ?? null;

  const byWs = new Map();
  for (const h of hits) {
    const ws = wsFor(h.root);
    const id = ws?.id ?? path.basename(h.root);
    if (!byWs.has(id)) byWs.set(id, { id, ws, files: new Map() });
    byWs.get(id).files.set(h.file, h.layer);
  }

  const lines = [];
  for (const { id, ws, files } of byWs.values()) {
    const computed = new Set(atRiskFiles(ws));
    const shown = [...files.keys()].sort().slice(0, 5);
    const u = report?.unique.find((x) => x.id === id);
    const sample = u
      ? [...u.byLayer.uncommitted, ...u.byLayer.untracked]
        .filter((s) => files.has(s.file)).slice(0, 3).map((s) => s.key).join(', ')
      : '';
    for (const f of shown) {
      const seen = computed.has(f) ? '' : ' [seen by the guard, not by the last scan]';
      lines.push(`  • ${id}: ${f} (${files.get(f)})${seen}`);
    }
    if (files.size > shown.length) lines.push(`    … and ${files.size - shown.length} more in ${id}`);
    if (sample) lines.push(`      e.g. ${sample}`);
  }

  const total = [...byWs.values()].reduce((n, x) => n + x.files.size, 0);
  return {
    decision: 'deny',
    kind: hits[0].kind,
    targets: [...byWs.keys()],
    files: hits.map((h) => h.file),
    reason:
      `holt blocked this: ${hits[0].kind} would destroy ${total} file(s) whose only copy is on disk.\n`
      + `${lines.join('\n')}\n`
      + 'No commit, index entry or stash holds this content — git cannot bring it back.\n'
      + 'Run `holt risk` to inspect, `holt rescue <id>` to capture it first, or commit it. '
      + 'If it is genuinely disposable, discard it explicitly rather than through this command.',
  };
}

/* --------------------------------------------------------- neutral verdicts ---- */

/**
 * Would this command destroy work that exists nowhere else?
 *
 * @returns {{decision:'allow'|'deny'|'ask', reason:string|null, kind:string|null, targets:Array}}
 *
 * Agent-neutral by design. Adapters map:  allow/deny/ask -> whatever their host calls it.
 */
export async function assessCommand(command, cwd = process.cwd()) {
  const ctx = newProbeCtx(cwd);

  // TWO GRANULARITIES, BOTH ANSWERED. The worktree layer catches deleting or resetting a whole
  // workstream; the file layer catches the same loss one file at a time. Neither subsumes the
  // other — `rm -rf ../feature` is invisible to the file layer's per-path evidence, and
  // `rm feature/notes.md` is invisible to a rule that only recognises worktree roots — so a
  // command is assessed by both and the STRONGEST verdict wins. Never the first one to answer:
  // the worktree layer returning 'allow' for a path that is not a worktree is exactly how
  // file-granular destruction went unwatched.
  const wtVerdict = await assessWorktreeCommand(command, cwd, ctx);
  if (wtVerdict?.decision === 'deny') return wtVerdict;

  const fileTargets = resolveFileTargets(command);
  const fileVerdict = fileTargets.length ? await assessFileTargets(fileTargets, cwd, ctx) : null;
  if (fileVerdict?.decision === 'deny') return fileVerdict;
  if (wtVerdict?.decision === 'ask') return wtVerdict;
  if (fileVerdict?.decision === 'ask') return fileVerdict;

  return wtVerdict ?? fileVerdict ?? { decision: 'allow', reason: null, kind: null, targets: [] };
}

/** The worktree-granularity half: unchanged behaviour, returns null when no rule matches. */
async function assessWorktreeCommand(command, cwd, ctx) {
  const hit = classifyCommand(command);
  if (!hit) return null;

  // CHEAP PRE-CHECK before the expensive scan. The rm rule matches any target so that
  // `rm -rf ../my-feature` is caught, but that would otherwise make every `rm -rf node_modules`
  // in an agent session pay for a full repository scan. `git worktree list` is one fast call:
  // if the target is not a worktree at all, there is nothing THIS layer can protect and it
  // stands aside — the file layer above still resolves the same path.
  if (hit.kind === 'rm of a worktree path' && hit.target) {
    const isWt = await targetIsWorktree(hit.target, cwd, ctx);
    if (!isWt) return null;
  }

  let report;
  try {
    // includePrimary: git REFUSES to lock the main worktree, so for it the hook is the only
    // protection there is — and it was excluded from the scan entirely. The one tree that can
    // never be locked was also the one never watched.
    ({ report } = await cachedReport(cwd, { includePrimary: true }));
  } catch (err) {
    // holt could not measure. It must NOT silently allow a destructive command it failed to
    // check — but it must not hard-block work on its own bug either, so it asks.
    return {
      decision: 'ask',
      kind: hit.kind,
      targets: [],
      reason: `holt could not verify what this would destroy (${err.message}). Confirm manually before proceeding.`,
    };
  }

  // `worktree prune` affects every prunable worktree at once, so evaluate all of them.
  const targets = hit.all
    ? report.safe.filter((s) => !s.safe)
    : hit.cwdTarget
      ? [(await findWorkstream(report, gitCFlag(command) ?? cwd, cwd)) ?? (await containingWorkstream(report, cwd))].filter(Boolean)
      : [await findWorkstream(report, hit.target, cwd)].filter(Boolean);

  const holding = targets.filter((s) => !s.safe);
  if (holding.length === 0) {
    return { decision: 'allow', reason: null, kind: hit.kind, targets: targets.map((t) => t.id) };
  }

  const unknown = holding.filter((s) => s.confidence === 'unknown');
  const detail = holding.slice(0, 3).map((s) => {
    const u = report.unique.find((x) => x.id === s.id);
    const sample = u
      ? [...u.byLayer.uncommitted, ...u.byLayer.untracked, ...u.byLayer.committed]
        .slice(0, 3).map((x) => x.key).join(', ')
      : '';
    return `  • ${s.id}: ${s.reasons.join('; ')}${sample ? `\n      e.g. ${sample}` : ''}`;
  }).join('\n');

  return {
    decision: 'deny',
    kind: hit.kind,
    targets: holding.map((h) => h.id),
    reason:
      `holt blocked this: ${hit.kind} would destroy work that exists nowhere else.\n${detail}\n` +
      (unknown.length
        ? `  ${unknown.length} of these could not be scanned, so holt cannot confirm they are safe.\n`
        : '') +
      'Run `holt risk` to inspect, or `holt gate <id>` for one workstream. ' +
      'If the work is genuinely disposable, commit or discard it explicitly first.',
  };
}

/**
 * What does an agent working here need to know about its siblings?
 * @returns {Promise<string|null>} plain text, or null when there is nothing worth saying
 */
export async function buildBrief(cwd = process.cwd()) {
  let report;
  let scanned;
  try {
    ({ report, scanned } = await cachedReport(cwd));
  } catch {
    return null; // no repo, or unscannable: contribute nothing rather than noise
  }

  const here = report.graph.nodes.find(
    (n) => n.path && path.resolve(cwd).startsWith(path.resolve(n.path)),
  );

  const lines = [];
  if (here) {
    const d = contextDigest(scanned, here.id);
    if (d.ok) {
      lines.push(`You are working in workstream '${d.workstream}' (family ${d.family}).`);
      if (d.siblings.length) lines.push(`Siblings from the same dispatch: ${d.siblings.join(', ')}.`);
      for (const a of d.advice) lines.push(`- ${a}`);
      if (d.duplicatedSymbols.length) {
        lines.push('Symbols you added that ALSO exist elsewhere (check before building further):');
        for (const x of d.duplicatedSymbols.slice(0, 5)) {
          lines.push(`  - ${x.workstream}: ${x.symbols.slice(0, 4).join(', ')}`);
        }
      }
    }
  }

  const risky = report.unique.filter((u) => u.uncommittedOnlyCount > 0);
  if (risky.length) {
    lines.push(
      `${risky.length} workstream(s) hold work existing ONLY as uncommitted changes — ` +
      `deleting them loses it: ${risky.slice(0, 5).map((r) => r.id).join(', ')}.`,
    );
  }
  if (report.counts.collisions > 0) {
    const top = report.collisions[0];
    lines.push(
      `${report.counts.collisions} workstream collision(s); highest: ${top.a} <-> ${top.b} (${top.why}).`,
    );
  }

  if (lines.length === 0) return null;

  return `[holt — parallel workstream state]\n${lines.join('\n')}\n` +
    '(Before deleting ANY worktree run: holt gate <id> — exit 0 disposable, 1 holds unique work, 2 unknown.)';
}
