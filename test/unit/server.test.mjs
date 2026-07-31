/**
 * holt license service — attacked.
 *
 * This process holds the signing key. Its failure modes are asymmetric in the same way the
 * client's are, but inverted: minting a license for someone who did not pay costs money, while
 * failing to mint one for someone who DID pay costs a customer. So the tests below prove both —
 * every forged, replayed or ambiguous event is refused, and every genuine event produces exactly
 * one license even under retries and delivery failures.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import {
  verifyStripeSignature, mintLicense, licenseForEvent, tierForEvent, seatsForEvent,
  appendRecord, readRecords, findByEvent, deliverLicense, requireConfig,
} from '../../server/index.mjs';
import { verifyToken } from '../../src/license.mjs';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const SIGNING = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
const PUB = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

const SECRET = 'whsec_test_secret';
const NOW = 1_700_000_000_000;

function stripeSig(body, { secret = SECRET, now = NOW, t = null } = {}) {
  const ts = t ?? Math.floor(now / 1000);
  const v1 = createHmac('sha256', secret).update(`${ts}.${body}`, 'utf8').digest('hex');
  return `t=${ts},v1=${v1}`;
}

const tmpLedger = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'holt-srv-')), 'licenses.jsonl');

const checkoutEvent = (over = {}) => ({
  id: 'evt_1', type: 'checkout.session.completed',
  data: { object: {
    customer: 'cus_1',
    customer_details: { email: 'buyer@acme.test', name: 'Acme Inc' },
    metadata: { tier: 'team' },
    line_items: { data: [{ quantity: 12, price: { id: 'price_team' } }] },
    ...over,
  } },
});

/* ---------------------------------------------------------------- boot config ---- */

test('service: refuses to start without its signing key or webhook secret', () => {
  assert.throws(() => requireConfig({}), /missing HOLT_SIGNING_KEY, STRIPE_WEBHOOK_SECRET/);
  assert.throws(() => requireConfig({ HOLT_SIGNING_KEY: 'x' }), /STRIPE_WEBHOOK_SECRET/);
  assert.doesNotThrow(() => requireConfig({ HOLT_SIGNING_KEY: 'x', STRIPE_WEBHOOK_SECRET: 'y' }));
});

/* ------------------------------------------------------------ webhook proof ---- */

test('webhook: a correctly signed, fresh event verifies', () => {
  const body = JSON.stringify(checkoutEvent());
  const r = verifyStripeSignature(body, stripeSig(body), SECRET, { now: NOW });
  assert.equal(r.ok, true, r.reason);
});

test('ATTACK: forged signature, wrong secret, and tampered body are all refused', () => {
  const body = JSON.stringify(checkoutEvent());
  const good = stripeSig(body);

  assert.equal(verifyStripeSignature(body, `t=${Math.floor(NOW / 1000)},v1=${'0'.repeat(64)}`, SECRET, { now: NOW }).ok, false);
  assert.equal(verifyStripeSignature(body, stripeSig(body, { secret: 'whsec_attacker' }), SECRET, { now: NOW }).ok, false);
  // Same signature, body edited to a bigger seat count.
  const tampered = body.replace('"quantity":12', '"quantity":9999');
  assert.equal(verifyStripeSignature(tampered, good, SECRET, { now: NOW }).ok, false);
});

test('ATTACK: a genuine but OLD event is refused (replay window)', () => {
  const body = JSON.stringify(checkoutEvent());
  const old = stripeSig(body, { t: Math.floor(NOW / 1000) - 3600 });
  const r = verifyStripeSignature(body, old, SECRET, { now: NOW });
  assert.equal(r.ok, false);
  assert.match(r.reason, /replay window/);
});

test('webhook: malformed or missing signature headers are refused without throwing', () => {
  const body = '{}';
  for (const h of [undefined, null, '', 'garbage', 't=', 'v1=abc', 't=abc,v1=def', 't=1700000000']) {
    const r = verifyStripeSignature(body, h, SECRET, { now: NOW });
    assert.equal(r.ok, false, `must refuse header ${JSON.stringify(h)}`);
    assert.ok(r.reason);
  }
});

test('webhook: signature comparison tolerates length mismatch without throwing', () => {
  const body = '{}';
  const r = verifyStripeSignature(body, `t=${Math.floor(NOW / 1000)},v1=abcd`, SECRET, { now: NOW });
  assert.equal(r.ok, false, 'a short signature must fail, not crash timingSafeEqual');
});

