#!/usr/bin/env node
// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — CLI.
 *
 * holt never writes to the repository it inspects. See src/git.mjs for the enforced
 * contract and test/unit/safety.test.mjs for the proof.
 */

import process from 'node:process';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discover, repoAbsenceError } from '../src/discover.mjs';
import { scan } from '../src/scan.mjs';
import { analyze, contextDigest } from '../src/analyze.mjs';
import { deepDuplicates, detectJscpd } from '../src/deep.mjs';
import { detectCtags, detectEnry, languageCoverage } from '../src/symbols.mjs';
import { classify } from '../src/git.mjs';
import {
  renderSummary, renderRisk, renderCollisions, renderDuplicates,
  renderPlan, renderContext, renderImpact, paint,
} from '../src/render.mjs';
import { renderHtml } from '../src/graph-html.mjs';
import { renderClusters } from '../src/ascii-graph.mjs';
import { assessCommand, buildBrief, cachedReport } from '../src/agent.mjs';
import { impact, detectRipgrep } from '../src/impact.mjs';
import {
  integrate, uninstall, detectHosts, hostsReport, formatVerdict, formatContext, mcpTargets,
} from '../src/integrate/adapters.mjs';
import { protect, unprotect, rescue, rescues, clean, discard, auto } from '../src/actions.mjs';
import { verifyPair } from '../src/verify.mjs';
import { runTui } from '../src/tui.mjs';
import { landingOrder } from '../src/order.mjs';
import { branchAudit } from '../src/branches.mjs';
import { partitionPlan } from '../src/partition.mjs';
import { readJournal, appendEvent } from '../src/journal.mjs';
import { summarizeJournal } from '../src/roi.mjs';
import { git, listTrackedFiles } from '../src/git.mjs';
import { checkEntitlement, licenseStatus, activateLicense, deactivateLicense, LicenseError } from '../src/license.mjs';
import { loadPolicy, loadPolicyFrom, evaluatePolicy } from '../src/team/policy.mjs';
import { fleetScan } from '../src/team/fleet.mjs';
import { loadConfig, ConfigError } from '../src/config.mjs';
import { stashState, describeStash } from '../src/stash.mjs';

// Commands where a config error must NEVER kill the process. The principle is universal:
// config tunes HEURISTICS (family grouping, maintenance nagging) — it never changes the
// content-identity safety contract. A broken config file is a user error, and the right
// response to a user error is a WARNING and defaults, not a dead guard.
//
// The split is NOT "safety-critical vs informational" — it is "can this command's failure
// cause work to be lost or the guard to be bypassed?" If yes, config errors are non-fatal.
// If no (pure display commands like status, graph, brief), config errors fail loudly so
// the user knows their config is broken.
//
// Falls back to defaults for: every command that PROTECTS, GATES, RESCUES, or REMOVES work.
// Fails loudly for: pure display/reporting commands.
const CONFIG_NON_FATAL = new Set([
  'hook',           // the guard itself — dying here leaves the agent unprotected
  'gate',           // pre-destruction gate — dying here could let a destructive command through
  'rescue',         // captures work before destruction
  'doctor',         // health check
  'context',        // sibling awareness — agent relies on this to avoid duplicate work
  'protect',        // places locks — dying here leaves work unprotected
  'unprotect',      // releases locks
  'auto',           // auto-protect
  'clean',          // removes worktrees (re-verifies; defaults are MORE conservative, not less)
  'discard',        // discards paths
  'verify',         // verifies workstream pairs
  'rescued',        // lists rescues
  'mcp',            // MCP server — agent relies on this for decisions
]);

const USAGE = `
holt — know what your agents made, and don't lose any of it

USAGE
  holt [command] [options]

COMMANDS
  status              what your workstreams produced and what to do about it  (default)
  risk                unique work and what is provably safe to delete          (P0, P6)
  collisions          workstream pairs that will fight                         (P1)
  duplicates          pairs that built the same thing  [--deep]                (P3)
  context <id>        what an agent in <id> needs to know about its siblings   (P2)
  plan                drop / collapse / land-in-this-order                     (P5)
  impact              who DEPENDS on what another workstream changed  (not a conflict check)
  order               landing order: parallel lanes + min-entanglement sequence
  partition           pre-flight split for N agents  [--agents <n>]   (collision-free start map)
  branches            the branch graveyard: landed / content-landed / unlanded  [--apply]
  journal             audit trail of every protect / unprotect / rescue / clean / branch-delete,
                      each stamped with WHO (user, host, agent session when one is declared)
                      --summary: the ROI view — losses prevented, hours saved
  fleet <dir>...      every repository under <dir>: where work sits unlanded   [team]
  license             activate | status | deactivate  (team/enterprise features)
  ci                  team gate for CI: fail a merge that abandons work
                      [--fail-on-unlanded] [--max-age-days <n>] [--ignore <branch>]...
                      (needs full refs: actions/checkout fetch-depth: 0)
  graph               the relationship graph  [--html <file>]
  stash               stash entries holding work no ref has  [--json]
  gate <id>           exit non-zero if <id> holds unique work   (pre-delete hook)
  tui                 interactive risk-sorted dashboard  [--snapshot]
  setup               ONE-COMMAND FIRST RUN: install backends, wire agents, show what is at risk
  doctor              environment and backend check  [--install [--yes]]

ACTING  (these MUTATE the repo; everything above is read-only)
  auto                do everything that cannot lose data, and report what needs you
                      locks what is at risk, releases locks no longer justified, and hands
                      the destructive half over WITH the evidence — it never deletes
  protect             git-lock every workstream holding unique work   [--dry-run]
                      a locked worktree REFUSES 'git worktree remove --force'
  unprotect [<id>]    release holt's locks (never touches locks it did not place)
                      a lock holt did not place needs  --force  plus  --reason "<why>"
                      (or --yes to confirm without writing one) — the override is journalled
  rescue <id>         capture unique work to a verifiable ref  [--release] [--dry-run]
                      exits non-zero if the capture cannot be verified
  rescued             list every rescue taken in this repo
  clean               remove provably-disposable worktrees + branches  [--apply]
  discard <path>...   delete something holt is guarding, capturing it first  [--dry-run]
                      the escape hatch: content goes to refs/holt/discard/* and is VERIFIED
                      before anything is removed, so the guard stays on and the loss does not
  verify <a> <b>      run YOUR test suite on A alone, B alone, and A+B merged; report
                      only what the COMBINATION breaks  [--run "<cmd>"]  (executes code)

AGENT INTEGRATION
  hosts               coverage matrix: every known agent host + the strength holt gives it
  integrate           wire holt into every agent found here (AGENTS.md + MCP + hooks)
                      re-run any time — upgrade-safe: reconciles entries from any prior version
                      in place and reports what it changed, rather than only adding  [--remove]
  uninstall           the other half of integrate: remove every hook/MCP entry holt wrote here
                      (alias for integrate --remove) — run BEFORE removing the holt package, or
                      every agent wired to it is left pointing at a binary that is gone
  brief               plain-text sibling-workstream briefing for any agent
  mcp                 run as an MCP server over stdio
  hook <event>        hook entry point; reads the host event as JSON on stdin
                      events: pre-tool-use · session-start · user-prompt-submit · stop · session-end
                      --host claude-code|cursor|devin|generic   --command <cmd>
                      --autoprotect: session-start also locks at-risk workstreams first
                      (holt integrate wires this — zero-touch protection at every session)

OPTIONS
  --json              machine-readable output
  --export <fmt>      journal: json | csv  (your own repo log — free)
  --all               collisions: also show bare file overlap (hidden by default: it is
                      high-volume and low-evidence; landing order always uses it)
  --max-depth <n>     fleet: directory depth to search for repositories (default 3)
  --base <ref>        compare against <ref>            (default: origin/HEAD, then main/master…)
  --family-window <s> seconds within which workstreams created close together count as one dispatch (default: 3600)
  --cwd <path>        repository to inspect            (default: cwd)
  --no-symbols        skip symbol extraction (faster, file-level only)
  --strict-read-only  never write objects; committed deltas become APPROXIMATE
  --concurrency <n>   parallel git operations          (default: 8)
  --include-primary   also scan the primary worktree
  --deep              duplicates: additionally run jscpd token clone detection
  --html <file>       graph: write an interactive HTML graph
  --global            integrate: ALSO add holt to user-level editor configs.
                      Default is project scope — nothing outside the repo is touched.
  --remove            integrate: remove everything holt wrote here instead of installing it
                      (same as holt uninstall)
  --force             unprotect: also release a lock holt did not place
                      (needs --reason or --yes; without one, refused before anything changes)
  --reason <text>     unprotect --force: why the override is happening — journalled verbatim
  --yes, -y           confirm an action non-interactively (unprotect --force; doctor --install)
  -h, --help          this
  -v, --version       print the version and exit
  --verbose           show progress during long operations (discover/scan/analyze)
  --debug             print stack traces on unexpected errors (default: message only)
  --quiet             suppress non-essential output (headers, tips)
  --plain             force human-readable output for action commands (default: JSON when piped)

CONFIG (optional — see README.md#configuration)
  .holtrc.json        in the repository root: familyOverrides, maintenanceFloor, maintenanceRatio
                      absent is fine; present-and-invalid is a hard error (exit 2), never silent

QUICK START
  holt setup                     # first run: install backends, wire agents, show what's at risk
  holt status                    # see what your workstreams produced
  holt risk                      # find work that exists nowhere else
  holt clean                     # see what's disposable (dry-run; add --apply to remove)
  holt gate <id>                 # pre-delete check: exit 0 = safe, 1 = holds unique work, 2 = unknown
  holt protect                   # lock at-risk worktrees so 'git worktree remove --force' refuses

Full documentation: https://raed2180416.github.io/holt/
`;

function parseArgs(argv) {
  const opts = {
    _: [], json: false, base: null, cwd: process.cwd(), symbols: true,
    strictReadOnly: false, concurrency: 8, includePrimary: false,
    deep: false, html: null, help: false,
    host: 'generic', command: null, bin: 'holt', global: false,
    dryRun: false, apply: false, release: false, force: false, reason: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--json': opts.json = true; break;
      case '--no-symbols': opts.symbols = false; break;
      case '--strict-read-only': opts.strictReadOnly = true; break;
      case '--include-primary': opts.includePrimary = true; break;
      case '--global': opts.global = true; break;
      case '--deep': opts.deep = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--apply': opts.apply = true; break;
      case '--release': opts.release = true; break;
      case '--force': opts.force = true; break;
      case '--reason': opts.reason = argv[++i]; break;
      case '--run': opts.run = argv[++i]; break;
      case '--agents': opts.agents = Number(argv[++i]) || 2; break;
      case '--autoprotect': opts.autoprotect = true; break;
      case '--export': opts.exportFmt = argv[++i]; break;
      case '--summary': opts.summary = true; break;
      case '--all': opts.includeCoLocated = true; break;
      case '--install': opts.install = true; break;
      case '--yes': case '-y': opts.yes = true; break;
      case '--max-depth': opts.maxDepth = Number(argv[++i]) || 3; break;
      case '--fail-on-unlanded': opts.failOnUnlanded = true; break;
      case '--max-age-days': opts.maxAgeDays = Number(argv[++i]) || null; break;
      case '--ignore': (opts.ignore ??= []).push(argv[++i]); break;
      case '--snapshot': opts.snapshot = true; break;
      case '--columns': opts.columns = Number(argv[++i]) || 120; break;
      case '--rows': opts.rowsOpt = Number(argv[++i]) || 34; break;
      case '-h': case '--help': opts.help = true; break;
      case '-v': case '-V': case '--version': opts.version = true; break;
      case '--base': opts.base = argv[++i]; break;
      case '--family-window': {
        const s = Number(argv[++i]);
        // `|| 300` swallowed 0 (a valid "no window" value) and NaN. A NaN or negative is a user
        // error; 0 is a deliberate "every workstream is its own family". Help text says SECONDS.
        opts.familyWindowMs = (Number.isFinite(s) && s >= 0 ? s : 3600) * 1000;
        break;
      }
      case '--cwd': opts.cwd = argv[++i]; break;
      case '--html': opts.html = argv[++i]; break;
      case '--host': opts.host = argv[++i]; break;
      case '--command': opts.command = argv[++i]; break;
      case '--bin': opts.bin = argv[++i]; break;
      case '--remove': opts.remove = true; break;
      case '--concurrency': opts.concurrency = Number(argv[++i]) || 8; break;
      case '--verbose': opts.verbose = true; break;
      case '--debug': opts.debug = true; break;
      case '--quiet': opts.quiet = true; break;
      case '--plain': opts.plain = true; break;
      default:
        if (a.startsWith('--')) throw new Error(`unknown option: ${a}\n  Run 'holt --help' for valid options.`);
        opts._.push(a);
    }
  }
  return opts;
}

