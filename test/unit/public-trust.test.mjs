// SPDX-License-Identifier: FSL-1.1-MIT
/** Public trust claims must resolve to namespaces and licence text this project controls. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOLT_PUBLIC_NAMESPACE, journalOrigin } from '../../src/journal.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OWNED_SITE = 'https://raed2180416.github.io/holt';
const LICENSE_URL = 'https://github.com/Raed2180416/holt/blob/main/LICENSE.md';
const UNOWNED_DOMAIN = ['holt', 'dev'].join('.');

async function filesUnder(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await filesUnder(target));
    else if (entry.isFile()) out.push(target);
  }
  return out;
}

test('public identifiers and contact paths never claim the unowned custom domain', async () => {
  const files = [
    ...await filesUnder(path.join(ROOT, 'src')),
    path.join(ROOT, 'site', 'index.html'),
  ];
  const offenders = [];
  for (const file of files) {
    const body = await fs.readFile(file, 'utf8');
    if (body.toLowerCase().includes(UNOWNED_DOMAIN)) {
      offenders.push(path.relative(ROOT, file));
    }
  }
  assert.deepEqual(offenders, [],
    `public/shipped files claim an unowned namespace or contact domain: ${offenders.join(', ')}`);
  assert.equal(HOLT_PUBLIC_NAMESPACE, OWNED_SITE);
  assert.equal(journalOrigin('demo'), `${OWNED_SITE}/journal/demo`);
});

test('site links FSL terms and states the competing-use qualifier beside the grant', async () => {
  const [site, teamLicense] = await Promise.all([
    fs.readFile(path.join(ROOT, 'site', 'index.html'), 'utf8'),
    fs.readFile(path.join(ROOT, 'src', 'team', 'LICENSE'), 'utf8'),
  ]);

  assert.match(site, new RegExp(`<a href="${LICENSE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}">FSL-1\\.1-MIT<\\/a>`),
    'the public FSL label must link to the complete, project-controlled licence text');
  assert.match(site, /any purpose other than a defined Competing Use/i,
    'the site must state the FSL Permitted Purpose boundary, not imply unrestricted use');
  assert.match(site, /Internal commercial use is permitted/i);
  assert.doesNotMatch(site, /including commercial production use/i,
    'an unqualified commercial-use claim hides the FSL competing-use restriction');

  assert.match(teamLicense, /\[FSL-1\.1-MIT\]\(\.\.\/\.\.\/LICENSE\.md\)/);
  assert.match(teamLicense, /internal commercial\s+use that is not a Competing Use/i);
  assert.match(teamLicense, /github\.com\/Raed2180416\/holt\/issues\/new/,
    'licensing questions must use a contact path controlled by the project owner');
});
