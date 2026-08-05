// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — git engine.
 *
 * SAFETY MODEL (this is a contract, enforced here and proven by test/unit/safety.test.mjs):
 *
 *   Tier SAFE          — touches nothing. Pure reads.
 *   Tier OBJECT_WRITE  — may write UNREFERENCED loose objects into .git/objects.
 *                        Exactly one command needs this: `merge-tree --write-tree`.
 *                        It never touches refs, index, working tree, config, stash or reflog.
 *                        Unreferenced objects are reclaimed by git's own gc.
 *   Everything else    — REFUSED. Not "discouraged", not "guarded". The command never runs.
 *
 * We do NOT claim "read-only" without qualification, because `merge-tree --write-tree` is
 * the only correct way to answer "what does main LACK from this branch". The three-dot
 * `git diff main...head` answers a DIFFERENT question — what the branch did since divergence —
 * and over-reports whenever main already acquired the content by another route (cherry-pick,
 * re-implementation, a parallel landing). Callers who need zero object writes can opt into
 * that weaker instrument explicitly via `strictReadOnly`, and it is labelled as approximate
 * everywhere it surfaces.
 *
 * No command is ever built by string interpolation. Every invocation is execFile with an
 * argv array, so a path containing spaces, quotes, globs or newlines cannot become two
 * arguments — and an empty variable cannot silently collapse into "no argument at all".
 */

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** git subcommands that touch nothing. */
const SAFE = new Set([
  // `version` reads nothing but the binary's own build string — it does not even open a repository.
  // It is on the list because catFileBatch() must know whether this git accepts NUL-delimited batch
  // input (`--batch -z`, git >= 2.38) before it can frame a spec containing a newline safely.
  'version',
  'rev-parse', 'rev-list', 'log', 'show', 'cat-file', 'ls-files', 'ls-tree',
  'check-attr',
  // `hash-object` WITHOUT `-w` computes an object id and writes nothing — the object database is
  // not opened for writing at all. It is the correct way to ask whether working-tree bytes equal
  // an index blob under Git's BUILTIN eol/ident/encoding conversion: measured on `text eol=crlf`,
  // a CRLF file whose index blob is LF hashes to the index oid here and a DIFFERENT oid under
  // `--no-filters`. Repository program filters are centrally suppressed and their attributed
  // paths are reported unmeasured before this comparison. Used by scan.mjs indexFlagDelta().
  // The write forms were already forbidden below — FORBIDDEN_SUBVERBS
  // refuses `-w` and `--stdin-paths`, and that check runs BEFORE this allowlist, so listing the
  // subcommand here cannot widen it to a write.
  'hash-object',
  'status', 'diff', 'diff-tree', 'diff-index', 'merge-base', 'name-rev',
  'worktree', 'branch', 'for-each-ref', 'show-ref', 'config', 'var', 'symbolic-ref',
  'describe', 'blame', 'shortlog', 'count-objects',
]);

/**
 * Subcommands whose READ form takes at most N positional arguments, and whose WRITE form is
 * distinguished ONLY by taking more. Caught by test/unit/safety.test.mjs, which found both of
 * these passing an earlier flag-only allowlist:
 *
 *   git symbolic-ref HEAD                  -> read  (1 positional)
 *   git symbolic-ref HEAD refs/heads/other -> REPOINTS HEAD  (2 positionals)
 *   git config user.name                   -> read  (1 positional)
 *   git config user.name mallory           -> WRITES CONFIG  (2 positionals)
 *   git branch                             -> list  (0 positionals)
 *   git branch newbranch                   -> CREATES A BRANCH  (1 positional)
 *
 * A flag-based allowlist cannot see this: there is no flag to forbid. Counting positionals is
 * the only thing that separates the two.
 */
const POSITIONAL_LIMITS = {
  'symbolic-ref': 1,
  config: 1,
  branch: 0,
};

/** Subcommands allowed to write unreferenced objects. */
const OBJECT_WRITE = new Set(['merge-tree']);

/**
 * Tier MUTATE — commands that genuinely change the repository.
 *
 * These are UNREACHABLE unless a reviewed caller passes `allowMutation: true`. Protective actions
 * use them for locks, captures, and quarantine; collision/verify code uses only unreferenced
 * objects, scratch indexes, and temporary worktrees. test/unit/safety.test.mjs proves a full scan
 * still leaves refs, real indexes, and working-tree bytes unchanged.
 *
 * The read-only guarantee is a core reason to trust holt, so adding write features must not
 * quietly widen the default. It does not: the default for every code path in the scanner remains
 * allowMutation:false, and a mutating command that forgets to opt in fails loudly rather than
 * silently succeeding.
 *
 * Each entry is here because a specific feature needs it, and nothing else is:
 *   worktree lock/unlock  -> `holt protect`  (git's own protection; defeats a single --force)
 *   worktree move/repair  -> `holt clean`    (recoverable quarantine; never physical deletion)
 *   commit-tree/hash-object/update-ref/write-tree/read-tree -> `holt rescue` (capture work)
 *   add with a scratch index -> collision snapshots (never the user's index)
 */
const MUTATE_SUBVERBS = {
  // `add` is here for `holt verify`, which materialises a SPECULATIVE MERGE into a scratch
  // worktree (outside the repo, removed afterwards) to run the user's tests against it. It is
  // still refused without the explicit opt-in, so the scanner can never create worktrees.
  worktree: new Set(['lock', 'unlock', 'remove', 'prune', 'add', 'move', 'repair']),
  branch: new Set(['-d', '-D', '--delete']),
};
const MUTATE_COMMANDS = new Set([
  'commit-tree', 'hash-object', 'update-ref', 'write-tree', 'read-tree', 'update-index', 'mktree',
  // `add` is only for worktreeSnapshot(), with GIT_INDEX_FILE pointed at a scratch index. If a
  // repository clean/process program would own the authored bytes, the central execution boundary
  // refuses it and collision analysis keeps the side unmeasured.
  'add',
]);

/**
 * Flags that turn an otherwise-safe subcommand into a mutating one.
 * `git worktree list` is a read; `git worktree add/remove/prune` is not.
 * `git config --get` is a read; `git config key value` is not.
 */
const FORBIDDEN_SUBVERBS = {
  worktree: new Set(['add', 'remove', 'prune', 'move', 'lock', 'unlock', 'repair']),
  branch: new Set(['-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy', '--set-upstream-to', '-u']),
  config: new Set(['--unset', '--unset-all', '--add', '--replace-all', '--edit', '-e', '--rename-section', '--remove-section']),
  'hash-object': new Set(['-w', '--stdin-paths']),
  diff: new Set(['--ext-diff', '--textconv']),
  'diff-tree': new Set(['--ext-diff', '--textconv']),
  'diff-index': new Set(['--ext-diff', '--textconv']),
  log: new Set(['--ext-diff', '--textconv']),
  show: new Set(['--ext-diff', '--textconv']),
  // Both forms feed object bytes through repository-configured programs. catFileBatch uses the
  // raw batch protocol and never needs either conversion mode.
  'cat-file': new Set(['--filters', '--textconv']),
};

/** Global flags that can redirect git at another repo or escalate it. Never allowed from callers. */
const FORBIDDEN_GLOBAL = new Set(['--exec-path', '-c', '--config-env', '--namespace', '--work-tree', '--git-dir']);

/**
 * Subcommands that rewrite working-tree or history state. Refused unconditionally, BEFORE any
 * allow-logic, as a structurally independent first gate — no opt-in reaches them, including
 * `allowMutation`. Two gates exist on purpose: mutation testing proved that when the final
 * allowlist fallthrough alone stood between "classified refused" and "actually executed", a
 * single-line defect opened everything at once — and a test that asserted refusal by executing
 * then ran `git reset --hard` for real (2026-07-31). Refusals from this gate carry
 * `gate: 'destructive'` so tests can prove WHICH layer refused, making a defect in either gate
 * independently detectable.
 */
const DESTRUCTIVE_ALWAYS = new Set([
  'reset', 'checkout', 'restore', 'switch', 'stash', 'clean', 'push', 'rebase', 'merge',
  'pull', 'cherry-pick', 'revert', 'am', 'gc', 'reflog', 'filter-branch', 'replace', 'rm',
]);

export class GitRefused extends Error {
  constructor(msg, { unmeasured = false } = {}) {
    super(msg);
    this.name = 'GitRefused';
    this.refused = true;
    this.unmeasured = unmeasured;
  }
}

export class GitFailed extends Error {
  /**
   * @param {string} msg
   * @param {{ code?: number, stderr?: string, argv?: string[] }} [info]
   */
  constructor(msg, { code, stderr, argv } = {}) {
    super(msg);
    this.name = 'GitFailed';
    this.code = code;
    this.stderr = stderr;
    this.argv = argv;
  }
}

/**
 * Decide whether an argv is permitted. Exported so the safety test can assert on it
 * directly without spawning processes.
 *
 * @returns {{allowed: boolean, tier?: 'SAFE'|'OBJECT_WRITE'|'MUTATE', reason?: string, gate?: string}}
 */
