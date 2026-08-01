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
  // Copilot CLI does NOT read .vscode/mcp.json — that file is the separate VS Code Copilot Chat
  // extension's config, and it uses the unsupported top-level key `servers`. Confirmed against
  // GitHub's own docs (docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers)
  // and a Microsoft migration notice telling users to move OFF .vscode/mcp.json for the CLI. The
  // CLI's real project file is `.mcp.json` or `.github/mcp.json` (mcpServers, walked from cwd to
  // repo root); holt now writes the latter. Global scope is `~/.copilot/mcp-config.json`.
  { id: 'copilot', name: 'GitHub Copilot (CLI / coding agent)', env: 'local', strength: 'mcp', blockCapable: true,
    detect: { project: ['.github/copilot-instructions.md'], user: [] },
    rulesFile: '.github/copilot-instructions.md', mcp: true,
    note: 'Dominant reach; coding-agent runs partly in cloud. Project MCP is .github/mcp.json '
      + '(mcpServers) — NOT .vscode/mcp.json, which the CLI does not read. holt ships MCP + '
      + 'advisory; the coding-agent async surface (GitHub App issue→PR) is advisory-only.' },
  // The Cline CLI has NO project-scope MCP file at all — verified against cline/cline#11671, which
  // is Cline's OWN maintainers confirming their docs wrongly say `~/.cline/mcp.json` while the code
  // actually reads `~/.cline/data/settings/cline_mcp_settings.json` (overridable via
  // CLINE_MCP_SETTINGS_PATH / CLINE_DATA_DIR). holt was shipping the same wrong path its docs did.
  // There is no repo-committed Cline config surface — only that single global file, and only if the
  // user already has it (holt never fabricates a user-scope config from nothing).
  { id: 'cline', name: 'Cline', env: 'local', strength: 'mcp', blockCapable: true,
    detect: { project: ['.clinerules'], user: [] },
    rulesFile: '.clinerules', mcp: true,
    note: 'Executable hooks in .clinerules/hooks/ (deny via exit code). MCP has NO project scope — '
      + 'only one global file, ~/.cline/data/settings/cline_mcp_settings.json (mcpServers); the '
      + 'VS Code extension keeps its own copy in per-platform globalStorage holt does not write.' },
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
  // Shape confirmed against Goose's own current docs (goose-docs.ai/docs/guides/config-files and
  // /docs/getting-started/using-extensions): each entry needs `cmd` (NOT `command`), `type: stdio`,
  // and `enabled: true` — a prior revision of this note itself got the field name wrong (`command`),
  // which would have sent a user copying it straight into a config Goose silently ignores.
  { id: 'goose', name: 'Goose (Block)', env: 'local', strength: 'advisory', blockCapable: true,
    detect: { project: ['.goosehints'], user: ['.config/goose'] },
    rulesFile: '.goosehints / AGENTS.md', mcp: false,
    note: 'MCP config is YAML at ~/.config/goose/config.yaml under `extensions:`, alongside the '
      + 'user\'s permissions and secrets — holt does not write it. Add by hand:\n'
      + 'extensions:\n  holt:\n    name: holt\n    cmd: holt\n    args: [mcp]\n    enabled: true\n    type: stdio' },
  { id: 'factory', name: 'Factory Droid', env: 'local', strength: 'mcp', blockCapable: true,
    detect: { project: ['.factory'], user: ['.factory'] },
    rulesFile: 'AGENTS.md', mcp: true,
    note: 'PreToolUse deny hook + org policy; holt ships MCP + advisory today.' },
  { id: 'junie', name: 'JetBrains Junie', env: 'local', strength: 'mcp', blockCapable: true,
    detect: { project: ['.junie'], user: [] },
    rulesFile: '.junie/guidelines.md', mcp: true,
    note: 'CLI blocking hook, but project config is untrusted-by-default (needs opt-in). MCP + advisory today.' },
  // PREVIOUSLY misclassified env:'cloud' entirely, on the theory that "Amazon Q Developer" means
  // the server-side GitHub-issue→PR agent. It does not ONLY mean that: `.amazonq` / `.aws/amazonq`
  // — this row's OWN detection markers — belong to the Amazon Q Developer CLI, a local interactive
  // terminal agent that reads/writes real files and runs real git, same kind of tool as Codex CLI
  // or Copilot CLI. Confirmed against docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/: the CLI
  // has a real, stable, file-based MCP config (mcpServers, both scopes) that was simply never
  // implemented because the row was scoped around the wrong surface. The separate GitHub App agent
  // (issue→PR, "Amazon Q development agent" label) IS real and IS cloud/async — it just is not the
  // whole story, so it is now a caveat on a local row rather than the row's entire classification.
  { id: 'amazon-q', name: 'Amazon Q Developer', env: 'local', strength: 'mcp',
    detect: { project: ['.amazonq'], user: ['.aws/amazonq'] },
    rulesFile: 'none auto-read — `.amazonq/rules/*.md` is a real lever (confirmed, analogous to '
      + 'Cursor\'s .cursor/rules/*.mdc) but holt writes plain AGENTS.md at the repo root, which the '
      + 'CLI does not look inside that directory for',
    mcp: true,
    note: 'Amazon Q Developer CLI is LOCAL (real files, real git) — MCP confirmed at .amazonq/mcp.json '
      + '(project) and ~/.aws/amazonq/mcp.json (user), both `mcpServers`, legacy-but-enabled-by-default '
      + '(useLegacyMcpJson). The separate "Amazon Q Developer in GitHub" issue→PR agent is a different, '
      + 'cloud/async surface with no deny hook and no rules file it reads — advisory-only, same split as Copilot.' },

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
  // Devin Desktop's global MCP config still lives at the legacy Windsurf path — confirmed current,
  // not just grandfathered (docs.devin.ai / community reporting on the June 2026 rebrand: the data
  // directory keeps the old name by design). Devin CLI ALSO has its own project file,
  // .devin/mcp_config.local.json — but its own docs call it out as meant to be GITIGNORED (secrets
  // live there), which conflicts with holt's project-scope philosophy of a committed file that works
  // for the next person. Left uncovered rather than writing a committed file into a path the host's
  // own docs say should not be committed.
  { id: 'devin-desktop', name: 'Devin Desktop / CLI (was Windsurf)', env: 'local', strength: 'mcp', blockCapable: true,
    detect: { project: ['.devin', '.windsurf', '.windsurfrules'], user: ['.codeium/windsurf'] },
    rulesFile: 'AGENTS.md · .devin/rules/ · CLAUDE.md', mcp: true,
    note: 'Cognition retired the Windsurf brand (2026); Devin CLI/Desktop accept a Claude-format hook. Legacy .windsurf paths still detected. MCP is user-scope only — the CLI\'s project file is designed to be gitignored, so holt does not write it.' },

  // --- cloud / ephemeral: the worktree lock does NOT apply; advisory is the only lever ---------
  { id: 'jules', name: 'Google Jules', env: 'cloud', strength: 'advisory',
    detect: { project: [], user: [] }, rulesFile: 'AGENTS.md', mcp: false,
    note: 'Fresh cloud VM per task, no local worktree. holt\'s lock does NOT apply; AGENTS.md is the '
      + 'only lever. Jules restricts MCP to a vetted partner allowlist (confirmed), so a self-hosted '
      + 'server like holt could not be added even if it were worth wiring for an ephemeral VM.' },
  // Verified: Replit Agent's MCP setup is entirely UI-driven through the Integrations pane — no
  // local JSON config file at all (docs.replit.com/platforms/mcp-server). Nothing here for holt to
  // write; this is a real "no file exists" rather than an unverified guess.
  { id: 'replit', name: 'Replit Agent', env: 'cloud', strength: 'advisory',
    detect: { project: ['.replit'], user: [] }, rulesFile: 'AGENTS.md', mcp: false,
    note: 'Repo lives on Replit; remote-MCP-only, UI-configured, no local config file. Furthest from '
      + 'the local-git model — advisory only.' },

  // --- editors / frozen: detect but do not over-integrate --------------------------------------
  // Continue's OWN docs call config.json "deprecated" in favour of config.yaml — but also state
  // that config.json is only ignored once a config.yaml EXISTS ("if a config.yaml file is present,
  // it will be loaded instead of config.json"). So the write here still works for anyone who has
  // not migrated, and goes quietly inert for anyone who has. Worth a YAML writer in the abstract,
  // not worth building one for a repo that has been read-only since 2026-07-15.
  { id: 'continue', name: 'Continue.dev (frozen)', env: 'local', strength: 'advisory',
    detect: { project: ['.continuerc.json'], user: ['.continue'] }, rulesFile: '.continuerules', mcp: true,
    note: 'Repo went read-only 2026-07-15 — legacy only, not a forward path. holt writes the '
      + 'deprecated config.json (mcpServers); it is only READ if the user has no config.yaml — once '
      + 'they migrate, this write is silently inert. Not worth a YAML writer for an archived project.' },
  { id: 'vscode', name: 'VS Code (host shell)', env: 'local', strength: 'advisory',
    detect: { project: ['.vscode'], user: [] }, rulesFile: '.github/copilot-instructions.md', mcp: true,
    note: 'The editor is not the agent — its active AI extension (Copilot / Cline / Roo) determines '
      + 'the real posture. MCP is .vscode/mcp.json under `servers` (confirmed against VS Code\'s own '
      + 'docs) — a DIFFERENT file and key from Copilot CLI\'s own .github/mcp.json / mcpServers, so '
      + 'this row is VS Code-only and does not also cover the standalone Copilot CLI.' },
];

