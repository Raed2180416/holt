/**
 * grove — integration adapters.
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
 *               listed above. Nothing here requires grove to know the host in advance.
 *
 * ORDER MATTERS: awareness (AGENTS.md) and tools (MCP) work everywhere and are safe to install
 * unconditionally. Hooks are installed only for hosts actually detected in the repo/home, so we
 * never write config for a tool the user does not use.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const GROVE_BEGIN = '<!-- BEGIN grove -->';
const GROVE_END = '<!-- END grove -->';

/* ------------------------------------------------------- AGENTS.md (universal) ---- */

export function agentsMdBlock(bin = 'grove') {
  return `${GROVE_BEGIN}
## Parallel workstreams (grove)

This repository uses multiple git worktrees / jj workspaces at once. Work can exist in a
worktree that is invisible to ordinary git commands — \`git diff\` and \`merge-tree\` cannot
relate UNCOMMITTED changes across worktrees, so a worktree can hold the only copy of something.

**Before deleting, pruning, or \`rm\`-ing any worktree, run:**

\`\`\`bash
${bin} gate <worktree-id>
\`\`\`

Exit code \`0\` = disposable · \`1\` = holds work found nowhere else · \`2\` = could not verify
(treat as unsafe). Never delete on exit 1 or 2.

**Before starting work, check what your siblings are doing:**

\`\`\`bash
${bin} context <worktree-id>     # who else is editing your files, what already exists
${bin} status                    # collisions, duplicates, what is at risk
\`\`\`

If a symbol you are about to write already exists in another workstream, reuse or coordinate —
do not build it twice. Add \`--json\` to any command for machine-readable output.
${GROVE_END}`;
}

/** Idempotently insert/refresh grove's block in AGENTS.md. */
export async function installAgentsMd(repoRoot, { bin = 'grove', filename = 'AGENTS.md' } = {}) {
  const file = path.join(repoRoot, filename);
  let existing = '';
  let created = true;
  try {
    existing = await fs.readFile(file, 'utf8');
    created = false;
  } catch { /* new file */ }

  const block = agentsMdBlock(bin);
  let next;
  if (existing.includes(GROVE_BEGIN) && existing.includes(GROVE_END)) {
    const before = existing.slice(0, existing.indexOf(GROVE_BEGIN));
    const after = existing.slice(existing.indexOf(GROVE_END) + GROVE_END.length);
    next = `${before}${block}${after}`;
  } else {
    const header = created ? '# AGENTS.md\n\nInstructions for AI coding agents working in this repository.\n\n' : '';
    next = `${header}${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${existing ? '\n' : ''}${block}\n`;
  }

  await fs.writeFile(file, next, 'utf8');
  return { adapter: 'agents-md', path: file, created, action: created ? 'created' : 'updated' };
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
 * is also usually wrong: the entry points at a `grove` binary that may only exist for this
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
  ];
  const user = [
    { host: 'cursor', scope: 'user', file: path.join(home, '.cursor', 'mcp.json'), key: 'mcpServers' },
    { host: 'windsurf', scope: 'user', file: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'), key: 'mcpServers' },
    { host: 'gemini-cli', scope: 'user', file: path.join(home, '.gemini', 'settings.json'), key: 'mcpServers' },
    { host: 'zed', scope: 'user', file: path.join(home, '.config', 'zed', 'settings.json'), key: 'context_servers' },
    { host: 'continue', scope: 'user', file: path.join(home, '.continue', 'config.json'), key: 'mcpServers' },
  ];
  return scope === 'user' ? user : scope === 'all' ? [...project, ...user] : project;
}

export function mcpServerEntry(bin = 'grove') {
  return { command: bin, args: ['mcp'], env: {} };
}

/**
 * Write the grove MCP server into a host config.
 * `onlyExisting` (default) touches only files that already exist, so grove never fabricates
 * config for tools the user does not have installed.
 */
export async function installMcp(repoRoot, {
  bin = 'grove', home = os.homedir(), scope = 'project', hosts = null,
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
      // User scope: never create. Adding grove to a config the user does not have is
      // indistinguishable from installing software they did not ask for.
      if (t.scope === 'user') {
        results.push({ adapter: 'mcp', host: t.host, scope: t.scope, path: t.file, action: 'skipped (no user config)' });
        continue;
      }
    }

    cfg[t.key] ??= {};
    const already = !!cfg[t.key].grove;
    cfg[t.key].grove = mcpServerEntry(bin);

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

export function claudeCodeHooks(bin = 'grove') {
  return {
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: `${bin} hook pre-tool-use --host claude-code`, timeout: 120 }] },
    ],
    SessionStart: [
      { hooks: [{ type: 'command', command: `${bin} hook session-start --host claude-code`, timeout: 120 }] },
    ],
    UserPromptSubmit: [
      { hooks: [{ type: 'command', command: `${bin} hook user-prompt-submit --host claude-code`, timeout: 60 }] },
    ],
  };
}

