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
// @ts-nocheck
function stryNS_9fa48() {
  var g = typeof globalThis === 'object' && globalThis && globalThis.Math === Math && globalThis || new Function("return this")();
  var ns = g.__stryker__ || (g.__stryker__ = {});
  if (ns.activeMutant === undefined && g.process && g.process.env && g.process.env.__STRYKER_ACTIVE_MUTANT__) {
    ns.activeMutant = g.process.env.__STRYKER_ACTIVE_MUTANT__;
  }
  function retrieveNS() {
    return ns;
  }
  stryNS_9fa48 = retrieveNS;
  return retrieveNS();
}
stryNS_9fa48();
function stryCov_9fa48() {
  var ns = stryNS_9fa48();
  var cov = ns.mutantCoverage || (ns.mutantCoverage = {
    static: {},
    perTest: {}
  });
  function cover() {
    var c = cov.static;
    if (ns.currentTestId) {
      c = cov.perTest[ns.currentTestId] = cov.perTest[ns.currentTestId] || {};
    }
    var a = arguments;
    for (var i = 0; i < a.length; i++) {
      c[a[i]] = (c[a[i]] || 0) + 1;
    }
  }
  stryCov_9fa48 = cover;
  cover.apply(null, arguments);
}
function stryMutAct_9fa48(id) {
  var ns = stryNS_9fa48();
  function isActive(id) {
    if (ns.activeMutant === id) {
      if (ns.hitCount !== void 0 && ++ns.hitCount > ns.hitLimit) {
        throw new Error('Stryker: Hit count limit reached (' + ns.hitCount + ')');
      }
      return true;
    }
    return false;
  }
  stryMutAct_9fa48 = isActive;
  return isActive(id);
}
import { execFile } from 'node:child_process';

/** git subcommands that touch nothing. */
const SAFE = new Set(stryMutAct_9fa48("636") ? [] : (stryCov_9fa48("636"), [stryMutAct_9fa48("637") ? "" : (stryCov_9fa48("637"), 'rev-parse'), stryMutAct_9fa48("638") ? "" : (stryCov_9fa48("638"), 'rev-list'), stryMutAct_9fa48("639") ? "" : (stryCov_9fa48("639"), 'log'), stryMutAct_9fa48("640") ? "" : (stryCov_9fa48("640"), 'show'), stryMutAct_9fa48("641") ? "" : (stryCov_9fa48("641"), 'cat-file'), stryMutAct_9fa48("642") ? "" : (stryCov_9fa48("642"), 'ls-files'), stryMutAct_9fa48("643") ? "" : (stryCov_9fa48("643"), 'ls-tree'), stryMutAct_9fa48("644") ? "" : (stryCov_9fa48("644"), 'status'), stryMutAct_9fa48("645") ? "" : (stryCov_9fa48("645"), 'diff'), stryMutAct_9fa48("646") ? "" : (stryCov_9fa48("646"), 'diff-tree'), stryMutAct_9fa48("647") ? "" : (stryCov_9fa48("647"), 'diff-index'), stryMutAct_9fa48("648") ? "" : (stryCov_9fa48("648"), 'merge-base'), stryMutAct_9fa48("649") ? "" : (stryCov_9fa48("649"), 'name-rev'), stryMutAct_9fa48("650") ? "" : (stryCov_9fa48("650"), 'worktree'), stryMutAct_9fa48("651") ? "" : (stryCov_9fa48("651"), 'branch'), stryMutAct_9fa48("652") ? "" : (stryCov_9fa48("652"), 'for-each-ref'), stryMutAct_9fa48("653") ? "" : (stryCov_9fa48("653"), 'config'), stryMutAct_9fa48("654") ? "" : (stryCov_9fa48("654"), 'var'), stryMutAct_9fa48("655") ? "" : (stryCov_9fa48("655"), 'symbolic-ref'), stryMutAct_9fa48("656") ? "" : (stryCov_9fa48("656"), 'describe'), stryMutAct_9fa48("657") ? "" : (stryCov_9fa48("657"), 'blame'), stryMutAct_9fa48("658") ? "" : (stryCov_9fa48("658"), 'shortlog'), stryMutAct_9fa48("659") ? "" : (stryCov_9fa48("659"), 'count-objects')]));

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
const POSITIONAL_LIMITS = stryMutAct_9fa48("660") ? {} : (stryCov_9fa48("660"), {
  'symbolic-ref': 1,
  config: 1,
  branch: 0
});

