# Data Processing Addendum (template)

**Draft for legal review. Provided for enterprise procurement; sign the executed version, not this file.**

This addendum forms part of the Terms of Service between holt ("Processor") and the customer
("Controller").

## 1. Scope — and why it is unusually narrow

holt's software runs entirely on the Controller's own infrastructure and transmits nothing.
The Processor therefore does **not** process the Controller's repository data, source code, or
developer activity in any form. The only personal data processed is **billing and support
contact data** voluntarily supplied by the Controller to purchase and maintain a subscription.

Controllers evaluating this document for a code-scanning risk review should note that there is
no data flow to assess: the tool has no network capability.

## 2. Categories

- **Data subjects:** the Controller's billing and technical contacts.
- **Personal data:** name, business email, company name, purchase and support history.
- **Special categories:** none. The Processor does not request or accept them.

## 3. Processor obligations

The Processor shall: process personal data only on documented instructions; ensure personnel are
bound by confidentiality; implement appropriate technical and organisational measures (section
5); engage sub-processors only under equivalent written terms and with notice of changes; assist
the Controller with data-subject requests and with DPIAs; delete or return personal data at the
end of the agreement except where retention is legally required; and make available the
information necessary to demonstrate compliance.

## 4. Sub-processors

Stripe (payments), Resend (transactional email), and the cloud host of the license service.
The Controller is notified at least 30 days before any addition, and may object on reasonable
data-protection grounds.

## 5. Security measures

- The license signing key is held only in a secrets manager and never in source control.
- License tokens are Ed25519-signed; webhook endpoints verify HMAC signatures in constant time
  and reject events outside a 5-minute replay window.
- Access to the license ledger is limited to named administrators with multi-factor
  authentication.
- Transport is TLS 1.2+ throughout.
- The Processor's own software is covered by a published vulnerability disclosure policy
  (see SECURITY.md).

## 6. Breach notification

The Processor notifies the Controller without undue delay, and in any case within 72 hours of
becoming aware of a personal-data breach affecting the Controller's data.

## 7. International transfers

Where personal data leaves the EEA or the UK, transfers rely on the European Commission's
Standard Contractual Clauses and the UK International Data Transfer Addendum.

## 8. Audit

The Controller may, no more than once per year and on 30 days' notice, request written evidence
of the measures in section 5.
