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
  renderPlan, renderCollapse, renderHotspots, renderContext, renderImpact, renderOrder, renderPartition, renderBranches, paint,
} from '../src/render.mjs';
import { renderHtml } from '../src/graph-html.mjs';
import { renderClusters } from '../src/ascii-graph.mjs';
import { assessCommand, buildBrief, cachedReport, resolveCommand, resolveFileTargets } from '../src/agent.mjs';
import { impact, detectRipgrep } from '../src/impact.mjs';
import {
  integrate, uninstall, detectHosts, hostsReport, formatVerdict, formatContext, mcpTargets,
} from '../src/integrate/adapters.mjs';
import { protect, unprotect, rescue, rescues, clean, discard, auto } from '../src/actions.mjs';
import { verifyPair } from '../src/verify.mjs';
import { runTui } from '../src/tui.mjs';
import { landingOrder } from '../src/order.mjs';
import { branchAudit } from '../src/branches.mjs';
import { partitionPlan, MAX_PARTITION_AGENTS } from '../src/partition.mjs';
import { readJournal, appendEvent, verifyJournal, proveEntry } from '../src/journal.mjs';
import { exportJournal, SIEM_FORMATS } from '../src/siem.mjs';
import { summarizeJournal } from '../src/roi.mjs';
import { resolveActor, setAmbientActor, actorLabel } from '../src/actor.mjs';
import { forensics, renderForensics } from '../src/forensics.mjs';
import { git, listTrackedFiles, historyCompleteness } from '../src/git.mjs';
import { checkEntitlement, licenseStatus, activateLicense, deactivateLicense, LicenseError } from '../src/license.mjs';
import { loadPolicy, loadPolicyFrom, loadGatePolicy, evaluatePolicy, gateVerdict } from '../src/team/policy.mjs';
import { fleetScan, fleetAudit } from '../src/team/fleet.mjs';
import { sinkExport } from '../src/team/audit-sink.mjs';
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
  hotspots            files shared by multiple workstreams (aggregated, low-noise)
  duplicates          pairs that built the same thing  [--deep]                (P3)
  context <id>        what an agent in <id> needs to know about its siblings   (P2)
  plan                drop / collapse / land-in-this-order                     (P5)
  impact              who DEPENDS on what another workstream changed  (not a conflict check)
  order               landing order: parallel lanes + min-entanglement sequence
  partition           pre-flight split for N agents  [--agents <n>]   (1–256, collision-free start map)
  branches            the branch graveyard: landed / content-landed / unlanded  [--apply]
  journal             hash-chained audit trail of every protect / UNPROTECT / rescue /
                      clean / branch-delete / blocked, with WHO did it
                      --verify        re-hash the chain; names the exact entry that broke
                      --prove <seq>   offline RFC 6962 inclusion proof for one entry
                      --export <fmt>  ocsf | ecs | cef | json | csv | intoto   (free)
                      --summary       the ROI view — losses prevented, hours saved
                      --sink <path>   CONTINUOUS cursor-tracked export into a SIEM  [team]
                      --fleet <dir>   verify + aggregate every repo's trail        [team]
  forensics [<id>]    which agent destroyed what, and when: created / wrote / attempted /
                      BLOCKED / survived, attributed to the agent session that did it
                      [--since <iso>] [--agent <id>]
                      --fleet <dir>...: correlate one agent session across every repo  [team]
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
  --export <fmt>      journal: ocsf | ecs | cef | json | csv | intoto
                      (your own repo's log, in the format your SIEM ingests — free)
  --force             journal --export: emit even though the chain does not verify;
                      every record is then stamped with the integrity failure
  --all               collisions: also show bare file overlap (hidden by default: it is
                      high-volume and low-evidence; landing order always uses it)
  --limit <n>         hotspots/duplicates/collisions: max rows (1–100)
  --max-depth <n>     fleet: directory depth to search for repositories (default 3)
  --since <iso>       forensics: ignore events before this date
  --agent <id>        forensics: only this agent's events
  --session <id>      hook: the host's session id, when it cannot pipe its own event
  --invocation <id>   hook: the host's per-call id
  --base <ref>        compare against <ref>            (default: origin/HEAD, then main/master…)
  --family-window <s> seconds within which workstreams created close together count as one dispatch (default: 3600)
  --cwd <path>        repository to inspect            (default: cwd)
  --no-symbols        skip symbol extraction (faster, file-level only)
  --strict-read-only  never write objects; committed deltas become APPROXIMATE
  --concurrency <n>   parallel git operations          (default: 8)
  --include-primary   also scan the primary worktree
  --deep              duplicates: additionally run jscpd token clone detection
  --collapse          plan: show exact, durable supersededBy recommendations only
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
  .holtrc.json        in the repository root: familyOverrides, guardAllow, maintenanceFloor, maintenanceRatio
                      absent is fine; present-and-invalid is a hard error (exit 2), never silent

  guardAllow          THE HUMAN ESCAPE HATCH for the guard. Each entry is a regex that must match
                      ONE WHOLE command; a compound command is approved only when every one of its
                      commands is. An entry whose wildcard could span a command separator (".*",
                      "\\S", "[^…]") is declined with a reason — it would approve commands nobody
                      read. Every use is journalled and announced to the user.
                      This is deliberately not something holt asks an AGENT to write: it is your
                      decision, in a file you review.

  HOLT_HOOK_FAIL_OPEN=1   BREAK GLASS for a CRASH, not for a refusal. If holt's analyser throws,
                      this lets the command through instead of blocking you behind a broken tool,
                      and says so. It does NOT overrule a verdict: a command holt has decided to
                      refuse is still refused with this set — measured, exit 2 either way. To get
                      past a refusal holt should not have made, add a bounded guardAllow entry
                      (see above); that path is reviewed and journalled, which is why it is the one
                      that exists.

QUICK START
  holt setup                     # first run: install backends, wire agents, show what's at risk
  holt status                    # see what your workstreams produced
  holt risk                      # find work that exists nowhere else
  holt clean                     # see what's disposable (dry-run; add --apply to remove)
  holt gate <id>                 # pre-delete check: exit 0 = safe, 1 = holds unique work, 2 = unknown
  holt protect                   # lock at-risk worktrees so 'git worktree remove --force' refuses

Full documentation: https://raed2180416.github.io/holt/
`;

/**
 * A NUMERIC FLAG IS PARSED, NOT COERCED. `Number(x) || fallback` did three wrong things at once.
 *
 * src/mcp/server.mjs:466-472 writes holt's own contract for exactly this: "REJECT wrong type …
 * CLAMP+SAY a number outside its declared range … nothing is silent." The MCP layer obeys it; the
 * CLI did not, and the gap was invisible because both were "working".
 *
 *   `--max-depth abc`  -> NaN, then `|| 3`  -> silently ran at depth 3 as if 3 had been typed.
 *   `--columns abc`    -> silently 120.
 *   `--max-depth 0`    -> 0 is FALSY, so a value the user chose on purpose was silently replaced.
 *
 * Accepting garbage and proceeding as though a real value had been supplied is the meta-root in
 * miniature: acting on a number nobody derived. Out-of-range is clamped rather than refused —
 * `--columns 99999` has an obvious intended meaning and refusing it would be over-refusal — but
 * the clamp is ANNOUNCED, because a silent clamp is the same defect wearing a different hat.
 */
function numericFlag(name, raw, { min, max, integer = true }) {
  if (raw === undefined) throw new Error(`${name} needs a value`);
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got ${JSON.stringify(raw)}`);
  if (integer && !Number.isInteger(n)) throw new Error(`${name} must be a whole number, got ${JSON.stringify(raw)}`);
  if (n < min) {
    process.stderr.write(`holt: ${name} ${n} is below the minimum ${min} — using ${min}.\n`);
    return min;
  }
  if (n > max) {
    process.stderr.write(`holt: ${name} ${n} is above the maximum ${max} — using ${max}.\n`);
    return max;
  }
  return n;
}

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
      case '--collapse': opts.collapse = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--apply': opts.apply = true; break;
      case '--release': opts.release = true; break;
      case '--force': opts.force = true; break;
      case '--reason': opts.reason = argv[++i]; break;
      case '--run': opts.run = argv[++i]; break;
      case '--agents': {
        const agents = Number(argv[++i]);
        if (!Number.isInteger(agents) || agents < 1 || agents > MAX_PARTITION_AGENTS) {
          throw new Error(`--agents must be an integer from 1 to ${MAX_PARTITION_AGENTS}`);
        }
        opts.agents = agents;
        break;
      }
      case '--autoprotect': opts.autoprotect = true; break;
      case '--export': opts.exportFmt = argv[++i]; break;
      case '--summary': opts.summary = true; break;
      case '--verify': opts.verify = true; break;
      case '--prove': opts.prove = argv[++i]; break;
      case '--sink': opts.sink = argv[++i]; break;
      case '--fleet': (opts.fleetRoots ??= []).push(argv[++i]); break;
      case '--since': opts.since = argv[++i]; break;
      case '--force': opts.force = true; break;
      case '--all': opts.includeCoLocated = true; break;
      case '--limit': {
        const limit = Number(argv[++i]);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('--limit must be an integer from 1 to 100');
        opts.limit = limit;
        break;
      }
      case '--install': opts.install = true; break;
      case '--yes': case '-y': opts.yes = true; break;
      case '--max-depth': opts.maxDepth = numericFlag('--max-depth', argv[++i], { min: 1, max: 64 }); break;
      case '--fail-on-unlanded': opts.failOnUnlanded = true; break;
      case '--max-age-days': opts.maxAgeDays = numericFlag('--max-age-days', argv[++i], { min: 0, max: 36500 }); break;
      case '--ignore': (opts.ignore ??= []).push(argv[++i]); break;
      case '--snapshot': opts.snapshot = true; break;
      case '--columns': opts.columns = numericFlag('--columns', argv[++i], { min: 20, max: 1000 }); break;
      case '--rows': opts.rowsOpt = numericFlag('--rows', argv[++i], { min: 5, max: 500 }); break;
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
      case '--session': opts.session = argv[++i]; break;
      case '--invocation': opts.invocation = argv[++i]; break;
      case '--agent': opts.agent = argv[++i]; break;
      case '--since': opts.since = argv[++i]; break;
      case '--fleet': opts.fleet = true; break;
      case '--bin': opts.bin = argv[++i]; break;
      case '--remove': opts.remove = true; break;
      case '--concurrency': opts.concurrency = numericFlag('--concurrency', argv[++i], { min: 1, max: 64 }); break;
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

