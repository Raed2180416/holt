/**
 * holt — integration adapters.
 *
 * One neutral core (src/agent.mjs) produces verdicts; these adapters translate them into each
 * host's schema. Adding a host means adding an entry here, never touching the analysis.
 *
 * COVERAGE, and why each is here:
 *
 *   agents-md   UNIVERSAL AWARENESS. AGENTS.md is the Linux Foundation AAIF cross-tool standard,
 *               read natively by 30+ agents (Codex, Cursor, Copilot, Gemini CLI, Aider, Zed,
 *               Windsurf, Jules, Factory, Devin, VS Code…). This is the widest-reach surface
 *               that exists and it costs one markdown block.
 *   mcp         UNIVERSAL TOOLS. Any MCP-speaking host. Writes the server entry into whichever
 *               config files are present, so one command wires Cursor, Windsurf, Codex, Claude
 *               Code, Continue, Zed and others at once.
 *   claude-code DETERMINISTIC ENFORCEMENT via settings.json hooks (PreToolUse can deny).
 *   opencode    DETERMINISTIC ENFORCEMENT via its JS plugin API.
 *   git-hooks   AGENT-INDEPENDENT ENFORCEMENT. Works even for an agent with no plugin system at
 *               all, and for humans. This is the floor: if every other integration is missing,
 *               the repository still protects itself.
 *   generic     A documented stdin-JSON/stdout-JSON protocol plus exit codes, for any host not
 *               listed above. Nothing here requires holt to know the host in advance.
 *
 * ORDER MATTERS: awareness (AGENTS.md) and tools (MCP) work everywhere and are safe to install
 * unconditionally. Hooks are installed only for hosts actually detected in the repo/home, so we
 * never write config for a tool the user does not use.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { HOSTS, getHost, strengthLabel, CLOUD_CAVEAT } from './hosts.mjs';

const HOLT_BEGIN = '<!-- BEGIN holt -->';
const HOLT_END = '<!-- END holt -->';

/* ------------------------------------------------------- AGENTS.md (universal) ---- */

export function agentsMdBlock(bin = 'holt') {
  return `${HOLT_BEGIN}
## Parallel workstreams (holt)

This repository uses multiple git worktrees / jj workspaces at once. Work can exist in a
worktree that is invisible to ordinary git commands — \`git diff\` and \`merge-tree\` cannot
relate UNCOMMITTED changes across worktrees, so a worktree can hold the only copy of something.

### If you were asked to clean up worktrees, this is the whole task

\`\`\`bash
${bin} clean            # shows exactly what holds nothing base lacks — changes nothing
${bin} clean --apply    # removes those worktrees and their merged branches
\`\`\`

That is the safe, complete action. \`clean\` re-verifies each worktree immediately before removing
it, never touches one that holds work found nowhere else, and never touches one it could not
assess. **You do not need to decide which worktrees are disposable — that is what this computes.**

Do not hand-inspect worktrees and reason about them yourself. Measured across real trials, that
approach deleted a worktree holding the only copy of a security fix and kept two empty ones, in
the same run.

**Worktree names are not evidence.** Measured in real trials: agents deleted a worktree holding
the only copy of a security fix because it was called \`DELETEME-old-experiment\`, and kept two
empty ones because they were called \`IMPORTANT-do-not-delete\` and \`KEEP-release-candidate\` —
in both cases *after* holt had reported the opposite. Names, commit counts, file counts and
mtimes are all routinely anti-correlated with what a worktree actually holds. Use the content
verdict, not the label.

**Before deleting, pruning, or \`rm\`-ing any worktree, run this ONE COMMAND PER WORKTREE:**

\`\`\`bash
${bin} gate <worktree-id>
\`\`\`

Exit code \`0\` = disposable · \`1\` = holds work found nowhere else · \`2\` = could not verify
(treat as unsafe). Never delete on exit 1 or 2.

**The exit code is the verdict. Do not summarise, paraphrase or re-derive it.** Measured in a
real trial: an agent ran holt, then reported *"Holt verdict: all 16 are marked as safe to
delete"* when holt had marked seven as holding work found nowhere else — including one whose
uncommitted file the agent had itself just listed. Reading the prose output and summarising it is
how that happens. Run \`gate\` per worktree and branch on \`$?\`; it cannot be misread.

If a worktree is locked, that is holt protecting it. **Do not run \`git worktree unlock\` or
\`remove -f -f\` to get past it** — run \`${bin} rescue <id> --release\`, which preserves the work
to a verifiable ref first and then releases the lock.

**Before starting work, check what your siblings are doing:**

\`\`\`bash
${bin} context <worktree-id>     # who else is editing your files, what already exists
${bin} status                    # collisions, duplicates, what is at risk
\`\`\`

If a symbol you are about to write already exists in another workstream, reuse or coordinate —
do not build it twice. Add \`--json\` to any command for machine-readable output.
${HOLT_END}`;
}

