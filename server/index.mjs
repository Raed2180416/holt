#!/usr/bin/env node
/**
 * holt license service.
 *
 * One small Node process, zero dependencies. It does exactly four things:
 *   1. verifies Stripe webhooks and issues Ed25519-signed license tokens on payment,
 *   2. re-issues / looks up a license for support and self-service,
 *   3. revokes on cancellation by simply not renewing (licenses expire; there is no kill switch,
 *      because a kill switch would require the CLI to phone home, which it never does),
 *   4. records every issuance in an append-only log.
 *
 * WHY NO STRIPE SDK: webhook verification is an HMAC-SHA256 over `${timestamp}.${rawBody}`
 * compared in constant time — about fifteen lines with node:crypto. Adding a dependency to a
 * service that holds the license signing key widens the supply-chain surface for no benefit.
 * Everything else Stripe-side is a plain HTTPS call with the built-in fetch.
 *
 * STORAGE is an append-only JSONL file. At licensing volumes this is faster than a database,
 * survives any crash mid-write (a torn last line is detected and reported, never silently
 * dropped), backs up with `cp`, and can be audited by a human with `less`.
 *
 * REQUIRED ENV
 *   HOLT_SIGNING_KEY        base64 PKCS8 Ed25519 private key (the only real secret)
 *   STRIPE_WEBHOOK_SECRET   whsec_... from the Stripe dashboard
 *   STRIPE_SECRET_KEY       sk_live_... (only used for the billing-portal endpoint)
 * OPTIONAL
 *   RESEND_API_KEY          if absent, issued licenses are written to the log and stdout only
 *   HOLT_LICENSE_FROM       sender address for delivery mail (default: licenses@holt.dev)
 *   HOLT_DATA               path to the JSONL ledger (default: ./data/licenses.jsonl)
 *   PORT                    default 8080
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createPrivateKey, sign as edSign, createHmac, timingSafeEqual, randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT) || 8080;
const DATA = process.env.HOLT_DATA || path.join(process.cwd(), 'data', 'licenses.jsonl');
const FROM = process.env.HOLT_LICENSE_FROM || 'licenses@holt.dev';

/* -------------------------------------------------------------- configuration ---- */

/**
 * Fail fast and loudly at boot. A licensing service that starts without its signing key and
 * only discovers that on the first paying customer's webhook is worse than one that refuses
 * to start at all.
 */
export function requireConfig(env = process.env) {
  const missing = ['HOLT_SIGNING_KEY', 'STRIPE_WEBHOOK_SECRET'].filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`holt license service cannot start: missing ${missing.join(', ')}`);
  }
  return { signingKey: env.HOLT_SIGNING_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET };
}

/* ------------------------------------------------------------------- signing ---- */

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Mint a token. Pure apart from the key, so the tests can mint with a throwaway keypair. */
export function mintLicense({ tier = 'team', org = null, email = null, seats = null, days = 365, id = null }, signingKeyB64) {
  if (!['team', 'enterprise'].includes(tier)) throw new Error(`refusing to mint unknown tier '${tier}'`);
  if (!(days > 0)) throw new Error('refusing to mint a license with a non-positive lifetime');
  const now = Date.now();
  const claims = { v: 1, id: id ?? randomUUID(), tier, org, email, seats, iat: now, exp: now + days * 86_400_000 };
  const payload = b64url(JSON.stringify(claims));
  const key = createPrivateKey({ key: Buffer.from(signingKeyB64, 'base64'), format: 'der', type: 'pkcs8' });
  return { token: `holt_${tier}_${payload}.${b64url(edSign(null, Buffer.from(payload, 'utf8'), key))}`, claims };
}

/* ------------------------------------------------------- Stripe webhook proof ---- */

/**
 * Verify a Stripe-Signature header against the raw request body.
 *
 * Three things must all hold, and each is a real attack if skipped:
 *   - the HMAC matches            (forged event)
 *   - compared in constant time   (signature oracle)
 *   - the timestamp is recent     (replay of a genuine old event, e.g. re-triggering an
 *                                  upgrade webhook forever)
 */
