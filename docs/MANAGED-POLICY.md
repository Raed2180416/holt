# Enterprise managed policy: deployment and trust boundary

Holt's shipped Enterprise surface is a local, offline enforcement path for a **persistent Linux
workspace on a dedicated, self-hosted runner**. A root administrator enrolls a TUF trust root and
one exact workspace directory. Signed policy is synchronized explicitly. Ordinary `holt ci` then
reads and evaluates the last authenticated generation without network access or privilege
elevation.

This is a filesystem integrity authority, not a hosted control plane and not repository-provider
authentication. Read the scope below before deploying it.

## Supported initial topology

- Linux, with the authoritative store fixed at `/etc/holt/managed-policy`.
- A single-purpose runner for one trusted private/internal repository and exactly one system
  profile. Shared multi-repository runners are not supported in this initial authority model.
- A persistent absolute workspace directory. Checkout may replace content inside that directory;
  it must not replace the directory itself.
- Enrollment, sync and recovery run as uid 0. `status` and `holt ci` may run as the ordinary runner
  account. Authenticated policy bytes are root-owned and world-readable, never group/world
  writable; policy is not treated as secret material.
- A profile's repository label is an administrator-asserted join key. Holt does not infer or
  authenticate it from a Git remote, environment variable or repository-controlled file.