/** The shipped version, read once. Stamped into every SIEM record so a log names its producer. */
let _version = null;
async function holtVersion() {
  if (_version) return _version;
  try {
    _version = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch { _version = '0'; }
  return _version;
}

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
 * The inline-flag half of `holt ci` — the free gate a single repo runs on itself.
 *
 * Extracted so it can be evaluated INDEPENDENTLY of the policy branch. A policy the base ref
 * does not carry must not be able to switch these off (see loadGatePolicy): the checks a user
 * asked for on the command line are the one thing a file inside the candidate cannot revoke.
 */
function inlineFlagFailures(audit, ignore, opts) {
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
  return failures;
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
    // WHICH WORKTREES ARE ACTUALLY WIRED, because "integrate ran once" is not the same fact.
    //
    // Every host reads its project config relative to where it runs, and `git worktree add`
    // copies no untracked files — so a worktree created AFTER integrate has no hooks, and an
    // agent dispatched into it runs unprotected while the repository looks integrated. integrate
    // now wires every worktree that exists when it runs; this is what makes the ones created
    // afterwards visible instead of silently unguarded.
    unwiredWorktrees: await (async () => {
      const rows = [];
      for (const w of disc.workstreams ?? []) {
        if (!w.path) continue;
        // eslint-disable-next-line no-await-in-loop -- one stat per worktree, bounded by the repo
        const wired = await fs.stat(path.join(w.path, '.claude', 'settings.json')).then(() => true).catch(() => false);
        // eslint-disable-next-line no-await-in-loop
        const mcp = await fs.stat(path.join(w.path, '.mcp.json')).then(() => true).catch(() => false);
        if (!wired && !mcp) rows.push(w.id);
      }
      return rows;
    })(),
  };

  if (opts.json) return emitJson(info);

  out(paint('bold', 'holt doctor'));
  out('');
  out(`  node              ${info.node}`);
  out(`  repository        ${info.repo ?? paint('red', info.bare ? 'bare repository (no working tree) — holt needs a checkout' : 'not a git repository')}`);
  out(`  workstreams       ${info.workstreams}  (${info.workstreams - 1} linked + 1 primary)`);
  if (info.unwiredWorktrees.length) {
    out(`  ${paint('yellow', 'unwired')}           ${info.unwiredWorktrees.length} worktree(s) have no holt config — an agent working there is `
      + 'NOT guarded');
    out(paint('grey', `                    ${info.unwiredWorktrees.slice(0, 5).join(', ')}`
      + `${info.unwiredWorktrees.length > 5 ? ` … +${info.unwiredWorktrees.length - 5}` : ''}`));
    out(paint('grey', '                    fix: `holt integrate`  (it wires every worktree that exists when it runs)'));
  }
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
 * WHEN holt ITSELF BREAKS, WHAT DOES THE HOST GET TOLD?
 *
 * It used to get told "proceed", silently, and that is not a decision anyone made. Every exit
 * code in the PreToolUse path was produced deliberately EXCEPT this one: an exception anywhere in
 * the analysis fell past cmdHook to `main().catch`, which is the CLI's error handler and exits 1
 * because 1 is what a broken CLI exits. For the hook, 1 means the opposite of what it means for a
 * CLI. The host's documentation is explicit — "For most hook events, only exit code 2 blocks the
 * action. Claude Code treats exit code 1 as a non-blocking error and proceeds with the action"
 * (code.claude.com/docs/en/hooks) — so the only effect a crash ever had was to run the command.
 *
 * MEASURED, through the real hook, before this existed:
 *     rm -rf x[z-a] ../vc-wt   ->  exit 1, empty stdout, the worktree deleted.
 *     rm -rf ../vc-wt          ->  exit 2, blocked.       (the control, same worktree)
 * Two exit codes, two contracts, one handler, and the destructive one was the accident.
 *
 * WHAT IT DOES NOW, and why this shape:
 *
 * Every mature policy checker treats "the checker broke" as a THIRD outcome, distinct from allow
 * and deny, and makes the allow/deny choice for it explicit rather than an accident of control
 * flow: sudo's plugin API returns -1 for an error separately from 0/1 for the decision; nginx
 * `auth_request` counts anything that is not 2xx/401/403 as an error and denies; Envoy's
 * `ext_authz` defaults `failure_mode_allow` to false AND stamps every request that got through on
 * a failure; Kubernetes admission webhooks default `failurePolicy: Fail`; Cursor ships
 * `failClosed`. The consistent answer to "but permanent fail-closed on a persistent bug makes it
 * unusable" is NOT to fail open — it is to SHRINK THE SCOPE so a failure costs less (Kubernetes'
 * own documented mitigation) and to provide a pre-existing, out-of-band, auditable break-glass.
 *
 * So the scope is shrunk with holt's own pure phase. `resolveCommand` is string analysis with
 * zero I/O; it is what recognises a destructive verb in the first place, and it survives the
 * inputs that break the layers above it (the measured crash above happens two layers deeper, in
 * assessFileTargets). If it reports NO destructive shape at all, holt has a positive statement
 * from an intact check that this command cannot be one of the ones it exists to stop, and the
 * command proceeds — with the failure stated, never swallowed. If it reports a destructive shape,
 * or is itself unable to answer, the command STOPS: holt has no verdict, and a command that can
 * destroy work must not run on a guard's silence.
 *
 * The break-glass is `HOLT_HOOK_FAIL_OPEN=1`, deliberately an ENVIRONMENT VARIABLE and not a
 * config key: `.holtrc.json` is an ordinary in-repo file that the unguarded Write and Edit tools
 * can author, so an in-repo switch is one an agent can flip for itself. Every command it lets
 * through is stamped in the host's own user-visible channel and written to the journal, which is
 * Envoy's `failure_mode_allow_header_add` rule: fail-open may be permitted, never silent.
 *
 * @param {string} command
 * @param {any} error
 * @param {{failOpen?: boolean}} [opts]
 * @returns {{decision:'allow'|'ask', reason:string|null, kind:string, targets:any[], files:any[],
 *   internalError:true, internalErrorMessage:string, systemMessage?:string}}
 */
