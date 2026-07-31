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
