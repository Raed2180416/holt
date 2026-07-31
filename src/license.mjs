// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — offline entitlement verification.
 *
 * DESIGN CONSTRAINTS, in priority order:
 *
 *   1. The free tool must never break. Every failure path here degrades to "no entitlement",
 *      and no free command consults this module at all. A corrupt, forged, expired, or absent
 *      license can only ever cost you a PAID feature — never a working one.
 *   2. No network, ever. Verification is a local Ed25519 signature check against a public key
 *      compiled into the binary. holt promises zero telemetry and zero outbound calls; a
 *      license system that phones home would break that promise for the customers who care
 *      about it most. Revocation is therefore expressed as short expiry, not as a live check.
 *   3. Tamper-EVIDENT, not tamper-proof. The source is public: anyone can patch the check out.
 *      That is true of every open-core tool and is a licensing matter, not a technical one.
 *      What the signature guarantees is that a license cannot be FORGED or EDITED — an
 *      organisation cannot accidentally believe it is compliant when it is not.
 *
 * TOKEN FORMAT (compact, greppable, safe to paste in CI):
 *
 *     holt_<tier>_<base64url(payload)>.<base64url(ed25519 signature)>
 *
 * The signature covers the base64url payload STRING exactly as transmitted — never a
 * re-serialised object. Re-serialising before verifying is the classic canonicalisation hole:
 * two different byte strings that parse to the same object would then share one signature.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPublicKey, verify as edVerify } from 'node:crypto';

/**
 * Ed25519 public key (SPKI, base64). The matching private key never exists in this repository.
 *
 * Overridable ONLY as a function argument, never from the environment. An env-var override would
 * be a forgery hole: anyone could point holt at a key they control and mint their own licenses.
 * A caller who can pass an argument can already edit this file, so the parameter grants nothing
 * new — it exists so the test suite can exercise the crypto with a throwaway keypair.
 */
const LICENSE_PUBLIC_KEY_B64 = 'MCowBQYDK2VwAyEAEg0pQuXYxzS1ftB+WAclS0QsFAd1eEXZBR6GtJOFDco=';

/**
 * KEY ROTATION. Every key in this list is trusted; the first is the one new licenses are
 * signed with. If the signing key is ever compromised: generate a new pair, prepend the new
 * public key here, ship a release, re-issue active customers' licenses under the new key, and
 * after the longest outstanding license under the old key has expired, remove it. Old licenses
 * keep verifying throughout — rotation must never brick a paying customer mid-term.
 */
const LICENSE_PUBLIC_KEYS_B64 = [LICENSE_PUBLIC_KEY_B64];

/** Days a license keeps working after `exp`. A failed card must not break a customer's CI at 3am. */
export const GRACE_DAYS = 14;

/** Tiers, ordered. A tier entitles everything at or below it. */
export const TIERS = ['free', 'team', 'enterprise'];

/**
 * Feature -> minimum tier. Everything absent from this table is FREE, which is the safe default:
 * a new feature is free until somebody deliberately prices it.
 */
export const FEATURE_TIER = {
  // Deliberately NOT priced, because each is either the adoption wedge or the user's own data:
  //   - `holt ci` with inline flags: a single repo failing its own build on unlanded work.
  //   - `holt journal` and its --export: one repo's audit log is the user's own data, and
  //     `journal --json` already prints all of it. A gate there would be illusory, so there is
  //     none. The PAID audit product is fleet-level aggregation and the streaming webhook sink.
  // What a TEAM pays for is managing this centrally, across repos, with policy and a paper trail.
  'policy-file': 'team',      // .holt/policy.json — policy as code, richer rules than flags
  fleet: 'team',              // multi-repo aggregation
  'audit-sink': 'team',       // continuous export of the journal to an external system (webhook)
  sso: 'enterprise',
  'air-gap': 'enterprise',
};

export class LicenseError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'LicenseError';
    this.code = code;
  }
}

