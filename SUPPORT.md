# Support

Holt is supported through the public
[GitHub issue tracker](https://github.com/Raed2180416/holt/issues) on a best-effort basis. There is
no guaranteed response, resolution timetable, or contractual support SLA. Please search existing
issues before opening a new one.

Use the official stable install source unless you are deliberately testing a source checkout:

```bash
npm install -g https://github.com/Raed2180416/holt/releases/latest/download/holt.tgz
holt --version
```

For a reproducible report, include the exact command and redacted output, Holt/Node/Git versions,
operating system and architecture, shell, agent host (if relevant), and whether the repository uses
linked worktrees, jj workspaces, submodules, a shallow/partial clone, network storage, or symlinked
paths. `holt doctor --json` can help; `holt audit --json` is relevant to package-integrity reports.
Review both outputs before posting because paths, usernames and environment details may be private.

Do not post credentials, licence tokens, proprietary source, or private repository contents.
Report suspected vulnerabilities through
[GitHub Security Advisories](https://github.com/Raed2180416/holt/security/advisories/new) as described
in [SECURITY.md](SECURITY.md).

The issue tracker is not an emergency recovery service. Preserve the affected repository and Git
metadata, avoid destructive cleanup, and make a separate backup before experimenting with a
workaround.
