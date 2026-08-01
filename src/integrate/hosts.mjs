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
    rulesFile: 'CLAUDE.md', mcp: true, verifiedLive: true,
    note: 'VERIFIED LIVE: the PreToolUse deny hook was driven against the real host and observed to '
      + 'return deny with the at-risk symbol named. holt\'s reference integration.' },
  { id: 'opencode', name: 'OpenCode', env: 'local', strength: 'block',
    detect: { project: ['.opencode', 'opencode.json'], user: ['.config/opencode'] },
    rulesFile: 'AGENTS.md', mcp: true, verifiedLive: true,
    note: 'VERIFIED LIVE: the plugin\'s tool.execute.before throws to block, confirmed against a real '
      + '`opencode debug config`. Caveat: subagent-spawned calls can bypass it (upstream bug) — the '
      + 'git lock is the floor.' },

  // --- block-CAPABLE hosts (host supports a deny hook; holt ships MCP+advisory until the
  //     bespoke adapter is verified, because a guessed hook format is worse than none) ----------
  { id: 'cursor', name: 'Cursor', env: 'local', strength: 'block', blockCapable: true, verifiedLive: false,
    detect: { project: ['.cursor', '.cursorrules'], user: ['.cursor'] },
    rulesFile: 'AGENTS.md · .cursor/rules/*.mdc', mcp: true,
    note: 'DETERMINISTIC BLOCK: holt writes .cursor/hooks.json (beforeShellExecution) and denies '
      + 'with Cursor\'s own {permission:"deny"} signal. Verified against Cursor\'s current hook '
      + 'documentation, not guessed.' },
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
  // Goose's only first-class MCP config is YAML (~/.config/goose/config.yaml, `extensions:`), and
  // that same file holds the user's permissions and secrets. holt writes JSON and TOML; it will
  // not hand-merge a YAML file it cannot parse safely, so this says so rather than claiming MCP.
  { id: 'goose', name: 'Goose (Block)', env: 'local', strength: 'advisory', blockCapable: true,
    detect: { project: ['.goosehints'], user: ['.config/goose'] },
    rulesFile: '.goosehints / AGENTS.md', mcp: false,
    note: 'MCP config is YAML at ~/.config/goose/config.yaml under `extensions:`, alongside the '
      + 'user\'s permissions and secrets — holt does not write it. Add by hand: '
      + 'extensions: { holt: { command: holt, args: [mcp] } }.' },
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
  // Aider has NO MCP client. The previous entry claimed 'MCP since late 2025', which was checked
  // against aider.chat's own current documentation and is false — there is no MCP page anywhere in
  // its docs and no MCP option in the tool. Claiming it made `holt hosts` promise a user coverage
  // that does not exist, which is worse than an admitted gap because it stops them looking further.
  { id: 'aider', name: 'Aider', env: 'local', strength: 'advisory',
    detect: { project: ['.aider.conf.yml'], user: ['.aider.conf.yml', '.config/aider'] },
    rulesFile: 'CONVENTIONS.md (loaded explicitly via --read or .aider.conf.yml `read:`)', mcp: false,
    note: 'NO MCP client as of 2026-08-01, and nothing is read automatically — not even AGENTS.md. '
      + 'Coverage here is the git pre-commit hook plus a CONVENTIONS.md the user loads themselves.' },
  // Split, because they are now two products with two different config formats — and one of them
  // is archived. Treating them as one row meant holt wrote neither.
  { id: 'roo', name: 'Roo Code (archived)', env: 'local', strength: 'mcp',
    detect: { project: ['.roo', '.roorules'], user: [] }, rulesFile: '.roo/rules/ · .roorules', mcp: true,
    note: 'ARCHIVED by its owner on 2026-05-15 and read-only. Still reads .roo/mcp.json, so holt '
      + 'wires existing installs; do not adopt it for new work.' },
  { id: 'kilo', name: 'Kilo Code', env: 'local', strength: 'mcp',
    detect: { project: ['.kilo', 'kilo.jsonc', '.kilocode'], user: ['.config/kilo'] },
    rulesFile: 'AGENTS.md', mcp: true,
    note: 'The maintained Roo successor, rebuilt on the OpenCode engine — which is why its key is '
      + '`mcp` with type:local entries, not the `mcpServers` its Roo ancestry suggests.' },
  { id: 'warp', name: 'Warp', env: 'local', strength: 'mcp',
    detect: { project: ['.warp', 'WARP.md'], user: ['.warp'] }, rulesFile: 'AGENTS.md (WARP.md legacy)', mcp: true,
    note: 'Terminal agent, MCP via .warp/.mcp.json. AGENTS.md must be ALL CAPS to be recognised.' },
  { id: 'devin-desktop', name: 'Devin Desktop / CLI (was Windsurf)', env: 'local', strength: 'mcp', blockCapable: true,
    detect: { project: ['.devin', '.windsurf', '.windsurfrules'], user: ['.codeium/windsurf'] },
    rulesFile: 'AGENTS.md · .devin/rules/ · CLAUDE.md', mcp: true,
    note: 'Cognition retired the Windsurf brand (2026); Devin CLI/Desktop accept a Claude-format hook. Legacy .windsurf paths still detected.' },

  // --- cloud / ephemeral: the worktree lock does NOT apply; advisory is the only lever ---------
  { id: 'jules', name: 'Google Jules', env: 'cloud', strength: 'advisory',
    detect: { project: [], user: [] }, rulesFile: 'AGENTS.md', mcp: false,
    note: 'Fresh cloud VM per task, no local worktree. holt\'s lock does NOT apply; AGENTS.md is the only lever.' },
  { id: 'replit', name: 'Replit Agent', env: 'cloud', strength: 'advisory',
    detect: { project: ['.replit'], user: [] }, rulesFile: 'AGENTS.md', mcp: false,
    note: 'Repo lives on Replit; remote-MCP-only. Furthest from the local-git model — advisory only.' },
  // Marked false because holt has no CONFIRMED config path for it. The CLI is understood to read
  // an mcp.json, but nothing here was verified against Amazon's current documentation, and holt's
  // rule is that a guessed config is worse than none.
  { id: 'amazon-q', name: 'Amazon Q Developer', env: 'cloud', strength: 'advisory',
    detect: { project: ['.amazonq'], user: ['.aws/amazonq'] }, rulesFile: 'AGENTS.md', mcp: false,
    note: 'Server-side issue→PR agent, no deny hook. Its MCP config path is NOT verified by us, so '
      + 'holt writes none rather than guessing; coverage here is AGENTS.md advisory.' },

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