export function classify(argv, { allowMutation = false } = {}) {
  if (!Array.isArray(argv) || argv.length === 0) {
    return { allowed: false, reason: 'empty argv' };
  }
  for (const a of argv) {
    if (typeof a !== 'string') return { allowed: false, reason: `non-string argument: ${String(a)}` };
  }

  // Reject repo-redirecting / escalating global flags before the subcommand.
  let i = 0;
  while (i < argv.length && argv[i].startsWith('-')) {
    const flag = argv[i].split('=')[0];
    if (FORBIDDEN_GLOBAL.has(flag)) {
      return { allowed: false, reason: `global flag not permitted: ${flag}` };
    }
    i++;
  }
  const sub = argv[i];
  if (!sub) return { allowed: false, reason: 'no subcommand' };

  const rest = argv.slice(i + 1);

  // First gate: destructive subcommands are refused before any allow-logic runs, and no
  // option — not even allowMutation — is consulted. See DESTRUCTIVE_ALWAYS.
  if (DESTRUCTIVE_ALWAYS.has(sub)) {
    return {
      allowed: false, gate: 'destructive',
      reason: `'git ${sub}' rewrites working-tree or history state; holt never runs it (no opt-in exists)`,
    };
  }

  // MUTATE tier — only reachable with an explicit opt-in from a mutating holt command.
  if (allowMutation) {
    if (MUTATE_COMMANDS.has(sub)) return { allowed: true, tier: 'MUTATE' };
    const mutable = MUTATE_SUBVERBS[sub];
    if (mutable && rest.some((t) => mutable.has(t.split('=')[0]))) {
      return { allowed: true, tier: 'MUTATE' };
    }
  }

  const forbidden = FORBIDDEN_SUBVERBS[sub];
  if (forbidden) {
    for (const token of rest) {
      const bare = token.split('=')[0];
      if (forbidden.has(bare)) {
        return {
          allowed: false,
          reason: `'git ${sub} ${bare}' mutates the repository`
            + (MUTATE_SUBVERBS[sub]?.has(bare) ? ' (needs an explicit mutating holt command)' : ''),
        };
      }
    }
  }

  // Positional-count check — the only way to tell `config <key>` from `config <key> <value>`.
  const limit = POSITIONAL_LIMITS[sub];
  if (limit !== undefined) {
    let positionals = 0;
    let afterDoubleDash = false;
    for (const token of rest) {
      if (token === '--') { afterDoubleDash = true; continue; }
      if (!afterDoubleDash && token.startsWith('-')) continue;
      positionals++;
    }
    if (positionals > limit) {
      return {
        allowed: false,
        reason: `'git ${sub}' with ${positionals} positional argument(s) is a WRITE form (read form takes at most ${limit})`,
      };
    }
  }

  if (OBJECT_WRITE.has(sub)) return { allowed: true, tier: 'OBJECT_WRITE' };
  if (SAFE.has(sub)) return { allowed: true, tier: 'SAFE' };
  return { allowed: false, reason: `'git ${sub}' is not on holt's allowlist` };
}

export const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

/* ==========================================================================================
 * THE PROCESS ENVIRONMENT IS AN INPUT TO GIT, NOT BACKGROUND NOISE.
 *
 * Git gives environment variables authority over its repository, object database, config
 * stack, helper programs, output file descriptors and network protocols. Inherited wholesale,
 * these can make a correctly-classified argv answer a different question (`GIT_DIR`,
 * `GIT_OBJECT_DIRECTORY`), execute a program (`GIT_EXTERNAL_DIFF`, `GIT_ASKPASS`), append to an
 * arbitrary file (`GIT_TRACE*`) or silently omit work (a lying `core.fsmonitor`). That is the
 * same class of authority as a caller-supplied `--git-dir`, only hidden outside argv.
 *
 * One builder owns the boundary for BOTH execFile() and the long-lived cat-file spawn. It admits
 * only the OS bootstrap, user-config and scratch-directory variables Git needs across supported
 * platforms. Unrelated credentials, loader controls and application state never cross merely
 * because they happened to be ambient. Only the few GIT_* variables created deliberately by
 * Holt for a scratch index/worktree or a rescue identity can cross back in. Repository
 * alternates in `.git/objects/info/alternates` remain visible; only ambient ODB redirection is
 * removed.
 * ========================================================================================== */

const INTENTIONAL_GIT_ENV = new Set([
  'GIT_INDEX_FILE', 'GIT_WORK_TREE',
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE',
]);

const FORCED_GIT_ENV = Object.freeze({
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_PAGER: 'cat',
  // Git 2.45 documents this as equivalent to --no-lazy-fetch. The capability probe below proves
  // the selected executable supports that contract before any repository command is spawned.
  GIT_NO_LAZY_FETCH: '1',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_PROTOCOL_FROM_USER: '0',
  GIT_ALLOW_PROTOCOL: '',
  GIT_REF_PARANOIA: '1',
  GIT_COMMIT_GRAPH_PARANOIA: '1',
  LC_ALL: 'C',
});

/**
 * Build the only environment a Holt-owned Git process may receive.
 *
 * @param {Record<string, string|undefined>} [intentional]
 * @returns {Record<string,string>}
 */
export function buildGitEnv(intentional = {}) {
  // Keep this list explicit. A computed process.env lookup would make the capability unknowable,
  // while copying process.env wholesale would hand unrelated secrets and NODE_OPTIONS/LD_*
  // execution controls to every Holt-owned Git process.
  const osInputs = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_CONFIG_DIRS: process.env.XDG_CONFIG_DIRS,
    TMPDIR: process.env.TMPDIR,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
    PATHEXT: process.env.PATHEXT,
    SYSTEMROOT: process.env.SYSTEMROOT,
    WINDIR: process.env.WINDIR,
    COMSPEC: process.env.COMSPEC,
    USERPROFILE: process.env.USERPROFILE,
    HOMEDRIVE: process.env.HOMEDRIVE,
    HOMEPATH: process.env.HOMEPATH,
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
  };
  /** @type {Record<string,string>} */
  const clean = {};
  for (const [key, value] of Object.entries(osInputs)) {
    if (typeof value === 'string') clean[key] = value;
  }

  // Deliberately do not spread `intentional`: a new call-site variable gets no authority until
  // this central allowlist is reviewed. On Windows environment keys are case-insensitive, so only
  // the canonical uppercase spelling is admitted.
  for (const key of INTENTIONAL_GIT_ENV) {
    const value = intentional[key];
    if (typeof value === 'string') clean[key] = value;
  }
  return addHardenedConfig(Object.assign(clean, FORCED_GIT_ENV));
}

/** Git 2.45 (2024-04-29) introduced --no-lazy-fetch / GIT_NO_LAZY_FETCH. */
export const NO_LAZY_FETCH_MIN_GIT = Object.freeze({ major: 2, minor: 45 });

/**
 * Whether a `git version ...` line names a Git that can make local object reads non-networking.
 * Unparseable versions fail closed.
 */
export function noLazyFetchSupported(versionLine) {
  const m = /(?:^|\s)(\d+)\.(\d+)/.exec(String(versionLine ?? ''));
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > NO_LAZY_FETCH_MIN_GIT.major
    || (major === NO_LAZY_FETCH_MIN_GIT.major && minor >= NO_LAZY_FETCH_MIN_GIT.minor);
}

// `/dev/null` is intentional even on Windows: Git for Windows is an MSYS program and understands
// this spelling, whereas Node's os.devNull (`\\.\NUL`) is not a valid Git path there.
export const INERT_GIT_HOOKS_PATH = '/dev/null';

const HARDENED_GIT_CONFIG = Object.freeze([
  ['core.fsmonitor', 'false'],
  ['core.hooksPath', INERT_GIT_HOOKS_PATH],
  ['log.showSignature', 'false'],
  ['commit.gpgSign', 'false'],
  ['core.pager', 'cat'],
  ['core.askPass', ''],
  // A merge with renormalisation enabled runs the check-in conversion pipeline for all three
  // stages. That pipeline includes repository-configured clean/process filters. Holt never needs
  // renormalisation for its evidence merge, and leaving the user's setting active would turn a
  // supposedly local inspection into arbitrary program execution.
  ['merge.renormalize', 'false'],
  ['protocol.allow', 'never'],
  ['protocol.ext.allow', 'never'],
  ['protocol.file.allow', 'never'],
  ['protocol.git.allow', 'never'],
  ['protocol.http.allow', 'never'],
  ['protocol.https.allow', 'never'],
  ['protocol.ssh.allow', 'never'],
]);

function addHardenedConfig(env) {
  env.GIT_CONFIG_COUNT = String(HARDENED_GIT_CONFIG.length);
  for (let i = 0; i < HARDENED_GIT_CONFIG.length; i++) {
    env[`GIT_CONFIG_KEY_${i}`] = HARDENED_GIT_CONFIG[i][0];
    env[`GIT_CONFIG_VALUE_${i}`] = HARDENED_GIT_CONFIG[i][1];
  }
  return env;
}