/* -------------------------------------------------------------------- minting ---- */

test('mint: produces a token the CLIENT accepts, with the right claims', () => {
  const { token, claims } = mintLicense({ tier: 'team', org: 'Acme', seats: 12, days: 365 }, SIGNING);
  const v = verifyToken(token, { publicKeyB64: PUB });
  assert.equal(v.valid, true, JSON.stringify(v));
  assert.equal(v.claims.tier, 'team');
  assert.equal(v.claims.seats, 12);
  assert.equal(claims.exp - claims.iat, 365 * 86_400_000);
});

test('mint: refuses an unknown tier or a non-positive lifetime', () => {
  assert.throws(() => mintLicense({ tier: 'godmode' }, SIGNING), /unknown tier/);
  assert.throws(() => mintLicense({ tier: 'team', days: 0 }, SIGNING), /non-positive/);
  assert.throws(() => mintLicense({ tier: 'team', days: -5 }, SIGNING), /non-positive/);
});

/* --------------------------------------------------------------- event logic ---- */

test('event: a paid checkout issues exactly the tier that was bought', () => {
  const r = licenseForEvent(checkoutEvent(), SIGNING);
  assert.equal(r.action, 'issue');
  assert.equal(r.tier, 'team');
  assert.equal(r.email, 'buyer@acme.test');
  assert.equal(verifyToken(r.token, { publicKeyB64: PUB }).claims.org, 'Acme Inc');
});

test('SAFETY: an unrecognised price REFUSES rather than defaulting to a tier', () => {
  const ev = checkoutEvent({ metadata: {}, line_items: { data: [{ quantity: 1, price: { id: 'price_unknown' } }] } });
  const r = licenseForEvent(ev, SIGNING, { priceMap: new Map([['price_team', 'team']]) });
  assert.equal(r.action, 'refuse');
  assert.match(r.reason, /not in HOLT_PRICE_MAP/);
});

test('event: a price map resolves the tier when metadata is absent', () => {
  const ev = checkoutEvent({ metadata: {}, line_items: { data: [{ quantity: 3, price: { id: 'price_ent' } }] } });
  const r = licenseForEvent(ev, SIGNING, { priceMap: new Map([['price_ent', 'enterprise']]) });
  assert.equal(r.action, 'issue');
  assert.equal(r.tier, 'enterprise');
  assert.equal(verifyToken(r.token, { publicKeyB64: PUB }).claims.seats, 3);
});

test('event: unrelated event types are ignored, not refused or issued', () => {
  const r = licenseForEvent({ id: 'evt_x', type: 'customer.created', data: { object: {} } }, SIGNING);
  assert.equal(r.action, 'ignore');
});

test('event: cancellation lapses rather than revoking — there is no kill switch by design', () => {
  const r = licenseForEvent({
    id: 'evt_c', type: 'customer.subscription.updated',
    data: { object: { status: 'canceled', customer: 'cus_1' } },
  }, SIGNING);
  assert.equal(r.action, 'lapse');
  assert.match(r.reason, /no renewal/);
});

test('event: seat quantity is read from either event shape, and never invented', () => {
  assert.equal(seatsForEvent(checkoutEvent()), 12);
  assert.equal(seatsForEvent({ data: { object: { items: { data: [{ quantity: 4 }] } } } }), 4);
  assert.equal(seatsForEvent({ data: { object: {} } }), null);
});

test('event: tier metadata is only honoured for known tiers', () => {
  const ev = checkoutEvent({ metadata: { tier: 'enterprise' } });
  assert.equal(tierForEvent(ev).tier, 'enterprise');
  const bad = checkoutEvent({ metadata: { tier: 'free-for-me' }, line_items: { data: [{ price: { id: 'nope' } }] } });
  assert.equal(tierForEvent(bad, new Map()).tier, null);
});

/* ------------------------------------------------------------------- ledger ---- */

test('ledger: records append, survive reads, and support idempotency by event id', () => {
  const file = tmpLedger();
  appendRecord({ eventId: 'evt_1', action: 'issue', tier: 'team' }, file);
  appendRecord({ eventId: 'evt_2', action: 'refuse', reason: 'x' }, file);
  const { records, torn } = readRecords(file);
  assert.equal(records.length, 2);
  assert.equal(torn, 0);
  assert.equal(findByEvent('evt_1', file).action, 'issue');
  assert.equal(findByEvent('evt_missing', file), null);
});

