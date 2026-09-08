# Keep a workspace while a session is using it

A clean worktree can still be in use. An agent may be thinking, running a command, or preparing
an edit that has not reached disk. Content analysis alone cannot observe that work.

Before starting, claim the worktree with an identifier for your session:

```sh
holt ownership claim my-worktree --owner session-123
```

The default lease is 15 minutes. Renew it while working, before it expires:

```sh
holt ownership heartbeat my-worktree --owner session-123
```

To transfer responsibility to another session:

```sh
holt ownership handoff my-worktree --owner session-123 --to session-456
```

When the session no longer needs the workspace:

```sh
holt ownership release my-worktree --owner session-456
```

Release ends the claim. It does not delete files, declare the task complete, or make unique work
disposable. Holt's ordinary content and recovery checks still apply.

## What the other features do with a claim

- `gate` and `clean` retain claimed worktrees, including ones with no saved changes.
- `plan` and `order` defer them until ownership is resolved; being retained is not readiness to merge.
- `context`, normal hook briefings, the TUI, and the graph show ownership. A handoff refreshes
  cached hook context even if Git and working files are unchanged.
- Linked worktrees also receive a native Git lock when no other lock already exists. Ordinary
  `unprotect` leaves this session lock alone; use the ownership lifecycle to release it.
- `rescue` preserves saved content. It cannot capture an editor buffer or an agent's unsaved work.

MCP exposes the same lifecycle through `holt_worktree_ownership`. A session or its integration
must explicitly participate; installing Holt does not automatically register every running agent.

## If a session stops responding

```sh
holt ownership status my-worktree
```

Expiry does not prove abandonment. The named owner can still release an expired claim. If you
have established that it is appropriate to take over, record that decision:

```sh
holt ownership claim my-worktree --owner recovery-session --takeover --reason "Previous session was stopped and its work reviewed"
```

Then continue working or release the recovered claim. The same explicit recovery path handles a
malformed lease record. An unreadable store reports the specific access problem.

An internal Holt operation can also briefly hold a mutex. That native lock releases if the Holt
process crashes; it does not expire or release the session's separate claim. Lease records and
mutex files stay in private Git administration storage, outside working files and the audit log.

Claims coordinate participating sessions sharing one local Git common directory. They do not
detect arbitrary agents, coordinate independent hosts, or prevent someone from bypassing Holt
and forcibly overriding Git's locks.