/** Subcommands allowed to write unreferenced objects. */
const OBJECT_WRITE = new Set(stryMutAct_9fa48("661") ? [] : (stryCov_9fa48("661"), [stryMutAct_9fa48("662") ? "" : (stryCov_9fa48("662"), 'merge-tree')]));

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
const MUTATE_SUBVERBS = stryMutAct_9fa48("663") ? {} : (stryCov_9fa48("663"), {
  worktree: new Set(stryMutAct_9fa48("664") ? [] : (stryCov_9fa48("664"), [stryMutAct_9fa48("665") ? "" : (stryCov_9fa48("665"), 'lock'), stryMutAct_9fa48("666") ? "" : (stryCov_9fa48("666"), 'unlock'), stryMutAct_9fa48("667") ? "" : (stryCov_9fa48("667"), 'remove'), stryMutAct_9fa48("668") ? "" : (stryCov_9fa48("668"), 'prune')])),
  branch: new Set(stryMutAct_9fa48("669") ? [] : (stryCov_9fa48("669"), [stryMutAct_9fa48("670") ? "" : (stryCov_9fa48("670"), '-d'), stryMutAct_9fa48("671") ? "" : (stryCov_9fa48("671"), '-D'), stryMutAct_9fa48("672") ? "" : (stryCov_9fa48("672"), '--delete')]))
});
const MUTATE_COMMANDS = new Set(stryMutAct_9fa48("673") ? [] : (stryCov_9fa48("673"), [stryMutAct_9fa48("674") ? "" : (stryCov_9fa48("674"), 'commit-tree'), stryMutAct_9fa48("675") ? "" : (stryCov_9fa48("675"), 'update-ref'), stryMutAct_9fa48("676") ? "" : (stryCov_9fa48("676"), 'write-tree'), stryMutAct_9fa48("677") ? "" : (stryCov_9fa48("677"), 'read-tree'), stryMutAct_9fa48("678") ? "" : (stryCov_9fa48("678"), 'update-index'), stryMutAct_9fa48("679") ? "" : (stryCov_9fa48("679"), 'mktree'), // `add` is here for `grove rescue` ONLY, and it is safe there because rescue runs it with
// GIT_INDEX_FILE pointed at a scratch index — the user's real index is never touched, which
// test/e2e/actions.test.mjs asserts by comparing `git status` before and after.
// The hand-rolled update-index fallback that preceded this silently failed to capture files,
// and rescue's own verification caught it: an incomplete capture is worse than none, because
// it licenses a deletion.
stryMutAct_9fa48("680") ? "" : (stryCov_9fa48("680"), 'add')]));

/**
 * Flags that turn an otherwise-safe subcommand into a mutating one.
 * `git worktree list` is a read; `git worktree add/remove/prune` is not.
 * `git config --get` is a read; `git config key value` is not.
 */
const FORBIDDEN_SUBVERBS = stryMutAct_9fa48("681") ? {} : (stryCov_9fa48("681"), {
  worktree: new Set(stryMutAct_9fa48("682") ? [] : (stryCov_9fa48("682"), [stryMutAct_9fa48("683") ? "" : (stryCov_9fa48("683"), 'add'), stryMutAct_9fa48("684") ? "" : (stryCov_9fa48("684"), 'remove'), stryMutAct_9fa48("685") ? "" : (stryCov_9fa48("685"), 'prune'), stryMutAct_9fa48("686") ? "" : (stryCov_9fa48("686"), 'move'), stryMutAct_9fa48("687") ? "" : (stryCov_9fa48("687"), 'lock'), stryMutAct_9fa48("688") ? "" : (stryCov_9fa48("688"), 'unlock'), stryMutAct_9fa48("689") ? "" : (stryCov_9fa48("689"), 'repair')])),
  branch: new Set(stryMutAct_9fa48("690") ? [] : (stryCov_9fa48("690"), [stryMutAct_9fa48("691") ? "" : (stryCov_9fa48("691"), '-d'), stryMutAct_9fa48("692") ? "" : (stryCov_9fa48("692"), '-D'), stryMutAct_9fa48("693") ? "" : (stryCov_9fa48("693"), '--delete'), stryMutAct_9fa48("694") ? "" : (stryCov_9fa48("694"), '-m'), stryMutAct_9fa48("695") ? "" : (stryCov_9fa48("695"), '-M'), stryMutAct_9fa48("696") ? "" : (stryCov_9fa48("696"), '--move'), stryMutAct_9fa48("697") ? "" : (stryCov_9fa48("697"), '-c'), stryMutAct_9fa48("698") ? "" : (stryCov_9fa48("698"), '-C'), stryMutAct_9fa48("699") ? "" : (stryCov_9fa48("699"), '--copy'), stryMutAct_9fa48("700") ? "" : (stryCov_9fa48("700"), '--set-upstream-to'), stryMutAct_9fa48("701") ? "" : (stryCov_9fa48("701"), '-u')])),
  config: new Set(stryMutAct_9fa48("702") ? [] : (stryCov_9fa48("702"), [stryMutAct_9fa48("703") ? "" : (stryCov_9fa48("703"), '--unset'), stryMutAct_9fa48("704") ? "" : (stryCov_9fa48("704"), '--unset-all'), stryMutAct_9fa48("705") ? "" : (stryCov_9fa48("705"), '--add'), stryMutAct_9fa48("706") ? "" : (stryCov_9fa48("706"), '--replace-all'), stryMutAct_9fa48("707") ? "" : (stryCov_9fa48("707"), '--edit'), stryMutAct_9fa48("708") ? "" : (stryCov_9fa48("708"), '-e'), stryMutAct_9fa48("709") ? "" : (stryCov_9fa48("709"), '--rename-section'), stryMutAct_9fa48("710") ? "" : (stryCov_9fa48("710"), '--remove-section')])),
  'hash-object': new Set(stryMutAct_9fa48("711") ? [] : (stryCov_9fa48("711"), [stryMutAct_9fa48("712") ? "" : (stryCov_9fa48("712"), '-w'), stryMutAct_9fa48("713") ? "" : (stryCov_9fa48("713"), '--stdin-paths')]))
});

