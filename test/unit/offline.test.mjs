/**
 * holt — the no-network promise, asserted structurally rather than by grepping for URLs.
 *
 * WHY THIS EXISTS AS A TEST AND NOT ONLY AS A CI GREP. The CI step greps `src/` for `https?://`
 * and friends. That step was MEASURED RED on main on 2026-08-01 and nobody had noticed, for a
 * reason worth writing down: a URL literal is not a network call. `src/license.mjs` puts the
 * pricing page in a customer-facing `fix:` string, and src/siem.mjs names two in-toto schema
 * identifiers that the spec REQUIRES to be exactly those URIs. A gate that cannot tell an
 * identifier from an endpoint has exactly two futures, and both are bad: it goes red on innocent
 * strings until somebody widens it into uselessness, or it gets quietly ignored.
 *
 * So the real property is asserted here, and it is a property about CAPABILITY: no file under
 * src/ may import or reference any API through which a packet could leave the machine. That is
 * what the promise actually means, it is checkable, and it runs on every platform in every job
 * rather than only on the paid-path runner.
 *
 * The URL grep in CI stays. A bare URL in src/ is still a smell worth a human look; it just is
 * not the thing that makes the promise true.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

/** Every module through which a byte could leave this machine. */
const NETWORK_MODULES = [
  'http', 'https', 'net', 'tls', 'dgram', 'dns', 'http2', 'undici', 'axios', 'node-fetch',
  'got', 'superagent', 'ws', 'socket.io-client', 'request',
];

/** Every global that reaches the network with no import at all. */
const NETWORK_GLOBALS = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon'];

async function sourceFiles(dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await sourceFiles(p));
    else if (/\.(mjs|js|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * Strip comments and string literals: only EXECUTABLE text can make a call. An import
 * SPECIFIER is the one string that is executable, so imports are matched on the raw line.
 */
function executable(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

const IMPORT_RE = /(?:^\s*import\b[^\n]*?from\s*|^\s*import\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/;

/** The single checker both tests use — one instrument, exercised against presence AND absence. */
async function scanForNetwork(dir) {
  const violations = [];
  for (const f of await sourceFiles(dir)) {
    const raw = await fs.readFile(f, 'utf8');
    const body = executable(raw);
    const rel = path.relative(dir, f);
    for (const line of raw.split('\n')) {
      const m = IMPORT_RE.exec(line);
      if (!m) continue;
      const spec = m[1].replace(/^node:/, '');
      if (NETWORK_MODULES.includes(spec) || NETWORK_MODULES.includes(spec.split('/')[0])) {
        violations.push(`${rel}: imports '${m[1]}'`);
      }
    }
    for (const g of NETWORK_GLOBALS) {
      if (new RegExp(`(?:^|[^\\w.$])${g}\\s*\\(`).test(body)) violations.push(`${rel}: calls ${g}()`);
    }
  }
  return violations;
}

test('NO src/ FILE CAN REACH THE NETWORK — no import, no require, no bare global', async () => {
  const files = await sourceFiles(SRC);
  assert.ok(files.length > 15,
    `only ${files.length} source files were scanned — the walker is blind, and its silence would mean nothing`);
  const violations = await scanForNetwork(SRC);
  assert.deepEqual(violations, [],
    `src/ must make no network calls — the free tool promises zero telemetry:\n  ${violations.join('\n  ')}`);
});

test('PROVE THE INSTRUMENT: the same checker DOES fire on a file that reaches the network', async () => {
  // An empty result has two explanations — nothing is there, or the detector is blind — and they
  // are indistinguishable from the output alone. So run the SAME function against cases known to
  // be present, and against the innocent shape that made the CI grep useless.
  const tmp = await fs.mkdtemp(path.join(process.env.HOLT_TMPDIR || os.tmpdir(), 'holt-offline-'));
  try {
    await fs.writeFile(path.join(tmp, 'phones-home.mjs'),
      "import https from 'node:https';\nexport const go = () => https.get('x');\n", 'utf8');
    await fs.writeFile(path.join(tmp, 'requires.cjs'),
      "const net = require('net');\nmodule.exports = () => net.connect(80);\n", 'utf8');
    await fs.writeFile(path.join(tmp, 'fetches.mjs'), "export const go = () => fetch('x');\n", 'utf8');
    await fs.writeFile(path.join(tmp, 'innocent.mjs'),
      "// mentions https://example.com in a comment\nexport const ID = 'https://in-toto.io/Statement/v1';\n"
      + "export const NOT_A_CALL = 'call fetch(url) if you want telemetry';\n", 'utf8');

    const found = await scanForNetwork(tmp);
    assert.deepEqual([...new Set(found.map((v) => v.split(':')[0]))].sort(),
      ['fetches.mjs', 'phones-home.mjs', 'requires.cjs'],
      'the offline checker cannot see a real network call, so its silence over src/ means nothing');
    assert.ok(!found.some((v) => v.startsWith('innocent')),
      'a URL in a comment, a schema identifier, or the word fetch inside a string was reported as a '
      + 'network call — that is exactly the false positive that made the CI URL grep useless');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