/* ==========================================================================================
 * REPOSITORY CONFIG IS ALSO AN EXECUTION ENVIRONMENT.
 *
 * `filter.<driver>.clean`, `.smudge` and `.process` are shell commands. They can be supplied by
 * repository, worktree, global, system or included config and Git may start them while answering
 * an apparently read-only `status`, worktree `diff`, or filtered `hash-object`. Capture commands
 * (`add`, `worktree add`) can start them too. argv classification and ambient-environment
 * scrubbing do not touch that authority.
 *
 * Git has no wildcard "disable all filters" switch. Before one of the small set of commands that
 * can enter the conversion pipeline, Holt reads the effective program-key NAMES with the inert
 * `git config --name-only` builtin, then appends command-scope empty values for every discovered
 * filter driver. Git's own convert.c only invokes a driver when the selected command string is
 * non-empty; the later command-scope values therefore preserve builtin text/eol/ident conversion
 * but make every external filter a no-op. `required=false` is paired with them so a configured
 * required driver fails into passthrough instead of turning the instrument into an opaque Git
 * error.
 *
 * A custom `merge.<name>.driver` is different: suppressing it changes the synthetic merge's
 * semantics, so there is no truthful replacement answer. `merge-tree` fails closed before it can
 * start that program and the scanner labels the committed delta unmeasured. This is intentionally
 * broader than checking whether today's files carry `merge=<name>`: deciding applicability is
 * itself part of the merge instrument whose result is not trusted under external program control.
 *
 * Values are deliberately never returned or interpolated: the attacker-controlled command text
 * remains data inside Git's config parser and never reaches a shell owned by Holt.
 * ========================================================================================== */

const EXTERNAL_CONVERSION_CONFIG_RE =
  '^(filter\\..*\\.(clean|smudge|process|required)|merge\\..*\\.driver)$';

function commandMayConvert(argv) {
  const subAt = subcommandIndex(argv);
  const sub = argv[subAt];
  const rest = argv.slice(subAt + 1);
  if (sub === 'status' || sub === 'add' || sub === 'diff') return true;
  if (sub === 'diff-index') return !rest.includes('--cached');
  if (sub === 'hash-object') return !rest.includes('--no-filters');
  if (sub === 'merge-tree') return true;
  if (sub === 'worktree') return rest.some((arg) => arg.split('=')[0] === 'add');
  if (sub === 'read-tree') return commandMaterializesWorkingTree(argv);
  if (sub === 'update-index') {
    // These are the only object-only forms Holt uses. Presence of one safe-looking flag is not
    // enough: update-index accepts options and ordinary file paths in the same invocation.
    if (rest.length >= 3 && rest[0] === '--force-remove' && rest[1] === '--') return false;
    if (rest.length === 2 && rest[0] === '--cacheinfo') return false;
    if (rest.length === 3 && rest[0] === '--add' && rest[1] === '--cacheinfo') return false;
    if (rest.length === 1 && rest[0] === '--index-info') return false;
    return true;
  }
  return false;
}

function appendConfigPairs(env, pairs) {
  let count = Number(env.GIT_CONFIG_COUNT ?? 0);
  for (const [key, value] of pairs) {
    env[`GIT_CONFIG_KEY_${count}`] = key;
    env[`GIT_CONFIG_VALUE_${count}`] = value;
    count++;
  }
  env.GIT_CONFIG_COUNT = String(count);
  return env;
}

function externalConversionPrograms(configOutput) {
  const filterPrefixes = new Set();
  const checkinFilterPrefixes = new Set();
  const checkinFilterKeys = new Set();
  const checkoutFilterPrefixes = new Set();
  const checkoutFilterKeys = new Set();
  const mergeDriverKeys = new Set();
  for (const record of String(configOutput ?? '').split('\0')) {
    if (!record) continue;
    const key = record.trim();
    const match = /^(filter\..+)\.(clean|smudge|process|required)$/i.exec(key);
    if (match && match[2].toLowerCase() !== 'required') {
      filterPrefixes.add(match[1]);
      if (match[2].toLowerCase() !== 'smudge') {
        checkinFilterPrefixes.add(match[1]);
        checkinFilterKeys.add(key);
      }
      if (match[2].toLowerCase() !== 'clean') {
        checkoutFilterPrefixes.add(match[1]);
        checkoutFilterKeys.add(key);
      }
    }
    else if (/^merge\..+\.driver$/i.test(key)) mergeDriverKeys.add(key);
  }
  return {
    filterPrefixes: [...filterPrefixes].sort(),
    checkinFilterPrefixes: [...checkinFilterPrefixes].sort(),
    checkinFilterKeys: [...checkinFilterKeys].sort(),
    checkoutFilterPrefixes: [...checkoutFilterPrefixes].sort(),
    checkoutFilterKeys: [...checkoutFilterKeys].sort(),
    mergeDriverKeys: [...mergeDriverKeys].sort(),
  };
}

function commandMaterializesWorkingTree(argv) {
  const subAt = subcommandIndex(argv);
  const sub = argv[subAt];
  const rest = argv.slice(subAt + 1);
  if (sub === 'worktree') {
    return rest.some((arg) => arg.split('=')[0] === 'add')
      && !rest.some((arg) => arg.split('=')[0] === '--no-checkout');
  }
  if (sub === 'read-tree') {
    return rest.some((arg) => arg === '-u' || (/^-[^-]*u/.test(arg) && arg.length > 2));
  }
  return false;
}

function commandAuthorsConvertedContent(argv) {
  const sub = argv[subcommandIndex(argv)];
  return sub === 'add' || sub === 'update-index';
}

async function effectiveExternalConversionPrograms(cwd, env, timeout) {
  return new Promise((resolve, reject) => {
    execFile('git', [
      'config', '--null', '--name-only', '--get-regexp', EXTERNAL_CONVERSION_CONFIG_RE,
    ], {
      cwd, timeout, maxBuffer: 8 * 1024 * 1024, env,
    }, (error, stdout, stderr) => {
      // `git config --get-regexp` uses 1 for "no matches". That is a measured empty answer.
      if (error && error.code !== 1) {
        reject(new GitFailed(
          `could not enumerate repository conversion programs before running Git: ${error.message}`,
          {
            code: typeof error.code === 'number' ? error.code : undefined,
            stderr: String(stderr ?? ''),
            argv: ['config', '--get-regexp', EXTERNAL_CONVERSION_CONFIG_RE],
          },
        ));
        return;
      }
      resolve(externalConversionPrograms(stdout));
    });
  });
}

async function buildGitCommandContext(argv, cwd, intentional, timeout = DEFAULT_TIMEOUT_MS) {
  const env = buildGitEnv(intentional);
  if (!commandMayConvert(argv)) {
    return {
      env,
      programs: {
        filterPrefixes: [], checkinFilterPrefixes: [], checkinFilterKeys: [],
        checkoutFilterPrefixes: [],
        checkoutFilterKeys: [], mergeDriverKeys: [],
      },
    };
  }
  const programs = await effectiveExternalConversionPrograms(cwd, env, timeout);
  if (commandAuthorsConvertedContent(argv) && programs.checkinFilterKeys.length > 0) {
    const named = programs.checkinFilterKeys.slice(0, 5).join(', ');
    const more = programs.checkinFilterKeys.length > 5
      ? ` (and ${programs.checkinFilterKeys.length - 5} more)` : '';
    throw new GitRefused(
      'holt refused to author converted content: repository-configured external check-in '
      + `filter program(s) ${named}${more} were not executed; authored object bytes are unmeasured`,
      { unmeasured: true },
    );
  }
  if (commandMaterializesWorkingTree(argv) && programs.checkoutFilterKeys.length > 0) {
    const named = programs.checkoutFilterKeys.slice(0, 5).join(', ');
    const more = programs.checkoutFilterKeys.length > 5
      ? ` (and ${programs.checkoutFilterKeys.length - 5} more)` : '';
    throw new GitRefused(
      'holt refused to materialize a working tree: repository-configured external checkout '
      + `filter program(s) ${named}${more} were not executed; checkout bytes are unmeasured`,
      { unmeasured: true },
    );
  }
  if (argv[subcommandIndex(argv)] === 'merge-tree' && programs.mergeDriverKeys.length > 0) {
    const named = programs.mergeDriverKeys.slice(0, 5).join(', ');
    const more = programs.mergeDriverKeys.length > 5
      ? ` (and ${programs.mergeDriverKeys.length - 5} more)` : '';
    throw new GitRefused(
      'holt refused `git merge-tree`: repository-configured external merge program(s) '
      + `${named}${more} were not executed; the synthetic merge result is unmeasured`,
      { unmeasured: true },
    );
  }
  const overrides = [];
  for (const prefix of programs.filterPrefixes) {
    overrides.push(
      [`${prefix}.clean`, ''],
      [`${prefix}.smudge`, ''],
      [`${prefix}.process`, ''],
      [`${prefix}.required`, 'false'],
    );
  }
  return { env: appendConfigPairs(env, overrides), programs };
}

export async function buildGitCommandEnv(argv, cwd, intentional, timeout = DEFAULT_TIMEOUT_MS) {
  return (await buildGitCommandContext(argv, cwd, intentional, timeout)).env;
}

// These commands emit machine evidence, never a human presentation. External diff and textconv
// programs can both fabricate that evidence; explicit negative flags override repo/global config.
const MACHINE_DIFF_COMMANDS = new Set(['diff', 'diff-tree', 'diff-index', 'log', 'show']);

function subcommandIndex(argv) {
  let i = 0;
  while (i < argv.length && argv[i].startsWith('-')) i++;
  return i;
}

/**
 * Add controls owned by Holt after classification. Callers cannot smuggle these through classify:
 * the public argv is classified first; this function only narrows what that approved command does.
 */
export function hardenGitArgv(argv) {
  const subAt = subcommandIndex(argv);
  const sub = argv[subAt];
  const command = [...argv];
  // The capability probe reads only the Git executable's own version string. Keeping its argv
  // primitive is what lets even very old Git run far enough for the explicit 2.45 refusal below.
  if (sub === 'version') return command;
  if (MACHINE_DIFF_COMMANDS.has(sub)) {
    command.splice(subAt + 1, 0, '--no-ext-diff', '--no-textconv');
  }

  return command;
}