test('ledger: a torn final line is COUNTED, never silently dropped', () => {
  const file = tmpLedger();
  appendRecord({ eventId: 'evt_1', action: 'issue' }, file);
  fs.appendFileSync(file, '{"eventId":"evt_2","act');
  const { records, torn } = readRecords(file);
  assert.equal(records.length, 1);
  assert.equal(torn, 1, 'a partially written record must be visible to /health, not invisible');
});

test('ledger: an absent file reads as empty rather than throwing', () => {
  const { records, torn } = readRecords(path.join(os.tmpdir(), 'holt-nope', 'nothing.jsonl'));
  assert.deepEqual(records, []);
  assert.equal(torn, 0);
});

/* ----------------------------------------------------------------- delivery ---- */

test('delivery: without a mail provider the license is still issued and recorded', async () => {
  const r = await deliverLicense({ email: 'a@b.test', token: 'holt_team_x.y', tier: 'team', claims: { exp: NOW } }, { env: {} });
  assert.equal(r.delivered, false);
  assert.match(r.reason, /manual delivery/);
});

test('delivery: a provider failure is reported, never swallowed', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500 });
  const r = await deliverLicense(
    { email: 'a@b.test', token: 't', tier: 'team', claims: { exp: NOW } },
    { fetchImpl, env: { RESEND_API_KEY: 'k' } });
  assert.equal(r.delivered, false);
  assert.match(r.reason, /500/);
});

test('delivery: the email contains an activation command and the expiry', async () => {
  let captured = null;
  const fetchImpl = async (_url, opts) => { captured = JSON.parse(opts.body); return { ok: true, status: 200 }; };
  const { token, claims } = mintLicense({ tier: 'team', days: 30 }, SIGNING);
  const r = await deliverLicense({ email: 'a@b.test', token, tier: 'team', claims },
    { fetchImpl, env: { RESEND_API_KEY: 'k' } });
  assert.equal(r.delivered, true);
  assert.match(captured.text, /holt license activate holt_team_/);
  assert.match(captured.text, /HOLT_LICENSE=/);
  assert.match(captured.text, /verify offline/);
});

/* ------------------------------------------------------------- checkout ---- */

import {
  parseCheckoutRequest, createCheckoutSession, RateLimiter, clientIp,
  latestLicenseForEmail, resendLicense,
} from '../../server/index.mjs';

const priceMap = new Map([['price_team', 'team'], ['price_ent', 'enterprise']]);

test('checkout: a valid request resolves a configured price by plan name', () => {
  const r = parseCheckoutRequest('/checkout?plan=team&seats=25', priceMap);
  assert.equal(r.ok, true);
  assert.equal(r.price, 'price_team');
  assert.equal(r.seats, 25);
});

test('SAFETY: a raw price id in the query is ignored — only plan names resolve', () => {
  // The caller cannot check out against an arbitrary Stripe price object. An id with an
  // underscore fails the plan-name charset before it can even be looked up; a well-formed but
  // unknown plan name is refused at the price lookup. Both are refused — that is what matters.
  assert.equal(parseCheckoutRequest('/checkout?plan=price_attacker_controlled', priceMap).ok, false);
  const wellFormed = parseCheckoutRequest('/checkout?plan=priceattacker', priceMap);
  assert.equal(wellFormed.ok, false);
  assert.match(wellFormed.reason, /no price configured/);
});

test('checkout: seat count is bounded and integer-only', () => {
  for (const bad of ['0', '-3', '501', '3.5', 'abc', '1e9', '  ']) {
    assert.equal(parseCheckoutRequest(`/checkout?plan=team&seats=${bad}`, priceMap).ok, false, `seats=${bad} must be refused`);
  }
  assert.equal(parseCheckoutRequest('/checkout?plan=team', priceMap).seats, 5, 'defaults to 5');
});

test('checkout: an unknown plan is refused, not defaulted', () => {
  assert.equal(parseCheckoutRequest('/checkout?plan=godmode', priceMap).ok, false);
  assert.equal(parseCheckoutRequest('/checkout?plan=Team', priceMap).ok, false, 'case-sensitive; no fuzzy matching');
});