/** Global flags that can redirect git at another repo or escalate it. Never allowed from callers. */
const FORBIDDEN_GLOBAL = new Set(stryMutAct_9fa48("714") ? [] : (stryCov_9fa48("714"), [stryMutAct_9fa48("715") ? "" : (stryCov_9fa48("715"), '--exec-path'), stryMutAct_9fa48("716") ? "" : (stryCov_9fa48("716"), '-c'), stryMutAct_9fa48("717") ? "" : (stryCov_9fa48("717"), '--config-env'), stryMutAct_9fa48("718") ? "" : (stryCov_9fa48("718"), '--namespace'), stryMutAct_9fa48("719") ? "" : (stryCov_9fa48("719"), '--work-tree'), stryMutAct_9fa48("720") ? "" : (stryCov_9fa48("720"), '--git-dir')]));
export class GitRefused extends Error {
  constructor(msg) {
    if (stryMutAct_9fa48("721")) {
      {}
    } else {
      stryCov_9fa48("721");
      super(msg);
      this.name = stryMutAct_9fa48("722") ? "" : (stryCov_9fa48("722"), 'GitRefused');
      this.refused = stryMutAct_9fa48("723") ? false : (stryCov_9fa48("723"), true);
    }
  }
}
export class GitFailed extends Error {
  constructor(msg, {
    code,
    stderr,
    argv
  } = {}) {
    if (stryMutAct_9fa48("724")) {
      {}
    } else {
      stryCov_9fa48("724");
      super(msg);
      this.name = stryMutAct_9fa48("725") ? "" : (stryCov_9fa48("725"), 'GitFailed');
      this.code = code;
      this.stderr = stderr;
      this.argv = argv;
    }
  }
}

/**
 * Decide whether an argv is permitted. Exported so the safety test can assert on it
 * directly without spawning processes.
 *
 * @returns {{allowed: boolean, tier?: 'SAFE'|'OBJECT_WRITE', reason?: string}}
 */