// Piping any command into `head`, `less` or `grep -m1` closes stdout early. Without this the
// process dies with an unhandled EPIPE and prints a Node-internals stack trace — a bad look for
// the most ordinary shell idiom there is.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (e) => { if (e?.code === 'EPIPE') process.exit(0); throw e; });
}

function out(s) { process.stdout.write(s.endsWith('\n') ? s : `${s}\n`); }
function emitJson(v) { out(JSON.stringify(v, null, 2)); }

/**
 * One scan per invocation. Commands that need the raw scan (context, deep duplicates) get it
 * from here rather than re-running git — a second scan would also risk disagreeing with the
 * first if a worktree changed underneath us mid-command.
 */
async function buildReport(opts) {
  const verbose = opts.verbose || process.argv.includes('--verbose');
  const stderr = (s) => { if (verbose) process.stderr.write(s); };
  stderr('holt: discovering workstreams...\n');
  const disc = await discover(opts.cwd, opts);
  if (!disc.root) {
    const { message } = repoAbsenceError(disc, opts.cwd);
    process.stderr.write(paint('red', `holt: ${message}\n`));
    process.exit(2);
  }
  stderr(`holt: ${disc.worktrees?.length ?? 0} workstreams found, scanning...\n`);
  const scanned = await scan(disc, opts);
  stderr(`holt: scan complete (${scanned.workstreams?.length ?? 0} scanned), analyzing...\n`);
  const report = await analyze(scanned, opts);
  stderr('holt: analysis complete.\n');
  return { report, scanned };
}

/**
 * Render an action result. JSON for scripts/agents (default), human-readable prose when a
 * human is at a terminal. The prose mode is critical: `clean`, `protect`, `auto` — the commands
 * that actually CHANGE the repo — must be readable by the person deciding whether to proceed,
 * not just by the script chaining on the exit code. Scripts and tests that pipe stdout get JSON;
 * a human at a TTY gets prose. --json forces JSON; --plain forces prose.
 */
function cmdAction(result, opts = {}) {
  // AN ACTION THAT FAILED MUST NOT EXIT 0. Scripts and agents chain on these:
  //
  //     holt protect && <proceed as though the work is now safe>
  //
  // `holt protect` on a single-worktree repository exited 0 with `failed: 1` and the reason
  // "fatal: The main working tree cannot be locked or unlocked" sitting inside its own payload —
  // git refuses to lock a main working tree, permanently, so this is every solo repo rather than
  // a race. The exit code said the protection succeeded. Anything downstream believed it.
  //
  // Set here rather than at each call site because every action command routes through this one
  // renderer, and a rule enforced in six places is a rule enforced in five.
  if (typeof result?.failed === 'number' && result.failed > 0) process.exitCode = 1;
  const wantJson = opts.json || (!process.stdout.isTTY && !opts.plain);
  if (wantJson) { emitJson(result); return result; }
  // Human-readable summary for action commands
  const lines = [];
  if (result.dryRun) lines.push(paint('yellow', 'DRY RUN — nothing was changed. Re-run with --apply to execute.\n'));
  const did = result.did || {};
  const actions = result.actions || result.wouldRemove || [];
  if (actions.length) {
    const isProtect = actions.some((a) => a.action?.includes('lock') || a.action?.includes('protect'));
    const isClean = actions.some((a) => a.action === 'removed' || (!a.action && result.dryRun && !isProtect));
    const label = result.dryRun
      ? (isProtect ? 'would protect' : isClean ? 'would remove' : 'would act on')
      : 'action(s)';
    lines.push(paint('bold', `${actions.length} ${label}:`));
    for (const a of actions) {
      const action = a.action || (result.dryRun ? 'remove' : 'done');
      const icon = action === 'removed' || action === 'remove' ? '✗'
        : action.includes('lock') || action.includes('protect') ? '🔒'
        : action === 'skipped' || action === 'already-locked' ? '○'
        : '•';
      const color = action === 'removed' || action === 'remove' ? 'red'
        : action.includes('lock') || action.includes('protect') ? 'yellow'
        : action === 'skipped' || action === 'already-locked' ? 'grey'
        : 'green';
      const reason = a.why || a.reason;
      lines.push(`  ${paint(color, icon)} ${a.id || a.path || '?'}${reason ? paint('grey', ` — ${reason.slice(0, 120)}`) : ''}`);
    }
  }
  for (const [k, v] of Object.entries(did)) {
    if (Array.isArray(v) && v.length) lines.push(paint('grey', `  ${k}: ${v.length}`));
    else if (typeof v === 'number' && v > 0) lines.push(paint('grey', `  ${k}: ${v}`));
  }
  // THE RECOVERY ROUTE IS THE POINT OF `discard` AND `rescue`, AND IT WAS THE ONE THING THE
  // HUMAN PATH DROPPED.
  //
  // `holt discard <path>` at a TTY printed exactly one grey line — "…the edits you threw away are
  // captured in the ref above and recoverable" — with no ref above it. No ref, no commit, no
  // restore command. A dangling reference to output that was never emitted, pointing the reader
  // at something that is not there, immediately after destroying their work. The JSON payload had
  // `ref`, `commit`, `restore` and `inspect` all along; only the renderer threw them away, and
  // the renderer is what a person sees.
  //
  // This is what makes an aggressive guard tolerable: the escape hatch has to say how to escape.
  for (const [key, label] of [['ref', 'captured to'], ['commit', 'commit'], ['restore', 'restore with'], ['inspect', 'inspect with']]) {
    if (typeof result?.[key] === 'string' && result[key]) {
      lines.push(`  ${paint('grey', `${label}:`)} ${result[key]}`);
    }
  }
  for (const [key, label] of [['reverted', 'restored from HEAD'], ['discarded', 'removed']]) {
    const v = result?.[key];
    if (Array.isArray(v) && v.length) {
      lines.push(paint('grey', `  ${label} (${v.length}): ${v.slice(0, 5).join(', ')}${v.length > 5 ? ` … +${v.length - 5}` : ''}`));
    }
  }
  if (result.note) lines.push(paint('grey', `\n  ${result.note}`));
  if (lines.length) out(lines.join('\n'));
  else emitJson(result);
  return result;
}

async function cmdDoctor(opts) {
  const [ctags, jscpd, enry] = await Promise.all([detectCtags(), detectJscpd(), detectEnry()]);
  const disc = await discover(opts.cwd, opts);

  // Prove the safety contract is live rather than asserting it.
  const probes = [
    ['worktree list', ['worktree', 'list', '--porcelain']],
    ['merge-tree', ['merge-tree', '--write-tree', 'a', 'b']],
    ['worktree add', ['worktree', 'add', 'x']],
    ['reset --hard', ['reset', '--hard']],
    ['push', ['push', 'origin', 'main']],
    ['checkout', ['checkout', '--', '.']],
  ].map(([label, argv]) => ({ label, ...classify(argv) }));

  const info = {
    node: process.version,
    repo: disc.root ?? null,
    bare: !!disc.bare,
    vcs: disc.vcs,
    workstreams: disc.workstreams.length,
    jj: disc.jj?.available ? 'available' : `unavailable (${disc.jj?.reason ?? 'not probed'})`,
    symbolBackend: ctags.available ? `universal-ctags ${ctags.version}` : `regex fallback (${ctags.reason})`,
    languageDetection: enry.available
      ? `enry ${enry.version} (content-based)`
      : `extension mapping only (${enry.reason}) — ambiguous extensions (.fs .m .h .pl) may resolve to the wrong language`,
    deepDuplicates: jscpd.available ? `jscpd ${jscpd.version}` : `unavailable (${jscpd.reason})`,
    safetyContract: probes,
  };

  if (opts.json) return emitJson(info);

  out(paint('bold', 'holt doctor'));
  out('');
  out(`  node              ${info.node}`);
  out(`  repository        ${info.repo ?? paint('red', info.bare ? 'bare repository (no working tree) — holt needs a checkout' : 'not a git repository')}`);
  out(`  workstreams       ${info.workstreams}  (${info.workstreams - 1} linked + 1 primary)`);
  out(`  jj backend        ${info.jj}`);
  out(`  symbol backend    ${ctags.available ? paint('green', info.symbolBackend) : paint('yellow', info.symbolBackend)}`);
  // Never claim language coverage the INSTALLED toolchain cannot deliver: distro ctags packages
  // lag (Ubuntu 24.04 ships 5.9.0, no Terraform/Elm parser), so say so instead of overclaiming.
  if (ctags.available) {
    const cov = await languageCoverage(['Terraform', 'Elm', 'Julia', 'Zig', 'Nim', 'Crystal', 'Solidity', 'Dart', 'Swift', 'Scala']);
    if (cov.available) {
      const line = `${cov.total} languages parseable by this ctags`;
      out(`  languages         ${cov.missing.length ? paint('yellow', `${line} — MISSING ${cov.missing.join(', ')}`) : paint('green', line)}`);
      if (cov.missing.length) out(paint('grey', `                    upgrade universal-ctags to cover them (distro packages lag; 6.x adds these)`));
    }
  }
  out(`  language detect   ${enry.available ? paint('green', info.languageDetection) : paint('yellow', info.languageDetection)}`);
  out(`  deep duplicates   ${jscpd.available ? paint('green', info.deepDuplicates) : paint('yellow', info.deepDuplicates)}`);
  out('');
  out(paint('bold', '  SAFETY CONTRACT') + paint('grey', '  (live classification, not a claim)'));
  for (const p of probes) {
    const mark = p.allowed ? paint('green', `allow ${p.tier}`) : paint('red', 'REFUSE');
    out(`    ${(p.label + '                ').slice(0, 18)} ${mark}${p.reason ? paint('grey', `  ${p.reason}`) : ''}`);
  }
  out('');

  // Every absence above is optional — holt already said what each one costs. Close the loop
  // by saying how to fix it, per platform, so setup is one pasted command, not a scavenger hunt.
  const missing = [];
  if (!ctags.available) missing.push('ctags');
  if (!enry.available) missing.push('enry');
  // Package names live outside the block so `--install` can reach them too.
  const pkgs = {
    ctags: { pacman: 'ctags', apt: 'universal-ctags', dnf: 'ctags', brew: 'universal-ctags', winget: 'UniversalCtags.Ctags' },
    enry: { pacman: null, apt: null, dnf: null, brew: 'enry', winget: null }, // most distros: go install
  };
  if (missing.length) {
    const managers = [
      ['pacman', (names) => `sudo pacman -S ${names.join(' ')}`],
      ['apt', (names) => `sudo apt install ${names.join(' ')}`],
      ['dnf', (names) => `sudo dnf install ${names.join(' ')}`],
      ['brew', (names) => `brew install ${names.join(' ')}`],
      ['winget', (names) => names.map((n) => `winget install ${n}`).join(' && ')],
    ];
    out(paint('bold', '  TO ENABLE THE MISSING LAYERS') + paint('grey', '  (optional — holt works without them)'));
    for (const [mgr, fmt] of managers) {
      const names = missing.map((m) => pkgs[m][mgr]).filter(Boolean);
      if (names.length) out(`    ${(mgr + '        ').slice(0, 8)}  ${fmt(names)}`);
    }
    if (missing.includes('enry')) out(paint('grey', '    enry elsewhere: go install github.com/go-enry/enry@latest (only needed for ambiguous extensions like .fs/.m/.pl)'));
    out('');
    if (!opts.install) {
      out(paint('grey', '    or let holt do it:  ') + paint('bold', 'holt doctor --install') + paint('grey', '   (asks before running anything)'));
      out('');
    }
  }

  if (opts.install) await runInstall(missing, pkgs, opts);
}