/**
 * Remove every holt-delimited block from a document, leaving the user's own content untouched.
 * Global and tolerant: handles zero, one, or several blocks, and trims the blank lines a removal
 * leaves behind so re-running integrate never grows the file.
 */
export function stripHoltBlock(text) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\n*${esc(HOLT_BEGIN)}[\\s\\S]*?${esc(HOLT_END)}\\n*`, 'g');
  return text.replace(re, '\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Insert/refresh holt's block in AGENTS.md WITHOUT ever destroying the user's existing content.
 *
 * A repo very often already has an AGENTS.md (it is the cross-tool standard). So: strip any prior
 * holt block, keep everything else exactly, and append one fresh holt block at the end. Running
 * integrate any number of times converges to the same file — the user's rules first, holt's block
 * last, no duplication, no growth.
 */
export async function installAgentsMd(repoRoot, { bin = 'holt', filename = 'AGENTS.md' } = {}) {
  const file = path.join(repoRoot, filename);
  let existing = '';
  let created = true;
  try {
    existing = await fs.readFile(file, 'utf8');
    created = false;
  } catch { /* new file */ }

  const userContent = stripHoltBlock(existing).replace(/\s+$/, '');
  const block = agentsMdBlock(bin);
  const header = (created && !userContent)
    ? '# AGENTS.md\n\nInstructions for AI coding agents working in this repository.\n\n'
    : '';
  const next = userContent
    ? `${header}${userContent}\n\n${block}\n`
    : `${header}${block}\n`;

  await fs.writeFile(file, next, 'utf8');
  const hadBlock = existing.includes(HOLT_BEGIN);
  return {
    adapter: 'agents-md', path: file, created,
    action: created ? 'created' : hadBlock ? 'refreshed holt block' : 'appended holt block (kept your content)',
    preservedUserContent: !created && !!userContent,
  };
}

/* --------------------------------------------------------------- MCP (universal) ---- */

/**
 * MCP config locations, by host. Each entry says where the file lives and which key holds the
 * server map, because the ecosystem did not converge on one shape.
 */
/**
 * MCP config locations, by host and SCOPE.
 *
 * Scope matters and the default is project-only. An earlier revision wrote to every user-global
 * config it could find — ~/.cursor/mcp.json, ~/.codeium/…, ~/.config/zed/… — the first time it
 * ran. Editing a developer's home configuration for every editor they have installed, because
 * they asked to wire up ONE repository, is not acceptable behaviour for an install command. It
 * is also usually wrong: the entry points at a `holt` binary that may only exist for this
 * project.
 *
 * `--global` opts into user scope explicitly.
 */
export function mcpTargets(repoRoot, home = os.homedir(), { scope = 'project' } = {}) {
  const project = [
    { host: 'claude-code', scope: 'project', file: path.join(repoRoot, '.mcp.json'), key: 'mcpServers' },
    { host: 'cursor', scope: 'project', file: path.join(repoRoot, '.cursor', 'mcp.json'), key: 'mcpServers' },
    { host: 'vscode / copilot', scope: 'project', file: path.join(repoRoot, '.vscode', 'mcp.json'), key: 'servers' },
    { host: 'gemini-cli', scope: 'project', file: path.join(repoRoot, '.gemini', 'settings.json'), key: 'mcpServers' },
    // OpenCode uses a DIFFERENT key AND a different entry shape. Verified against a live
    // `opencode debug config`: mcp: { name: { type: "local", command: [bin, ...args] } }.
    // Writing the mcpServers shape here would produce a config opencode silently ignores.
    { host: 'opencode', scope: 'project', file: path.join(repoRoot, 'opencode.json'), key: 'mcp', shape: 'opencode' },
    // Crush uses yet a third shape: mcp:{name:{type:"stdio",command,args}}. Verified against a
    // live ~/.config/crush/crush.json.
    { host: 'crush', scope: 'project', file: path.join(repoRoot, 'crush.json'), key: 'mcp', shape: 'crush' },
  ];
  const user = [
    { host: 'cursor', scope: 'user', file: path.join(home, '.cursor', 'mcp.json'), key: 'mcpServers' },
    { host: 'devin-desktop', scope: 'user', file: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'), key: 'mcpServers' },
    { host: 'gemini-cli', scope: 'user', file: path.join(home, '.gemini', 'settings.json'), key: 'mcpServers' },
    { host: 'zed', scope: 'user', file: path.join(home, '.config', 'zed', 'settings.json'), key: 'context_servers' },
    { host: 'continue', scope: 'user', file: path.join(home, '.continue', 'config.json'), key: 'mcpServers' },
    { host: 'opencode', scope: 'user', file: path.join(home, '.config', 'opencode', 'opencode.json'), key: 'mcp', shape: 'opencode' },
  ];
  return scope === 'user' ? user : scope === 'all' ? [...project, ...user] : project;
}

/**
 * The server entry, in whichever shape the host expects.
 *
 * `bin` may carry arguments ("node /path/holt.mjs", "npx holt"), so it is split rather than
 * passed whole — the same defect that made the OpenCode plugin gate fail open.
 */
export function mcpServerEntry(bin = 'holt', shape = 'standard') {
  const [cmd, ...prefix] = String(bin).trim().split(/\s+/);
  if (shape === 'opencode') {
    return { type: 'local', command: [cmd, ...prefix, 'mcp'], enabled: true };
  }
  if (shape === 'crush') {
    return { type: 'stdio', command: cmd, args: [...prefix, 'mcp'] };
  }
  return { command: cmd, args: [...prefix, 'mcp'], env: {} };
}

/**
 * Write the holt MCP server into a host config.
 * `onlyExisting` (default) touches only files that already exist, so holt never fabricates
 * config for tools the user does not have installed.
 */
export async function installMcp(repoRoot, {
  bin = 'holt', home = os.homedir(), scope = 'project', hosts = null,
} = {}) {
  const results = [];
  for (const t of mcpTargets(repoRoot, home, { scope })) {
    // Only wire hosts the user actually has, when we know which those are.
    if (hosts && !hosts.some((h) => t.host.startsWith(h.replace('-cli', '')) || h.startsWith(t.host))) {
      results.push({ adapter: 'mcp', host: t.host, scope: t.scope, path: t.file, action: 'skipped (host not detected)' });
      continue;
    }

    let cfg = {};
    let exists = true;
    try {
      cfg = JSON.parse(await fs.readFile(t.file, 'utf8'));
    } catch {
      exists = false;
      // Project scope: creating the file is the point — it is how you wire a repo.
      // User scope: never create. Adding holt to a config the user does not have is
      // indistinguishable from installing software they did not ask for.
      if (t.scope === 'user') {
        results.push({ adapter: 'mcp', host: t.host, scope: t.scope, path: t.file, action: 'skipped (no user config)' });
        continue;
      }
    }

    cfg[t.key] ??= {};
    const already = !!cfg[t.key].holt;
    cfg[t.key].holt = mcpServerEntry(bin, t.shape);

    await fs.mkdir(path.dirname(t.file), { recursive: true });
    await fs.writeFile(t.file, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
    results.push({
      adapter: 'mcp', host: t.host, scope: t.scope, path: t.file,
      action: !exists ? 'created' : already ? 'updated' : 'added',
    });
  }
  return results;
}

/* ------------------------------------------------------------------ Claude Code ---- */

export function claudeCodeHooks(bin = 'holt') {
  return {
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: `${bin} hook pre-tool-use --host claude-code`, timeout: 120 }] },
    ],
    SessionStart: [
      { hooks: [{ type: 'command', command: `${bin} hook session-start --autoprotect --host claude-code`, timeout: 120 }] },
    ],
    UserPromptSubmit: [
      { hooks: [{ type: 'command', command: `${bin} hook user-prompt-submit --host claude-code`, timeout: 60 }] },
    ],
  };
}

export async function installClaudeCode(repoRoot, { bin = 'holt' } = {}) {
  const file = path.join(repoRoot, '.claude', 'settings.json');
  let cfg = {};
  let created = true;
  try { cfg = JSON.parse(await fs.readFile(file, 'utf8')); created = false; } catch { /* new */ }

  cfg.hooks ??= {};
  const wanted = claudeCodeHooks(bin);
  let added = 0;
  for (const [event, entries] of Object.entries(wanted)) {
    cfg.hooks[event] ??= [];
    const already = cfg.hooks[event].some((e) => JSON.stringify(e).includes(`${bin} hook`));
    if (already) continue;
    cfg.hooks[event].push(...entries);
    added++;
  }

  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  return { adapter: 'claude-code', path: file, created, added, action: added ? 'installed' : 'already present' };
}

/* --------------------------------------------------------------------- OpenCode ---- */

/**
 * OpenCode plugin.
 *
 * Written against the real API (verified against opencode 1.18.x, not a summary):
 *   - plugins live in `.opencode/plugins/` (PLURAL) or `~/.config/opencode/plugins/`
 *   - a plugin exports an async fn receiving `{ project, client, $, directory, worktree }`
 *     and returning a hooks object
 *   - `"tool.execute.before": async (input, output)` — `input.tool` names the tool,
 *     `output.args` holds its arguments
 *   - a tool call is DENIED by THROWING. There is no permissionDecision object here, which is
 *     exactly why the neutral core returns verdicts and adapters translate them.
 *   - `input` ALSO carries `sessionID` and `callID`. Verified in the shipping opencode binary:
 *     the runtime fires `trigger("tool.execute.before", {tool, sessionID, callID}, {args})`.
 *     Earlier revisions of this plugin destructured only `input.tool` and discarded both, so
 *     every OpenCode action holt journalled was anonymous while the host had been handing it a
 *     session id the whole time. They are now forwarded to the CLI.
 *       re-derive:  strings "$(command -v opencode)" | grep -o 'tool.execute.before.\{0,90\}'
 */
export function opencodePlugin(bin = 'holt') {
  return `// holt — OpenCode plugin (generated by \`holt integrate\`).