export function classify(argv, {
  allowMutation = stryMutAct_9fa48("726") ? true : (stryCov_9fa48("726"), false)
} = {}) {
  if (stryMutAct_9fa48("727")) {
    {}
  } else {
    stryCov_9fa48("727");
    if (stryMutAct_9fa48("730") ? !Array.isArray(argv) && argv.length === 0 : stryMutAct_9fa48("729") ? false : stryMutAct_9fa48("728") ? true : (stryCov_9fa48("728", "729", "730"), (stryMutAct_9fa48("731") ? Array.isArray(argv) : (stryCov_9fa48("731"), !Array.isArray(argv))) || (stryMutAct_9fa48("733") ? argv.length !== 0 : stryMutAct_9fa48("732") ? false : (stryCov_9fa48("732", "733"), argv.length === 0)))) {
      if (stryMutAct_9fa48("734")) {
        {}
      } else {
        stryCov_9fa48("734");
        return stryMutAct_9fa48("735") ? {} : (stryCov_9fa48("735"), {
          allowed: stryMutAct_9fa48("736") ? true : (stryCov_9fa48("736"), false),
          reason: stryMutAct_9fa48("737") ? "" : (stryCov_9fa48("737"), 'empty argv')
        });
      }
    }
    for (const a of argv) {
      if (stryMutAct_9fa48("738")) {
        {}
      } else {
        stryCov_9fa48("738");
        if (stryMutAct_9fa48("741") ? typeof a === 'string' : stryMutAct_9fa48("740") ? false : stryMutAct_9fa48("739") ? true : (stryCov_9fa48("739", "740", "741"), typeof a !== (stryMutAct_9fa48("742") ? "" : (stryCov_9fa48("742"), 'string')))) return stryMutAct_9fa48("743") ? {} : (stryCov_9fa48("743"), {
          allowed: stryMutAct_9fa48("744") ? true : (stryCov_9fa48("744"), false),
          reason: stryMutAct_9fa48("745") ? `` : (stryCov_9fa48("745"), `non-string argument: ${String(a)}`)
        });
      }
    }

    // Reject repo-redirecting / escalating global flags before the subcommand.
    let i = 0;
    while (stryMutAct_9fa48("747") ? i < argv.length || argv[i].startsWith('-') : stryMutAct_9fa48("746") ? false : (stryCov_9fa48("746", "747"), (stryMutAct_9fa48("750") ? i >= argv.length : stryMutAct_9fa48("749") ? i <= argv.length : stryMutAct_9fa48("748") ? true : (stryCov_9fa48("748", "749", "750"), i < argv.length)) && (stryMutAct_9fa48("751") ? argv[i].endsWith('-') : (stryCov_9fa48("751"), argv[i].startsWith(stryMutAct_9fa48("752") ? "" : (stryCov_9fa48("752"), '-')))))) {
      if (stryMutAct_9fa48("753")) {
        {}
      } else {
        stryCov_9fa48("753");
        const flag = argv[i].split(stryMutAct_9fa48("754") ? "" : (stryCov_9fa48("754"), '='))[0];
        if (stryMutAct_9fa48("756") ? false : stryMutAct_9fa48("755") ? true : (stryCov_9fa48("755", "756"), FORBIDDEN_GLOBAL.has(flag))) {
          if (stryMutAct_9fa48("757")) {
            {}
          } else {
            stryCov_9fa48("757");
            return stryMutAct_9fa48("758") ? {} : (stryCov_9fa48("758"), {
              allowed: stryMutAct_9fa48("759") ? true : (stryCov_9fa48("759"), false),
              reason: stryMutAct_9fa48("760") ? `` : (stryCov_9fa48("760"), `global flag not permitted: ${flag}`)
            });
          }
        }
        stryMutAct_9fa48("761") ? i-- : (stryCov_9fa48("761"), i++);
      }
    }
    const sub = argv[i];
    if (stryMutAct_9fa48("764") ? false : stryMutAct_9fa48("763") ? true : stryMutAct_9fa48("762") ? sub : (stryCov_9fa48("762", "763", "764"), !sub)) return stryMutAct_9fa48("765") ? {} : (stryCov_9fa48("765"), {
      allowed: stryMutAct_9fa48("766") ? true : (stryCov_9fa48("766"), false),
      reason: stryMutAct_9fa48("767") ? "" : (stryCov_9fa48("767"), 'no subcommand')
    });
    const rest = stryMutAct_9fa48("768") ? argv : (stryCov_9fa48("768"), argv.slice(stryMutAct_9fa48("769") ? i - 1 : (stryCov_9fa48("769"), i + 1)));

    // MUTATE tier — only reachable with an explicit opt-in from a mutating grove command.
    if (stryMutAct_9fa48("771") ? false : stryMutAct_9fa48("770") ? true : (stryCov_9fa48("770", "771"), allowMutation)) {
      if (stryMutAct_9fa48("772")) {
        {}
      } else {
        stryCov_9fa48("772");
        if (stryMutAct_9fa48("774") ? false : stryMutAct_9fa48("773") ? true : (stryCov_9fa48("773", "774"), MUTATE_COMMANDS.has(sub))) return stryMutAct_9fa48("775") ? {} : (stryCov_9fa48("775"), {
          allowed: stryMutAct_9fa48("776") ? false : (stryCov_9fa48("776"), true),
          tier: stryMutAct_9fa48("777") ? "" : (stryCov_9fa48("777"), 'MUTATE')
        });
        const mutable = MUTATE_SUBVERBS[sub];
        if (stryMutAct_9fa48("780") ? mutable || rest.some(t => mutable.has(t.split('=')[0])) : stryMutAct_9fa48("779") ? false : stryMutAct_9fa48("778") ? true : (stryCov_9fa48("778", "779", "780"), mutable && (stryMutAct_9fa48("781") ? rest.every(t => mutable.has(t.split('=')[0])) : (stryCov_9fa48("781"), rest.some(stryMutAct_9fa48("782") ? () => undefined : (stryCov_9fa48("782"), t => mutable.has(t.split(stryMutAct_9fa48("783") ? "" : (stryCov_9fa48("783"), '='))[0]))))))) {
          if (stryMutAct_9fa48("784")) {
            {}
          } else {
            stryCov_9fa48("784");
            return stryMutAct_9fa48("785") ? {} : (stryCov_9fa48("785"), {
              allowed: stryMutAct_9fa48("786") ? false : (stryCov_9fa48("786"), true),
              tier: stryMutAct_9fa48("787") ? "" : (stryCov_9fa48("787"), 'MUTATE')
            });
          }
        }
      }
    }
    const forbidden = FORBIDDEN_SUBVERBS[sub];
    if (stryMutAct_9fa48("789") ? false : stryMutAct_9fa48("788") ? true : (stryCov_9fa48("788", "789"), forbidden)) {
      if (stryMutAct_9fa48("790")) {
        {}
      } else {
        stryCov_9fa48("790");
        for (const token of rest) {
          if (stryMutAct_9fa48("791")) {
            {}
          } else {
            stryCov_9fa48("791");
            const bare = token.split(stryMutAct_9fa48("792") ? "" : (stryCov_9fa48("792"), '='))[0];
            if (stryMutAct_9fa48("794") ? false : stryMutAct_9fa48("793") ? true : (stryCov_9fa48("793", "794"), forbidden.has(bare))) {
              if (stryMutAct_9fa48("795")) {
                {}
              } else {
                stryCov_9fa48("795");
                return stryMutAct_9fa48("796") ? {} : (stryCov_9fa48("796"), {
                  allowed: stryMutAct_9fa48("797") ? true : (stryCov_9fa48("797"), false),
                  reason: (stryMutAct_9fa48("798") ? `` : (stryCov_9fa48("798"), `'git ${sub} ${bare}' mutates the repository`)) + ((stryMutAct_9fa48("799") ? MUTATE_SUBVERBS[sub].has(bare) : (stryCov_9fa48("799"), MUTATE_SUBVERBS[sub]?.has(bare))) ? stryMutAct_9fa48("800") ? "" : (stryCov_9fa48("800"), ' (needs an explicit mutating grove command)') : stryMutAct_9fa48("801") ? "Stryker was here!" : (stryCov_9fa48("801"), ''))
                });
              }
            }
          }
        }
      }
    }

    // Positional-count check — the only way to tell `config <key>` from `config <key> <value>`.
    const limit = POSITIONAL_LIMITS[sub];
    if (stryMutAct_9fa48("804") ? limit === undefined : stryMutAct_9fa48("803") ? false : stryMutAct_9fa48("802") ? true : (stryCov_9fa48("802", "803", "804"), limit !== undefined)) {
      if (stryMutAct_9fa48("805")) {
        {}
      } else {
        stryCov_9fa48("805");
        let positionals = 0;
        let afterDoubleDash = stryMutAct_9fa48("806") ? true : (stryCov_9fa48("806"), false);
        for (const token of rest) {
          if (stryMutAct_9fa48("807")) {
            {}
          } else {
            stryCov_9fa48("807");
            if (stryMutAct_9fa48("810") ? token !== '--' : stryMutAct_9fa48("809") ? false : stryMutAct_9fa48("808") ? true : (stryCov_9fa48("808", "809", "810"), token === (stryMutAct_9fa48("811") ? "" : (stryCov_9fa48("811"), '--')))) {
              if (stryMutAct_9fa48("812")) {
                {}
              } else {
                stryCov_9fa48("812");
                afterDoubleDash = stryMutAct_9fa48("813") ? false : (stryCov_9fa48("813"), true);
                continue;
              }
            }
            if (stryMutAct_9fa48("816") ? !afterDoubleDash || token.startsWith('-') : stryMutAct_9fa48("815") ? false : stryMutAct_9fa48("814") ? true : (stryCov_9fa48("814", "815", "816"), (stryMutAct_9fa48("817") ? afterDoubleDash : (stryCov_9fa48("817"), !afterDoubleDash)) && (stryMutAct_9fa48("818") ? token.endsWith('-') : (stryCov_9fa48("818"), token.startsWith(stryMutAct_9fa48("819") ? "" : (stryCov_9fa48("819"), '-')))))) continue;
            stryMutAct_9fa48("820") ? positionals-- : (stryCov_9fa48("820"), positionals++);
          }
        }
        if (stryMutAct_9fa48("824") ? positionals <= limit : stryMutAct_9fa48("823") ? positionals >= limit : stryMutAct_9fa48("822") ? false : stryMutAct_9fa48("821") ? true : (stryCov_9fa48("821", "822", "823", "824"), positionals > limit)) {
          if (stryMutAct_9fa48("825")) {
            {}
          } else {
            stryCov_9fa48("825");
            return stryMutAct_9fa48("826") ? {} : (stryCov_9fa48("826"), {
              allowed: stryMutAct_9fa48("827") ? true : (stryCov_9fa48("827"), false),
              reason: stryMutAct_9fa48("828") ? `` : (stryCov_9fa48("828"), `'git ${sub}' with ${positionals} positional argument(s) is a WRITE form (read form takes at most ${limit})`)
            });
          }
        }
      }
    }
    if (stryMutAct_9fa48("830") ? false : stryMutAct_9fa48("829") ? true : (stryCov_9fa48("829", "830"), OBJECT_WRITE.has(sub))) return stryMutAct_9fa48("831") ? {} : (stryCov_9fa48("831"), {
      allowed: stryMutAct_9fa48("832") ? false : (stryCov_9fa48("832"), true),
      tier: stryMutAct_9fa48("833") ? "" : (stryCov_9fa48("833"), 'OBJECT_WRITE')
    });
    if (stryMutAct_9fa48("835") ? false : stryMutAct_9fa48("834") ? true : (stryCov_9fa48("834", "835"), SAFE.has(sub))) return stryMutAct_9fa48("836") ? {} : (stryCov_9fa48("836"), {
      allowed: stryMutAct_9fa48("837") ? false : (stryCov_9fa48("837"), true),
      tier: stryMutAct_9fa48("838") ? "" : (stryCov_9fa48("838"), 'SAFE')
    });
    return stryMutAct_9fa48("839") ? {} : (stryCov_9fa48("839"), {
      allowed: stryMutAct_9fa48("840") ? true : (stryCov_9fa48("840"), false),
      reason: stryMutAct_9fa48("841") ? `` : (stryCov_9fa48("841"), `'git ${sub}' is not on grove's allowlist`)
    });
  }
}
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = stryMutAct_9fa48("842") ? 64 * 1024 / 1024 : (stryCov_9fa48("842"), (stryMutAct_9fa48("843") ? 64 / 1024 : (stryCov_9fa48("843"), 64 * 1024)) * 1024);