/**
 * Install the optional backends for the user.
 *
 * DELIBERATELY NOT SILENT AND NOT AUTOMATIC. holt's entire value is that it does not do surprising
 * things to your machine, so this: runs only when explicitly asked (`--install`), PRINTS the exact
 * command first, requires confirmation unless `--yes`, never uses sudo without saying so, and
 * reports honestly when it cannot help rather than guessing. An installer that silently runs
 * package managers is a bigger footgun than the missing dependency it fixes.
 */
async function runInstall(missing, pkgs, opts) {
  if (!missing.length) { out(paint('green', '  nothing to install — every optional backend is present')); return; }

  let remaining = missing;

  // ctags has a NO-SUDO path: a pinned, checksum-verified static build holt fetches into its own
  // directory (see src/toolchain.mjs / bin/install-ctags.mjs) — the exact mechanism `holt setup`
  // already offers. Before this, `doctor --install` went straight to the system package manager,
  // which on Linux/most CI needs sudo — so a locked-down machine WITH apt/dnf/pacman present but
  // no sudo rights (precisely the case the portable path exists for) hit a password prompt it was
  // never going to satisfy, with no mention that a path needing neither existed one flag away.
  if (remaining.includes('ctags')) {
    const { portableTarget, holtBinDir } = await import('../src/toolchain.mjs');
    const target = portableTarget();
    if (target) {
      out(paint('bold', '  ctags has a no-sudo option:'));
      out(paint('grey', `    a private copy into ${holtBinDir()} — no sudo, nothing system-wide, pinned release, checksum verified`));
      const go = opts.yes || await confirm('  install it now?');
      if (go) {
        const { installPortableCtags } = await import('./install-ctags.mjs');
        const { resetToolchainProbes } = await import('../src/symbols.mjs');
        const r = await installPortableCtags((m) => out(paint('grey', `    ${m}`)));
        if (r.ok) {
          out(`  ${paint('green', 'ok')}  installed universal-ctags ${r.version}`);
          resetToolchainProbes();
          remaining = remaining.filter((m) => m !== 'ctags');
        } else {
          out(`  ${paint('yellow', '--')}  ${r.reason}`);
          out(paint('grey', '    falling back to the system package manager for ctags.'));
        }
      }
      out('');
    }
  }

  if (!remaining.length) { out(paint('green', '  nothing left to install — the no-sudo path covered it.')); return; }

  const detect = async (bin) => new Promise((r) => {
    execFile('sh', ['-c', `command -v ${bin}`], { timeout: 4000 }, (e) => r(!e));
  });
  const order = process.platform === 'darwin' ? ['brew'] : process.platform === 'win32' ? ['winget'] : ['apt', 'dnf', 'pacman', 'brew'];
  let mgr = null;
  for (const m of order) {
    const probe = { apt: 'apt-get', dnf: 'dnf', pacman: 'pacman', brew: 'brew', winget: 'winget' }[m];
    if (await detect(probe)) { mgr = m; break; }
  }
  if (!mgr) {
    out(paint('yellow', '  no supported package manager found on PATH.'));
    out(paint('grey', `  Install ${remaining.join(' / ')} manually — holt keeps working without it, with reduced coverage.`));
    return;
  }

  const names = remaining.map((m) => pkgs[m][mgr]).filter(Boolean);
  const unavailable = remaining.filter((m) => !pkgs[m][mgr]);
  if (!names.length) {
    out(paint('yellow', `  ${mgr} has no package for: ${unavailable.join(', ')}`));
    if (unavailable.includes('enry')) out(paint('grey', '  enry: go install github.com/go-enry/enry@latest'));
    return;
  }

  const needsSudo = ['apt', 'dnf', 'pacman'].includes(mgr);
  const cmd = ({ apt: `apt-get install -y ${names.join(' ')}`, dnf: `dnf install -y ${names.join(' ')}`,
    pacman: `pacman -S --noconfirm ${names.join(' ')}`, brew: `brew install ${names.join(' ')}`,
    winget: names.map((n) => `winget install ${n}`).join(' && ') })[mgr];
  const full = needsSudo ? `sudo ${cmd}` : cmd;

  out(paint('bold', '  holt will run:'));
  out(`    ${full}`);
  if (needsSudo) out(paint('yellow', '    (this needs sudo — you will be prompted for your password)'));
  out('');

  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      out(paint('yellow', '  not a terminal — re-run with --yes to confirm non-interactively.'));
      return;
    }
    process.stdout.write('  proceed? [y/N] ');
    const answer = await new Promise((r) => {
      process.stdin.setEncoding('utf8');
      process.stdin.once('data', (d) => r(String(d).trim().toLowerCase()));
    });
    if (answer !== 'y' && answer !== 'yes') { out(paint('grey', '  cancelled — nothing was run.')); return; }
  }

  out(paint('grey', '  installing…'));
  const code = await new Promise((r) => {
    const child = spawn('sh', ['-c', full], { stdio: 'inherit' });
    child.on('close', r);
    child.on('error', () => r(1));
  });
  if (code === 0) {
    out(paint('green', '\n  done — re-run `holt doctor` to confirm the new coverage.'));
  } else {
    out(paint('red', `\n  the installer exited ${code}. holt still works without these; run the command above manually to see why.`));
  }
}

/** Read a host's hook event from stdin. Absent/!TTY stdin is normal — not an error. */
function readStdin(timeoutMs = 4000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    // TEAR THE READER DOWN BEFORE RESOLVING, or the process never exits.
    //
    // The timeout fired and the verdict was computed and printed — and then holt sat there,
    // because the 'data'/'end' listeners keep the event loop alive for as long as the host holds
    // the pipe open. Measured: a host that writes the payload and keeps stdin open blocked for
    // 27 seconds on a call whose answer was ready in four. Claude Code, Cursor and every other
    // host that reuses one pipe across a session do exactly that, so this is a hook that stalls
    // EVERY tool call by however long the host keeps the descriptor — and a guard that makes the
    // agent unusable gets uninstalled the same day, which costs all of the protection.
    const done = (v) => {
      clearTimeout(timer);
      process.stdin.removeAllListeners('data');
      process.stdin.removeAllListeners('end');
      process.stdin.removeAllListeners('error');
      process.stdin.pause();
      resolve(v);
    };
    const timer = setTimeout(() => done(data), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    process.stdin.setEncoding('utf8');
    // ANSWER AS SOON AS THE PAYLOAD IS COMPLETE, rather than waiting for end-of-stream.
    //
    // A hook payload is exactly one JSON object. Waiting for `end` means a host that keeps the
    // pipe open across a session pays the full timeout on EVERY tool call — four seconds of
    // stall, every time, for an answer that was ready immediately. Parsing to decide when the
    // object is complete costs one JSON.parse per chunk on input that is a few hundred bytes.
    process.stdin.on('data', (c) => {
      data += c;
      const t = data.trim();
      if (!t.startsWith('{') && !t.startsWith('[')) return;   // not JSON; fall back to end/timeout
      try { JSON.parse(t); } catch { return; }                 // still incomplete
      done(data);
    });
    process.stdin.on('end', () => done(data));
    process.stdin.on('error', () => done(data));
  });
}

/**
 * Hook entry point.
 *
 * Exit codes are part of the contract for hosts that branch on them rather than parsing JSON:
 *   0 = allow · 1 = deny · 2 = ask/could-not-verify
 */