function b64urlToBuf(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

/** Where a license lives, most specific first. Env beats disk so CI needs no file. */
export function licensePaths() {
  const home = os.homedir();
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return [path.join(xdg, 'holt', 'license')];
}

export function readLicenseToken({ env = process.env } = {}) {
  const fromEnv = env.HOLT_LICENSE?.trim();
  if (fromEnv) return { token: fromEnv, source: 'HOLT_LICENSE' };
  for (const p of licensePaths()) {
    try {
      const token = fs.readFileSync(p, 'utf8').trim();
      if (token) return { token, source: p };
    } catch { /* absent is normal and not an error */ }
  }
  return { token: null, source: null };
}

/**
 * Verify a token. Pure and synchronous: no I/O, no clock surprises beyond `now`.
 *
 * @returns {{valid: boolean, reason?: string, code?: string, claims?: object, expired?: boolean,
 *            inGrace?: boolean, daysLeft?: number|null}}
 */
export function verifyToken(token, { now = Date.now(), publicKeyB64 = null, publicKeysB64 = LICENSE_PUBLIC_KEYS_B64 } = {}) {
  if (typeof token !== 'string' || !token) {
    return { valid: false, code: 'absent', reason: 'no license present' };
  }
  // Structure first: a malformed string must never reach the crypto layer.
  const m = /^holt_([a-z]+)_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token.trim());
  if (!m) return { valid: false, code: 'malformed', reason: 'not a holt license token' };
  const [, tierHint, payloadB64, sigB64] = m;

  // Any pinned key may verify (rotation), but the list is compiled in — a token can never
  // nominate its own key, which is the JWK/x5c mistake this format refuses to inherit.
  const keys = publicKeyB64 ? [publicKeyB64] : publicKeysB64;
  let ok = false;
  try {
    for (const kb64 of keys) {
      const key = createPublicKey({
        key: Buffer.from(kb64, 'base64'), format: 'der', type: 'spki',
      });
      // Signed over the transmitted payload STRING — never over a re-serialised object.
      if (edVerify(null, Buffer.from(payloadB64, 'utf8'), key, b64urlToBuf(sigB64))) { ok = true; break; }
    }
  } catch {
    return { valid: false, code: 'bad-signature', reason: 'signature could not be verified' };
  }
  if (!ok) return { valid: false, code: 'bad-signature', reason: 'signature does not match — this license was edited or forged' };

  let claims;
  try {
    claims = JSON.parse(b64urlToBuf(payloadB64).toString('utf8'));
  } catch {
    return { valid: false, code: 'bad-payload', reason: 'license payload is not valid JSON' };
  }
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
    return { valid: false, code: 'bad-payload', reason: 'license payload is not an object' };
  }
  if (claims.v !== 1) {
    return { valid: false, code: 'unsupported-version', reason: `license format v${claims.v} is newer than this holt understands — upgrade holt` };
  }
  if (!TIERS.includes(claims.tier)) {
    return { valid: false, code: 'unknown-tier', reason: `unknown tier '${claims.tier}'` };
  }
  // The prefix is a convenience for humans reading a key; it is NOT authority. If it disagrees
  // with the signed payload, the token is rejected rather than silently trusting either one.
  if (tierHint !== claims.tier) {
    return { valid: false, code: 'tier-mismatch', reason: 'license prefix disagrees with its signed contents' };
  }
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) {
    return { valid: false, code: 'bad-payload', reason: 'license has no usable expiry' };
  }

  const graceMs = GRACE_DAYS * 86_400_000;
  const expired = now > claims.exp;
  const inGrace = expired && now <= claims.exp + graceMs;
  const daysLeft = Math.ceil((claims.exp - now) / 86_400_000);

  if (expired && !inGrace) {
    return {
      valid: false, code: 'expired', claims, expired: true, inGrace: false, daysLeft,
      reason: `license expired ${Math.abs(daysLeft)} day(s) ago (grace period of ${GRACE_DAYS} days has also passed)`,
    };
  }
  return { valid: true, claims, expired, inGrace, daysLeft };
}

/** Does `tier` entitle `feature`? */
export function tierEntitles(tier, feature) {
  const need = FEATURE_TIER[feature];
  if (!need) return true; // unpriced features are free by default
  return TIERS.indexOf(tier) >= TIERS.indexOf(need);
}

/**
 * The single question every paid code path asks. Never throws; the caller decides how to refuse,
 * and the refusal always states exactly what is missing and how to fix it.
 */
