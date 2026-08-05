# holt — vendor security questionnaire

Pre-filled answers to what a security review actually asks, in the order the standard
questionnaires (SIG Lite, CAIQ v4, and most bespoke vendor forms) ask it. Copy the relevant rows
into whatever form you have been handed.

Answers below distinguish runtime structure, explicitly approved setup behaviour and commercial
operations. `holt audit` checks the installed package's declared capabilities; it does not turn a
roadmap item, draft contract or unverified release process into a current assurance.

- Product: **holt** — a local CLI, MCP server, git hooks and TUI for relating work across parallel
  agent worktrees.
- Deployment model: **analysis and enforcement run on the developer's machine and in customer CI;
  there is no hosted analysis tenant or repository-data service.** A separate commercial service
  handles checkout, licence issuance and delivery without receiving repository data.
- Last reviewed: see `git log -1 -- docs/SECURITY-QUESTIONNAIRE.md`. Selected supply-chain
  assertions are checked by `test/unit/supply-chain.test.mjs`; that suite is not evidence that
  every sentence in this questionnaire is continuously verified.

---

## 1. The five questions that usually end the review

| # | Question | Answer |
|---|---|---|
| 1 | Does the product transmit customer data anywhere? | **Repository analysis, actions, journalling and licence verification do not.** The package has two in-process network paths: a confirmed pinned `universal-ctags` download, and an explicit Enterprise `managed-policy sync` to administrator-supplied credential-free TUF bases. Neither adds repository content or identity. Setup also has two confirmed child-process paths: a package manager and exact-versioned `go install github.com/go-enry/go-enry/v2/cmd/enry@v2.9.6`. All four are declared in `holt audit --json`; see `SUPPLY-CHAIN.md` for request shapes and boundaries. |
| 2 | Does it phone home for licensing? | **No.** An issued entitlement is checked offline with Ed25519 against a compiled-in public key. Normal runtime verification works without egress. Customer-controlled offline issuance/renewal and a signed removable-media managed-policy update workflow are not shipped yet; expiry substitutes for live revocation. |
| 3 | Does it require credentials or cloud access? | **No.** No account, no OAuth, no API key. The only secret it can hold is a licence token, stored at `$XDG_CONFIG_HOME/holt/license`, mode `0600`, opened `O_NOFOLLOW`. |
| 4 | Can it modify or destroy source code? | **Only through explicit acting commands/options and installed host hooks.** Core analysis cannot reach destructive Git verbs; scan plumbing may create an unreferenced merge-tree object unless `--strict-read-only` is used. `clean --apply` is mutating but non-destructive: it atomically moves a complete registered worktree into locked local quarantine, retains the branch and returns restore argv. `rescue`, `discard`, `branches --apply`, integration and setup state their different writes. The mutation suite deliberately weakens the boundary and requires the relevant tests to fail. |
| 5 | What is the blast radius if the vendor is compromised? | The distributed package and commercial contact/licence systems. There is no hosted analysis service or self-update channel. `holt audit` checks package integrity/capabilities after installation; `gh attestation verify` can authenticate a release artifact before you install it when a matching attestation is present. |

---

## 2. Data handling

