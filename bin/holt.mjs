#!/usr/bin/env node
/**
 * holt — CLI.
 *
 * holt never writes to the repository it inspects. See src/git.mjs for the enforced
 * contract and test/unit/safety.test.mjs for the proof.
 */

import process from 'node:process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { discover } from '../src/discover.mjs';
import { scan } from '../src/scan.mjs';
import { analyze, contextDigest } from '../src/analyze.mjs';
import { deepDuplicates, detectJscpd } from '../src/deep.mjs';
import { detectCtags, detectEnry } from '../src/symbols.mjs';
import { classify } from '../src/git.mjs';
import {
  renderSummary, renderRisk, renderCollisions, renderDuplicates,
  renderPlan, renderContext, renderImpact, paint,
} from '../src/render.mjs';
import { renderHtml } from '../src/graph-html.mjs';
import { assessCommand, buildBrief } from '../src/agent.mjs';
import { impact, detectRipgrep } from '../src/impact.mjs';
import { integrate, detectHosts, formatVerdict, formatContext } from '../src/integrate/adapters.mjs';
import { protect, unprotect, rescue, rescues, clean } from '../src/actions.mjs';
import { verifyPair } from '../src/verify.mjs';
import { runTui } from '../src/tui.mjs';
import { landingOrder } from '../src/order.mjs';
import { branchAudit } from '../src/branches.mjs';
import { partitionPlan } from '../src/partition.mjs';
import { readJournal } from '../src/journal.mjs';
import { git } from '../src/git.mjs';

const USAGE = `
holt — the landing layer for parallel agent work

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
  journal             audit trail of every protect / rescue / clean / branch-delete
  graph               the relationship graph  [--html <file>]
  gate <id>           exit non-zero if <id> holds unique work   (pre-delete hook)
  tui                 interactive risk-sorted dashboard  [--snapshot]
  doctor              environment and backend check

ACTING  (these MUTATE the repo; everything above is read-only)
  protect             git-lock every workstream holding unique work   [--dry-run]
                      a locked worktree REFUSES 'git worktree remove --force'
  unprotect [<id>]    release holt's locks (never touches locks it did not place)
  rescue <id>         capture unique work to a verifiable ref  [--release] [--dry-run]
                      exits non-zero if the capture cannot be verified
  rescued             list every rescue taken in this repo
  clean               remove provably-disposable worktrees + branches  [--apply]
  verify <a> <b>      run YOUR test suite on A alone, B alone, and A+B merged; report
                      only what the COMBINATION breaks  [--run "<cmd>"]  (executes code)

AGENT INTEGRATION
  integrate           wire holt into every agent found here (AGENTS.md + MCP + hooks)
  brief               plain-text sibling-workstream briefing for any agent
  mcp                 run as an MCP server over stdio
  hook <event>        hook entry point; reads the host event as JSON on stdin
                      events: pre-tool-use · session-start · user-prompt-submit
                      --host claude-code|generic   --command <cmd>  (bypass stdin)
                      --autoprotect: session-start also locks at-risk workstreams first
                      (holt integrate wires this — zero-touch protection at every session)

OPTIONS
  --json              machine-readable output
  --base <ref>        compare against <ref>            (default: origin/HEAD, then main/master…)
  --cwd <path>        repository to inspect            (default: cwd)
  --no-symbols        skip symbol extraction (faster, file-level only)
  --strict-read-only  never write objects; committed deltas become APPROXIMATE
  --concurrency <n>   parallel git operations          (default: 8)
  --include-primary   also scan the primary worktree
  --deep              duplicates: additionally run jscpd token clone detection
  --html <file>       graph: write an interactive HTML graph
  --global            integrate: ALSO add holt to user-level editor configs.
                      Default is project scope — nothing outside the repo is touched.
  -h, --help          this
`;

