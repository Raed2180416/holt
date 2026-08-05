// SPDX-License-Identifier: FSL-1.1-MIT

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDER_PROFILE_SCHEMA_VERSION,
  PROVIDER_PROFILE_VOCABULARY,
  PROVIDER_PROFILES,
  buildConformancePlan,
  getProviderProfile,
  providersReport,
  validateProviderProfile,
  validateProviderProfiles,
} from '../../src/integrate/provider-profiles.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));

test('built-in provider profiles are strict, immutable JSON data with explicit family surfaces', () => {
  assert.equal(PROVIDER_PROFILE_SCHEMA_VERSION, 2);
  assert.equal(validateProviderProfiles(), true);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(PROVIDER_PROFILES)));
  assert.ok(Object.isFrozen(PROVIDER_PROFILES));
  assert.ok(PROVIDER_PROFILES.every((profile) => Object.isFrozen(profile)));

  assert.deepEqual(PROVIDER_PROFILES.map((profile) => profile.id), [
    'antigravity-2', 'antigravity-ide', 'antigravity-cli',
    'qwen-code', 'auggie-cli', 'kiro-ide', 'kiro-cli-v3',
  ]);
  assert.deepEqual(
    PROVIDER_PROFILES.filter((profile) => profile.family === 'antigravity').map((profile) => profile.surface),
    ['orchestrator', 'ide', 'cli'],
  );

  const report = providersReport();
  assert.deepEqual(report.counts, {
    profiles: 7,
    families: 4,
    implementedAdapters: 2,
    implementedProfiles: 4,
    contractVerifiedProfiles: 4,
    liveVerifiedProfiles: 0,
    frameworkOnlyProfiles: 3,
  });
  assert.deepEqual(
    [...new Set(report.providers.filter((profile) => profile.implementation === 'implemented')
      .map((profile) => profile.hostId))],
    ['antigravity', 'qwen-code'],
  );
});

test('no built-in promotes documentation or source review into a blocking claim', () => {
  for (const profile of PROVIDER_PROFILES) {
    assert.notEqual(profile.support.grade, 'blocking', profile.id);
    assert.equal(profile.support.blockingClaim, false, profile.id);
    assert.notEqual(profile.proof.liveAllow.state, 'pass', profile.id);
    assert.notEqual(profile.proof.liveDeny.state, 'pass', profile.id);
  }
});

test('blocking is rejected until live allow, live deny, failure injection, and native permission preservation pass', () => {
  const unproved = clone(getProviderProfile('qwen-code'));
  unproved.support.grade = 'blocking';
  unproved.support.blockingClaim = true;
  assert.throws(() => validateProviderProfile(unproved), /adapter\.verification.*live-verified before a blocking claim/);

  unproved.adapter.verification = 'live-verified';
  assert.throws(() => validateProviderProfile(unproved), /live-verified requires a live-verified capability/);
  unproved.adapter.capabilities.preTool.state = 'live-verified';
  unproved.hooks.state = 'live-verified';
  assert.throws(() => validateProviderProfile(unproved), /nativeDiscovery.*live-verified/);
  unproved.proof.nativeDiscovery.state = 'pass';
  assert.throws(() => validateProviderProfile(unproved), /live-verified requires at least one exercised live capability/);
  unproved.proof.liveAllow.state = 'pass';
  assert.throws(() => validateProviderProfile(unproved), /liveDeny.*must pass before a blocking claim/);

  for (const key of ['liveDeny', 'failureInjection']) unproved.proof[key].state = 'pass';
  for (const key of Object.keys(unproved.hooks.failureMatrix)) {
    if (unproved.hooks.failureMatrix[key] === 'unknown') unproved.hooks.failureMatrix[key] = 'warn-and-deny';
  }
  assert.throws(
    () => validateProviderProfile(unproved),
    /neutralAllowPreservesNativePermission.*must be proven yes before a blocking claim/,
  );

  unproved.hooks.preToolUse.neutralAllowPreservesNativePermission = 'yes';
  assert.equal(validateProviderProfile(unproved), true);
});

test('MCP is always labelled reactive model-pull while lifecycle context is host-push', () => {
  for (const profile of PROVIDER_PROFILES) {
    assert.equal(profile.mcp.trigger, 'model-pull', profile.id);
    assert.equal(profile.mcp.delivery, 'model-pull', profile.id);
    for (const event of profile.hooks.lifecycle) {
      assert.equal(event.trigger, 'host-push', `${profile.id}:${event.event}`);
      assert.notEqual(event.delivery, 'model-pull', `${profile.id}:${event.event}`);
    }
  }

  const lie = clone(getProviderProfile('auggie-cli'));
  lie.mcp.delivery = 'model-context';
  assert.throws(() => validateProviderProfile(lie), /MCP must be model-pull/);
});