| Question | Answer |
|---|---|
| What customer data is collected? | **The installed product collects no repository or usage data.** No telemetry, analytics, crash reporting, usage metrics or update check. The separate purchase/support process holds the billing and contact data described in `legal/PRIVACY.md`. |
| What data is processed, and where? | Your Git repository, on the machine Holt runs on. Repository-derived data may be printed or written to the explicit local paths described below, but is not transmitted to Holt or an analysis service. Approved setup tools have separate network behaviour and do not receive repository content from Holt. |
| Is source code sent to a third party or an LLM? | **No.** holt contains no model, no inference call and no AI provider integration. It is the tool that *watches* agents; it is not one. |
| Data at rest | Depending on the command used, holt may create a JSONL journal and checkpoints under `$GIT_COMMON_DIR/holt`, Git worktree locks, locked clean-quarantine directories and transition markers, rescue/discard refs, project-scoped host configuration, managed-policy state under `/etc/holt/managed-policy` (or an explicitly selected user store), an optional locally installed tool, explicit graph/export files and the licence file. All remain on customer-controlled storage. Read-only analysis does not silently create those action artifacts. |
| Data retention / deletion | The vendor retains no repository/usage data. `clean --apply` does not reclaim disk: quarantined worktrees remain registered, local, locked and branch-reachable until explicitly restored or otherwise handled by the customer. Other local removal may require uninstalling project host config and deleting journal/checkpoint state, Holt-managed locks/refs, optional tool data and the licence file. Commercial billing/support retention is described separately in `legal/PRIVACY.md`. |
| PII | Git commit identity may already exist in repository history. For local journal attribution, holt also reads selected host/session variables or hook payload fields such as `AI_AGENT`, `CLAUDECODE`, `CURSOR_TRACE_ID`, `HOLT_ACTOR` and `HOLT_ACTOR_SESSION`. They are recorded locally as reported/inferred/unknown and are not transmitted. The complete declared list is in `SUPPLY-CHAIN.md` and `holt audit --json`. |
| Sub-processors | For the installed product: **none.** The commercial path is designed to use Stripe for payment, Resend for licence-delivery email, and the configured licence-service host. Resend receives the recipient address and message content, including the licence token. None is in the repository-analysis path. Confirm deployed providers, entities and regions before relying on this answer contractually. |
| Cross-border transfer | Not applicable to repository analysis because there is no repository-data transfer. Commercial contact/payment processing may involve the sub-processors and regions disclosed in `legal/PRIVACY.md`. |

---

## 3. Access, authentication, cryptography

| Question | Answer |
|---|---|
| Authentication model | Holt has no hosted user session. It runs as the local OS user. The shipped Enterprise managed-policy authority authenticates signed policy metadata to an administrator-enrolled TUF root and binds one single-purpose runner to one root-enrolled persistent Linux workspace path/device/inode plus an administrator-asserted assignment label; Holt does **not** authenticate that label from a Git remote or CI environment. Store presence makes any other path or additional system profile a refusal, not an exemption. It is not SSO. GitHub-hosted/ephemeral checkout identity would require a provider-attested adapter such as verified OIDC, which is not shipped. |
| Authorisation model | OS permissions, local Git authority, signed feature entitlement, and—when explicitly enrolled—additive managed-policy rules. The entitlement remains a licensing control rather than a security boundary (see §7). SSO and SCIM are not shipped. |
| Cryptography in use | Ed25519 (licence and release-manifest signatures), SHA-256 (integrity), and the signature schemes permitted by each customer's enrolled TUF root for managed policy. Holt and `tuf-js` use Node's `node:crypto`/OpenSSL; Holt implements no custom cryptographic primitive. |
| Key management | The repository contains only public verification keys. Licence signing requires an externally supplied private key; rotation uses the newest-first `LICENSE_PUBLIC_KEYS_B64` list. Release-manifest signing uses a separate Ed25519 key in the `release` environment. On 2026-08-05 the retained private half derived the pinned public SPKI fingerprint `fdc0f121ca21f23a6ae7d448f4cbb7f16a6c214d4bfae855f380cc54b4e170d8`; no private material is retained here. GitHub does not expose environment-secret values, so a successful release job and downloaded-artifact verification remain required evidence. |
| Secrets in the package | The package-content and supply-chain tests search for private-key and server material and are intended to fail if found. Verify the specific tarball and manifest; a scanner is not a proof that no possible secret shape exists. |
| Signature verification hardening | The signature covers the transmitted payload **string**, never a re-serialised object (the classic canonicalisation hole). A token cannot nominate its own verification key. The tier prefix in a token is a human convenience and is rejected if it disagrees with the signed payload. |

---

## 4. Supply chain

