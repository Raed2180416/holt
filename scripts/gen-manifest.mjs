#!/usr/bin/env node
// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — write the integrity manifest that ships inside the package.
 *
 *   node scripts/gen-manifest.mjs            write MANIFEST.sha256, print the tree digest
 *   node scripts/gen-manifest.mjs --check    exit non-zero if the manifest on disk is stale
 *   node scripts/gen-manifest.mjs --digest   print only the tree digest (for CI to attest)
 *
 * `--check` is the CI gate. Without it the manifest would be a file somebody remembers to
 * regenerate, and a manifest that is one commit stale reports every honest change as tampering
 * — the fastest possible way to teach a customer to ignore the integrity check.
 *
 * The manifest deliberately does NOT cover itself or its signature; nothing can hash itself.
 * Its authenticity comes from outside — the release workflow attests its digest with Sigstore,
 * and optionally signs it with the release key. See SUPPLY-CHAIN.md.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest, treeDigest, integrityCoveredFiles, MANIFEST_FILE } from '../src/supply-chain.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(ROOT, MANIFEST_FILE);
const argv = process.argv.slice(2);

const files = integrityCoveredFiles(ROOT);
const body = buildManifest(ROOT, files);
const digest = treeDigest(body);
/** Covered = every executable/configuration/machine-contract file in the shipped package. */
const covered = body.split('\n').filter(Boolean).length;

if (argv.includes('--digest')) {
  process.stdout.write(`${digest}\n`);
  process.exit(0);
}

if (argv.includes('--check')) {
  let current = null;
  try { current = fs.readFileSync(target, 'utf8'); } catch { /* absent */ }
  if (current === body) {
    process.stdout.write(`${MANIFEST_FILE} is current: ${covered} files, tree digest ${digest}\n`);
    process.exit(0);
  }
  process.stderr.write(
    `${MANIFEST_FILE} is ${current === null ? 'MISSING' : 'STALE'}.\n`
    + 'The shipped file set or its contents changed without the manifest being regenerated.\n'
    + 'Run: node scripts/gen-manifest.mjs\n',
  );
  if (current !== null) {
    const was = new Map(current.split('\n').filter(Boolean).map((l) => [l.slice(66), l.slice(0, 64)]));
    const now = new Map(body.split('\n').filter(Boolean).map((l) => [l.slice(66), l.slice(0, 64)]));
    for (const [f, h] of now) {
      if (!was.has(f)) process.stderr.write(`  + ${f}\n`);
      else if (was.get(f) !== h) process.stderr.write(`  ~ ${f}\n`);
    }
    for (const f of was.keys()) if (!now.has(f)) process.stderr.write(`  - ${f}\n`);
  }
  process.exit(1);
}

fs.writeFileSync(target, body, 'utf8');
process.stdout.write(`wrote ${MANIFEST_FILE}: ${covered} files\ntree digest: ${digest}\n`);
