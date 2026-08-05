# holt — supply-chain evidence

Everything on this page is something **you** can check, on the copy you installed, without
contacting the vendor and mostly without a network. That is the point: a vendor's assurance about a vendor's
CI is a claim. Evidence you can re-run is not.

```
holt audit                 # integrity + every capability this installation holds   (offline)
holt audit --json          # the same, machine-readable, exit 1 on any failure
```

---

## 1. Verify what you installed

### 1a. Integrity — offline, no network, no account

```console
$ holt audit
# prints this installation's version, file count and tree digest,
# then reports each integrity and capability check by name
```

`MANIFEST.sha256` ships inside the package and lists a SHA-256 for every other shipped file.
`holt audit` recomputes all of them. A modified file, a deleted file, an **added** file, a
missing manifest or an unparseable one are each a **failure with a non-zero exit code** — never a
pass with a note. The manifest cannot cover itself; that is what §1b is for.

The **tree digest** is one SHA-256 over the whole manifest. It is the single number to compare
against an attestation, to paste into a ticket, or to diff between two machines that are supposed
to be running the same thing.

### 1b. Authenticity — who built this, from which commit

Integrity says the bytes are self-consistent. It cannot say who produced them. When a release
actually carries a Sigstore provenance attestation, that separate artifact can bind the package to
a workflow and commit without a long-lived signing key in this repository:

```console
# The published tarball, verified against the workflow and commit that built it
$ HOLT_RELEASE_VERSION=X.Y.Z   # replace with the release you are evaluating
$ gh release download --repo Raed2180416/holt --pattern "holt-${HOLT_RELEASE_VERSION}.tgz"
$ gh attestation verify "holt-${HOLT_RELEASE_VERSION}.tgz" --repo Raed2180416/holt
```

`gh attestation verify` prints the repository, the workflow file, the commit SHA and the runner
that produced the artefact. If any of those is not what you expect, the package is not ours,
whatever the version number says.

**Need offline artifact verification?** Download the attestation bundle on a connected machine
and carry it in:

```console
$ gh attestation download "holt-${HOLT_RELEASE_VERSION}.tgz" --repo Raed2180416/holt
$ gh attestation verify "holt-${HOLT_RELEASE_VERSION}.tgz" --repo Raed2180416/holt \
    --bundle sha256:<digest>.jsonl --custom-trusted-root trusted_root.jsonl
```