/**
 * Run git. Rejects on refusal; resolves {stdout, stderr, code} otherwise.
 * Non-zero exit is NOT automatically an error — many git reads use exit codes as answers
 * (merge-tree returns 1 on conflict, diff --quiet returns 1 on difference). Callers decide.
 */
export function git(argv, {
  cwd,
  timeout = DEFAULT_TIMEOUT_MS,
  allowObjectWrite = stryMutAct_9fa48("844") ? false : (stryCov_9fa48("844"), true),
  allowMutation = stryMutAct_9fa48("845") ? true : (stryCov_9fa48("845"), false),
  env
} = {}) {
  if (stryMutAct_9fa48("846")) {
    {}
  } else {
    stryCov_9fa48("846");
    const verdict = classify(argv, stryMutAct_9fa48("847") ? {} : (stryCov_9fa48("847"), {
      allowMutation
    }));
    if (stryMutAct_9fa48("850") ? false : stryMutAct_9fa48("849") ? true : stryMutAct_9fa48("848") ? verdict.allowed : (stryCov_9fa48("848", "849", "850"), !verdict.allowed)) {
      if (stryMutAct_9fa48("851")) {
        {}
      } else {
        stryCov_9fa48("851");
        return Promise.reject(new GitRefused(stryMutAct_9fa48("852") ? `` : (stryCov_9fa48("852"), `grove refused to run \`git ${argv.join(stryMutAct_9fa48("853") ? "" : (stryCov_9fa48("853"), ' '))}\`: ${verdict.reason}`)));
      }
    }
    if (stryMutAct_9fa48("856") ? verdict.tier === 'OBJECT_WRITE' || !allowObjectWrite : stryMutAct_9fa48("855") ? false : stryMutAct_9fa48("854") ? true : (stryCov_9fa48("854", "855", "856"), (stryMutAct_9fa48("858") ? verdict.tier !== 'OBJECT_WRITE' : stryMutAct_9fa48("857") ? true : (stryCov_9fa48("857", "858"), verdict.tier === (stryMutAct_9fa48("859") ? "" : (stryCov_9fa48("859"), 'OBJECT_WRITE')))) && (stryMutAct_9fa48("860") ? allowObjectWrite : (stryCov_9fa48("860"), !allowObjectWrite)))) {
      if (stryMutAct_9fa48("861")) {
        {}
      } else {
        stryCov_9fa48("861");
        return Promise.reject(new GitRefused(stryMutAct_9fa48("862") ? `` : (stryCov_9fa48("862"), `grove refused \`git ${argv[0]}\`: it writes unreferenced objects and strictReadOnly is set`)));
      }
    }
    return new Promise((resolve, reject) => {
      if (stryMutAct_9fa48("863")) {
        {}
      } else {
        stryCov_9fa48("863");
        execFile(stryMutAct_9fa48("864") ? "" : (stryCov_9fa48("864"), 'git'), argv, stryMutAct_9fa48("865") ? {} : (stryCov_9fa48("865"), {
          cwd,
          timeout,
          maxBuffer: DEFAULT_MAX_BUFFER,
          // Keep git deterministic and non-interactive. A prompt would hang the scan.
          env: stryMutAct_9fa48("866") ? {} : (stryCov_9fa48("866"), {
            ...process.env,
            ...env,
            GIT_TERMINAL_PROMPT: stryMutAct_9fa48("867") ? "" : (stryCov_9fa48("867"), '0'),
            GIT_OPTIONAL_LOCKS: stryMutAct_9fa48("868") ? "" : (stryCov_9fa48("868"), '0'),
            GIT_PAGER: stryMutAct_9fa48("869") ? "" : (stryCov_9fa48("869"), 'cat'),
            LC_ALL: stryMutAct_9fa48("870") ? "" : (stryCov_9fa48("870"), 'C')
          })
        }), (err, stdout, stderr) => {
          if (stryMutAct_9fa48("871")) {
            {}
          } else {
            stryCov_9fa48("871");
            if (stryMutAct_9fa48("874") ? err || err.killed : stryMutAct_9fa48("873") ? false : stryMutAct_9fa48("872") ? true : (stryCov_9fa48("872", "873", "874"), err && err.killed)) {
              if (stryMutAct_9fa48("875")) {
                {}
              } else {
                stryCov_9fa48("875");
                reject(new GitFailed(stryMutAct_9fa48("876") ? `` : (stryCov_9fa48("876"), `git ${argv[0]} timed out after ${timeout}ms`), stryMutAct_9fa48("877") ? {} : (stryCov_9fa48("877"), {
                  argv,
                  stderr
                })));
                return;
              }
            }
            if (stryMutAct_9fa48("880") ? err || typeof err.code !== 'number' : stryMutAct_9fa48("879") ? false : stryMutAct_9fa48("878") ? true : (stryCov_9fa48("878", "879", "880"), err && (stryMutAct_9fa48("882") ? typeof err.code === 'number' : stryMutAct_9fa48("881") ? true : (stryCov_9fa48("881", "882"), typeof err.code !== (stryMutAct_9fa48("883") ? "" : (stryCov_9fa48("883"), 'number')))))) {
              if (stryMutAct_9fa48("884")) {
                {}
              } else {
                stryCov_9fa48("884");
                reject(new GitFailed(stryMutAct_9fa48("885") ? `` : (stryCov_9fa48("885"), `git ${argv[0]} failed to spawn: ${err.message}`), stryMutAct_9fa48("886") ? {} : (stryCov_9fa48("886"), {
                  argv,
                  stderr
                })));
                return;
              }
            }
            resolve(stryMutAct_9fa48("887") ? {} : (stryCov_9fa48("887"), {
              stdout: stryMutAct_9fa48("888") ? stdout && '' : (stryCov_9fa48("888"), stdout ?? (stryMutAct_9fa48("889") ? "Stryker was here!" : (stryCov_9fa48("889"), ''))),
              stderr: stryMutAct_9fa48("890") ? stderr && '' : (stryCov_9fa48("890"), stderr ?? (stryMutAct_9fa48("891") ? "Stryker was here!" : (stryCov_9fa48("891"), ''))),
              code: err ? err.code : 0
            }));
          }
        });
      }
    });
  }
}