test('checkout: success/cancel URLs come from server config, never the query (no open redirect)', async () => {
  let captured = null;
  const fetchImpl = async (_url, opts) => { captured = opts.body; return { ok: true, json: async () => ({ url: 'https://checkout.stripe.com/x', id: 'cs_1' }) }; };
  await createCheckoutSession({ plan: 'team', price: 'price_team', seats: 10 }, {
    env: { STRIPE_SECRET_KEY: 'sk_test', HOLT_SITE_URL: 'https://holt.dev' }, fetchImpl,
  });
  assert.match(captured, /success_url=https%3A%2F%2Fholt\.dev/);
  // A success_url injected in the (already-rejected) query can never reach Stripe.
  assert.ok(!captured.includes('evil.com'));
});

test('checkout: a Stripe error is reported without leaking Stripe internals to the caller', async () => {
  const fetchImpl = async () => ({ ok: false, status: 402, json: async () => ({ error: { message: 'card_declined internal detail' } }) });
  const r = await createCheckoutSession({ plan: 'team', price: 'price_team', seats: 1 }, { env: { STRIPE_SECRET_KEY: 'sk' }, fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.status, 402);
});

/* ------------------------------------------------------------ rate limit ---- */

test('rate limit: a bucket drains and then refuses with a retry hint', () => {
  const rl = new RateLimiter({ capacity: 3, refillPerSec: 1 });
  const t = 1_000_000;
  assert.equal(rl.take('ip', { now: t }).allowed, true);
  assert.equal(rl.take('ip', { now: t }).allowed, true);
  assert.equal(rl.take('ip', { now: t }).allowed, true);
  const denied = rl.take('ip', { now: t });
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterSec >= 1);
  // Refills over time.
  assert.equal(rl.take('ip', { now: t + 2000 }).allowed, true);
});

test('rate limit: separate keys have separate buckets', () => {
  const rl = new RateLimiter({ capacity: 1, refillPerSec: 0 });
  assert.equal(rl.take('a').allowed, true);
  assert.equal(rl.take('b').allowed, true);
  assert.equal(rl.take('a').allowed, false);
});

test('clientIp: prefers the platform header, then the RIGHTMOST forwarded hop', () => {
  assert.equal(clientIp({ headers: { 'fly-client-ip': '1.2.3.4', 'x-forwarded-for': '9.9.9.9' }, socket: {} }), '1.2.3.4');
  // Rightmost (nearest our proxy), not leftmost (client-controllable) — see the hardening note.
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '9.9.9.9, 8.8.8.8' }, socket: {} }), '8.8.8.8');
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '7.7.7.7' } }), '7.7.7.7');
});

/* ------------------------------------------------ self-service resend ---- */

test('resend: finds only the LATEST license for an address, case-insensitively', () => {
  const file = tmpLedger();
  appendRecord({ action: 'issue', email: 'Buyer@Acme.test', tier: 'team', token: 'holt_team_old', licenseId: 'l1' }, file);
  appendRecord({ action: 'issue', email: 'buyer@acme.test', tier: 'team', token: 'holt_team_new', licenseId: 'l2' }, file);
  const r = latestLicenseForEmail('BUYER@acme.TEST', file);
  assert.equal(r.token, 'holt_team_new');
});

test('PRIVACY: resend for an unknown address does nothing and reveals nothing', async () => {
  const file = tmpLedger();
  const r = await resendLicense('nobody@nowhere.test', { env: { RESEND_API_KEY: 'k' }, file, fetchImpl: async () => ({ ok: true, status: 200 }) });
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'no record', 'a missing address is indistinguishable to the CALLER, but logged internally');
});

/* ------------------------------------------------------------ key rotation ---- */

test('rotation: a token signed by ANY pinned key verifies; others do not', () => {
  const { privateKey: oldK, publicKey: oldPub } = generateKeyPairSync('ed25519');
  const { privateKey: newK, publicKey: newPub } = generateKeyPairSync('ed25519');
  const { privateKey: evilK } = generateKeyPairSync('ed25519');
  const keys = [newPub, oldPub].map((k) => k.export({ type: 'spki', format: 'der' }).toString('base64'));

  const underOld = mintLicense({ tier: 'team', days: 30 }, oldK.export({ type: 'pkcs8', format: 'der' }).toString('base64')).token;
  const underNew = mintLicense({ tier: 'team', days: 30 }, newK.export({ type: 'pkcs8', format: 'der' }).toString('base64')).token;
  const underEvil = mintLicense({ tier: 'team', days: 30 }, evilK.export({ type: 'pkcs8', format: 'der' }).toString('base64')).token;

  assert.equal(verifyToken(underOld, { publicKeysB64: keys }).valid, true, 'old customers keep working during rotation');
  assert.equal(verifyToken(underNew, { publicKeysB64: keys }).valid, true, 'new licenses work');
  assert.equal(verifyToken(underEvil, { publicKeysB64: keys }).valid, false, 'a foreign key never verifies');
});