/** @type {Map<string, Promise<string>>} */
const noLazyFetchProbes = new Map();

function gitExecutableKey(env) {
  const value = (name) => {
    const found = Object.keys(env).find((key) => key.toUpperCase() === name);
    return found ? env[found] : '';
  };
  return `${value('PATH')}\0${value('PATHEXT')}`;
}

async function requireNoLazyFetch(env) {
  const key = gitExecutableKey(env);
  let probe = noLazyFetchProbes.get(key);
  if (!probe) {
    probe = new Promise((resolve, reject) => {
      execFile('git', ['version'], {
        timeout: 10_000, maxBuffer: 1024 * 1024, env,
      }, (err, stdout, stderr) => {
        if (err) {
          reject(new GitFailed(`git version probe failed: ${err.message}`, {
            code: typeof err.code === 'number' ? err.code : undefined,
            stderr: String(stderr ?? ''), argv: ['version'],
          }));
          return;
        }
        const version = String(stdout ?? '').trim();
        if (!noLazyFetchSupported(version)) {
          resolve(version);
          return;
        }
        // A vendor build can carry a modern-looking version while omitting a feature. Probe the
        // actual option once; real commands use the equivalent environment variable so their
        // subcommand remains argv[0] for wrappers and instrumentation.
        execFile('git', ['--no-lazy-fetch', 'version'], {
          timeout: 10_000, maxBuffer: 1024 * 1024, env,
        }, (capabilityError, _capabilityStdout, capabilityStderr) => {
          if (capabilityError) {
            reject(new GitFailed(
              'holt requires a Git binary that implements --no-lazy-fetch (Git 2.45 or newer)',
              {
                code: typeof capabilityError.code === 'number' ? capabilityError.code : undefined,
                stderr: String(capabilityStderr ?? ''), argv: ['--no-lazy-fetch', 'version'],
              },
            ));
            return;
          }
          resolve(version);
        });
      });
    });
    noLazyFetchProbes.set(key, probe);
  }

  let version;
  try {
    version = await probe;
  } catch (error) {
    noLazyFetchProbes.delete(key);
    throw error;
  }
  if (!noLazyFetchSupported(version)) {
    throw new GitFailed(
      `holt requires Git 2.45 or newer for repository operations (found ${version || 'an unparseable version'}): `
      + 'older Git cannot disable lazy fetching, so a local evidence read could contact a promisor remote',
      { argv: ['version'] },
    );
  }
  return version;
}

/** Test seam for PATH-shim compatibility probes. */
export function _resetGitCapabilityProbe() { noLazyFetchProbes.clear(); }

/**
 * NETWORK FILESYSTEM TIMEOUT ESCALATION.
 *
 * holt's timeouts assume local-disk latency. On NFS/SMB a `git status` that takes 30s locally
 * can take minutes, and the default ceiling reads as "instrument failed" — fail-closed
 * classification then refuses to scan, which is the right safety call but the wrong user
 * experience: the repository is fine, only the mount is slow. When a network filesystem is
 * detected (src/paths.mjs), the timeout is multiplied so a slow link does not become a false
 * instrument failure.
 *
 * The multiplier is deliberately conservative: 3x local-disk time, capped at 180s, so a
 * genuinely hung process still fails rather than hanging the scan indefinitely. A network
 * mount that needs more than 3 minutes for a single git read has a problem holt cannot solve.
 */
export const NETWORK_FS_TIMEOUT_MULTIPLIER = 3;
export const NETWORK_FS_TIMEOUT_CEILING_MS = 180_000;

/**
 * Resolve the effective timeout for operations against `cwd`.
 *
 * If `cwd` is on a detected network filesystem and no explicit timeout was given, the default
 * is escalated (multiplied, capped) so a slow link does not produce a false instrument
 * failure. An explicit `timeout` is always honoured as-is — the caller knows their latency.
 *
 * Returns `{ timeout, network: boolean, warning?: string }`. The warning is present when the
 * timeout was escalated, so the scan/CLI can surface it rather than silently changing behaviour.
 *
 * @param {string} cwd
 * @param {number} [timeout]  explicit timeout; when omitted, the default (possibly escalated) is used
 */
export async function resolveTimeout(cwd, timeout) {
  if (timeout !== undefined && timeout !== null) return { timeout, network: false };
  const { detectNetworkFilesystem, networkFilesystemWarning } = await import('./paths.mjs');
  /** @type {{network: boolean, type?: string, mountPoint?: string, reason?: string}} */
  const info = await detectNetworkFilesystem(cwd).catch(() => ({ network: false }));
  if (!info.network) return { timeout: DEFAULT_TIMEOUT_MS, network: false };
  const escalated = Math.min(DEFAULT_TIMEOUT_MS * NETWORK_FS_TIMEOUT_MULTIPLIER, NETWORK_FS_TIMEOUT_CEILING_MS);
  return { timeout: escalated, network: true, warning: networkFilesystemWarning(info) };
}

/**
 * Run git. Rejects on refusal; resolves {stdout, stderr, code} otherwise.
 * Non-zero exit is NOT automatically an error — many git reads use exit codes as answers
 * (merge-tree returns 1 on conflict, diff --quiet returns 1 on difference). Callers decide.
 *
 * The options are typed explicitly because `cwd` and `env` carry no defaults: without this,
 * inference builds the option type from the destructuring alone, omits both, and every caller
 * that passes `{ cwd }` — which is nearly all of them — reports "'cwd' does not exist in type".
 *
 * @param {string[]} argv
 * @param {{ cwd?: string, timeout?: number, allowObjectWrite?: boolean,
 *           allowMutation?: boolean, env?: Record<string, string|undefined> }} [opts]
 */
export async function git(argv, {
  cwd, timeout = DEFAULT_TIMEOUT_MS, allowObjectWrite = true, allowMutation = false, env,
} = {}) {
  const verdict = classify(argv, { allowMutation });
  if (!verdict.allowed) {
    return Promise.reject(new GitRefused(`holt refused to run \`git ${argv.join(' ')}\`: ${verdict.reason}`));
  }
  if (verdict.tier === 'OBJECT_WRITE' && !allowObjectWrite) {
    return Promise.reject(
      new GitRefused(
        `holt refused \`git ${argv[0]}\`: it writes unreferenced objects and strictReadOnly is set`,
      ),
    );
  }

  const commandContext = await buildGitCommandContext(argv, cwd, env, timeout);
  const childEnv = commandContext.env;
  if (argv[subcommandIndex(argv)] !== 'version') await requireNoLazyFetch(childEnv);
  const childArgv = hardenGitArgv(argv);

  return new Promise((resolve, reject) => {
    execFile(
      'git',
      childArgv,
      {
        cwd,
        timeout,
        maxBuffer: DEFAULT_MAX_BUFFER,
        env: childEnv,
      },
      (err, stdout, stderr) => {
        if (err && err.killed) {
          reject(new GitFailed(`git ${argv[0]} timed out after ${timeout}ms`, { argv, stderr }));
          return;
        }
        if (err && typeof err.code !== 'number') {
          reject(new GitFailed(`git ${argv[0]} failed to spawn: ${err.message}`, { argv, stderr }));
          return;
        }
        resolve({
          stdout: stdout ?? '', stderr: stderr ?? '', code: err ? err.code : 0,
          externalCheckinFilterDrivers: commandContext.programs.checkinFilterPrefixes.map(
            (prefix) => prefix.slice('filter.'.length)),
        });
      },
    );
  });
}

/* ==========================================================================================
 * THE ARGUMENT LIST HAS A CEILING, AND A PER-PATH ARGV REACHES IT IN AN ORDINARY REPOSITORY.
 *
 * `execve(2)` fails with E2BIG once argv+envp exceeds the kernel's limit — on Linux
 * `getconf ARG_MAX` is 2,097,152 bytes. holt built several argv lists with ONE ENTRY PER
 * REPOSITORY PATH, so the ceiling is crossed at roughly `ARG_MAX / average-path-length` files.
 * MEASURED, on an ordinary monorepo sparse checkout (40,000 paths outside the cone, 65-char
 * average path, argv 2,600,000 bytes): `git ls-files -s -z -- <40,000 paths>` failed with
 * `spawn E2BIG`, and because the guard is fail-closed on an instrument that failed, the
 * worktree became permanently unclassifiable — `rm -rf dist` went from allow to exit 2, on
 * every invocation, for as long as the checkout stayed sparse. Not recoverable by the developer.
 *
 * It is a CLASS, not that one call: `git diff --raw … -- <files>`, `git rev-list … -- <paths>`,
 * `git add --all --force -- <paths>` and `git hash-object -- <paths>` are all built the same way
 * and all cross the same ceiling. So the ceiling is enforced in ONE place, here, and every
 * per-path spawn goes through it. A call site cannot opt out by forgetting.
 *
 * THE BUDGET IS THE ONE GNU xargs USES, for the same reason it uses it. findutils' documented
 * default is "ARG_MAX - 2k, or 128k, whichever is smaller"
 * (https://www.gnu.org/software/findutils/manual/html_node/find_html/Limiting-Command-Size.html)
 * — the 128 KiB cap is deliberately far below the kernel limit so that a large environment, a
 * long interpreter path or a different kernel cannot eat the headroom. On Windows the limit is
 * not ARG_MAX at all: CreateProcess documents `lpCommandLine` as at most 32,767 characters
 * including the terminating null
 * (https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw),
 * and node spawns git directly rather than through cmd.exe, so that is the number that binds.
 * ========================================================================================== */

