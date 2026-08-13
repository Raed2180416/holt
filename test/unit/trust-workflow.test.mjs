import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const workflowUrl = new URL('../../.github/workflows/trust.yml', import.meta.url);

test('public trust workflow runs on every pull request and checks claim-bearing surfaces', async () => {
  const workflow = await fs.readFile(workflowUrl, 'utf8');

  assert.match(workflow, /^name: public trust$/m);
  assert.match(workflow, /^\s{2}pull_request:\s*$/m,
    'the trust lane must run for every PR instead of disappearing on prose-only changes');
  assert.doesNotMatch(workflow, /^\s{4}paths(?:-ignore)?:/m,
    'a required trust check cannot be path-filtered or docs-only PRs will never report it');
  assert.match(workflow, /^\s{4}name: public trust and claims$/m);

  for (const required of [
    'doc-command-smoke.test.mjs',
    'install-url.test.mjs',
    'pricing-cta.test.mjs',
    'public-trust.test.mjs',
    'published-numbers.test.mjs',
    'release-body.test.mjs',
    'site-accessibility.test.mjs',
    'site-layout.test.mjs',
    'site-self-contained.test.mjs',
    'scripts/check-ci-hardening.mjs',
    'scripts/check-release-body.mjs --all',
  ]) {
    assert.match(workflow, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `public trust workflow lost ${required}`);
  }
});
