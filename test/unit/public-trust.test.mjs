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

test('community entrypoints describe this CLI and make support/security limits explicit', async () => {
  const read = (rel) => fs.readFile(path.join(ROOT, rel), 'utf8');
  const [support, conduct, bug, feature, config, funding, security, questionnaire] = await Promise.all([
    read('SUPPORT.md'),
    read('CODE_OF_CONDUCT.md'),
    read('.github/ISSUE_TEMPLATE/bug_report.md'),
    read('.github/ISSUE_TEMPLATE/feature_request.md'),
    read('.github/ISSUE_TEMPLATE/config.yml'),
    read('.github/FUNDING.yml'),
    read('SECURITY.md'),
    read('docs/SECURITY-QUESTIONNAIRE.md'),
  ]);

  assert.match(support, /best-effort basis/i);
  assert.match(support, /no guaranteed response, resolution timetable, or contractual support SLA/i);
  assert.match(support,
    /npm install -g https:\/\/github\.com\/Raed2180416\/holt\/releases\/latest\/download\/holt\.tgz/);
  assert.match(conduct, /does not currently advertise a dedicated private conduct-reporting inbox/i,
    'conduct policy must not invent a private contact channel');

  assert.match(bug, /holt --version/);
  assert.match(bug, /Git\s+worktrees/);
  assert.doesNotMatch(bug, /Smartphone|Browser \[|iPhone6|Go to '\.\.\.'/,
    'bug template must not ship generic browser/mobile boilerplate for a CLI');
  assert.match(feature, /deliberately broken or ambiguous case/i,
    'feature requests must include a negative control, not only desired prose');
  assert.match(config, /blank_issues_enabled:\s*false/);
  assert.match(config, /security\/advisories\/new/);
  assert.doesNotMatch(funding, /Replace with|supported funding model platforms/i,
    'funding config must contain only configured destinations, not stock placeholders');

  assert.doesNotMatch(security, /within 72 hours|within\s+7 days|72-hour acknowledgement|7-day substantive/i,
    'a volunteer/best-effort project must not promise an unverified security response SLA');
  assert.match(security, /does not currently promise\s+an acknowledgement or remediation timetable/i);
  assert.doesNotMatch(questionnaire, /there is no public package name to squat/i,
    'an unclaimed registry namespace is risk, not protection from squatting');
  assert.match(questionnaire, /unreserved namespace is itself a dependency-confusion\/typosquat risk/i);
  assert.match(questionnaire,
    /npm install -g https:\/\/github\.com\/Raed2180416\/holt\/releases\/latest\/download\/holt\.tgz/);
});

test('historical release notes keep tagged artifacts but never endorse the bare registry name', async () => {
  for (const version of ['0.2.0', '0.3.0', '0.3.1', '0.4.0']) {
    const notes = await fs.readFile(path.join(ROOT, '.github', 'releases', `v${version}.md`), 'utf8');
    assert.match(notes,
      new RegExp(`npm install -g https://github\\.com/Raed2180416/holt/releases/download/v${version}/holt(?:-${version.replace(/\./g, '\\.')})?\\.tgz`),
      `v${version} must keep its immutable, version-specific GitHub artifact install`);
    assert.match(notes, /bare `holt` npm registry name is not an official distribution/i,
      `v${version} must warn that the registry namespace is not an official package`);
    assert.match(notes, /Do not use\s+`npm install -g holt`/i);
    assert.doesNotMatch(notes, /npm install -g holt` lands with/i,
      'an unclaimed registry namespace cannot be described as a supported version channel');
  }
});
