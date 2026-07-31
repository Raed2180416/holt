# Launch runbook

Everything is built and tested. This is the ordered list of **account and money decisions** left —
the only things that require a human with a credit card and a login. Each step says exactly what to
do and how to confirm it worked. Nothing here needs code changes.

> This file is operator-only and is excluded from the npm package. Delete it before making the
> repository's history public if you would rather it not be visible, or keep it — it contains no
> secrets, only a checklist.

---

## 0. Before anything — secure the signing key

The private Ed25519 key that mints every license currently lives at
`~/.agentic-os-tmp/holt-private/keys/holt-license-signing.key` (mode 0600). It is **not** in the
repository and must never be.

- [ ] Copy it into a password manager or secrets vault. If you lose it, you cannot issue new
      licenses. If it leaks, anyone can.
- [ ] The matching public key is already embedded in `src/license.mjs`. Nothing to do.

If you ever want a fresh key (recommended before real sales, so no dev-machine copy is ever the
production key):

```bash
node -e 'const {generateKeyPairSync}=require("node:crypto");const{publicKey,privateKey}=generateKeyPairSync("ed25519");console.log("PUBLIC :",publicKey.export({type:"spki",format:"der"}).toString("base64"));console.log("PRIVATE:",privateKey.export({type:"pkcs8",format:"der"}).toString("base64"))'
```

Put the PUBLIC value into `LICENSE_PUBLIC_KEYS_B64` in `src/license.mjs` (prepend it; keep the old
one only if you already issued licenses under it), commit, and store the PRIVATE value in your
secrets vault.

---

## 1. Publish the code

Already done locally: repo created at `github.com/Raed2180416/holt`, everything committed on
`main`, author identity clean, no AI or internal-project traces, tarball verified to contain only
`bin/ src/ README LICENSE`.

- [ ] `git push -u origin main`   *(blocked in the build session by a safety rule; run it yourself)*
- [ ] Confirm CI goes green on GitHub (the matrix runs Linux/macOS/Windows, plus the business and
      packaging jobs).

## 2. Turn on the website

- [ ] Repo → Settings → Pages → Source: **GitHub Actions**. The `site` workflow deploys
      `site/` on the next push to `main`. Confirm `https://raed2180416.github.io/holt/` loads.
- [ ] (Optional) buy a domain and point it at Pages; update the URLs in `README.md`,
      `src/license.mjs` (the pricing link), and `site/` if you do.

## 3. Publish to npm

- [ ] `npm publish` (you are already logged in as an npm user; the name `holt` is free).
- [ ] Confirm `npm install -g holt` works from a clean machine or container.

## 4. Stand up the license service (only needed to take money)

The service is one zero-dependency Node process in `server/`. It never talks to the CLI — it only
turns Stripe payments into signed licenses.

- [ ] Create a **Stripe** account. Create two Products with recurring prices: "holt Team"
      (per-seat) and "holt Enterprise". Note the two `price_...` ids.
- [ ] Create a **Resend** account (or any email API) for delivering licenses. Note the API key.
- [ ] Deploy (Fly.io config is in `server/fly.toml`):
      ```bash
      cd server
      fly launch --no-deploy
      fly secrets set \
        HOLT_SIGNING_KEY='<private key from step 0>' \
        STRIPE_SECRET_KEY='sk_live_...' \
        STRIPE_WEBHOOK_SECRET='whsec_...' \
        RESEND_API_KEY='re_...' \
        HOLT_PRICE_MAP='price_teamXXX:team,price_entYYY:enterprise' \
        HOLT_SITE_URL='https://raed2180416.github.io/holt' \
        HOLT_STRIPE_TAX='1'
      fly deploy
      ```
- [ ] In Stripe, add a webhook endpoint → `https://<your-fly-app>/webhooks/stripe`, subscribed to
      `checkout.session.completed`, `invoice.paid`, `customer.subscription.updated`. Paste the
      signing secret into `STRIPE_WEBHOOK_SECRET` above.
- [ ] Confirm `https://<your-fly-app>/health` returns `{"ok":true}`.

## 5. Connect the website to checkout

- [ ] After the service is live, set its URL in the site so the "Start a Team plan" button drives
      real checkout instead of the mailto fallback. In `site/index.html` the placeholder is
      `__HOLT_API__`; replace it with your service origin (a one-line `sed` in the Pages workflow,
      or edit and commit). Until you do, the button opens an email to `sales@holt.dev`, which is a
      safe fallback, not a broken link.

## 6. Test the whole path with Stripe test mode

- [ ] Put Stripe in **test mode**, use the test price ids and test card `4242 4242 4242 4242`.
- [ ] Click "Start a Team plan" → complete checkout → confirm you land on `thanks.html` and receive
      a license email → run `holt license activate <token>` → `holt license status` shows `team`.
- [ ] Only then switch Stripe to live keys.

## 7. Legal — before the first real dollar

- [ ] Have a lawyer review `legal/TERMS.md`, `legal/PRIVACY.md`, `legal/DPA.md`. They are honest
      drafts written to the actual architecture (the software transmits nothing), but they are
      drafts.
- [ ] Decide your **Merchant-of-Record** stance: Stripe leaves you responsible for sales tax/VAT
      registration. If that is a burden, Paddle/Polar/Lemon Squeezy act as MoR and handle tax at a
      higher fee — the service's webhook shape is close enough to switch later, but Stripe-native is
      wired today.

## 8. After launch — growth is already automated

- [ ] Nothing to do. `scripts/milestone.mjs` runs weekly and switches on the README's star/download
      badges automatically once you hit **500 stars or 1,000 weekly downloads**. Until then they
      stay hidden, because real small numbers argue against a new project.
- [ ] Submit to MCP registries (Smithery, mcp.so, PulseMCP) and the awesome-lists when you are
      ready for traffic — these are marketing actions, not code.

---

## What is already handled, so you don't have to think about it

- Licenses verify **offline** — no server call from the CLI, ever. An outage of the license
  service cannot break a customer. A lapsed subscription keeps working for a 14-day grace period.
- Unknown Stripe prices **refuse** rather than issuing the wrong tier. Retried webhooks are
  idempotent. Forged webhooks mint nothing.
- The resend endpoint cannot be used to enumerate customers and is rate limited so it cannot be
  turned into a spam relay.
- The free tool can **never** be broken by any license state — every failure degrades to "no paid
  feature", never "no tool".
- The npm tarball cannot leak the server, keys, tests, or legal docs — CI fails if it tries.