| Question | Answer |
|---|---|
| SBOM | The release workflow is configured to generate CycloneDX 1.5 (ECMA-424) and SPDX 2.3 with `npm sbom`. Verify that both assets are attached to the specific release under review; v0.3.0 did not include them. See `SUPPLY-CHAIN.md`. |
| Runtime dependencies | Three exact direct runtime dependencies: `@modelcontextprotocol/sdk@1.30.0`, `jsonc-parser@3.3.1`, and `tuf-js@6.0.0`, plus their locked transitive graph. `jscpd@5.0.14` is optional and serves only `duplicates --deep`. Node `^22.22.2`, `^24.15.0`, or `>=26.0.0` and Git 2.45+ are prerequisites. Git 2.45 provides the `--no-lazy-fetch` boundary Holt probes before repository operations; `holt doctor --json` reports the selected version and capability. Inspect the SBOM and optional-omission job for the exact release rather than inferring a green run from this document. |
| Build provenance | The workflow is configured for SLSA v1.0 **Build L2** provenance from a GitHub-hosted runner. Verify the actual release with `gh attestation verify`; workflow configuration alone is not an attestation. L3 is **not** claimed. |
| Signed releases | GitHub currently reports immutable releases enabled and a `release` environment restricted to tags matching `v*`. Environment-secret names `HOLT_RELEASE_SIGNING_KEY` and `HOLT_RELEASE_ADMIN_TOKEN` exist. Detached Ed25519 signing of `MANIFEST.sha256` is fail-closed, and the workflow requests GitHub artifact attestations. This is control-plane configuration, not proof about an artifact: verify the actual downloaded release with `holt audit --require-signature` and `gh attestation verify`. v0.3.0 predates these assurances. |
| Release credential scope | The immutable-state preflight needs only repository **Administration: read**. The environment currently holds the maintainer's broader GitHub OAuth credential (`repo`, `workflow`, `read:org`, `gist` observed); rotation to a repository-scoped fine-grained PAT or GitHub App token is an open least-privilege item. No token value is retained in evidence. |
| Can a customer verify an installed copy? | Yes, offline: `holt audit`. It re-hashes every shipped file against `MANIFEST.sha256` and re-proves the capability ledger — no network, no repository, no account needed. |
| Dependency-confusion / typosquat exposure | holt is distributed from this repository's GitHub releases only — not from the npm registry — so there is no public package name to squat. Provenance ties every release to this repository and commit. |
| Post-install scripts | **None.** The package defines no `postinstall`, `preinstall` or `install` script. |
| Third-party binaries | Optional and never bundled: `ctags`, `enry`, `rg`, `jj`, `jscpd`. `holt setup` can download a pinned static `universal-ctags` and refuses it on a SHA-256 mismatch, launch a confirmed package-manager command, or run exact-versioned `go install github.com/go-enry/go-enry/v2/cmd/enry@v2.9.6`. `mount` is used on macOS/Unix for network-filesystem detection; `where` probes tools on Windows. Installing approved backends yourself avoids the setup network paths. |
| Vulnerability disclosure | GitHub Security Advisories; 72-hour acknowledgement, 7-day substantive reply. `SECURITY.md`. |

---

## 5. Secure development lifecycle

| Question | Answer |
|---|---|
| Test coverage of security-relevant behaviour | The refusal layer, entitlement path, destructive-command guards and supply-chain audit have dedicated suites. CI is configured with Linux, macOS and Windows jobs, but coverage differs by job; verify the exact release run rather than reading this as an all-tests-on-all-platforms claim. |
| Do the tests actually detect defects? | `npm run test:mutation` injects deliberate defects — an entitlement check that grants everything, a licence that never expires, a webhook that skips signature verification, a supply-chain audit blind to `fetch()`, and an integrity check that reports a **missing** manifest as verified — and fails if a mutation survives. A score is publishable only from a complete successful run. |
| Code review | Contributions carry DCO checks. Review status for a specific release should be established from that release's Git history and pull requests rather than inferred from this questionnaire. |
| Static analysis | `holt audit` scans the whole shipped package, including `bin/`, and fails if an in-process network primitive appears outside the two declared files or if either declaration has no implementation behind it. It separately inventories external binaries, computed environment reads and indirect child-process network paths. This is a deliberately bounded static instrument, not a claim of formal whole-program verification. |
| Dependency scanning | When present, the CycloneDX/SPDX SBOMs can feed a customer-selected scanner. Holt's three required direct packages, their transitive graph, the optional deep-clone package, and non-npm prerequisites all need normal review. |
| Change management for the published artefact | A valid provenance attestation can bind one release artifact to a commit and workflow. Verify that the specific release actually has one; v0.3.0 has no discoverable attestation. |
| Penetration testing | The repository contains adversarial automated tests for token forgery, webhook replay, payment-event confusion, terminal-escape injection, rate limiting and secret handling. No third-party penetration-test report exists. Automated regression tests are not presented as a pentest. |

---

## 6. Operational / business continuity

