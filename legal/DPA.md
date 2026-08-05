# Data Processing Addendum readiness note

**Not an agreement. Unreviewed as of 2026-08-04. Holt does not currently offer or execute a DPA,
and this file creates no commitment. The shipped Enterprise managed-policy feature does not turn
this readiness note into an executed agreement.**

An Article 28 processor contract must describe the real processing relationship, including its
subject, duration, nature, purpose, data types and data-subject categories. Calling Holt a
"Processor" in a template does not establish that role. The parties must determine their factual
roles for each commercial flow before drafting or signing anything.

## Current product boundary

- Repository analysis, actions, journalling and licence verification run on customer-controlled
  infrastructure and do not transmit repository data to Holt.
- Confirmed setup actions may download a pinned ctags asset, run a package manager or run the
  exact-versioned Go installer described in `SUPPLY-CHAIN.md`. An administrator can explicitly
  sync managed policy from credential-free TUF bases. Holt does not pass repository content to
  those tools or endpoints, but their network metadata and provider terms are separate.
- A commercial purchase/delivery path may process billing and technical contact data, licence
  records and support correspondence. Resend also receives licence-email content, including the
  token. Those flows are distinct from repository analysis.

## What must be settled before a DPA can be offered

1. Identify Holt's contracting legal entity and the controller/processor role for each flow.
2. Record the subject, duration, nature and purpose of processing; data types; data-subject
   categories; documented instructions; return/deletion behaviour; and legal-retention exceptions.
3. Name the deployed provider legal entities, regions and processing purposes. The current design
   names Stripe, Resend and Fly.io when the checked-in deployment configuration is used, but a
   repository file is not proof of the production deployment.
4. Verify and contract for confidentiality, access control, secret storage, logging, backup,
   incident handling, data-subject assistance, subprocessors, audit evidence and deletion.
5. Determine the transfer mechanism required for the deployed entities and customer location.
   A provider publishing SCCs or a DPA does not by itself incorporate those terms into Holt's
   customer agreement.
6. Obtain legal review and signatures from both parties.

## Code-level controls that can be evaluated now

- Issued licence tokens are Ed25519-signed and verified offline against compiled-in public keys.
- The Stripe webhook implementation verifies HMAC signatures using timing-safe comparison and a
  five-minute timestamp tolerance, and records idempotency state.
- The repository contains public verification keys, not the licence-signing private key.
- The installed repository-analysis product has no hosted data path or telemetry path.

These implementation facts do not prove how a production secret is stored, who can administer the
service, whether MFA is enforced, what a host logs, which provider region is active, or whether a
particular release/deployment passed its configured checks. Those require deployment evidence.

## Terms not currently offered

There is no contractual 72-hour breach-notification promise, 30-day subprocessor-change notice,
annual audit right, transfer representation, deletion schedule, support SLA or executed DPA today.
Those terms may be discussed with a design partner, then verified, legally reviewed and signed;
they must not be represented as shipped Enterprise capabilities.