const byId = new Map(HOSTS.map((h) => [h.id, h]));
export const getHost = (id) => byId.get(id) ?? null;

/** Human-facing strength label. */
export function strengthLabel(h) {
  if (h.env === 'cloud') return 'advisory (cloud — worktree lock does not apply)';
  // TWO GRADES OF "BLOCKING", AND THIS LABEL WAS COLLAPSING THEM. verifiedLive:true (Claude Code,
  // OpenCode) means holt was DRIVEN against the real host and observed to deny. Cursor is
  // strength:'block' too, but verifiedLive:false — its hook schema is taken from Cursor's own
  // published docs, never fired against a real Cursor process. The e2e test right next to this
  // file's manifest test says the quiet part out loud: "collapsing the two would let a
  // documentation-derived adapter inherit the credibility of a demonstrated one" — but the label a
  // user actually reads (`holt hosts`, HOSTS.md) was doing exactly that collapse, printing the
  // identical string for both grades.
  if (h.strength === 'block') {
    return h.verifiedLive
      ? 'BLOCKING (deterministic deny hook, verified live)'
      : 'BLOCKING (deterministic deny hook, verified against host docs — not yet driven live)';
  }
  if (h.strength === 'mcp') return h.blockCapable
    ? 'MCP + advisory (deny hook planned)'
    : 'MCP + advisory';
  // 'advisory' STRENGTH is about the absence of a deny hook, not the absence of MCP — Continue and
  // VS Code both get a real MCP config written (see mcpTargets) despite being downgraded here for
  // other reasons (frozen repo; "the editor is not the agent"). Saying "rules file only" for those
  // two undersells what holt actually does, which is the opposite direction of dishonesty from the
  // one this file exists to prevent, but still a wrong sentence in a page whose entire point is to
  // be exact about what a user's agent gets.
  if (h.strength === 'advisory') return h.mcp ? 'MCP + advisory (no deny hook)' : 'advisory (rules file only)';
  return 'git-level only';
}

/** The one honest sentence about cloud agents, reused in docs and the CLI. */
export const CLOUD_CAVEAT =
  'holt\'s worktree lock and git pre-commit hook are LOCAL guarantees — they do not apply to '
  + 'cloud/ephemeral agents (Google Jules, Replit Agent, Devin cloud sessions), which run on a '
  + 'remote sandbox with no local worktree. There, holt reaches the agent only through an '
  + 'advisory AGENTS.md. Stated plainly rather than glossed.';
