/**
 * holt — the host capability manifest.
 *
 * ONE source of truth for every AI coding agent holt knows about, and — honestly — how strongly
 * holt can integrate with each. Compiled from a 2026 survey of the agent landscape. The point of
 * this file is transparency: `holt hosts` prints it verbatim, so a user sees exactly what
 * protection each of their agents gets rather than a blanket "works everywhere" claim.
 *
 * STRENGTH, strongest first:
 *   block     — holt writes a deterministic PRE-TOOL-USE deny hook the host enforces; a
 *               destructive command is refused before it runs, no model cooperation. Only listed
 *               where holt has a VERIFIED adapter that actually fires. Everything else that is
 *               merely block-CAPABLE is marked 'mcp' until its adapter is verified, because a hook
 *               config written in a guessed format is worse than none.
 *   mcp       — holt runs as an MCP server the agent can call (14 tools). Advisory + actable, but
 *               the model chooses to call it.
 *   advisory  — the agent only reads a rules file (AGENTS.md/CLAUDE.md/…); holt is context, not
 *               control.
 *   git       — no agent integration; the universal git pre-commit hook + git's own worktree lock
 *               are the only levers (they need no host cooperation at all).
 *
 * ENV: 'local' = runs on the user's filesystem with real git worktrees, so holt's lock applies.
 *      'cloud' = ephemeral remote sandbox; the worktree lock does NOT apply and holt can only
 *      reach it via an advisory rules file. Stated plainly rather than glossed.
 */