/** Bytes of PATH ARGUMENTS one spawn may carry. Per-platform, deliberately far below the limit. */
export const ARGV_BYTE_BUDGET = process.platform === 'win32' ? 24_000 : 128 * 1024;

/**
 * Split `paths` into groups whose argv byte cost fits the budget.
 *
 * A single path longer than the whole budget still gets its own group — splitting a path is not
 * an option, and one over-long path is the kernel's problem to report, not a reason to silently
 * drop it. Byte cost is measured in UTF-8, because that is what `execve` counts, and a path of
 * CJK or emoji characters costs three to four bytes per character rather than one.
 *
 * @param {string[]} paths
 * @param {number} [budget]
 * @param {number} [prefixBytes]  argv the caller adds before the paths (`ls-files -s -z --`)
 * @returns {string[][]} never empty when `paths` is non-empty
 */
export function chunkByArgvBytes(paths, budget = ARGV_BYTE_BUDGET, prefixBytes = 0) {
  const room = Math.max(1024, budget - prefixBytes);
  const out = [];
  let cur = [];
  let bytes = 0;
  for (const p of paths) {
    const cost = Buffer.byteLength(p, 'utf8') + 1;   // +1: execve counts the NUL terminator
    if (cur.length && bytes + cost > room) { out.push(cur); cur = []; bytes = 0; }
    cur.push(p);
    bytes += cost;
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * `git <prefix…> <paths…>`, split across as many spawns as the argument-list ceiling requires.
 *
 * Only for commands whose answer over a path list is the UNION of its answers over any partition
 * of that list — `ls-files -s`, `hash-object`, `diff --raw`, `rev-list --objects`, `add`. That is
 * a property of the caller's command, not of this helper, so each call site states it.
 *
 * FAILURE IS NOT AVERAGED. The first batch that exits non-zero ends the walk and its code and
 * stderr are returned, because a partial answer read as a whole answer is exactly the
 * "absence of evidence" fault this codebase keeps re-learning. `batches` is reported so a caller
 * (and a test) can see whether chunking happened at all.
 *
 * @returns {Promise<{stdout:string, stderr:string, code:number, batches:number}>}
 */
export async function gitPathBatched(prefix, paths, opts = {}) {
  const prefixBytes = prefix.reduce((n, a) => n + Buffer.byteLength(a, 'utf8') + 1, 0);
  const groups = chunkByArgvBytes(paths, opts.argvBudget ?? ARGV_BYTE_BUDGET, prefixBytes);
  let stdout = '';
  let stderr = '';
  let batches = 0;
  for (const group of groups) {
    batches++;
    // `git()` rejects rather than resolves when the binary cannot be spawned at all, and E2BIG
    // arrives on that path — so it is caught here and shaped like any other failure, never
    // allowed to escape as an exception into a caller that is holding a fail-closed contract.
    const r = await git([...prefix, ...group], opts)
      .catch((error) => ({ code: -1, stdout: '', stderr: error?.message ?? String(error) }));
    stdout += r.stdout;
    stderr += r.stderr;
    if (r.code !== 0) return { stdout, stderr, code: r.code, batches };
  }
  return { stdout, stderr, code: 0, batches };
}

/**
 * `git cat-file --batch -z` — NUL-delimited batch INPUT — landed in git 2.38 (2022-10).
 * Below that, holt cannot frame a spec containing a newline at all and says so (see catFileBatch).
 * Verified against the official git documentation: the 2.32.0 manpage does not list `-z`, while
 * the 2.38.0 manpage does. The previous claim of 2.32 was wrong — on a 2.32–2.37 git, the probe
 * would report support (because the option is accepted without error on some builds) but the
 * framing would be newline-delimited, silently mis-attributing records for newline-bearing paths.
 */
const BATCH_NUL_MIN = { major: 2, minor: 38 };

/**
 * Parse the first `<major>.<minor>` out of a `git version …` line and answer whether that git
 * accepts NUL-delimited batch input.
 *
 * Exported because it is the whole load-bearing decision behind whether a repository containing a
 * newline-named file is read correctly or refused, and a decision that important gets asserted
 * directly rather than only through a live git. Every real-world shape is covered by the leading
 * `<num>.<num>`: `git version 2.55.0`, `git version 2.45.1.windows.1`,
 * `git version 2.39.5 (Apple Git-154)`. Anything unparseable answers NO — holt then refuses the
 * newline case loudly instead of guessing, which is the one direction that cannot corrupt.
 */
export function batchNulInputSupported(versionLine) {
  const m = /(?:^|\s)(\d+)\.(\d+)/.exec(String(versionLine ?? ''));
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major > BATCH_NUL_MIN.major) return true;
  return major === BATCH_NUL_MIN.major && minor >= BATCH_NUL_MIN.minor;
}

/** @type {Promise<boolean>|null} — one probe per process; `git version` does not vary by repo. */
let _batchNulProbe = null;

function probeBatchNulSupport(cwd) {
  if (_batchNulProbe === null) {
    _batchNulProbe = (async () => {
      try {
        const r = await git(['version'], { cwd, timeout: 10_000 });
        return batchNulInputSupported(r.stdout);
      } catch {
        // A probe that could not RUN is not evidence that the feature is absent, so it is not
        // cached as a verdict — the next call asks again. This call answers "no", which only ever
        // costs a loud refusal on the newline case, never a silent mis-framing.
        _batchNulProbe = null;
        return false;
      }
    })();
  }
  return _batchNulProbe;
}

/** Test seam: forget the cached `git version` probe. */
export function _resetBatchNulProbe() {
  _batchNulProbe = null;
  _resetGitCapabilityProbe();
}

/**
 * Batched, STREAMING object reads: ONE `git cat-file --batch` process answers every spec,
 * instead of one `git cat-file -p <spec>` PROCESS PER FILE.
 *
 * MEASURED (2026-08, --cpu-prof against a synthetic 40k-file repo with a 5,500-file delta):
 * the per-file form spent 64.7% of wall-clock time inside `spawn` alone — 6,626 of 10,239
 * sampled hits, one `execFile` per requested file. At kernel-scale file counts (94,852 files,
 * see BENCHMARKS.md's 16m26s figure) that is the dominant term, not ctags: process-spawn
 * overhead multiplied by file count. `git cat-file --batch` answers the identical question —
 * object content by `<oid>:<path>` spec — over one long-lived process fed every spec on stdin,
 * reading the reply back as a stream of `<sha> <type> <size>\n<payload>\n` records (or
 * `<spec> missing\n` when the object does not exist at that spec — e.g. a file introduced only
 * in a workstream and absent at base, the same case the old per-file call treated as "wholly
 * new").
 *
 * STREAMING, not buffer-then-parse: each record is handed to `onRecord` the moment it is fully
 * received, and the running buffer is trimmed to only the unconsumed tail. Nothing here ever
 * holds the combined content of the whole batch in memory at once — only the one record
 * currently in flight — which is the fix for the "something is held whole" RSS growth this
 * apparatus was built to chase down.
 *
 * FRAMING IS THE CORRECTNESS PROPERTY HERE, AND IT USED TO BE WRONG IN BOTH DIRECTIONS.
 * A git path may contain any byte except `/` and NUL — a raw NEWLINE in a filename is legal and
 * real. Records are matched back to specs BY POSITION, so any framing that lets one spec occupy
 * two positions silently re-attributes every record after it: a valid Buffer or a null lands on
 * the wrong `onRecord(spec, content, idx)` call, `symbolsAtBase()` then materialises one file's
 * bytes under another file's name, and `diffSymbols()` omits a symbol the workstream genuinely
 * introduced because the corrupted read made it look pre-existing. `uniqueSymbolCount` is one of
 * the few reasons `safeToDelete` refuses, so an undercount authorises deleting real work.
 * Reproduced end to end; pinned by test/unit/cat-file-batch-newline-paths.test.mjs.
 *
 *   INPUT  — `specs.join('\n') + '\n'` turned one newline-bearing spec into two requests. Fixed by
 *            `--batch -z`, which reads NUL-delimited specs (git >= 2.38; see BATCH_NUL_MIN).
 *   OUTPUT — `-z` alone fixes only half of it. git answers a miss with `<spec> missing\n`, echoing
 *            the spec VERBATIM, so an ABSENT newline-named path still spans two physical lines on
 *            the way back. Reading "up to the next \n" splits that reply in two exactly as before.
 *            Fixed by parsing the reply AGAINST THE SPEC HOLT ASKED FOR: records come back in the
 *            order the specs went out, so the miss form for `specs[specIdx]` is known byte-for-byte
 *            and is tested for first, instead of guessing where the record ends.
 *
 * On a git older than 2.38 there is no safe input framing for a newline-bearing spec, so the batch
 * is REFUSED with the offending spec named. That is deliberately loud: the alternative is the
 * silent mis-attribution above. Every other spec shape works unchanged on every git.
 *
 * @param {string[]} specs   git object specs, e.g. `${oid}:${relPath}`, one per requested object
 * @param {{cwd?: string, timeout?: number}} opts
 * @param {(spec: string, content: Buffer|null, index: number) => any} onRecord
 *        called once per spec, in the order `specs` was given. `content` is `null` when the
 *        object is missing at that spec. May return a Promise; every returned promise is
 *        awaited before this function resolves, so writes onRecord starts are guaranteed to
 *        have settled by the time the caller proceeds.
 * @returns {Promise<void>}
 */
export async function catFileBatch(specs, { cwd, timeout = DEFAULT_TIMEOUT_MS } = {}, onRecord) {
  if (specs.length === 0) return;

  // NUL is the one byte no git spec can carry — paths cannot contain it and oids are hex — so a
  // spec holding one is unframable on ANY protocol here, `-z` included. Refuse rather than mis-frame.
  const nulAt = specs.findIndex((s) => String(s).includes('\0'));
  if (nulAt !== -1) {
    throw new GitRefused(
      'holt refused `git cat-file --batch`: spec ' + nulAt + ' contains a NUL byte, which no batch '
      + 'framing can carry unambiguously',
    );
  }

  const useNul = await probeBatchNulSupport(cwd);
  if (!useNul) {
    const nlAt = specs.findIndex((s) => String(s).includes('\n'));
    if (nlAt !== -1) {
      throw new GitRefused(
        'holt refused `git cat-file --batch`: spec ' + nlAt + ' (' + JSON.stringify(specs[nlAt])
        + ') contains a newline, and this git is older than 2.38 so it has no NUL-delimited batch '
        + 'input (`--batch -z`). Reading it on the newline-delimited protocol would silently '
        + 'attribute every later file\'s content to the wrong file. Upgrade git to 2.38 or newer.',
      );
    }
  }

  const argv = useNul ? ['cat-file', '--batch', '-z'] : ['cat-file', '--batch'];
  const label = `git ${argv.join(' ')}`;

  const childEnv = buildGitEnv();
  await requireNoLazyFetch(childEnv);
  const childArgv = hardenGitArgv(argv);

  return new Promise((resolve, reject) => {
    const verdict = classify(argv);
    if (!verdict.allowed) {
      reject(new GitRefused(`holt refused \`${label}\`: ${verdict.reason}`));
      return;
    }

    const child = spawn('git', childArgv, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
    });

    let pending = Buffer.alloc(0);
    let specIdx = 0;
    /** @type {number|null} */
    let awaitingSize = null; // non-null while mid-payload for specs[specIdx]
    const inFlight = [];
    let settled = false;
    let stderrText = '';

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new GitFailed(`${label} timed out after ${timeout}ms`, { argv, stderr: stderrText }));
    }, timeout);

    // A record header is "<sha> <type> <size>" — sha and type never contain a space, so this
    // cannot be confused with a "<spec> missing" line UNLESS a spec were deliberately crafted to
    // look like a valid header, which is no weaker than the equivalent per-file design.
    const HEADER_RE = /^([0-9a-f]{4,64}) (\S+) (\d+)$/;

    // The exact bytes git emits when `spec` has no object: the spec echoed verbatim, then
    // " missing\n". Knowing this per-spec is what makes a newline INSIDE a spec harmless on the
    // reply side — see the framing note in the doc comment above.
    const missReply = (spec) => Buffer.from(`${spec} missing\n`, 'utf8');

    // PER-RECORD CATCH: one onRecord rejection must not kill the entire batch. The old form was
    // `inFlight.push(Promise.resolve(onRecord(...)))` — a synchronous throw inside onRecord
    // crashed the 'data' handler (uncaught in an event emitter), and an async rejection
    // propagated through `Promise.all(inFlight)` at close time, rejecting the whole batch and
    // discarding every record after the failing one. Against a 5,500-file chunk, one bad path
    // could lose symbol information for thousands of files. Now each call is wrapped: sync throws
    // become rejected promises, and each promise has a `.catch()` that swallows the rejection so
    // Promise.all never sees it. The caller's own per-record catch (e.g. symbolsAtBase) handles
    // the application-level fallback for the one file that failed.
    const safeCall = (spec, content, idx) => {
      try {
        return Promise.resolve(onRecord(spec, content, idx)).catch(() => {});
      } catch {
        return Promise.resolve();
      }
    };

    function drain() {
      for (;;) {
        if (specIdx >= specs.length) return;
        if (awaitingSize === null) {
          const miss = missReply(specs[specIdx]);
          if (pending.length >= miss.length && pending.subarray(0, miss.length).equals(miss)) {
            pending = pending.subarray(miss.length);
            inFlight.push(safeCall(specs[specIdx], null, specIdx));
            specIdx++;
            continue;
          }
          const nl = pending.indexOf(0x0a);
          if (nl === -1) return; // header not fully arrived yet
          const header = pending.toString('utf8', 0, nl);
          const m = header.match(HEADER_RE);
          if (!m) {
            // Not a hit header. If everything received so far is still a viable PREFIX of THIS
            // spec's own miss reply, the rest of that reply is merely still in flight — wait for
            // it, instead of mistaking the first physical line of a newline-bearing spec for a
            // whole record and shifting every record after it by one.
            if (pending.length < miss.length && miss.subarray(0, pending.length).equals(pending)) return;
            pending = pending.subarray(nl + 1);
            inFlight.push(safeCall(specs[specIdx], null, specIdx));
            specIdx++;
            continue;
          }
          pending = pending.subarray(nl + 1);
          awaitingSize = Number(m[3]);
        }
        if (pending.length < awaitingSize + 1) return; // payload + its trailing \n not fully here
        const content = Buffer.from(pending.subarray(0, awaitingSize)); // copy: don't pin the chunk
        pending = pending.subarray(awaitingSize + 1);
        awaitingSize = null;
        inFlight.push(safeCall(specs[specIdx], content, specIdx));
        specIdx++;
      }
    }

    child.stdout.on('data', (chunk) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      drain();
    });
    child.stderr.on('data', (d) => { stderrText += d; });
    child.stdin.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(new GitFailed(`${label} input failed: ${err.message}`, { argv, stderr: stderrText }));
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new GitFailed(`${label} failed to spawn: ${err.message}`, { argv }));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new GitFailed(`${label} exited ${code}: ${stderrText.trim()}`, {
          code: code ?? undefined, stderr: stderrText, argv,
        }));
        return;
      }
      if (specIdx !== specs.length || awaitingSize !== null || pending.length !== 0) {
        reject(new GitFailed(
          `${label} ended after ${specIdx}/${specs.length} complete records with ${pending.length} trailing byte(s); `
          + 'partial or surplus object evidence is not usable',
          { code: code ?? undefined, stderr: stderrText, argv },
        ));
        return;
      }
      // `resolve` is called with NO argument elsewhere in this executor (this function resolves
      // `Promise<void>`); passing it directly as `.then()`'s fulfilled handler would hand it
      // `Promise.all`'s array result instead, which is a real type mismatch, not just a checker
      // complaint — wrapping it keeps the resolved value what the doc comment promises.
      Promise.all(inFlight).then(() => resolve(), reject);
    });

    // NUL-terminated (not NUL-separated) when `-z` is in play: git wants a delimiter after the last
    // spec too, exactly as the newline form did.
    const sep = useNul ? '\0' : '\n';
    child.stdin.write(specs.join(sep) + sep);
    child.stdin.end();
  });
}

