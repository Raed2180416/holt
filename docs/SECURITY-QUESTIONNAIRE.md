# holt — vendor security questionnaire

Pre-filled answers to what a security review actually asks, in the order the standard
questionnaires (SIG Lite, CAIQ v4, and most bespoke vendor forms) ask it. Copy the relevant rows
into whatever form you have been handed.

**Every "no" here is a structural no, not a policy no.** Most of the risky answers are not
"we choose not to" — they are "the product cannot", and `holt audit` re-proves it on your machine
in under a second. Where something is not yet in place, this document says so; a questionnaire
that answers only the flattering questions is worth nothing to the person who has to sign it.

- Product: **holt** — a local CLI, MCP server, git hooks and TUI for relating work across parallel
  agent worktrees.
- Deployment model: **on the developer's machine and in the customer's CI. There is no holt
  service, no tenant, no account.**
- Last reviewed: see `git log -1 -- docs/SECURITY-QUESTIONNAIRE.md`. This file is checked against
  the code by `test/unit/supply-chain.test.mjs`, so its factual claims cannot silently rot.

---

## 1. The five questions that usually end the review

| # | Question | Answer |
|---|---|---|
| 1 | Does the product transmit customer data anywhere? | **No.** There is no endpoint to transmit to. One outbound request exists in the entire package — a human-triggered download of a pinned `universal-ctags` release asset, with a pinned SHA-256 — and it sends no body, no query string and no identifiers. One *indirect* path also exists and is disclosed in §7.8: `holt doctor --install` can run your package manager after printing the command and requiring confirmation. Verify: `holt audit`. |
| 2 | Does it phone home for licensing? | **No.** Entitlement is an offline Ed25519 signature check against a public key compiled into the binary. holt works fully air-gapped. The trade-off is stated openly: revocation is expressed as short expiry, not as a live check. |
| 3 | Does it require credentials or cloud access? | **No.** No account, no OAuth, no API key. The only secret it can hold is a licence token, stored at `$XDG_CONFIG_HOME/holt/license`, mode `0600`, opened `O_NOFOLLOW`. |
| 4 | Can it modify or destroy source code? | **Only through commands whose entire purpose is to act, and never as a side effect of analysis.** Read commands cannot reach a mutating git verb: `src/git.mjs` classifies every invocation, and destructive verbs (`reset`, `checkout`, `stash`, `clean`, `restore`, `rebase`, `push`, …) are refused at a gate no opt-in can reach. Mutation testing proves the refusal would fail the build if weakened. |
| 5 | What is the blast radius if the vendor is compromised? | The npm package. There is no server holding your data, no session to hijack and no update channel that can push code — holt never self-updates. `holt audit` plus `gh attestation verify` detect a substituted package before it runs. |

---

## 2. Data handling

| Question | Answer |
|---|---|
| What customer data is collected? | **None.** No telemetry, analytics, crash reporting, usage metrics or update check. |
| What data is processed, and where? | Your git repository, entirely on the machine holt runs on. Nothing leaves the process except what it prints to your terminal. |
| Is source code sent to a third party or an LLM? | **No.** holt contains no model, no inference call and no AI provider integration. It is the tool that *watches* agents; it is not one. |
| Data at rest | The only artefacts holt creates are: an append-only JSONL journal inside the repository's git directory (`$GIT_COMMON_DIR/holt/journal.jsonl`), rescue refs inside your own repository, and the licence file. All on your disk, all yours. |
| Data retention / deletion | Nothing is retained by us. Delete the journal and the licence file and nothing of holt's remains. |
| PII | holt records what git already records — commit author identity in your own repository's log. It adds no identity of its own; it reads **no** agent-identity environment variables. |
| Sub-processors | For the product: **none.** Commercially: Stripe (payment) and the mail provider used to deliver a licence key. Neither is in the tool's data path. |
| Cross-border transfer | Not applicable — no data transfer occurs. |

---

## 3. Access, authentication, cryptography

| Question | Answer |
|---|---|
| Authentication model | None. holt runs as your user, with your permissions. |
| Authorisation model | Feature entitlement only, and it is a licensing control, not a security control (see §7). |
| Cryptography in use | Ed25519 (licence and release-manifest signatures) and SHA-256 (integrity), both from Node's `node:crypto` — i.e. OpenSSL. No custom cryptography, no bundled crypto library. |
| Key management | The licence signing private key exists only on the maintainer's side and never in this repository. Rotation is supported: `LICENSE_PUBLIC_KEYS_B64` is a list, newest first, and old licences keep verifying until they expire so rotation cannot brick a paying customer mid-term. |
| Secrets in the package | None. CI fails the build if anything key-shaped, or the licence server, reaches the tarball. |
| Signature verification hardening | The signature covers the transmitted payload **string**, never a re-serialised object (the classic canonicalisation hole). A token cannot nominate its own verification key. The tier prefix in a token is a human convenience and is rejected if it disagrees with the signed payload. |

---

## 4. Supply chain

