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

/**
 * The tag under test is the one this working tree would publish — never a literal. A hardcoded tag
 * here passes for exactly one release and then asserts agreement between the README and a body it
 * has moved past, which is the same drift the file exists to catch, aimed backwards.
 */
const TAG = `v${JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')).version}`;

/** Verbatim, as published. Kept as the permanent record of what this gate exists to stop. */
const FILLER = `**v0.2.0 — Developer Preview**

This release continues building the foundation for Holt as the control plane for parallel
development and AI agent collaboration.

**What's New**

Improved repository and worktree analysis.
Better handling of concurrent operations.
Expanded automated test coverage across core workflows.`;

/** Built from TAG so the accepted-shape fixture tracks the release under test, never a past one. */
const VERSION = TAG.replace(/^v/, '');
const GOOD = `## holt ${VERSION}

\`\`\`bash
npm install -g https://github.com/Raed2180416/holt/releases/download/${TAG}/holt-${VERSION}.tgz
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
  const wrong = GOOD.replace(`${TAG}/holt-${VERSION}.tgz`, 'v0.0.1/holt-0.0.1.tgz');
  assert.notEqual(wrong, GOOD, 'the substitution did not apply — the assertion below is vacuous');
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

test('RELEASE BODY: the body and the README advertise the SAME ASSET, each selecting it the way its own surface must', async () => {
  // The three surfaces drifting apart is the whole defect. Agreement is asserted, not assumed —
  // but agreement is not the same as being IDENTICAL, and requiring identical URLs here was
  // itself holding one of the two surfaces wrong:
  //
  //   · A RELEASE BODY is the page for ONE release. A reader who lands on the v0.3.0 page must
  //     get v0.3.0, so its URL pins the tag. checkReleaseBody() enforces exactly that, above.
  //   · The README is the page for the PROJECT. A tag pinned there makes the headline install
  //     command hand every future reader an older build until somebody remembers to edit a
  //     markdown file — and 404 outright while that tag is unpublished, which is precisely what
  //     it was doing. It uses GitHub's documented stable form: /releases/latest/download/<asset>.
  //
  // So the two URLs must differ in their SELECTOR and agree on everything else. What still may
  // never drift — the thing this test was written to catch — is the repository and the asset
  // FILE: two surfaces naming different files is how a reader installs something nobody verified.
  const readme = await fs.readFile(path.join(ROOT, 'README.md'), 'utf8');
  const body = await fs.readFile(path.join(BODIES_DIR, `${TAG}.md`), 'utf8');
  const commandIn = (text, what) => {
    const m = text.match(/npm install -g (https:\/\/\S+\.tgz)/);
    assert.ok(m, `${what}: no tarball install command found — pattern drift, not agreement`);
    const { pathname } = new URL(m[1]);
    const segments = pathname.split('/').filter(Boolean);
    return { url: m[1], pathname, slug: segments.slice(0, 2).join('/'), asset: segments.at(-1) };
  };
  const inReadme = commandIn(readme, 'README.md');
  const inBody = commandIn(body, `${TAG}.md`);

  assert.equal(inReadme.slug, inBody.slug,
    'the release body and the README install from different repositories');
  assert.equal(inReadme.asset, inBody.asset,
    `the release body installs '${inBody.asset}' and the README installs '${inReadme.asset}' — `
    + 'one of them is a file the other never verified');
  assert.equal(inReadme.pathname, `/${SLUG}/releases/latest/download/${inReadme.asset}`,
    `the README must use the stable-latest form, not ${inReadme.url}`);
  assert.equal(inBody.pathname, `/${SLUG}/releases/download/${TAG}/${inBody.asset}`,
    `the ${TAG} body must install ${TAG}'s own asset, not ${inBody.url}`);
});

test('RELEASE BODY: the GitHub Action installs the version this tree publishes', async () => {
  // action.yml pins a tag so a consumer's CI cannot be moved under it by a force-push. A pin is
  // only safe while it is CURRENT: left behind, it silently serves every downstream consumer a
  // release older than the one this repository claims to ship. Same drift, one surface over.
  const action = await fs.readFile(path.join(ROOT, 'action.yml'), 'utf8');
  const pins = [...action.matchAll(/github:Raed2180416\/holt#(v[\d.]+)/g)].map((m) => m[1]);
  assert.ok(pins.length > 0, 'no pinned install found in action.yml — pattern drift, not agreement');
  for (const pin of pins) {
    assert.equal(pin, TAG, `action.yml installs ${pin} while this tree publishes ${TAG}`);
  }
  // The registry name is not ours. Falling back to it would hand consumers a stranger's package.
  assert.ok(!/npm\s+install\s+-g\s+["']?holt[@"']/.test(action),
    'action.yml installs the unclaimed npm name `holt` — an unowned name is not a safe fallback');
});
