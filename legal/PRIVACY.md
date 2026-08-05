# Privacy Policy

**Last updated: 2026-08-04 · Draft for legal review before first sale.**

## The short version

**Holt's analysis, protection, journal and licence-verification paths send no repository or usage
data to Holt.** There is no telemetry, analytics, crash reporting, usage reporting or licence
check-in. Those runtime paths do write the explicit local Git/config/journal artifacts documented
in `SUPPLY-CHAIN.md`; vendor-side collection is the boundary stated here.

Confirmed setup actions are separate from that runtime boundary: Holt may download a pinned,
hash-verified universal-ctags asset, invoke your package manager, or run exact-versioned
`go install github.com/go-enry/go-enry/v2/cmd/enry@v2.9.6`, each only after confirmation. An
Enterprise administrator may also explicitly run `holt managed-policy sync` against
administrator-supplied credential-free TUF bases. None receives repository content from Holt, but
the child tools and configured endpoints have their own network metadata and provider policies.
All are disclosed by the audit ledger; [SUPPLY-CHAIN.md](../SUPPLY-CHAIN.md) gives the exact request
shape and how to avoid the network paths.

## What we do hold

Only what you provide in order to buy a plan:

| Data | Why | Where |
|---|---|---|
| Billing name, company, email | To issue and deliver your license, and to invoice you | Our license ledger; our payment processor |
| Payment details | To take payment | **Only** with our payment processor — we never see or store card numbers |
| License records (id, tier, licensed-repository quantity, issue and expiry dates) | To support you and prevent duplicate issuance | Our license ledger |
| Licence delivery email (recipient address, token and message content) | To deliver an issued licence | Our email provider |
| Support correspondence | To answer you | Our email provider |

## Repository-data boundary

The installed product does not transmit repository contents, file names, symbol names, branch
names, worktree paths, commit messages or a record that you ran Holt. Commercial web, payment,
mail and hosting providers may process ordinary request, fraud-prevention, delivery and security
metadata under their own configurations and terms; this draft does not promise those systems hold
no IP address or operational logs.

## Sub-processors

- **Stripe** — payment processing and invoicing, in the controller/processor roles described by
  Stripe for the selected services
- **Resend** — delivery of licence emails; receives the recipient address and email content,
  including the licence token
- **Fly.io when the checked-in deployment configuration is used** — licence-service hosting

The exact deployed provider entities, regions and current sub-processors must be confirmed before
this draft becomes effective. Provider lists change; do not infer them from this repository alone.

## Retention

No contractual retention schedule is offered by this draft. Before first sale, the effective
policy must specify the jurisdiction-appropriate tax/accounting retention for billing and licence
records, the support-correspondence period, operational-log periods and provider deletion
settings. Repository/usage data is not vendor-collected by the installed runtime.

## Your rights

Where GDPR, UK GDPR or CCPA apply you may request access to, correction of, or deletion of your
personal data, and may object to processing. Open a request at
**[https://github.com/Raed2180416/holt/issues/new](https://github.com/Raed2180416/holt/issues/new)**
(or use the private security-advisory channel if the request itself contains personal data).
Response timing and any retention exception follow applicable law and the effective policy; this
unreviewed draft does not create a shorter contractual deadline.

## International transfers

Commercial data may be processed in provider regions outside the customer's jurisdiction. Before
first sale, confirm the deployed entities/regions and execute or incorporate the transfer
mechanisms actually required for those flows. A provider offering standard contractual clauses is
not evidence that Holt has executed or incorporated them.

## Children

holt is a developer tool and is not directed at anyone under 16.

## Contact

https://github.com/Raed2180416/holt/issues/new