function internalErrorVerdict(command, error, { failOpen = false } = {}) {
  const msg = error?.message ?? String(error);
  const detail = `holt's own analysis failed on this command (${msg}).`;

  if (failOpen) {
    return {
      decision: 'allow', reason: null, kind: 'holt internal error (HOLT_HOOK_FAIL_OPEN)',
      targets: [], files: [], internalError: true, internalErrorMessage: msg,
      systemMessage: `holt did NOT check this command — ${detail} HOLT_HOOK_FAIL_OPEN is set, so it `
        + 'was allowed unchecked. Every command is unguarded while that variable is set.',
    };
  }

  // The cheap, pure, independently-surviving question: is there a destructive verb here at all?
  // BOTH GRANULARITIES, or the scope is narrower than the thing it is scoping. `matches` is the
  // worktree-level destructive verb table; `resolvedPaths` is the file layer's set of paths the
  // command writes over, moves or truncates — measured: without it, `mv <the only copy> /tmp/x`
  // and `> <the only copy>` proceeded during a total analyser failure, which is the same
  // file-granular blind spot assessCommand itself already refuses to have.
  // A FAILURE BEFORE THE COMMAND WAS EVEN READ CANNOT BE SCOPED, so it is not scoped down. The
  // whole policy rests on a positive statement from an intact check — "this command contains no
  // verb that can destroy work" — and there is no command here to make that statement about.
  if (typeof command !== 'string' || !command.trim()) {
    return {
      decision: 'ask',
      kind: 'holt internal error (before the command was read)',
      targets: [], files: [], internalError: true, internalErrorMessage: msg,
      reason: `${detail}\nIt failed before it could read the command, so holt cannot say what this `
        + 'one does. Confirm it yourself.\n'
        + 'If holt is persistently broken here, set HOLT_HOOK_FAIL_OPEN=1 in the environment that '
        + 'starts your agent to keep working unguarded, and please report this: '
        + 'https://github.com/Raed2180416/holt/issues',
    };
  }

  let shape = null;
  try {
    const resolved = resolveCommand(command);
    shape = (resolved.matches.length || resolved.unresolved.length || resolved.resolvedPaths.length)
      ? (resolved.matches[0]?.kind ?? resolved.unresolved[0]
        ?? `a write to ${resolved.resolvedPaths[0]?.path ?? 'a path'}`)
      : null;
  } catch (triageError) {
    shape = `the triage could not read it either (${triageError?.message ?? triageError})`;
  }

  if (!shape) {
    return {
      decision: 'allow', reason: null, kind: 'holt internal error (no destructive verb)',
      targets: [], files: [], internalError: true, internalErrorMessage: msg,
      systemMessage: `${detail} This command contains no verb that can destroy work, so it was `
        + 'allowed — but holt is broken here and should be reported: '
        + 'https://github.com/Raed2180416/holt/issues',
    };
  }

  return {
    decision: 'ask',
    kind: 'holt internal error',
    targets: [],
    files: [],
    internalError: true,
    internalErrorMessage: msg,
    reason: `${detail}\n`
      + `This command reaches "${shape}", so holt has stopped it rather than guessed: an unchecked `
      + 'command is not a checked one, and this is the shape of command holt exists to check.\n'
      + 'Confirm it yourself, or re-run it in a form holt can read.\n'
      + 'If holt is persistently broken here, set HOLT_HOOK_FAIL_OPEN=1 in the environment that '
      + 'starts your agent to keep working unguarded (every command it lets through is announced '
      + 'and journalled), and please report this: https://github.com/Raed2180416/holt/issues',
  };
}

/**
 * THE ONE PLACE A PreToolUse INVOCATION IS ALLOWED TO END.
 *
 * Emit the verdict in every channel a host might read — the JSON on stdout, the reason on stderr,
 * and the exit code — and then exit. Having exactly one of these is the entire point: the fault
 * this replaces was three different code paths each deciding, on their own, what exit code a
 * PreToolUse invocation ends with, and the one nobody wrote on purpose was the one that ran the
 * command.
 */
/**
 * The command this process is deciding about, and the cwd it was asked about, recorded the moment
 * they are known. They exist so the last-resort handler at the bottom of this file can reach the
 * SAME scoped decision as the in-band one: a crash before the verdict is still a crash about a
 * specific command, and answering it with "no command, therefore nothing destructive" would
 * rebuild the fail-open hole one level up.
 */
let hookCommandInFlight;
let hookCwdInFlight;
let hookVerdictEmitted = false;

/**
 * @param {any} verdict
 * @param {any} opts
 * @param {{command?: string, cwd?: string}} [ctx] the command this verdict is about, when known
 */
/**
 * FILES WHOSE REMOVAL CHANGES WHETHER HOLT RUNS AT ALL.
 *
 * holt DENIES `git worktree unlock <wt>` and ALLOWS `rm -f .git/worktrees/<wt>/locked`, which has
 * the identical effect. It allows `rm -f ~/.claude/settings.json`, which de-registers the PreToolUse
 * hook so the guard stops running in every later session. Both measured, with controls.
 *
 * That is root-cause taxonomy #2 — deciding on the SPELLING of an action rather than its EFFECT.
 *
 * The answer is NOT to refuse these. Over-refusal disqualifies exactly as under-protection does,
 * and reconfiguring or removing holt is legitimate work a user must be able to do without fighting
 * the tool being removed. What was missing is that it happened SILENTLY: the single event an audit
 * trail most exists for is the guard being switched off, and nothing recorded it.
 *
 * So this RECORDS and does not block.
 *
 * Detection uses the guard's OWN resolver, never a match on the command text. Text matching is the
 * same defect one level up: `rm -f ./AGENTS.md`, `rm -f "$PWD/AGENTS.md"` and `rm -f AGENTS.md` are
 * one action spelled three ways, and a regex would catch a different subset than the guard sees.
 *
 * @param {string} command
 * @param {string} cwd
 * @returns {string[]} absolute paths of holt's own wiring this command reaches
 */