export async function installClaudeCode(repoRoot, { bin = 'grove' } = {}) {
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
 */
export function opencodePlugin(bin = 'grove') {
  return `// grove — OpenCode plugin (generated by \`grove integrate\`).
//
// Blocks worktree destruction that would lose work existing nowhere else, and injects
// sibling-workstream context at session start. Every decision is delegated to the grove CLI,
// so the logic lives in one place and this file never goes stale.
import { execFile } from "node:child_process"

// The configured binary may carry arguments (e.g. "node /path/to/grove.mjs" during development,
// or "npx grovekit"). execFile takes the executable and an argv array separately, so passing the
// whole string as the executable finds nothing — and the gate then FAILS OPEN, silently, on every
// command. Caught by test/e2e/opencode-plugin.test.mjs, which is the only reason it is not still
// shipping: the plugin loaded, the hooks fired, and it blocked nothing.
const [GROVE_CMD, ...GROVE_PREFIX] = ${JSON.stringify(bin)}.trim().split(/\\s+/)

let warned = false

const run = (args, cwd) =>
  new Promise((resolve) => {
    execFile(GROVE_CMD, [...GROVE_PREFIX, ...args], { cwd, timeout: 120000, maxBuffer: 16 * 1024 * 1024 },
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

export const grove = async ({ directory, worktree }) => {
  const cwd = worktree || directory || process.cwd()
  return {
    "tool.execute.before": async (input, output) => {
      const command = commandOf(input, output)
      if (!command) return

      const res = await run(["hook", "pre-tool-use", "--host", "generic", "--command", command, "--cwd", cwd], cwd)

      let verdict
      try {
        verdict = JSON.parse(res.stdout)
      } catch {
        // grove could not run, or produced something unparseable. Do NOT block — a safety tool
        // that bricks the agent when it breaks is worse than one that is absent. But SAY SO,
        // once: a gate that fails open in silence is indistinguishable from no gate at all,
        // and the user believes they are protected when they are not.
        if (!warned) {
          warned = true
          console.warn(
            "[grove] gate INACTIVE — could not run '" + GROVE_CMD + "'" +
              (res.err ? " (" + res.err.message + ")" : "") +
              ". Worktree deletions are NOT being checked. Fix with: grove doctor",
          )
        }
        return
      }

      if (verdict.decision === "deny") {
        throw new Error(verdict.reason || "grove: this command would destroy work found nowhere else")
      }
      if (verdict.decision === "ask") {
        // OpenCode has no "ask" channel here; surface it without blocking legitimate work.
        console.warn("[grove] " + (verdict.reason || "could not verify this command"))
      }
    },

    event: async ({ event }) => {
      if (event?.type !== "session.created") return
      const res = await run(["brief"], cwd)
      const text = res.stdout.trim()
      if (text && !text.startsWith("[grove] no parallel")) console.log(text)
    },
  }
}
`;
}

export async function installOpenCode(repoRoot, { bin = 'grove' } = {}) {
  // `.opencode/plugins/` — plural. The singular form is silently ignored by opencode, which is
  // the worst kind of wrong: the file exists, looks installed, and never runs.
  const file = path.join(repoRoot, '.opencode', 'plugins', 'grove.js');
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
export function preCommitHook(bin = 'grove') {
  return `#!/bin/sh
# grove — pre-commit warning (generated by \`grove integrate\`).
# Surfaces cross-worktree collisions before you add to them. Never blocks: exit 0 always.
if command -v ${bin} >/dev/null 2>&1; then
  ${bin} collisions --json 2>/dev/null | grep -q '"severity": *"high"' && {
    echo "grove: HIGH-severity collisions exist between worktrees. Run '${bin} collisions'." >&2
  }
fi
exit 0
`;
}

export async function installGitHooks(repoRoot, { bin = 'grove' } = {}) {
  const dir = path.join(repoRoot, '.git', 'hooks');
  const file = path.join(dir, 'pre-commit');
  try {
    const existing = await fs.readFile(file, 'utf8');
    if (!existing.includes('grove —')) {
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
 * Scope is reported separately because it changes what grove is allowed to do. A host found only
 * in the user's home directory means "this person uses Cursor", not "this repository is wired
 * for Cursor" — and it is not a licence to edit their home config.
 *
 * @returns {Promise<{all: string[], project: string[], user: string[]}>}
 */
export async function detectHosts(repoRoot, home = os.homedir()) {
  const probes = [
    { host: 'claude-code', project: ['.claude'], user: ['.claude'] },
    { host: 'opencode', project: ['.opencode'], user: ['.config/opencode'] },
    { host: 'cursor', project: ['.cursor'], user: ['.cursor'] },
    { host: 'windsurf', project: [], user: ['.codeium/windsurf'] },
    { host: 'gemini-cli', project: ['.gemini'], user: ['.gemini'] },
    { host: 'codex', project: ['.codex', 'AGENTS.md'], user: ['.codex'] },
    { host: 'zed', project: ['.zed'], user: ['.config/zed'] },
    { host: 'continue', project: [], user: ['.continue'] },
    { host: 'aider', project: ['.aider.conf.yml'], user: ['.aider.conf.yml'] },
    { host: 'vscode', project: ['.vscode'], user: [] },
  ];

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
export async function integrate(repoRoot, {
  bin = 'grove', home = os.homedir(), hosts = null, scope = 'project',
} = {}) {
  const detected = hosts ?? await detectHosts(repoRoot, home);
  const present = detected.all ?? detected;
  const results = [];

  results.push(await installAgentsMd(repoRoot, { bin }));
  results.push(...await installMcp(repoRoot, { bin, home, scope, hosts: present }));

  if (present.includes('claude-code')) results.push(await installClaudeCode(repoRoot, { bin }));
  if (present.includes('opencode')) results.push(await installOpenCode(repoRoot, { bin }));
  results.push(await installGitHooks(repoRoot, { bin }));

  return { detected, scope, results };
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