test('adapter inventory separates shipped installation from provider capability and reports activation semantics', () => {
  const report = providersReport();
  assert.equal(report.schemaVersion, 2);

  for (const id of ['antigravity-2', 'antigravity-ide', 'antigravity-cli', 'qwen-code']) {
    const provider = report.providers.find((row) => row.id === id);
    assert.equal(provider.implementation, 'implemented', id);
    assert.equal(provider.verification, 'contract-verified', id);
    assert.equal(provider.liveVerified, false, id);
    assert.deepEqual(provider.install.scopes, ['project', 'user'], id);
    assert.equal(provider.install.detectedProject, 'holt integrate', id);
    assert.equal(provider.install.explicitProject, 'holt integrate --all-hosts', id);
    assert.equal(provider.install.detectedUser, 'holt integrate --global', id);
    assert.equal(provider.install.explicitUser, 'holt integrate --all-hosts --global', id);
    assert.deepEqual(provider.capabilities.mcp.installedScopes, ['project', 'user'], id);
    assert.equal(provider.capabilities.mcp.initiation, 'model-pull', id);
    assert.equal(provider.capabilities.mcp.proactive, false, id);
    assert.deepEqual(provider.capabilities.lifecycle.installedScopes, ['project'], id);
    assert.equal(provider.capabilities.lifecycle.initiation, 'host-push', id);
    assert.equal(provider.capabilities.lifecycle.proactive, true, id);
  }

  const antigravity = report.providers.find((row) => row.id === 'antigravity-cli');
  assert.equal(antigravity.capabilities.preTool.state, 'unsupported');
  assert.deepEqual(antigravity.capabilities.preTool.installedScopes, []);

  const qwen = report.providers.find((row) => row.id === 'qwen-code');
  assert.equal(qwen.capabilities.preTool.state, 'contract-verified');
  assert.deepEqual(qwen.capabilities.preTool.installedScopes, ['project']);

  for (const id of ['auggie-cli', 'kiro-ide', 'kiro-cli-v3']) {
    const provider = report.providers.find((row) => row.id === id);
    assert.equal(provider.implementation, 'framework-only', id);
    assert.equal(provider.verification, 'unverified', id);
    assert.equal(provider.hostId, null, id);
    assert.deepEqual(provider.install.scopes, [], id);
    assert.ok(Object.values(provider.install).filter((value) => typeof value === 'string')
      .every((value) => !value.startsWith('holt integrate')), id);
    assert.ok(Object.values(provider.capabilities)
      .every((capability) => capability.installedScopes.length === 0), id);
  }
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(report)));
});

test('profiles preserve provider-specific payload and failure facts instead of a fake universal hook', () => {
  const antigravity = getProviderProfile('antigravity-cli');
  assert.equal(antigravity.hooks.preToolUse.toolMappings[0].argumentPaths.command, 'toolCall.args.CommandLine');
  assert.equal(antigravity.hooks.preToolUse.neutralAllowPreservesNativePermission, 'unknown');
  assert.ok(Object.values(antigravity.hooks.failureMatrix).every((outcome) => outcome === 'unknown'));
  for (const id of ['antigravity-2', 'antigravity-ide', 'antigravity-cli']) {
    assert.equal(getProviderProfile(id).proof.configRoundTrip.state, 'pass', id);
    assert.equal(getProviderProfile(id).proof.upgradeUninstall.state, 'pass', id);
  }

  const qwen = getProviderProfile('qwen-code');
  assert.equal(qwen.hooks.failureMatrix.exit2, 'deny');
  assert.equal(qwen.hooks.failureMatrix.timeout, 'allow');
  assert.equal(qwen.hooks.preToolUse.toolMappings[0].toolIds[0], 'run_shell_command');
  assert.equal(qwen.proof.payloadReplay.state, 'pass');
  assert.equal(qwen.proof.upgradeUninstall.state, 'pass');

  const auggie = getProviderProfile('auggie-cli');
  assert.equal(auggie.hooks.failureMatrix.exit1, 'warn-and-allow');
  assert.equal(auggie.hooks.failureMatrix.timeout, 'unknown');
  assert.ok(auggie.hooks.preToolUse.matchers.includes('remove-files'));
  assert.ok(!auggie.hooks.preToolUse.toolMappings.some((mapping) => mapping.toolIds.includes('remove-files')),
    'do not invent the current remove-files argument shape');

  for (const id of ['kiro-ide', 'kiro-cli-v3']) {
    const kiro = getProviderProfile(id);
    assert.deepEqual(kiro.hooks.preToolUse.toolMappings, [], 'an undocumented stdin shape must stay empty');
    assert.equal(kiro.hooks.state, 'documented');
    assert.match(kiro.limitations.join(' '), /conflict/i);
  }
});

