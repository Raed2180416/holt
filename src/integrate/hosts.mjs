/**
 * holt — the host capability manifest.
 *
 * ONE source of truth for every AI coding agent holt knows about, and — honestly — how strongly
 * holt can integrate with each. Compiled from a 2026 survey of the agent landscape. The point of
 * this file is transparency: `holt hosts` prints it verbatim, so a user sees exactly what
 * protection each of their agents gets rather than a blanket "works everywhere" claim.
 *
 * STRENGTH, strongest first:
 *   block     — holt writes a documented PRE-TOOL-USE deny hook; an explicit covered destructive
 *               operation is refused before it runs, without model cooperation. This grade says the
 *               adapter EXISTS. `verifiedLive` and each row's note separately say whether a real
 *               host process was driven; schema/source validation is never promoted into a live
 *               enforcement claim.
 *   mcp       — holt runs as an MCP server the agent can call (16 tools). Advisory + actable, but
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
  // --- dominant, local, holt can BLOCK ----------------------------------------------------------
  { id: 'claude-code', name: 'Claude Code', env: 'local', strength: 'block',
    detect: { project: ['.claude', 'CLAUDE.md'], user: ['.claude'] },
    rulesFile: 'CLAUDE.md', mcp: true, verifiedLive: false,
    blockScope: 'shell + exact Write/full-file Edit',
    note: 'IMPLEMENTED, NOT DRIVEN LIVE: Claude-format PreToolUse/Bash|Write|Edit config and output '
      + 'are contract-tested from current host docs; no real Claude process enforcement run is claimed. '
      + 'Write and a measured whole-file Edit get fresh path/content evidence; ordinary incremental '
      + 'Edit stays silent. MCP inputs remain server-defined and are not guessed from field names. '
      + 'Model context uses SessionStart and UserPromptSubmit only. Holt deliberately does not wire '
      + 'Stop: current Stop additionalContext continues the conversation under the same loop '
      + 'protections as decision:block, rather than supplying a passive advisory.' },
  { id: 'opencode', name: 'OpenCode', env: 'local', strength: 'block',
    detect: { project: ['.opencode', 'opencode.json'], user: ['.config/opencode'] },
    rulesFile: 'AGENTS.md', mcp: true, verifiedLive: false,
    blockScope: 'shell commands', failureMode: 'plugin errors fail open',
    note: 'IMPLEMENTED, NOT DRIVEN LIVE: source-level plugin contract and real `opencode debug config` '
      + 'discovery were checked, but that config smoke did not execute a destructive call through '
      + 'the host. The stable plugin has no proven model-context injection hook, so session.created '
      + 'terminal logging is not emitted or called context; AGENTS.md and MCP remain advisory. '
      + 'OpenCode V2 documents a real context hook, but that API is explicitly beta and is not '
      + 'mixed into Holt\'s stable 1.x plugin shape. '
      + 'Subagent-spawned calls can bypass the plugin (upstream bug).' },

  // --- documented blocking adapters (contract-tested; none is claimed as driven live) ----------
  { id: 'cursor', name: 'Cursor', env: 'local', strength: 'block', blockCapable: true, verifiedLive: false,
    detect: { project: ['.cursor', '.cursorrules'], user: ['.cursor'] },
    rulesFile: 'AGENTS.md · .cursor/rules/*.mdc', mcp: true,
    blockScope: 'shell commands', failureMode: 'hook crash, timeout, or invalid output fails open',
    note: 'IMPLEMENTED, NOT DRIVEN LIVE: .cursor/hooks.json uses beforeShellExecution and Cursor\'s '
      + 'current snake_case {permission,user_message,agent_message} output. Shell commands only; '
      + 'failClosed is explicitly false, so hook failure or timeout allows the command. Cursor Stop '
      + 'uses the documented followup_message only for completed loop_count=0 and changed state; '
      + 'that starts one bounded follow-up rather than passively injecting context.' },
  { id: 'cursor-cloud', name: 'Cursor Cloud Agent', env: 'cloud', strength: 'advisory',
    detect: { project: [], user: [] }, rulesFile: 'AGENTS.md · .cursor/rules/*.mdc', mcp: false,
    note: 'The repository hook can be present in a cloud checkout, but holt is not guaranteed to be '
      + 'installed in the remote environment and Cursor hook failures are fail-open. No cloud block '
      + 'claim is made.' },
  { id: 'codex', name: 'OpenAI Codex CLI / local clients', env: 'local', strength: 'block', blockCapable: true,
    detect: { project: ['.codex'], user: ['.codex'] },
    rulesFile: 'AGENTS.md', mcp: true, verifiedLive: false,
    blockScope: 'shell + exact apply_patch delete/risky move',
    note: 'IMPLEMENTED, NOT DRIVEN LIVE: .codex/hooks.json keeps the PreToolUse/Bash|apply_patch '
      + 'guard. Exact Delete File operations and pre-existing move destinations get fresh Holt '
      + 'evidence; ordinary Add/Update patches stay silent. Codex has no supported ask decision, '
      + 'so a destructive operation Holt cannot verify is denied instead of becoming a hook failure. '
      + 'Arbitrary local-function and MCP inputs remain tool-specific and are not guessed. It '
      + 'runs SessionStart auto-protection before the first tool call, and injects concise sibling '
      + 'context through documented SessionStart and UserPromptSubmit additionalContext output. '
      + 'Unchanged prompt briefs stay silent. Project hooks do not run until the exact definition '
      + 'is reviewed and trusted; specialized or hosted tool paths can opt out, so BLOCKING is the '
      + 'named shell/apply_patch scope, not a total tool boundary.' },
  { id: 'codex-cloud', name: 'OpenAI Codex cloud', env: 'cloud', strength: 'advisory',
    detect: { project: [], user: [] }, rulesFile: 'AGENTS.md', mcp: false,
    note: 'Remote environment: the local worktree lock does not apply and the holt executable is '
      + 'not guaranteed to exist. Project hook schema support does not by itself prove enforcement.' },
  { id: 'gemini-cli', name: 'Gemini CLI', env: 'local', strength: 'mcp', blockCapable: true,
    detect: { project: ['.gemini', 'GEMINI.md'], user: ['.gemini'] },
    rulesFile: 'GEMINI.md', mcp: true,
    note: 'Has a command-hook system AND a declarative policy engine; holt ships MCP + advisory today.' },
  { id: 'antigravity', name: 'Google Antigravity 2 / IDE / CLI', env: 'local', strength: 'mcp',
    blockCapable: true, proactiveContext: true, verifiedLive: false,
    detect: {
      project: ['.agents/hooks.json', '.agents/mcp_config.json'],
      user: ['.gemini/antigravity', '.gemini/antigravity-cli'],
    },
    rulesFile: 'AGENTS.md · .agents/rules/*.md', mcp: true,
    note: 'IMPLEMENTED CONTEXT + MCP, NOT BLOCKING: project .agents/mcp_config.json exposes Holt '
      + 'reactively, while .agents/hooks.json uses documented PreInvocation ephemeralMessage '
      + 'injection to deliver changed sibling context proactively and auto-protect on invocation 0. '
      + 'Holt does not install Antigravity PreToolUse yet: the documented allow decision '
      + 'auto-approves execution and no neutral pass-through is documented, so an unproved guard '
      + 'could weaken native permissions or prompt on every safe command. Live discovery/context '
      + 'and failure-semantics proof are still required before any blocking claim.' },
  { id: 'qwen-code', name: 'Qwen Code', env: 'local', strength: 'block', blockCapable: true,
    verifiedLive: false,
    detect: { project: ['.qwen', 'QWEN.md'], user: ['.qwen'] },
    rulesFile: 'AGENTS.md · QWEN.md · .qwen/rules/', mcp: true,
    blockScope: 'shell + exact write_file/full-file edit',
    failureMode: 'exit 2 blocks; hook crash, timeout, or other errors fail open',
    note: 'IMPLEMENTED, NOT DRIVEN LIVE: current Qwen Code source and docs define project '
      + '.qwen/settings.json for both MCP and hooks. PreToolUse covers canonical runtime IDs '
      + 'run_shell_command, write_file and edit; exact writes and measured full-file edits receive '
      + 'fresh path evidence while incremental edits stay silent. SessionStart and '
      + 'UserPromptSubmit deliver changed-state context. Source documents fail-open runner errors; '
      + 'a real Qwen 0.21.5 destructive-call run is still required before verifiedLive can become true.' },
  // Copilot CLI does NOT read .vscode/mcp.json — that file is the separate VS Code Copilot Chat
  // extension's config, and it uses the unsupported top-level key `servers`. Confirmed against
  // GitHub's own docs (docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers)
  // and a Microsoft migration notice telling users to move OFF .vscode/mcp.json for the CLI. The
  // CLI's real project file is `.mcp.json` or `.github/mcp.json` (mcpServers, walked from cwd to
  // repo root); holt now writes the latter. Global scope is `~/.copilot/mcp-config.json`.
  { id: 'copilot', name: 'GitHub Copilot CLI', env: 'local', strength: 'block', blockCapable: true, verifiedLive: false,
    detect: { project: ['.github/copilot-instructions.md'], user: [] },
    rulesFile: '.github/copilot-instructions.md', mcp: true,
    blockScope: 'shell commands', failureMode: 'timeouts fail open; other command-hook errors fail closed',
    note: 'IMPLEMENTED, NOT DRIVEN LIVE: .github/hooks/holt.json uses version 1, PascalCase '
      + 'PreToolUse/Bash and permissionDecision:deny. The same file is visible to cloud agent, so '
      + 'its command first checks whether holt exists; absence fails open instead of bricking jobs.' },
  { id: 'copilot-cloud', name: 'GitHub Copilot cloud coding agent', env: 'cloud', strength: 'advisory',
    detect: { project: [], user: [] }, rulesFile: '.github/copilot-instructions.md', mcp: false,
    note: 'The shared .github hook is installed safely but intentionally fails open when the '
      + 'ephemeral sandbox lacks holt. It blocks there only if the project independently provisions '
      + 'the executable; holt does not claim that default cloud environment as enforced.' },
  // The Cline CLI has NO project-scope MCP file at all — verified against cline/cline#11671, which
  // is Cline's OWN maintainers confirming their docs wrongly say `~/.cline/mcp.json` while the code
  // actually reads `~/.cline/data/settings/cline_mcp_settings.json` (overridable via
  // CLINE_MCP_SETTINGS_PATH / CLINE_DATA_DIR). holt was shipping the same wrong path its docs did.
  // There is no repo-committed Cline config surface — only that single global file, and only if the
  // user already has it (holt never fabricates a user-scope config from nothing).
  { id: 'cline', name: 'Cline IDE extension', env: 'local', strength: 'block', blockCapable: true, verifiedLive: false,
    detect: { project: ['.clinerules'], user: [] },
    rulesFile: '.clinerules', mcp: false, blockScope: 'shell commands', failureMode: 'hook failures fail open',
    note: 'IMPLEMENTED, NOT DRIVEN LIVE against current source: .clinerules/hooks/PreToolUse is a '
      + 'POSIX executable, reads preToolUse.toolName/parameters, and blocks execute_command with '
      + '{cancel:true} at exit 0. Cline currently documents Windows hooks as unsupported.' },
  { id: 'cline-cli', name: 'Cline CLI', env: 'local', strength: 'mcp', blockCapable: true,
    detect: { project: ['.cline'], user: ['.cline'] }, rulesFile: 'AGENTS.md', mcp: true,
    note: 'Separate from the IDE executable-hook surface. MCP is user-scope only at '
      + '~/.cline/data/settings/cline_mcp_settings.json; no repository MCP file is fabricated. '
      + 'A deterministic default project hook path was not confirmed for the CLI.' },
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
  { id: 'goose', name: 'Goose (Block)', env: 'local', strength: 'block', blockCapable: true, verifiedLive: false,
    detect: { project: ['.goosehints'], user: ['.config/goose'] },
    rulesFile: '.goosehints / AGENTS.md', mcp: false,
    blockScope: 'shell commands', failureMode: 'broken hooks fail open',
    note: 'IMPLEMENTED, NOT DRIVEN LIVE: project plugin .agents/plugins/holt matches '
      + 'developer__shell and emits Goose\'s {decision:"block"} plus exit 2/stderr. Broken or '
      + 'timed-out hooks fail open. MCP remains manual YAML because it shares user secrets.' },
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
  { id: 'devin-cli', name: 'Devin CLI / Devin Local', env: 'local', strength: 'block', blockCapable: true, verifiedLive: false,
    detect: { project: ['.devin'], user: ['.config/devin'] },
    rulesFile: 'AGENTS.md · .devin/rules/', mcp: true, blockScope: 'shell commands',
    failureMode: 'exit 2 blocks; other hook errors fail open',
    note: 'IMPLEMENTED, NOT DRIVEN LIVE: .devin/hooks.v1.json is the bare event map, matches exec, '
      + 'and emits {decision:"block"}. MCP uses the shared .devin/mcp_config.json (not the '
      + 'gitignored .local override) and ~/.config/devin/mcp_config.json.' },
  { id: 'cascade', name: 'Devin Desktop Cascade (formerly Windsurf)', env: 'local', strength: 'block', blockCapable: true, verifiedLive: false,
    detect: { project: ['.windsurf', '.windsurfrules'], user: ['.codeium/windsurf'] },
    rulesFile: 'AGENTS.md · .windsurfrules', mcp: true, blockScope: 'shell commands',
    failureMode: 'exit 2 blocks; other hook errors fail open',
    note: 'IMPLEMENTED, NOT DRIVEN LIVE: .windsurf/hooks.json pre_run_command reads '
      + 'tool_info.command_line and blocks via exit 2/stderr. Current canonical docs still place '
      + 'Desktop MCP at ~/.codeium/windsurf/mcp_config.json; the legacy-looking directory name is current.' },

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
  { id: 'continue', name: 'Continue', env: 'local', strength: 'mcp',
    detect: { project: ['.continue', '.continuerc.json'], user: ['.continue'] }, rulesFile: '.continuerules', mcp: true,
    note: 'Current project integration writes a standard MCP JSON file at '
      + '.continue/mcpServers/holt.json. The deprecated ~/.continue/config.json target is retired '
      + 'rather than extended; no YAML round-trip of the user\'s main config is needed.' },
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
  // Keep implemented contract adapters visibly distinct from a real host process observed denying
  // a command. At present every blocking row is in the former category; retaining the field and
  // branch prevents a future live run from silently inheriting weaker wording (or vice versa).
  if (h.strength === 'block') {
    const scope = h.blockScope ?? 'documented pre-tool deny hook';
    const failure = h.failureMode ? `; ${h.failureMode}` : '';
    return h.verifiedLive
      ? `BLOCKING (${scope}${failure}; driven against a real host)`
      : `BLOCKING (${scope}${failure}; contract-tested, not driven live)`;
  }
  if (h.strength === 'mcp' && h.proactiveContext) {
    return 'MCP + proactive context (blocking unproven)';
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
  + 'cloud/ephemeral agents (Codex cloud, Copilot cloud, Cursor cloud, Google Jules, Replit Agent), '
  + 'which run in a remote sandbox with no local worktree. Repository hook files may be visible '
  + 'there, but holt does not claim blocking unless that sandbox also provisions and runs the holt '
  + 'executable; by default these rows remain advisory. Stated plainly rather than glossed.';