//
// Blocks worktree destruction that would lose work existing nowhere else, and injects
// sibling-workstream context at session start. Every decision is delegated to the holt CLI,
// so the logic lives in one place and this file never goes stale.
import { execFile } from "node:child_process"

// The configured binary may carry arguments (e.g. "node /path/to/holt.mjs" during development,
// or "npx holt"). execFile takes the executable and an argv array separately, so passing the
// whole string as the executable finds nothing — and the gate then FAILS OPEN, silently, on every
// command. Caught by test/e2e/opencode-plugin.test.mjs, which is the only reason it is not still
// shipping: the plugin loaded, the hooks fired, and it blocked nothing.
const [HOLT_CMD, ...HOLT_PREFIX] = ${JSON.stringify(bin)}.trim().split(/\\s+/)

let warned = false

const run = (args, cwd) =>
  new Promise((resolve) => {
    execFile(HOLT_CMD, [...HOLT_PREFIX, ...args], { cwd, timeout: 120000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout ?? ""), err }),
    )
  })

// OpenCode's shell tool has been named "bash" and "shell" across versions; accept either, and
// fall back to sniffing the args rather than silently doing nothing on an unknown name.
const commandOf = (input, output) => {
  const a = output?.args ?? {}
  if (typeof a.command === "string") return a.command
  if (typeof a.cmd === "string") return a.cmd
  if (Array.isArray(a.command)) return a.command.join(" ")
  return null
}

