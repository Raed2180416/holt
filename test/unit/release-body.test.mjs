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
import {
  checkEvidenceClaims,
  checkReleaseBody,
  changelogSection,
  BODIES_DIR,
  CHANGELOG_PATH,
  repoSlug,
  ROOT,
} from '../../scripts/check-release-body.mjs';

const SLUG = 'Raed2180416/holt';

/**
 * The tag under test is the one this working tree would publish — never a literal. A hardcoded tag
 * here passes for exactly one release and then asserts agreement between the README and a body it
 * has moved past, which is the same drift the file exists to catch, aimed backwards.
 */
const TAG = `v${JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')).version}`;
const VERSION = TAG.replace(/^v/, '');

/** Verbatim, as published. Kept as the permanent record of what this gate exists to stop. */
const FILLER = `**v0.2.0 — Developer Preview**

This release continues building the foundation for Holt as the control plane for parallel
development and AI agent collaboration.

**What's New**

Improved repository and worktree analysis.
Better handling of concurrent operations.
Expanded automated test coverage across core workflows.`;

/** Built from TAG so the accepted-shape fixture tracks the release under test, never a past one. */
const GOOD = `## holt ${VERSION}

\`\`\`bash
npm install -g https://github.com/Raed2180416/holt/releases/download/${TAG}/holt.tgz
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

test('RELEASE BODY: measured numbers and live-host claims require an exact retained artifact', () => {
  const measured = `${GOOD}\nGuard latency: 65 ms. Memory: 11 MB. Correct: 1000/1000.\n`
    + '[methods](https://github.com/Raed2180416/holt/blob/main/BENCHMARKS.md)\n';
  assert.ok(checkReleaseBody(measured, TAG, SLUG).some((p) => /exact retained evidence artifact/i.test(p)),
    'a methods-page link was accepted as the artifact behind measured release claims');

  const live = `${GOOD}\nHost coverage is verified end to end on hosts CI actually drives.\n`;
  assert.ok(checkReleaseBody(live, TAG, SLUG).some((p) => /live-host enforcement evidence/i.test(p)),
    'config/CI coverage was accepted as a live-host proof claim');

  const quotedBug = `${GOOD}\nThe old output said \`scanned 0/0\`; an HTTP install used to 404.\n`;
  assert.deepEqual(checkReleaseBody(quotedBug, TAG, SLUG), [],
    'literal bug output was misclassified as a published measurement');

  const evidenced = `${GOOD}\nGuard latency: 65 ms.\n`
    + '[artifact](https://github.com/Raed2180416/holt/blob/main/docs/evidence/release/run.json)\n';
  assert.deepEqual(checkReleaseBody(evidenced, TAG, SLUG), [],
    'an exact evidence link should make a measured claim structurally eligible');
});

