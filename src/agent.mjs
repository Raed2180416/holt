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
import {
  underOrEqualAsync, canonicalPath, foldCase, CASE_INSENSITIVE_FS,
  samePathSync, underOrEqualSync, relativeWithinAsync, findByPath,
} from './paths.mjs';
import { discover, repoAbsenceError, parseWorktreePorcelain } from './discover.mjs';
import { scan, atRiskFiles, atRiskFromStatus, generatedEvidence } from './scan.mjs';
import { analyze, contextDigest } from './analyze.mjs';
import { scratchDir } from './symbols.mjs';
import { git } from './git.mjs';
import { stashState, describeStash, MAX_ENTRIES } from './stash.mjs';

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

  // THE STASH MOVES WITHOUT ANY WORKING TREE MOVING, and the report now reports on it.
  //
  // Every input above is a WORKTREE fact, which was exactly right while the report only described
  // worktrees. `git stash drop` changes no worktree's status and no worktree's presence — so with
  // the stash section keyed on those inputs alone, the fingerprint would be unchanged, the cached
  // report would be served, and holt would go on naming an entry that no longer exists. A warning
  // about work that was already made safe is not a harmless extra: it is the false alarm that
  // teaches a reader to ignore the true one.
  //
  // THE WHOLE REFLOG, NOT `refs/stash` — the ref names stash@{0} only, so `drop stash@{1}` leaves
  // it untouched while destroying an entry. Hashing the reflog's commit list catches push, pop,
  // drop at any index, and clear. One cheap call, and in a repository with no stash it fails
  // immediately and contributes a constant.
  const stashLog = await git(['log', '-g', '--format=%H', 'refs/stash'], { cwd: root })
    .catch(() => ({ code: 1, stdout: '' }));
  h.update('stash').update(String(stashLog.code)).update(stashLog.stdout);

  return h.digest('hex').slice(0, 32);
}

/**
 * Options that cannot change the ANSWER — only how long it takes or how it is printed.
 *
 * A DENYLIST, NOT AN ALLOWLIST, and that direction is the whole point. An allowlist of
 * result-affecting options is correct only until someone adds the next one and forgets to list
 * it, at which point two different analyses silently share a cache entry again. With a denylist
 * the default for anything new is "part of the identity": a genuinely inert option that nobody
 * adds here costs a redundant scan, which is a performance bug. The other direction costs work.
 */
const CACHE_INERT_OPTS = new Set(['timeout', 'json', 'plain', 'quiet', 'verbose', 'debug', 'cwd']);

/**
 * DEFENCE IN DEPTH: does this cached analysis actually contain what the caller asked about?
 *
 * The key derivation above is the fix; this is the belt beside it, because the failure mode is
 * a guard that says `allow` about work it never looked at, and one hash function is a thin thing
 * to stake that on. If `includePrimary` was requested and the cached scan holds no primary
 * workstream, the cache cannot answer the question — and a cache that cannot answer must be a
 * MISS, never a permission.
 */
function cacheAnswers(cached, opts) {
  if (!opts.includePrimary) return true;
  const ws = cached?.scanned?.workstreams;
  if (!Array.isArray(ws)) return false;
  return ws.some((w) => w?.isPrimary);
}

/**
 * The identity of a cached analysis: WHICH repository, and WHAT WAS ASKED OF IT.
 *
 * THE SECOND HALF WAS MISSING AND IT TURNED THE GUARD OFF. `holt integrate` wires three hooks for
 * claude-code: PreToolUse (the blocking guard, which asks for `includePrimary: true`), plus
 * SessionStart and UserPromptSubmit (the brief, which does not). Both call cachedReport(); the
 * cache key hashed only the repo root and the fingerprint only worktree state, so the brief's
 * answer — computed WITHOUT the primary worktree — was served to the guard as though it were the
 * guard's own.
 *
 * Reproduced end to end on a repository whose primary worktree held the only copy of a symbol:
 * on a cold cache `git clean -fd` is DENIED with the symbol named; run the UserPromptSubmit hook
 * first — which the installed configuration does on every single user message — and the identical
 * command is ALLOWED. `git reset --hard`, `git checkout -- .` and `git stash push -u` go the same
 * way. That is holt's central promise failing open, in the exact configuration holt installs, on
 * the most common host it supports.
 *
 * Distinct option sets get distinct FILES rather than sharing one and evicting each other,
 * because a shared entry would make the brief and the guard miss alternately and turn every hook
 * call into a cold scan — a 20-second stall in the agent's critical path, which is the cost this
 * cache exists to avoid.
 */
function cachePath(root, opts = {}) {
  const shape = Object.keys(opts)
    .filter((k) => !CACHE_INERT_OPTS.has(k) && opts[k] !== undefined)
    .sort()
    .map((k) => `${k}=${JSON.stringify(opts[k])}`)
    .join('&');
  const key = createHash('sha256')
    .update(path.resolve(root)).update('\0').update(shape)
    .digest('hex').slice(0, 16);
  return path.join(scratchDir(), `holt-cache-${key}.json`);
}

