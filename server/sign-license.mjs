#!/usr/bin/env node
/**
 * holt — license signer (operator tool, never shipped in the npm package).
 *
 * The private key is read from HOLT_SIGNING_KEY (base64 PKCS8) or --key-file. It must never be
 * committed, never be in the published tarball, and never leave the machine or secret store that
 * issues licenses.
 *
 *   HOLT_SIGNING_KEY=... node server/sign-license.mjs \
 *     --tier team --org "Acme Inc" --email billing@acme.com --seats 25 --days 365
 */

import fs from 'node:fs';
import { createPrivateKey, sign as edSign, randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const keyB64 = process.env.HOLT_SIGNING_KEY
  ?? (arg('key-file') ? fs.readFileSync(arg('key-file'), 'utf8').trim() : null);
if (!keyB64) {
  console.error('holt sign: no signing key (set HOLT_SIGNING_KEY or pass --key-file)');
  process.exit(2);
}

const tier = arg('tier', 'team');
if (!['team', 'enterprise'].includes(tier)) {
  console.error(`holt sign: tier must be team or enterprise, got '${tier}'`);
  process.exit(2);
}
const days = Number(arg('days', 365));
if (!(days > 0)) { console.error('holt sign: --days must be positive'); process.exit(2); }

const now = Date.now();
const claims = {
  v: 1,
  id: arg('id', randomUUID()),
  tier,
  org: arg('org', null),
  email: arg('email', null),
  seats: arg('seats') ? Number(arg('seats')) : null,
  iat: now,
  exp: now + days * 86_400_000,
};

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const payload = b64url(JSON.stringify(claims));
const key = createPrivateKey({ key: Buffer.from(keyB64, 'base64'), format: 'der', type: 'pkcs8' });
const sig = b64url(edSign(null, Buffer.from(payload, 'utf8'), key));

const token = `holt_${tier}_${payload}.${sig}`;
if (args.includes('--json')) {
  console.log(JSON.stringify({ token, claims }, null, 2));
} else {
  console.log(token);
}
