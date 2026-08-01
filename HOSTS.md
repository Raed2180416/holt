# Agent host coverage

holt integrates with AI coding agents three ways, strongest first: a **deterministic blocking hook**, an **MCP server**, or an **advisory rules file** (AGENTS.md). Plus a universal git floor (the worktree lock + pre-commit hook) that needs no host cooperation. This page is meant to track holt's own manifest — run `holt hosts` to see the live, current version against *your* machine (that command reads the manifest directly and cannot drift; this file can, and has — see below).

This table has no automated generator (a past drift between it and `src/integrate/hosts.mjs` — Cursor's promotion to a docs-verified deny hook, Roo/Kilo's split into two products, Goose's and Amazon Q's corrected classification — went unreflected here for a while). Until one exists, treat `src/integrate/hosts.mjs` as ground truth and re-sync this file by hand whenever that manifest changes; `strengthLabel()` in that file produces the exact text below.

| Host | Environment | holt integration |
|---|---|---|
| Claude Code | local | BLOCKING (deterministic deny hook, verified live) |
| OpenCode | local | BLOCKING (deterministic deny hook, verified live) |
| Cursor | local | BLOCKING (deterministic deny hook, verified against host docs — not yet driven live) |
| OpenAI Codex CLI | local | MCP + advisory (deny hook planned) |
| Gemini CLI | local | MCP + advisory (deny hook planned) |
| GitHub Copilot (CLI / coding agent) | local | MCP + advisory (deny hook planned) |
| Cline | local | MCP + advisory (deny hook planned) |
| Crush (Charm) | local | MCP + advisory (deny hook planned) |
| Amp (Sourcegraph) | local | MCP + advisory (deny hook planned) |
| Goose (Block) | local | advisory (rules file only) — MCP config is YAML holt does not write; see below |
| Factory Droid | local | MCP + advisory (deny hook planned) |
| JetBrains Junie | local | MCP + advisory (deny hook planned) |
| Amazon Q Developer | local | MCP + advisory |
| Zed | local | MCP + advisory |
| Aider | local | advisory (rules file only) — no MCP client exists |
| Roo Code (archived) | local | MCP + advisory |
| Kilo Code | local | MCP + advisory |
| Warp | local | MCP + advisory |
| Devin Desktop / CLI (was Windsurf) | local | MCP + advisory (deny hook planned) |
| Google Jules | cloud | advisory (cloud — worktree lock does not apply) |
| Replit Agent | cloud | advisory (cloud — worktree lock does not apply) |
| Continue.dev (frozen) | local | MCP + advisory (no deny hook) |
| VS Code (host shell) | local | MCP + advisory (no deny hook) |

## The cloud caveat

holt's worktree lock and git pre-commit hook are LOCAL guarantees — they do not apply to cloud/ephemeral agents (Google Jules, Replit Agent, Devin cloud sessions), which run on a remote sandbox with no local worktree. There, holt reaches the agent only through an advisory AGENTS.md. Stated plainly rather than glossed.

## Reading this table

- **BLOCKING** — holt writes a hook the host enforces; a destructive command is refused before it runs, no model cooperation. Two grades, stated separately rather than collapsed: **verified live** means holt was actually driven against the real host and observed to deny; **verified against host docs** means the schema is taken from the host's own current documentation but has not been fired against a real instance of it. A documentation-derived adapter is real work, not a guess — but it is not the same claim as having watched it deny.
- **MCP + advisory (deny hook planned)** — the host *supports* a deny hook, but holt ships MCP + AGENTS.md until its bespoke adapter is verified. A guessed hook format is worse than none.
- **MCP + advisory** — holt runs as an MCP server the agent may call, and its AGENTS.md is read as context.
- **advisory** — the agent only reads a rules file; holt is context, not control. The git floor still applies for any *local* agent.

Whatever the host, the **git worktree lock** (agent-independent) and the **git pre-commit hook** remain the floor for any agent working on a real local checkout.