Offline verification with `--bundle` has known rough edges in some `gh` versions
([cli/cli#10059](https://github.com/cli/cli/issues/10059)). If it fails for you, §1a still works
with no network at all. The release key is pinned, and `holt audit --require-signature` is the
fail-closed **offline artifact-verification** path: an unsigned, invalidly signed, or differently
signed package is refused — see §5. This does not by itself provide a complete air-gapped
operating model: customer-controlled offline licence issuance, removable-media managed-policy
updates, dependency/update mirrors, and offline support procedures remain separate unshipped
Enterprise work.

---

## 2. SBOM

The release workflow generates two formats with `npm sbom`, reading the lockfile npm resolved.
Check the assets attached to the release you are evaluating; this document describes the workflow,
not evidence that a particular release completed it.

| file | format | why it is here |
|---|---|---|
| `holt.cdx.json` | **CycloneDX 1.5** (ECMA-424) | **primary.** Native VEX support, the format security tooling — Dependency-Track, Snyk, Trivy, Grype — ingests best, and the one CRA-aligned tooling has standardised on. |
| `holt.spdx.json` | **SPDX 2.3** (the ISO/IEC 5962:2021 lineage) | for procurement and licence-compliance workflows that require SPDX by policy. |

Both, rather than one, because the marginal cost is a second `npm sbom` invocation and the
alternative is an argument with whichever reviewer wanted the other one.

### What the SBOM says, and the trap it avoids

Holt has **three exact direct runtime dependencies**: `@modelcontextprotocol/sdk@1.30.0`,
`jsonc-parser@3.3.1`, and `tuf-js@6.0.0`. They back advertised product surfaces—MCP, structural
JSONC edits/strict policy parsing, and authenticated managed-policy delivery—so an install cannot
silently omit them while still presenting itself as complete. Node `^22.22.2`, `^24.15.0`, or
`>=26.0.0` and Git 2.45+ remain product prerequisites. Use the SBOM actually attached to a release
for its complete transitive component count.

`jscpd@5.0.14` is the sole `optionalDependency`, used only by `holt duplicates --deep`. If your
policy is to minimise third-party code and you do not need token-clone analysis:

```console
$ HOLT_CORE_PREFIX=/an/absolute/path/outside/your/checkout
$ npm install --omit=optional --prefix "$HOLT_CORE_PREFIX" https://github.com/Raed2180416/holt/releases/latest/download/holt.tgz
$ "$HOLT_CORE_PREFIX/node_modules/.bin/holt" doctor
```

This retains the CLI, MCP, host integration and managed-policy surfaces; only deep token-clone
analysis is absent. `holt doctor` reports that backend as unavailable, and `holt duplicates --deep`
labels the missing backend instead of turning an ordinary scan into a startup failure.

CI has a dedicated optional-omission job and a packaged-artifact proof that installs into a fresh
non-global prefix, asserts every declared optional package root is absent and unresolvable, and
only then drives the product smoke against that exact installed binary. The isolated shape is
intentional: npm 10 global installs have been observed to retain optional packages despite
accepting `--omit=optional`. Inspect the run for the commit or release under review rather than
inferring a green result from the workflow file. Use the ordinary install without
`--omit=optional` when you want `duplicates --deep`. On Windows, invoke the corresponding `.cmd`
shim under `node_modules/.bin`.

### Required Git runtime

Holt requires **Git 2.45 or newer** and probes the selected executable before any repository Git
command. The floor is functional, not cosmetic: the official [git(1)
documentation](https://git-scm.com/docs/git) defines `--no-lazy-fetch` (equivalent to
`GIT_NO_LAZY_FETCH=1`) as preventing an on-demand fetch of a missing object from a promisor remote.
Holt needs that boundary so a supposedly local evidence read cannot silently become a network
operation. A modern-looking vendor version is not accepted on its label alone; the option is
probed too. `holt doctor --json` reports `git.version`, the `>=2.45.0` requirement, and whether the
capability was verified. Install or upgrade from the official [Git
downloads](https://git-scm.com/downloads).

CI and release verification run `scripts/check-git-runtime.mjs` before Holt tests on Ubuntu,
macOS and Windows. The Windows run also plants a real pre-commit hook, proves it executes, then
proves Git for Windows treats Holt's documented `core.hooksPath=/dev/null` setting as inert. This
is runtime evidence for that release job, not a claim about an untested Git distribution.

> `npm sbom` run plainly on a developer machine describes **node_modules as installed**, which on
> a machine that ran `npm ci` includes the development tree. `scripts/gen-sbom.mjs` passes
> `--package-lock-only --omit dev` and
> **fails the build** if a dev-only package appears, if any component lacks a purl, or if the
> version disagrees with `package.json`. An SBOM that describes the wrong tree does not just fail
> to help — it generates vulnerability tickets against software the vendor does not ship.

---

## 3. Build provenance

| property | status |
|---|---|
| SLSA version | v1.0 build track |
| **Configured target** | **SLSA Build L2** — the workflow requests GitHub artifact attestation from a GitHub-hosted runner. Configuration is not an attestation; verify the release artifact itself. |
| Build L3 | **Not claimed.** The current single-repository workflow has no retained proof that it meets the current hardened-build requirements. Move build/provenance generation behind an appropriately isolated reusable workflow and assess the resulting builder against the [SLSA Build L3 requirements](https://slsa.dev/spec/v1.2/build-track-basics) before changing this row. |
| Predicate | SLSA Provenance v1 in an in-toto Statement |
| Transparency log | Sigstore public-good instance (Rekor) |
| Release attestation | Workflow configured for GitHub artifact attestation; verify the downloaded release with `gh attestation verify` rather than assuming the asset is present. v0.3.0 has no discoverable attestation or attached SBOM assets. |

The published level is what can be defended. A vendor claiming L3 from a plain workflow is telling you
they have not read the specification, which is itself a useful signal about the rest of their
answers.

### Live release-control plane

The repository controls below were observed through GitHub's authenticated API on
**2026-08-05 04:39 +05:30**. They are live state, not properties of a commit, and can drift. The
sanitised response summary and its digest are retained in
[`docs/evidence/release-ci/release-controls-20260805.json`](docs/evidence/release-ci/release-controls-20260805.json).

| control | observed state | boundary |
|---|---|---|
| Immutable releases | **Enabled** for `Raed2180416/holt`; the release workflow also calls GitHub's live immutable-release endpoint before checkout or repository code | This does not make an untagged working tree immutable or retroactively add attestations to v0.3.0. [GitHub documents](https://docs.github.com/en/enterprise-cloud@latest/rest/repos/repos#check-if-immutable-releases-are-enabled-for-a-repository) the read check as requiring repository Administration read. |
| Release environment | `release` exists with a selected **tag** policy `v*`; only jobs naming that environment receive its secrets | This is a ref restriction, not a claim of human approval: the API reports no required-reviewer rule and reports administrator bypass enabled. [GitHub's environment documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments) distinguishes tag rules, reviewers and administrator bypass. |
| Environment secrets | Names `HOLT_RELEASE_ADMIN_TOKEN` and `HOLT_RELEASE_SIGNING_KEY` exist | GitHub never returns secret values. Existence is not proof that a future job can use them; the release workflow fails closed on absence, API failure, wrong key type or a signing-key mismatch. |
| Release signing key | One Ed25519 public key is pinned; its SPKI SHA-256 fingerprint is `fdc0f121ca21f23a6ae7d448f4cbb7f16a6c214d4bfae855f380cc54b4e170d8`. The locally retained private half derives the same fingerprint and is mode `0600`. | No private material is retained in this repository or the evidence artifact. The environment secret cannot be read back; the first successful release job must re-prove the match before signing. |
| Immutable-state reader token | The environment secret currently contains the maintainer's existing GitHub OAuth credential. Its observed scopes are `repo`, `workflow`, `read:org` and `gist`. | That is broader than the one API read. Rotate it to a fine-grained token or GitHub App token limited to this repository with **Administration: read**, following GitHub's [fine-grained-token permission reference](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens). Never print or retain the token value. |

---

## 4. What holt reads, writes and sends

The installed audit checks in-process primitives, declared external binaries and selected
documentation assertions against the package bytes. It cannot infer what a child executable does
after launch, so its machine-readable statement separately declares both confirmed child-process
install paths and what they can do.

### Sends — two explicit in-process paths, and only when you ask

| when | to where | what is sent |
|---|---|---|
| `holt setup`, or `holt doctor --install` | `https://github.com/universal-ctags/...` | An unauthenticated GET of a pinned public release asset. No request body, query string, credential or repository identifier is added; normal HTTPS request metadata still exists. The response is checked against a SHA-256 pinned in `src/toolchain.mjs` and refused on mismatch. Avoid it entirely by installing `universal-ctags` yourself. |
| `holt managed-policy sync` | administrator-supplied credential-free TUF metadata and target base URLs | Bounded GETs for signed TUF roles and the fixed `policy.json` target. Holt adds only a fixed user-agent: no body, query, URL credential, cookie, licence, environment value, repository content or repository identity. Redirects outside the supplied bases refuse; TUF verifies root rotation, expiry, delegation, hashes and lengths before crash-safe activation. Ordinary CI, hooks, MCP, status and policy evaluation never reach this path. |

### Indirect setup paths, stated because a true sentence can still mislead

After confirmation, `holt setup` and `holt doctor --install` can launch two classes of child tools
that may reach the network:

1. **Your package manager** — `apt-get` / `dnf` / `pacman` / `brew` / `winget`, prefixed with
   `sudo` on Linux where required, to install `universal-ctags` or `ripgrep`.
2. **Go's installer** — `go install github.com/go-enry/go-enry/v2/cmd/enry@v2.9.6` when Go is
   present and enry is missing. The exact upstream version is fixed rather than selected through
   `@latest`; Go may download its module/build dependencies, applies the operator's configured
   proxy/checksum policy, and writes the result to Holt's private bin directory via fixed `GOBIN`.
   Holt runs the binary before reporting success.

Both happen only after Holt prints the command and requires you to type `y` (or pass `--yes`). The
package-manager path says when it needs sudo; it is the only declared setup path that elevates
privilege. Analysis, scan, hook, MCP and Git action paths do not request elevation.

The indirect paths are disclosed here because a true sentence can still mislead: `sh` was
described as "backend probes and `holt verify --run`" and stopped there — every word true, and the
reader would still have finished the paragraph with a wrong picture. `holt audit --json` reports
both under `statement.indirectNetwork`.

No telemetry. No analytics. No crash reporting. No update check. **No licence call-home** —
entitlement is an offline Ed25519 signature check (`src/license.mjs`). Normal analysis and policy
enforcement can therefore run without egress, and a licence cannot be revoked remotely (short
expiry substitutes for live revocation). Customer-controlled offline licence issuance and a
signed removable-media managed-policy update workflow are not shipped yet.

Two independent things make that checkable rather than promised:

- **The capability ledger.** Every shipped file is classified by what it can reach —
  `network`, `process`, `eval`, `filesystem`. Exactly two files hold `network`: the setup downloader
  and explicit managed-policy TUF adapter above. Adding `import net from 'node:net'`, a bare
  `require('https')`, a dynamic `import('node:http')`, `globalThis.fetch`, or a bare `fetch(`
  anywhere else fails the audit.
- **Holt does not invoke network Git verbs.** `fetch`, `push`, `pull`, `clone`, `ls-remote`,
  `remote`, `submodule`, `daemon`, `credential`, the `http-*` helpers, `p4` and `svn` are outside
  its argv allowlist, with and without mutation opt-in. That statement does not neutralise a
  repository or user-configured clean filter, fsmonitor hook or other Git extension; such child
  processes execute under the user's Git configuration and may have their own network behaviour.

### Executes

`git`, and — only if present and only for the feature that needs them — `jj`, `ctags`, `enry`,
`rg`, `jscpd`, `tar`, `sh`, `holt`, `go`, `mount`, `where`. Every one is listed in `holt audit --json`
under `checks[].detail`, including the call sites where the executable is a **variable** rather than a
literal, which is the half a string scan cannot see.

Three of those are worth stating plainly rather than burying:

- **`holt verify --run "<cmd>"` executes the command you give it.** That is the feature: it runs
  *your* test suite against a speculative merge. It runs nothing you did not type.
- **`sh -c "command -v <tool>"`** is used to probe for optional backends. On Windows, `where <tool>`
  is used instead (it is the Windows equivalent of `command -v`).
- **`go install github.com/go-enry/go-enry/v2/cmd/enry@v2.9.6`** is offered by `holt setup` when Go
  is available and enry is missing. It is exact-versioned, human-confirmed and network-capable;
  install enry through your own approved toolchain to avoid that path. `mount` is used on macOS/Unix to detect network filesystems (NFS/SMB/SSHFS)
  for timeout escalation. On Windows, `powershell` `-Command Expand-Archive` extracts the ctags zip
  (listed as a dynamic call site in `bin/install-ctags.mjs`, after checksum verification).

### Reads

The Git repository you point it at; project policy and host configuration; its licence, data and
cache paths; selected environment variables listed below; and the explicit inputs supplied to
commands such as `verify` and journal export.

### Writes

Read-only analysis does not modify tracked working-tree files. Some analysis plumbing may create
an unreferenced Git object via `merge-tree --write-tree`; Git garbage collection can reclaim it,
and `--strict-read-only` disables that path. Acting commands intentionally write locks, refs,
journal state or host configuration and print those changes.

Documented write targets include:

| path | put there by | notes |
|---|---|---|
| `$XDG_CONFIG_HOME/holt/license` | `holt license activate` | mode 0600, opened `O_NOFOLLOW` |
| `$TMPDIR` / `HOLT_TMPDIR` | scans, hooks, symbol/deep analysis and `verify` | scan/hook caches, changed-brief state, temporary indexes and command-owned scratch; best-effort cleanup where applicable |
| the Git object database | merge analysis, rescue and discard | analysis may leave one unreferenced `merge-tree --write-tree` object unless `--strict-read-only`; capture actions write verified blobs/trees/commits before refs |
| `$GIT_COMMON_DIR/holt/journal.jsonl`, `checkpoint`, integration receipts and sink cursors | mutating actions, integration and Team sink | journal line precedes its Merkle checkpoint; ownership/cursor state is kept outside working-tree files |
| `refs/holt/rescue/*`, `refs/holt/discard/*` | `rescue`, `discard` | verified capture refs created before release/removal |
| Git worktree administrative lock state | `protect`, `unprotect`, `auto`, `rescue --release` | Holt records which locks it placed and does not silently release a foreign lock |
| registered worktree paths and private worktree admin state | `clean --apply`, `restore`, `purge --apply` | clean moves to same-filesystem locked quarantine; restore moves back; purge re-verifies and uses non-forced Git removal |
| explicit working-tree paths | `discard` | rename-to-quarantine is first; untracked content is removed only after verified capture and tracked content is restored to HEAD |
| landed local branch refs and recovery anchors | `branches --apply`, `purge` | branch cleanup uses `git branch -d`, never `-D`; recovery reachability is retained |
| `$HOLT_HOME` (or `$XDG_DATA_HOME/holt`) | `holt setup` | private ctags and/or enry binaries; ctags is checksum-verified, enry is exact-version Go-built and run-verified |
| the path you pass to `--html` | `holt graph --html <file>` | you named it |
| the sink path you pass to `journal --sink`, plus `<sink>.checkpoint` | Team sink | explicit destination; sink output is refused when the source journal does not verify; one-shot `journal --export` writes stdout |
| project agent/rule/MCP/hook files and Holt's Git pre-commit block | `holt integrate` / `uninstall` | structurally merges/removes only Holt-owned content and retains foreign content |
| supported existing user host-config files | `holt integrate --global` / `uninstall --global` | explicit opt-in, existing-only MCP merge; Holt does not create a new user config solely because `--global` was passed |
| `/etc/holt/managed-policy` or the explicitly selected user managed-policy store | `holt managed-policy enroll`, `sync`, `recover` | fixed root-owned system authority or explicit non-system user authority; immutable authenticated generations, exclusive lock, fsync/atomic activation and explicit crash recovery |

### Environment variables read

`AI_AGENT`, `APPDATA`, `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_HOST_SESSION_ID`,
`COMSPEC`, `CURSOR_TRACE_ID`, `GITHUB_HEAD_REF`, `GITHUB_WORKSPACE`, `HOLT_ACTOR`, `HOLT_ACTOR_SESSION`,
`HOLT_AUDIT_SIGNER`, `HOLT_AUDIT_SIGNING_KEY`, `HOLT_CTAGS_OPTIONS`, `HOLT_HOME`,
`HOLT_HOOK_FAIL_OPEN`, `HOLT_LICENSE`, `HOLT_TMPDIR`, `HOME`, `HOMEDRIVE`, `HOMEPATH`,
`JJ_CONFIG`, `LOCALAPPDATA`, `LOGNAME`, `NO_COLOR`, `OPENCODE`, `OPENCODE_SESSION_ID`, `PATH`,
`PATHEXT`, `SYSTEMROOT`, `TEMP`, `TERM`, `TMP`, `TMPDIR`, `USER`, `USERPROFILE`, `USERNAME`,
`WINDIR`, `XDG_CONFIG_DIRS`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`.

These values are not transmitted by analysis, journalling, licensing or telemetry (there is no
telemetry path), and they are not added to either explicit in-process request. The bundled Action
has two declared computed read sites for its fixed `INPUT_*` labels; any additional computed read
(`process.env[name]`, including through a recognised alias) fails the audit rather than inheriting
a wildcard exemption.

---

## 5. Remaining release-control gaps

Stated here rather than omitted, because a security page that lists only what is done is not a
security page.

| gap | what it needs | who must do it |
|---|---|---|
| **Least-privilege immutable-state token** — the required environment secret exists and was populated from the maintainer's broader OAuth credential, which can read the API. GitHub does not permit read-back of the stored value. | Replace `HOLT_RELEASE_ADMIN_TOKEN` with a repository-scoped fine-grained PAT or GitHub App token granting only **Administration: read**. Re-run the preflight, then revoke the broader credential from this use. | repository owner |
| **Signing-key custody and first live proof** — the environment secret exists and the retained private half matches the pinned public fingerprint, but GitHub does not permit secret read-back and no published release proves this new configuration yet. | Assign backup/rotation ownership, protect the private-key backup, and require the first release job plus `holt audit --require-signature` on its downloaded tarball to prove the configured secret. Never commit the private key. | repository owner |
| **Environment approval policy** — the `v*` tag policy is live, but administrators can bypass environment protection and no required-reviewer rule is present. | Decide whether to disable administrator bypass and/or add required reviewers. Record that governance choice without describing the current tag restriction as a human approval. | repository owner |
| **SLSA Build L3** | Use and assess a hardened builder that satisfies the current L3 isolation and provenance-key requirements; an appropriately isolated reusable workflow is part of that migration. | maintainers |

Generating the pair, for the record — run it on a machine you trust and never commit the private
half:

```console
$ openssl genpkey -algorithm ed25519 -out holt-release.pem
$ openssl pkey -in holt-release.pem -pubout -outform DER | base64 -w0   # -> RELEASE_PUBLIC_KEYS_B64
```

---

## 6. Reporting

Security reports go through
[GitHub Security Advisories](https://github.com/Raed2180416/holt/security/advisories/new).
Acknowledgement within 72 hours, substantive reply within 7 days. See `SECURITY.md` for scope,
and `docs/SECURITY-QUESTIONNAIRE.md` for the vendor-review answers a procurement team will ask
for.

**If you observe a Holt-owned runtime path transmit repository data, or an in-process network call
outside the two explicit paths described in §4, report it as a vulnerability.** Child tools
launched through the disclosed, confirmed setup paths have their own network behaviour.
