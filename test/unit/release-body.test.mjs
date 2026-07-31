// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — a release body must tell a reader how to install the release.
 *
 * THE FIXTURE BELOW IS NOT INVENTED. `FILLER` is the body that was actually published for
 * v0.2.0: it called holt an "AI-native workspace" and a "control plane", promised a "semantic
 * project graph", and contained no install command. Every other surface — README, site, CI —
 * carried the same verified `npm install -g <tarball URL>` one-liner, and nothing compared them,
 * so the one page a person reaches from the Releases tab was the only one that was wrong.
 *
 * The assertions are about PROPERTIES a body must have, never about wording: prose cannot be
 * gated on being good, but it can be gated on containing a command a reader can paste, whose
 * target belongs to the release being published.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { checkReleaseBody, BODIES_DIR, repoSlug, ROOT } from '../../scripts/check-release-body.mjs';

const SLUG = 'Raed2180416/holt';
const TAG = 'v0.2.0';

/** Verbatim, as published. Kept as the permanent record of what this gate exists to stop. */
const FILLER = `**v0.2.0 — Developer Preview**

This release continues building the foundation for Holt as the control plane for parallel
development and AI agent collaboration.

**What's New**

Improved repository and worktree analysis.
Better handling of concurrent operations.
Expanded automated test coverage across core workflows.`;

const GOOD = `## holt 0.2.0

\`\`\`bash
npm install -g https://github.com/Raed2180416/holt/releases/download/v0.2.0/holt-0.2.0.tgz
\`\`\`
`;

test('RELEASE BODY: the body that actually shipped is REFUSED, and the reason names the defect', () => {
  const problems = checkReleaseBody(FILLER, TAG, SLUG);
  assert.ok(problems.length > 0, 'the filler body passed the gate that exists because of it');
  assert.ok(problems.some((p) => /no install command/i.test(p)),
    `the refusal must say WHY it fired, not just refuse: ${JSON.stringify(problems)}`);
});

test('RELEASE BODY: a body with a concrete install command for this release is accepted', () => {
  assert.deepEqual(checkReleaseBody(GOOD, TAG, SLUG), []);
});

test('RELEASE BODY: an unfilled template is refused, not counted as an install command', () => {
  // The failure mode one step past "no command at all": the command is there and unusable.
  for (const target of ['<TARBALL_URL>', '${TARBALL}', 'TARBALL', '...']) {
    const problems = checkReleaseBody(`npm install -g ${target}\n${TAG}`, TAG, SLUG);
    assert.ok(problems.some((p) => /placeholder/i.test(p)),
      `\`npm install -g ${target}\` was accepted as a usable install command`);
  }
});

test('RELEASE BODY: an install command for a DIFFERENT release is refused', () => {
  // Worse than no command: it looks right and hands the reader the wrong version.
  const wrong = GOOD.replace('v0.2.0/holt-0.2.0.tgz', 'v0.1.0/holt-0.1.0.tgz');
  const problems = checkReleaseBody(wrong, TAG, SLUG);
  assert.ok(problems.some((p) => /outside this release's own assets/.test(p)),
    `a v0.1.0 tarball was accepted as the install command for ${TAG}: ${JSON.stringify(problems)}`);
});

test('RELEASE BODY: absent evidence REFUSES — an empty body is not a passing body', () => {
  for (const body of ['', '   \n\n', null, undefined]) {
    assert.ok(checkReleaseBody(body, TAG, SLUG).length > 0, `an empty body passed: ${JSON.stringify(body)}`);
  }
  assert.ok(checkReleaseBody(GOOD, '', SLUG).length > 0, 'a missing tag passed');
});

test('RELEASE BODY: a body that never names its own version is filler by construction', () => {
  const anon = GOOD.replaceAll('0.2.0', '0.9.9');
  assert.ok(checkReleaseBody(anon, TAG, SLUG).some((p) => /never mentions/.test(p)),
    'a body that could describe any release was accepted');
});

test('RELEASE BODY: the body checked into this repository passes its own gate', async () => {
  const slug = await repoSlug(ROOT);
  const files = (await fs.readdir(BODIES_DIR)).filter((f) => f.endsWith('.md'));
  // Anti-vacuity: an empty directory would make every assertion below trivially true.
  assert.ok(files.length > 0, `${BODIES_DIR} holds no release bodies — the gate is checking nothing`);
  for (const f of files) {
    const body = await fs.readFile(path.join(BODIES_DIR, f), 'utf8');
    assert.deepEqual(checkReleaseBody(body, path.basename(f, '.md'), slug), [],
      `${f} does not pass the gate this repository ships`);
  }
});

test('RELEASE BODY: the shipped install command is the one the README and CI use', async () => {
  // The three surfaces drifting apart is the whole defect. Agreement is asserted, not assumed.
  const readme = await fs.readFile(path.join(ROOT, 'README.md'), 'utf8');
  const body = await fs.readFile(path.join(BODIES_DIR, `${TAG}.md`), 'utf8');
  const commandIn = (text) => {
    const m = text.match(/npm install -g (https:\/\/\S+\.tgz)/);
    assert.ok(m, 'no tarball install command found — pattern drift, not agreement');
    return m[1];
  };
  assert.equal(commandIn(body), commandIn(readme),
    'the release body and the README advertise different install commands');
});