/** Run git and throw if it exits non-zero. For calls where non-zero genuinely is a failure. */
export async function gitOk(argv, opts) {
  if (stryMutAct_9fa48("892")) {
    {}
  } else {
    stryCov_9fa48("892");
    const r = await git(argv, opts);
    if (stryMutAct_9fa48("895") ? r.code === 0 : stryMutAct_9fa48("894") ? false : stryMutAct_9fa48("893") ? true : (stryCov_9fa48("893", "894", "895"), r.code !== 0)) {
      if (stryMutAct_9fa48("896")) {
        {}
      } else {
        stryCov_9fa48("896");
        throw new GitFailed(stryMutAct_9fa48("897") ? `` : (stryCov_9fa48("897"), `git ${argv.join(stryMutAct_9fa48("898") ? "" : (stryCov_9fa48("898"), ' '))} exited ${r.code}: ${stryMutAct_9fa48("899") ? r.stderr : (stryCov_9fa48("899"), r.stderr.trim())}`), stryMutAct_9fa48("900") ? {} : (stryCov_9fa48("900"), {
          code: r.code,
          stderr: r.stderr,
          argv
        }));
      }
    }
    return r;
  }
}

/** Split git output on NUL. Used with -z forms so filenames with newlines survive. */
export function splitNul(s) {
  if (stryMutAct_9fa48("901")) {
    {}
  } else {
    stryCov_9fa48("901");
    return stryMutAct_9fa48("902") ? s.split('\0') : (stryCov_9fa48("902"), s.split(stryMutAct_9fa48("903") ? "" : (stryCov_9fa48("903"), '\0')).filter(stryMutAct_9fa48("904") ? () => undefined : (stryCov_9fa48("904"), x => stryMutAct_9fa48("908") ? x.length <= 0 : stryMutAct_9fa48("907") ? x.length >= 0 : stryMutAct_9fa48("906") ? false : stryMutAct_9fa48("905") ? true : (stryCov_9fa48("905", "906", "907", "908"), x.length > 0))));
  }
}