function holtWiringTouched(command, cwd) {
  let targets;
  try { targets = resolveFileTargets(command); } catch { return []; }
  const hits = [];
  for (const t of targets ?? []) {
    const raw = t?.resolvedRaw ?? t?.raw;
    if (!raw) continue;
    const abs = path.resolve(cwd, String(raw));
    const base = path.basename(abs);
    const parts = abs.split(path.sep);
    if (base === 'settings.json' && parts.includes('.claude')) hits.push(abs);
    else if (base === '.mcp.json' || base === 'AGENTS.md' || base === 'CLAUDE.md') hits.push(abs);
    else if (base === '.holtrc.json') hits.push(abs);
    else if (base === 'locked' && parts.includes('worktrees')) hits.push(abs);
  }
  return [...new Set(hits)];
}

/**
 * @param {any} verdict
 * @param {any} opts
 * @param {{command?: string, cwd?: string}} [ctx] the command this verdict is about, when known
 */
function emitHookVerdict(verdict, opts, { command, cwd } = {}) {
  // Re-entry means the emitter itself failed. There is no verdict to report and no way to report
  // one: stop the command. Fail-closed is the only honest end for a guard that cannot speak.
  if (hookVerdictEmitted) process.exit(2);
  hookVerdictEmitted = true;
  // THE EXIT CODE IS DECIDED FIRST AND CANNOT BE LOST. Everything below it is reporting, and no
  // failure in reporting — a formatter, a JSON cycle, a journal write — may change the answer or
  // escape and land back in the CLI's exit(1). This function is the choke point; a choke point
  // that can itself throw past the exit is not one.
  const code = verdict.decision === 'allow' ? 0 : 2;
  try {
    const body = formatVerdict(verdict, { host: opts.host, eventName: 'PreToolUse' });
    // `systemMessage` is a universal top-level hook field — "A warning message shown to the user".
    // It is the channel for an allow that nobody should mistake for a clean bill of health. Exit 2
    // ignores stdout entirely, so it is only attached when the command is proceeding.
    if (verdict.decision === 'allow' && verdict.systemMessage) body.systemMessage = verdict.systemMessage;
    const speak = verdict.decision !== 'allow' || opts.host !== 'claude-code' || body.systemMessage;
    if (speak) out(JSON.stringify(body));
    if (verdict.decision !== 'allow' && verdict.reason) process.stderr.write(`${verdict.reason}\n`);
    // An internal failure is never invisible, whichever way it was resolved.
    if (verdict.internalError && verdict.decision === 'allow') {
      process.stderr.write(`holt: ${verdict.systemMessage}\n`);
    }
    if (verdict.internalError) {
      appendEvent(cwd, {
        action: verdict.decision === 'allow' ? 'internal-error-allowed' : 'internal-error-blocked',
        command: String(command ?? '').slice(0, 200), error: verdict.internalErrorMessage ?? null,
      }).catch(() => {});
    }
  } catch (reportingError) {
    // Say what happened on the one channel that needs nothing to work, and keep the verdict.
    try { process.stderr.write(`holt: could not render its verdict (${reportingError?.message ?? reportingError})\n`); } catch { /* nothing left */ }
    process.exit(code === 0 ? 2 : code);   // a verdict nobody can read is not an allow
  }
  process.exit(code);
}

/** Is this process a PreToolUse hook invocation? Decides whether exit 1 is survivable. */
function isPreToolUseInvocation(argv = process.argv) {
  const args = argv.slice(2).filter((a) => !a.startsWith('-'));
  return args[0] === 'hook' && (args[1] ?? 'pre-tool-use') === 'pre-tool-use';
}

/**
 * Hook entry point.
 *
 * Exit codes are part of the contract for hosts that branch on them rather than parsing JSON:
 *   0 = allow · 2 = deny, ask, or could-not-verify
 *
 * DENY AND ASK SHARE 2, DELIBERATELY, AND 1 IS NEVER EMITTED. This comment used to say
 * "1 = deny", which no code path can produce — `const code = verdict.decision === 'allow' ? 0 : 2`
 * is the only place a hook exit code is chosen. A host written against the old comment would wait
 * for a 1 that never arrives and read every DENIAL as the softer "ask". The collapse is intended:
 * a host that cannot express "ask" must stop, not proceed, when holt could not verify what a
 * command does — so the safe verdict and the unverified verdict deliberately look identical from
 * the outside. Hosts needing the distinction parse the JSON, which carries it exactly.
 */
