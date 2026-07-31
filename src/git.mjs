/**
 * grove — git engine.
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

import { execFile } from 'node:child_process';

/** git subcommands that touch nothing. */
const SAFE = new Set([
  'rev-parse', 'rev-list', 'log', 'show', 'cat-file', 'ls-files', 'ls-tree',
  'status', 'diff', 'diff-tree', 'diff-index', 'merge-base', 'name-rev',
  'worktree', 'branch', 'for-each-ref', 'config', 'var', 'symbolic-ref',
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
 * These are UNREACHABLE unless a caller passes `allowMutation: true`, which only the explicitly
 * destructive/protective commands do (`grove protect`, `grove rescue`, `grove clean`). Scanning
 * and analysis can never reach them, and test/unit/safety.test.mjs proves a full scan still
 * changes nothing byte-for-byte.
 *
 * The read-only guarantee is a core reason to trust grove, so adding write features must not
 * quietly widen the default. It does not: the default for every code path in the scanner remains
 * allowMutation:false, and a mutating command that forgets to opt in fails loudly rather than
 * silently succeeding.
 *
 * Each entry is here because a specific feature needs it, and nothing else is:
 *   worktree lock/unlock  -> `grove protect`  (git's own protection; defeats a single --force)
 *   worktree remove       -> `grove clean`    (removing provably-disposable worktrees)
 *   branch -d/-D          -> `grove clean`    (the second command nobody runs)
 *   commit-tree/hash-object/update-ref/write-tree/read-tree -> `grove rescue` (capture work)
 */
const MUTATE_SUBVERBS = {
  worktree: new Set(['lock', 'unlock', 'remove', 'prune']),
  branch: new Set(['-d', '-D', '--delete']),
};
const MUTATE_COMMANDS = new Set([
  'commit-tree', 'update-ref', 'write-tree', 'read-tree', 'update-index', 'mktree',
  // `add` is here for `grove rescue` ONLY, and it is safe there because rescue runs it with
  // GIT_INDEX_FILE pointed at a scratch index — the user's real index is never touched, which
  // test/e2e/actions.test.mjs asserts by comparing `git status` before and after.
  // The hand-rolled update-index fallback that preceded this silently failed to capture files,
  // and rescue's own verification caught it: an incomplete capture is worse than none, because
  // it licenses a deletion.
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
};

/** Global flags that can redirect git at another repo or escalate it. Never allowed from callers. */
const FORBIDDEN_GLOBAL = new Set(['--exec-path', '-c', '--config-env', '--namespace', '--work-tree', '--git-dir']);

export class GitRefused extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'GitRefused';
    this.refused = true;
  }
}

export class GitFailed extends Error {
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
 * @returns {{allowed: boolean, tier?: 'SAFE'|'OBJECT_WRITE', reason?: string}}
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

  // MUTATE tier — only reachable with an explicit opt-in from a mutating grove command.
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
            + (MUTATE_SUBVERBS[sub]?.has(bare) ? ' (needs an explicit mutating grove command)' : ''),
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
  return { allowed: false, reason: `'git ${sub}' is not on grove's allowlist` };
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Run git. Rejects on refusal; resolves {stdout, stderr, code} otherwise.
 * Non-zero exit is NOT automatically an error — many git reads use exit codes as answers
 * (merge-tree returns 1 on conflict, diff --quiet returns 1 on difference). Callers decide.
 */
export function git(argv, {
  cwd, timeout = DEFAULT_TIMEOUT_MS, allowObjectWrite = true, allowMutation = false, env,
} = {}) {
  const verdict = classify(argv, { allowMutation });
  if (!verdict.allowed) {
    return Promise.reject(new GitRefused(`grove refused to run \`git ${argv.join(' ')}\`: ${verdict.reason}`));
  }
  if (verdict.tier === 'OBJECT_WRITE' && !allowObjectWrite) {
    return Promise.reject(
      new GitRefused(
        `grove refused \`git ${argv[0]}\`: it writes unreferenced objects and strictReadOnly is set`,
      ),
    );
  }

  return new Promise((resolve, reject) => {
    execFile(
      'git',
      argv,
      {
        cwd,
        timeout,
        maxBuffer: DEFAULT_MAX_BUFFER,
        // Keep git deterministic and non-interactive. A prompt would hang the scan.
        env: {
          ...process.env,
          ...env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
          GIT_PAGER: 'cat',
          LC_ALL: 'C',
        },
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
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code: err ? err.code : 0 });
      },
    );
  });
}

/** Run git and throw if it exits non-zero. For calls where non-zero genuinely is a failure. */
export async function gitOk(argv, opts) {
  const r = await git(argv, opts);
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
 * returns that worktree, which made grove treat it as the repository root and then exclude it
 * from its own report as "primary". An agent running grove from inside its own worktree got a
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

/** Resolve a ref to a full oid, or null if it does not resolve. */
export async function resolveRef(cwd, ref) {
  const r = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd });
  if (r.code !== 0) return null;
  const oid = r.stdout.trim();
  return oid.length === 40 || oid.length === 64 ? oid : null;
}