async function cmdHook(opts) {
  const event = opts._[1] ?? 'pre-tool-use';
  const raw = opts.command ? '' : await readStdin();

  let payload = {};
  if (raw.trim()) { try { payload = JSON.parse(raw); } catch { payload = {}; } }

  const cwd = payload.cwd || opts.cwd;

  if (event === 'pre-tool-use') {
    const toolName = payload.tool_name ?? payload.toolName;
    // EVERY HOST'S PAYLOAD SHAPE, because reading only one of them makes the hook inert on the
    // others while still reporting a decision.
    //
    // MEASURED: the identical `rm -rf <worktree holding the only copy>` came back `deny` for
    // Claude Code's shape and `{"permission":"allow"}` for Cursor's. Cursor's
    // `beforeShellExecution` carries the command at the TOP LEVEL; holt only looked inside
    // `tool_input`, found nothing, and took the `!command` early-allow path. So every Cursor user
    // had a deny hook installed, wired correctly, emitting a correctly-shaped response — that
    // permitted everything. A guard that is present and inert is worse than an absent one,
    // because its presence is what stops anyone looking.
    const command = opts.command
      ?? payload.tool_input?.command       // Claude Code
      ?? payload.toolInput?.command        // camelCase variants
      ?? payload.command                   // Cursor beforeShellExecution, and the generic shape
      ?? payload.input?.command
      ?? payload.arguments?.command;

    // Only shell-ish tools can destroy a worktree. Anything else is allowed without a scan,
    // which keeps the hook off the critical path for the overwhelming majority of tool calls.
    const shellish = !toolName || /^(Bash|Shell|Terminal|run_command|execute)$/i.test(toolName);
    if (!shellish || !command) {
      out(JSON.stringify(formatVerdict({ decision: 'allow', reason: null }, { host: opts.host })));
      return;
    }

    const verdict = await assessCommand(command, cwd);
    // Record a prevented loss, so `holt journal --summary` can show the champion a real number:
    // "N destructive commands refused." Best-effort — logging must never delay or alter the hook.
    if (verdict.decision === 'deny') {
      await appendEvent(cwd, {
        action: 'blocked', command: String(command).slice(0, 200),
        reason: verdict.reason ?? null, kind: verdict.kind ?? null,
      }).catch(() => {});
    }
    out(JSON.stringify(formatVerdict(verdict, { host: opts.host, eventName: 'PreToolUse' })));

    // THE REFUSAL IS SAID THREE WAYS, BECAUSE ONE OF THEM WAS RELYING ON LUCK.
    //
    // holt emitted a correct `permissionDecision: "deny"` on stdout and then exited 1. Claude
    // Code documents exit 1 as a NON-BLOCKING error whose stdout JSON is not parsed; exit 2 as
    // blocking, read from STDERR; and exit 0 as the case where the JSON decision is honoured.
    // The guard worked in practice only because this client does read the JSON — the most
    // important refusal in the product was resting on undocumented behaviour, on the one host
    // the README calls its reference integration and marks verified live.
    //
    // So a denial now carries the verdict in every channel a host might read: the JSON above,
    // the reason on stderr, and exit 2. That is fail-CLOSED under all three documented readings
    // rather than correct under one of them. `ask` shares exit 2 deliberately — a host that
    // cannot express "ask" must stop, not proceed, when holt could not verify what a command does.
    if (verdict.decision !== 'allow' && verdict.reason) {
      process.stderr.write(`${verdict.reason}\n`);
    }
    process.exit(verdict.decision === 'allow' ? 0 : 2);
  }

  if (event === 'session-start' || event === 'user-prompt-submit') {
    // Zero-touch protection: with --autoprotect (what `holt integrate` wires), every session
    // start locks the workstreams that hold work found nowhere else BEFORE the agent's first
    // tool call. Best-effort by design — a protection failure must not break session startup,
    // but it is stated in the brief, never swallowed.
    let protectLine = '';
    if (event === 'session-start' && opts.autoprotect) {
      try {
        const p = await protect(cwd, {});
        if (p.protected > 0) protectLine = `holt auto-protect: locked ${p.protected} workstream(s) holding unique work.\n`;
        else if (p.failed > 0) protectLine = `holt auto-protect: ${p.failed} lock attempt(s) FAILED — run 'holt protect' to see why.\n`;
      } catch (e) {
        protectLine = `holt auto-protect FAILED (${e.message}) — protection is NOT in place; run 'holt protect'.\n`;
      }
    }
    // UserPromptSubmit fires on EVERY message. Re-injecting a byte-identical paragraph on every
    // turn is not a reminder — it is the thing that teaches an agent to skip holt's output, and
    // it burns context on every prompt of a long session. So the per-prompt brief speaks only
    // when what it would say has CHANGED (with a periodic refresh so a compacted session is not
    // left permanently unaware). SessionStart always speaks: a new session has seen nothing.
    const brief = await buildBrief(cwd, {
      onlyIfChanged: event === 'user-prompt-submit',
      familyOverrides: opts.familyOverrides, maintenanceFloor: opts.maintenanceFloor, maintenanceRatio: opts.maintenanceRatio,
    });

    // `'' + null` is the string "null", and this line used to hand exactly that to the agent as
    // its workstream briefing whenever there was nothing to report.
    const text = [protectLine.trimEnd(), brief].filter(Boolean).join('\n');
    if (!text) return; // nothing to say: say nothing, rather than an empty context block

    const eventName = event === 'session-start' ? 'SessionStart' : 'UserPromptSubmit';
    out(JSON.stringify(formatContext(text, { host: opts.host, eventName })));
    return;
  }

  // STOP: fires when the agent finishes responding. This closes the "biggest cadence hole" —
  // the moment an agent creates something irreplaceable and then stops, with no warning that
  // the worktree holds the only copy.
  //
  // DESIGN: ADVISORY, NOT BLOCKING. A blocking stop hook fires after every turn in a long
  // session, forcing the agent to respond to holt instead of just stopping — that disrupts
  // the workflow and teaches the agent to skip holt's output. Instead, the stop hook injects
  // context (like session-start) ONLY when the brief CHANGED during the response. If the
  // agent just created something irreplaceable, that's a change worth mentioning. If nothing
  // changed, holt stays silent — the agent already saw the brief at session start and on
  // prompt submit, and repeating it on every stop is noise.
  //
  // MULTI-PROVIDER: this works with any host that supports a stop/post-response event.
  // The context is injected via formatContext(), which handles each host's schema.
  if (event === 'stop') {
    try {
      const brief = await buildBrief(cwd, {
        onlyIfChanged: true,
        familyOverrides: opts.familyOverrides, maintenanceFloor: opts.maintenanceFloor, maintenanceRatio: opts.maintenanceRatio,
      });
      if (brief) {
        out(JSON.stringify(formatContext(brief, { host: opts.host, eventName: 'Stop' })));
      }
    } catch {
      // Best-effort — a scan failure must not disrupt the agent's stop.
    }
    return;
  }

  // SESSION_END: advisory-only. Cannot block. holt uses it for a final warning about at-risk
  // work — this is precisely when someone tears down worktrees, and a last-word reminder is
  // the cheapest possible intervention.
  //
  // MULTI-PROVIDER: works with any host that supports a session-end event. The warning goes
  // to stderr, which most hosts surface to the user.
  if (event === 'session-end') {
    try {
      const brief = await buildBrief(cwd, {
        familyOverrides: opts.familyOverrides, maintenanceFloor: opts.maintenanceFloor, maintenanceRatio: opts.maintenanceRatio,
      });
      if (brief) {
        process.stderr.write(`holt: ${brief}\n`);
      }
    } catch {
      // Best-effort — session end is not the time to fail.
    }
    return;
  }

  process.stderr.write(paint('red', `holt hook: unknown event '${event}'\n`));
  process.exit(2);
}

async function cmdBrief(opts) {
  const text = await buildBrief(opts.cwd, {
    familyOverrides: opts.familyOverrides, maintenanceFloor: opts.maintenanceFloor, maintenanceRatio: opts.maintenanceRatio,
  });
  if (opts.json) return emitJson({ context: text });
  if (text) { out(text); return; }

  // buildBrief() returns null for three very different situations — no repo at all, a repo
  // nobody has fanned out yet (the overwhelmingly common first run), and a repo with siblings
  // that genuinely have nothing to report — and collapsing all three into one fixed sentence
  // means the ONE case that is actually informative ("nothing to report") reads identically to
  // the two where holt could not check anything at all. A human running `holt brief` directly
  // (as opposed to the hook, which is right to stay silent) deserves to know which is true.
  const disc = await discover(opts.cwd, opts).catch(() => null);
  if (!disc?.root) {
    out(disc?.bare
      ? '[holt] this is a bare repository (no working tree) — nothing to brief.'
      : '[holt] not a git repository here — nothing to brief.');
  } else if (disc.workstreams.filter((w) => !w.isPrimary).length === 0) {
    out('[holt] no other worktrees yet — holt compares this one against siblings created with '
      + '`git worktree add ../<name> <branch>`. Nothing to relate until then.');
  } else {
    // "CLEAN" IS A CLAIM, AND A NULL IS NOT EVIDENCE FOR IT. buildBrief() returns null when the
    // siblings are genuinely clean — and ALSO when the scan threw, and when every sibling failed
    // to scan. Adversarial review reproduced both failure shapes (an unreadable .git pointer, a
    // missing base object) and this branch printed "every sibling workstream is clean right now"
    // at exit 0 while `holt status` in the same repo, at the same moment, said
    // "scanned 0/2 · 2 skipped". A confident clean bill on missing evidence is fail-open — the
    // exact defect class this tool exists to catch — so the claim is only made after re-deriving
    // the scan and seeing every workstream actually answer.
    let report = null;
    try { ({ report } = await cachedReport(opts.cwd, opts)); } catch { /* handled below */ }
    const skipped = report ? report.counts.workstreams - report.counts.scanned : -1;
    if (!report) {
      out('[holt] could not scan this repository — holt cannot vouch for the siblings. '
        + 'Run `holt status` for the error.');
      process.exit(2);
    } else if (skipped > 0) {
      out(`[holt] ${skipped} of ${report.counts.workstreams} workstream(s) could not be scanned — `
        + 'holt cannot vouch for them. Run `holt status` to see which, and why.');
      process.exit(2);
    } else {
      out('[holt] nothing to report — every sibling workstream is clean right now.');
    }
  }
}


/**
 * `holt setup` — the whole first run, in one command.
 *
 * THE UX PROBLEM THIS SOLVES. Everything holt needs already existed as separate commands
 * (doctor --install, integrate, protect), which meant a new user's happy path was: install, run
 * something, read a suggestion, run doctor, read another suggestion, run integrate, then finally
 * get value. Every one of those steps is a place to stop.
 *
 * TWO THINGS ARE DELIBERATELY NOT DONE, and both are UX decisions rather than laziness:
 *
 *   npm postinstall does NOT fetch binaries. Package installs that download and execute things
 *   are blocked by `--ignore-scripts` (which plenty of organisations enforce), break in CI, and
 *   are a supply-chain smell. Fetching happens when a human asks for it, here.
 *
 *   `integrate` does NOT run automatically on first use. It writes files into the user's
 *   repository — AGENTS.md, .claude/settings.json, .mcp.json. Writing to somebody's repo without
 *   asking is precisely the behaviour holt exists to prevent, and doing it ourselves would be
 *   indefensible. So this is one command, but it still shows what it will do and asks.
 */