export const holt = async ({ directory, worktree }) => {
  const cwd = worktree || directory || process.cwd()
  return {
    "tool.execute.before": async (input, output) => {
      const command = commandOf(input, output)
      if (!command) return

      // Forward the identity opencode already handed us. Only when it is a non-empty string:
      // passing "" would make holt record an empty session, which reads as identity in a
      // timeline and is not one. Absent stays absent, and holt records 'unknown'.
      const ident = []
      if (typeof input?.sessionID === "string" && input.sessionID.trim()) ident.push("--session", input.sessionID.trim())
      if (typeof input?.callID === "string" && input.callID.trim()) ident.push("--invocation", input.callID.trim())

      const res = await run(["hook", "pre-tool-use", "--host", "opencode", "--command", command, "--cwd", cwd, ...ident], cwd)

      let verdict
      try {
        verdict = JSON.parse(res.stdout)
      } catch {
        // holt could not run, or produced something unparseable. Do NOT block — a safety tool
        // that bricks the agent when it breaks is worse than one that is absent. But SAY SO,
        // once: a gate that fails open in silence is indistinguishable from no gate at all,
        // and the user believes they are protected when they are not.
        if (!warned) {
          warned = true
          console.warn(
            "[holt] gate INACTIVE — could not run '" + HOLT_CMD + "'" +
              (res.err ? " (" + res.err.message + ")" : "") +
              ". Worktree deletions are NOT being checked. Fix with: holt doctor",
          )
        }
        return
      }

      if (verdict.decision === "deny") {
        throw new Error(verdict.reason || "holt: this command would destroy work found nowhere else")
      }
      if (verdict.decision === "ask") {
        // OpenCode has no "ask" channel here; surface it without blocking legitimate work.
        console.warn("[holt] " + (verdict.reason || "could not verify this command"))
      }
    },

    event: async ({ event }) => {
      if (event?.type !== "session.created") return
      const res = await run(["brief"], cwd)
      const text = res.stdout.trim()
      if (text && !text.startsWith("[holt] no parallel")) console.log(text)
    },
  }
}
`;
}

export async function installOpenCode(repoRoot, { bin = 'holt' } = {}) {
  // `.opencode/plugins/` — plural. The singular form is silently ignored by opencode, which is
  // the worst kind of wrong: the file exists, looks installed, and never runs.
  const file = path.join(repoRoot, '.opencode', 'plugins', 'holt.js');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, opencodePlugin(bin), 'utf8');
  return { adapter: 'opencode', path: file, action: 'installed' };
}

/* ------------------------------------------------------- git hooks (agent-free) ---- */

/**
 * The floor. Works with no agent at all, and for humans.
 *
 * git has NO hook for `worktree remove`, so this cannot block deletion directly. What it can do
 * is refuse to let a branch whose worktree holds unique uncommitted work be quietly discarded,
 * and warn loudly on checkout. Honest about its own limits rather than implying full coverage.
 */
export function preCommitHook(bin = 'holt') {
  return `#!/bin/sh
