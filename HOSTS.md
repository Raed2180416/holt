# Agent host coverage

holt integrates with AI coding agents three ways, strongest first: a **deterministic blocking hook**, an **MCP server**, or an **advisory rules file** (AGENTS.md). Plus a universal git floor (the worktree lock + pre-commit hook) that needs no host cooperation. This page is generated from holt's own manifest — run `holt hosts` to see it against *your* machine.

| Host | Environment | holt integration |
|---|---|---|
| Claude Code | local | BLOCKING (deterministic deny hook) |
| OpenCode | local | BLOCKING (deterministic deny hook) |
| Cursor | local | MCP + advisory (deny hook planned) |
| OpenAI Codex CLI | local | MCP + advisory (deny hook planned) |
| Gemini CLI | local | MCP + advisory (deny hook planned) |
| GitHub Copilot (CLI / coding agent) | local | MCP + advisory (deny hook planned) |
| Cline | local | MCP + advisory (deny hook planned) |
| Crush (Charm) | local | MCP + advisory (deny hook planned) |
| Amp (Sourcegraph) | local | MCP + advisory (deny hook planned) |
| Goose (Block) | local | MCP + advisory (deny hook planned) |
| Factory Droid | local | MCP + advisory (deny hook planned) |
| JetBrains Junie | local | MCP + advisory (deny hook planned) |
| Zed | local | MCP + advisory |
| Aider | local | MCP + advisory |
| Roo Code / Kilo Code | local | advisory (rules file only) |
| Devin Desktop / CLI (was Windsurf) | local | MCP + advisory (deny hook planned) |
| Google Jules | cloud | advisory (cloud — worktree lock does not apply) |
| Replit Agent | cloud | advisory (cloud — worktree lock does not apply) |
| Amazon Q Developer | cloud | advisory (cloud — worktree lock does not apply) |
| Continue.dev (frozen) | local | advisory (rules file only) |
| VS Code (host shell) | local | advisory (rules file only) |

## The cloud caveat

holt's worktree lock and git pre-commit hook are LOCAL guarantees — they do not apply to cloud/ephemeral agents (Google Jules, Replit Agent, Devin cloud sessions), which run on a remote sandbox with no local worktree. There, holt reaches the agent only through an advisory AGENTS.md. Stated plainly rather than glossed.

## Reading this table

- **BLOCKING** — holt writes a hook the host enforces; a destructive command is refused before it runs, no model cooperation. Only listed where holt has a *verified* adapter.
- **MCP + advisory (deny hook planned)** — the host *supports* a deny hook, but holt ships MCP + AGENTS.md until its bespoke adapter is verified. A guessed hook format is worse than none.
- **MCP + advisory** — holt runs as an MCP server the agent may call, and its AGENTS.md is read as context.
- **advisory** — the agent only reads a rules file; holt is context, not control. The git floor still applies for any *local* agent.

Whatever the host, the **git worktree lock** (agent-independent) and the **git pre-commit hook** remain the floor for any agent working on a real local checkout.
