# Holt release and CI readiness audit

Observed 2026-08-05 03:24:51 +05:30. This is a read-only audit of the shared working tree and the
live `Raed2180416/holt` GitHub repository. No file outside this new evidence directory was edited,
and no branch, tag, setting, secret, release, or package was changed.

All unqualified results in the original audit below are point-in-time findings from 03:24:51.
Repository settings changed afterward. The update immediately below supersedes only the original
live release-control findings; it does not turn the dirty candidate, hosted CI, artifact integrity,
branch governance or published v0.3.0 rows green.

## Release-control update — observed 2026-08-05 04:39:02 +05:30

Authenticated read-back now reports:

| Control | Updated result | Sanitised evidence and boundary |
|---|---:|---|
| Immutable releases | **GREEN live** | `enabled: true`, `enforced_by_owner: false` |
| `release` environment | **GREEN live for ref restriction** | exists; custom branch policies enabled; one tag policy `v*`; administrator bypass enabled; no required-reviewer rule returned |
| Required environment-secret names | **GREEN existence only** | `HOLT_RELEASE_ADMIN_TOKEN` and `HOLT_RELEASE_SIGNING_KEY` exist; GitHub never returns values |
| Ed25519 release key | **GREEN local match** | pinned and private-derived SPKI SHA-256 both `fdc0f121ca21f23a6ae7d448f4cbb7f16a6c214d4bfae855f380cc54b4e170d8`; private material excluded |
| Admin-read credential | **AMBER — rotate** | current secret was populated from the maintainer's OAuth credential with `repo`, `workflow`, `read:org`, `gist`; the workflow needs only repository Administration read |
| SLSA Build L3 | **GAP / not claimed** | release controls do not change the builder-level requirement |

