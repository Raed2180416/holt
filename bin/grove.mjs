#!/usr/bin/env node
/**
 * grove — CLI.
 *
 * grove never writes to the repository it inspects. See src/git.mjs for the enforced
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

const USAGE = `
grove — the landing layer for parallel agent work

USAGE
  grove [command] [options]

COMMANDS
  status              what your workstreams produced and what to do about it  (default)
  risk                unique work and what is provably safe to delete          (P0, P6)
  collisions          workstream pairs that will fight                         (P1)
  duplicates          pairs that built the same thing  [--deep]                (P3)
  context <id>        what an agent in <id> needs to know about its siblings   (P2)
  plan                drop / collapse / land-in-this-order                     (P5)
  impact              who DEPENDS on what another workstream changed  (not a conflict check)
  graph               the relationship graph  [--html <file>]
  gate <id>           exit non-zero if <id> holds unique work   (pre-delete hook)
  doctor              environment and backend check

AGENT INTEGRATION
  integrate           wire grove into every agent found here (AGENTS.md + MCP + hooks)
  brief               plain-text sibling-workstream briefing for any agent
  mcp                 run as an MCP server over stdio
  hook <event>        hook entry point; reads the host event as JSON on stdin
                      events: pre-tool-use · session-start · user-prompt-submit
                      --host claude-code|generic   --command <cmd>  (bypass stdin)

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
  --global            integrate: ALSO add grove to user-level editor configs.
                      Default is project scope — nothing outside the repo is touched.
  -h, --help          this
`;

function parseArgs(argv) {
  const opts = {
    _: [], json: false, base: null, cwd: process.cwd(), symbols: true,
    strictReadOnly: false, concurrency: 8, includePrimary: false,
    deep: false, html: null, help: false,
    host: 'generic', command: null, bin: 'grove', global: false,
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
    process.stderr.write(paint('red', `grove: not a git repository (searched from ${opts.cwd})\n`));
    process.exit(2);
  }
  const scanned = await scan(disc, opts);
  const report = await analyze(scanned, opts);
  return { report, scanned };
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

  out(paint('bold', 'grove doctor'));
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
    const text = await buildBrief(cwd);
    const eventName = event === 'session-start' ? 'SessionStart' : 'UserPromptSubmit';
    out(JSON.stringify(formatContext(text, { host: opts.host, eventName })));
    return;
  }

  process.stderr.write(paint('red', `grove hook: unknown event '${event}'\n`));
  process.exit(2);
}

async function cmdBrief(opts) {
  const text = await buildBrief(opts.cwd);
  if (opts.json) return emitJson({ context: text });
  out(text ?? '[grove] no parallel workstream findings.');
}

async function cmdIntegrate(opts) {
  const disc = await discover(opts.cwd, opts);
  if (!disc.root) {
    process.stderr.write(paint('red', `grove: not a git repository (${opts.cwd})\n`));
    process.exit(2);
  }

  const scope = opts.global ? 'all' : 'project';
  const { detected, results } = await integrate(disc.root, { bin: opts.bin, scope });
  if (opts.json) return emitJson({ detected, scope, results });

  out(paint('bold', 'grove integrate') + paint('grey', `  (${scope} scope)`));
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
    out(paint('grey', '  add grove to your user-level editor configs (existing files only, never created).'));
  }
  out('');
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(paint('red', `grove: ${e.message}\n`));
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
        process.stderr.write(paint('red', 'grove context: needs a workstream id\n'));
        process.exit(2);
      }
      const digest = contextDigest(scanned, id);
      return opts.json ? emitJson(digest) : out(renderContext(digest));
    }

    case 'gate': {
      // Pre-delete gate. Exit 0 = disposable, 1 = holds unique work, 2 = unknown.
      const id = opts._[1];
      if (!id) {
        process.stderr.write(paint('red', 'grove gate: needs a workstream id\n'));
        process.exit(2);
      }
      const verdict = report.safe.find((s) => s.id === id);
      if (!verdict) {
        process.stderr.write(paint('red', `grove gate: no workstream '${id}'\n`));
        process.exit(2);
      }
      if (opts.json) emitJson(verdict);
      else if (verdict.confidence === 'unknown') {
        out(paint('yellow', `? ${id}: UNKNOWN — grove could not scan it. Refusing to call it safe.`));
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
      process.stderr.write(paint('red', `grove: unknown command '${cmd}'\n`));
      out(USAGE);
      process.exit(2);
  }
}

main().catch((err) => {
  process.stderr.write(paint('red', `grove: ${err?.stack ?? err?.message ?? String(err)}\n`));
  process.exit(1);
});