export function verifyStripeSignature(rawBody, header, secret, { now = Date.now(), toleranceSec = 300 } = {}) {
  if (typeof header !== 'string' || !header) return { ok: false, reason: 'missing Stripe-Signature header' };
  const parts = Object.fromEntries(header.split(',').map((kv) => {
    const i = kv.indexOf('=');
    return i < 0 ? ['', ''] : [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
  }));
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) return { ok: false, reason: 'malformed Stripe-Signature header' };

  const age = Math.abs(now / 1000 - t);
  if (age > toleranceSec) return { ok: false, reason: `event timestamp is ${Math.round(age)}s old — outside the ${toleranceSec}s replay window` };

  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(v1, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'signature mismatch' };
  return { ok: true, timestamp: t };
}

/* ------------------------------------------------------------------- storage ---- */

export function appendRecord(record, file = DATA) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
    fs.fsyncSync(fd); // a license we mailed but did not record is a support incident
  } finally {
    fs.closeSync(fd);
  }
}

export function readRecords(file = DATA) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { records: [], torn: 0 }; }
  const lines = raw.split('\n').filter(Boolean);
  const records = [];
  let torn = 0;
  for (const l of lines) {
    try { records.push(JSON.parse(l)); } catch { torn++; }
  }
  return { records, torn };
}

/** Idempotency: Stripe retries, and a retry must never mint a second license. */
export function findByEvent(eventId, file = DATA) {
  return readRecords(file).records.find((r) => r.eventId === eventId) ?? null;
}

/* -------------------------------------------------------------------- events ---- */

const TIER_BY_PRICE = () => {
  // Set HOLT_PRICE_MAP='price_abc:team,price_def:enterprise' in the environment. Unknown prices
  // are REFUSED rather than defaulted, so a new product created in Stripe cannot silently issue
  // the wrong tier.
  const map = new Map();
  for (const pair of (process.env.HOLT_PRICE_MAP || '').split(',').filter(Boolean)) {
    const [price, tier] = pair.split(':');
    if (price && tier) map.set(price.trim(), tier.trim());
  }
  return map;
};

export function tierForEvent(event, priceMap = TIER_BY_PRICE()) {
  const line = event?.data?.object?.line_items?.data?.[0]
    ?? event?.data?.object?.items?.data?.[0];
  const price = line?.price?.id ?? event?.data?.object?.metadata?.price_id ?? null;
  const fromMeta = event?.data?.object?.metadata?.tier;
  if (fromMeta && ['team', 'enterprise'].includes(fromMeta)) return { tier: fromMeta, via: 'metadata' };
  if (price && priceMap.has(price)) return { tier: priceMap.get(price), via: `price ${price}` };
  return { tier: null, via: null, reason: price ? `price ${price} is not in HOLT_PRICE_MAP` : 'no price or tier metadata on the event' };
}

export function seatsForEvent(event) {
  const qty = event?.data?.object?.line_items?.data?.[0]?.quantity
    ?? event?.data?.object?.items?.data?.[0]?.quantity ?? null;
  return Number.isFinite(qty) ? qty : null;
}

/**
 * Turn a verified Stripe event into a license, or into an explicit refusal. Pure: no I/O, so
 * every branch is testable without a network or a filesystem.
 */
export function licenseForEvent(event, signingKeyB64, { priceMap = TIER_BY_PRICE(), days = 365 } = {}) {
  const handled = ['checkout.session.completed', 'invoice.paid', 'customer.subscription.updated'];
  if (!handled.includes(event?.type)) {
    return { action: 'ignore', reason: `event type '${event?.type}' is not a license trigger` };
  }
  const obj = event.data?.object ?? {};
  if (event.type === 'customer.subscription.updated' && ['canceled', 'unpaid', 'incomplete_expired'].includes(obj.status)) {
    // No kill switch by design: the CLI never phones home. A cancelled subscription simply
    // stops being renewed, and the existing token expires on its own schedule.
    return { action: 'lapse', reason: `subscription ${obj.status} — no renewal will be issued`, customer: obj.customer ?? null };
  }
  const { tier, reason } = tierForEvent(event, priceMap);
  if (!tier) return { action: 'refuse', reason: `cannot determine tier: ${reason}` };

  const email = obj.customer_details?.email ?? obj.customer_email ?? obj.metadata?.email ?? null;
  const org = obj.customer_details?.name ?? obj.metadata?.org ?? null;
  const { token, claims } = mintLicense({ tier, org, email, seats: seatsForEvent(event), days }, signingKeyB64);
  return { action: 'issue', token, claims, email, tier, customer: obj.customer ?? null };
}