| Question | Answer |
|---|---|
| SBOM | CycloneDX 1.5 (ECMA-424) **and** SPDX 2.3, generated by `npm sbom`, attached to every release. See `SUPPLY-CHAIN.md`. |
| Runtime dependencies | **Zero required.** Everything in the SBOM is optional; `npm install -g holt --omit=optional` is a genuinely zero-dependency install, and CI proves the degraded path works and says so. |
| Build provenance | SLSA v1.0 **Build L2** — GitHub-hosted runner, Sigstore-signed provenance bound to the workflow's OIDC identity. Verify with `gh attestation verify`. L3 is reachable via a reusable workflow and is **not** claimed today. |
| Signed releases | npm provenance (`npm publish --provenance`) plus a GitHub artifact attestation over the tarball, the SBOMs and the integrity manifest. A detached Ed25519 signature over `MANIFEST.sha256` is implemented and **awaits the owner pinning a release key** — until then `holt audit --require-signature` refuses rather than passing. |
| Can a customer verify an installed copy? | Yes, offline: `holt audit`. It re-hashes every shipped file against `MANIFEST.sha256` and re-proves the capability ledger — no network, no repository, no account needed. |
| Dependency-confusion / typosquat exposure | The published name is `holt`, scoped to one publisher, and provenance ties every release to this repository and commit. |
| Post-install scripts | **None.** The package defines no `postinstall`, `preinstall` or `install` script. |
| Third-party binaries | Optional and never bundled: `ctags`, `enry`, `rg`, `jj`, `jscpd`. `holt setup` can download a pinned static `universal-ctags` and **refuses to install it on a SHA-256 mismatch**, or run your own package manager (§7.8); installing the backends yourself avoids both entirely. |
| Vulnerability disclosure | GitHub Security Advisories; 72-hour acknowledgement, 7-day substantive reply. `SECURITY.md`. |

---

## 5. Secure development lifecycle

| Question | Answer |
|---|---|
| Test coverage of security-relevant behaviour | The refusal layer, the entitlement path, the destructive-command guards and the supply-chain audit each carry dedicated suites, run on Linux, macOS and Windows. |
| Do the tests actually detect defects? | Proven, not assumed. `npm run test:mutation` injects deliberate defects — an entitlement check that grants everything, a licence that never expires, a webhook that skips signature verification, a supply-chain audit blind to `fetch()`, an integrity check that reports a **missing** manifest as verified — and **fails the build if any survives**. All are killed today. |
| Code review | All changes reviewed; DCO enforced in CI. |
| Static analysis | CI fails on any network primitive in `src/`; `holt audit` extends the same check to the whole shipped package, including `bin/`, and is runnable by you. |
| Dependency scanning | The SBOMs are CycloneDX/SPDX and feed any scanner you already run. With zero required dependencies there is little to scan, which is the intent. |
| Change management for the published artefact | Provenance binds each release to a commit and a workflow. A release nobody can trace to a commit does not verify. |
| Penetration testing | An adversarial audit of the commercial surface (token forgery, webhook replay, payment-event confusion, terminal-escape injection, rate-limit bypass, secret handling) was run before first paid release; every finding is pinned by a regression test. No third-party pentest report exists yet — stated plainly rather than implied. |

---

## 6. Operational / business continuity

| Question | Answer |
|---|---|
| Availability dependency | **None at runtime.** holt is a local binary; it keeps working if we are offline, and it keeps working if we are gone. |
| What happens if the vendor disappears? | The tool continues to run. Licences keep verifying until expiry, plus a 14-day grace period, with no server involved. The free tier is the whole single-repo product and is unaffected by any licence state. |
| Backup / DR | Not applicable to the tool. No customer data is held. |
| Incident response | Advisory published through GitHub Security Advisories with a fixed version and the tree digest of the fixed release, so you can confirm what you have. |
| Support | Public issue tracker; commercial support terms per your agreement. |

---

## 7. The honest caveats

Reviewers find these anyway. Finding them here first is cheaper for everyone.

1. **The entitlement check is tamper-evident, not tamper-proof.** The source is public and anyone
   can patch the check out. That is true of every open-core tool. What the signature guarantees is
   that a licence cannot be **forged or edited**, so an organisation cannot accidentally believe
   it is compliant when it is not. Patching it out is a licensing matter, not a vulnerability.
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
5. **`holt setup` downloads a binary.** Pinned URL, pinned hash, refuses on mismatch, only when a
   human asks. If your policy forbids it, install `universal-ctags` yourself and holt never
   reaches the network at all.
6. **No third-party pentest report and no SOC 2 report exists.** We are not going to imply
   otherwise. What exists instead is a product that holds no customer data, runs no service and
   can be verified on your own laptop — which is a different and, for this category of tool, more
   directly checkable assurance.
7. **SLSA Build L2, not L3.** L3 needs a reusable workflow. It is on the list and it is not
   claimed today.
8. **`holt doctor --install` can run your package manager, with `sudo` on Linux.** It prints the
   exact command, says that it needs sudo, and requires a typed `y` or `--yes` first. That is a
   network path and a privilege-escalation path, and it is the only one — no analysis, scan,
   hook, MCP call or git action ever elevates. It is listed here rather than left to the reader
   because the first draft of our own capability declaration missed it: `sh` was documented as
   "backend probes and `holt verify --run`", every word true, and the picture still wrong. A
   capability that arrives through a child process is still a capability, and no in-process
   detector can see it. `holt audit --json` reports it under `statement.indirectNetwork`.

---

## 8. Evidence index

| Artefact | Where |
|---|---|
| Verification instructions | `SUPPLY-CHAIN.md` |
| Vulnerability disclosure policy | `SECURITY.md` |
| Capability declaration (what holt reads/writes/executes/sends) | `src/supply-chain.mjs`, and `holt audit --json` on your own machine |
| Integrity manifest | `MANIFEST.sha256`, shipped in the package |
| SBOMs | `holt.cdx.json`, `holt.spdx.json`, attached to each GitHub release |
| Provenance attestation | `gh attestation verify <tarball> --repo Raed2180416/holt` |
| Mutation-testing evidence | `npm run test:mutation` |
| Licence terms | `LICENSE.md` |