test('RELEASE BODY: the current changelog entry is subject to the same evidence-claim gate', async () => {
  const changelog = await fs.readFile(CHANGELOG_PATH, 'utf8');
  const current = changelogSection(changelog, VERSION);
  assert.ok(current.trim(), `CHANGELOG.md has no ## ${VERSION} entry`);
  assert.deepEqual(checkEvidenceClaims(current), []);

  const unsupported = `${current}\nGuard latency is 65 ms.\n`;
  assert.ok(checkEvidenceClaims(unsupported).some((p) => /exact retained evidence artifact/i.test(p)),
    'the current changelog could publish an unsupported measured value');
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
  // Worse than no command: it looks right and hands the reader the wrong version. A URL pointing
  // at another release's assets is the shape checkReleaseBody() catches.
  const wrong = `## holt ${VERSION}

\`\`\`bash
npm install -g https://github.com/Raed2180416/holt/releases/download/v0.0.1/holt-0.0.1.tgz
\`\`\`
`;
  assert.notEqual(wrong, GOOD, 'the fixture is identical to GOOD — the assertion below is vacuous');
  const problems = checkReleaseBody(wrong, TAG, SLUG);
  assert.ok(problems.some((p) => /outside this release's own assets/.test(p)),
    `a v0.0.1 tarball was accepted as the install command for ${TAG}: ${JSON.stringify(problems)}`);
});

test('RELEASE BODY: absent evidence REFUSES — an empty body is not a passing body', () => {
  for (const body of ['', '   \n\n', null, undefined]) {
    assert.ok(checkReleaseBody(body, TAG, SLUG).length > 0, `an empty body passed: ${JSON.stringify(body)}`);
  }
  assert.ok(checkReleaseBody(GOOD, '', SLUG).length > 0, 'a missing tag passed');
});

test('RELEASE BODY: a body that never names its own version is filler by construction', () => {
  const anon = GOOD.replaceAll(VERSION, '0.9.9');
  assert.notEqual(anon, GOOD, 'the substitution did not apply — the assertion below is vacuous');
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

test('RELEASE BODY: the body and the README advertise the SAME REPOSITORY', async () => {
  // The two surfaces drifting apart is the whole defect. Agreement is asserted, not assumed —
  // but agreement is not the same as being IDENTICAL, and requiring identical commands here was
  // itself holding one of the two surfaces wrong:
  //
  //   · The README is the page for the PROJECT. It uses `releases/latest/download/` so the
  //     command always hands the reader the newest version and never goes stale.
  //   · A RELEASE BODY is the page for ONE release. A reader who lands on the v0.3.1 page must
  //     get v0.3.1, so its command pins the tag: `releases/download/v0.3.1/holt.tgz`.
  //
  // What still may never drift — the thing this test was written to catch — is the REPOSITORY:
  // two surfaces pointing at different repos is how a reader installs something nobody verified.
  const readme = await fs.readFile(path.join(ROOT, 'README.md'), 'utf8');
  const body = await fs.readFile(path.join(BODIES_DIR, `${TAG}.md`), 'utf8');
  const repoIn = (text, what) => {
    const m = text.match(/npm\s+install\s+-g\s+https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\//);
    assert.ok(m, `${what}: no GitHub release install command found — pattern drift, not agreement`);
    return m[1]; // e.g. "Raed2180416/holt"
  };
  const inReadme = repoIn(readme, 'README.md');
  const inBody = repoIn(body, `${TAG}.md`);

  assert.equal(inReadme, inBody,
    `the release body points at '${inBody}' and the README points at '${inReadme}' — different repositories`);
  assert.equal(inReadme, SLUG,
    `the README points at '${inReadme}' but the release body expects '${SLUG}'`);
  // The body pins its own tag; the README uses latest (always newest).
  assert.ok(body.includes(`/releases/download/${TAG}/holt.tgz`),
    `the ${TAG} body must install from ${TAG}'s assets, not a different release`);
});

test('RELEASE BODY: the GitHub Action executes the dependency-complete bundle in the exact checkout its caller pinned', async () => {
  // The caller owns the immutable boundary: `uses: owner/holt@<commit SHA>`. GitHub downloads that
  // repository object and its Node runtime executes this committed file directly. No second tag,
  // package registry install, or shell interpolation can select different executable bytes.
  const [action, bundle] = await Promise.all([
    fs.readFile(path.join(ROOT, 'action.yml'), 'utf8'),
    fs.readFile(path.join(ROOT, 'dist/holt-action.mjs'), 'utf8'),
  ]);
  assert.match(action, /^\s*using:\s*['"]?node24['"]?\s*$/m,
    'action.yml does not use GitHub\'s supported Node 24 JavaScript-action runtime');
  assert.match(action, /^\s*main:\s*['"]?dist\/holt-action\.mjs['"]?\s*$/m,
    'action.yml does not execute the committed dependency-complete bundle');
  assert.match(bundle, /^#!\/usr\/bin\/env node\n\/\/ GENERATED by scripts\/build-action-bundle\.mjs/,
    'the action entry is not the mechanically generated bundle');
  assert.doesNotMatch(action, /\b(?:npm|pnpm|yarn)\s+(?:i|install|add)\b/,
    'action.yml bootstraps another package at runtime instead of using its checked-out bytes');
});