export async function cachedReport(cwd, opts = {}) {
  const disc = await discover(cwd, opts);
  if (!disc.root) throw repoAbsenceError(disc, cwd);

  const fp = await fingerprint(disc.root);
  const file = cachePath(disc.root, opts);

  try {
    const cached = JSON.parse(await fs.readFile(file, 'utf8'));
    if (cached.fingerprint === fp && cached.version === 1 && cacheAnswers(cached, opts)) {
      return { report: cached.report, scanned: cached.scanned, fingerprint: fp, root: disc.root, fromCache: true };
    }
  } catch { /* no usable cache */ }

  const scanned = await scan(disc, opts);
  const report = await analyze(scanned, opts);
  await fs.writeFile(file, JSON.stringify({ version: 1, fingerprint: fp, report, scanned }), 'utf8')
    .catch(() => { /* an unwritable cache must never fail the scan */ });

  return { report, scanned, fingerprint: fp, root: disc.root, fromCache: false };
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
 * ONE COMMAND-LINE OPERAND — quoted or not. Every destructive rule's target goes through this.
 *
 * IT USED TO BE `[^\s;|&]+`, WHICH TURNED THE GUARD OFF FOR ANYONE WHOSE CHECKOUT PATH CONTAINS
 * A SPACE. That capture stops at the first whitespace whether or not the operand is quoted, so
 * `git worktree remove "/Users/x/My Drive/repo/wt1"` captured `"/Users/x/My` — a path that
 * matches no worktree, so findWorkstream returned null and the verdict fell through to ALLOW.
 * Measured on two byte-identical fixtures differing only by a space in the parent directory
 * name, against a worktree provably holding the only copy of a symbol:
 *
 *   git -C <wt> checkout -- .      deny -> allow      git worktree remove <wt>        deny -> allow
 *   git -C <wt> restore .          deny -> allow      git worktree remove -f -f <wt>  deny -> allow
 *   git -C <wt> reset --hard       deny -> allow      git worktree unlock <wt>        deny -> allow
 *   git -C <wt> clean -fd          deny -> allow      git -C <wt> stash push -u       ask  -> allow
 *
 * Eight of nine forms. Only `rm` survived, and only because a separate quote-aware tokeniser
 * rescues it downstream. `C:\Users\First Last\project` and `~/My Drive/project` are ordinary
 * paths on the two platforms holt is least proven on, so this was the core guarantee being off
 * for a whole population of users while every test on a space-free CI path stayed green.
 *
 * A backslash-escaped space is accepted too, because that is how a POSIX shell spells the same
 * thing unquoted. A lone backslash is NOT treated as an escape, so `C:\src\wt` still parses as
 * one operand on Windows.
 */
const TARGET = '(?:"[^"]*"|\'[^\']*\'|(?:\\\\ |[^\\s;|&])+)';

/** Strip one layer of surrounding quotes and unescape `\ ` — the inverse of TARGET. */
function unquoteTarget(raw) {
  if (raw == null) return null;
  const s = String(raw);
  const quoted = /^"(.*)"$/s.exec(s) ?? /^'(.*)'$/s.exec(s);
  return (quoted ? quoted[1] : s).replace(/\\ /g, ' ');
}

/**
 * Global git options may take a VALUE (`git -C /repo …`, `git -c k=v …`, `--git-dir <p>`), so a
 * pattern that only skips flag tokens misses `git -C /repo worktree remove`. Found by test.
 *
 * `-C` takes a PATH, so its value is a TARGET and not `\S+`: with `\S+` the whole rule failed to
 * match `git -C "has space/wt1" checkout -- .` at all — the globals ate `-C "has ` and then
 * `checkout` did not follow — and a rule that does not match is a command that is allowed.
 */
const GIT_GLOBALS = `(?:-[cC]\\s+${TARGET}\\s+|--(?:git-dir|work-tree|namespace|exec-path)(?:=${TARGET}|\\s+${TARGET})\\s+|-[a-zA-Z]+\\s+|--[a-z-]+\\s+)*`;

// ORDER MATTERS: the first match wins, so the more specific patterns come first. The general
// `remove` pattern's `(?:--force|-f)*` also matches `-f -f`, which would mislabel the override.
  // `--staged` WITHOUT `--worktree` only unstages: the content stays on disk and nothing is lost.
  // The file's own comment below already said so, and the generic pathspec rules above matched it
  // first anyway — so `git restore --staged .` was refused while the behaviourally identical
  // `git reset HEAD .` was allowed, which is the kind of inconsistency that teaches a developer
  // the whole layer is arbitrary.
  const unstageOnly = (c) => /\brestore\b/.test(c) && /--staged\b/.test(c) && !/--worktree\b/.test(c);

/**
 * The tokens `git stash` itself would see, as one shared scan.
 *
 * Both questions below — "is there a pathspec" and "which layers does this sweep" — are answered
 * from the same argv, and answering them from two private copies of the same tokenizer is how the
 * two drift apart. Stops at the next shell separator so a LATER command is never read as this
 * stash's own arguments.
 */
function stashArgs(command) {
  const m = new RegExp(`\\bgit\\s+${GIT_GLOBALS}stash\\b\\s*([\\s\\S]*)`).exec(String(command ?? ''));
  if (!m) return [];
  const rest = m[1].split(/&&|\|\||[;&|\n]/)[0];
  return (rest.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map((t) => t.replace(/^['"]|['"]$/g, ''));
}

/**
 * Does this `git stash` invocation carry a PATHSPEC?
 *
 * `git stash push -- <path>` (or `git stash <path>`, or `git stash -u -- <path>`) scopes the
 * sweep to exactly the paths named — the invoker chose them, so the blast radius is bounded and
 * deliberate, unlike a bare `git stash` which takes everything uncommitted in the worktree
 * without anyone having asked for that specific file. `git stash save <message>` is the one
 * exception: `save` has NO pathspec support at all (git-stash(1)) — its trailing words are a
 * commit message, never a path — so it is always unscoped, however many words follow it.
 *
 * A token scan, not a full parser: the only option `stash push` takes that consumes a VALUE is
 * `-m`/`--message`; every other flag is boolean and skipped whole. `--` marks the start of
 * pathspecs unambiguously; without it, the first bare (non-flag) token is one.
 */
function stashHasPathspec(command) {
  const tokens = stashArgs(command);
  if (!tokens.length) return false;

  let i = 0;
  if (tokens[0] === 'push') i = 1;
  else if (tokens[0] === 'save') return false; // save never takes a pathspec — always the whole tree

  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--') return tokens.slice(i + 1).length > 0;
    if (/^-/.test(t)) {
      if (/^(-m|--message)$/.test(t)) i++; // consumes its value, never a path
      continue;
    }
    return true; // a bare operand with no preceding '--': git treats it as a pathspec
  }
  return false;
}

/**
 * WHICH WORKING-TREE LAYERS THIS PARTICULAR SWEEP CAN ACTUALLY REACH.
 *
 * The same class of defect as gating a stash on committed history, one layer down. A bare
 * `git stash` does not touch untracked files — git-stash(1) is explicit, and it is checkable:
 * in a worktree whose only content is an untracked file, `git stash` prints "No local changes to
 * save", exits 0, and leaves the file exactly where it was. So refusing (or even asking about)
 * that invocation is a warning about work the command provably cannot take, and a guard whose
 * stated reason is untrue is one the reader learns to discount.
 *
 *   always            tracked modifications, staged or not          (layer 'uncommitted')
 *   -u/--include-untracked  adds files git has never tracked        (layer 'untracked')
 *   -a/--all                adds those AND ignored files            (layer 'gitignored')
 *
 * Short options cluster (`-ua`, `-um wip`), so flags are matched inside a cluster rather than as
 * whole tokens. `-m`/`--message` consumes the token after it, which is a message and must never
 * be read as a flag or a path.
 */
function stashSweepLayers(command) {
  const layers = new Set(['uncommitted']);
  const tokens = stashArgs(command);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--') break;                       // everything after this is a pathspec
    if (!t.startsWith('-')) continue;
    if (/^(-m|--message)$/.test(t)) { i++; continue; }
    if (t === '--all' || /^-[a-zA-Z]*a/.test(t)) { layers.add('untracked'); layers.add('gitignored'); }
    if (t === '--include-untracked' || /^-[a-zA-Z]*u/.test(t)) layers.add('untracked');
  }
  return layers;
}

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
  { re: new RegExp(`\\bgit\\s+${GIT_GLOBALS}worktree\\s+unlock\\s+(?<target>${TARGET})`), kind: 'git worktree unlock (disarms protection)' },
  // `remove -f -f` is git's documented override for a locked worktree. Same treatment.
  { re: new RegExp(`\\bgit\\s+${GIT_GLOBALS}worktree\\s+remove\\s+(?:(?:--force|-f)\\s+){2,}(?<target>${TARGET})`), kind: 'git worktree remove --force --force (overrides the lock)' },

  { re: new RegExp(`\\bgit\\s+${GIT_GLOBALS}worktree\\s+remove\\s+(?:(?:--force|-f)\\s+)*(?<target>${TARGET})`), kind: 'git worktree remove' },
  { re: new RegExp(`\\bgit\\s+${GIT_GLOBALS}worktree\\s+prune\\b`), kind: 'git worktree prune', all: true },
  // MATCH ANY rm TARGET, then let resolution decide. This rule previously required the path to
  // contain 'worktree', '.worktrees' or 'wt' — so `rm -rf ../my-feature`, the most natural way to
  // delete a worktree, sailed straight through the one defence holt has against rm (git's lock
  // cannot stop a filesystem delete). Broadening is safe because the target is resolved against
  // the actual worktree list below: a path that is not a worktree finds nothing and is allowed,
  // so `rm -rf node_modules` and `rm -rf dist` are unaffected.
  { re: new RegExp(`\\brm\\s+(?:-[a-zA-Z]+\\s+)*(?<target>${TARGET})`), kind: 'rm of a worktree path' },

  // ---- CONTENT-MUTATING VERBS ------------------------------------------------------------
  // A lock stops `git worktree remove`. It does NOT stop the commands that destroy the SAME
  // uncommitted work in place — and those are the ones that actually cost this project work
  // during its own development. Deleting a worktree and hard-resetting it are the same loss,
  // so covering only the deletion verb was a coverage gap, not a scope boundary.
  //
  // These carry no path argument: they act on the worktree they RUN IN, or wherever `git -C`
  // points. Resolution still decides — a clean worktree has nothing to lose, so the verdict is
  // allow and a developer never notices the rule exists.
  { re: new RegExp(`\\bgit\\s+${GIT_GLOBALS}reset\\s+(?:${TARGET}\\s+)*--hard\\b`), kind: 'git reset --hard (discards uncommitted work)', cwdTarget: true },
  // `-n` and `--dry-run` make this command PRINT what it would delete and delete nothing. Refusing
  // a dry run is refusing the exact thing a careful developer does BEFORE the destructive form —
  // the guard was punishing the caution it exists to encourage, and `-fdn` reads as destructive to
  // a pattern that only looks for f and d anywhere in the cluster.
  {
    re: new RegExp(`\\bgit\\s+${GIT_GLOBALS}clean\\s+-[a-zA-Z]*[fd][a-zA-Z]*\\b`),
    kind: 'git clean -fd (deletes untracked files)',
    cwdTarget: true,
    unless: (c) => /--dry-run\b/.test(c) || /\s-[a-zA-Z]*n[a-zA-Z]*\b/.test(c),
  },
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
  { re: new RegExp(`\\bgit\\s+${GIT_GLOBALS}(?:checkout|restore)\\s+(?:${TARGET}\\s+)*--\\s`), kind: 'git checkout/restore of a pathspec (overwrites uncommitted changes)', cwdTarget: true, unless: unstageOnly },
  { re: new RegExp(`\\bgit\\s+${GIT_GLOBALS}(?:checkout|restore)\\s+(?:${TARGET}\\s+)*\\.\\s*$`), kind: 'git checkout/restore . (overwrites the whole working tree)', cwdTarget: true, unless: unstageOnly },
  // `--staged` ALONE only unstages: the content stays in the working tree and nothing is lost, so
  // denying it was a false positive on an operation people run all day. `--worktree` (with or
  // without --staged) is the one that overwrites files, and a bare pathspec defaults to it.
  { re: new RegExp(`\\bgit\\s+${GIT_GLOBALS}restore\\s+(?:${TARGET}\\s+)*--worktree\\b`), kind: 'git restore --worktree (discards changes)', cwdTarget: true },

  // ---- THE STASH, WHICH THIS GUARD ASSUMED IT ALREADY UNDERSTOOD ---------------------------
  // The refusal message below this table literally reads "No commit, index entry or stash holds
  // this content" — and nothing anywhere checked a stash. Reproduced end to end: work staged and
  // then `git stash push -u` leaves the worktree byte-clean, so `gate` reported "✓ disposable",
  // `rescue` reported "nothingToRescue", and `git stash drop` was classified as NOTHING AT ALL
  // (kind:null) and allowed. Dropping it made the stash commit unreachable immediately.
  //
  // Removing the WORKTREE does not lose a stash — refs/stash is repository-wide and shared — so
  // the loss path is exactly these verbs, and they were the one part of it left unguarded. They
  // are as final as `reset --hard`, which has been in this table from the beginning.
  //
  // `stashScope` — NOT `cwdTarget`/`all` — because the evidence for a stash verb is not a
  // worktree's disposability. See assessStashCommand: `drop`/`clear` destroy STASH ENTRIES, so
  // the only thing that can make them dangerous is an entry existing.
  //
  // `list`, `show` and `apply` are reads and stay out entirely.
  { re: new RegExp(`\\bgit\\s+${GIT_GLOBALS}stash\\s+(?:drop|clear)\\b`), kind: 'git stash drop/clear (destroys stashed work)', stashScope: 'entries' },

  // POP IS THE RECOVERY ACTION, AND A FLAT DENY ON IT WAS THE OVER-REFUSAL THAT MADE TONIGHT'S
  // INCIDENT WORSE: an agent that had just had eleven siblings' work swept into the stash by a
  // bare `git stash` was then BLOCKED from putting any of it back with `pop`. Its actual risk is
  // narrow — a pop that hits a conflict can drop the entry with the content left unapplied — and
  // `apply` does everything `pop` does except that one unsafe last step. So the honest verdict is
  // `ask`, evidence-gated on the SAME thing `drop` is (the entry being popped may belong to any
  // worktree sharing this repository's one `refs/stash`, so the stash is read repo-wide, not per
  // worktree), never hardened into a refusal that blocks the only way back.
  {
    re: new RegExp(`\\bgit\\s+${GIT_GLOBALS}stash\\s+pop\\b`),
    kind: 'git stash pop (drops the entry even if applying fails)',
    stashScope: 'entries',
    verdict: 'ask',
    recovery: '`git stash apply` does everything `pop` does except drop the entry afterward — '
      + 'the same content back, without the one step that can lose it on a conflict.',
  },

  // BARE `stash` / `stash push` / `stash save` WITH NO PATHSPEC SWEEP THE WHOLE WORKTREE, AND
  // THIS IS THE COMMAND THAT ACTUALLY CAUSED TONIGHT'S INCIDENT: run in a working tree several
  // agents were editing at once, it took every one of their uncommitted edits into a single stash
  // entry — the working tree went clean and none of them had been asked. It was let straight
  // through before because a stash IS recoverable; "recoverable if you know to look" is not
  // "safe to run without asking", which is the same reasoning gap `checkout`/`restore` above
  // closed for the working tree and stash never got.
  //
  // So it goes through the SAME evidence engine as `reset --hard` and `clean -fd`: a clean
  // worktree has nothing to sweep and the verdict is a silent allow, and a worktree holding
  // uncommitted-only work gets `ask` — never a flat deny, because stashing is ordinary, everyday,
  // legitimate work and refusing it outright is the opposite failure this whole fix is against.
  //
  // A PATHSPEC NARROWS THE BLAST RADIUS ON PURPOSE: `git stash push -- <path>` sweeps only the
  // files named, chosen by the invoker, so it is the scoped and deliberate act it looks like and
  // is left alone entirely (see `stashHasPathspec`). `save` is excluded from that exemption: it
  // has NO pathspec support at all, so its trailing words are a message, never a path, and it is
  // always treated as sweeping everything.
  {
    re: new RegExp(`\\bgit\\s+${GIT_GLOBALS}stash\\b(?!\\s+(?:apply|list|show|branch|create|store|pop|drop|clear)\\b)`),
    kind: 'git stash / stash push (sweeps every uncommitted change in this worktree into the shared stash)',
    cwdTarget: true,
    // `'mention'`, not `'entries'`: pushing ADDS an entry, it destroys none, so existing entries
    // must never make this fire — a clean tree still sweeps nothing and is still allowed silently.
    // They belong in the MESSAGE, because "your work is now in the stash, alongside four older
    // entries holding content no ref holds" is the sentence that stops a pile from being forgotten.
    // Forgetting is how the stash loses work without anybody typing `drop`.
    stashScope: 'mention',
    verdict: 'ask',
    recovery: '`git stash list` shows what just got queued, and `git stash apply` restores the '
      + 'most recent entry without dropping it.',
    unless: (c) => stashHasPathspec(c),
  },

  // ---- THE SAME ACTS, SPELLED FOR WINDOWS -------------------------------------------------
  // Every rule above is POSIX. On Windows the default shell of most agent hosts is PowerShell or
  // cmd, where the deletion an agent actually emits is `Remove-Item -Recurse -Force ../feature`
  // or `rd /s /q ..\feature`. Neither contains the token `rm`, so the guard returned null and
  // ALLOWED it — under a README that lists Windows as a supported platform.
  //
  // This is the layer that matters most there. git's lock stops `git worktree remove` and cannot
  // stop a filesystem delete; the hook is the only thing that can, and on Windows it was blind.
  //
  // Case-insensitive because PowerShell is: `remove-item`, `Remove-Item` and `REMOVE-ITEM` are
  // one command. The POSIX rules above stay case-SENSITIVE, because `RM` is not `rm` on a POSIX
  // shell and matching it would be inventing a command the user never ran.
  //
  // The flag skip accepts both dialects — PowerShell `-Recurse`, cmd `/s` — and deliberately
  // consumes `-Path`/`-LiteralPath` as a flag so the value that follows is read as the target.
  // Breadth is safe here for the same reason it is safe for `rm`: the target is resolved against
  // the real worktree list, and a path that is not a worktree finds nothing and is allowed.
  {
    re: new RegExp(`\\b(?:Remove-Item|ri|rd|rmdir|erase)\\b(?:\\s+(?:/[a-zA-Z]+|-[A-Za-z]+))*\\s+(?<target>${TARGET})`, 'i'),
    kind: 'Remove-Item / rd / rmdir (deletes the worktree directory)',
  },
  // `del` is separated only so its kind names the command the user typed.
  {
    re: new RegExp(`\\bdel\\b(?:\\s+(?:/[a-zA-Z]+|-[A-Za-z]+))*\\s+(?<target>${TARGET})`, 'i'),
    kind: 'del (deletes the path)',
  },
  // `robocopy <src> <dst> /MIR` mirrors, and mirroring DELETES whatever is in the destination
  // that is not in the source. The destination is the second operand.
  {
    re: new RegExp(`\\brobocopy\\s+${TARGET}\\s+(?<target>${TARGET})(?=[\\s\\S]*/(?:MIR|PURGE)\\b)`, 'i'),
    kind: 'robocopy /MIR (mirrors, deleting anything the source lacks)',
  },
];

/**
 * The byte ranges of a command that are DATA, not command.
 *
 * The patterns above match the raw string, so anything that merely MENTIONS a destructive command
 * was treated as that command. Measured in real use, three times in one session while writing this
 * feature: a test whose COMMENT contained `git checkout -- <path>`, an `echo 'rm -rf wt/x'`, and a
 * heredoc writing documentation about `rm`. Each was refused with an evidence-bearing message
 * about work that was never in danger.
 *
 * That is not a cosmetic annoyance. It is the failure mode this project names repeatedly — a gate
 * that fires on things a developer knows are harmless is a gate they switch off — and it hits
 * hardest on exactly the people most likely to be writing about destructive commands: the ones
 * documenting and testing them.
 *
 * Two kinds of region, and the rule is the same for both: a VERB inside them is text.
 *   quotes    '…' and "…", honouring backslash escapes inside double quotes
 *   heredocs  <<WORD, <<-WORD, <<'WORD' — the body up to the terminator line is a document being
 *             written, not a script being run
 *
 * A quoted TARGET is deliberately still resolved: `rm -rf "wt/my worktree"` must be caught, so
 * only the position of the VERB is tested, never the whole match.
 */
export function maskedRegions(command, { quotes = true } = {}) {
  const out = [];
  const s = String(command);
  let i = 0;
  while (i < s.length) {
    const ch = s[i];

    if (quotes && (ch === "'" || ch === '"')) {
      const start = i;
      const quote = ch;
      i++;
      while (i < s.length && s[i] !== quote) {
        if (quote === '"' && s[i] === '\\') i++;
        i++;
      }
      out.push([start, Math.min(i, s.length - 1)]);
      i++;
      continue;
    }

    if (ch === '<' && s[i + 1] === '<') {
      const m = /^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(s.slice(i));
      if (m) {
        const word = m[2];
        const bodyStart = s.indexOf('\n', i + m[0].length);
        if (bodyStart === -1) { i += m[0].length; continue; }
        // The terminator is a line consisting only of the word (tabs allowed for <<-).
        const term = new RegExp(`^[\\t ]*${word}[\\t ]*$`, 'm');
        const rest = s.slice(bodyStart + 1);
        const hit = term.exec(rest);
        const end = hit ? bodyStart + 1 + hit.index + hit[0].length : s.length;
        out.push([bodyStart, end]);
        i = end;
        continue;
      }
    }
    i++;
  }
  return out;
}

const insideMasked = (regions, idx) => regions.some(([a, b]) => idx >= a && idx <= b);


/**
 * SHELL INDIRECTION: the command holt was handed is not the command that will run.
 *
 * Every rule in the table above matches literal text, and an adversarial sweep confirmed 19 ways
 * to defeat that by supplying the VERB indirectly — each re-executed, each destroying the target:
 *
 *     $(echo rm) -rf ../feature        command substitution supplies the verb
 *     `echo rm` -rf ../feature         the same, in backticks
 *     x=rm; $x -rf ../feature          a variable supplies the verb
 *     eval "rm -rf ../feature"         the argument is code, evaluated later
 *     echo <base64> | base64 -d | sh   the pipeline's input is code
 *
 * holt cannot resolve any of these without EXECUTING them, which is the one thing a pre-execution
 * guard must never do. So it does not pretend: a command whose verb it cannot see is UNKNOWN, and
 * unknown resolves to ASK — the same verdict holt already gives when a probe fails. Absence of
 * evidence is not evidence of absence, and that rule does not stop applying because the ambiguity
 * came from a shell rather than from a broken ctags.
 *
 * DELIBERATELY NARROW, because breadth here would be intolerable. Substitution in an ARGUMENT is
 * completely ordinary — `git commit -m "$(cat msg)"`, `ls $(pwd)`, `echo "$(date)" >> build.log`
 * — and none of those are flagged. Only the VERB position counts.
 *
 * `sh -c '<code>'` is RECURSED INTO rather than flagged: the code is right there as a string, so
 * holt reads it and gives a real answer instead of a shrug. That is strictly better than asking,
 * and it is why wrapping a command in a shell is not a way to soften the verdict.
 */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'pwsh', 'powershell']);