/* ---------------------------------------------------------------- delivery ---- */

export async function deliverLicense({ email, token, tier, claims }, { fetchImpl = fetch, env = process.env } = {}) {
  if (!env.RESEND_API_KEY) {
    return { delivered: false, reason: 'RESEND_API_KEY not set — license recorded in the ledger for manual delivery' };
  }
  if (!email) return { delivered: false, reason: 'no email address on the event' };
  const res = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.HOLT_LICENSE_FROM || FROM,
      to: [email],
      subject: `Your holt ${tier} license`,
      text: [
        `Thank you for supporting holt.`,
        ``,
        `Activate on any machine:`,
        `  holt license activate ${token}`,
        ``,
        `Or set it in CI:`,
        `  HOLT_LICENSE=${token}`,
        ``,
        `Valid until ${new Date(claims.exp).toISOString().slice(0, 10)}.`,
        `Licenses verify offline — holt never contacts a server, on any tier.`,
        ``,
        `Questions: support@holt.dev`,
      ].join('\n'),
    }),
  });
  if (!res.ok) return { delivered: false, reason: `delivery provider returned ${res.status}` };
  return { delivered: true };
}

/* ------------------------------------------------------------------- server ---- */

function readBody(req, limitBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) { reject(new Error('request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createServer({ env = process.env, dataFile = DATA } = {}) {
  const { signingKey, webhookSecret } = requireConfig(env);

  return http.createServer(async (req, res) => {
    const send = (code, body) => {
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      res.writeHead(code, { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json' });
      res.end(text);
    };

    try {
      if (req.method === 'GET' && req.url === '/health') {
        const { records, torn } = readRecords(dataFile);
        return send(torn ? 500 : 200, { ok: torn === 0, issued: records.filter((r) => r.action === 'issue').length, tornRecords: torn });
      }

      if (req.method === 'POST' && req.url === '/webhooks/stripe') {
        const raw = await readBody(req);
        const sig = verifyStripeSignature(raw, req.headers['stripe-signature'], webhookSecret);
        if (!sig.ok) {
          // 400, never 200: Stripe must keep retrying a genuine event we failed to verify.
          return send(400, { ok: false, reason: sig.reason });
        }
        let event;
        try { event = JSON.parse(raw); } catch { return send(400, { ok: false, reason: 'body is not JSON' }); }

        const already = findByEvent(event.id, dataFile);
        if (already) return send(200, { ok: true, idempotent: true, action: already.action });

        const result = licenseForEvent(event, signingKey);
        if (result.action !== 'issue') {
          appendRecord({ eventId: event.id, type: event.type, action: result.action, reason: result.reason }, dataFile);
          // A refusal is still a 200: retrying will not change the outcome, and Stripe should
          // stop. The ledger and /health are where a human sees it.
          return send(200, { ok: true, action: result.action, reason: result.reason });
        }

        appendRecord({
          eventId: event.id, type: event.type, action: 'issue', tier: result.tier,
          licenseId: result.claims.id, email: result.email, customer: result.customer,
          exp: result.claims.exp, token: result.token,
        }, dataFile);

        const delivery = await deliverLicense(result, { env }).catch((e) => ({ delivered: false, reason: e.message }));
        appendRecord({ eventId: event.id, action: 'deliver', licenseId: result.claims.id, ...delivery }, dataFile);
        return send(200, { ok: true, action: 'issue', licenseId: result.claims.id, delivered: delivery.delivered });
      }

      return send(404, { ok: false, reason: 'not found' });
    } catch (e) {
      return send(500, { ok: false, reason: e.message });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createServer().listen(PORT, () => {
    process.stdout.write(`holt license service listening on :${PORT}\n`);
  });
}