function parseArgs(argv) {
  const opts = {
    _: [], json: false, base: null, cwd: process.cwd(), symbols: true,
    strictReadOnly: false, concurrency: 8, includePrimary: false,
    deep: false, html: null, help: false,
    host: 'generic', command: null, bin: 'holt', global: false,
    dryRun: false, apply: false, release: false,
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
      case '--run': opts.run = argv[++i]; break;
      case '--agents': opts.agents = Number(argv[++i]) || 2; break;
      case '--autoprotect': opts.autoprotect = true; break;
      case '--snapshot': opts.snapshot = true; break;
      case '--columns': opts.columns = Number(argv[++i]) || 120; break;
      case '--rows': opts.rowsOpt = Number(argv[++i]) || 34; break;
      case '-h': case '--help': opts.help = true; break;
      case '--base': opts.base = argv[++i]; break;
      case '--cwd': opts.cwd = argv[++i]; break;
      case '--html': opts.html = argv[++i]; break;
      case '--host': opts.host = argv[++i]; break;
      case '--command': opts.command = argv[++i]; break;
      case '--bin': opts.bin = argv[++i]; break;
      case '--concurrency': opts.concurrency = Number(argv[++i]) || 8; break;
      default:
        if (a.startsWith('--')) throw new Error(`unknown option: ${a}`);
        opts._.push(a);
    }
  }
  return opts;
}

function out(s) { process.stdout.write(s.endsWith('\n') ? s : `${s}\n`); }
function emitJson(v) { out(JSON.stringify(v, null, 2)); }

/**
 * One scan per invocation. Commands that need the raw scan (context, deep duplicates) get it
 * from here rather than re-running git — a second scan would also risk disagreeing with the
 * first if a worktree changed underneath us mid-command.
 */
async function buildReport(opts) {
  const disc = await discover(opts.cwd, opts);
  if (!disc.root) {
    process.stderr.write(paint('red', `holt: not a git repository (searched from ${opts.cwd})\n`));
    process.exit(2);
  }
  const scanned = await scan(disc, opts);
  const report = await analyze(scanned, opts);
  return { report, scanned };
}

/**
 * Render an action result. Always JSON: these are the outputs a script or an agent chains on,
 * and a prose summary of a destructive operation is harder to act on than the facts.
 */
function cmdAction(result) {
  emitJson(result);
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
  out(`  repository        ${info.repo ?? paint('red', 'not a git repository')}`);
  out(`  workstreams       ${info.workstreams}`);
  out(`  jj backend        ${info.jj}`);
  out(`  symbol backend    ${ctags.available ? paint('green', info.symbolBackend) : paint('yellow', info.symbolBackend)}`);
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
  if (missing.length) {
    const pkgs = {
      ctags: { pacman: 'ctags', apt: 'universal-ctags', dnf: 'ctags', brew: 'universal-ctags', winget: 'UniversalCtags.Ctags' },
      enry: { pacman: null, apt: null, dnf: null, brew: 'enry', winget: null }, // most distros: go install
    };
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
  }
}

/** Read a host's hook event from stdin. Absent/!TTY stdin is normal — not an error. */
function readStdin(timeoutMs = 4000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    const done = (v) => { clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => done(data), timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
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
    const command = opts.command ?? payload.tool_input?.command ?? payload.toolInput?.command;

    // Only shell-ish tools can destroy a worktree. Anything else is allowed without a scan,
    // which keeps the hook off the critical path for the overwhelming majority of tool calls.
    const shellish = !toolName || /^(Bash|Shell|Terminal|run_command|execute)$/i.test(toolName);
    if (!shellish || !command) {
      out(JSON.stringify(formatVerdict({ decision: 'allow', reason: null }, { host: opts.host })));
      return;
    }

    const verdict = await assessCommand(command, cwd);
    out(JSON.stringify(formatVerdict(verdict, { host: opts.host, eventName: 'PreToolUse' })));
    process.exit(verdict.decision === 'deny' ? 1 : verdict.decision === 'ask' ? 2 : 0);
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
    const text = protectLine + await buildBrief(cwd);
    const eventName = event === 'session-start' ? 'SessionStart' : 'UserPromptSubmit';
    out(JSON.stringify(formatContext(text, { host: opts.host, eventName })));
    return;
  }

  process.stderr.write(paint('red', `holt hook: unknown event '${event}'\n`));
  process.exit(2);
}

async function cmdBrief(opts) {
  const text = await buildBrief(opts.cwd);
  if (opts.json) return emitJson({ context: text });
  out(text ?? '[holt] no parallel workstream findings.');
}