export const HOSTS = [
  // --- dominant, local, holt can BLOCK (verified adapters) -------------------------------------
  { id: 'claude-code', name: 'Claude Code', env: 'local', strength: 'block',
    detect: { project: ['.claude', 'CLAUDE.md'], user: ['.claude'] },
    rulesFile: 'CLAUDE.md', mcp: true,
    note: 'PreToolUse deny hook — holt\'s reference integration; refuses before the tool runs.' },
  { id: 'opencode', name: 'OpenCode', env: 'local', strength: 'block',
    detect: { project: ['.opencode', 'opencode.json'], user: ['.config/opencode'] },
    rulesFile: 'AGENTS.md', mcp: true,
    note: 'plugin tool.execute.before throws to block. Caveat: subagent-spawned calls can bypass it (upstream bug) — the git lock is the floor.' },

  // --- block-CAPABLE hosts (host supports a deny hook; holt ships MCP+advisory until the
  //     bespoke adapter is verified, because a guessed hook format is worse than none) ----------
  { id: 'cursor', name: 'Cursor', env: 'local', strength: 'mcp', blockCapable: true,
    detect: { project: ['.cursor', '.cursorrules'], user: ['.cursor'] },
    rulesFile: '.cursorrules / .cursor/rules', mcp: true,
    note: 'Cursor has a deny hook (JSON permission:deny). holt ships MCP + rules today; a verified deny adapter is planned.' },
  { id: 'codex', name: 'OpenAI Codex CLI', env: 'local', strength: 'mcp', blockCapable: true,
    detect: { project: ['.codex'], user: ['.codex'] },
    rulesFile: 'AGENTS.md', mcp: true,
    note: 'Codex reads AGENTS.md natively and supports hooks; holt ships MCP + advisory today.' },
  { id: 'gemini-cli', name: 'Gemini CLI', env: 'local', strength: 'mcp', blockCapable: true,
    detect: { project: ['.gemini', 'GEMINI.md'], user: ['.gemini'] },
    rulesFile: 'GEMINI.md', mcp: true,
    note: 'Has a command-hook system AND a declarative policy engine; holt ships MCP + advisory today.' },
  { id: 'copilot', name: 'GitHub Copilot (CLI / coding agent)', env: 'local', strength: 'mcp', blockCapable: true,
    detect: { project: ['.github/copilot-instructions.md'], user: [] },
    rulesFile: '.github/copilot-instructions.md', mcp: true,
    note: 'Dominant reach; coding-agent runs partly in cloud. holt ships MCP + advisory; the coding-agent async surface is advisory-only.' },
  { id: 'cline', name: 'Cline', env: 'local', strength: 'mcp', blockCapable: true,
    detect: { project: ['.clinerules'], user: [] },
    rulesFile: '.clinerules', mcp: true,
    note: 'Executable hooks in .clinerules/hooks/ (deny via exit code); holt ships MCP + advisory today.' },
  { id: 'crush', name: 'Crush (Charm)', env: 'local', strength: 'mcp', blockCapable: true,
    detect: { project: ['.crush', 'crush.json'], user: ['.config/crush'] },
    rulesFile: 'AGENTS.md', mcp: true,
    note: 'Pre-permission shell hook (self-labeled preliminary); holt ships MCP + advisory today.' },
  { id: 'amp', name: 'Amp (Sourcegraph)', env: 'local', strength: 'mcp', blockCapable: true,
    detect: { project: ['.amp'], user: ['.config/amp'] },
    rulesFile: 'AGENTS.md', mcp: true,
    note: 'permissions reject + hooks; permissive-by-default. holt ships MCP + advisory today.' },
  { id: 'goose', name: 'Goose (Block)', env: 'local', strength: 'mcp', blockCapable: true,
    detect: { project: ['.goosehints'], user: ['.config/goose'] },
    rulesFile: '.goosehints / AGENTS.md', mcp: true,
    note: 'Open-Plugins hooks.json (AAIF cross-agent spec); holt ships MCP + advisory today.' },
  { id: 'factory', name: 'Factory Droid', env: 'local', strength: 'mcp', blockCapable: true,
    detect: { project: ['.factory'], user: ['.factory'] },
    rulesFile: 'AGENTS.md', mcp: true,
    note: 'PreToolUse deny hook + org policy; holt ships MCP + advisory today.' },
  { id: 'junie', name: 'JetBrains Junie', env: 'local', strength: 'mcp', blockCapable: true,
    detect: { project: ['.junie'], user: [] },
    rulesFile: '.junie/guidelines.md', mcp: true,
    note: 'CLI blocking hook, but project config is untrusted-by-default (needs opt-in). MCP + advisory today.' },

  // --- MCP or advisory only (no deny hook, or unverified) --------------------------------------
  { id: 'zed', name: 'Zed', env: 'local', strength: 'mcp',
    detect: { project: ['.zed'], user: ['.config/zed'] }, rulesFile: 'AGENTS.md / .rules', mcp: true,
    note: 'MCP (context_servers). No pre-tool deny hook.' },
  { id: 'aider', name: 'Aider', env: 'local', strength: 'mcp',
    detect: { project: ['.aider.conf.yml'], user: ['.aider.conf.yml', '.config/aider'] },
    rulesFile: 'CONVENTIONS.md (via read:)', mcp: true,
    note: 'MCP since late 2025; no per-call deny hook. Strongest lever here is the git pre-commit hook.' },
  { id: 'roo', name: 'Roo Code / Kilo Code', env: 'local', strength: 'advisory',
    detect: { project: ['.roo', '.roorules', '.kilocode'], user: [] }, rulesFile: '.roorules', mcp: false,
    note: 'Rules-file advisory. (Kilo Code is the maintained Roo successor.)' },
  { id: 'devin-desktop', name: 'Devin Desktop / CLI (was Windsurf)', env: 'local', strength: 'mcp', blockCapable: true,
    detect: { project: ['.devin', '.windsurf', '.windsurfrules'], user: ['.codeium/windsurf'] },
    rulesFile: 'AGENTS.md / .windsurfrules', mcp: true,
    note: 'Cognition retired the Windsurf brand (2026); Devin CLI/Desktop accept a Claude-format hook. Legacy .windsurf paths still detected.' },

  // --- cloud / ephemeral: the worktree lock does NOT apply; advisory is the only lever ---------
  { id: 'jules', name: 'Google Jules', env: 'cloud', strength: 'advisory',
    detect: { project: [], user: [] }, rulesFile: 'AGENTS.md', mcp: false,
    note: 'Fresh cloud VM per task, no local worktree. holt\'s lock does NOT apply; AGENTS.md is the only lever.' },
  { id: 'replit', name: 'Replit Agent', env: 'cloud', strength: 'advisory',
    detect: { project: ['.replit'], user: [] }, rulesFile: 'AGENTS.md', mcp: false,
    note: 'Repo lives on Replit; remote-MCP-only. Furthest from the local-git model — advisory only.' },
  { id: 'amazon-q', name: 'Amazon Q Developer', env: 'cloud', strength: 'advisory',
    detect: { project: ['.amazonq'], user: ['.aws/amazonq'] }, rulesFile: 'AGENTS.md', mcp: true,
    note: 'Server-side issue→PR agent; MCP-capable, no deny hook. Local sessions get MCP; async is advisory.' },

  // --- editors / frozen: detect but do not over-integrate --------------------------------------
  { id: 'continue', name: 'Continue.dev (frozen)', env: 'local', strength: 'advisory',
    detect: { project: ['.continuerc.json'], user: ['.continue'] }, rulesFile: '.continuerules', mcp: true,
    note: 'Repo went read-only 2026-07-15 — legacy only, not a forward path.' },
  { id: 'vscode', name: 'VS Code (host shell)', env: 'local', strength: 'advisory',
    detect: { project: ['.vscode'], user: [] }, rulesFile: '.github/copilot-instructions.md', mcp: true,
    note: 'The editor is not the agent — its active AI extension (Copilot / Cline / Roo) determines the real posture. Detected for MCP config only.' },
];

const byId = new Map(HOSTS.map((h) => [h.id, h]));
export const getHost = (id) => byId.get(id) ?? null;

/** Human-facing strength label. */
export function strengthLabel(h) {
  if (h.env === 'cloud') return 'advisory (cloud — worktree lock does not apply)';
  if (h.strength === 'block') return 'BLOCKING (deterministic deny hook)';
  if (h.strength === 'mcp') return h.blockCapable
    ? 'MCP + advisory (deny hook planned)'
    : 'MCP + advisory';
  if (h.strength === 'advisory') return 'advisory (rules file only)';
  return 'git-level only';
}

/** The one honest sentence about cloud agents, reused in docs and the CLI. */
export const CLOUD_CAVEAT =
  'holt\'s worktree lock and git pre-commit hook are LOCAL guarantees — they do not apply to '
  + 'cloud/ephemeral agents (Google Jules, Replit Agent, Devin cloud sessions), which run on a '
  + 'remote sandbox with no local worktree. There, holt reaches the agent only through an '
  + 'advisory AGENTS.md. Stated plainly rather than glossed.';
