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
  // input (`--batch -z`, git >= 2.32) before it can frame a spec containing a newline safely.
  'version',
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
 * destructive/protective commands do (`holt protect`, `holt rescue`, `holt clean`). Scanning
 * and analysis can never reach them, and test/unit/safety.test.mjs proves a full scan still
 * changes nothing byte-for-byte.
 *
 * The read-only guarantee is a core reason to trust holt, so adding write features must not
 * quietly widen the default. It does not: the default for every code path in the scanner remains
 * allowMutation:false, and a mutating command that forgets to opt in fails loudly rather than
 * silently succeeding.
 *
 * Each entry is here because a specific feature needs it, and nothing else is:
 *   worktree lock/unlock  -> `holt protect`  (git's own protection; defeats a single --force)
 *   worktree remove       -> `holt clean`    (removing provably-disposable worktrees)
 *   branch -d/-D          -> `holt clean`    (the second command nobody runs)
 *   commit-tree/hash-object/update-ref/write-tree/read-tree -> `holt rescue` (capture work)
 */
const MUTATE_SUBVERBS = {
  // `add` is here for `holt verify`, which materialises a SPECULATIVE MERGE into a scratch
  // worktree (outside the repo, removed afterwards) to run the user's tests against it. It is
  // still refused without the explicit opt-in, so the scanner can never create worktrees.
  worktree: new Set(['lock', 'unlock', 'remove', 'prune', 'add']),
  branch: new Set(['-d', '-D', '--delete']),
};
const MUTATE_COMMANDS = new Set([
  'commit-tree', 'update-ref', 'write-tree', 'read-tree', 'update-index', 'mktree',
  // `add` is here for `holt rescue` ONLY, and it is safe there because rescue runs it with
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

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

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
export function git(argv, {
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

/**
 * `git cat-file --batch -z` — NUL-delimited batch INPUT — landed in git 2.32 (2021-06).
 * Below that, holt cannot frame a spec containing a newline at all and says so (see catFileBatch).
 */
const BATCH_NUL_MIN = { major: 2, minor: 32 };

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
export function _resetBatchNulProbe() { _batchNulProbe = null; }

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
 *            `--batch -z`, which reads NUL-delimited specs (git >= 2.32; see BATCH_NUL_MIN).
 *   OUTPUT — `-z` alone fixes only half of it. git answers a miss with `<spec> missing\n`, echoing
 *            the spec VERBATIM, so an ABSENT newline-named path still spans two physical lines on
 *            the way back. Reading "up to the next \n" splits that reply in two exactly as before.
 *            Fixed by parsing the reply AGAINST THE SPEC HOLT ASKED FOR: records come back in the
 *            order the specs went out, so the miss form for `specs[specIdx]` is known byte-for-byte
 *            and is tested for first, instead of guessing where the record ends.
 *
 * On a git older than 2.32 there is no safe input framing for a newline-bearing spec, so the batch
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
        + ') contains a newline, and this git is older than 2.32 so it has no NUL-delimited batch '
        + 'input (`--batch -z`). Reading it on the newline-delimited protocol would silently '
        + 'attribute every later file\'s content to the wrong file. Upgrade git to 2.32 or newer.',
      );
    }
  }

  const argv = useNul ? ['cat-file', '--batch', '-z'] : ['cat-file', '--batch'];
  const label = `git ${argv.join(' ')}`;

  return new Promise((resolve, reject) => {
    const verdict = classify(argv);
    if (!verdict.allowed) {
      reject(new GitRefused(`holt refused \`${label}\`: ${verdict.reason}`));
      return;
    }

    const child = spawn('git', argv, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', LC_ALL: 'C',
      },
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

    function drain() {
      for (;;) {
        if (specIdx >= specs.length) return;
        if (awaitingSize === null) {
          const miss = missReply(specs[specIdx]);
          if (pending.length >= miss.length && pending.subarray(0, miss.length).equals(miss)) {
            pending = pending.subarray(miss.length);
            inFlight.push(Promise.resolve(onRecord(specs[specIdx], null, specIdx)));
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
            inFlight.push(Promise.resolve(onRecord(specs[specIdx], null, specIdx)));
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
        inFlight.push(Promise.resolve(onRecord(specs[specIdx], content, specIdx)));
        specIdx++;
      }
    }

    child.stdout.on('data', (chunk) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      drain();
    });
    child.stderr.on('data', (d) => { stderrText += d; });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new GitFailed(`${label} failed to spawn: ${err.message}`, { argv }));
    });
    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

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

/** Resolve a ref to a full oid, or null if it does not resolve. */
export async function resolveRef(cwd, ref) {
  const r = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd });
  if (r.code !== 0) return null;
  const oid = r.stdout.trim();
  return oid.length === 40 || oid.length === 64 ? oid : null;
}