/** Split on newlines, dropping empties. */
export function splitLines(s) {
  if (stryMutAct_9fa48("909")) {
    {}
  } else {
    stryCov_9fa48("909");
    return stryMutAct_9fa48("910") ? s.split('\n').map(l => l.replace(/\r$/, '')) : (stryCov_9fa48("910"), s.split(stryMutAct_9fa48("911") ? "" : (stryCov_9fa48("911"), '\n')).map(stryMutAct_9fa48("912") ? () => undefined : (stryCov_9fa48("912"), l => l.replace(stryMutAct_9fa48("913") ? /\r/ : (stryCov_9fa48("913"), /\r$/), stryMutAct_9fa48("914") ? "Stryker was here!" : (stryCov_9fa48("914"), '')))).filter(stryMutAct_9fa48("915") ? () => undefined : (stryCov_9fa48("915"), l => stryMutAct_9fa48("919") ? l.length <= 0 : stryMutAct_9fa48("918") ? l.length >= 0 : stryMutAct_9fa48("917") ? false : stryMutAct_9fa48("916") ? true : (stryCov_9fa48("916", "917", "918", "919"), l.length > 0))));
  }
}

/**
 * Bounded-concurrency map. The scan fans out over N workstreams; without a bound,
 * 500 worktrees would fork 500 git processes at once and thrash the box.
 */