/** Run git and throw if it exits non-zero. For calls where non-zero genuinely is a failure. */

/**
 * Identity for git objects HOLT creates (rescue captures, verify probes).
 *
 * MEASURED BUG: `holt rescue` died with "Author identity unknown" in any repository that has no
 * user.name/user.email configured — a fresh container, a CI runner, a new machine, a locked-down
 * corporate image. The command whose entire purpose is preserving work that exists nowhere else
 * failed precisely when asked to preserve it. It failed CLOSED (exit 1, no ref, no false claim of
 * success), so nothing was lost — but nothing was saved either, and the user is then one
 * `git worktree remove` away from losing it for real.
 *
 * The repository's own identity WINS whenever it is configured, so nothing changes for a normal
 * developer and rescue commits stay attributable. The fallback exists only so that holt can still
 * do its job where git would otherwise refuse to author anything at all.
 *
 * @returns {Promise<Record<string,string>>} env additions — empty when the repo has an identity
 */
export async function authorEnv(cwd) {
  const read = async (key) => {
    const r = await git(['config', key], { cwd }).catch(() => null);
    return r && r.code === 0 ? r.stdout.trim() : '';
  };
  const [name, email] = await Promise.all([read('user.name'), read('user.email')]);
  if (name && email) return {}; // configured — never override the user's own identity
  return {
    GIT_AUTHOR_NAME: name || 'holt',
    GIT_AUTHOR_EMAIL: email || 'holt@localhost',
    GIT_COMMITTER_NAME: name || 'holt',
    GIT_COMMITTER_EMAIL: email || 'holt@localhost',
  };
}


/**
 * A commit OID representing a worktree's COMPLETE current state — committed, uncommitted and
 * untracked — without touching the user's index, worktree, refs or stash.
 *
 * WHY THIS EXISTS AT THE GIT LAYER. holt's collision detection used to run `merge-tree` against
 * the two worktrees' committed HEADS, on the stated grounds that "merge-tree cannot see
 * uncommitted sides". That premise is wrong, and the cost of believing it was measured: two
 * worktrees editing the SAME LINE of the same file, uncommitted, produced "No collisions. No two
 * workstreams contest the same content." A real, provable conflict reported as no conflict —
 * a false negative on the flagship question, in the simplest case it exists to answer.
 *
 * Every worktree shares one object database, so a scratch index turns any worktree's working
 * state into a first-class tree, and a tree into a commit. Then every commit-based primitive —
 * merge-tree above all — applies unchanged. `holt rescue` has done exactly this since it was
 * written; the analysis path simply never used it.
 *
 * Object-writing only: it creates unreferenced objects (collected by a later `git gc`) and
 * mutates nothing reachable. Callers under strictReadOnly must not call it.
 *
 * @returns {Promise<string|null>} commit OID, or null if the worktree cannot be snapshotted —
 *   callers must fall back rather than treat null as "no conflict".
 */