async function cmdHook(opts) {
  const event = opts._[1] ?? 'pre-tool-use';
  const raw = opts.command ? '' : await readStdin();

  // A LEADING BOM IS NOT AN UNREADABLE PAYLOAD, IT IS THREE BYTES OF ENCODING PREAMBLE.
  //
  // JSON.parse throws on it, and everything downstream is fail-closed, so a single BOM turned every
  // tool call in the session into an "holt could not parse the hook payload" prompt — a guard that
  // interrupts constantly for a reason the reader cannot act on is a guard that gets uninstalled.
  // A BOM in front of otherwise valid JSON is emitted by real hosts (any writer using a UTF-8-BOM
  // encoder), so it is stripped and the payload is processed normally. Anything STILL unparseable
  // stays an ask: absence of evidence is not evidence of absence.
  let payload = {};
  let payloadError;
  if (raw.trim()) {
    try {
      payload = JSON.parse(raw.replace(/^\uFEFF/, ''));
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('payload must be a JSON object');
    } catch (error) {
      payload = {};
      payloadError = error;
    }
  } else if (event === 'pre-tool-use' && !opts.command) {
    payloadError = new Error('hook payload is empty');
  }

  // Hosts that cannot pipe their event to holt (the OpenCode plugin calls the CLI with flags)
  // hand identity over on the command line instead. Merged UNDER the payload: a host that sent
  // its own event always outranks a flag, because the payload is the host speaking and the flag
  // is a generated integration repeating what it was told.
  if (opts.session && !payload.session_id && !payload.sessionID) payload.sessionID = opts.session;
  if (opts.invocation && !payload.tool_use_id && !payload.callID) payload.callID = opts.invocation;

  const actor = resolveActor({ payload, host: opts.host, via: 'hook' });
  setAmbientActor(actor);

  const cwd = payload.cwd || opts.cwd;

  if (event === 'pre-tool-use') {
    if (payloadError) {
      const verdict = {
        decision: 'ask',
        reason: `holt could not parse the hook payload (${payloadError.message}). Confirm the command manually before proceeding.`,
      };
      out(JSON.stringify(formatVerdict(verdict, { host: opts.host, eventName: 'PreToolUse' })));
      process.stderr.write(`${verdict.reason}\n`);
      process.exit(2);
    }
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
    hookCommandInFlight = command;
    hookCwdInFlight = cwd;

    // Only shell-ish tools can destroy a worktree. Anything else is allowed without a scan,
    // which keeps the hook off the critical path for the overwhelming majority of tool calls.
    const shellish = !toolName || /^(Bash|Shell|Terminal|run_command|execute)$/i.test(toolName);
    if (!shellish || !command) {
      if (opts.host !== 'claude-code') {
        out(JSON.stringify(formatVerdict({ decision: 'allow', reason: null }, { host: opts.host })));
      }
      return;
    }

    // THE ANALYSIS IS ALLOWED TO FAIL. IT IS NOT ALLOWED TO FAIL SILENTLY INTO "PROCEED".
    // Anything thrown here used to leave through main().catch and exit 1, which the host reads as
    // a non-blocking error and runs the command. See internalErrorVerdict.
    let verdict;
    try {
      verdict = await assessCommand(command, cwd, { guardAllow: opts.guardAllow });
    } catch (error) {
      verdict = internalErrorVerdict(command, error, { failOpen: process.env.HOLT_HOOK_FAIL_OPEN === '1' });
    }
    if (verdict.allowlisted) {
      await appendEvent(cwd, {
        action: 'allowlisted', source: 'guardAllow', command: String(command).slice(0, 200),
        pattern: verdict.allowlistPattern ?? null,
      }, { actor }).catch(() => {});
    }

    // SWITCHING THE GUARD OFF IS THE ONE EVENT AN AUDIT TRAIL MOST EXISTS FOR, and it was the one
    // event nothing recorded. Only on a verdict that lets the command PROCEED: a refusal did not
    // happen, and the refusal path already journals its own prevented loss. Best-effort and
    // last — like every other write here, logging must never delay or alter the hook.
    if (verdict.decision === 'allow') {
      const wiring = holtWiringTouched(command, cwd);
      if (wiring.length) {
        await appendEvent(cwd, {
          action: 'holt-wiring-touched',
          command: String(command).slice(0, 200),
          paths: wiring.slice(0, 8),
          note: 'a command holt ALLOWED reaches holt\'s own installation. Allowed on purpose — '
            + 'reconfiguring or removing holt is legitimate and must not require fighting it — '
            + 'and recorded because after this the guard may no longer be running.',
        }, { actor }).catch(() => {});
      }
    }
    // Record a prevented loss, so `holt journal --summary` can show the champion a real number:
    // "N destructive commands refused." Best-effort — logging must never delay or alter the hook.
    //
    // THE REFUSAL USED TO END BY TEACHING THE READER HOW TO SWITCH THE GUARD OFF: "add a matching
    // guardAllow pattern to .holtrc.json". Every reader of a PreToolUse refusal is an AGENT — that
    // is the channel's whole purpose — and `.holtrc.json` is an ordinary in-repo file that the
    // unguarded Write and Edit tools can author. So the deny message closed its own loop: refuse,
    // hand over the recipe, get overruled by the party that was just refused. An agent does not
    // invent `.holtrc.json` on its own; it was told.
    //
    // The escape hatch still exists and is still documented (`holt hook --help`, the README, and
    // src/config.mjs) — for a HUMAN, in the places a human looks. It is no longer offered as the
    // next step to the party being refused. What the message says instead is what the agent can
    // actually do that does not lose anything: capture it, or report back.
    //
    // RECORD THE ATTEMPT, NOT ONLY THE COMPLETION. `ask` matters MORE than deny, not less. `deny`
    // means holt stopped it. `ask` means holt could not verify what the command would destroy and
    // handed the decision back to the host, which may well have proceeded. That is exactly the
    // line a reviewer needs and it was discarded, leaving a timeline in which the destruction has
    // no antecedent.
    const renderedVerdict = verdict.decision === 'allow' || !verdict.reason
      ? verdict
      : {
        ...verdict,
        reason: `${verdict.reason}\nIf you believe this is wrong, say so and stop — do not edit `
          + 'holt\'s configuration to get past it. Overruling this is a human decision, and it is '
          + 'journalled.',
      };
    if (verdict.decision === 'deny' || verdict.decision === 'ask') {
      await appendEvent(cwd, {
        action: verdict.decision === 'deny' ? 'blocked' : 'unverified',
        command: String(command).slice(0, 200),
        reason: renderedVerdict.reason ?? null,
        kind: verdict.kind ?? null,
        targets: Array.isArray(verdict.targets) ? verdict.targets : [],
        tool: toolName ?? null,
      }, { actor }).catch(() => {});
    }

    // A BYPASS THAT NOBODY CAN SEE IS A BYPASS NOBODY CAN AUDIT. An allowlisted destroyer used to
    // exit 0 emitting nothing at all on this host, so the one command in the session that
    // overruled holt's evidence was the one command holt said nothing about. Envoy's rule for the
    // same situation — `failure_mode_allow_header_add` — is that a decision reached by bypass is
    // stamped. `systemMessage` is the host's own user-visible field for exactly this.
    if (verdict.allowlisted && !verdict.systemMessage) {
      verdict.systemMessage = `holt did not check "${String(command).slice(0, 120)}" — a guardAllow `
        + `entry in .holtrc.json (${verdict.allowlistPattern}) approves it. If you did not put that `
        + 'entry there, treat it as a change to your safety configuration.';
      renderedVerdict.systemMessage = verdict.systemMessage;
    }

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
    emitHookVerdict(renderedVerdict, opts, { command, cwd });
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

  // WHO IS RUNNING THIS, resolved once for the whole process, before any command can record an
  // event. `holt clean` invoked by an agent and `holt clean` typed by a human are the same
  // command and produce the same journal line unless identity is established here — and the
  // agent case is the one an incident review is about. Resolution reads the environment only;
  // when the environment says nothing the actor is `unknown`, never a stand-in.
  setAmbientActor(resolveActor({ host: opts.host, via: 'cli' }));

  if (opts.help || cmd === 'help') { out(USAGE); return; }
  // Every packaged CLI is expected to answer this, and holt answered none of the four spellings
  // people try. A bug report that cannot say which version produced it is not actionable.
  if (opts.version || cmd === 'version') {
    out(`holt ${await holtVersion()}`);
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
    if (cfg.config.guardAllow !== undefined) opts.guardAllow = cfg.config.guardAllow;
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
  // ORDER / PARTITION / BRANCHES RENDER IN src/render.mjs, NOT HERE. They used to be written out
  // inline, and inline in this file means outside the one place the untrusted-content gate can
  // enumerate — which is exactly how `holt order` and `holt partition` came to print a worktree
  // basename raw while `holt collisions` fenced the same value correctly. See renderOrder().
  if (cmd === 'order') {
    const { report } = await buildReport(opts);
    const plan = landingOrder(report);
    if (opts.json) return emitJson(plan);
    out(renderOrder(plan));
    return;
  }
  if (cmd === 'partition') {
    const { report, scanned } = await buildReport(opts);
    const plan = partitionPlan(report, await listTrackedFiles(scanned.root), { agents: opts.agents ?? 2 });
    if (opts.json) return emitJson(plan);
    out(renderPartition(plan));
    return;
  }
  if (cmd === 'hotspots') {
    const { report } = await buildReport(opts);
    const limit = opts.limit ?? 12;
    const rows = report.hotspots ?? [];
    if (opts.json) {
      emitJson({ total: rows.length, returned: Math.min(rows.length, limit), truncated: rows.length > limit, hotspots: rows.slice(0, limit) });
    } else out(renderHotspots(report, limit));
    return;
  }
  if (cmd === 'branches') {
    const audit = await branchAudit(opts.cwd, opts);
    if (opts.json) { emitJson(audit); if (!audit.ok) process.exit(2); return; }
    if (!audit.ok) {
      process.stderr.write(paint('red', `holt branches: ${audit.reason}\n`));
      process.exit(2);
    }
    out(renderBranches(audit));
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
    const ciRoot = (await discover(opts.cwd, opts)).root;

    // PRECONDITION, checked before any mode branch so no future mode can be added around it:
    // holt can only say "nothing was abandoned" if it can SEE the history. A shallow or grafted
    // checkout — actions/checkout's default fetch-depth of 1 — produces an empty audit for the
    // same reason a blindfold produces an empty room. Absent evidence REFUSES; it never passes.
    // Skipped when there is no repository at all: that is a different failure, and branchAudit
    // below already names it precisely.
    const hist = ciRoot ? await historyCompleteness(ciRoot) : { complete: true, kind: 'complete' };
    if (!hist.complete) {
      const payload = {
        ok: false, code: `incomplete-history:${hist.kind}`, history: hist,
        reason: `holt ci refuses to render a verdict here — ${hist.reason}`,
        fix: hist.fix,
      };
      if (opts.json) { emitJson(payload); process.exit(2); }
      process.stderr.write(paint('red', `holt ci: ${payload.reason}\n`) + paint('grey', `  ${hist.fix}\n`));
      process.exit(2);
    }

    const audit = await branchAudit(opts.cwd, opts);
    if (!audit.ok) { process.stderr.write(paint('red', `holt ci: ${audit.reason}\n`)); process.exit(2); }
    const ignore = new Set([...(opts.ignore ?? []), process.env.GITHUB_HEAD_REF].filter(Boolean));

    // Policy as code, when the repository declares one. A declared policy that cannot be
    // enforced is a hard failure in BOTH directions: unreadable policy exits 2, and an
    // unlicensed policy exits 3 — never a silent pass, which would tell a team they are
    // covered when nothing ran.
    //
    // The policy is read from the BASE the audit compared against, never from the working tree:
    // a pull request may propose rules, it may not enact them upon itself. See loadGatePolicy.
    let loaded;
    try {
      loaded = await loadGatePolicy(ciRoot ?? opts.cwd, { baseRef: audit.base?.oid ?? null });
    } catch (e) {
      if (opts.json) { emitJson({ ok: false, code: e.code, reason: e.message }); process.exit(2); }
      process.stderr.write(paint('red', `holt ci: ${e.message}\n`));
      process.exit(2);
    }
    // Flag failures are computed BEFORE the policy branch because an UNTRUSTED policy — one the
    // base does not carry — must never suppress them. Otherwise a PR that merely adds a
    // permissive .holt/policy.json neutralises `--fail-on-unlanded`, which is the same defect
    // as editing the policy, through a different door.
    const flagFailures = inlineFlagFailures(audit, ignore, opts);
    if (loaded.found) {
      const ent = checkEntitlement('policy-file');
      if (!ent.entitled) {
        // WHICH policy was found is part of the refusal: a reader has to be able to tell that the
        // rules came from the base and not from the change being judged.
        const from = loaded.trusted ? `${loaded.ref}:${loaded.path}` : `${loaded.path} (working tree)`;
        const payload = { ok: false, code: 'unlicensed-policy', policy: loaded.path,
          policySource: loaded.source, policyTrusted: !!loaded.trusted, policyRef: loaded.ref ?? null,
          entitlement: ent,
          reason: `${from} declares a policy but ${ent.reason}. Refusing to pass a build against a policy that did not run.` };
        if (opts.json) { emitJson(payload); process.exit(3); }
        process.stderr.write(paint('red', `holt ci: ${payload.reason}\n`) + paint('grey', `  ${ent.fix}\n`));
        process.exit(3);
      }
      const { report } = await buildReport(opts).catch(() => ({ report: null }));
      const res = evaluatePolicy(loaded.policy, { audit, report, ignore: [...ignore] });
      // An untrusted policy (base has none — see loadGatePolicy) may ADD failures and never
      // remove them, so whatever the inline flags would have failed on still fails.
      const verdict = gateVerdict({ policyResult: res, flagFailures, trusted: loaded.trusted });
      const carried = verdict.carriedFlagFailures;
      const ok = verdict.ok;
      const payload = {
        ok, mode: 'policy', policy: loaded.path,
        policySource: loaded.source, policyTrusted: !!loaded.trusted,
        policyRef: loaded.ref ?? null, policyNote: loaded.note ?? null,
        entitlement: { tier: ent.tier, org: ent.org ?? null },
        rulesEvaluated: res.rulesEvaluated, errors: res.errors, warnings: res.warnings,
        violations: res.violations, exempted: res.exempted,
        flagFailures: carried,
        note: 'requires full refs (actions/checkout with fetch-depth: 0)',
      };
      if (opts.json) { emitJson(payload); process.exit(ok ? 0 : 1); }
      const origin = loaded.trusted ? `from base ${loaded.ref}` : 'from the WORKING TREE (base declares none)';
      out(paint('bold', `holt ci — policy ${loaded.path}`) + paint('grey', `  ${res.rulesEvaluated.length} rule(s) · ${ent.tier} license · ${origin}`));
      for (const v of res.violations) {
        const c = v.severity === 'error' ? 'red' : 'yellow';
        out(`  ${paint(c, v.severity.toUpperCase())} ${paint('bold', v.rule)}  ${v.message}`);
        for (const e of v.evidence ?? []) out(paint('grey', `      ${e}`));
      }
      for (const f of carried) out(`  ${paint('red', 'ERROR')} ${paint('bold', 'ci-flags')}  ${f}`);
      if (ok) out(paint('green', `\n  PASS — ${res.warnings} warning(s), 0 errors\n`));
      else out(paint('red', `\n  FAIL — ${verdict.errors} error(s), ${verdict.warnings} warning(s)\n`));
      process.exit(ok ? 0 : 1);
    }
    const unlanded = audit.unlanded.filter((b) => !ignore.has(b.name));
    // A SHALLOW CLONE CANNOT ANSWER THIS QUESTION, AND SAYING `ok: true` ANYWAY IS THE WORST
    // FAILURE THIS COMMAND HAS.
    //
    // `holt ci` exists to fail a merge that abandons work. `actions/checkout` defaults to
    // `fetch-depth: 1` — SHALLOW — so the DEFAULT GitHub Actions installation gave a gate that
    // always passed. Measured on one repository, same command:
    //     full clone     holt ci --fail-on-unlanded  -> exit 1, unlanded work correctly reported
    //     shallow clone  holt ci --fail-on-unlanded  -> exit 0, {"ok":true,"unlanded":[],"unknown":[]}
    // and the word "shallow" appeared nowhere in the output. The `note` below is printed
    // unconditionally, so it is boilerplate, not a detection — a team adopts the gate, sees green on
    // every PR, and concludes they are protected.
    //
    // That is absence of evidence reported as evidence of absence, inside the one command whose
    // entire purpose is to fail. It is treated exactly like `audit.unknown` below — the pattern this
    // function already had for "the instrument could not measure" — and `holt gate` already gets
    // this right by returning 2 for unknown rather than 0.
    const shallowR = await git(['rev-parse', '--is-shallow-repository'], { cwd: opts.cwd });
    const isShallow = shallowR.code === 0 && shallowR.stdout.trim() === 'true';

    const failures = [...flagFailures];
    if (isShallow && (opts.failOnUnlanded || opts.maxAgeDays)) {
      failures.unshift(
        'SHALLOW CLONE — holt cannot see the history this policy is about, so it is refusing to '
        + 'pass rather than reporting a green it did not verify. Fetch full refs: '
        + 'actions/checkout with `fetch-depth: 0`.',
      );
    }
    const result = {
      ok: flagFailures.length === 0,
      policy: { failOnUnlanded: !!opts.failOnUnlanded, maxAgeDays: opts.maxAgeDays ?? null, ignored: [...ignore] },
      failures: flagFailures,
      unlanded: unlanded.map((b) => ({ name: b.name, files: b.fileCount, ageDays: b.ageDays })),
      contentLanded: audit.contentLanded.map((b) => b.name),
      unknown: audit.unknown.map((b) => b.name),
      // MEASURED, not asserted. The `note` beneath it is advice and is printed always; this field
      // says what THIS run actually found, so a reader can tell a verified pass from an unverifiable
      // one without reading the note and guessing.
      shallow: isShallow,
      note: 'requires full refs (actions/checkout with fetch-depth: 0)',
    };
    emitJson(result);
    process.exit(result.ok ? 0 : 1);
  }
  if (cmd === 'journal') {
    const events = await readJournal(opts.cwd);

    // ---- integrity, FREE. A tamper-evident log its owner cannot check is a contradiction, so
    //      verification is never gated. Exit 1 on a broken chain: this is the shape a CI job or
    //      a nightly compliance check branches on.
    if (opts.verify) {
      const v = await verifyJournal(opts.cwd);
      if (opts.json) { emitJson(v); process.exit(v.ok ? 0 : 1); }
      out(paint('bold', 'holt journal — integrity'));
      out(`\n  ${paint(v.ok ? 'green' : 'red', v.ok ? 'VERIFIED' : `BROKEN (${v.code})`)}  ${v.reason}`);
      out(`  ${paint('grey', `${v.chained} chained · ${v.legacy} legacy (unverifiable) · root ${v.root ? v.root.slice(0, 16) : '—'}`)}`);
      if (v.checkpoint) {
        out(`  ${paint('grey', `checkpoint: ${v.checkpoint.origin} size=${v.checkpoint.size}`
          + `${v.checkpoint.signed ? ` signed by ${v.checkpoint.signers.join(', ')} (${v.checkpoint.signatureValid ? 'valid' : 'UNVERIFIED'})` : ' unsigned'}`)}`);
      }
      if (v.broken) {
        // A deleted tail has no entry left to print; a row of nulls under the words "first
        // broken entry" reads as a parse failure rather than as the deletion it is.
        out(`\n  ${paint('red', v.broken.missing ? `${v.broken.missing} record(s) MISSING from the end:` : 'first broken entry:')}`);
        if (v.broken.missing) out(`    after line ${v.broken.line - 1} (seq ${v.broken.seq - 1})`);
        else {
          out(`    line ${v.broken.line} · seq ${v.broken.seq ?? '—'} · ${v.broken.at ?? 'no timestamp'} · ${paint('bold', v.broken.action ?? 'unknown action')}`);
          if (v.broken.actor) out(`    ${paint('grey', `recorded actor: ${actorLabel(v.broken.actor)}`)}`);
        }
        out(`    ${paint('grey', v.broken.reason)}`);
      }
      out('');
      process.exit(v.ok ? 0 : 1);
    }

    // ---- an offline inclusion proof for ONE entry, FREE.
    if (opts.prove != null) {
      try {
        const p = await proveEntry(opts.cwd, Number(opts.prove));
        if (opts.json) return emitJson(p);
        out(paint('bold', `holt journal — RFC 6962 inclusion proof for entry ${p.seq}`));
        out(`  ${paint('grey', `${p.entry.at}  ${p.entry.action}  ${actorLabel(p.entry.actor)}`)}`);
        out(`  leaf   ${p.leaf}`);
        out(`  root   ${p.root}  (tree size ${p.size})`);
        out(`  path   ${p.proof.length ? p.proof.join('\n         ') : '(single-entry tree — the leaf IS the root)'}`);
        out(`\n  ${paint(p.verifies ? 'green' : 'red', p.verifies ? 'proof verifies' : 'PROOF DOES NOT VERIFY')}\n`);
        return;
      } catch (e) {
        process.stderr.write(paint('red', `holt journal --prove: ${e.message}\n`));
        process.exit(2);
      }
    }

    // ---- the continuous SIEM sink — TEAM. Everything above and below is free.
    if (opts.sink) {
      const ent = checkEntitlement('audit-sink');
      if (!ent.entitled) {
        if (opts.json) { emitJson({ ok: false, entitled: false, ...ent }); process.exit(3); }
        process.stderr.write(paint('yellow', `holt journal --sink: ${ent.reason}\n`) + paint('grey', `  ${ent.fix}\n`));
        process.stderr.write(paint('grey', "  A one-shot export of this repo is free: holt journal --export ocsf\n"));
        process.exit(3);
      }
      try {
        const r = await sinkExport(opts.cwd, {
          to: opts.sink, format: opts.exportFmt ?? 'ocsf', dryRun: opts.dryRun,
        });
        if (opts.json) return emitJson(r);
        out(paint('bold', `holt audit sink — ${r.emitted} record(s) ${r.dryRun ? 'would be ' : ''}exported`));
        out(`  ${paint('grey', `seq ${r.fromSeq} → ${r.toSeq} · ${r.format.toUpperCase()} → ${r.destination}`)}`);
        out(`  ${paint('grey', r.note)}`);
        out(`  ${paint(r.signed ? 'green' : 'yellow', r.signingNote)}\n`);
        return;
      } catch (e) {
        process.stderr.write(paint('red', `holt journal --sink: ${e.message}\n`));
        process.exit(e.code === 'EINTEGRITY' || e.code === 'EREWRITE' ? 1 : 2);
      }
    }

    // ---- fleet-wide audit aggregation — TEAM.
    if (opts.fleetRoots?.length) {
      const ent = checkEntitlement('fleet');
      if (!ent.entitled) {
        if (opts.json) { emitJson({ ok: false, entitled: false, ...ent }); process.exit(3); }
        process.stderr.write(paint('yellow', `holt journal --fleet: ${ent.reason}\n`) + paint('grey', `  ${ent.fix}\n`));
        process.exit(3);
      }
      const f = await fleetAudit(opts.fleetRoots, opts);
      if (opts.json) return emitJson(f);
      out(paint('bold', `holt fleet audit — ${f.verifiedRepositories}/${f.repositories} repositories verify`));
      out('');
      for (const r of f.repos) {
        const mark = r.verified ? paint('green', ' ok ') : paint('red', 'FAIL');
        out(`  ${mark}  ${r.name.padEnd(24)} ${String(r.entries).padStart(5)} events  ${String(r.unprotects).padStart(4)} unprotect  ${paint('grey', r.verified ? '' : r.code)}`);
      }
      out(`\n  ${paint('bold', String(f.totals.unprotects))} protection release(s) across the fleet · ${f.totals.blocked} destructive command(s) refused`);
      if (f.totals.unattributed) out(`  ${paint('yellow', `${f.totals.unattributed} event(s) have no attributable user`)}`);
      out(`  ${paint(f.unverifiedRepositories.length ? 'red' : 'grey', f.note)}\n`);
      process.exit(f.unverifiedRepositories.length || f.failures.length ? 1 : 0);
    }

    if (opts.summary) {
      const s = summarizeJournal(events);
      if (opts.json) return emitJson(s);
      out(paint('bold', 'holt — what it has prevented here'));
      out(`\n  ${paint(s.preventedLosses ? 'green' : 'grey', s.headline)}`);
      const b = s.breakdown;
      out('');
      out(`    ${paint('bold', String(b.destructiveCommandsBlocked).padStart(4))}  destructive command(s) refused`);
      out(`    ${paint('bold', String(b.attemptsHoltCouldNotVerify).padStart(4))}  attempt(s) holt could NOT verify — the host decided (not counted as prevented)`);
      out(`    ${paint('bold', String(b.workstreamsRescued).padStart(4))}  workstream(s) rescued to a verifiable ref`);
      out(`    ${paint('bold', String(b.workstreamsProtected).padStart(4))}  workstream(s) protected (holding work found nowhere else)`);
      out(`    ${paint('bold', String(b.worktreesReclaimed).padStart(4))}  disposable worktree(s) reclaimed`);
      out(`    ${paint('bold', String(b.branchesDeleted).padStart(4))}  landed branch(es) cleaned up`);
      out(`    ${paint(b.protectionsReleased ? 'yellow' : 'grey', String(b.protectionsReleased).padStart(4))}  protection(s) RELEASED (work made destroyable again — recorded with who released them)`);
      out(`\n  ${paint('grey', `~${s.estimatedHoursSaved}h saved (conservative planning estimate) · ${s.events} events since ${s.since ? s.since.slice(0,10) : '—'}`)}`);
      out(`  ${paint('grey', s.note)}\n`);
      return;
    }
    if (opts.exportFmt) {
      // A single repository's audit log is the USER'S OWN DATA, and `holt journal --json`
      // already prints all of it for free — gating a re-encoding of the same rows would be a
      // gate in name only, in EVERY format including the SIEM ones. So one-shot export is free.
      // The paid audit product is fleet-level aggregation and the CONTINUOUS, cursor-tracked
      // sink (--sink), which is where the work and the value actually are.
      //
      // The export is integrity-gated: a log that does not verify refuses to export without
      // --force, because feeding a SIEM records from a possibly-rewritten log launders the
      // tampering — downstream it is indistinguishable from a clean one.
      const verification = await verifyJournal(opts.cwd);
      try {
        process.stdout.write(exportJournal(events, opts.exportFmt, {
          verification, repo: opts.cwd, version: await holtVersion(), force: opts.force,
        }));
        return;
      } catch (e) {
        process.stderr.write(paint('red', `holt journal --export: ${e.message}\n`));
        if (e.code === 'EINTEGRITY') {
          process.stderr.write(paint('grey', '  Run `holt journal --verify` for the exact entry, or --force to export anyway (every record is then stamped as unverified).\n'));
          process.exit(1);
        }
        process.exit(2);
      }
    }
    if (opts.json) return emitJson({ events });
    if (!events.length) { out(paint('grey', 'holt journal: no recorded actions in this repository yet')); return; }
    out(paint('bold', `holt journal — ${events.length} recorded action(s)`));
    for (const e of events) {
      if (e.corrupt) { out(`  ${paint('red', 'corrupt line:')} ${e.corrupt.slice(0, 80)}`); continue; }
      const what = [e.id ?? e.name, e.ref, e.evidence ?? e.reason].filter(Boolean).join('  ');
      const who = e.actor ? paint('grey', ` ${actorLabel(e.actor)}`) : '';
      const mark = e.action === 'unprotect' ? paint('yellow', e.action) : paint('bold', e.action);
      out(`  ${paint('grey', e.at)}  ${mark}  ${what}${who}`);
    }
    out(paint('grey', '\n  `holt forensics <workstream>` reconstructs one workstream\'s full timeline, attributed.'));
    out(`\n  ${paint('grey', "integrity: holt journal --verify")}`);
    return;
  }
  if (cmd === 'forensics') {
    // FLEET CORRELATION IS THE PAID HALF. One repository's timeline below is the user's own
    // data and is free; joining a session across many repositories is the thing a single repo
    // cannot compute and a team pays for.
    if (opts.fleet) {
      const ent = checkEntitlement('forensics-fleet');
      if (!ent.entitled) {
        if (opts.json) { emitJson({ ok: false, entitlement: ent }); process.exit(3); }
        process.stderr.write(paint('yellow', `holt forensics --fleet: ${ent.reason}\n`)
          + paint('grey', `  ${ent.fix}\n`)
          + paint('grey', '  Single-repository forensics is free: run `holt forensics <workstream>` without --fleet.\n'));
        process.exit(3);
      }
      const { fleetForensics } = await import('../src/team/forensics-fleet.mjs');
      const roots = opts._.slice(1);
      if (!roots.length) roots.push(opts.cwd);
      const f = await fleetForensics(roots, { maxDepth: opts.maxDepth ?? 3, since: opts.since ?? null, agent: opts.agent ?? null });
      if (opts.json) return emitJson(f);
      out(paint('bold', `holt forensics — fleet: ${f.repositories} repositories, ${f.totals.sessions} identified agent session(s)`));
      out(paint('grey', `  ${f.roots.join(' ')}`));
      out(`\n  ${paint('bold', 'TOTALS')}  ${f.totals.events} events · ${paint(f.totals.blocked ? 'red' : 'grey', `${f.totals.blocked} refused`)} · ${f.totals.destroyed} removed · ${f.totals.crossRepoSessions} session(s) spanning >1 repo · ${f.totals.unattributedEvents} unattributed`);
      if (f.refusedThenDestroyed.length) {
        out(`\n  ${paint('red', 'REFUSED IN ONE PLACE, DESTRUCTIVE IN ANOTHER')}`);
        for (const r of f.refusedThenDestroyed.slice(0, 10)) {
          out(`    ${paint('bold', r.agent)} ${paint('grey', String(r.session).slice(0, 16))}`);
          out(paint('grey', `      blocked in: ${r.blockedIn.join(', ') || '—'}  ·  removed in: ${r.destroyedIn.join(', ') || '—'}`));
          out(paint(r.differentRepo ? 'red' : 'grey', `      ${r.why}`));
        }
      }
      out(`\n  ${paint('bold', 'SESSIONS')}`);
      for (const s of f.sessions.slice(0, 20)) {
        out(`    ${paint('bold', s.agent)}${s.agentVersion ? paint('grey', ` ${s.agentVersion}`) : ''} ${paint('grey', String(s.session).slice(0, 16))}  ${s.repoCount} repo(s)`);
        out(paint('grey', `      ${s.events} events · ${s.blocked} refused · ${s.couldNotVerify} unverified · ${s.destroyed} removed  [${s.repos.map((p) => p.name).slice(0, 6).join(', ')}]`));
      }
      if (f.failures.length) {
        out(`\n  ${paint('red', 'COULD NOT READ')} ${paint('grey', '(not clean — unknown)')}`);
        for (const x of f.failures) out(`    ${x.repo}  ${paint('grey', x.error)}`);
      }
      out(`\n  ${paint('grey', f.note)}\n`);
      return;
    }
    const f = await forensics(opts.cwd, {
      ...opts, id: opts._[1] ?? null, since: opts.since ?? null, agent: opts.agent ?? null,
    });
    if (opts.json) return emitJson(f);
    out(renderForensics(f, paint));
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
      if (opts.collapse) {
        return opts.json ? emitJson({ supersededBy: report.plan.supersededBy ?? report.plan.collapse })
          : out(renderCollapse(report.plan));
      }
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

  // A PreToolUse INVOCATION MUST NEVER LEAVE THROUGH A CLI ERROR HANDLER.
  //
  // This handler exits 1, which is correct for a CLI and catastrophic for a hook: the host reads
  // 1 as a non-blocking error and runs the tool call. Everything reachable from `holt hook
  // pre-tool-use` therefore routes to the same scoped decision the in-band path uses, so a crash
  // ANYWHERE — reading stdin, loading config, resolving the repo, importing a module — produces a
  // verdict rather than a silent proceed. `hookVerdictEmitted` keeps this from re-entering when
  // the failure was in the emitter itself.
  if (isPreToolUseInvocation() && !hookVerdictEmitted) {
    const hostArg = process.argv.indexOf('--host');
    const host = hostArg >= 0 ? process.argv[hostArg + 1] : 'generic';
    const verdict = internalErrorVerdict(hookCommandInFlight ?? '', err, {
      failOpen: process.env.HOLT_HOOK_FAIL_OPEN === '1',
    });
    // A repository STATE holt cannot work in is not a destructive command. Saying so is the same
    // scoped answer, reached through the same door — never a blanket refusal of every Bash call
    // in a session that simply has no repository to protect.
    if (EXPECTED_STATE.some((re) => re.test(msg)) && verdict.decision !== 'allow') {
      verdict.reason = `${verdict.reason}\nholt could not read this repository (${msg.replace(/^holt:\s*/, '')}).`;
    }
    emitHookVerdict(verdict, { host }, { command: hookCommandInFlight, cwd: hookCwdInFlight });
  }

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