test('primary evidence is dated and pinned to a version or source commit', () => {
  for (const profile of PROVIDER_PROFILES) {
    assert.match(profile.evidence.fetchedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(profile.evidence.sources.every((source) => source.url.startsWith('https://')));
    assert.ok(profile.evidence.sources.some((source) => source.version || source.commit));
    assert.ok(profile.evidence.sources.every((source) => source.fetchedAt === profile.evidence.fetchedAt));
  }
  assert.equal(getProviderProfile('qwen-code').version.sourceCommit, '32e27415779226b23174a3b0aa6c04e094f1aca2');
  assert.equal(getProviderProfile('antigravity-cli').version.sourceCommit, null,
    'do not attach Antigravity CLI to an unrelated public repository');
  assert.equal(getProviderProfile('antigravity-2').version.current, '2.5.0');
});

test('strict validation rejects stale vocabulary, dangling evidence, non-JSON data, and duplicate ids', () => {
  const stale = clone(getProviderProfile('auggie-cli'));
  stale.hooks.failureMatrix.timeout = 'probably-open';
  assert.throws(() => validateProviderProfile(stale), /failureMatrix\.timeout.*must be one of/);

  const dangling = clone(getProviderProfile('qwen-code'));
  dangling.proof.sourceContract.evidenceRefs.push('missing-source');
  assert.throws(() => validateProviderProfile(dangling), /references unknown evidence id missing-source/);

  const insecure = clone(getProviderProfile('kiro-ide'));
  insecure.evidence.sources[0].url = 'http://example.invalid';
  assert.throws(() => validateProviderProfile(insecure), /primary HTTPS URL/);

  const executable = clone(getProviderProfile('antigravity-2'));
  executable.extra = () => true;
  assert.throws(() => validateProviderProfile(executable), /JSON-serializable/);

  const duplicate = clone(getProviderProfile('qwen-code'));
  assert.throws(() => validateProviderProfiles([...PROVIDER_PROFILES, duplicate]), /duplicate profile id qwen-code/);

  const frameworkInstaller = clone(getProviderProfile('auggie-cli'));
  frameworkInstaller.adapter.install.explicitProject = 'holt integrate --all-hosts';
  assert.throws(() => validateProviderProfile(frameworkInstaller), /framework-only profiles cannot expose an install command/);

  const proactiveMcp = clone(getProviderProfile('qwen-code'));
  proactiveMcp.adapter.capabilities.mcp.proactive = true;
  assert.throws(() => validateProviderProfile(proactiveMcp), /adapter\.capabilities\.mcp\.proactive.*must be false/);

  const unverifiedInstall = clone(getProviderProfile('antigravity-cli'));
  unverifiedInstall.adapter.capabilities.preTool.installedScopes = ['project'];
  assert.throws(() => validateProviderProfile(unverifiedInstall), /preTool\.state.*installed capability must be contract-verified/);

  const missingContractProof = clone(getProviderProfile('qwen-code'));
  missingContractProof.proof.configRoundTrip.state = 'not-run';
  assert.throws(() => validateProviderProfile(missingContractProof), /configRoundTrip.*must pass before adapter verification/);

  const capabilityOutrunsContract = clone(getProviderProfile('qwen-code'));
  capabilityOutrunsContract.rules.state = 'configuration-ready';
  assert.throws(() => validateProviderProfile(capabilityOutrunsContract), /capabilities\.rules\.state.*cannot outrank/);
});

test('conformance plans expose exact remaining proof instead of returning a readiness slogan', () => {
  const plan = buildConformancePlan('qwen-code');
  assert.equal(plan.profileId, 'qwen-code');
  assert.equal(plan.currentGrade, 'contract-verified');
  assert.equal(plan.canClaimBlocking, false);
  assert.equal(plan.steps.find((step) => step.id === 'source-contract').status, 'complete');
  assert.equal(plan.steps.find((step) => step.id === 'config-round-trip').status, 'complete');
  assert.equal(plan.steps.find((step) => step.id === 'payload-replay').status, 'complete');
  assert.equal(plan.steps.find((step) => step.id === 'upgrade-uninstall').status, 'complete');
  assert.equal(plan.steps.find((step) => step.id === 'live-allow').status, 'pending');
  assert.equal(plan.steps.find((step) => step.id === 'live-deny').status, 'pending');
  assert.ok(plan.remainingRequiredSteps.includes('failure-injection'));
  assert.ok(plan.remainingRequiredSteps.includes('subagent'));
  assert.deepEqual(JSON.parse(JSON.stringify(plan)), plan);

  assert.throws(() => buildConformancePlan('not-a-provider'), /unknown provider profile/);
  assert.ok(PROVIDER_PROFILE_VOCABULARY.planStatuses.includes('blocked'));
});