async function cmdSetup(opts) {
  const { detectCtags, detectEnry, resetToolchainProbes } = await import('../src/symbols.mjs');
  const { portableTarget, holtBinDir } = await import('../src/toolchain.mjs');
  const { installPortableCtags } = await import('./install-ctags.mjs');

  out('');
  out(paint('bold', 'holt setup') + paint('grey', '  — backends, agent wiring, and what is at risk right now'));
  out('');

  // Fail fast, before printing sections this directory cannot back up. Without this check, a
  // `holt setup` typo'd into the wrong directory printed the FULL backends section and the FULL
  // agent-wiring section, then reached step 3's buildReport() — which calls process.exit(2)
  // directly, bypassing the try/catch around it — and died mid-sentence with no indication of
  // what to do next. The very first command a new user is told to run must not do that.
  const early = await discover(opts.cwd, opts);
  if (!early.root) {
    const { message } = repoAbsenceError(early, opts.cwd || process.cwd());
    process.stderr.write(paint('red', `holt: ${message}\n`));
    out(paint('grey', '  `holt setup` configures an existing repository — cd into one and re-run.'));
    process.exit(2);
  }

  // ---- 1. backends -------------------------------------------------------------------------
  out(paint('bold', '  1. analysis backends'));
  let ctags = await detectCtags();
  const enry = await detectEnry();
  if (ctags.available) {
    out(`     ${paint('green', 'ok')}  universal-ctags ${ctags.version}`);
  } else {
    out(`     ${paint('yellow', '--')}  universal-ctags missing — holt falls back to regex extraction and relates LESS work`);
    const target = portableTarget();
    if (target) {
      out(paint('grey', `         holt can install a private copy into ${holtBinDir()}`));
      out(paint('grey', '         (no sudo, nothing system-wide, pinned release, checksum verified)'));
      const go = opts.yes || await confirm('     install it now?');
      if (go) {
        const r = await installPortableCtags((m) => out(paint('grey', `         ${m}`)));
        if (r.ok) {
          out(`     ${paint('green', 'ok')}  installed universal-ctags ${r.version}`);
          // The probe already ran and cached "unavailable" a few lines above. Without this, the
          // scan in step 3 would use that stale verdict and silently fall back to regex — the
          // command that just fixed the toolchain reporting the machine as if it had not.
          resetToolchainProbes();
          ctags = { available: true, version: r.version };
        } else {
          out(`     ${paint('red', 'no')}  ${r.reason}`);
          out(paint('grey', '         holt still works — symbol coverage is reduced, and it says so in every report.'));
        }
      }
    } else {
      out(paint('grey', `         no portable build for ${process.platform}-${process.arch}; use your package manager (holt doctor --install)`));
    }
  }
  if (!enry.available) {
    out(paint('grey', '     --  enry missing — only affects ambiguous extensions (.fs .m .h .pl); optional'));
  }
  out('');

  // ---- 2. agent wiring ---------------------------------------------------------------------
  out(paint('bold', '  2. agent wiring') + paint('grey', '  — writes into THIS repository'));
  const { detectHosts } = await import('../src/integrate/adapters.mjs');
  const hosts = await detectHosts(opts.cwd || process.cwd()).catch(() => null);
  const names = hosts ? (hosts.detected ?? []).map((h) => h.name ?? h.id ?? h) : [];
  out(names.length
    ? paint('grey', `     detected: ${names.join(', ')}`)
    : paint('grey', '     no agent host detected here — AGENTS.md is still written, every agent reads it'));
  const doIntegrate = opts.yes || await confirm('     write agent config into this repository?');
  if (doIntegrate) {
    await cmdIntegrate({ ...opts, quiet: false });
  } else {
    out(paint('grey', '     skipped — run `holt integrate` whenever you want it.'));
  }
  out('');

  // ---- 3. what is at risk RIGHT NOW ---------------------------------------------------------
  out(paint('bold', '  3. this repository, right now'));
  try {
    const { report } = await buildReport(opts);
    const atRisk = (report.unique ?? []).filter((u) => (u.uncommittedOnlyCount ?? 0) > 0);
    if (!report.counts?.scanned) {
      out(paint('grey', '     no worktrees yet — holt has nothing to relate until agents fan out.'));
    } else if (atRisk.length) {
      out(`     ${paint('red', String(atRisk.length))} workstream(s) hold work that exists NOWHERE ELSE:`);
      for (const u of atRisk.slice(0, 5)) out(paint('grey', `       ${u.id}`));
      out('');
      out(paint('grey', '     `holt protect` locks these so git itself refuses to delete them.'));
    } else {
      out(paint('green', '     nothing at risk — every workstream\'s work exists somewhere else too.'));
    }
  } catch (e) {
    out(paint('grey', `     could not scan here: ${e.message}`));
  }

  out('');
  out(paint('bold', '  done.') + paint('grey', '  `holt status` any time. `holt setup` is safe to re-run.'));
  out('');
}

/** One y/N prompt. Non-interactive contexts answer NO — never assume consent from silence. */
async function confirm(question) {
  if (!process.stdin.isTTY) {
    out(paint('grey', `${question}  (not a terminal — skipped; re-run with --yes)`));
    return false;
  }
  process.stdout.write(`${question} [y/N] `);
  const answer = await new Promise((r) => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (d) => r(String(d).trim().toLowerCase()));
  });
  return answer === 'y' || answer === 'yes';
}