const SUBSTITUTION = /[$`]/;

/**
 * INTERPRETERS THAT CARRY A PROGRAM INLINE.
 *
 * `node -e`, `python3 -c`, `perl -e` and their kin were completely invisible: the verb is ordinary
 * and readable, so the indirection check cleared them, and the DESTRUCTIVE table never sees inside
 * a quoted argument. Reproduced end to end with the loss verified —
 *
 *     node -e "require('fs').rmSync('../feature', {recursive:true, force:true})"
 *     -> {"permissionDecision":"allow"}   then the worktree was gone, and with the file
 *        untracked `git fsck --unreachable --full` returned NOTHING at all
 *
 * — and it contradicted this product's own README, which promises "ask, never a silent allow, for
 * a command whose verb it could not read". The verb here is perfectly readable. The gap was never
 * about the verb.
 *
 * The distinction that matters, and the reason this is not "holt must analyse every program":
 * `npm run build` and `make clean` keep their code in a FILE, so holt cannot read it and does not
 * pretend to — those stay allowed, exactly like any binary on PATH. An inline `-e`/`-c` payload is
 * sitting in the very string being inspected. holt CAN read it, so not reading it was the defect.
 *
 * A destructive filesystem call inside that payload is therefore treated as what it is. Nothing
 * else about these commands changes: `node -e "console.log(1)"` is still allowed, because
 * refusing every inline script would be the over-broad guard that gets a tool uninstalled.
 */
const INTERPRETERS = new Set([
  'node', 'nodejs', 'deno', 'bun', 'python', 'python2', 'python3', 'perl', 'ruby', 'php',
]);
const INLINE_CODE_FLAGS = new Set(['-e', '-c', '--eval', '-E', '--exec', '-p', '--print']);

/**
 * Destructive filesystem operations, as they appear inside an inline program rather than as a
 * shell verb. Deliberately a small list of the calls that actually remove or truncate: this is a
 * recogniser for the common case, not an attempt to understand arbitrary code.
 */
/**
 * Bare program names that destroy, for the case where a verb and its target arrive as SEPARATE
 * quoted strings — `execFile('rm', ['-rf', dir])`, `spawn('shred', [path])`. classifyCommand can
 * only judge a whole command line, and `'rm'` alone is not one, so it needs a token list.
 *
 * Kept deliberately short: every entry licenses treating other strings in the same program as
 * deletion targets, so a false entry here is an over-refusal generator. Anything that needs
 * arguments to be destructive (`git`, `npm`) is NOT here — classifyCommand judges those in full.
 */
const DESTROYER_TOKENS = new Set(['rm', 'rmdir', 'shred', 'truncate', 'unlink', 'del', 'erase']);

const INLINE_DESTRUCTIVE = [
  { re: /\brmSync\s*\(|\brmdirSync\s*\(|\bunlinkSync\s*\(|\bfs\s*\.\s*(rm|rmdir|unlink)\s*\(/, what: 'a filesystem remove', role: 'remove' },
  { re: /\bshutil\s*\.\s*rmtree\s*\(|\bos\s*\.\s*(remove|unlink|rmdir)\s*\(/, what: 'a filesystem remove', role: 'remove' },
  // perl and ruby spell these with no namespace at all, which is how `perl -e "unlink('…')"`
  // walked past a list that only knew the JS and Python forms.
  { re: /\bunlink\s*\(|\brmtree\s*\(|\bremove_entry\s*\(|\bFileUtils\s*\.\s*rm_(rf|r|f)?\b/, what: 'a filesystem remove', role: 'remove' },
  // OVERWRITE IS ITS OWN ROLE, NOT A REMOVE. The old bytes are equally gone, so a target whose
  // only copy is uncommitted still deserves a guard — but writing a file is also the everyday act
  // of editing, performed constantly by legitimate scripts against files they own. Classifying it
  // through the same `rm -rf` proxy as a remove produced verdicts that were wrong in BOTH fields:
  // the label claimed "rm (deletes the file)" about a write, and the decision was a flat deny —
  // measured live, twice in one session, each time blocking a script from editing the very file
  // its author was working on. A guard that misdescribes what it saw teaches the reader to
  // distrust every other message it prints. Overwrites of at-risk files resolve to ASK, with a
  // label that says overwrite.
  { re: /\btruncateSync\s*\(|\bwriteFileSync\s*\(/, what: 'a filesystem overwrite', role: 'overwrite' },
  // `execSync` was the only node spelling here, so `execFile`, `spawn`, `spawnSync` and
  // `execFileSync` — the argv-array forms agents emit constantly — were INVISIBLE. Found while
  // narrowing the over-refusal above: `node -e "execFile('rm',['-rf','<repo>'])"` came back ALLOW,
  // because no rule matched at all. Bare `exec(` is deliberately NOT listed: `/re/.exec(s)` is
  // ordinary and would over-refuse, and any genuine child_process.exec call names the module,
  // which the `child_process` alternative already catches.
  { re: /\bos\s*\.\s*system\s*\(|\bsubprocess\s*\.|\bchild_process\b|\b(?:execSync|execFile|execFileSync|spawn|spawnSync)\s*\(/, what: 'a shelled-out command', role: 'shell' },
  { re: /\bFile\s*\.\s*delete\b|\bFileUtils\s*\.\s*rm/, what: 'a filesystem remove', role: 'remove' },
];

/**
 * EVERY quoted string inside an inline program, not the first one.
 *
 * Taking the first was wrong in the commonest spelling there is: in
 * `require('fs').rmSync('../feature', …)` the first quoted string is `fs`, so the target resolved
 * to a module name, found nothing, and the verdict fell back to ask. And in
 * `os.system('rm -rf ../feature')` the quoted string is not a path at all — it is a whole shell
 * command, which has to be recursed into rather than resolved as a filename.
 *
 * So: return them all, and let the caller try each as a command first and as a path second.
 */
export function inlineStrings(code) {
  return [...String(code).matchAll(/['"`]([^'"`\n]+)['"`]/g)]
    // A WINDOWS PATH IS SPELLED WITH DOUBLED BACKSLASHES IN SOURCE, and taking the raw text
    // between the quotes gets the source spelling rather than the path. `fs.rmSync('C:\\p\\wt')`
    // — the CORRECT way to write that path in JavaScript or Python — yielded the literal string
    // `C:\\p\\wt`, which resolves to nothing, so holt found no target and ALLOWED the removal.
    // A silent under-refusal on the one platform this project has already been bitten by twice.
    //
    // Only the doubled backslash is collapsed. Interpreting the rest of the escape table would
    // turn `C:\new` into `C:` + a newline and invent paths nobody wrote; leaving those verbatim
    // keeps the raw text, which is the closest thing to intent when the source is already
    // malformed.
    .map((m) => m[1].replace(/\\\\/g, '\\'));
}

export function indirectVerb(command) {
  // HEREDOC BODIES AND QUOTED STRINGS ARE DATA, and this check has to know that or it becomes the
  // very thing it was added to avoid. Caught immediately in real use: a `git commit -F` whose
  // heredoc MESSAGE contained the word `npm ci` in backticks was refused with "the command name
  // comes from a substitution" — the guard blocking a commit because of prose inside the commit
  // message. classifyCommand already masks these regions; indirectVerb did not, so the same
  // command was safe from one half of the guard and refused by the other.
  // HEREDOC BODIES ONLY — quoted strings are deliberately left visible here, and the difference
  // matters in both directions.
  //
  // A quoted string cannot be a VERB, so masking one buys nothing: `echo 'rm -rf x'` was never
  // going to be read as indirection, because only w[0] is examined. But `sh -c "rm -rf x"` puts
  // real code inside quotes, and that code is exactly what the recursion below reads to give a
  // DENY with evidence instead of a shrug. Masking quotes turned that back into "sh executing
  // input holt cannot see" — softening a proven deny to an ask, which is the bypass this whole
  // check exists to close. Caught by the test that pins it.
  const masked = maskedRegions(command, { quotes: false });
  const visible = masked.length
    ? [...String(command ?? '')].map((ch, i) =>
      (masked.some(([a, b]) => i >= a && i <= b) ? ' ' : ch)).join('')
    : String(command ?? '');

  // A VARIABLE ASSIGNED A LITERAL IN THE SAME COMMAND IS NOT OPAQUE.
  //
  // `BIN=/opt/holt/bin/holt; "$BIN" --version` is ordinary and the value is sitting right there —
  // refusing it says holt cannot read something it demonstrably can. Caught by dogfooding for the
  // third time: the guard interrupted exactly this while verifying an artifact gate.
  //
  // Only LITERAL assignments are resolved, and only from earlier in the SAME command. A value that
  // is itself a substitution (`X=$(…)`) resolves to nothing and the verb stays unknown, which is
  // the honest answer — this narrows the check, it does not weaken it.
  const literals = new Map();
  for (const m of visible.matchAll(/(?:^|[;&|]\s*)([A-Za-z_][A-Za-z0-9_]*)=([^\s;&|$`'"]+)/g)) {
    literals.set(m[1], m[2]);
  }
  const resolve = (tok) => {
    const m = /^["']?\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?["']?$/.exec(tok);
    return m && literals.has(m[1]) ? literals.get(m[1]) : tok;
  };

  for (const seg of lexSegments(visible)) {
    let w = seg.words;
    // Drop leading VAR=value assignments and transparent wrappers, as the file layer does.
    let cut = 0;
    while (cut < w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[cut]) || WRAPPERS.has(w[cut]))) cut++;
    w = w.slice(cut);
    if (!w.length) continue;

    const verb = resolve(w[0]);
    if (verb === 'eval') return { kind: 'eval (holt cannot see what this will run)' };
    if (SUBSTITUTION.test(verb)) return { kind: 'the command name comes from a substitution or variable' };

    // RESOLVING A VERB MUST FEED CLASSIFICATION, OR IT IS A HOLE.
    //
    // Caught immediately by the anti-vacuity half of the test: `x=rm; $x -rf ../feature` used to
    // come back ASK, because the verb was unreadable. Resolving `$x` to `rm` made this check
    // clean — but classifyCommand still matched against the RAW string, where the token `rm` never
    // appears as a verb, so the verdict silently became ALLOW. A narrowing that turns "ask" into
    // "allow" is not a narrowing, it is the bypass.
    //
    // So a resolved verb is handed back as a rewritten command and re-assessed exactly as a
    // `sh -c` payload is: `x=rm; $x -rf ../feature` is judged as `rm -rf ../feature` and denied
    // with per-file evidence, which is strictly better than the ask it replaced.
    if (verb !== w[0]) {
      const rewritten = [verb, ...w.slice(1)].join(' ');
      const inner = classifyCommand(rewritten);
      if (inner) return { kind: `${inner.kind} (via a variable)`, inner, innerCommand: rewritten };
    }

    // An interpreter's inline program is code holt can read, so it reads it. See INTERPRETERS.
    if (INTERPRETERS.has(path.basename(verb).replace(/\.exe$/i, ''))) {
      for (let i = 1; i < w.length; i++) {
        if (!INLINE_CODE_FLAGS.has(w[i]) || !w[i + 1]) continue;
        const code = w[i + 1];
        for (const { re, what, role } of INLINE_DESTRUCTIVE) {
          if (!re.test(code)) continue;
          return {
            kind: `${verb} ${w[i]} performing ${what}`,
            inlineRole: role,
            inlineStrings: inlineStrings(code),
          };
        }
      }
      continue;   // an inline program with no destructive call is an ordinary program
    }

    // A shell invoked with -c carries its program as a literal string: read it.
    if (SHELLS.has(path.basename(verb))) {
      const i = w.indexOf('-c');
      if (i !== -1 && w[i + 1]) {
        const inner = classifyCommand(w[i + 1]);
        if (inner) return { kind: `${inner.kind} (inside ${verb} -c)`, inner, innerCommand: w[i + 1] };
        if (indirectVerb(w[i + 1])) return { kind: `nested indirection inside ${verb} -c` };
        continue;
      }
      // A SHELL GIVEN A SCRIPT FILE IS JUST A PROGRAM, and holt does not pretend otherwise.
      //
      // `bash build.sh` is no more opaque than `npm run build`, `make clean` or any binary on
      // PATH — holt cannot read inside ANY of them, and flagging this one because the word "bash"
      // appears would interrupt an enormous amount of ordinary work while doing nothing for
      // safety. Caught by dogfooding: this check refused `bash perf-check.sh` moments after it
      // landed, which is precisely how a guard earns its way off a machine.
      //
      // What DOES stay flagged is a shell with no program at all — `… | sh`, `sh < file` — where
      // the code is being assembled by the very command under inspection. That is indirection;
      // running a script somebody wrote is not.
      const hasScript = w.slice(1).some((t) => !t.startsWith('-'));
      if (!hasScript) return { kind: `${verb} executing input holt cannot see` };
      continue;
    }
  }
  return null;
}

export function classifyCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const masked = maskedRegions(command);
  for (const { re, kind, all, cwdTarget, stashScope, unless, verdict, recovery } of DESTRUCTIVE) {
    // A rule may declare an exemption that is not expressible as "the pattern should not have
    // matched", because it depends on ANOTHER flag elsewhere in the command — `--dry-run` on a
    // clean, `--staged` without `--worktree` on a restore. Encoding those as negative lookaheads
    // inside an already dense regex is how the next reader gets it wrong.
    if (unless && unless(command)) continue;
    // Scan every occurrence, not just the first: `echo 'rm -rf a' && rm -rf b` must still be
    // caught on the second one. Only a match whose VERB starts outside a data region counts.
    const scan = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let m = null;
    for (let hit = scan.exec(command); hit; hit = scan.exec(command)) {
      if (!insideMasked(masked, hit.index)) { m = hit; break; }
      if (scan.lastIndex === hit.index) scan.lastIndex++;   // zero-width guard
    }
    if (m) {
      return {
        kind,
        target: m.groups?.target ? unquoteTarget(m.groups.target) : null,
        all: !!all,
        cwdTarget: !!cwdTarget,
        // Which store this rule destroys. `'entries'` means the STASH — read the stash itself for
        // evidence (src/stash.mjs), because no worktree holds what a stash entry holds. Null on
        // every other rule, and nothing without it pays a single git call for the stash.
        stashScope: stashScope ?? null,
        // A rule may cap its OWN verdict below the table's default 'deny' — stash is recoverable
        // (the content lands in a stash commit, not nowhere), so its worst honest answer is
        // "confirm before you do this", never a flat refusal. Absent on every other rule, where
        // the default (assessWorktreeCommand falling through to 'deny') is unchanged.
        verdict: verdict ?? null,
        recovery: recovery ?? null,
      };
    }
  }
  return null;
}


/** `git -C <path> …` redirects which worktree a path-less verb acts on. */
function gitCFlag(command) {
  const m = new RegExp(`\\bgit\\s+(?:${TARGET}\\s+)*?-C\\s+(${TARGET})`).exec(command);
  return m ? unquoteTarget(m[1]) : null;
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
// THE HELPERS BELOW LIVED HERE AS A SECOND COPY, and a second copy is how this class survives.
//
// src/paths.mjs is the single source of truth for path comparison, and the guard test that keeps
// it that way greps src/ for RAW comparisons — so a faithful re-implementation sitting in another
// file was invisible to it. Two copies of a rule drift; the one nobody is watching drifts first,
// and every instance of this class in this project has been invisible on Linux and live on macOS
// and Windows.
//
// The reasoning that produced them is preserved in paths.mjs, including the case that made
// canonicalPath resolve the nearest existing ANCESTOR: `mv src/a.js src/b.js`, a rename inside one
// worktree that loses nothing, was DENIED on macOS and Windows because the source existed and
// canonicalised to /private/var/... while the destination did not exist yet and stayed /var/...,
// so they landed in different worktrees and an ordinary refactor looked like a move OUT.
const samePath = samePathSync;
const underOrEqual = underOrEqualSync;

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
          // parseWorktreePorcelain, not a second hand-rolled reader of the same format.
          //
          // This one split on '\n' and kept lines beginning `worktree `, so a worktree whose
          // DIRECTORY NAME contains a newline — which git permits and reports across two physical
          // lines — was recorded TRUNCATED at the newline. The truncated path matched nothing, so
          // targetIsWorktree() returned false and the guard stood aside entirely.
          //
          // Measured: `holt risk` REPORTED that worktree as holding work found nowhere else,
          // naming it, and the guard ALLOWED `rm -rf` of it in the same repository at the same
          // moment. holt knew, and let it go. `.trim()` compounded it by eating meaningful
          // leading and trailing whitespace in a path.
          //
          // src/discover.mjs already parses this format correctly, with a test pinning exactly
          // this case. Two readers of one format is one reader too many; this is now the same one.
          const recs = parseWorktreePorcelain(r.stdout);
          const out = [];
          for (const rec of recs) {
            if (!rec?.path || rec.bare) continue;
            out.push(await canonicalPath(rec.path));
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
          // The same manifest evidence the scan uses — the fast probe and the scan must not
          // disagree about whether `build/only.js` is noise, because the probe is what the
          // per-command guard actually consults. One readdir, cached with the status.
          const activeDirs = await generatedEvidence(root);
          return atRiskFromStatus(r.stdout, activeDirs);
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

/**
 * THE SAME TABLE, FOR THE SHELLS WINDOWS AGENTS ACTUALLY RUN.
 *
 * Looked up case-INSENSITIVELY, because PowerShell is: `clear-content` and `Clear-Content` are
 * one command. The POSIX table above stays case-sensitive on purpose.
 *
 * `Clear-Content` and `Set-Content` deserve the attention: they are in-place destroyers with no
 * entry in the POSIX table at all. Neither deletes a file, so nothing about the path changes and
 * no `rm` appears anywhere — they simply replace the contents of a file that may hold the only
 * copy of an agent's work. `Out-File` does the same through a redirect-shaped API.
 *
 * `-Path` and `-LiteralPath` are NOT listed as value-taking options anywhere here: dropping the
 * flag and keeping its value is exactly right, because the value IS the target. `-Value`,
 * `-Encoding` and friends are listed, because their values are payload, not paths.
 */
const PS_PATH_OPTS = ['-Path', '-LiteralPath', '-FilePath'];
const PS_NOISE = new Set(['-Value', '-Encoding', '-Filter', '-Include', '-Exclude', '-Stream',
  '-ErrorAction', '-WarningAction', '-InformationAction', '-ErrorVariable', '-OutVariable',
  '-Width', '-Delimiter', '-NewName']);

const WIN_FILE_VERBS = {
  'remove-item': { role: 'delete', valueOpts: PS_NOISE },
  ri: { role: 'delete', valueOpts: PS_NOISE },
  del: { role: 'delete', valueOpts: PS_NOISE },
  erase: { role: 'delete', valueOpts: PS_NOISE },
  rd: { role: 'delete', valueOpts: PS_NOISE },
  rmdir: { role: 'delete', valueOpts: PS_NOISE },
  'clear-content': { role: 'truncate', valueOpts: PS_NOISE },
  clc: { role: 'truncate', valueOpts: PS_NOISE },
  'set-content': { role: 'truncate', valueOpts: PS_NOISE },
  'out-file': { role: 'truncate', valueOpts: PS_NOISE },
  // A move takes the work OUT of its worktree; the destination is clobbered. Same shape as `mv`.
  'move-item': { role: 'move', valueOpts: new Set([...PS_NOISE, '-Destination']) },
  mi: { role: 'move', valueOpts: new Set([...PS_NOISE, '-Destination']) },
  move: { role: 'move', valueOpts: new Set([...PS_NOISE, '-Destination']) },
  // A copy leaves the source alone and replaces the destination only.
  'copy-item': { role: 'dest-only', valueOpts: new Set([...PS_NOISE, '-Destination']) },
};

/** cmd switches (`/s`, `/q`, `/f`) are flags, not paths — dropped like `-x` is. */
const isWinSwitch = (t) => /^\/[a-zA-Z]+$/.test(t);

/**
 * Resolve a verb through the POSIX table first, then the Windows one.
 *
 * POSIX first and exact, so nothing about existing behaviour shifts; Windows second and folded,
 * so PowerShell's case-insensitivity is honoured without making `RM` mean `rm`.
 */
function verbSpec(word) {
  if (Object.hasOwn(FILE_VERBS, word)) return FILE_VERBS[word];
  const w = word.toLowerCase();
  return Object.hasOwn(WIN_FILE_VERBS, w) ? WIN_FILE_VERBS[w] : null;
}

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
export function lexSegments(command, depth = 0) {
  const segments = [];
  // Inner commands found inside $(…) / `…`, lexed separately and appended. See the note below.
  const nested = [];
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

    // A BACKSLASH IS AN ESCAPE IN A POSIX SHELL AND A PATH SEPARATOR ON WINDOWS, and treating it
    // as an escape unconditionally was a live safety hole:
    //
    //     mv secret.js C:\Users\x\stolen.js   ->   destination parsed as "C:UsersxStolen.js"
    //
    // which is a RELATIVE path, so it resolved INSIDE the worktree, so holt read a move OUT of the
    // worktree as an in-place rename and ALLOWED it. On Windows an agent could move the only copy
    // of a file out from under holt and the guard would permit it.
    //
    // The discrimination has to keep POSIX semantics exactly — `rm foo\ bar.txt` is one file named
    // "foo bar.txt", and breaking that would be its own defect — so the rule is narrow and keyed on
    // shapes no POSIX shell produces:
    //
    //   `C:\…`      the buffer so far is exactly a drive letter and a colon: a Windows absolute path
    //   `\\host\…`  a leading double backslash: a UNC path
    //   win32       on Windows itself, a backslash before a normal path character is a separator;
    //               before a space or a quote it is still an escape, which is how cmd and
    //               PowerShell quote paths containing spaces
    //
    // Everything else keeps the old behaviour, so nothing about POSIX parsing changes.
    if (ch === '\\') {
      const next = command[i + 1] ?? '';
      // STARTS with a drive letter, not EQUALS one: after the first separator the buffer is
      // `C:\Users`, and an equality test would make only the first backslash literal and eat the
      // rest — which is the same mangling in slower motion.
      const driveQualified = /^[A-Za-z]:/.test(buf);
      // A UNC path opens with two backslashes. After the FIRST one is taken literally the buffer
      // holds a single backslash, so the continuation test is "this token began with one" — not
      // "begins with two", which never matches at that point and ate the rest of the path.
      const uncStart = (!has && next === '\\') || buf.startsWith('\\');
      const winSeparator = process.platform === 'win32' && next !== '' && !/[\s'"]/.test(next);
      if (driveQualified || uncStart || winSeparator) {
        buf += ch;              // literal separator — do NOT consume the character after it
        has = true;
        continue;
      }
      buf += next; has = true; i++; continue;
    }
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

    // A COMMAND SUBSTITUTION IS ONE WORD TO THE OUTER COMMAND, AND A COMMAND OF ITS OWN.
    //
    // `|`, `;` and `&` inside `$(…)` were treated as outer segment separators, so
    //
    //     ID=$(echo $R | cut -d' ' -f1); gh run view $ID
    //
    // split at the inner pipe, the assignment-stripper consumed `ID=$(echo`, and the NEXT word —
    // `$R`, an argument to echo — was read as a command VERB. holt then refused the whole thing
    // with "the command name comes from a substitution or variable". Measured against holt's own
    // guard while it was guarding this repository: an ordinary `gh run view` was blocked, and a
    // refusal an agent cannot act on costs a turn and teaches it to ignore the next one.
    //
    // The substitution's text is kept in the current WORD, so the outer verb is read correctly and
    // a verb that genuinely IS a substitution still trips the check below. Its contents are then
    // lexed as commands in their own right and appended, so `$(rm -rf x)` is still seen: this
    // narrows a false positive without narrowing what holt can find.
    if ((ch === '$' && command[i + 1] === '(') || ch === '`') {
      const backtick = ch === '`';
      const openLen = backtick ? 1 : 2;
      let j = i + openLen;
      let dep = 1;
      for (; j < command.length; j++) {
        if (command[j] === '\\') { j++; continue; }
        if (backtick) { if (command[j] === '`') { dep = 0; break; } continue; }
        if (command[j] === '(') dep++;
        else if (command[j] === ')') { dep--; if (dep === 0) break; }
      }
      const inner = command.slice(i + openLen, j);
      buf += command.slice(i, Math.min(j + 1, command.length));
      has = true;
      if (depth < 4 && inner.trim()) nested.push(...lexSegments(inner, depth + 1));
      i = Math.min(j, command.length - 1);
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
  return segments.concat(nested);
}

/** The spelling of `opt` that appears in `valueOpts`, ignoring case. PowerShell params fold. */
function canonOpt(opt, valueOpts) {
  const lower = opt.toLowerCase();
  for (const v of valueOpts) if (v.toLowerCase() === lower) return v;
  return opt;
}

/** Positional operands of a verb: flags dropped, `--` honoured, value-taking options skipped. */
function operandsOf(tokens, valueOpts) {
  const out = [];
  let after = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!after && t === '--') { after = true; continue; }
    if (!after && t.length > 1 && t.startsWith('-')) {
      // Value-taking options are matched case-insensitively so PowerShell's `-value` and
      // `-Value` behave alike; a POSIX short option is unaffected because it has no other case.
      if (valueOpts.has(t) || valueOpts.has(canonOpt(t, valueOpts))) i++;
      continue;
    }
    // cmd switches (`/s`, `/q`, `/f`) are flags in every sense that matters here.
    if (!after && isWinSwitch(t)) continue;
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

    const spec = verbSpec(w[0]);
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

    // Through paths.mjs even though both sides ARE already canonical here (abs comes from
    // canonicalPath, root from deepestRoot over canonical roots). The guard cannot see that from
    // one line, and "it happens to be safe at this call site" is exactly the reasoning that let
    // the /var-vs-/private/var class survive three separate fixes. One helper, no exceptions.
    const relPrefix = await relativeWithinAsync(root, abs);

    // THE SUFFIX IS SLICED BY THE PREFIX'S REAL LENGTH, NOT BY ITS SUBSTITUTE'S.
    //
    // globFreePrefix() returns '.' when the FIRST segment is already a glob — a stand-in meaning
    // "no prefix", not a prefix that exists in the string. Slicing `raw` by that stand-in's length
    // therefore ate the first real character: `*.js` became `.js`, and a bare `?` became the empty
    // string. Empty then fell through to the `|| '**'` default below, so the matcher claimed EVERY
    // at-risk file in the worktree.
    //
    // Live consequence, reproduced: `echo x > ?` was refused with "would destroy 7 file(s)",
    // listing the whole gitignored set of this repository. Nothing there redirects to anything —
    // the shell would create one file literally named `?`. A target holt could not resolve was
    // being reported as a target that hits everything, which is the loudest possible false
    // positive and precisely how a guard gets switched off.
    const gfp = globFreePrefix(t.raw);
    const prefixLen = (gfp === '.' && !t.raw.startsWith('.')) ? 0 : gfp.length;
    const suffix = GLOBBY.test(t.raw) ? t.raw.slice(prefixLen).replace(/^\/+/, '') : '';
    const rel = suffix ? `${relPrefix ? `${relPrefix}/` : ''}${suffix}` : relPrefix;

    // '**' stays the default for a target that genuinely IS the worktree root — `rm -rf .` really
    // does put everything at stake. It is reached only when the raw target resolved there with no
    // glob left over, which is now a statement about the path rather than an artefact of slicing.
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

  // findByPath, not two hand-rolled comparisons. What stood here was
  //   foldCase(path.resolve(w.path)) === foldCase(root)
  //   ?? samePathSync(path.resolve(w.path), root)
  // — and samePathSync IS `foldCase(a) === foldCase(b)`, so the second clause was the first one
  // spelled differently. The line read as a fast path with a careful fallback and was one
  // comparison repeated, neither of which resolves a symlink. It also sat invisible to the
  // raw-comparison guard for the whole life of that guard, because wrapping `path.resolve()` in
  // anything at all defeated the patterns it grepped for. Both are fixed; this is the class's
  // one correct spelling.
  //
  // Memoised because it is called once per hit and canonicalPath does real filesystem work.
  const wsCache = new Map();
  const wsFor = async (root) => {
    if (!wsCache.has(root)) wsCache.set(root, await findByPath(scanned?.workstreams ?? [], root) ?? null);
    return wsCache.get(root);
  };

  const byWs = new Map();
  for (const h of hits) {
    const ws = await wsFor(h.root);
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
      + 'Run `holt risk` to inspect, `holt rescue <id>` to capture the whole worktree, or commit it.\n'
      + `If it is genuinely disposable: holt discard ${hits.map((h) => h.file).slice(0, 3).join(' ')}`
      + ' — that captures the content to a verified ref FIRST, then removes it, so this is'
      + ' recoverable and recorded rather than gone.',
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

/* ------------------------------------------------------- the stash's own evidence ---- */

/**
 * WHICH ENTRY THIS `drop`/`pop` DESTROYS.
 *
 * `git stash drop stash@{2}` cannot destroy `stash@{0}`, and weighing it against the whole stash
 * is the same over-refusal as weighing a stash against committed history, one scope down.
 *
 * AND A DROP WITH NO SELECTOR IS NOT "EVERY ENTRY" EITHER — that is the same mistake with the
 * default. `git stash drop` drops stash@{0} and nothing else (git-stash(1): "<stash> … defaults
 * to the latest one"), so a stash whose newest entry is disposable and whose OLDER entry holds
 * the only copy of something must still allow the bare drop. Reading the absent selector as "all"
 * refused it, naming an entry the command provably cannot reach — the checkably-false refusal
 * this whole area already learned to avoid once, reintroduced at the level of a default.
 *
 * `clear` takes no selector — it always means every entry — so callers must not consult this
 * for it.
 *
 * @returns {string|undefined} the selector, or `undefined` when an operand IS present and holt
 *   cannot resolve it — never conflated with "no operand", because the safe answer differs:
 *   an unreadable selector must weigh every entry, an absent one weighs exactly stash@{0}.
 */
function stashSelector(command) {
  const tokens = stashArgs(command);
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--') continue;
    // Every option `drop`/`pop` accepts (-q/--quiet, --index) is boolean and consumes no value.
    if (t.startsWith('-')) continue;
    // git accepts both spellings for the same entry: `stash@{2}` and a bare `2`.
    const m = /^(?:(?:refs\/)?stash@\{(\d+)\}|(\d+))$/.exec(t);
    return m ? `stash@{${m[1] ?? m[2]}}` : undefined;
  }
  return 'stash@{0}';
}

/**
 * `drop` / `clear` / `pop`, answered from the stash reflog and nothing else.
 *
 * THE EVIDENCE IS THE ENTRY, NOT THE WORKTREE. After a sweep the working tree is byte-clean and
 * the stash is the workstream — so a worktree-shaped check answers "nothing at risk" about the
 * one place the work now lives. It also answers the reverse, which is what the refutation
 * measured: with `git stash list` verified EMPTY, these verbs were still being asked about, on
 * evidence describing content no stash entry holds. An empty stash makes every one of them a
 * provable no-op.
 *
 * PER-BLOB REACHABILITY, not "is this stash commit reachable" — a stash commit never is, by
 * construction, so that question refuses every drop forever. `stashState` asks whether the
 * CONTENT is reachable from a real ref: apply an entry and commit it, and dropping the entry
 * loses nothing, so the guard steps back. See src/stash.mjs for the full argument.
 */
async function assessStashEntries(command, cwd, hit) {
  // Resolve `git -C <path>` against the ASSESSED cwd, not process.cwd(). A relative path like
  // `git -C ../other-wt stash drop` must target the sibling worktree, not whatever directory
  // Node happened to start in.
  const cFlag = gitCFlag(command);
  const dir = cFlag ? path.resolve(cwd, cFlag) : cwd;
  // `stashState` is documented never to throw; the catch is there so that promise remaining true
  // is not something this file has to trust, and so `null` stays a value the checks below handle.
  const state = await stashState(dir).catch(() => null);
  // "holt could not look" is not "there is nothing there", and conflating them is the exact
  // silence this whole module exists to break.
  if (!state || (!state.checked && state.total === 0)) {
    return {
      decision: 'ask',
      kind: hit.kind,
      targets: [],
      reason: `holt could not read this repository's stash, so it cannot say what ${hit.kind} `
        + 'would destroy. Run `git stash list` and confirm manually before proceeding.',
    };
  }
  if (state.total === 0) {
    return { decision: 'allow', reason: null, kind: hit.kind, targets: [] };
  }

  let scoped = state.entries;
  // `drop`/`pop` WITHOUT A SELECTOR MEAN stash@{0}, NOT "the whole stash" — verified against
  // git: with two entries queued, a bare `git stash drop` prints "Dropped refs/stash@{0}" and
  // leaves stash@{1} exactly where it was. Weighing every entry against a command that removes
  // one is the same over-refusal as weighing a stash against committed history, one scope down:
  // it refuses a provably safe drop on evidence from an entry the command cannot reach.
  // `clear` is the one that genuinely takes them all, and it takes no selector at all — read
  // from the argv rather than by searching the string, so a stash MESSAGE containing the word
  // "clear" (`git stash push -m "clear the decks"`) cannot rewrite which entries are at stake.
  // Can this command reach an entry the walk never scanned? `clear` takes every entry, so past
  // the cap it always can. Anything narrower can only be cleared of that suspicion by RESOLVING
  // to an entry holt actually read.
  let reachesUnscanned = state.truncated;
  if (stashArgs(command)[0] !== 'clear') {
    const selector = stashSelector(command);
    // `undefined` is an operand holt could not resolve — NOT an absent one. The safe answers
    // differ, and collapsing them loses one of the two: an unreadable selector must weigh every
    // entry (holt does not know which is going), an absent one weighs exactly stash@{0}.
    if (selector !== undefined) {
      const one = state.entries.find((e) => e.selector === selector);
      // A selector that names an entry holt READ is fully accounted for, cap or no cap — this is
      // what keeps a bare `git stash drop` (which means stash@{0}) cheap and allowed.
      if (one) { scoped = [one]; reachesUnscanned = false; }
      // A selector holt could not match means "not there" ONLY when holt saw the whole stash.
      // The walk is capped (MAX_ENTRIES), and beyond the cap an unmatched selector means "not
      // looked at" — so there, every entry is weighed rather than none.
      else if (!state.truncated) { scoped = []; reachesUnscanned = false; }
    }
  }

  const doomed = scoped.filter((e) => e.uniqueCount > 0);
  if (doomed.length === 0) {
    // NOTHING AT RISK AMONG THE ENTRIES HOLT READ IS NOT NOTHING AT RISK. Past the cap the walk
    // stops, and a sole copy sitting at stash@{30} produces exactly this empty result — every
    // scanned entry provably safe, the one that matters never examined. Answering `allow` here
    // reports the silence as an all-clear and destroys the content; the honest answer is that
    // holt did not look, which is the same answer it gives when it cannot read the stash at all.
    if (reachesUnscanned) {
      return {
        decision: 'ask',
        kind: hit.kind,
        targets: [],
        reason: `holt is asking before this: ${hit.kind}. This repository has more than `
          + `${MAX_ENTRIES} stash entries and holt scanned only the first ${MAX_ENTRIES}. Nothing `
          + 'at risk was found among those — but this command can reach entries holt never '
          + 'examined, so that is not an all-clear.\n'
          + 'Run `git stash list` and check the entries past '
          + `stash@{${MAX_ENTRIES - 1}} before proceeding, or `
          + '`holt rescue` them to a ref first.',
      };
    }
    return { decision: 'allow', reason: null, kind: hit.kind, targets: [] };
  }

  const detail = describeStash({ atRisk: doomed, truncated: state.truncated });
  const targets = doomed.map((e) => e.selector);
  // Same cap the table declares, read the same way as everywhere else: `pop` is the way BACK
  // from a sweep and must never harden into a refusal, `drop`/`clear` have no equivalent that
  // keeps the entry and stay final.
  if ((hit.verdict ?? 'deny') === 'ask') {
    return {
      decision: 'ask',
      kind: hit.kind,
      targets,
      reason: `holt is asking before this: ${hit.kind}. The stash holds content no ref holds:\n`
        + `${detail}\n`
        // THE SPECIFIC RISK, SAID OUT LOUD. `pop` = apply, then drop — and it drops on a partial
        // apply too. So this content survives ONLY IF the apply succeeds; if it conflicts, the
        // entry is unlinked anyway and the blobs above become unreachable in the same command.
        // A message that only says "content no ref holds" describes the stake without describing
        // the mechanism, and the mechanism is the whole reason `apply` is the better verb.
        + 'This content survives only if the apply succeeds — `pop` drops the entry either way, '
        + 'including on a conflict.\n'
        + `${hit.recovery}\n`
        + 'Run `git stash list` to inspect first, or confirm this is what you mean.',
    };
  }
  return {
    decision: 'deny',
    kind: hit.kind,
    targets,
    reason: `holt blocked this: ${hit.kind} would destroy stashed content that no ref holds.\n`
      + `${detail}\n`
      + 'A stash entry is a commit nothing points at: unlink it from the reflog and those blobs '
      + 'are unreachable in the same breath.\n'
      + 'Run `git stash apply` to bring it back into a worktree first, or `holt rescue <id>` to '
      + 'capture it to a ref — then dropping it loses nothing and holt will say so.',
  };
}

/**
 * WHAT THIS PARTICULAR SWEEP WOULD ACTUALLY TAKE OUT OF THE WORKING TREE.
 *
 * One `git status`, intersected with the layers this invocation reaches (stashSweepLayers): a
 * bare `git stash` cannot touch an untracked file, so an untracked-only worktree is a proven
 * no-op there and asking about it is a warning about work the command leaves on disk. `-u` adds
 * the untracked layer, `-a` adds ignored content too, and each is judged on exactly what it
 * takes.
 *
 * The at-risk mapping is scan.mjs's (`atRiskFromStatus`), the same instrument the file-granular
 * layer uses — so recognisable build output is already excluded and the two layers cannot drift
 * into describing the same file two different ways. `git status` reports the whole worktree with
 * root-relative paths from any subdirectory, so running it where the stash would run is exact.
 */
async function sweptContent(command, cwd, ctx) {
  const layers = stashSweepLayers(command);
  // Resolve `git -C <path>` against the assessed cwd, not process.cwd() — same fix as
  // assessStashEntries. A relative -C path must target the worktree the agent specified.
  const cFlag = gitCFlag(command);
  const root = await canonicalPath(cFlag ? path.resolve(cwd, cFlag) : cwd);
  const dirty = await ctx.dirtyFiles(root);
  if (dirty === null) return { unreadable: true, files: [] };
  const files = [];
  for (const [p, layer] of dirty) if (layers.has(layer)) files.push({ path: p, layer });
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { unreadable: false, files };
}

/** The sweep half of a guard message: which files leave the working tree, and from which layer. */
function describeSweep(sweep, id) {
  const sample = sweep.files.slice(0, 3).map((f) => `\n      ${f.path} (${f.layer})`).join('');
  const more = sweep.files.length > 3 ? `\n      +${sweep.files.length - 3} more` : '';
  return `  • ${id ?? 'this worktree'}: ${sweep.files.length} file(s) this sweep would take`
    + `${sample}${more}`;
}

/** What the stash is ALREADY holding, for a message about adding one more entry to it. */
async function describeQueued(dir) {
  const state = await stashState(dir).catch(() => null);
  if (!state || !state.atRisk.length) return '';
  return `  …and the stash already holds ${state.atRisk.length} entr(y/ies) whose content no ref `
    + `holds:\n${describeStash(state)}\n`;
}

/** The worktree-granularity half: unchanged behaviour, returns null when no rule matches. */
async function assessWorktreeCommand(command, cwd, ctx) {
  const hit = classifyCommand(command);
  if (!hit) {
    // Nothing matched — but did holt actually get to READ the command? If the verb is supplied by
    // a substitution, a variable or an eval, "no rule matched" means "no rule could match", and
    // reporting that as allow is the fail-open shape this guard exists to prevent.
    const blind = indirectVerb(command);
    // A shell's `-c` argument is CODE HOLT CAN READ. Where the inner command is definitively
    // destructive there is no ambiguity left to report, and softening deny to ask would make the
    // wrapper itself the bypass. Re-assess the inner string exactly as if it had been typed, so
    // the verdict carries the same per-file evidence.
    if (blind?.innerCommand) return assessWorktreeCommand(blind.innerCommand, cwd, ctx);

    // An inline program that removes something names its target in the same string, so holt
    // resolves it through the ordinary path and gives a real refusal that names the files:
    // `node -e "require('fs').rmSync('../feature', …)"` is judged exactly as `rm -rf ../feature`.
    if (blind?.inlineStrings) {
      // THE `rm -rf <str>` PROXY BELOW NEEDS A DESTRUCTIVE VERB TO BE PRESENT, OR IT INVENTS ONE.
      //
      // For a REMOVE (`rmSync('../feature')`) the quoted string IS the removal target, so the
      // proxy is exact. For a SHELLED-OUT command it is not: the strings are that command's
      // ARGUMENTS — a cwd, an env value, a flag — and nothing is being removed at all.
      //
      // MEASURED, and it blocked this project's own maintenance twice in one session:
      //   node -e "execSync('git show HEAD:site/index.html', { cwd: '/home/raed/grove' })"
      // was DENIED as "rm -rf of the main working tree", because `/home/raed/grove` — the
      // directory the read-only command runs IN — was fed to the proxy as a deletion target. Any
      // script that so much as mentions a path in a `cwd:` option is refused. Over-refusal is the
      // failure that gets a safety tool switched off, and this one refuses `git log`.
      //
      // Dropping the proxy for `shell` outright would open a real hole the other way, because a
      // verb and its target can live in SEPARATE strings: `execFile('rm', ['-rf', dir])`. So the
      // rule is neither "always" nor "never" — the proxy applies when some string actually names
      // a destroyer, which is the evidence that makes the remaining strings targets.
      const namesADestroyer = blind.inlineRole !== 'shell'
        || blind.inlineStrings.some((s) => classifyCommand(s) || DESTROYER_TOKENS.has(
          path.basename(String(s).trim().split(/\s+/)[0] ?? '').replace(/\.exe$/i, '').toLowerCase()));

      for (const str of blind.inlineStrings) {
        // Each quoted string is either a shell command (`os.system('rm -rf x')`) or a path
        // (`rmSync('../feature')`). Try it as a command first, then as a path — whichever resolves
        // to something holt would refuse IS the refusal.
        // BOTH GRANULARITIES, because an inline program removes files as readily as directories.
        // `perl -e "unlink('../feature/only-here.txt')"` names a FILE inside a worktree, which the
        // worktree layer cannot see by design — checking only that layer let it through.
        const viaWorktree = async (c) => {
          const wt = await assessWorktreeCommand(c, cwd, ctx);
          if (wt && wt.decision !== 'allow') return wt;
          const targets = resolveFileTargets(c);
          return targets.length ? assessFileTargets(targets, cwd, ctx) : null;
        };
        const asCommand = classifyCommand(str) ? await viaWorktree(str) : null;
        const resolved = asCommand && asCommand.decision !== 'allow'
          ? asCommand
          : (namesADestroyer ? await viaWorktree(`rm -rf ${str}`) : null);
        if (resolved && resolved.decision !== 'allow') {
          // The `rm -rf` resolution above is a TARGETING proxy — it answers "would this path's
          // loss matter", not "what is this program doing". For a REMOVE the two coincide. For an
          // OVERWRITE they do not: the old content is equally gone, but writing a file is the
          // everyday act of editing, and inheriting the proxy verbatim produced a message calling
          // a write "rm (deletes the file)" and a flat deny where the calibrated answer is ask —
          // the target matters, the human decides, and the label tells the truth about the act.
          if (blind.inlineRole === 'overwrite') {
            return {
              ...resolved,
              decision: 'ask',
              kind: blind.kind,
              reason: `this overwrites file(s) whose current content exists nowhere else — the old bytes are unrecoverable if this is wrong.\n`
                + `${resolved.reason.split('\n').slice(1).join('\n')}\n`
                + `(seen inside ${blind.kind} — confirm the write is intended, or use holt discard first to capture the current content)`,
            };
          }
          return { ...resolved, kind: blind.kind, reason: `${resolved.reason}\n(seen inside ${blind.kind})` };
        }
      }
      // NOTHING AT RISK, SO ALLOW — not ask. holt READ this program; it is not blind to it. Asking
      // here would interrupt `node -e "require('fs').rmSync('./node_modules')"`, which is ordinary
      // and harmless, and an over-broad guard is the one that gets uninstalled.
      return null;
    }
    if (blind) {
      return {
        decision: 'ask',
        kind: blind.kind,
        targets: [],
        reason: `holt cannot determine what this command will run: ${blind.kind}.\n`
          + 'The verb is produced at runtime, so no pre-execution check can see it. If it is '
          + 'harmless, run it directly so holt can read it; if it deletes a worktree, run '
          + '`holt gate <id>` first.',
      };
    }
    return null;
  }

  // CHEAP PRE-CHECK before the expensive scan. The rm rule matches any target so that
  // `rm -rf ../my-feature` is caught, but that would otherwise make every `rm -rf node_modules`
  // in an agent session pay for a full repository scan. `git worktree list` is one fast call:
  // if the target is not a worktree at all, there is nothing THIS layer can protect and it
  // stands aside — the file layer above still resolves the same path.
  if (hit.kind === 'rm of a worktree path' && hit.target) {
    const isWt = await targetIsWorktree(hit.target, cwd, ctx);
    if (!isWt) return null;

    // DELETING THE MAIN WORKING TREE DELETES .git, AND WITH IT EVERYTHING.
    //
    // Every check below this point asks "would this destroy content whose only copy is on disk".
    // For a clean main working tree the honest answer is no — and `rm -rf <repo>` still takes
    // every commit, every branch, every reflog, every stash and every refs/holt/* rescue ref that
    // holt itself created, because .git is inside the path. The guard allowed it, correctly by
    // its own rule and catastrophically in effect.
    //
    // `git worktree remove` refuses the main working tree outright, which is the only reason
    // `holt clean --apply` was never able to do this. `rm` has no such protection. So this is
    // answered here, from the repository's own layout, and it is answered the same way whether
    // the tree is clean or dirty — the value at stake is the history, not the working files.
    const abs = await canonicalPath(path.resolve(cwd || process.cwd(), hit.target));
    const gitPath = path.join(abs, '.git');
    const holdsGitDir = await fs.stat(gitPath).then((s) => s.isDirectory()).catch(() => false);
    if (holdsGitDir) {
      return {
        decision: 'deny',
        kind: 'rm of the repository root',
        targets: [path.basename(abs)],
        files: [],
        reason:
          `holt blocked this: ${hit.target} is the repository's MAIN WORKING TREE, and .git is inside it.\n`
          + '  • every commit, branch, tag, reflog, stash and refs/holt/* rescue ref goes with it\n'
          + 'This is not recoverable from the worktree, because the worktree is what holds the history.\n'
          + '`git worktree remove` refuses the main working tree for the same reason; `rm` does not.\n'
          + 'If you meant to remove a LINKED worktree, name that path instead. If you genuinely mean '
          + 'to delete this repository, do it outside the agent session.',
      };
    }
  }

  // ---- A STASH VERB IS WEIGHED ONLY AGAINST WHAT A STASH CAN DESTROY ----------------------
  //
  // Everything below this point answers "would DELETING this workstream lose something", and
  // that is the wrong question for `git stash`. Its blast radius is provably bounded to the
  // working tree and the stash reflog: no spelling of it can reach a commit. Routed through the
  // workstream's `safe` flag — built from committed deltas AND uncommitted counts AND unique
  // symbols spanning every layer — the guard asked about a bare `git stash` in a worktree with a
  // VERIFIED-EMPTY `git status`, citing a symbol sitting safely in committed history. The real
  // command there prints "No local changes to save". The reason was not merely cautious, it was
  // checkably false, and a guard whose stated reason is false teaches its reader to discount
  // every message it prints — which is how the true ones get ignored too.
  //
  // So each verb is answered from the store IT writes to:
  //   drop / clear / pop           the stash reflog (src/stash.mjs). Nothing queued, nothing to
  //                                lose: an empty stash makes all three provable no-ops.
  //   stash / push / save          this worktree's status, restricted to the layers this exact
  //                                invocation sweeps (see stashSweepLayers). A clean tree sweeps
  //                                nothing and is allowed in silence.
  if (hit.stashScope === 'entries') return assessStashEntries(command, cwd, hit);

  // Deliberately BEFORE the scan: a no-op stash must not pay for a full repository analysis in
  // the agent's critical path, and it must not be able to fail on one either. One `git status`.
  const sweep = hit.stashScope === 'mention' ? await sweptContent(command, cwd, ctx) : null;
  if (sweep?.unreadable) {
    return {
      decision: 'ask',
      kind: hit.kind,
      targets: [],
      reason: `holt could not read this worktree's status, so it cannot say what ${hit.kind} `
        + 'would sweep. Run `git status` and confirm manually before proceeding.',
    };
  }
  if (sweep && sweep.files.length === 0) {
    // PROVEN NO-OP. git itself would print "No local changes to save" here.
    return { decision: 'allow', reason: null, kind: hit.kind, targets: [] };
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

  // Resolve `git -C <path>` against the assessed cwd once — used by both the workstream lookup
  // and the queued-stash description below. A relative -C path must target the worktree the
  // agent specified, not whatever directory Node happened to start in.
  const resolvedCFlag = gitCFlag(command);
  const assessedCwd = resolvedCFlag ? path.resolve(cwd, resolvedCFlag) : cwd;

  // `worktree prune` affects every prunable worktree at once, so evaluate all of them.
  const targets = hit.all
    ? report.safe.filter((s) => !s.safe)
    : hit.cwdTarget
      ? [(await findWorkstream(report, assessedCwd, cwd)) ?? (await containingWorkstream(report, cwd))].filter(Boolean)
      : [await findWorkstream(report, hit.target, cwd)].filter(Boolean);

  // A sweep that reached here HAS something to take (the no-op case returned above), and the
  // report is consulted for ONE thing: the workstream's id, so the message can name it. Its
  // `safe` flag never enters the verdict — that flag is about deleting the worktree, and this
  // command cannot delete anything. A tree holt cannot place in a workstream still gets the
  // question asked; the evidence is the status, not the id.
  const holding = sweep
    ? (targets.length ? targets : [{ id: null }])
    // `safe` ANSWERS "IS THIS WORKTREE REMOVABLE", AND THIS LINE IS ASKING "WOULD THIS COMMAND
    // DESTROY CONTENT". For a linked worktree the two coincide — safe:true means provably
    // disposable, so nothing is lost either way. FOR THE MAIN WORKING TREE THEY DO NOT, and
    // conflating them made holt unusable in the layout almost every repository has.
    //
    // analyze.mjs sets safe:false for the primary unconditionally, and correctly: git itself
    // refuses `git worktree remove` there and .git lives inside it, so it is never removable. But
    // `git reset --hard` does not remove a worktree; it discards content. Reading removability as
    // "holds irreplaceable work" meant that in a single-clone repository — no linked worktrees,
    // the ordinary case — holt DENIED `git reset --hard`, `git clean -fdx`, `git checkout -- .`
    // and `git restore --worktree .` FOREVER. MEASURED on a byte-clean fresh clone with zero
    // dirty files: all four denied, while `git stash` on the same tree allowed, because the sweep
    // path asks the content question directly and never touches this flag.
    //
    // No repository state satisfied it and there was no escape hatch: .holtrc.json cannot make
    // holt less safe, and `holt discard` cannot help because the refusal names no file. The
    // message even contradicted itself — "would destroy work that exists nowhere else", then
    // "its files are reproducible from base" in the same breath. That is the hour-one uninstall.
    //
    // analyze.mjs already computes the right answer and carries it as `contentReproducible`
    // precisely so this question can be asked without reading removability. Ask it.
    : targets.filter((s) => (s.isPrimary ? s.contentReproducible === false : !s.safe));
  if (holding.length === 0) {
    return { decision: 'allow', reason: null, kind: hit.kind, targets: targets.map((t) => t.id) };
  }

  const unknown = sweep ? [] : holding.filter((s) => s.confidence === 'unknown');
  const detail = sweep
    ? describeSweep(sweep, targets[0]?.id ?? null)
    : holding.slice(0, 3).map((s) => {
      const u = report.unique.find((x) => x.id === s.id);
      const sample = u
        ? [...u.byLayer.uncommitted, ...u.byLayer.untracked, ...u.byLayer.committed]
          .slice(0, 3).map((x) => x.key).join(', ')
        : '';
      return `  • ${s.id}: ${s.reasons.join('; ')}${sample ? `\n      e.g. ${sample}` : ''}`;
    }).join('\n');

  // The one sentence a sweep's message needs and a deletion's does not: what the stash DID find
  // already queued. Pushing destroys no entry, so existing entries can never make this rule fire
  // — but "your work is now in the stash, alongside four older entries holding content no ref
  // holds" is what stops a pile from being silently forgotten, and forgetting is how a stash
  // loses work without anybody typing `drop`. Paid for only on the path that already asks.
  const queued = sweep ? await describeQueued(assessedCwd) : '';

  // A RULE THAT CAPPED ITS OWN VERDICT AT 'ask' NEVER ESCALATES TO 'deny', no matter how much is
  // at stake — the whole point of capping it here is that this action is recoverable (see the
  // stash rules above), so the worst honest answer is "confirm before you do this", not a
  // refusal. Same evidence as a deny, same per-workstream detail — a softer landing, not a
  // weaker check.
  if (hit.verdict === 'ask') {
    return {
      decision: 'ask',
      kind: hit.kind,
      targets: holding.map((h) => h.id).filter(Boolean),
      reason:
        (sweep
          // NAMES ONLY THE LAYERS THIS INVOCATION REACHES. Nothing committed appears here,
          // because nothing committed is at stake — see the block above assessStashEntries.
          ? `holt is asking before this: ${hit.kind}. It would take work out of `
            + `${holding.length} workstream(s) that no one else has been asked about:\n${detail}\n${queued}`
          : `holt is asking before this: ${hit.kind} would touch work that exists nowhere else, `
            + `across ${holding.length} workstream(s):\n${detail}\n`) +
        (unknown.length
          ? `  ${unknown.length} of these could not be scanned, so holt cannot confirm they are safe.\n`
          : '') +
        `${hit.recovery}\n` +
        'Run `holt risk` to inspect first, or confirm this is what you mean.',
    };
  }

  return {
    decision: 'deny',
    kind: hit.kind,
    targets: holding.map((h) => h.id).filter(Boolean),
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
/**
 * How many consecutive suppressions before an unchanged brief is repeated anyway.
 *
 * Pure change-triggering has one failure mode, and it is not hypothetical: a long agent session
 * gets its context compacted, the brief scrolls out, and because the repository state never
 * changed, holt stays silent forever about work it is actively protecting. The agent then
 * believes there is nothing to know. A periodic refresh costs one short paragraph and removes
 * that hole; the state has to be genuinely static for twenty prompts to earn one repeat.
 */
export const BRIEF_REFRESH_AFTER = 20;

/** Sibling of the report cache: what was last SAID, as opposed to what was last computed. */
function briefStatePath(root) {
  const key = createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16);
  return path.join(scratchDir(), `holt-brief-${key}.json`);
}

/**
 * Build the agent-facing brief.
 *
 * @param {string} cwd
 * @param {{ onlyIfChanged?: boolean, familyOverrides?: string[],
 *           maintenanceFloor?: number, maintenanceRatio?: number }} [opts]
 *   onlyIfChanged — return null when this exact brief was already emitted for this exact
 *   repository state. Wired to UserPromptSubmit, which fires on EVERY message: without it holt
 *   re-injected a byte-identical paragraph into the agent's context on every single turn, which
 *   is not a reminder, it is noise that teaches the reader to skip holt's output. SessionStart
 *   never passes it — a new session has seen nothing.
 *   familyOverrides / maintenanceFloor / maintenanceRatio — the project config surface
 *   (`.holtrc.json`, see src/config.mjs). Defaulted here so a caller that never loads config
 *   (or a repo with none) gets exactly the built-in behaviour.
 */
export async function buildBrief(cwd = process.cwd(), opts = {}) {
  let report;
  let scanned;
  let root = null;
  try {
    ({ report, scanned, root } = await cachedReport(cwd, { familyOverrides: opts.familyOverrides }));
  } catch {
    return null; // no repo, or unscannable: contribute nothing rather than noise
  }

  // Canonicalised: a raw path.resolve() comparison finds NOTHING on macOS and Windows, and the
  // brief then silently drops the sibling context that is the whole point of it — the agent is
  // told nothing rather than told something wrong, which is harder to notice.
  let here = null;
  for (const n of report.graph.nodes) {
    if (n.path && await underOrEqualAsync(cwd, n.path)) {
      if (!here || String(n.path).length > String(here.path).length) here = n; // deepest wins
    }
  }

  const lines = [];
  if (here) {
    const d = contextDigest(scanned, here.id);
    if (d.ok) {
      // THE "YOU ARE HERE" HEADER IS ORIENTATION, NOT NEWS, so it only earns its place when
      // there is news beside it. On a clean single-worktree repository it was the entire brief:
      // "You are working in workstream 'x' (family x, via primary-worktree)" — a sentence whose
      // whole content is the name of the directory the reader is already in — fired on every
      // Stop and every user message, forever. `whenNews` defers it until something else lands.
      const whenNews = lines.length;
      lines.push(`You are working in workstream '${d.workstream}' (family ${d.family}, via ${d.familyRule}).`);
      if (d.siblings.length) lines.push(`Siblings from the same dispatch: ${d.siblings.join(', ')}.`);
      for (const a of d.advice) lines.push(`- ${a}`);
      // Drop the header again if it turned out to be all there was.
      if (lines.length === whenNews + 1 && !d.duplicatedSymbols.length) lines.length = whenNews;
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

  // THE STASH, TOLD TO THE AGENT THAT WILL NEVER THINK TO LOOK.
  //
  // The line above says "N workstreams hold work existing ONLY as uncommitted changes". After a
  // sweep that number is zero and the brief simply omits the sentence — so an agent inheriting a
  // repository whose only unrecoverable work is stashed is told nothing at all, and the brief's
  // silence reads as "there is nothing here". That silence is what the guard cannot fix on its
  // own: the guard only speaks when someone types a stash verb, and forgetting never does.
  //
  // Bounded to entries that hold content no ref holds, so a stash everyone has already rescued
  // stops being mentioned the moment it stops mattering.
  const stashed = report.stash?.atRisk ?? [];
  if (stashed.length) {
    lines.push(
      `${stashed.length} stash entr(y/ies) hold content NO ref holds — no worktree shows this ` +
      `work and deleting a worktree will not lose it, but \`git stash drop\`/\`clear\` will: ` +
      `${stashed.slice(0, 3).map((e) => e.selector).join(', ')}. ` +
      '`git stash apply` then commit, or `holt rescue`, makes it reachable.',
    );
  }
  // LOUD BREAK: if holt stopped scanning at MAX_ENTRIES, entries beyond the cap were NOT checked
  // and might hold the only copy of real work. The brief must say so — an agent that sees "N
  // stash entries at risk" and does not know there are MORE is operating on incomplete evidence.
  if (report.stash?.truncated) {
    lines.push(
      `⚠ holt scanned only the first ${MAX_ENTRIES} stash entries — there are more. ` +
      'Review the remaining entries manually before dropping anything.',
    );
  }

  // MAINTENANCE PRESSURE — the half nobody was told about.
  //
  // holt already auto-PROTECTS at session start (`hook session-start --autoprotect`), so the
  // dangerous direction is covered without anyone asking. Nothing ever said the opposite thing:
  // that the repository is silting up. Disposable worktrees accumulate quietly — every one is a
  // checkout on disk, a branch in the list, and another row in every scan — and the moment anyone
  // notices is usually the moment someone starts deleting by hand, which is the exact behaviour
  // that loses work and the reason this product exists.
  //
  // So the accumulation is surfaced BEFORE it becomes a cleanup task, with the deterministic
  // command that resolves it. It is deliberately not an automatic deletion: `clean --apply` is
  // destructive, and a tool that silently deletes on a threshold nobody set is the opposite of
  // this product's promise. The user gets the signal and a one-line action.
  //
  // The threshold is a RATIO plus a floor, not a raw count. Ten disposable worktrees out of ten
  // is a repository that needs sweeping; ten out of two hundred is a busy Tuesday. The floor stops
  // a three-worktree repo nagging about one empty tree.
  const disposable = report.safe.filter((x) => x.safe).length;
  const total = report.counts.workstreams || 0;
  // `.holtrc.json` may override either number (src/config.mjs); an absent or partial config
  // falls back to the built-in floor/ratio exported below, one key at a time.
  const floor = opts.maintenanceFloor ?? MAINTENANCE_FLOOR;
  const ratio = opts.maintenanceRatio ?? MAINTENANCE_RATIO;
  if (disposable >= floor && disposable / Math.max(1, total) >= ratio) {
    lines.push(
      `MAINTENANCE: ${disposable} of ${total} workstream(s) are provably disposable — they hold ` +
      'nothing base lacks. `holt clean --apply` removes exactly those and nothing else, ' +
      're-verifying each one immediately before it goes.',
    );
  }

  if (lines.length === 0) return null;

  const text = `[holt — parallel workstream state]\n${lines.join('\n')}\n` +
    '(Before deleting ANY worktree run: holt gate <id> — exit 0 disposable, 1 holds unique work, 2 unknown.)';

  if (!opts.onlyIfChanged || !root) return text;

  // Suppression is keyed on the BRIEF TEXT, not on the repository fingerprint. The fingerprint
  // moves on every file save; the brief moves only when something a reader would act on moves.
  // Keying on the fingerprint would have suppressed almost nothing, which is the bug wearing the
  // fix's clothes.
  const digest = createHash('sha256').update(text).digest('hex').slice(0, 32);
  const statePath = briefStatePath(root);
  let prev = null;
  try { prev = JSON.parse(await fs.readFile(statePath, 'utf8')); } catch { /* first time */ }

  const repeats = prev?.digest === digest ? (prev.suppressed ?? 0) + 1 : 0;
  const suppress = repeats > 0 && repeats < BRIEF_REFRESH_AFTER;

  await fs.writeFile(statePath, JSON.stringify({
    version: 1, digest, suppressed: suppress ? repeats : 0,
  }), 'utf8').catch(() => { /* an unwritable state file must never break a hook */ });

  return suppress ? null : text;
}

/**
 * When accumulation becomes worth mentioning.
 *
 * Exported so the threshold is testable and visible rather than two magic numbers buried in a
 * string, and so a future config surface has one place to override.
 */
export const MAINTENANCE_FLOOR = 5;
export const MAINTENANCE_RATIO = 0.3;