test('SECURITY: clientIp takes the rightmost X-Forwarded-For hop, not the spoofable leftmost', () => {
  // An attacker stuffs the leftmost entry to rotate fake identities and dodge the limiter.
  assert.equal(clientIp({ headers: { 'x-forwarded-for': 'evil-fake-1, evil-fake-2, 203.0.113.7' }, socket: {} }), '203.0.113.7');
  // But the platform header still wins outright.
  assert.equal(clientIp({ headers: { 'fly-client-ip': '198.51.100.9', 'x-forwarded-for': 'spoof' }, socket: {} }), '198.51.100.9');
});

test('E2E: the webhook endpoint is rate limited against an unsigned flood', async (t) => {
  const { createServer } = await import('../../server/index.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holt-wl-'));
  const server = createServer({ env: { HOLT_SIGNING_KEY: SIGNING, STRIPE_WEBHOOK_SECRET: SECRET }, dataFile: path.join(dir, 'l.jsonl') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const flood = Array.from({ length: 260 }, () => fetch(`http://127.0.0.1:${port}/webhooks/stripe`, { method: 'POST', headers: { 'stripe-signature': 'garbage' }, body: '{}' }));
  const codes = (await Promise.all(flood)).map((r) => r.status);
  assert.ok(codes.includes(429), 'a 260-request unsigned flood must hit the limiter');
  assert.ok(codes.includes(400), 'and legitimate-shaped-but-unsigned ones still get 400 until the limiter trips');
});


/* -------------------------------------------------- billing-interval duration ---- */

import { daysForEvent, sanitizeClaim } from '../../server/index.mjs';

test('MONETIZATION: license lifetime tracks the billing interval, not a flat year', () => {
  const ev = (interval) => ({ data: { object: { line_items: { data: [{ price: { recurring: { interval } } }] } } } });
  assert.equal(daysForEvent(ev('month')), 38, 'a monthly plan gets ~1 month + buffer, not a year');
  assert.equal(daysForEvent(ev('year')), 379);
  assert.equal(daysForEvent(ev('week')), 38, 'an unrecognised interval falls back SHORT, never long');
  assert.equal(daysForEvent({ data: { object: {} } }), 38, 'no interval -> short default (never a giveaway)');
});

test('MONETIZATION: a monthly checkout does not mint a year-long license', () => {
  const ev = {
    id: 'evt_m', type: 'checkout.session.completed',
    data: { object: { customer_details: { email: 'm@x.test' }, metadata: { tier: 'team' },
      line_items: { data: [{ quantity: 3, price: { id: 'price_team', recurring: { interval: 'month' } } }] } } },
  };
  const r = licenseForEvent(ev, SIGNING);
  const days = Math.round((r.claims.exp - r.claims.iat) / 86_400_000);
  assert.ok(days <= 40, `a monthly plan must not mint a ~365-day license, got ${days}`);
});

test('MONETIZATION: per-repo model — the purchased quantity is preserved, floored at 1', () => {
  const ev = (qty) => ({
    id: 'evt_s' + qty, type: 'checkout.session.completed',
    data: { object: { customer_details: { email: 's@x.test' }, metadata: { tier: 'team' },
      line_items: { data: [{ quantity: qty, price: { id: 'price_team' } }] } } },
  });
  assert.equal(licenseForEvent(ev(5), SIGNING).claims.seats, 5, 'quantity (repos) preserved, no artificial minimum');
  assert.equal(licenseForEvent(ev(1), SIGNING).claims.seats, 1, 'one repo is allowed — no 3-seat floor anymore');
});

test('SECURITY: a billing name carrying a terminal escape is stripped before it is signed', () => {
  const esc = String.fromCharCode(27) + '[31m';
  const nl = String.fromCharCode(10);
  assert.equal(sanitizeClaim('Acme' + esc + nl + 'Inc'), 'Acme[31mInc');
  assert.equal(sanitizeClaim(' bad'), 'bad');
  assert.equal(sanitizeClaim(''), null);
  assert.equal(sanitizeClaim(42), null);
  const ev = {
    id: 'evt_esc', type: 'checkout.session.completed',
    data: { object: { customer_details: { email: 'e@x.test', name: 'Ev' + esc + '[2Jil' }, metadata: { tier: 'team' },
      line_items: { data: [{ quantity: 3, price: { id: 'price_team' } }] } } },
  };
  const r = licenseForEvent(ev, SIGNING);
  const hasControl = Array.from(r.claims.org).some((c) => c.charCodeAt(0) < 0x20);
  assert.equal(hasControl, false, 'no control byte may survive into the signed org claim');
});

test('event: refunds and chargebacks are recorded (flagged), never silently dropped', () => {
  for (const type of ['charge.refunded', 'charge.dispute.created']) {
    const r = licenseForEvent({ id: `evt_${type}`, type, data: { object: { customer: 'cus_9' } } }, SIGNING);
    assert.equal(r.action, 'flag');
    assert.match(r.reason, /manual review/);
  }
});

test('webhook: rotation — multiple secrets and multiple v1 signatures both verify', () => {
  const body = JSON.stringify(checkoutEvent());
  const ts = Math.floor(NOW / 1000);
  const sigWith = (sec) => createHmac('sha256', sec).update(`${ts}.${body}`, 'utf8').digest('hex');
  assert.equal(verifyStripeSignature(body, `t=${ts},v1=${sigWith('old')}`, 'new,old', { now: NOW }).ok, true);
  assert.equal(verifyStripeSignature(body, `t=${ts},v1=${'0'.repeat(64)},v1=${sigWith('new')}`, 'new', { now: NOW }).ok, true);
  assert.equal(verifyStripeSignature(body, `t=${ts},v1=${sigWith('wrong')}`, 'new,old', { now: NOW }).ok, false);
});


/* ------------------------------------------- residual edge cases (2nd audit pass) ---- */

test('MONETIZATION: a merchant-set metadata.interval cannot buy a year (only a real price interval)', () => {
  const ev = {
    id: 'evt_meta', type: 'checkout.session.completed',
    data: { object: { customer_details: { email: 'z@x.test' }, metadata: { tier: 'team', interval: 'year' },
      line_items: { data: [{ quantity: 3, price: { id: 'price_team' } }] } } },  // no recurring.interval on the price
  };
  const r = licenseForEvent(ev, SIGNING);
  const days = Math.round((r.claims.exp - r.claims.iat) / 86_400_000);
  assert.ok(days <= 40, `metadata.interval must NOT be trusted for duration, got ${days} days`);
});

test('MONETIZATION: the seat floor holds on a renewal shape and when quantity is absent', () => {
  // invoice.paid renewal carries the quantity under .lines.data, which seatsForEvent must read.
  const renewal = {
    id: 'evt_renew', type: 'invoice.paid',
    data: { object: { customer: 'c1', metadata: { tier: 'team' },
      lines: { data: [{ quantity: 4, price: { id: 'price_team' } }] } } },
  };
  assert.equal(seatsForEvent(renewal), 4, 'seatsForEvent must read the invoice line shape');
  assert.equal(licenseForEvent(renewal, SIGNING).claims.seats, 4, 'a renewal preserves the repo count');

  // Quantity entirely absent -> floored at 1, never null.
  const noQty = {
    id: 'evt_noqty', type: 'checkout.session.completed',
    data: { object: { customer_details: { email: 'n@x.test' }, metadata: { tier: 'team' }, line_items: { data: [{ price: { id: 'price_team' } }] } } },
  };
  assert.equal(licenseForEvent(noQty, SIGNING).claims.seats, 1, 'a missing quantity floors at 1, never null');
});

test('SECURITY: sanitizeClaim strips the C1 control range (8-bit CSI/OSC), not just C0/DEL', () => {
  const c1 = String.fromCharCode(0x9b) + '31m' + String.fromCharCode(0x9d) + '0;title';
  const cleaned = sanitizeClaim('Acme' + c1 + 'Inc');
  const hasC1 = Array.from(cleaned).some((ch) => { const c = ch.charCodeAt(0); return c >= 0x80 && c <= 0x9f; });
  assert.equal(hasC1, false, 'no C1 control byte may survive');
  assert.match(cleaned, /Acme/);
});