export function checkEntitlement(feature, { env = process.env, now = Date.now(), publicKeyB64 = null } = {}) {
  const need = FEATURE_TIER[feature];
  if (!need) return { entitled: true, tier: 'free', feature, reason: 'this feature is free' };

  const { token, source } = readLicenseToken({ env });
  const v = verifyToken(token, { now, publicKeyB64 });
  if (!v.valid) {
    return {
      entitled: false, tier: 'free', feature, need, source, code: v.code,
      reason: v.code === 'absent'
        ? `'${feature}' requires a holt ${need} license`
        : `holt ${need} license rejected: ${v.reason}`,
      fix: v.code === 'absent'
        ? 'Get one at https://holt.dev/pricing, then run: holt license activate <key>  (or set HOLT_LICENSE in CI)'
        : 'Run `holt license status` for details, or re-activate the key from your receipt.',
    };
  }
  if (!tierEntitles(v.claims.tier, feature)) {
    return {
      entitled: false, tier: v.claims.tier, feature, need, source, code: 'tier-too-low',
      reason: `'${feature}' requires the ${need} tier; this license is ${v.claims.tier}`,
      fix: 'Upgrade at https://holt.dev/pricing',
    };
  }
  return {
    entitled: true, tier: v.claims.tier, feature, source,
    org: v.claims.org ?? null, seats: v.claims.seats ?? null,
    inGrace: v.inGrace, daysLeft: v.daysLeft,
    warning: v.inGrace
      ? `license EXPIRED ${Math.abs(v.daysLeft)} day(s) ago — running on the ${GRACE_DAYS}-day grace period. Renew to avoid interruption.`
      : (v.daysLeft != null && v.daysLeft <= 14 ? `license expires in ${v.daysLeft} day(s)` : null),
  };
}

/** Full status for `holt license status` — never throws, always explains. */
export function licenseStatus({ env = process.env, now = Date.now(), publicKeyB64 = null } = {}) {
  const { token, source } = readLicenseToken({ env });
  const v = verifyToken(token, { now, publicKeyB64 });
  const features = Object.entries(FEATURE_TIER).map(([f, need]) => ({
    feature: f, need, entitled: v.valid ? tierEntitles(v.claims.tier, f) : false,
  }));
  if (!v.valid) {
    return {
      licensed: false, tier: 'free', source, code: v.code, reason: v.reason,
      features,
      note: 'holt free is fully functional. A license unlocks team and enterprise features only.',
    };
  }
  return {
    licensed: true, tier: v.claims.tier, source,
    org: v.claims.org ?? null, email: v.claims.email ?? null,
    seats: v.claims.seats ?? null, id: v.claims.id ?? null,
    issued: new Date(v.claims.iat ?? 0).toISOString(),
    expires: new Date(v.claims.exp).toISOString(),
    daysLeft: v.daysLeft, inGrace: v.inGrace,
    features,
  };
}

/** Persist a token after verifying it. Refuses to store anything that does not verify. */
export function activateLicense(token, { now = Date.now() } = {}) {
  const v = verifyToken(token, { now });
  if (!v.valid) throw new LicenseError(`refusing to store an invalid license: ${v.reason}`, v.code);
  const target = licensePaths()[0];
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Refuse to follow a symlink at the target: if the license path is a symlink (planted by a
  // shared-home attacker to redirect the write), O_NOFOLLOW makes the open fail rather than
  // writing through it to somewhere the caller did not intend. Truncate-and-create with 0600.
  let fd;
  try {
    fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
  } catch (e) {
    if (e.code === 'ELOOP') throw new LicenseError(`refusing to write through a symlink at ${target}`, 'unsafe-path');
    throw e;
  }
  try { fs.writeSync(fd, `${token.trim()}\n`); } finally { fs.closeSync(fd); }
  fs.chmodSync(target, 0o600); // in case the file pre-existed with looser bits
  return { stored: target, tier: v.claims.tier, org: v.claims.org ?? null, expires: new Date(v.claims.exp).toISOString() };
}

export function deactivateLicense() {
  const removed = [];
  for (const p of licensePaths()) {
    try { fs.rmSync(p); removed.push(p); } catch { /* absent is fine */ }
  }
  return { removed };
}

export const __test = { LICENSE_PUBLIC_KEY_B64 };