export async function pmap(items, fn, concurrency = 8) {
  if (stryMutAct_9fa48("920")) {
    {}
  } else {
    stryCov_9fa48("920");
    const out = stryMutAct_9fa48("921") ? new Array() : (stryCov_9fa48("921"), new Array(items.length));
    let next = 0;
    const workers = Array.from(stryMutAct_9fa48("922") ? {} : (stryCov_9fa48("922"), {
      length: stryMutAct_9fa48("923") ? Math.min(1, Math.min(concurrency, items.length)) : (stryCov_9fa48("923"), Math.max(1, stryMutAct_9fa48("924") ? Math.max(concurrency, items.length) : (stryCov_9fa48("924"), Math.min(concurrency, items.length))))
    }), async () => {
      if (stryMutAct_9fa48("925")) {
        {}
      } else {
        stryCov_9fa48("925");
        if (stryMutAct_9fa48("926")) {
          for (; false;) {
            const i = next++;
            if (i >= items.length) return;
            out[i] = await fn(items[i], i);
          }
        } else {
          stryCov_9fa48("926");
          for (;;) {
            if (stryMutAct_9fa48("927")) {
              {}
            } else {
              stryCov_9fa48("927");
              const i = stryMutAct_9fa48("928") ? next-- : (stryCov_9fa48("928"), next++);
              if (stryMutAct_9fa48("932") ? i < items.length : stryMutAct_9fa48("931") ? i > items.length : stryMutAct_9fa48("930") ? false : stryMutAct_9fa48("929") ? true : (stryCov_9fa48("929", "930", "931", "932"), i >= items.length)) return;
              out[i] = await fn(items[i], i);
            }
          }
        }
      }
    });
    await Promise.all(workers);
    return out;
  }
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
  if (stryMutAct_9fa48("933")) {
    {}
  } else {
    stryCov_9fa48("933");
    try {
      if (stryMutAct_9fa48("934")) {
        {}
      } else {
        stryCov_9fa48("934");
        const common = await git(stryMutAct_9fa48("935") ? [] : (stryCov_9fa48("935"), [stryMutAct_9fa48("936") ? "" : (stryCov_9fa48("936"), 'rev-parse'), stryMutAct_9fa48("937") ? "" : (stryCov_9fa48("937"), '--path-format=absolute'), stryMutAct_9fa48("938") ? "" : (stryCov_9fa48("938"), '--git-common-dir')]), stryMutAct_9fa48("939") ? {} : (stryCov_9fa48("939"), {
          cwd
        }));
        if (stryMutAct_9fa48("942") ? common.code !== 0 : stryMutAct_9fa48("941") ? false : stryMutAct_9fa48("940") ? true : (stryCov_9fa48("940", "941", "942"), common.code === 0)) {
          if (stryMutAct_9fa48("943")) {
            {}
          } else {
            stryCov_9fa48("943");
            const gitDir = stryMutAct_9fa48("944") ? common.stdout : (stryCov_9fa48("944"), common.stdout.trim());
            if (stryMutAct_9fa48("946") ? false : stryMutAct_9fa48("945") ? true : (stryCov_9fa48("945", "946"), gitDir)) {
              if (stryMutAct_9fa48("947")) {
                {}
              } else {
                stryCov_9fa48("947");
                // Normal repo: <main>/.git  ·  bare or unusual layouts: fall through to toplevel.
                const base = gitDir.replace(stryMutAct_9fa48("949") ? /\/$/ : stryMutAct_9fa48("948") ? /\/+/ : (stryCov_9fa48("948", "949"), /\/+$/), stryMutAct_9fa48("950") ? "Stryker was here!" : (stryCov_9fa48("950"), ''));
                if (stryMutAct_9fa48("953") ? base.startsWith('/.git') : stryMutAct_9fa48("952") ? false : stryMutAct_9fa48("951") ? true : (stryCov_9fa48("951", "952", "953"), base.endsWith(stryMutAct_9fa48("954") ? "" : (stryCov_9fa48("954"), '/.git')))) return stryMutAct_9fa48("955") ? base : (stryCov_9fa48("955"), base.slice(0, stryMutAct_9fa48("956") ? +'/.git'.length : (stryCov_9fa48("956"), -(stryMutAct_9fa48("957") ? "" : (stryCov_9fa48("957"), '/.git')).length)));
              }
            }
          }
        }
        const r = await git(stryMutAct_9fa48("958") ? [] : (stryCov_9fa48("958"), [stryMutAct_9fa48("959") ? "" : (stryCov_9fa48("959"), 'rev-parse'), stryMutAct_9fa48("960") ? "" : (stryCov_9fa48("960"), '--show-toplevel')]), stryMutAct_9fa48("961") ? {} : (stryCov_9fa48("961"), {
          cwd
        }));
        if (stryMutAct_9fa48("964") ? r.code === 0 : stryMutAct_9fa48("963") ? false : stryMutAct_9fa48("962") ? true : (stryCov_9fa48("962", "963", "964"), r.code !== 0)) return null;
        const p = stryMutAct_9fa48("965") ? r.stdout : (stryCov_9fa48("965"), r.stdout.trim());
        return (stryMutAct_9fa48("969") ? p.length <= 0 : stryMutAct_9fa48("968") ? p.length >= 0 : stryMutAct_9fa48("967") ? false : stryMutAct_9fa48("966") ? true : (stryCov_9fa48("966", "967", "968", "969"), p.length > 0)) ? p : null;
      }
    } catch {
      if (stryMutAct_9fa48("970")) {
        {}
      } else {
        stryCov_9fa48("970");
        return null;
      }
    }
  }
}

/** Resolve a ref to a full oid, or null if it does not resolve. */
export async function resolveRef(cwd, ref) {
  if (stryMutAct_9fa48("971")) {
    {}
  } else {
    stryCov_9fa48("971");
    const r = await git(stryMutAct_9fa48("972") ? [] : (stryCov_9fa48("972"), [stryMutAct_9fa48("973") ? "" : (stryCov_9fa48("973"), 'rev-parse'), stryMutAct_9fa48("974") ? "" : (stryCov_9fa48("974"), '--verify'), stryMutAct_9fa48("975") ? "" : (stryCov_9fa48("975"), '--quiet'), stryMutAct_9fa48("976") ? `` : (stryCov_9fa48("976"), `${ref}^{commit}`)]), stryMutAct_9fa48("977") ? {} : (stryCov_9fa48("977"), {
      cwd
    }));
    if (stryMutAct_9fa48("980") ? r.code === 0 : stryMutAct_9fa48("979") ? false : stryMutAct_9fa48("978") ? true : (stryCov_9fa48("978", "979", "980"), r.code !== 0)) return null;
    const oid = stryMutAct_9fa48("981") ? r.stdout : (stryCov_9fa48("981"), r.stdout.trim());
    return (stryMutAct_9fa48("984") ? oid.length === 40 && oid.length === 64 : stryMutAct_9fa48("983") ? false : stryMutAct_9fa48("982") ? true : (stryCov_9fa48("982", "983", "984"), (stryMutAct_9fa48("986") ? oid.length !== 40 : stryMutAct_9fa48("985") ? false : (stryCov_9fa48("985", "986"), oid.length === 40)) || (stryMutAct_9fa48("988") ? oid.length !== 64 : stryMutAct_9fa48("987") ? false : (stryCov_9fa48("987", "988"), oid.length === 64)))) ? oid : null;
  }
}