async function cmdIntegrate(opts) {
  const disc = await discover(opts.cwd, opts);
  if (!disc.root) {
    process.stderr.write(paint('red', `holt: not a git repository (${opts.cwd})\n`));
    process.exit(2);
  }

  const scope = opts.global ? 'all' : 'project';
  const { detected, results } = await integrate(disc.root, { bin: opts.bin, scope });
  if (opts.json) return emitJson({ detected, scope, results });

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

  if (cmd === 'mcp') {
    const { runStdioServer } = await import('../src/mcp/server.mjs');
    await runStdioServer(opts);
    return;
  }
  if (cmd === 'doctor') return cmdDoctor(opts);
  if (cmd === 'hook') return cmdHook(opts);
  if (cmd === 'tui') return runTui(opts.cwd, { snapshot: opts.snapshot, columns: opts.columns, rows: opts.rowsOpt });

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
    const ls = await git(['ls-files'], { cwd: scanned.root });
    const plan = partitionPlan(report, ls.stdout.split('\n').filter(Boolean), { agents: opts.agents ?? 2 });
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
  if (cmd === 'journal') {
    const events = await readJournal(opts.cwd);
    if (opts.json) return emitJson({ events });
    if (!events.length) { out(paint('grey', 'holt journal: no recorded actions in this repository yet')); return; }
    out(paint('bold', `holt journal — ${events.length} recorded action(s)`));
    for (const e of events) {
      if (e.corrupt) { out(`  ${paint('red', 'corrupt line:')} ${e.corrupt.slice(0, 80)}`); continue; }
      const what = [e.id ?? e.name, e.ref, e.evidence ?? e.reason].filter(Boolean).join('  ');
      out(`  ${paint('grey', e.at)}  ${paint('bold', e.action)}  ${what}`);
    }
    return;
  }
  if (cmd === 'protect') return void cmdAction(await protect(opts.cwd, opts));
  if (cmd === 'unprotect') return void cmdAction(await unprotect(opts.cwd, { id: opts._[1] ?? null, ...opts }));
  if (cmd === 'rescued') return void cmdAction(await rescues(opts.cwd));
  if (cmd === 'clean') return void cmdAction(await clean(opts.cwd, opts));
  if (cmd === 'verify') {
    const [, a, b] = opts._;
    if (!a || !b) {
      process.stderr.write(paint('red', 'holt verify: needs two workstream ids\n'));
      process.exit(2);
    }
    const r = await verifyPair(opts.cwd, a, b, { run: opts.run ?? null });
    cmdAction(r);
    if (r.ok === false) process.exit(2);
    if (r.interactionFailures?.length) process.exit(1);
    return;
  }
  if (cmd === 'rescue') {
    const target = opts._[1];
    if (!target) {
      process.stderr.write(paint('red', 'holt rescue: needs a workstream id\n'));
      process.exit(2);
    }
    const r = await rescue(opts.cwd, target, opts);
    cmdAction(r);
    // An unverified capture MUST exit non-zero: a script chaining
    //   holt rescue X && git worktree remove X
    // has to stop here, or that chain destroys the work it was meant to save.
    if (r.ok === false) process.exit(1);
    return;
  }
  if (cmd === 'brief') return cmdBrief(opts);
  if (cmd === 'integrate') return cmdIntegrate(opts);

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
      return emitJson(report.graph);
    }

    case 'context': {
      const id = opts._[1];
      if (!id) {
        process.stderr.write(paint('red', 'holt context: needs a workstream id\n'));
        process.exit(2);
      }
      const digest = contextDigest(scanned, id);
      return opts.json ? emitJson(digest) : out(renderContext(digest));
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
      if (opts.json) emitJson(verdict);
      else if (verdict.confidence === 'unknown') {
        out(paint('yellow', `? ${id}: UNKNOWN — holt could not scan it. Refusing to call it safe.`));
        for (const r of verdict.reasons) out(paint('grey', `    ${r}`));
      } else if (verdict.safe) {
        out(paint('green', `✓ ${id}: disposable — ${verdict.reasons[0]}`));
      } else {
        out(paint('red', `✗ ${id}: HOLDS UNIQUE WORK`));
        for (const r of verdict.reasons) out(paint('grey', `    ${r}`));
      }
      process.exit(verdict.confidence === 'unknown' ? 2 : verdict.safe ? 0 : 1);
      return;
    }

    default:
      process.stderr.write(paint('red', `holt: unknown command '${cmd}'\n`));
      out(USAGE);
      process.exit(2);
  }
}

main().catch((err) => {
  process.stderr.write(paint('red', `holt: ${err?.stack ?? err?.message ?? String(err)}\n`));
  process.exit(1);
});