/**
 * `includeIgnored` — and why the two callers want opposite answers.
 *
 * RESCUE wants gitignored content: an agent's uncommitted work is no less real for being ignored,
 * and a `.env` somebody spent an hour on is exactly what a capture must not drop.
 *
 * COLLISIONS must not have it. A gitignored file is overwhelmingly MACHINE-LOCAL — `.env.local`,
 * a per-developer config, a local cache — and every developer has their own. Sweeping it into the
 * snapshot made merge-tree conflict on content that is not shared work at all. Reproduced: two
 * worktrees editing one file at far-apart lines, which git merges cleanly, reported
 * `HIGH ... proven by merge-tree ... a real conflict` — and the file it NAMED was the one that
 * merges fine, because the actual conflict was in a `.env.local` the user was never told about.
 *
 * A manufactured HIGH is not a small error here. This file's own history records the finding:
 * "616 findings with 6 real ones is strictly worse than 6, because the real ones become
 * unreachable." A proof that proves the wrong thing is worse still, because it cannot be argued
 * with — it says git said so.
 */
export async function worktreeSnapshot(wsPath, head, { timeout = 60_000, includeIgnored = true } = {}) {
  // Unique per call: collisions() snapshots worktrees concurrently, and a shared index file
  // would have them overwrite each other's staging area. And OUTSIDE the worktree, for the same
  // two reasons scratchIndexPath() in actions.mjs moved out: `git add --all` in a concurrent
  // capture enumerates a sibling's transient `.lock` and dies on the stat when it vanishes
  // mid-walk ("unable to stat ... No such file or directory", reproduced ~1 in 12 locally and on
  // every CI OS), and even raceless runs photograph the siblings' scratch bytes into the tree
  // being captured. A worktree snapshot must contain the worktree, not the instruments.
  const dir = process.env.HOLT_TMPDIR || process.env.TMPDIR || os.tmpdir();
  const wsKey = Buffer.from(wsPath).toString('hex').slice(-16);
  const idx = path.join(dir, `holt-snap-${wsKey}-${process.pid}-${snapCounter++}`);
  const env = { GIT_INDEX_FILE: idx, ...(await authorEnv(wsPath)) };
  try {
    if (head) {
      const seed = await git(['read-tree', head], { cwd: wsPath, env, allowMutation: true, timeout });
      if (seed.code !== 0) return null;
    }
    // Deliberately not gitOk — a PARTIAL add (a nested git repo inside the worktree makes `add`
    // exit non-zero while still indexing everything else) should still yield a usable tree.
    const addArgs = includeIgnored
      ? ['add', '--all', '--force', '--', '.']
      : ['add', '--all', '--', '.'];
    await git(addArgs, { cwd: wsPath, env, allowMutation: true, timeout });
    const tree = await git(['write-tree'], { cwd: wsPath, env, allowMutation: true, timeout });
    if (tree.code !== 0) return null;
    const args = ['commit-tree', tree.stdout.trim(), '-m', 'holt snapshot'];
    if (head) args.push('-p', head);
    const commit = await git(args, { cwd: wsPath, env, allowMutation: true, timeout });
    return commit.code === 0 ? commit.stdout.trim() : null;
  } catch {
    return null;
  } finally {
    await fs.rm(idx, { force: true }).catch(() => {});
  }
}

let snapCounter = 0;

/**
 * The text of one worktree file, read directly off disk (working tree state, uncommitted
 * changes included), or null if it cannot be read as text — missing, a directory, a SYMLINK,
 * oversized, or binary. Deliberately narrow: callers that need this treat "cannot read" as
 * UNKNOWN, never as a mismatch, so this fails toward silence rather than toward a wrong answer.
 *
 * lstat, NOT stat, and for the same reason actions.mjs discard() lstats and content-identity.mjs
 * `pathContentKey` lstats: stat() follows the link and answers about its TARGET, so a symlink
 * passes `isFile()` and this hands back the target's text as if it were this path's. What git
 * tracks at a symlink path is the target STRING, not the bytes at the other end, so the target's
 * text is somebody else's content — and the one caller (analyze.mjs readDeclaredBody) is
 * COMPARING content across worktrees, where borrowed bytes are exactly how two unrelated paths
 * come to look like the same work.
 */
export async function readWorktreeFile(root, relPath) {
  try {
    const abs = path.join(root, relPath);
    const st = await fs.lstat(abs);
    if (!st.isFile() || st.size > 2 * 1024 * 1024) return null;
    const buf = await fs.readFile(abs);
    if (buf.includes(0)) return null;
    const text = buf.toString('utf8');
    // LFS pointer files are small text files that stand in for large binaries. Without this check,
    // holt would treat the pointer as the file's actual content — producing garbage symbols and
    // wrong "this file is tiny" metrics. The pointer format is:
    //   version https://git-lfs.github.com/spec/v1
    //   oid sha256:<hex>
    //   size <digits>
    if (isLfsPointer(text)) return null;
    return text;
  } catch {
    return null;
  }
}

/**
 * Detect a git-lfs pointer file. The pointer is a 3-line text file with a fixed format:
 *   version https://git-lfs.github.com/spec/v1
 *   oid sha256:<64 hex chars>
 *   size <digits>
 * Real content can start with "version https://..." but won't have the oid+size lines.
 * @param {string} text
 * @returns {boolean}
 */
export function isLfsPointer(text) {
  if (text.length > 500) return false; // pointers are tiny; real files can be too, but not huge
  const lines = text.split('\n');
  if (lines.length < 3) return false;
  return lines[0].startsWith('version https://git-lfs.github.com/spec/v')
    && /^oid sha256:[0-9a-f]{64}/.test(lines[1])
    && /^size \d+/.test(lines[2]);
}

/**
 * Two processes writing the SAME git object at the same time is a race Windows loses.
 *
 * git writes a loose object to a temporary file and renames it into place. On POSIX that rename
 * is atomic and idempotent — two processes computing the same content compute the same object id,
 * and whoever loses the race simply overwrites identical bytes. On Windows the rename fails if the
 * destination is open, and git surfaces it as
 *
 *     error: unable to write file …/.git/objects/aa/c493…: Permission denied
 *
 * MEASURED on a Windows CI runner: two concurrent `holt rescue` calls against one worktree, which
 * is the ordinary shape when two agents finish at once or a hook and a human overlap. One of them
 * died with a hard GitFailed instead of converging on the object the other had just written.
 *
 * The operation is CONTENT-ADDRESSED and therefore idempotent: retrying either finds the object
 * already present or writes the identical bytes. So this retries, briefly, and only for the
 * specific transient shape — never for a real failure, which would otherwise be retried into a
 * confusing timeout instead of reported.
 */
const TRANSIENT_OBJECT_WRITE = /unable to write (?:file|sha1 filename|loose object).*(?:Permission denied|EPERM|EACCES|being used by another process)/i;

/**
 * Is this repository's HISTORY COMPLETE enough for holt to render a verdict?
 *
 * MEASURED FAILURE, and it is the worst shape a gate can have: `actions/checkout` defaults to
 * `fetch-depth: 1`. In that checkout there are no other branches and no merge base, so the
 * branch audit finds nothing unlanded and `holt ci` reports GREEN — with `--fail-on-unlanded`
 * set, on a repository that provably held abandoned work. The moment holt knows LEAST is the
 * moment it is most reassuring, which is precisely backwards.
 *
 * This is the general rule, not a CI special case: an EMPTY result has two explanations — the
 * thing is absent, or the instrument cannot see it — and they are indistinguishable from the
 * output alone. Wherever holt turns an empty result into a PASS, it must first prove the
 * instrument could have seen a positive. Here that proof is the history itself.
 *
 * Detected, in the order git itself understands them:
 *   shallow  — `rev-parse --is-shallow-repository` (git >= 2.15), else the `shallow` marker file,
 *              which IS the shallow state and works on every git ever shipped.
 *   grafted  — `info/grafts` (deprecated) or `refs/replace/*` (the modern form). Either one means
 *              the commit graph git shows is not the commit graph that exists, so an ancestry or
 *              merge-base answer derived from it is not trustworthy.
 *
 * FAIL-CLOSED: if the instrument itself cannot be run, the answer is "incomplete", never
 * "complete". A gate that cannot check its own preconditions must refuse, not wave things through.
 *
 * @returns {Promise<{complete: boolean, kind: 'complete'|'shallow'|'grafted'|'unverifiable',
 *                    reason?: string, fix?: string}>}
 */
