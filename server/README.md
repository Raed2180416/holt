# holt license service

One Node process, zero dependencies. Verifies Stripe webhooks, mints Ed25519-signed license
tokens, records every issuance in an append-only ledger.

## What it is not

It is not a phone-home server. The holt CLI never contacts it — on any tier. Licenses are
verified locally against a public key compiled into the client, so this service is only ever
touched at purchase time. That is deliberate: it means an outage here cannot break a customer's
build, and it means holt's "no network calls" promise stays literally true.

## Deploy

```bash
# 1. Generate the signing keypair ONCE, offline. The private key never enters this repository.
node -e 'const {generateKeyPairSync}=require("node:crypto");const{publicKey,privateKey}=generateKeyPairSync("ed25519");console.log("PUBLIC :",publicKey.export({type:"spki",format:"der"}).toString("base64"));console.log("PRIVATE:",privateKey.export({type:"pkcs8",format:"der"}).toString("base64"))'

# 2. Put the PUBLIC key in src/license.mjs (LICENSE_PUBLIC_KEY_B64) and ship it.
# 3. Keep the PRIVATE key in your host's secret store only.

fly launch --no-deploy
fly secrets set HOLT_SIGNING_KEY='<private>' STRIPE_WEBHOOK_SECRET='whsec_...' \
               STRIPE_SECRET_KEY='sk_live_...' RESEND_API_KEY='re_...' \
               HOLT_PRICE_MAP='price_xxx:team,price_yyy:enterprise'
fly deploy
```

Then point a Stripe webhook endpoint at `https://<host>/webhooks/stripe` for
`checkout.session.completed`, `invoice.paid`, `customer.subscription.updated`.

## Issue a license by hand

```bash
HOLT_SIGNING_KEY='<private>' node sign-license.mjs --tier team --org "Acme Inc" \
  --email billing@acme.com --seats 25 --days 365
```

## Operational notes

- **Unknown prices refuse.** A new Stripe product that is not in `HOLT_PRICE_MAP` will not
  silently issue a tier; the refusal is recorded and visible at `/health`.
- **Retries are idempotent** by Stripe event id — a retried webhook returns the first outcome.
- **A failed signature returns 400**, so Stripe keeps retrying a genuine event.
- **Cancellation lapses, it does not revoke.** Tokens expire on their own schedule; there is no
  kill switch, because a kill switch would require the client to check in.
- **Back up `licenses.jsonl`.** It is the entire state of the business.