| Question | Answer |
|---|---|
| Availability dependency | Repository analysis is local and has no vendor-service dependency. Free single-repository features continue if the vendor is offline; paid entitlements verify offline only until their signed expiry plus the implemented grace period. |
| What happens if the vendor disappears? | The tool continues to run. Licences keep verifying until expiry, plus a 14-day grace period, with no server involved. The free tier is the whole single-repo product and is unaffected by any licence state. |
| Backup / DR | The local product holds no vendor-side repository data to restore. Continuity and retention for commercial contact/licence records depend on the payment, mail and licence-service systems described in the privacy policy and applicable agreement. |
| Incident response | GitHub Security Advisories is the disclosed private reporting channel. Verify remediation status, fixed version and release digest for the specific incident. |
| Support | Public issue tracker. No contractual support SLA is offered today. |

---

## 7. The honest caveats

Reviewers find these anyway. Finding them here first is cheaper for everyone.

1. **The entitlement check is tamper-evident, not tamper-proof.** The source is public and anyone
   can patch the check out. Without the corresponding private key, editing a signed payload makes
   verification fail under the implemented Ed25519 check. Patching the check itself remains
   possible and is a licensing matter, not a product security boundary.
2. **`holt audit` runs inside the package it audits.** An attacker who can rewrite the installed
   files can also rewrite the audit. It detects the realistic threat — a substituted or modified
   package that hopes nobody looks — and it does not defend against an attacker who already owns
   the machine. Pair it with `gh attestation verify`, which is signed outside the package.
3. **`holt verify --run "<cmd>"` executes code.** That is the feature; it runs *your* test suite
   against a speculative merge. It runs nothing you did not type, and no analysis path can reach
   it.
4. **A git lock is not a filesystem permission.** `holt protect` uses git's own worktree lock. It
   defeats `git worktree remove --force`; it does not defeat `rm -rf`, and `git worktree unlock`
   is git's documented escape hatch. Where a host hook layer exists, holt denies those too.
5. **`holt setup` can download or install tools.** The direct ctags download is URL/hash pinned and
   refuses on mismatch. The confirmed package-manager path and exact-versioned Go installer are
   separate indirect network paths. Install approved backends yourself and decline setup install
   prompts to avoid them.
6. **No third-party pentest report and no SOC 2 report exists.** This document does not imply
   otherwise. Repository analysis has no hosted service or repository-data egress, while checkout,
   licence issuance and email are separate commercial services. The installed package can be
   inspected locally; that is evidence of a different kind, not a substitute certification.
7. **SLSA Build L2, not L3.** L3 needs a reusable workflow. It is on the list and it is not
   claimed today.
8. **Confirmed setup child processes need separate review.** `holt doctor --install` can run a
   package manager, with `sudo` on Linux; `holt setup` can run
   `go install github.com/go-enry/go-enry/v2/cmd/enry@v2.9.6`. Both print and require confirmation,
   and both appear in `statement.indirectNetwork`. No analysis, scan, hook, MCP or Git action path
   requests privilege elevation.
9. **Configured release controls are live state, not an artifact property.** The 2026-08-05 API
   snapshot reports immutable releases enabled, a `release` environment restricted to `v*` tags,
   and the two required secret names. Administrators can currently bypass environment protection,
   no required-reviewer rule is present, and the admin-read secret uses a broader OAuth credential
   pending rotation. GitHub does not allow secret read-back; only a successful release and
   independent verification prove that a particular artifact was signed and attested.

---

## 8. Evidence index

| Artefact | Where |
|---|---|
| Verification instructions | `SUPPLY-CHAIN.md` |
| Vulnerability disclosure policy | `SECURITY.md` |
| Capability declaration (what holt reads/writes/executes/sends) | `src/supply-chain.mjs`, and `holt audit --json` on your own machine |
| Integrity manifest | `MANIFEST.sha256`, shipped in the package |
| SBOMs | `holt.cdx.json`, `holt.spdx.json` when attached to the release; v0.3.0 has neither |
| Provenance attestation | `gh attestation verify <tarball> --repo Raed2180416/holt` |
| Sanitised live release-control snapshot | `docs/evidence/release-ci/release-controls-20260805.json` and `.sha256` |
| Mutation-testing evidence | `npm run test:mutation` |
| Licence terms | `LICENSE.md` |