async function cmdIntegrate(opts) {
  const disc = await discover(opts.cwd, opts);
  if (!disc.root) {
    const { message } = repoAbsenceError(disc, opts.cwd);
    process.stderr.write(paint('red', `holt: ${message}\n`));
    process.exit(2);
  }

  const scope = opts.global ? 'all' : 'project';

  // The other half of integrate: reverse everything holt wrote here. `npm uninstall -g holt`
  // only removes the package — it does not touch the hooks/MCP entries wired into every repo
  // integrate ever ran in, which would otherwise fail on every tool call forever.
  if (opts.remove) {
    const results = await uninstall(disc.root, { scope });
    if (opts.json) return emitJson({ scope, results });

    out(paint('bold', 'holt uninstall') + paint('grey', `  (${scope} scope)`));
    out('');
    if (!results.length) {
      out(paint('grey', '  nothing to remove — no holt integration found in this repository.'));
    }
    for (const r of results) {
      const left = /left in place/.test(r.action);
      const mark = left ? paint('grey', '·') : paint('green', '✓');
      const label = r.host ? `${r.host}${r.scope ? ` [${r.scope}]` : ''} ` : '';
      out(`  ${mark} ${(r.adapter + '            ').slice(0, 12)} ${label}${paint('grey', r.action)}`);
      out(paint('grey', `      ${r.path}`));
    }
    out('');
    // COMPUTED, NOT ASSERTED. This line was printed unconditionally, and it was false in both
    // reproduced data-loss paths — it appeared verbatim over "removed (holt-only content)" for
    // sixteen third-party MCP files in a repository holt had never been installed into. A
    // reassurance the code cannot substantiate is worse than no reassurance, because it is the
    // sentence a user reads instead of checking.
    const removedFiles = results.filter((r) => /^removed/.test(r.action));
    const leftAlone = results.filter((r) => /left (in place|alone)/.test(r.action));
    if (removedFiles.length) {
      out(paint('grey', `  ${removedFiles.length} file(s) were deleted because nothing but holt's own content remained in them:`));
      for (const r of removedFiles) out(paint('grey', `      ${r.path}`));
    }
    if (leftAlone.length) {
      out(paint('grey', `  ${leftAlone.length} file(s) were left untouched — holt could not prove that content was its own.`));
    }
    out(paint('grey', '  Everything else was edited in place: holt\'s entries removed, the rest of each file kept.'));
    out('');
    return;
  }

  // `--dry-run` USED TO BE ACCEPTED AND IGNORED, and then integrate wrote 21 files.
  //
  // The flag is documented for protect/rescue/discard/clean, so a user has every reason to expect
  // it here — and this is the command that touches the most files by an order of magnitude. It
  // was silently swallowed by the global argument parser: `holt integrate --dry-run` exited 0
  // having created .mcp.json, installed a git pre-commit hook, and edited AGENTS.md, while
  // printing "created"/"refreshed" in the past tense as though it had been previewing.
  //
  // A safety flag that is accepted and ignored is worse than one that is rejected, and worse
  // still than one that works. This is the one that works: every target integrate can touch is
  // computed from the same pure planners integrate itself uses, each is stat'd to say whether it
  // would be CREATED or EDITED, and nothing is written. It doubles as the upfront preview that
  // `holt setup` — which writes ~21 files — never offered.
  if (opts.dryRun) {
    const detected = await detectHosts(disc.root, os.homedir());
    const present = detected.all ?? detected;
    const planned = [
      { adapter: 'agents-md', file: path.join(disc.root, 'AGENTS.md') },
      ...mcpTargets(disc.root, os.homedir(), { scope }).map((t) => ({ adapter: `mcp/${t.host}`, file: t.file, scope: t.scope })),
      ...(present.includes('claude-code') ? [{ adapter: 'claude-code', file: path.join(disc.root, '.claude', 'settings.json') }] : []),
      ...(present.includes('cursor') ? [{ adapter: 'cursor', file: path.join(disc.root, '.cursor', 'hooks.json') }] : []),
      ...(present.includes('opencode') ? [{ adapter: 'opencode', file: path.join(disc.root, '.opencode', 'plugins', 'holt.js') }] : []),
      { adapter: 'git-hooks', file: path.join(disc.root, '.git', 'hooks', 'pre-commit') },
    ];
    const rows = [];
    for (const p of planned) {
      const exists = await fs.stat(p.file).then(() => true).catch(() => false);
      rows.push({ ...p, exists, action: exists ? 'edit in place (holt\'s entries only)' : 'create' });
    }
    if (opts.json) return emitJson({ dryRun: true, scope, detected, planned: rows });

    out(paint('bold', 'holt integrate') + paint('grey', `  (${scope} scope) `) + paint('yellow', 'DRY RUN — nothing was written'));
    out('');
    out(`  in this repo     ${detected.project.length ? detected.project.join(', ') : paint('grey', 'none')}`);
    out(`  on this machine  ${detected.user.length ? detected.user.join(', ') : paint('grey', 'none')}`);
    out('');
    const created = rows.filter((r) => !r.exists);
    const edited = rows.filter((r) => r.exists);
    out(paint('grey', `  would CREATE ${created.length} file(s):`));
    for (const r of created) out(`    ${paint('green', '+')} ${(r.adapter + '                ').slice(0, 18)} ${paint('grey', r.file)}`);
    out('');
    out(paint('grey', `  would EDIT ${edited.length} existing file(s), removing and rewriting only holt's own entries:`));
    for (const r of edited) out(`    ${paint('yellow', '~')} ${(r.adapter + '                ').slice(0, 18)} ${paint('grey', r.file)}`);
    out('');
    out(paint('grey', '  Re-run without --dry-run to apply. `holt uninstall` reverses it.'));
    out('');
    return;
  }

  const { detected, results } = await integrate(disc.root, { bin: opts.bin, scope });

  // WIRE THE WORKTREES THE AGENTS ACTUALLY RUN IN.
  //
  // `holt integrate` wired the MAIN worktree and stopped. Every host reads its project config
  // relative to the directory it is running in, and `git worktree add` copies no untracked files —
  // so a dispatched agent, working in a linked worktree, had no .claude/settings.json, no
  // .mcp.json and no AGENTS.md. Measured on a fresh repo: the primary came back with all five hook
  // events wired and the worktree beside it had none of the three files.
  //
  // That is the product's central claim failing in the exact configuration the product is FOR.
  // holt exists because agents run in parallel worktrees; protecting only the one the human sits
  // in protects the one tree that was never the risk.
  //
  // Project scope only for the extras: the user-scope work is machine-wide and was already done
  // once above, and repeating it per worktree would rewrite $HOME configs N times.
  const linked = (disc.workstreams ?? []).filter((w) => !w.isPrimary && w.path);
  const worktreeResults = [];
  for (const w of linked) {
    try {
      // eslint-disable-next-line no-await-in-loop -- each worktree writes its own files
      const r = await integrate(w.path, { bin: opts.bin, scope: 'project' });
      worktreeResults.push({ worktree: w.id, results: r.results });
    } catch (e) {
      worktreeResults.push({ worktree: w.id, error: e.message });
    }
  }

  if (opts.json) return emitJson({ detected, scope, results, worktrees: worktreeResults });

  out(paint('bold', 'holt integrate') + paint('grey', `  (${scope} scope)`));
  out('');
  out(`  in this repo     ${detected.project.length ? detected.project.join(', ') : paint('grey', 'none')}`);
  out(`  on this machine  ${detected.user.length ? detected.user.join(', ') : paint('grey', 'none')}`);
  out('');
  for (const r of results) {
    const skipped = /skipped/.test(r.action);
    const mark = skipped ? paint('grey', '·') : paint('green', '✓');
    const label = `${r.host ? `${r.host}${r.scope ? ` [${r.scope}]` : ''} ` : ''}`;
    out(`  ${mark} ${(r.adapter + '            ').slice(0, 12)} ${label}${paint('grey', r.action)}`);
    if (!skipped) out(paint('grey', `      ${r.path}`));
  }
  out('');
  if (worktreeResults.length) {
    const failed = worktreeResults.filter((w) => w.error);
    out(paint('grey', `  + wired ${worktreeResults.length - failed.length} linked worktree(s) — `
      + 'agents run there, and a host reads its config relative to where it runs.'));
    for (const f of failed) out(paint('yellow', `  ! ${f.worktree}: ${f.error}`));
    out('');
  }
  out(paint('grey', '  AGENTS.md and MCP reach every agent that reads them; hooks add enforcement where supported.'));
  if (!opts.global) {
    out(paint('grey', '  Project scope only — nothing outside this repository was modified. Use --global to also'));
    out(paint('grey', '  add holt to your user-level editor configs (existing files only, never created).'));
  }
  out('');
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(paint('red', `holt: ${e.message}\n`));
    process.exit(2);
  }

  const cmd = opts._[0] ?? 'status';
  if (opts.help || cmd === 'help') { out(USAGE); return; }
  // Every packaged CLI is expected to answer this, and holt answered none of the four spellings
  // people try. A bug report that cannot say which version produced it is not actionable.
  if (opts.version || cmd === 'version') {
    const { version } = JSON.parse(
      await (await import('node:fs/promises')).readFile(new URL('../package.json', import.meta.url), 'utf8'),
    );
    out(`holt ${version}`);
    return;
  }

  if (cmd === 'mcp') {
    const { runStdioServer } = await import('../src/mcp/server.mjs');
    await runStdioServer(opts);
    return;
  }

  // Project config (`.holtrc.json`, see src/config.mjs) is entirely optional — most repositories
  // will never have one. But a file that EXISTS and fails to parse or validate must fail LOUDLY,
  // here, before any command runs — never fall back to defaults while pretending the config the
  // user wrote is in effect. Every command below gets whatever it declares (familyOverrides,
  // maintenanceFloor, maintenanceRatio) folded into `opts`, which every command already receives.
  //
  // EXCEPTION: safety-critical commands (hook, gate, rescue, doctor, context) must NEVER die on
  // a config error. The guard dying because of a typo in .holtrc.json is a self-inflicted wound
  // that leaves the agent unprotected — the exact opposite of what holt exists to prevent. These
  // commands fall back to defaults with a warning to stderr instead of exiting.
  let configPath = null;
  try {
    const cfg = await loadConfig(opts.cwd);
    configPath = cfg.path;
    if (cfg.config.familyOverrides !== undefined) opts.familyOverrides = cfg.config.familyOverrides;
    if (cfg.config.maintenanceFloor !== undefined) opts.maintenanceFloor = cfg.config.maintenanceFloor;
    if (cfg.config.maintenanceRatio !== undefined) opts.maintenanceRatio = cfg.config.maintenanceRatio;
    // Surface warnings (unknown keys) to stderr — loud but non-fatal.
    for (const w of cfg.warnings) {
      process.stderr.write(paint('yellow', `holt: ${w.message}\n`));
    }
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    if (CONFIG_NON_FATAL.has(cmd)) {
      // Safety-critical commands fall back to defaults with a warning. The guard must not die.
      if (opts.json) {
        process.stderr.write(paint('yellow', `holt: config warning (using defaults): ${e.message}\n`));
      } else {
        process.stderr.write(paint('yellow', `holt: ${e.message} — using defaults, continuing\n`));
      }
    } else {
      // Non-safety-critical commands fail loudly — the user should know their config is broken.
      if (opts.json) { emitJson({ ok: false, code: 'bad-config', reason: e.message, path: e.path }); process.exit(2); }
      process.stderr.write(paint('red', `holt: ${e.message}\n`));
      process.exit(2);
    }
  }
  opts.configPath = configPath;
  if (cmd === 'doctor') return cmdDoctor(opts);
  if (cmd === 'hook') return cmdHook(opts);
  if (cmd === 'tui') {
    return runTui(opts.cwd, {
      snapshot: opts.snapshot, columns: opts.columns, rows: opts.rowsOpt,
      familyOverrides: opts.familyOverrides,
    });
  }

  // The MUTATING commands, dispatched before buildReport() because each runs its own assessment.
  // These were once implemented, exported and covered by 19 passing tests while `holt protect`
  // printed "unknown command" — nothing exercised the CLI. test/e2e/cli.test.mjs now does.
  if (cmd === 'order') {
    const { report } = await buildReport(opts);
    const plan = landingOrder(report);
    if (opts.json) return emitJson(plan);
    out(paint('bold', 'holt order') + paint('grey', '  (heuristic — conflictsWithLater names the merges to watch)'));
    if (plan.parallel.length) {
      out(`\n  PARALLEL-SAFE  ${paint('grey', 'no observed interaction — land in any order, concurrently')}`);
      for (const id of plan.parallel) out(`    ${paint('green', id)}`);
    }
    for (const lane of plan.lanes) {
      out(`\n  LANE (${lane.members.length} entangled)`);
      lane.order.forEach((step, i) => {
        const later = step.conflictsWithLater.map((c) => `${c.id} (${c.why.join('; ')})`).join(', ');
        out(`    ${i + 1}. ${step.id}${later ? paint('yellow', `  → watch: ${later}`) : paint('green', '  → clears the lane')}`);
      });
    }
    out('');
    return;
  }
  if (cmd === 'partition') {
    const { report, scanned } = await buildReport(opts);
    const plan = partitionPlan(report, await listTrackedFiles(scanned.root), { agents: opts.agents ?? 2 });
    if (opts.json) return emitJson(plan);
    out(paint('bold', `holt partition — ${plan.agents} agents`) + paint('grey', '  (advisory: a collision-free starting map, not a work plan)'));
    for (const b of plan.buckets) {
      out(`\n  AGENT ${b.agent}  ${paint('grey', `${b.weight} tracked file(s)`)}`);
      out(`    ${b.dirs.join('  ')}`);
    }
    if (plan.avoid.length) {
      out(`\n  ${paint('yellow', 'ALREADY CONTESTED')}  ${paint('grey', 'one owner each — currently touched by multiple live workstreams')}`);
      for (const a of plan.avoid.slice(0, 15)) {
        out(`    ${a.file}  ${paint('grey', `held by ${a.currentlyHeldBy.join(', ')}`)}  → agent ${a.assignTo ?? '?'}`);
      }
    }
    out('');
    return;
  }
  if (cmd === 'branches') {
    const audit = await branchAudit(opts.cwd, opts);
    if (opts.json) { emitJson(audit); if (!audit.ok) process.exit(2); return; }
    if (!audit.ok) {
      process.stderr.write(paint('red', `holt branches: ${audit.reason}\n`));
      process.exit(2);
    }
    out(paint('bold', 'holt branches') + paint('grey', `  vs ${audit.base.ref ?? audit.base.oid.slice(0, 12)} · ${audit.audited} audited · checked-out excluded: ${audit.excludedCheckedOut.join(', ') || 'none'}`));
    const section = (label, items, color) => {
      if (!items.length) return;
      out(`\n  ${paint(color, label)}`);
      for (const b of items) {
        out(`    ${b.name}  ${paint('grey', b.reason)}`);
        if (b.command) out(`      ${paint('grey', '$')} ${b.command}`);
        if (b.files) out(`      ${paint('grey', b.files.slice(0, 5).join(', ') + (b.fileCount > 5 ? ` … +${b.fileCount - 5}` : ''))}`);
      }
    };
    section(`LANDED — safe to delete (${audit.landed.length})`, audit.landed, 'green');
    section(`CONTENT-LANDED — evidence says landed, git ancestry says no (${audit.contentLanded.length})`, audit.contentLanded, 'yellow');
    section(`UNLANDED — holds work (${audit.unlanded.length})`, audit.unlanded, 'red');
    section(`UNKNOWN — instrument failed, refusing to classify (${audit.unknown.length})`, audit.unknown, 'red');
    if (audit.applied.length) {
      out(`\n  APPLIED`);
      for (const a of audit.applied) out(`    ${a.name}  ${a.ok ? paint('green', 'deleted (-d)') : paint('red', `refused: ${a.error}`)}`);
    }
    out(`\n  ${paint('grey', audit.note)}\n`);
    return;
  }
  if (cmd === 'license') {
    const sub = opts._[1] ?? 'status';
    if (sub === 'activate') {
      const key = opts._[2];
      if (!key) { process.stderr.write(paint('red', 'holt license activate <key>\n')); process.exit(2); }
      try {
        const r = activateLicense(key);
        if (opts.json) return emitJson({ ok: true, ...r });
        out(paint('green', `holt ${r.tier} license activated`) + paint('grey', `  ${r.org ?? ''} · expires ${r.expires.slice(0, 10)}`));
        out(paint('grey', `  stored ${r.stored} (mode 0600)`));
        return;
      } catch (e) {
        if (opts.json) { emitJson({ ok: false, code: e.code ?? 'error', reason: e.message }); process.exit(1); }
        process.stderr.write(paint('red', `holt license: ${e.message}\n`));
        process.exit(1);
      }
    }
    if (sub === 'deactivate') {
      const r = deactivateLicense();
      if (opts.json) return emitJson({ ok: true, ...r });
      out(r.removed.length ? paint('green', `removed ${r.removed.join(', ')}`) : paint('grey', 'no license file to remove'));
      return;
    }
    const st = licenseStatus();
    if (opts.json) return emitJson(st);
    out(paint('bold', 'holt license'));
    if (!st.licensed) {
      out(`\n  ${paint('yellow', 'no active license')}  ${paint('grey', st.reason ?? '')}`);
      out(paint('grey', '  holt free is fully functional — a license unlocks team/enterprise features only.'));
    } else {
      out(`\n  tier      ${paint('green', st.tier)}${st.org ? paint('grey', `  (${st.org})`) : ''}`);
      out(`  expires   ${st.expires.slice(0, 10)}  ${paint(st.daysLeft <= 14 ? 'yellow' : 'grey', `${st.daysLeft} day(s) left`)}${st.inGrace ? paint('red', '  IN GRACE PERIOD') : ''}`);
      if (st.seats) out(`  seats     ${st.seats}`);
      out(`  source    ${paint('grey', st.source ?? '')}`);
    }
    out('\n  FEATURES');
    for (const f of st.features) {
      out(`    ${f.entitled ? paint('green', '✓') : paint('grey', '·')} ${(f.feature + '                ').slice(0, 16)} ${paint('grey', f.need)}`);
    }
    out('');
    return;
  }
  if (cmd === 'fleet') {
    const ent = checkEntitlement('fleet');
    if (!ent.entitled) {
      if (opts.json) { emitJson({ ok: false, entitlement: ent }); process.exit(3); }
      process.stderr.write(paint('yellow', `holt fleet: ${ent.reason}\n`) + paint('grey', `  ${ent.fix}\n`));
      process.exit(3);
    }
    const roots = opts._.slice(1);
    if (!roots.length) roots.push(opts.cwd);
    const f = await fleetScan(roots, opts);
    if (opts.json) return emitJson(f);
    out(paint('bold', `holt fleet — ${f.repositories} repositories`) + paint('grey', `  ${f.roots.join(' ')}`));
    out(`\n  ${paint('bold', 'TOTALS')}  ${f.totals.workstreams} workstreams · ${paint(f.totals.atRisk ? 'yellow' : 'green', `${f.totals.atRisk} at risk`)} · ${f.totals.disposable} disposable · ${f.totals.unlandedBranches} unlanded branches`);
    out('');
    for (const r of f.repos) {
      const flag = r.atRisk ? paint('yellow', `${r.atRisk} at risk`) : paint('grey', 'clear');
      out(`    ${(r.name + '                        ').slice(0, 24)} ${flag}  ${paint('grey', `${r.workstreams} ws · ${r.disposable} disposable · ${r.unlandedBranches ?? '?'} unlanded`)}`);
      if (r.atRiskIds.length) out(paint('grey', `      ${r.atRiskIds.slice(0, 6).join(', ')}`));
    }
    if (f.failures.length) {
      out(`\n  ${paint('red', 'FAILED TO SCAN')} ${paint('grey', '(not clean — unknown)')}`);
      for (const x of f.failures) out(`    ${x.repo}  ${paint('grey', x.error)}`);
    }
    out(`\n  ${paint('grey', f.note)}\n`);
    return;
  }
  if (cmd === 'ci') {
    // The team gate. Report-only by default; policy is explicit flags, and an instrument
    // failure (unknown bucket) is NEVER a green result when policy is on.
    const audit = await branchAudit(opts.cwd, opts);
    if (!audit.ok) { process.stderr.write(paint('red', `holt ci: ${audit.reason}\n`)); process.exit(2); }
    const ignore = new Set([...(opts.ignore ?? []), process.env.GITHUB_HEAD_REF].filter(Boolean));

    // Policy as code, when the repository declares one. A declared policy that cannot be
    // enforced is a hard failure in BOTH directions: unreadable policy exits 2, and an
    // unlicensed policy exits 3 — never a silent pass, which would tell a team they are
    // covered when nothing ran.
    let loaded;
    try {
      // THE POLICY COMES FROM THE BASE REF, NOT THE BRANCH BEING JUDGED.
      //
      // Both arms of the old expression resolved to the local filesystem — which, in the only
      // place this gate runs, is a checkout of the PULL REQUEST. The branch under review supplied
      // the rules that judged it, so a contributor could loosen a threshold or delete the file
      // and the gate reported a clean pass. On a fork PR that is an unauthenticated stranger
      // choosing their own policy, on the feature that requires a paid tier to run at all.
      //
      // `git show <base>:<path>` reads the committed object on the protected branch and never
      // touches the working tree. Changing the policy therefore requires a review on the base
      // branch, which is the control the feature claims to provide.
      //
      // Falling back to the working tree when there is no base is correct and not a hole: with no
      // base ref there is no PR, holt is running ON the branch, and that tree IS the authority.
      const baseRef = audit?.base?.oid ?? audit?.base?.ref ?? null;
      loaded = baseRef
        ? await loadPolicyFrom(async (rel) => {
          const r = await git(['show', `${baseRef}:${rel}`], { cwd: opts.cwd });
          return r.code === 0 ? r.stdout : null;
        })
        : await loadPolicy(opts.cwd);
      loaded.authority = baseRef ? `base ref ${String(baseRef).slice(0, 12)}` : 'working tree (no base ref)';
    } catch (e) {
      if (opts.json) { emitJson({ ok: false, code: e.code, reason: e.message }); process.exit(2); }
      process.stderr.write(paint('red', `holt ci: ${e.message}\n`));
      process.exit(2);
    }
    if (loaded.found) {
      const ent = checkEntitlement('policy-file');
      if (!ent.entitled) {
        const payload = { ok: false, code: 'unlicensed-policy', policy: loaded.path, entitlement: ent,
          reason: `${loaded.path} declares a policy but ${ent.reason}. Refusing to pass a build against a policy that did not run.` };
        if (opts.json) { emitJson(payload); process.exit(3); }
        process.stderr.write(paint('red', `holt ci: ${payload.reason}\n`) + paint('grey', `  ${ent.fix}\n`));
        process.exit(3);
      }
      const { report } = await buildReport(opts).catch(() => ({ report: null }));
      const res = evaluatePolicy(loaded.policy, { audit, report, ignore: [...ignore] });
      const payload = {
        ok: res.ok, mode: 'policy', policy: loaded.path, entitlement: { tier: ent.tier, org: ent.org ?? null },
        rulesEvaluated: res.rulesEvaluated, errors: res.errors, warnings: res.warnings,
        violations: res.violations, exempted: res.exempted,
        note: 'requires full refs (actions/checkout with fetch-depth: 0)',
      };
      if (opts.json) { emitJson(payload); process.exit(res.ok ? 0 : 1); }
      out(paint('bold', `holt ci — policy ${loaded.path}`) + paint('grey', `  ${res.rulesEvaluated.length} rule(s) · ${ent.tier} license`));
      for (const v of res.violations) {
        const c = v.severity === 'error' ? 'red' : 'yellow';
        out(`  ${paint(c, v.severity.toUpperCase())} ${paint('bold', v.rule)}  ${v.message}`);
        for (const e of v.evidence ?? []) out(paint('grey', `      ${e}`));
      }
      if (res.ok) out(paint('green', `\n  PASS — ${res.warnings} warning(s), 0 errors\n`));
      else out(paint('red', `\n  FAIL — ${res.errors} error(s), ${res.warnings} warning(s)\n`));
      process.exit(res.ok ? 0 : 1);
    }
    const unlanded = audit.unlanded.filter((b) => !ignore.has(b.name));
    const overAge = opts.maxAgeDays
      ? unlanded.filter((b) => b.ageDays != null && b.ageDays > opts.maxAgeDays) : [];
    const failures = [];
    if (opts.failOnUnlanded && unlanded.length) {
      failures.push(`${unlanded.length} branch(es) hold unlanded work: ${unlanded.map((b) => `${b.name} (${b.fileCount} file(s)${b.ageDays != null ? `, ${b.ageDays}d old` : ''})`).join(', ')}`);
    }
    if (opts.maxAgeDays && overAge.length && !opts.failOnUnlanded) {
      failures.push(`${overAge.length} unlanded branch(es) older than ${opts.maxAgeDays}d: ${overAge.map((b) => b.name).join(', ')}`);
    }
    if ((opts.failOnUnlanded || opts.maxAgeDays) && audit.unknown.length) {
      failures.push(`${audit.unknown.length} branch(es) could not be classified (instrument failure) — refusing to pass policy on missing evidence`);
    }
    const result = {
      ok: failures.length === 0,
      policy: { failOnUnlanded: !!opts.failOnUnlanded, maxAgeDays: opts.maxAgeDays ?? null, ignored: [...ignore] },
      failures,
      unlanded: unlanded.map((b) => ({ name: b.name, files: b.fileCount, ageDays: b.ageDays })),
      contentLanded: audit.contentLanded.map((b) => b.name),
      unknown: audit.unknown.map((b) => b.name),
      note: 'requires full refs (actions/checkout with fetch-depth: 0)',
    };
    emitJson(result);
    process.exit(result.ok ? 0 : 1);
  }
  if (cmd === 'journal') {
    const events = await readJournal(opts.cwd);
    if (opts.summary) {
      const s = summarizeJournal(events);
      if (opts.json) return emitJson(s);
      out(paint('bold', 'holt — what it has prevented here'));
      out(`\n  ${paint(s.preventedLosses ? 'green' : 'grey', s.headline)}`);
      const b = s.breakdown;
      out('');
      out(`    ${paint('bold', String(b.destructiveCommandsBlocked).padStart(4))}  destructive command(s) refused`);
      out(`    ${paint('bold', String(b.workstreamsRescued).padStart(4))}  workstream(s) rescued to a verifiable ref`);
      out(`    ${paint('bold', String(b.workstreamsProtected).padStart(4))}  workstream(s) protected (holding work found nowhere else)`);
      out(`    ${paint('bold', String(b.worktreesReclaimed).padStart(4))}  disposable worktree(s) reclaimed`);
      out(`    ${paint('bold', String(b.branchesDeleted).padStart(4))}  landed branch(es) cleaned up`);
      out(`    ${paint('bold', String(b.protectionsReleased).padStart(4))}  protection(s) released (recorded with who released them)`);
      out(`\n  ${paint('grey', `~${s.estimatedHoursSaved}h saved (conservative planning estimate) · ${s.events} events since ${s.since ? s.since.slice(0,10) : '—'}`)}`);
      out(`  ${paint('grey', s.note)}\n`);
      return;
    }
    if (opts.exportFmt) {
      // A single repository's audit log is the USER'S OWN DATA, and `holt journal --json`
      // already prints all of it for free — gating a CSV of the same rows would be a gate in
      // name only. So single-repo export is free. The paid audit product is the FLEET-level
      // aggregation across many repositories and the continuous webhook sink, which is where
      // the work and the value actually are.
      const fmt = String(opts.exportFmt).toLowerCase();
      if (fmt === 'json') return emitJson({ exportedAt: new Date().toISOString(), repo: opts.cwd, count: events.length, events });
      if (fmt === 'csv') {
        // WHO gets its own columns. A compliance reviewer filters and pivots on the actor; a
        // nested JSON blob in one cell is not something a spreadsheet can group by.
        const cols = ['at', 'action', 'actorUser', 'actorHost', 'actorAgent', 'actorSession',
          'id', 'name', 'path', 'branch', 'ref', 'commit', 'reason', 'evidence'];
        const esc = (v) => {
          if (v == null) return '';
          const s2 = Array.isArray(v) ? v.join('; ') : String(typeof v === 'object' ? JSON.stringify(v) : v);
          return /[",\n]/.test(s2) ? `"${s2.replace(/"/g, '""')}"` : s2;
        };
        // An event written before actor attribution existed has no actor, and 'unknown' is the
        // honest value for it — never a guess at who it must have been.
        const cell = (e, c) => (c.startsWith('actor')
          ? (e.actor?.[c.slice(5).toLowerCase()] ?? 'unknown')
          : e[c]);
        out(cols.join(','));
        for (const e of events) out(cols.map((c) => esc(cell(e, c))).join(','));
        return;
      }
      process.stderr.write(paint('red', `holt journal: unknown export format '${opts.exportFmt}' (json | csv)\n`));
      process.exit(2);
    }
    if (opts.json) return emitJson({ events });
    if (!events.length) { out(paint('grey', 'holt journal: no recorded actions in this repository yet')); return; }
    out(paint('bold', `holt journal — ${events.length} recorded action(s)`));
    for (const e of events) {
      if (e.corrupt) { out(`  ${paint('red', 'corrupt line:')} ${e.corrupt.slice(0, 80)}`); continue; }
      const what = [e.id ?? e.name, e.ref, e.evidence ?? e.reason].filter(Boolean).join('  ');
      // WHO, printed inline. An entry from before attribution existed prints 'unknown', which is
      // the honest reading of it — never a back-filled guess.
      const a = e.actor ?? {};
      const who = `${a.user ?? 'unknown'}@${a.host ?? 'unknown'}`
        + (a.agent && a.agent !== 'unknown' ? ` via ${a.agent}` : '');
      out(`  ${paint('grey', e.at)}  ${paint('bold', e.action)}  ${paint('grey', who)}  ${what}`);
    }
    return;
  }
  if (cmd === 'auto') return void cmdAction(await auto(opts.cwd, opts), opts);
  if (cmd === 'protect') return void cmdAction(await protect(opts.cwd, opts), opts);
  if (cmd === 'unprotect') {
    // `--force` overrides a lock holt did NOT place — a materially different act from releasing
    // holt's own, and the one that most needs a human to have deliberately meant it. Refused
    // before anything is touched (no partial override) unless the invocation carries an explicit
    // reason or an explicit --yes; a bare `--force` typed out of habit must not silently disarm
    // someone else's guard.
    //
    // The demand is made only when there is actually something to override. Gating on the mere
    // PRESENCE of `--force` refused `holt unprotect --force` against holt's own locks — where the
    // flag changes nothing at all — with a message asserting something untrue of that invocation.
    // A guard that refuses a legitimate action for a false reason is how people learn to stop
    // running the tool, so the foreign locks are counted first, without touching any of them.
    if (opts.force && !(opts.reason && opts.reason.trim()) && !opts.yes) {
      const probe = await unprotect(opts.cwd, { id: opts._[1] ?? null, ...opts, dryRun: true });
      if (probe.foreignLocks > 0) {
        process.stderr.write(paint('red',
          `holt unprotect --force: ${probe.foreignLocks} lock(s) here were not placed by holt; `
          + 'overriding them needs justification.\n')
          + paint('grey',
            '  re-run with --reason "<why>" to record why, or add --yes to confirm without one.\n'));
        process.exit(2);
      }
    }
    return void cmdAction(await unprotect(opts.cwd, { id: opts._[1] ?? null, ...opts }), opts);
  }
  if (cmd === 'rescued') return void cmdAction(await rescues(opts.cwd));
  if (cmd === 'discard') {
    const targets = opts._.slice(1);
    if (!targets.length) {
      process.stderr.write(paint('red', 'holt discard: needs at least one path\n'));
      process.exit(2);
    }
    const r = await discard(opts.cwd, targets, opts);
    cmdAction(r, opts);
    if (!r.ok) process.exit(1);
    return;
  }
  if (cmd === 'clean') return void cmdAction(await clean(opts.cwd, opts), opts);
  if (cmd === 'verify') {
    const [, a, b] = opts._;
    if (!a || !b) {
      process.stderr.write(paint('red', 'holt verify: needs two workstream ids\n'));
      process.exit(2);
    }
    const r = await verifyPair(opts.cwd, a, b, { run: opts.run ?? null });
    cmdAction(r, opts);
    if (r.ok === false) process.exit(2);
    // Deny on the VERDICT, not on whether a failure name could be parsed. Keying the exit code
    // off interactionFailures.length meant a runner whose output holt cannot parse exited 0 —
    // allow — on a combination that demonstrably broke the suite.
    if (r.interactionBreaks) process.exit(1);
    return;
  }
  if (cmd === 'rescue') {
    const target = opts._[1];
    if (!target) {
      process.stderr.write(paint('red', 'holt rescue: needs a workstream id\n'));
      process.exit(2);
    }
    const r = await rescue(opts.cwd, target, opts);
    cmdAction(r, opts);
    // An unverified capture MUST exit non-zero: a script chaining
    //   holt rescue X && git worktree remove X
    // has to stop here, or that chain destroys the work it was meant to save.
    if (r.ok === false) process.exit(1);
    return;
  }
  if (cmd === 'brief') return cmdBrief(opts);
  if (cmd === 'hosts') {
    const rep = await hostsReport(opts.cwd);
    if (opts.json) return emitJson(rep);
    out(paint('bold', 'holt — agent host coverage') + paint('grey', `  ${rep.counts.known} known · ${rep.counts.blocking} blocking · ${rep.counts.cloudAdvisoryOnly} cloud (advisory only)`));
    if (rep.detectedHere.length) out(`\n  ${paint('green', 'detected here:')} ${rep.detectedHere.join(', ')}`);
    out('');
    const strengthColor = (h) => h.env === 'cloud' ? 'yellow' : h.strength === 'block' ? 'green' : h.strength === 'mcp' ? 'cyan' : 'grey';
    for (const h of rep.hosts) {
      const mark = h.detectedHere ? paint('green', '●') : paint('grey', '○');
      const nm = h.name.length > 33 ? `${h.name.slice(0, 32)}…` : h.name;
      out(`  ${mark} ${(nm + '                                   ').slice(0, 34)} ${paint(strengthColor(h), h.label)}`);
    }
    out(`\n  ${paint('grey', rep.cloudCaveat)}\n`);
    return;
  }
  if (cmd === 'setup') return cmdSetup(opts);
  if (cmd === 'integrate') return cmdIntegrate(opts);
  // The other half of `integrate`. An alias for `integrate --remove`, not a separate code path,
  // so the two can never drift apart on what counts as "holt's own".
  if (cmd === 'uninstall') return cmdIntegrate({ ...opts, remove: true });

  const { report, scanned } = await buildReport(opts);

  switch (cmd) {
    case 'status': case 'scan':
      return opts.json ? emitJson(report) : out(renderSummary(report));

    case 'risk':
      return opts.json
        ? emitJson({ unique: report.unique, safe: report.safe, counts: report.counts })
        : out(renderRisk(report));

    case 'collisions':
      return opts.json ? emitJson(report.collisions) : out(renderCollisions(report));

    case 'duplicates': {
      const deep = opts.deep ? await deepDuplicates(scanned) : null;
      return opts.json
        ? emitJson({ symbolIdentity: report.duplicates, deep })
        : out(renderDuplicates(report, deep));
    }

    case 'plan':
      return opts.json ? emitJson(report.plan) : out(renderPlan(report));

    case 'impact': {
      const imp = await impact(scanned, opts);
      return opts.json ? emitJson(imp) : out(renderImpact(imp));
    }

    case 'graph': {
      if (opts.html) {
        const html = renderHtml(report);
        await fs.writeFile(path.resolve(opts.html), html, 'utf8');
        out(paint('green', `wrote ${path.resolve(opts.html)}`) + paint('grey', `  (${report.graph.nodes.length} nodes, ${report.graph.edges.length} edges)`));
        return;
      }
      if (opts.json) return emitJson(report.graph);
      // In a terminal, the useful shape of the graph is its CLUSTERING — who is entangled with
      // whom — not a node drawing. --html renders the full interactive graph when you want it.
      out(paint('bold', 'holt graph') + paint('grey', `  ${report.graph.nodes.length} workstreams · ${report.graph.edges.length} relationships`));
      out('');
      out(renderClusters(report, paint));
      out(paint('grey', '\n  holt graph --html <file>  writes the full interactive graph\n'));
      return;
    }

    case 'context': {
      const id = opts._[1];
      if (!id) {
        process.stderr.write(paint('red', 'holt context: needs a workstream id\n'));
        process.exit(2);
      }
      const digest = contextDigest(scanned, id);
      if (opts.json) emitJson(digest); else out(renderContext(digest));
      // An unknown id is a FAILED lookup, not a successful empty answer. Exiting 0 here made
      // `holt context $ID || handle_error` silently succeed on a typo — the same silent-success
      // class `gate` already exits non-zero for.
      if (digest?.ok === false) process.exit(2);
      return;
    }

    case 'stash': {
      const stash = report.stash;
      if (opts.json) {
        emitJson(stash);
      } else {
        if (!stash || stash.atRisk.length === 0) {
          out(paint('green', '✓ no stash entries holding unique work'));
          if (stash?.entries?.length) {
            out(paint('grey', `  (${stash.entries.length} stash entries, all verified redundant)`));
          }
        } else {
          out(paint('yellow', `⚠ ${stash.atRisk.length} stash entr${stash.atRisk.length === 1 ? 'y' : 'ies'} holding work no ref has:`));
          out('');
          out(describeStash(stash));
        }
      }
      return;
    }

    case 'gate': {
      // Pre-delete gate. Exit 0 = disposable, 1 = holds unique work, 2 = unknown.
      const id = opts._[1];
      if (!id) {
        process.stderr.write(paint('red', 'holt gate: needs a workstream id\n'));
        process.exit(2);
      }
      const verdict = report.safe.find((s) => s.id === id);
      if (!verdict) {
        process.stderr.write(paint('red', `holt gate: no workstream '${id}'\n`));
        process.exit(2);
      }
      // REDUNDANT IS DISPOSABLE FOR A COMMAND THAT RE-VERIFIES, AND NOT FOR ONE THAT DOES NOT.
      //
      // A worktree whose content a living sibling also holds IS individually disposable, and
      // saying otherwise cost 60% of this question's recall. But `gate` is the machine contract a
      // script chains on — `holt gate $id && rm -rf $id` — and that `rm -rf` performs no second
      // check. Run over a redundant SET, an exit 0 for every member authorises deleting all of
      // them, and the work is gone.
      //
      // `clean --apply` is different in exactly the way that matters: it re-verifies each worktree
      // against a fresh scan immediately before removing it, so the set drains to one survivor by
      // construction. So the split is not a fudge — it is which consumer looks again.
      //
      // gate therefore refuses a redundant worktree and says why, naming the siblings, so the
      // human can pick which one goes instead of the tool guessing.
      const redundantOnly = verdict.safe && verdict.redundantWith?.length;
      if (opts.json) emitJson(verdict);
      else if (verdict.confidence === 'unknown') {
        out(paint('yellow', `? ${id}: UNKNOWN — holt could not scan it. Refusing to call it safe.`));
        for (const r of verdict.reasons) out(paint('grey', `    ${r}`));
      } else if (redundantOnly) {
        out(paint('yellow', `? ${id}: DUPLICATE — the same work is also in ${verdict.redundantWith.join(', ')}`));
        out(paint('grey', '    Any ONE of them may go, but not all. `holt clean --apply` removes'));
        out(paint('grey', '    the extras safely (it re-checks before each removal); this gate will'));
        out(paint('grey', '    not authorise a delete it cannot re-verify.'));
      } else if (verdict.safe) {
        out(paint('green', `✓ ${id}: disposable — ${verdict.reasons[0]}`));
      } else {
        out(paint('red', `✗ ${id}: HOLDS UNIQUE WORK`));
        for (const r of verdict.reasons) out(paint('grey', `    ${r}`));
      }
      process.exit(verdict.confidence === 'unknown' ? 2 : redundantOnly ? 1 : verdict.safe ? 0 : 1);
      return;
    }

    default:
      process.stderr.write(paint('red', `holt: unknown command '${cmd}'\n`));
      out(USAGE);
      process.exit(2);
  }
}

/**
 * Errors that are a normal STATE of the user's repository, not a bug in holt. These get the same
 * one-line treatment as "not a git repository": the message is already written for a human, and
 * printing a Node stack trace with the maintainer's own file paths on the most common first run
 * (a brand-new repo with no commits yet) reads as "crashes on first use".
 */
const EXPECTED_STATE = [
  /could not determine a base ref/i,
  /not a git repository/i,
  /is a bare repository/i,
  /no usable base to compare against/i,
];

main().catch((err) => {
  const msg = err?.message ?? String(err);
  if (EXPECTED_STATE.some((re) => re.test(msg))) {
    // The message already says what to do; strip any duplicated "holt:" prefix and print it once.
    process.stderr.write(paint('red', `holt: ${msg.replace(/^holt:\s*/, '')}\n`));
    process.exit(2);
  }
  // A stack trace with internal file paths reads as "crashes on first use" for any error that
  // is not a recognised repository state. Print the message alone; offer the stack with --debug.
  if (process.argv.includes('--debug')) {
    process.stderr.write(paint('red', `holt: ${err?.stack ?? msg}\n`));
  } else {
    process.stderr.write(paint('red', `holt: ${msg}\n`));
    process.stderr.write(paint('grey', '  (run with --debug for a stack trace)\n'));
  }
  process.exit(1);
});
