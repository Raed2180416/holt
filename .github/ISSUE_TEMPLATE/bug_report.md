---
name: Bug report
about: Report reproducible Holt CLI, TUI, hook, MCP, or integration behaviour
title: ''
labels: 'bug'
assignees: ''

---

Thanks for taking the time to make Holt safer. Do not include credentials, licence tokens,
private source, or unredacted repository paths. Security vulnerabilities belong in a private
[GitHub Security Advisory](https://github.com/Raed2180416/holt/security/advisories/new), not here.

## What happened?

Include the exact command and complete redacted output.

## What did you expect?

## Minimal reproduction

List the smallest sequence that reproduces the issue. Say whether the repository uses Git
worktrees, jj workspaces, submodules, partial/shallow clone, network storage, or symlinked paths.

## Environment

- Holt version (`holt --version`):
- Install source (official GitHub release, source checkout, other):
- OS and architecture:
- Shell / terminal:
- Node version (`node --version`):
- Git version (`git --version`):
- Agent host and version, if this is an integration issue:

## Diagnostics

Attach relevant **redacted** output from `holt doctor --json` and, for install-integrity issues,
`holt audit --json`. Review environment values, usernames and paths before posting.