Use runner groups and repository scoping so only the intended repository can use the machine. Do
not use this topology for untrusted public pull requests. GitHub likewise warns about public
repositories on self-hosted runners, and its current autoscaling guidance recommends ephemeral
runners: [adding self-hosted runners](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners)
and [self-hosted runner reference](https://docs.github.com/en/actions/reference/runners/self-hosted-runners).

## Not supported yet

GitHub-hosted runners, ARC/ephemeral runner filesystems, and other fresh-checkout paths are not
system-authoritative in this release. Values such as `GITHUB_REPOSITORY`,
`GITHUB_REPOSITORY_ID`, a Git remote URL, or a caller-supplied `--repository` string are not
cryptographic evidence and are ignored by CI discovery.

A secure ephemeral implementation needs a verified CI-issued identity and its key/issuer lifecycle.
For example, GitHub's signed OIDC token can carry immutable `repository_id` and
`job_workflow_ref` claims, but Holt does not currently request or verify that token:
[GitHub OIDC reference](https://docs.github.com/en/actions/reference/security/oidc). Until that
adapter exists, Holt refuses to market process environment as authenticated identity. There is no
SSO, SCIM or hosted Holt dashboard in this path.

## 1. Choose the persistent workspace and label

Create or choose a stable directory owned by the runner account. The directory must already exist
and must be the repository root when enrolled. A provider's immutable numeric repository ID is a
good administrative label because it survives rename, but the administrator remains responsible
for obtaining it from a trusted provider-side channel.

```bash
install -d -o holt-runner -g holt-runner -m 0750 /srv/holt-workspaces/acme-api
# Clone/checkout the repository into that exact directory, then verify the root you intend.
git -C /srv/holt-workspaces/acme-api rev-parse --show-toplevel
```

Example label used below: `github-repository-id:123456`.

## 2. Enroll the out-of-repository trust root

Obtain the initial `root.json` over an independently approved administrative channel and verify its
fingerprint out of band. All managed-policy commands require an Enterprise entitlement. Make that
entitlement available to the administrator using your normal secret-delivery mechanism; do not
commit it or the bootstrap decision to the repository.

Run from an approved uid-0 administrative session:

```bash
holt managed-policy enroll \
  --authority system \
  --profile production \
  --bootstrap-root /secure/bootstrap/root.json \
  --repository github-repository-id:123456 \
  --repository-root /srv/holt-workspaces/acme-api
```

Enrollment is create-once. It records the canonical absolute path, device and directory inode
under the root-owned profile. Once that profile exists, both a different path and the same path
later naming a different inode hard-refuse; there is no repository-controlled opt-out.

## 3. Publish an exact assignment

The authenticated TUF target must be named `policy.json`. Its `profile` must match enrollment and
its assignment label must exactly match the administrator-enrolled label. A minimal shape is:

```json
{
  "version": 1,
  "profile": "production",
  "description": "Required CI policy for acme-api",
  "policies": [
    {
      "id": "baseline",
      "policy": {
        "version": 1,
        "rules": [
          { "id": "no-abandoned-work", "type": "no-unlanded", "severity": "error" }
        ]
      }
    }
  ],
  "assignments": [
    { "repository": "github-repository-id:123456", "policies": ["baseline"] }
  ]
}
```

TUF repository production, key custody and signing ceremonies remain customer-controlled. Holt
uses the enrolled root for root rotation, rollback/freeze protection, delegated targets, hash and
length verification; it does not create or hold signing keys.

## 4. Synchronize explicitly

The two bases must be credential-free HTTP(S) URLs approved by the administrator. Sync is the only
managed-policy network path and must run as uid 0:

```bash
holt managed-policy sync \
  --authority system \
  --profile production \
  --metadata-url https://policy.example.internal/production/metadata/ \
  --targets-url https://policy.example.internal/production/targets/
```

Successful activation is crash-safe and monotonic. Ordinary analysis, hooks, MCP, `status`, and
`holt ci` never invoke this transport.

## 5. Verify before enabling the gate

As the administrator:

```bash
holt managed-policy status --authority system --profile production --json
stat -c '%U %G %a %n' \
  /etc/holt/managed-policy \
  /etc/holt/managed-policy/profiles \
  /etc/holt/managed-policy/profiles/production/trust.json
```

As the unprivileged runner account, from the exact enrolled directory:

```bash
cd /srv/holt-workspaces/acme-api
holt ci --json
```

A managed verdict has `mode: "managed-policy"` and reports the profile, root fingerprint,
generation, freshness and policy provenance. Do not enable branch protection until that exact
output is observed on the real runner.

## Fail-closed and pass-through behavior

| State | Result |
|---|---|
| Fixed store absent | No Enterprise deployment; ordinary Free/Team CI behavior |
| A profile exists, current absolute path is not its enrolled workspace | `MANAGED_POLICY_NOT_TARGETED`; no verdict or weaker fallback |
| Enrolled path now names another device/inode | `MANAGED_POLICY_IDENTITY_MISMATCH`; no verdict |
| Enrolled label has no assignment in active signed policy | `MANAGED_POLICY_ASSIGNMENT_MISSING`; no verdict |
| More than one system profile exists on the runner | `MANAGED_POLICY_AMBIGUOUS`; shared-runner selection is unsupported |
| Corrupt, expired, rollbacked, permission-weakened or recovery-required authority | Named refusal; no weaker fallback |
| Candidate policy or inline ignore tries to weaken a managed rule | Managed rule remains additive and mandatory |

The absolute workspace path is the targeting boundary, and store presence declares the machine
single-purpose. A workflow that changes to a different directory refuses before rendering any CI
verdict. Pin the runner's working directory and alert on a result that is not
`mode: "managed-policy"`.

## Recovery and rotation

`status --json` reports the exact transition, lock token and orphan generation when a crash leaves
recovery-required state. Use only the receipt it reports:

```bash
holt managed-policy recover \
  --authority system \
  --profile production \
  --recovery-mode complete \
  --lock-token '<exact token from status>'
```

Use `--recovery-mode quarantine` only with the exact transition or `--orphan` basename shown by
status. Never select a generation by timestamp or directory order. Root rotation and routine policy
updates use the same explicit `sync` command; signed metadata expiry is enforced offline.

## Do enterprises need a Holt dashboard?

Not for this supported topology. Enforcement is local; `status --json`, CI JSON, the local
hash-chained journal, Team fleet/forensics and the local audit sink are the operating interfaces.
Existing CI, SIEM and fleet tooling can consume them. A dashboard becomes useful only with a future
hosted control plane for identity enrollment, fleet rollout, exception workflow or evidence
aggregation. Holt does not imply that control plane exists today.