# holt — pre-commit warning (generated by \`holt integrate\`).
# Surfaces cross-worktree collisions before you add to them. Never blocks: exit 0 always.
if command -v ${bin} >/dev/null 2>&1; then
  ${bin} collisions --json 2>/dev/null | grep -q '"severity": *"high"' && {
    echo "holt: HIGH-severity collisions exist between worktrees. Run '${bin} collisions'." >&2
  }
fi
exit 0
`;
}

export async function installGitHooks(repoRoot, { bin = 'holt' } = {}) {
  const dir = path.join(repoRoot, '.git', 'hooks');
  const file = path.join(dir, 'pre-commit');
  try {
    const existing = await fs.readFile(file, 'utf8');
    if (!existing.includes('holt —')) {
      return { adapter: 'git-hooks', path: file, action: 'skipped (a pre-commit hook already exists)' };
    }
  } catch { /* none yet */ }

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, preCommitHook(bin), { mode: 0o755 });
  return { adapter: 'git-hooks', path: file, action: 'installed' };
}

/* ---------------------------------------------------------------- host detection ---- */

/**
 * Which hosts are in use, and WHERE.
 *
 * Scope is reported separately because it changes what holt is allowed to do. A host found only
 * in the user's home directory means "this person uses Cursor", not "this repository is wired
 * for Cursor" — and it is not a licence to edit their home config.
 *
 * @returns {Promise<{all: string[], project: string[], user: string[]}>}
 */
export async function detectHosts(repoRoot, home = os.homedir()) {
  // Detection markers come from the single host manifest (src/integrate/hosts.mjs), each UNIQUE
  // to its host. AGENTS.md is deliberately NOT a marker for any host: it is the cross-tool
  // standard many agents read, so its presence says nothing about which host is installed —
  // treating it as a codex marker made every repo with an AGENTS.md report "codex present".
  const probes = HOSTS.map((h) => ({ host: h.id, project: h.detect.project, user: h.detect.user }));

  const hit = async (base, rels) => {
    for (const rel of rels) {
      try { await fs.stat(path.join(base, rel)); return true; } catch { /* absent */ }
    }
    return false;
  };

  const project = [];
  const user = [];
  for (const p of probes) {
    if (await hit(repoRoot, p.project)) project.push(p.host);
    if (await hit(home, p.user)) user.push(p.host);
  }
  return { all: [...new Set([...project, ...user])], project, user };
}

/**
 * The transparent coverage matrix: every host holt knows, its detection state here, and — the
 * honest part — the actual integration strength it gets. `holt hosts` prints this so a user is
 * never told "works everywhere" when the truth is "blocks on two, advises on the rest".
 */
export async function hostsReport(repoRoot, home = os.homedir()) {
  const detected = await detectHosts(repoRoot, home);
  const present = new Set(detected.all);
  const rows = HOSTS.map((h) => ({
    id: h.id, name: h.name, env: h.env,
    strength: h.strength, blockCapable: !!h.blockCapable,
    label: strengthLabel(h),
    detectedHere: present.has(h.id),
    rulesFile: h.rulesFile, mcp: !!h.mcp, note: h.note,
  }));
  return {
    detectedHere: [...present].map((id) => getHost(id)?.name ?? id),
    counts: {
      known: HOSTS.length,
      blocking: HOSTS.filter((h) => h.strength === 'block').length,
      blockCapablePlanned: HOSTS.filter((h) => h.blockCapable).length,
      cloudAdvisoryOnly: HOSTS.filter((h) => h.env === 'cloud').length,
    },
    cloudCaveat: CLOUD_CAVEAT,
    hosts: rows,
  };
}

/**
 * Install everything applicable.
 *
 * AGENTS.md and MCP go in unconditionally (widest reach, zero risk). Host-specific hooks go in
 * only where that host is detected.
 */
/**
 * Install everything applicable, PROJECT-SCOPED by default.
 *
 * AGENTS.md and project MCP config go in unconditionally: they live in the repository, they are
 * what the user asked to wire, and they are trivially reversible with git. Host hooks go in only
 * where that host is present. User-global config is touched ONLY with scope:'user'|'all', and
 * even then never created from nothing.
 */
/**
 * Resolve the command every integration should reference.
 *
 * MEASURED: with integrations written as `node /Users/dev/projects/holt/bin/holt.mjs`, agents read
 * AGENTS.md, chose the correct action, and were then STOPPED by the host's permission classifier
 * — "the permission classifier is blocking the execution". An absolute path to a script under a
 * developer's home directory is exactly the shape a Bash allowlist refuses, and the agent froze
 * holding the right answer.
 *
 * A plain `holt` on PATH is both what a real installation looks like and what a classifier will
 * accept. So: prefer the installed binary, and only fall back to an explicit path when there
 * genuinely is no installation — saying so, because the fallback is the shape that gets blocked.
 */
export async function resolveBin(preferred = null) {
  if (preferred && preferred !== 'holt') return { bin: preferred, how: 'explicit' };

  const found = await new Promise((resolve) => {
    execFile('holt', ['--help'], { timeout: 8000 }, (err) => resolve(!err));
  });

  return found
    ? { bin: 'holt', how: 'installed on PATH' }
    : {
        bin: 'holt',
        how: 'NOT FOUND on PATH — integrations reference `holt`; install it with '
          + '`npm install -g holt` or agents will be unable to run it',
        missing: true,
      };
}

export async function integrate(repoRoot, {
  bin = 'holt', home = os.homedir(), hosts = null, scope = 'project',
} = {}) {
  const detected = hosts ?? await detectHosts(repoRoot, home);
  const present = detected.all ?? detected;
  const results = [];

  // Every integration references the SAME command, and it must be one a host will actually run.
  const resolved = await resolveBin(bin);
  bin = resolved.bin;

  results.push(await installAgentsMd(repoRoot, { bin }));
  results.push(...await installMcp(repoRoot, { bin, home, scope, hosts: present }));

  if (present.includes('claude-code')) results.push(await installClaudeCode(repoRoot, { bin }));
  if (present.includes('opencode')) results.push(await installOpenCode(repoRoot, { bin }));
  results.push(await installGitHooks(repoRoot, { bin }));

  return { detected, scope, results, bin: { ...resolved } };
}

/* --------------------------------------------------------- response formatting ---- */

/**
 * Translate a neutral verdict into a host's schema.
 *
 * claude-code: {"hookSpecificOutput": {"hookEventName", "permissionDecision", ...}}
 * generic:     the neutral verdict itself, plus an exit code the caller can branch on.
 */
export function formatVerdict(verdict, { host = 'generic', eventName = 'PreToolUse' } = {}) {
  if (host === 'claude-code') {
    const out = { hookEventName: eventName, permissionDecision: verdict.decision };
    if (verdict.reason) out.permissionDecisionReason = verdict.reason;
    return { hookSpecificOutput: out };
  }
  return verdict;
}

export function formatContext(text, { host = 'generic', eventName = 'SessionStart' } = {}) {
  if (!text) return host === 'claude-code' ? {} : { context: null };
  if (host === 'claude-code') {
    return { hookSpecificOutput: { hookEventName: eventName, additionalContext: text } };
  }
  return { context: text };
}