The exact sanitised summary is
[`release-controls-20260805.json`](release-controls-20260805.json), with its adjacent SHA-256
sidecar. GitHub's [immutable-release endpoint](https://docs.github.com/en/enterprise-cloud@latest/rest/repos/repos#check-if-immutable-releases-are-enabled-for-a-repository)
documents Administration read for the check. Its
[environment documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
distinguishes tag restrictions, required reviewers and administrator bypass. No secret value was
printed, read back or retained.

## Original verdict at 03:24:51

**Do not tag or publish this tree yet.** The release architecture is substantially stronger than
the current red badge suggests, but the candidate is not immutable, the installed candidate fails
its own integrity audit, current macOS/Windows code has no hosted result, and live GitHub settings
would make the new release workflow fail before it builds anything.

The most important distinction is:

- The **pipeline contract** is strong locally: all 18 CI-hardening positive controls and all 17
  release-contract positive controls fire, the observed action pins were live, and package/install
  smoke tests exercise real planted work.
- The **candidate instance** is red: local and remote `main` diverge 1/1, the working tree is
  heavily dirty and changing, `MANIFEST.sha256` is stale, one new documentation command is invalid
  under the doc gate, and no hosted run has exercised these bytes.
- The **live release control plane at the original observation** was red: immutable releases were
  disabled and there was no `release` environment. That finding is superseded by the dated update
  above.

Machine-readable results and exact artifact digests are in [gate-results.json](gate-results.json).

## Gate table

| Gate | Result | Exact evidence |
|---|---:|---|
| Candidate identity | **RED** | local `c9f4d763…` and remote `a6c1c7ab…` are 1 ahead / 1 behind; 136 dirty paths at final snapshot; the shared tree changed during the audit |
| Git runtime | GREEN | `node scripts/check-git-runtime.mjs --verify-inert-hooks`: Git 2.55.0, minimum 2.45, `--no-lazy-fetch` and inert-hook positive control pass |
| CI hardening contract | GREEN locally | `node scripts/check-ci-hardening.mjs --self-test`: 18/18 planted violations detected; clean tree accepted |
| Release contract | GREEN locally | `node scripts/check-release-contract.mjs --self-test`: 17/17 planted violations detected; clean contract accepted |
| Type and generated-doc ratchets | GREEN locally | typecheck 0 diagnostics; HOSTS generated document matches; native-path lint clean across 185 files |
| Release body contract | GREEN locally | 3/3 checked-in bodies (`v0.2.0`, `v0.3.0`, `v0.3.1`) pass |
| Cross-platform ownership list | GREEN contract only | 106/107 test files selected; exactly `test/e2e/real-repos.test.mjs` assigned to the pinned 4/4 Linux owner |
| Current Linux portable run | **RED / non-frozen** | rerun: 1443/1476 pass, 33 fail, 0 skip. Twenty-nine failures share stale integrity evidence; doc smoke is independently red; three broad-run failures passed focused reruns |
| Current manifest and audit | **RED** | latest snapshot: 15 modified + 2 unexpected shipped files; `holt audit` has 6/7 checks green and integrity red |
| Package contents | GREEN locally | 3/3: reachable modules, 15 optlib packs, and external declarations ship |
| Runtime dependency advisory scan | GREEN locally | `npm audit --omit=dev --audit-level=high`: 0 known vulnerabilities |
| Candidate tarball core behavior | GREEN point-in-time | installed tarball smoke: version, doctor, positive/negative risk, gate deny/allow, and status all pass (7/7) |
| Candidate tarball integrity | **RED** | installed `holt audit`: 14 modified + 2 unexpected at pack time |
| Omit-optional path | **RED / false-green gate** | global `npm install -g --omit=optional` still installed 95 nested optional dependency directories; the workflow checks behavior but never proves absence |
| SBOM generation | GREEN locally | CycloneDX 1.5: 101 optional, 0 required; SPDX 2.3: 102 packages; root/version correct; no dev leak |
| GitHub Action pins | GREEN live | 11/11 SHA pins equal the commits named by their adjacent current version tags |
| Toolchain pins | GREEN live | 7/7: Node 22.23.2/24.19.0/26.6.0, Go 1.26.5, OpenCode 1.18.13 integrity, enry commit, jj 0.43.0 |
| Public stable install | GREEN for old core | public `holt.tgz` is HTTP 200, SHA matches GitHub, installed v0.3.0 core smoke is 6/6 |
| Public stable assurance/currentness | **RED** | v0.3.0 has no `audit`, no GitHub attestation, and the release is mutable; it does not contain this candidate's features |
| Latest hosted CI | **RED** | [run 30879188200](https://github.com/Raed2180416/holt/actions/runs/30879188200): 10/14 jobs green; Windows core, Windows full, macOS full, and all-backends failed |
| Current hosted candidate | **UNMEASURED** | current uncommitted bytes have never run on GitHub-hosted Linux/macOS/Windows or Node 22/24/26 |
| Live release preflight | **HISTORICAL HARD RED — superseded** | At 03:24:51 GitHub reported immutable releases `false` and no `release` environment. See the later control snapshot above. |
| Main governance | **RED** | branch protection 404, zero rulesets, action SHA pinning not required by repository setting |

## Independent defects found

### 1. The omit-optional CI check does not prove omission

The CI and release workflows say they prove Holt remains useful when optional dependencies are
omitted. Their command is a global install:

```sh
npm install -g --omit=optional ./holt-*.tgz
```

On npm 10.9.7, an isolated global-prefix run still installed Holt's 95-directory optional tree,
including the MCP SDK and its transitive dependencies. The subsequent core smoke passed because
the dependencies were present. A non-global isolated-prefix install with the same omit flag
correctly installed only Holt. The current gate never inspects the installed dependency tree, so
it cannot distinguish these cases.

This must become a measured property, not another command comment: assert that the three optional
roots are absent on disk, then run the core smoke. The workflow should use an install shape whose
omit semantics are proven across supported npm/Node versions. Official npm 10 documentation says
`--omit=optional` excludes optional packages from disk, which makes the observed global behavior a
reason to measure, not to assume: <https://docs.npmjs.com/cli/v10/commands/npm-install/#omit>.

### 2. Release events run the same body check twice

`.github/workflows/release.yml` and `.github/workflows/release-body.yml` are byte-identical
(SHA-256 `6501f73bc54ee30358e0921d25bd811fea5f346e0d6637427cdfbd3c72d30aed`). GitHub lists both as
active workflows named `release body`. Every release publish/edit therefore produces duplicate
checks, cost, and UI noise.

### 3. Security/release documentation contradicts executable behavior

- `src/supply-chain.mjs` describes `RELEASE_PUBLIC_KEYS_B64` as deliberately empty while the array
  contains the pinned release key.
- `SUPPLY-CHAIN.md` says missing signing material skips gracefully and signature verification is
  unavailable. The current workflow fails closed when `HOLT_RELEASE_SIGNING_KEY` is absent, and
  source verification now pins a key.
- The environment-variable inventory repeats its opening block.
- CI comments still say 29 integration targets while the current host manifest has 30.

These do not break execution, but they are exactly the sort of reviewer-visible contradiction a
respectable security release cannot carry.

### 4. Skip ownership is not a release gate

The current Linux all-backends job warns on skipped tests but does not fail on them. The explicit
public-number withholding state also passes regardless of the measured count. The release quality
job calls `npm test` but does not install OpenCode or jj; both suites contain explicit absent-tool
skips. Cross-platform jobs intentionally contain platform-specific skips, but there is no
machine-checked map proving each skipped case is owned by another matrix cell.

The right rule is not “zero skips on every OS.” It is: every case is either executed in at least
one required matrix cell, or its exclusion has one named owner and denominator. The new feature
proof runner is not yet invoked by CI or the release workflow, so it does not currently close this
gap.

### 5. The broad local suite is not yet deterministic evidence

Two 106/107-file runs returned 1442/1476 and 1443/1476 passes. In the second run, three non-manifest
tests failed under broad concurrency and then passed focused 1/1 reruns:

- Git reference-hook suppression,
- OpenCode CommonJS dialect loading,
- ignored executable dependency source identity.

The shared tree changed during these runs (the graph implementation changed after the candidate
tarball was packed), so these are not valid frozen-candidate failures. They still prevent calling
the local result green. Re-run from a clean, immutable checkout and treat any recurrence as a
flake to root-cause, not as a retry to ignore.

## Live GitHub state at the original snapshot

Read-only GitHub API checks returned:

- public repository and GitHub Pages live with HTTPS enforced;
- latest release is mutable v0.3.0;
- immutable releases disabled;
- no `release` environment, therefore no environment secrets or protection rules;
- no branch protection and no repository rulesets;
- Actions enabled, all actions allowed, repository-level SHA pinning not required;
- default workflow token permission is read and cannot approve PRs;
- Dependabot alerts and security updates disabled;
- no code-scanning analysis;
- secret scanning and push protection enabled, with zero open secret alerts;
- two active, identical `release body` workflows.

At the original snapshot the release workflow needed these exact live inputs. All four names or
controls now exist, subject to the limits in the later update:

- immutable releases enabled;
- protected environment named `release`;
- environment-secret name `HOLT_RELEASE_ADMIN_TOKEN`, populated from a credential that can read
  immutable state;
- environment-secret name `HOLT_RELEASE_SIGNING_KEY`, populated from the intended PKCS#8 Ed25519
  private key whose locally derived public key matches the key already pinned in source.

The remaining token issue is least privilege: the configured OAuth credential is broader than the
documented Administration-read requirement and should be rotated before release. GitHub does not
permit secret read-back, so the source credential's local API success and a secret name still
cannot substitute for one successful fail-closed release run.

## Public and candidate artifact evidence

| Artifact | SHA-256 | Meaning |
|---|---|---|
| `holt-public-v0.3.0.tgz` | `097af7ad10b52e44fd8bd5ca86f7e2efb584b0071ec3574edc1c62adcf15a663` | downloaded from the public stable-latest URL; matches GitHub asset digest |
| `holt-0.3.1.tgz` | `cccac620e3f8b64bcc9714caecf67d78fc257afc86991e605ec60e73ed3f0c5b` | diagnostic pack of the dirty tree at 03:12; scripts disabled to avoid regenerating the manifest; **not final** |
| `sbom-current/holt.cdx.json` | `991189833b7a0d9a7cfee2c2d9ab9394c13a7d63b9e08c13cec78171e290ef29` | current lock-derived CycloneDX evidence |
| `sbom-current/holt.spdx.json` | `e639249fe8ff14e04d60851865bdb8733ecbfe3657ba343058a91940f0f8d90d` | current lock-derived SPDX evidence |

The diagnostic candidate tarball installed and analyzed planted sole-copy work correctly, but its
integrity audit fails. It also predates later graph changes in the shared tree. It must never be
promoted or renamed as a release asset.

The public v0.3.0 tarball remains installable and the core smoke passes, but `holt audit` is an
unknown command in that version, `gh attestation verify` finds no attestation, `gh release verify`
finds no release attestation, and GitHub reports the release is not immutable.

## Safest publication sequence

1. **Freeze the candidate.** Stop all writers. Do not clean or delete any worktree. Review `holt
   status` and preserve every at-risk workstream before reconciliation.
2. **Resolve Git identity before testing.** Local and remote `main` diverge. The unpushed local
   commit `c9f4d763…` has no DCO `Signed-off-by` line, so carrying it unchanged into a PR will fail
   the DCO workflow. Rebuild/amend the local-only candidate with sign-off, then incorporate remote
   `a6c1c7ab…` without discarding either side.
3. **Remove audit-only install prefixes outside the agent.** The exact disposable paths are listed
   below. They are generated test installs, not source, but the repository guard correctly refused
   the agent's recursive removal. Do not include them in a commit or mutation copy.
4. **Fix every deterministic red and false-green gate.** In particular: doc smoke, omit-optional
   absence proof, duplicate release workflow, stale security prose, and skip ownership.
5. **Regenerate integrity evidence last.** Only after all code and docs are frozen, run
   `node scripts/gen-manifest.mjs`, then require `--check` and `holt audit` green. Any later shipped
   byte invalidates this step.
6. **Test a fresh immutable checkout.** Use `npm ci`, not the shared `node_modules`. Run the complete
   suite, mutation harness, feature-proof runner, typecheck, host generation, path lint, CI and
   release positive controls, npm audit, SBOM generation, and the exact pack/install/audit smoke.
   Record pass/skip denominators. No retry can substitute for a root cause.
7. **Push a signed-off candidate branch, not directly to main.** Open a PR, wait for every current
   Linux/macOS/Windows and Node 22/24/26 cell, and require all intended jobs. Current code has no
   hosted result.
8. **Re-verify GitHub before tagging.** Immutable releases, the `release` environment, its `v*`
   tag policy and both required secret names were present at the later 04:39 snapshot. Rotate the
   broad OAuth admin-read secret to a repository-scoped Administration-read credential, decide
   administrator bypass/reviewer policy, then re-run the live checks. Branch rules/required checks,
   Dependabot/security updates and code scanning remain separate governance work.
9. **Merge only after all required checks pass, then wait for main and Pages.** Re-verify the public
   site contains the merged bytes.
10. **Choose the release version.** This is a business/product decision: keep `0.3.1` or select a
    different semver for the much larger feature set. Bind `package.json`, tag, checked-in release
    body, SBOMs, and assets to the same version and commit.
11. **Push one stable `vX.Y.Z` tag.** The release workflow should build once, sign the in-package
    manifest, generate both SBOMs, install and test that same tarball, attest it, create one draft,
    verify every remote digest, and publish last.
12. **Verify the public result independently.** From clean Linux, macOS, and Windows hosts, install
    `releases/latest/download/holt.tgz`; require version, `audit --require-signature`, positive and
    negative risk/gate smoke, MCP startup, and a genuinely absent optional-dependency core run.
    Verify GitHub release and asset attestations and stable-latest digest.

## Exact disposable audit paths still present

The audit created these prefixes and attempted to remove only these exact paths. The repository
guard refused recursive removal, so no alternative deletion verb was attempted. They can be
deleted by the user outside the agent after this report is retained:

```text
docs/evidence/release-ci/candidate-prefix
docs/evidence/release-ci/public-prefix
docs/evidence/release-ci/candidate-omit-prefix
docs/evidence/release-ci/candidate-omit-local
docs/evidence/release-ci/test-tmp
docs/evidence/release-ci/candidate-tmp
docs/evidence/release-ci/public-tmp
```

They total roughly 200 MB and must not be committed. The retained tarballs, SBOMs, report,
`gate-results.json`, and `installed-artifact-smoke.mjs` are the useful evidence.

## Business/account choices after technical green

Once the gates above are green, the remaining decisions are genuinely owner choices:

- release semver and timing;
- who can approve the protected release environment and whether admins may bypass it;
- signing-key custody, backup, and rotation owners;
- merge policy and exact required checks;
- Dependabot/code-scanning policy;
- licence/pricing/checkout accounts and commercial support commitments.

Those choices should configure a proven release, not compensate for an unproven one.