export async function historyCompleteness(root) {
  const gitPathExists = async (rel) => {
    const r = await git(['rev-parse', '--git-path', rel], { cwd: root }).catch(() => null);
    if (!r || r.code !== 0) return null; // unknown, not "absent"
    const p = r.stdout.trim();
    if (!p) return null;
    const abs = path.isAbsolute(p) ? p : path.join(root, p);
    try {
      const st = await fs.stat(abs);
      return st.size > 0;
    } catch {
      return false;
    }
  };

  const q = await git(['rev-parse', '--is-shallow-repository'], { cwd: root }).catch(() => null);
  let shallow = q && q.code === 0 && /^(true|false)$/.test(q.stdout.trim())
    ? q.stdout.trim() === 'true'
    : await gitPathExists('shallow');

  if (shallow === null) {
    return {
      complete: false,
      kind: 'unverifiable',
      reason: 'holt could not determine whether this repository is a shallow clone, so it cannot '
        + 'tell "nothing was abandoned" from "there is no history to look at"',
      fix: 'Check out the full history — actions/checkout with `fetch-depth: 0` — or run `git fetch --unshallow`.',
    };
  }
  if (shallow) {
    return {
      complete: false,
      kind: 'shallow',
      reason: 'this is a SHALLOW clone: git holds only part of the history, so no branch can be '
        + 'compared against its base. An empty result here means "no history to look at", NOT '
        + '"no work was abandoned"',
      fix: 'actions/checkout@v4 with `fetch-depth: 0` (the default of 1 is a shallow clone), '
        + 'or run `git fetch --unshallow` before holt.',
    };
  }

  if (await gitPathExists('info/grafts')) {
    return {
      complete: false,
      kind: 'grafted',
      reason: 'this repository has GRAFTS (.git/info/grafts): the commit graph git reports is not '
        + 'the commit graph that exists, so ancestry and merge-base answers are not trustworthy',
      fix: 'Run holt against an ungrafted clone, or migrate the grafts to `git replace` and remove them.',
    };
  }
  const replaced = await git(['for-each-ref', 'refs/replace', '--format=%(refname)'], { cwd: root })
    .catch(() => null);
  if (replaced && replaced.code === 0 && replaced.stdout.trim()) {
    return {
      complete: false,
      kind: 'grafted',
      reason: 'this repository has replacement refs (refs/replace/*), which git itself labels '
        + '"grafted": the visible commit graph is not the real one, so a content verdict derived '
        + 'from it cannot be trusted',
      fix: 'Run holt with `GIT_NO_REPLACE_OBJECTS=1`, or against a clone without replacement refs.',
    };
  }

  return { complete: true, kind: 'complete' };
}

export async function gitOk(argv, opts) {
  let r = await git(argv, opts);
  for (let attempt = 1; attempt <= 4 && r.code !== 0 && TRANSIENT_OBJECT_WRITE.test(r.stderr ?? ''); attempt++) {
    // 20ms, 40ms, 80ms, 160ms — bounded, and short next to the operation it protects.
    await new Promise((res) => { setTimeout(res, 20 * (2 ** (attempt - 1))); });
    // eslint-disable-next-line no-await-in-loop -- a retry is sequential by definition
    r = await git(argv, opts);
  }
  if (r.code !== 0) {
    throw new GitFailed(`git ${argv.join(' ')} exited ${r.code}: ${r.stderr.trim()}`, {
      code: r.code,
      stderr: r.stderr,
      argv,
    });
  }
  return r;
}

/** Split git output on NUL. Used with -z forms so filenames with newlines survive. */
export function splitNul(s) {
  return s.split('\0').filter((x) => x.length > 0);
}

/** Split on newlines, dropping empties. */
export function splitLines(s) {
  return s.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.length > 0);
}

/**
 * Every tracked path in the repository, as the REAL bytes on disk.
 *
 * WHY THIS IS A FUNCTION AND NOT `git(['ls-files'])` AT EACH CALL SITE. `git ls-files` without
 * `-z` protects its own line framing by C-QUOTING any path holding a non-ASCII byte or a control
 * character — the WHOLE path, slashes included: `"src/caf\303\251.js"`. Split on `\n`, the caller
 * gets a string that is not the path. Two call sites did exactly that (`holt partition`, on the
 * CLI and over MCP), and `partitionPlan()` reads a path's top-level directory by slicing to the
 * first `/` — so `"src/caf\303\251.js"` has directory `"src`, a PHANTOM distinct from `src`:
 *
 *   AGENT 1  weight=4  dirs=["\"src","<root>","lib"]
 *   AGENT 2  weight=3  dirs=["config","src"]
 *
 * Two agents sent into the same real directory by one accented filename — the precise collision
 * the command exists to prevent. `core.quotePath=false` does not rescue it either: that only stops
 * the non-ASCII quoting, control characters stay quoted, so the answer changed with repo config.
 *
 * `-z` removes the question: NUL-terminated records, paths verbatim, no quoting under any config.
 * Unlike `cat-file --batch -z` this needs no version gate — `ls-files -z` is as old as the command.
 * Same defect class as the batched object reader; pinned by test/unit/git-path-framing.test.mjs.
 *
 * @param {string} cwd  anywhere inside the repository
 * @returns {Promise<string[]>} repo-relative paths, exactly as the filesystem holds them
 */
export async function listTrackedFiles(cwd, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
  const r = await git(['ls-files', '-z'], { cwd, timeout });
  return splitNul(r.stdout);
}

/**
 * Bounded-concurrency map. The scan fans out over N workstreams; without a bound,
 * 500 worktrees would fork 500 git processes at once and thrash the box.
 */
export async function pmap(items, fn, concurrency = 8) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * The MAIN worktree of the repository containing `cwd` — not whichever worktree you happen to
 * be standing in.
 *
 * `rev-parse --show-toplevel` returns the CURRENT worktree. Run from inside a linked worktree it
 * returns that worktree, which made holt treat it as the repository root and then exclude it
 * from its own report as "primary". An agent running holt from inside its own worktree got a
 * briefing about every workstream EXCEPT the one it was working in — the single most important
 * one. Found by test/e2e/integration.test.mjs.
 *
 * `--git-common-dir` is shared by every worktree and points at the main repository's .git, so
 * its parent is the main worktree regardless of where we are standing.
 */
export async function repoRoot(cwd) {
  try {
    const common = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd });
    if (common.code === 0) {
      const gitDir = common.stdout.trim();
      if (gitDir) {
        // Normal repo: <main>/.git  ·  bare or unusual layouts: fall through to toplevel.
        const base = gitDir.replace(/\/+$/, '');
        if (base.endsWith('/.git')) return base.slice(0, -'/.git'.length);
      }
    }
    const r = await git(['rev-parse', '--show-toplevel'], { cwd });
    if (r.code !== 0) return null;
    const p = r.stdout.trim();
    return p.length > 0 ? p : null;
  } catch {
    return null;
  }
}

/**
 * A directory's REPOSITORY IDENTITY — the thing that makes two directories the same repository.
 *
 * IDENTITY IS NOT LOCATION, AND repoRoot() ANSWERS THE LOCATION QUESTION. repoRoot() is documented
 * as "the MAIN worktree", and for a normal `<root>/.git` clone it is; but its `--git-common-dir`
 * fast path only fires when the common dir ends in `/.git`, so the CANONICAL bare-plus-linked-
 * worktrees layout — `proj.git` beside `wtA` and `wtB`, which is how every agent fleet holt exists
 * to serve is laid out — falls through to `rev-parse --show-toplevel`, and show-toplevel returns
 * WHICHEVER WORKTREE YOU ARE STANDING IN. Measured on that layout:
 *
 *   repoRoot(wtA)       = <base>/wtA          repoIdentity(wtA)       = <base>/proj.git
 *   repoRoot(wtB)       = <base>/wtB          repoIdentity(wtB)       = <base>/proj.git
 *   repoRoot(proj.git)  = null   (!)          repoIdentity(proj.git)  = <base>/proj.git
 *
 * So repoRoot() used as an identity is wrong in BOTH directions at once: two worktrees of one
 * repository compare as different repositories (an over-refusal of the product's own subject
 * matter), and every bare repository compares as `null` — which any "null means not a repository,
 * therefore harmless" branch then waves through (an under-protection). Both were live on the MCP
 * repository boundary; see guardRepoArg in src/mcp/server.mjs.
 *
 * `--git-common-dir` is git's own answer to "which repository is this": every worktree of one
 * repository — main, linked, and the bare directory itself — reports the SAME absolute path, and
 * two unrelated repositories can never share one. A submodule reports `<super>/.git/modules/<name>`
 * and so is correctly a DIFFERENT repository, which it is.
 *
 * Returns null only when git itself declines to name a repository here: no repository, a worktree
 * whose main repository has been moved away (git reports `fatal: not a git repository: (null)` for
 * every rev-parse in that state, so there is nothing to identify), an unreadable directory, or no
 * git on PATH. NULL IS NEVER "the same as something else" and never "harmless" — a caller
 * comparing identities must treat null as UNDETERMINED and say so, not as permission.
 *
 * @param {string} cwd  any path
 * @returns {Promise<string|null>} absolute, or null when git cannot name a repository here
 */
export async function repoIdentity(cwd) {
  try {
    const r = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd });
    if (r.code !== 0) return null;
    const out = r.stdout.trim();
    return out ? path.resolve(out) : null;
  } catch {
    return null; // GitRefused/GitFailed — unidentifiable, not "already seen"
  }
}

/** Resolve a ref to a full oid, or null if it does not resolve. */
export async function resolveRef(cwd, ref) {
  const r = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd });
  if (r.code !== 0) return null;
  const oid = r.stdout.trim();
  return oid.length === 40 || oid.length === 64 ? oid : null;
}
