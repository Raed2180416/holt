// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * Provider-neutral compatibility evidence for shipped and prospective agent-host adapters.
 *
 * A profile describes an adapter; it does not imply that one ships. Likewise, a documented hook is
 * not a blocking integration. These records preserve the facts needed to operate or build an
 * adapter without smuggling a marketing claim into the implementation. `validateProviderProfile`
 * makes those distinctions executable: framework-only records cannot expose install commands,
 * and the `blocking` grade is impossible until a real host has passed both an allow and a deny run,
 * failure behaviour has been exercised, and an allow is known not to bypass the host's own
 * permission system.
 */

export const PROVIDER_PROFILE_SCHEMA_VERSION = 2;
export const PROFILE_SCHEMA_VERSION = PROVIDER_PROFILE_SCHEMA_VERSION;

const FETCHED_AT = '2026-08-05';

/** @template T @param {T} value @returns {T} */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(/** @type {Record<string, unknown>} */ (value))) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Closed vocabulary shared by profile authors, validators, docs generators, and future adapters.
 * It is ordinary JSON data so another language can consume it without executing this module.
 */
export const PROVIDER_PROFILE_VOCABULARY = deepFreeze({
  supportGrades: ['advisory', 'configuration-ready', 'contract-verified', 'blocking'],
  capabilityStates: ['unsupported', 'documented', 'configuration-ready', 'contract-verified', 'live-verified'],
  evidenceKinds: ['official-docs', 'official-source', 'official-release', 'local-discovery', 'live-host-run'],
  proofStates: ['not-run', 'pass', 'fail', 'blocked', 'not-applicable'],
  deliveryModes: ['model-pull', 'model-context', 'user-visible', 'log-only', 'new-prompt', 'pre-execution-gate'],
  triggerModes: ['model-pull', 'host-push'],
  failureOutcomes: ['allow', 'deny', 'ask', 'warn-and-allow', 'warn-and-deny', 'unknown', 'not-applicable'],
  planStatuses: ['complete', 'pending', 'failed', 'blocked', 'not-applicable'],
  surfaces: ['cli', 'ide', 'orchestrator'],
  channels: ['stable', 'early-access', 'rolling'],
  environments: ['local', 'cloud', 'hybrid'],
  workspaceModels: ['single-root', 'multi-root', 'multi-workspace'],
  trustStates: ['automatic', 'prompted', 'manual', 'unknown'],
  neutralPermissionStates: ['yes', 'no', 'unknown'],
  adapterImplementations: ['implemented', 'framework-only'],
  adapterVerifications: ['unverified', 'contract-verified', 'live-verified'],
  capabilityInitiators: ['host-discovery', 'model-pull', 'host-push'],
  installScopes: ['project', 'user'],
});

export const CAPABILITY_GRADES = PROVIDER_PROFILE_VOCABULARY.supportGrades;
export const FAILURE_OUTCOMES = PROVIDER_PROFILE_VOCABULARY.failureOutcomes;
export const PROOF_STATES = PROVIDER_PROFILE_VOCABULARY.proofStates;
export const DELIVERY_MODES = PROVIDER_PROFILE_VOCABULARY.deliveryModes;

const FAILURE_KEYS = [
  'missingBinary', 'spawnError', 'crash', 'exit1', 'exit2', 'timeout', 'invalidJson',
  'emptyOutput', 'killed', 'untrusted', 'disabled', 'headlessAsk',
];

const PROOF_KEYS = [
  'sourceContract', 'configRoundTrip', 'nativeDiscovery', 'payloadReplay', 'liveAllow',
  'liveDeny', 'failureInjection', 'lifecycleContext', 'mcpRoundTrip', 'upgradeUninstall',
  'subagent', 'platforms',
];

/** @param {string} state @param {string} note @param {string[]} [evidenceRefs] */
function proof(state, note, evidenceRefs = []) {
  return { state, evidenceRefs, note };
}

/** @param {Partial<Record<string, ReturnType<typeof proof>>>} [overrides] */
function proofSet(overrides = {}) {
  const pending = (name) => proof('not-run', `${name} has not been run against the current product version.`);
  return {
    sourceContract: overrides.sourceContract ?? pending('Source-contract review'),
    configRoundTrip: overrides.configRoundTrip ?? pending('Native configuration round-trip'),
    nativeDiscovery: overrides.nativeDiscovery ?? pending('Native discovery'),
    payloadReplay: overrides.payloadReplay ?? pending('Golden and adversarial payload replay'),
    liveAllow: overrides.liveAllow ?? pending('Live safe-operation allow'),
    liveDeny: overrides.liveDeny ?? pending('Live destructive-decoy deny'),
    failureInjection: overrides.failureInjection ?? pending('Failure injection'),
    lifecycleContext: overrides.lifecycleContext ?? pending('Lifecycle context delivery'),
    mcpRoundTrip: overrides.mcpRoundTrip ?? pending('MCP discovery and tool round-trip'),
    upgradeUninstall: overrides.upgradeUninstall ?? pending('Upgrade and uninstall preservation'),
    subagent: overrides.subagent ?? pending('Subagent propagation'),
    platforms: {
      linux: overrides.platforms?.linux ?? pending('Linux host run'),
      macos: overrides.platforms?.macos ?? pending('macOS host run'),
      windows: overrides.platforms?.windows ?? pending('Windows host run'),
    },
  };
}

/**
 * Public adapter facts are deliberately separate from the provider capability record. A provider
 * can document a hook that Holt intentionally does not install, and a contract-tested installer
 * is still not a live-host run.
 *
 * @param {string} state
 * @param {'host-discovery'|'model-pull'|'host-push'} initiation
 * @param {boolean} proactive
 * @param {string[]} installedScopes
 * @param {string} note
 */
function adapterCapability(state, initiation, proactive, installedScopes, note) {
  return { state, initiation, proactive, installedScopes, note };
}

/** @param {Record<string, any>} options */
function implementedAdapter(options) {
  return {
    implementation: 'implemented',
    verification: 'contract-verified',
    hostId: options.hostId,
    install: {
      detectedProject: 'holt integrate',
      explicitProject: 'holt integrate --all-hosts',
      detectedUser: 'holt integrate --global',
      explicitUser: 'holt integrate --all-hosts --global',
      prerequisites: options.prerequisites,
      scopes: ['project', 'user'],
      note: options.installNote,
    },
    capabilities: options.capabilities,
  };
}

/** @param {{rules:string, mcp:string, lifecycle:string, preTool:string}} states */
function frameworkOnlyAdapter(states) {
  return {
    implementation: 'framework-only',
    verification: 'unverified',
    hostId: null,
    install: {
      detectedProject: null,
      explicitProject: null,
      detectedUser: null,
      explicitUser: null,
      prerequisites: ['No Holt adapter ships for this profile; use its conformance plan to implement and prove one.'],
      scopes: [],
      note: 'The profile is read-only evidence, not an installer.',
    },
    capabilities: {
      rules: adapterCapability(states.rules, 'host-discovery', false, [], 'Provider surface recorded; Holt does not install a provider-specific rules adapter.'),
      mcp: adapterCapability(states.mcp, 'model-pull', false, [], 'Provider MCP contract recorded; no Holt installer ships for this profile.'),
      lifecycle: adapterCapability(states.lifecycle, 'host-push', true, [], 'Candidate proactive context surface; no Holt lifecycle adapter ships for this profile.'),
      preTool: adapterCapability(states.preTool, 'host-push', true, [], 'Candidate pre-execution surface; no Holt guard adapter ships for this profile.'),
    },
  };
}

const unknownFailures = () => Object.fromEntries(FAILURE_KEYS.map((key) => [key, 'unknown']));

/** @param {string} version @param {string} surface */
function antigravityEvidence(version, surface) {
  return [
    { id: 'agy-release', kind: 'official-release', title: 'Antigravity downloads',
      url: 'https://antigravity.google/download', fetchedAt: FETCHED_AT, version, commit: null,
      note: `Current ${surface} version shown by the official download surface.` },
    { id: 'agy-hooks', kind: 'official-docs', title: 'Antigravity hooks',
      url: 'https://antigravity.google/docs/hooks', fetchedAt: FETCHED_AT, version: null, commit: null,
      note: 'Hook events, payloads, output decisions, lifecycle injection, and config paths.' },
    { id: 'agy-mcp', kind: 'official-docs', title: 'Antigravity MCP',
      url: 'https://antigravity.google/docs/mcp', fetchedAt: FETCHED_AT, version: null, commit: null,
      note: 'Project and user MCP paths plus stdio and remote entry shapes.' },
    { id: 'agy-plugins', kind: 'official-docs', title: 'Antigravity IDE plugins',
      url: 'https://antigravity.google/docs/ide/plugins', fetchedAt: FETCHED_AT, version: null, commit: null,
      note: 'Plugin bundle layout and validation command.' },
    { id: 'agy-rules', kind: 'official-docs', title: 'Antigravity rules',
      url: 'https://antigravity.google/docs/ide-rules', fetchedAt: FETCHED_AT, version: null, commit: null,
      note: 'Native rule locations and activation modes.' },
    { id: 'agy-agents', kind: 'official-docs', title: 'Antigravity migration guide',
      url: 'https://antigravity.google/docs/gcli-migration', fetchedAt: FETCHED_AT, version: null, commit: null,
      note: 'Documents AGENTS.md compatibility and the .agents directory.' },
    { id: 'agy-local-plugin-probe', kind: 'local-discovery', title: 'Local plugin validator probe',
      url: 'https://antigravity.google/docs/ide/plugins', fetchedAt: FETCHED_AT, version: '1.1.8', commit: null,
      note: 'Local `agy plugin validate` accepted a minimal plugin with one MCP server and one hook; this did not execute either feature.' },
  ];
}

/**
 * @param {{id:string, displayName:string, surface:'cli'|'ide'|'orchestrator', version:string,
 *   channel:'stable'|'early-access'|'rolling', workspaceModel:'single-root'|'multi-root'|'multi-workspace',
 *   rootSelectors:string[], multiRoot:boolean, locallyObserved:string|null}} options
 * @returns {Record<string, any>}
 */
function antigravityProfile(options) {
  const pluginPath = '.agents/plugins/holt/';
  return {
    schemaVersion: PROVIDER_PROFILE_SCHEMA_VERSION,
    id: options.id,
    family: 'antigravity',
    surface: options.surface,
    displayName: options.displayName,
    adapter: implementedAdapter({
      hostId: 'antigravity',
      prerequisites: [
        'Install Holt so the `holt` executable is on PATH.',
        'Run inside a Git repository. Automatic mode requires an Antigravity project/user marker; otherwise review and use --all-hosts.',
        'User MCP merge requires an existing ~/.gemini/config/mcp_config.json; Holt never fabricates absent user configuration.',
      ],
      installNote: 'Project scope installs AGENTS.md, MCP, and proactive PreInvocation context. User scope adds MCP only; Holt does not install a user-level Antigravity hook or any PreToolUse guard.',
      capabilities: {
        rules: adapterCapability('contract-verified', 'host-discovery', false, ['project'], 'Holt installs its bounded AGENTS.md instructions; native .agents/rules remain user-owned.'),
        mcp: adapterCapability('contract-verified', 'model-pull', false, ['project', 'user'], 'Installed MCP is reactive: the model must choose to call Holt.'),
        lifecycle: adapterCapability('contract-verified', 'host-push', true, ['project'], 'PreInvocation injects changed sibling context and auto-protects on invocation 0; contract-tested, not observed in a live model trajectory.'),
        preTool: adapterCapability('unsupported', 'host-push', true, [], 'Holt intentionally installs no Antigravity PreToolUse guard because a neutral permission-preserving result is not documented or live-proven.'),
      },
    }),
    support: {
      grade: 'contract-verified', blockingClaim: false,
      summary: 'Holt installs contract-tested AGENTS.md, MCP, and proactive PreInvocation context; no PreToolUse guard or live-host proof is claimed.',
    },
    version: {
      current: options.version, channel: options.channel, sourceCommit: null,
      locallyObserved: options.locallyObserved,
      compatibility: ['.agents rules/plugins', 'hooks v1 documentation', 'MCP mcpServers'],
      releaseEvidenceRef: 'agy-release', sourceEvidenceRef: null,
    },
    environment: {
      execution: 'local', platforms: ['linux', 'macos', 'windows'],
      workspaceModel: options.workspaceModel, rootSelectors: options.rootSelectors,
      multiRoot: options.multiRoot,
    },
    evidence: { fetchedAt: FETCHED_AT, sources: antigravityEvidence(options.version, options.displayName) },
    discovery: {
      markers: { project: ['.agents/', 'AGENTS.md'], user: ['~/.gemini/config/'] },
      trust: 'manual', activation: 'Rules may be always-on, model-selected, glob-selected, or manually selected.',
      observed: proof('not-run', 'The current product version has not been driven through native discovery.'),
    },
    rules: {
      state: 'contract-verified',
      files: [
        { scope: 'project', path: 'AGENTS.md', format: 'markdown', activation: 'migration-compatible autoload', precedence: 10 },
        { scope: 'project', path: '.agents/rules/*.md', format: 'markdown', activation: 'rule-defined', precedence: 20 },
        { scope: 'user', path: '~/.gemini/GEMINI.md', format: 'markdown', activation: 'global autoload', precedence: 0 },
      ],
      agentsMd: { supported: true, autoload: true, scope: 'project', evidenceRef: 'agy-agents' },
      mergeStrategy: 'preserve foreign rules; add a Holt-owned rule or bounded AGENTS.md block',
      maxBytes: null, evidenceRefs: ['agy-rules', 'agy-agents'],
    },
    mcp: {
      state: 'contract-verified', trigger: 'model-pull', delivery: 'model-pull',
      configTargets: [
        { scope: 'project', path: '.agents/mcp_config.json', format: 'json', key: 'mcpServers' },
        { scope: 'user', path: '~/.gemini/config/mcp_config.json', format: 'json', key: 'mcpServers' },
      ],
      entryShape: { stdio: ['command', 'args', 'env', 'cwd'], remote: ['serverUrl'] },
      transports: ['stdio', 'remote-http'], hotReload: 'unknown', trust: 'manual',
      mergeStrategy: 'structural JSON merge by server id; preserve foreign servers and keys',
      secrets: 'reference environment variables; never copy secret values into generated project files',
      evidenceRefs: ['agy-mcp'],
    },
    hooks: {
      state: 'configuration-ready', trigger: 'host-push', delivery: 'pre-execution-gate',
      packaging: [
        { kind: 'direct', scope: 'project', path: '.agents/hooks.json' },
        { kind: 'plugin', scope: 'project', path: pluginPath },
        { kind: 'plugin', scope: 'user', path: '~/.gemini/config/plugins/holt/' },
      ],
      configTargets: [
        { scope: 'project', path: '.agents/hooks.json', format: 'json', key: 'hooks' },
        { scope: 'user', path: '~/.gemini/config/hooks.json', format: 'json', key: 'hooks' },
      ],
      runner: { kind: 'command', commandField: 'command', timeoutSeconds: null },
      preToolUse: {
        event: 'PreToolUse', matchers: ['run_command', 'write_to_file', 'replace_file_content', 'multi_replace_file_content'],
        inputEnvelope: 'camelCase toolCall{name,args}, stepIdx, conversationId, workspacePaths, transcriptPath, artifactDirectoryPath',
        toolMappings: [
          { toolIds: ['run_command'], argumentPaths: { command: 'toolCall.args.CommandLine', cwd: 'toolCall.args.Cwd' }, coverage: 'shell', note: 'Command and working directory.' },
          { toolIds: ['write_to_file'], argumentPaths: { path: 'toolCall.args.TargetFile', content: 'toolCall.args.CodeContent', overwrite: 'toolCall.args.Overwrite' }, coverage: 'write', note: 'Whole-file write.' },
          { toolIds: ['replace_file_content'], argumentPaths: { path: 'toolCall.args.TargetFile', oldContent: 'toolCall.args.TargetContent', newContent: 'toolCall.args.ReplacementContent' }, coverage: 'edit', note: 'Single replacement.' },
          { toolIds: ['multi_replace_file_content'], argumentPaths: { path: 'toolCall.args.TargetFile', chunks: 'toolCall.args.ReplacementChunks' }, coverage: 'edit', note: 'Multiple replacements.' },
        ],
        output: { dialect: 'top-level JSON decision', allow: 'decision:allow', deny: 'decision:deny', ask: 'decision:ask or force_ask', neutral: 'not documented' },
        neutralAllowPreservesNativePermission: 'unknown',
      },
      lifecycle: [
        { event: 'PreInvocation', trigger: 'host-push', delivery: 'model-context', frequency: 'each invocation',
          output: 'injectSteps[].ephemeralMessage', deduplication: 'required', reentry: 'none', subagents: 'unverified', evidenceRefs: ['agy-hooks'] },
      ],
      failureMatrix: unknownFailures(), evidenceRefs: ['agy-hooks', 'agy-plugins'],
    },
    proof: proofSet({
      configRoundTrip: proof('pass', 'Holt contract tests install, reconcile, and parse its project MCP and PreInvocation entries while preserving foreign configuration; this is not native host discovery.', ['agy-hooks', 'agy-mcp']),
      upgradeUninstall: proof('pass', 'Holt contract tests remove only its Antigravity MCP and lifecycle entries and preserve foreign content.', ['agy-hooks', 'agy-mcp']),
      sourceContract: proof('not-applicable', 'The hook implementation source is not public; official documentation was reviewed.', ['agy-hooks']),
    }),
    ownership: {
      managedPaths: [], mergeStrategy: 'structurally own only Holt entries inside shared direct MCP and hook configuration',
      uninstall: 'remove only Holt-owned hook/server entries; the documented plugin paths remain user-owned because this adapter does not create them',
      secrets: 'never own, print, or rewrite foreign secrets',
    },
    limitations: [
      'Holt install/reconcile/uninstall behavior is contract-tested; native Antigravity discovery and execution are not live-verified.',
      'Plugin validation was observed on local CLI 1.1.8, not the current release and not a hook execution.',
      'Hook crash, timeout, malformed-output, and neutral allow semantics are undocumented.',
      'PreInvocation injection and subagent propagation have not been observed live.',
    ],
  };
}

const antigravity2 = antigravityProfile({
  id: 'antigravity-2', displayName: 'Antigravity 2', surface: 'orchestrator', version: '2.5.0',
  channel: 'stable', workspaceModel: 'multi-root', rootSelectors: ['workspacePaths[]'],
  multiRoot: true, locallyObserved: null,
});

const antigravityIde = antigravityProfile({
  id: 'antigravity-ide', displayName: 'Antigravity IDE', surface: 'ide', version: '2.1.1',
  channel: 'stable', workspaceModel: 'multi-workspace', rootSelectors: ['workspacePaths[]'],
  multiRoot: true, locallyObserved: null,
});

const antigravityCli = antigravityProfile({
  id: 'antigravity-cli', displayName: 'Antigravity CLI', surface: 'cli', version: '1.1.10',
  channel: 'stable', workspaceModel: 'multi-root', rootSelectors: ['cwd', 'workspacePaths[]'],
  multiRoot: true, locallyObserved: '1.1.8',
});

const qwenCode = {
  schemaVersion: PROVIDER_PROFILE_SCHEMA_VERSION,
  id: 'qwen-code', family: 'qwen', surface: 'cli', displayName: 'Qwen Code CLI',
  adapter: implementedAdapter({
    hostId: 'qwen-code',
    prerequisites: [
      'Install Holt so the `holt` executable is on PATH.',
      'Run inside a Git repository. Automatic mode requires .qwen/ or QWEN.md; otherwise review and use --all-hosts.',
      'Trust the project folder in Qwen Code or project hooks will not run.',
      'User MCP merge requires an existing ~/.qwen/settings.json; Holt never fabricates absent user configuration.',
    ],
    installNote: 'Project scope installs AGENTS.md plus Qwen MCP, PreToolUse, SessionStart, and UserPromptSubmit entries in .qwen/settings.json. User scope adds MCP only; Qwen hooks remain project-scoped.',
    capabilities: {
      rules: adapterCapability('contract-verified', 'host-discovery', false, ['project'], 'Holt installs its bounded AGENTS.md instructions; QWEN.md and .qwen/rules remain user-owned.'),
      mcp: adapterCapability('contract-verified', 'model-pull', false, ['project', 'user'], 'Installed MCP is reactive: the model must choose to call Holt.'),
      lifecycle: adapterCapability('contract-verified', 'host-push', true, ['project'], 'SessionStart and UserPromptSubmit inject changed sibling context; contract-tested, not observed in a live model trajectory.'),
      preTool: adapterCapability('contract-verified', 'host-push', true, ['project'], 'PreToolUse covers canonical run_shell_command, write_file, and edit IDs; source and Holt contract tests pass, but no real Qwen process denial is claimed.'),
    },
  }),
  support: { grade: 'contract-verified', blockingClaim: false,
    summary: 'Holt installs contract-tested MCP, lifecycle context, and a scoped PreToolUse guard; current live-host allow/deny proof is still absent.' },
  version: {
    current: '0.21.5', channel: 'stable', sourceCommit: '32e27415779226b23174a3b0aa6c04e094f1aca2',
    locallyObserved: '0.18.5', compatibility: ['Qwen settings hooks', 'mcpServers', 'AGENTS.md'],
    releaseEvidenceRef: 'qwen-release', sourceEvidenceRef: 'qwen-hook-source',
  },
  environment: { execution: 'local', platforms: ['linux', 'macos', 'windows'], workspaceModel: 'multi-root', rootSelectors: ['cwd', 'workspace roots'], multiRoot: true },
  evidence: { fetchedAt: FETCHED_AT, sources: [
    { id: 'qwen-release', kind: 'official-release', title: 'Qwen Code npm release', url: 'https://registry.npmjs.org/@qwen-code/qwen-code/0.21.5', fetchedAt: FETCHED_AT, version: '0.21.5', commit: null, note: 'Immutable package-version metadata from the primary npm registry.' },
    { id: 'qwen-hooks-docs', kind: 'official-docs', title: 'Qwen Code hooks', url: 'https://github.com/QwenLM/qwen-code/blob/32e27415779226b23174a3b0aa6c04e094f1aca2/docs/users/features/hooks.md', fetchedAt: FETCHED_AT, version: '0.21.5', commit: '32e27415779226b23174a3b0aa6c04e094f1aca2', note: 'Pinned hook configuration and event documentation.' },
    { id: 'qwen-hook-source', kind: 'official-source', title: 'Qwen Code tool hook triggers', url: 'https://github.com/QwenLM/qwen-code/blob/32e27415779226b23174a3b0aa6c04e094f1aca2/packages/core/src/core/toolHookTriggers.ts#L114-L219', fetchedAt: FETCHED_AT, version: '0.21.5', commit: '32e27415779226b23174a3b0aa6c04e094f1aca2', note: 'Pinned source for hook error and proceed behaviour.' },
    { id: 'qwen-hook-runner', kind: 'official-source', title: 'Qwen Code hook runner', url: 'https://github.com/QwenLM/qwen-code/blob/32e27415779226b23174a3b0aa6c04e094f1aca2/packages/core/src/hooks/hookRunner.ts#L712-L838', fetchedAt: FETCHED_AT, version: '0.21.5', commit: '32e27415779226b23174a3b0aa6c04e094f1aca2', note: 'Pinned stdout, exit-code, invalid-output, and timeout handling.' },
    { id: 'qwen-hook-matcher', kind: 'official-source', title: 'Qwen Code hook planner', url: 'https://github.com/QwenLM/qwen-code/blob/32e27415779226b23174a3b0aa6c04e094f1aca2/packages/core/src/hooks/hookPlanner.ts#L247-L278', fetchedAt: FETCHED_AT, version: '0.21.5', commit: '32e27415779226b23174a3b0aa6c04e094f1aca2', note: 'Pinned matcher behaviour; canonical tool IDs matter.' },
    { id: 'qwen-mcp', kind: 'official-docs', title: 'Qwen Code MCP', url: 'https://qwenlm.github.io/qwen-code-docs/en/users/features/mcp/', fetchedAt: FETCHED_AT, version: '0.21.5', commit: null, note: 'MCP config and transport contract.' },
    { id: 'qwen-memory', kind: 'official-docs', title: 'Qwen Code memory', url: 'https://qwenlm.github.io/qwen-code-docs/en/users/features/memory/', fetchedAt: FETCHED_AT, version: '0.21.5', commit: null, note: 'AGENTS.md, QWEN.md, and rule discovery.' },
  ] },
  discovery: { markers: { project: ['.qwen/', 'AGENTS.md', 'QWEN.md'], user: ['~/.qwen/'] }, trust: 'prompted', activation: 'Project hooks run only after folder trust; rules are loaded by documented memory discovery.', observed: proof('not-run', 'Current 0.21.5 discovery has not been driven locally.') },
  rules: {
    state: 'contract-verified',
    files: [
      { scope: 'project', path: 'AGENTS.md', format: 'markdown', activation: 'autoload', precedence: 10 },
      { scope: 'project', path: 'QWEN.md', format: 'markdown', activation: 'autoload', precedence: 20 },
      { scope: 'project', path: '.qwen/rules/*.md', format: 'markdown', activation: 'autoload', precedence: 30 },
    ],
    agentsMd: { supported: true, autoload: true, scope: 'project', evidenceRef: 'qwen-memory' },
    mergeStrategy: 'preserve foreign instructions and add a bounded Holt-owned section', maxBytes: null,
    evidenceRefs: ['qwen-memory'],
  },
  mcp: {
    state: 'contract-verified', trigger: 'model-pull', delivery: 'model-pull',
    configTargets: [
      { scope: 'project', path: '.qwen/settings.json', format: 'json', key: 'mcpServers' },
      { scope: 'user', path: '~/.qwen/settings.json', format: 'json', key: 'mcpServers' },
    ],
    entryShape: { stdio: ['command', 'args', 'env', 'cwd'], http: ['httpUrl'], sse: ['url'] },
    transports: ['stdio', 'http', 'sse'], hotReload: 'unknown', trust: 'prompted',
    mergeStrategy: 'structural JSON merge by server id; preserve foreign settings',
    secrets: 'environment references only', evidenceRefs: ['qwen-mcp'],
  },
  hooks: {
    state: 'contract-verified', trigger: 'host-push', delivery: 'pre-execution-gate',
    packaging: [{ kind: 'direct', scope: 'project', path: '.qwen/settings.json' }, { kind: 'direct', scope: 'user', path: '~/.qwen/settings.json' }],
    configTargets: [{ scope: 'project', path: '.qwen/settings.json', format: 'json', key: 'hooks' }, { scope: 'user', path: '~/.qwen/settings.json', format: 'json', key: 'hooks' }],
    runner: { kind: 'command', commandField: 'command', timeoutSeconds: null },
    preToolUse: {
      event: 'PreToolUse', matchers: ['run_shell_command', 'write_file', 'edit'],
      inputEnvelope: 'Claude-compatible event envelope with tool_name and tool_input',
      toolMappings: [
        { toolIds: ['run_shell_command'], argumentPaths: { command: 'tool_input.command' }, coverage: 'shell', note: 'Use canonical ID; aliases are not regex-expanded.' },
        { toolIds: ['write_file'], argumentPaths: { path: 'tool_input.file_path', content: 'tool_input.content' }, coverage: 'write', note: 'Whole-file write.' },
        { toolIds: ['edit'], argumentPaths: { path: 'tool_input.file_path', oldContent: 'tool_input.old_string', newContent: 'tool_input.new_string', replaceAll: 'tool_input.replace_all' }, coverage: 'edit', note: 'String replacement.' },
      ],
      output: { dialect: 'hookSpecificOutput.permissionDecision plus exit code', allow: 'exit 0 / allow', deny: 'exit 2 or permissionDecision:deny', ask: 'permissionDecision:ask', neutral: 'proceed without a permission decision' },
      neutralAllowPreservesNativePermission: 'unknown',
    },
    lifecycle: [
      { event: 'SessionStart', trigger: 'host-push', delivery: 'model-context', frequency: 'session start', output: 'hookSpecificOutput.additionalContext', deduplication: 'required', reentry: 'none', subagents: 'unverified', evidenceRefs: ['qwen-hooks-docs'] },
      { event: 'UserPromptSubmit', trigger: 'host-push', delivery: 'model-context', frequency: 'each prompt', output: 'hookSpecificOutput.additionalContext', deduplication: 'required', reentry: 'none', subagents: 'unverified', evidenceRefs: ['qwen-hooks-docs'] },
    ],
    failureMatrix: {
      missingBinary: 'allow', spawnError: 'allow', crash: 'allow', exit1: 'allow', exit2: 'deny',
      timeout: 'allow', invalidJson: 'allow', emptyOutput: 'allow', killed: 'allow',
      untrusted: 'unknown', disabled: 'unknown', headlessAsk: 'deny',
    },
    evidenceRefs: ['qwen-hooks-docs', 'qwen-hook-source', 'qwen-hook-runner', 'qwen-hook-matcher'],
  },
  proof: proofSet({
    sourceContract: proof('pass', 'Hook trigger, runner, and matcher paths reviewed at the pinned upstream commit.', ['qwen-hook-source', 'qwen-hook-runner', 'qwen-hook-matcher']),
    configRoundTrip: proof('pass', 'Holt contract tests install, reconcile, parse, and uninstall its MCP and hook entries while preserving foreign Qwen JSONC settings.', ['qwen-hooks-docs', 'qwen-mcp']),
    payloadReplay: proof('pass', 'Holt contract tests replay canonical shell, exact write, full-file edit, and lifecycle payloads through the shipped hook entry point.', ['qwen-hooks-docs', 'qwen-hook-source']),
    upgradeUninstall: proof('pass', 'Holt contract tests reconcile stale commands and remove only Holt-owned Qwen entries.', ['qwen-hooks-docs', 'qwen-mcp']),
  }),
  ownership: { managedPaths: [], mergeStrategy: 'structurally own only Holt entries inside shared settings', uninstall: 'remove only entries tagged or matched as Holt-owned', secrets: 'preserve all foreign keys and secret values byte-for-byte where possible' },
  limitations: ['The profile itself is read-only; `holt integrate` invokes the implemented adapter.', 'Qwen Code 0.21.5 has not been driven locally through a harmless allow and destructive deny.', 'Native permission preservation and subagent propagation remain unverified.'],
};

const auggie = {
  schemaVersion: PROVIDER_PROFILE_SCHEMA_VERSION,
  id: 'auggie-cli', family: 'augment', surface: 'cli', displayName: 'Auggie CLI',
  adapter: frameworkOnlyAdapter({
    rules: 'documented', mcp: 'configuration-ready', lifecycle: 'configuration-ready',
    preTool: 'configuration-ready',
  }),
  support: { grade: 'configuration-ready', blockingClaim: false, summary: 'Official hook/config contract recorded; no source-level or live Holt enforcement proof.' },
  version: { current: '0.34.0', channel: 'stable', sourceCommit: null, locallyObserved: null, compatibility: ['Auggie settings JSONC', 'hooks', 'mcpServers', 'AGENTS.md'], releaseEvidenceRef: 'auggie-release', sourceEvidenceRef: null },
  environment: { execution: 'local', platforms: ['linux', 'macos', 'windows'], workspaceModel: 'multi-root', rootSelectors: ['workspace_roots[]'], multiRoot: true },
  evidence: { fetchedAt: FETCHED_AT, sources: [
    { id: 'auggie-release', kind: 'official-release', title: 'Auggie npm release', url: 'https://registry.npmjs.org/@augmentcode/auggie/0.34.0', fetchedAt: FETCHED_AT, version: '0.34.0', commit: null, note: 'Immutable package-version metadata from the primary npm registry.' },
    { id: 'auggie-config', kind: 'official-docs', title: 'Auggie configuration', url: 'https://docs.augmentcode.com/cli/config', fetchedAt: FETCHED_AT, version: '0.34.0', commit: null, note: 'Settings scopes and JSONC format.' },
    { id: 'auggie-rules', kind: 'official-docs', title: 'Auggie rules', url: 'https://docs.augmentcode.com/cli/rules', fetchedAt: FETCHED_AT, version: '0.34.0', commit: null, note: 'AGENTS.md and Augment rule discovery.' },
    { id: 'auggie-mcp', kind: 'official-docs', title: 'Auggie integrations', url: 'https://docs.augmentcode.com/cli/integrations', fetchedAt: FETCHED_AT, version: '0.34.0', commit: null, note: 'MCP server settings.' },
    { id: 'auggie-hooks', kind: 'official-docs', title: 'Auggie hooks', url: 'https://docs.augmentcode.com/cli/hooks', fetchedAt: FETCHED_AT, version: '0.34.0', commit: null, note: 'Events, payloads, exit codes, and lifecycle stdout.' },
  ] },
  discovery: { markers: { project: ['.augment/', 'AGENTS.md', '.augment-guidelines'], user: ['~/.augment/'] }, trust: 'automatic', activation: 'Documented project/local/user settings precedence.', observed: proof('not-run', 'Current 0.34.0 discovery has not been driven locally.') },
  rules: {
    state: 'documented',
    files: [
      { scope: 'project', path: 'AGENTS.md', format: 'markdown', activation: 'autoload', precedence: 10 },
      { scope: 'project', path: '.augment-guidelines', format: 'markdown', activation: 'autoload', precedence: 20 },
      { scope: 'project', path: '.augment/rules/*.md', format: 'markdown', activation: 'autoload', precedence: 30 },
    ],
    agentsMd: { supported: true, autoload: true, scope: 'project', evidenceRef: 'auggie-rules' },
    mergeStrategy: 'preserve foreign instructions; add a bounded Holt-owned section', maxBytes: null, evidenceRefs: ['auggie-rules'],
  },
  mcp: {
    state: 'configuration-ready', trigger: 'model-pull', delivery: 'model-pull',
    configTargets: [
      { scope: 'project', path: '.augment/settings.json', format: 'jsonc', key: 'mcpServers' },
      { scope: 'local', path: '.augment/settings.local.json', format: 'jsonc', key: 'mcpServers' },
      { scope: 'user', path: '~/.augment/settings.json', format: 'jsonc', key: 'mcpServers' },
    ],
    entryShape: { stdio: ['type', 'command', 'args', 'env'] }, transports: ['stdio'], hotReload: 'unknown', trust: 'automatic',
    mergeStrategy: 'JSONC AST edit preserving comments, order, and foreign settings', secrets: 'environment references only', evidenceRefs: ['auggie-config', 'auggie-mcp'],
  },
  hooks: {
    state: 'configuration-ready', trigger: 'host-push', delivery: 'pre-execution-gate',
    packaging: [{ kind: 'direct', scope: 'project', path: '.augment/settings.json' }, { kind: 'direct', scope: 'local', path: '.augment/settings.local.json' }, { kind: 'direct', scope: 'user', path: '~/.augment/settings.json' }],
    configTargets: [{ scope: 'project', path: '.augment/settings.json', format: 'jsonc', key: 'hooks' }, { scope: 'local', path: '.augment/settings.local.json', format: 'jsonc', key: 'hooks' }, { scope: 'user', path: '~/.augment/settings.json', format: 'jsonc', key: 'hooks' }],
    runner: { kind: 'command', commandField: 'command', timeoutSeconds: 60 },
    preToolUse: {
      event: 'PreToolUse', matchers: ['launch-process', 'str-replace-editor', 'save-file', 'remove-files'],
      inputEnvelope: 'snake_case hook_event_name, conversation_id, workspace_roots, tool_name, tool_input, is_mcp_tool',
      toolMappings: [
        { toolIds: ['launch-process'], argumentPaths: { command: 'tool_input.command' }, coverage: 'shell', note: 'Process launch.' },
        { toolIds: ['str-replace-editor'], argumentPaths: { path: 'tool_input.path', oldContent: 'tool_input.old_str', newContent: 'tool_input.new_str' }, coverage: 'edit', note: 'String replacement.' },
        { toolIds: ['save-file'], argumentPaths: { path: 'tool_input.path', content: 'tool_input.content' }, coverage: 'write', note: 'Whole-file write.' },
      ],
      output: { dialect: 'exit code with optional deny JSON', allow: 'exit 0 with no decision', deny: 'exit 2', ask: 'unsupported; map unknown destructive evidence to deny', neutral: 'exit 0' },
      neutralAllowPreservesNativePermission: 'unknown',
    },
    lifecycle: [{ event: 'SessionStart', trigger: 'host-push', delivery: 'model-context', frequency: 'session start', output: 'stdout/additional context', deduplication: 'required', reentry: 'none', subagents: 'unverified', evidenceRefs: ['auggie-hooks'] }],
    failureMatrix: { missingBinary: 'warn-and-allow', spawnError: 'warn-and-allow', crash: 'warn-and-allow', exit1: 'warn-and-allow', exit2: 'deny', timeout: 'unknown', invalidJson: 'unknown', emptyOutput: 'allow', killed: 'unknown', untrusted: 'not-applicable', disabled: 'not-applicable', headlessAsk: 'deny' },
    evidenceRefs: ['auggie-hooks'],
  },
  proof: proofSet({ sourceContract: proof('not-applicable', 'No public authoritative runner source was identified; official documentation was reviewed.', ['auggie-hooks']) }),
  ownership: { managedPaths: [], mergeStrategy: 'JSONC AST edit of Holt-owned entries only', uninstall: 'remove only Holt-owned hook and MCP entries while preserving comments', secrets: 'never materialize or rewrite secret values' },
  limitations: ['Timeout, malformed-output, killed-process, and neutral permission behaviour need live proof.', 'remove-files payload variants need a captured current payload.', 'No adapter is installed by this profile.'],
};

/** @param {{id:string, displayName:string, surface:'cli'|'ide', version:string, channel:'stable'|'early-access'|'rolling'}} options */
function kiroProfile(options) {
  const versionEvidence = options.surface === 'cli' ? 'kiro-cli-v3' : 'kiro-hooks';
  return {
    schemaVersion: PROVIDER_PROFILE_SCHEMA_VERSION,
    id: options.id, family: 'kiro', surface: options.surface, displayName: options.displayName,
    adapter: frameworkOnlyAdapter({
      rules: 'documented', mcp: 'configuration-ready', lifecycle: 'documented',
      preTool: 'documented',
    }),
    support: { grade: 'configuration-ready', blockingClaim: false, summary: 'MCP/rules/lifecycle config is documented; the current pre-tool payload and conflicting failure docs prevent a blocking adapter claim.' },
    version: { current: options.version, channel: options.channel, sourceCommit: null, locallyObserved: null, compatibility: ['hook schema v1', 'MCP mcpServers', 'AGENTS.md steering'], releaseEvidenceRef: versionEvidence, sourceEvidenceRef: null },
    environment: { execution: 'local', platforms: ['linux', 'macos', 'windows'], workspaceModel: 'multi-root', rootSelectors: ['workspace root', 'cwd'], multiRoot: true },
    evidence: { fetchedAt: FETCHED_AT, sources: [
      { id: 'kiro-cli-v3', kind: 'official-release', title: 'Kiro CLI v3', url: 'https://kiro.dev/docs/cli/v3/', fetchedAt: FETCHED_AT, version: '3.0 early access', commit: null, note: 'CLI v3 compatibility and release channel.' },
      { id: 'kiro-hooks', kind: 'official-docs', title: 'Kiro hooks', url: 'https://kiro.dev/docs/hooks/', fetchedAt: FETCHED_AT, version: 'hook schema v1', commit: null, note: 'Current hook overview and exit-code behaviour.' },
      { id: 'kiro-hook-types', kind: 'official-docs', title: 'Kiro hook types', url: 'https://kiro.dev/docs/hooks/types/', fetchedAt: FETCHED_AT, version: 'hook schema v1', commit: null, note: 'PreToolUse categories and lifecycle events.' },
      { id: 'kiro-hook-actions', kind: 'official-docs', title: 'Kiro hook actions', url: 'https://kiro.dev/docs/hooks/actions/', fetchedAt: FETCHED_AT, version: 'hook schema v1', commit: null, note: 'Older action page conflicts with the newer overview on nonzero exit semantics.' },
      { id: 'kiro-mcp', kind: 'official-docs', title: 'Kiro MCP configuration', url: 'https://kiro.dev/docs/cli/mcp/configuration/', fetchedAt: FETCHED_AT, version: 'CLI 3.0', commit: null, note: 'MCP paths, server entries, and hot reload.' },
      { id: 'kiro-steering', kind: 'official-docs', title: 'Kiro steering', url: 'https://kiro.dev/docs/cli/steering/', fetchedAt: FETCHED_AT, version: 'CLI 3.0', commit: null, note: 'AGENTS.md and .kiro/steering discovery.' },
    ] },
    discovery: { markers: { project: ['.kiro/', 'AGENTS.md'], user: ['~/.kiro/'] }, trust: 'manual', activation: 'Steering autoloads; hook trust/enablement must be confirmed per surface.', observed: proof('not-run', `Current ${options.version} discovery has not been driven locally.`) },
    rules: {
      state: 'documented', files: [
        { scope: 'project', path: 'AGENTS.md', format: 'markdown', activation: 'always included', precedence: 10 },
        { scope: 'project', path: '.kiro/steering/*.md', format: 'markdown', activation: 'steering-defined', precedence: 20 },
        { scope: 'user', path: '~/.kiro/steering/*.md', format: 'markdown', activation: 'global steering', precedence: 0 },
      ],
      agentsMd: { supported: true, autoload: true, scope: 'project', evidenceRef: 'kiro-steering' }, mergeStrategy: 'preserve steering; add a bounded Holt-owned file or section', maxBytes: null, evidenceRefs: ['kiro-steering'],
    },
    mcp: {
      state: 'configuration-ready', trigger: 'model-pull', delivery: 'model-pull',
      configTargets: [{ scope: 'project', path: '.kiro/settings/mcp.json', format: 'json', key: 'mcpServers' }, { scope: 'user', path: '~/.kiro/settings/mcp.json', format: 'json', key: 'mcpServers' }],
      entryShape: { stdio: ['command', 'args', 'env'], remote: ['url'] }, transports: ['stdio', 'http'], hotReload: true, trust: 'manual',
      mergeStrategy: 'structural JSON merge by server id', secrets: 'environment references only', evidenceRefs: ['kiro-mcp'],
    },
    hooks: {
      state: 'documented', trigger: 'host-push', delivery: 'pre-execution-gate',
      packaging: [{ kind: 'direct', scope: 'project', path: '.kiro/hooks/<holt-id>.json' }],
      configTargets: [{ scope: 'project', path: '.kiro/hooks/<holt-id>.json', format: 'json', key: 'hooks' }],
      runner: { kind: 'command', commandField: 'action.command', timeoutSeconds: null },
      preToolUse: {
        event: 'PreToolUse', matchers: ['shell', 'write', '@mcp', '@builtin', '*'],
        inputEnvelope: 'current unified stdin payload is not documented precisely enough to implement',
        toolMappings: [],
        output: { dialect: 'exit code', allow: 'exit 0', deny: 'exit 2 in current overview', ask: 'unsupported/undocumented', neutral: 'not proven to preserve native permission prompts' },
        neutralAllowPreservesNativePermission: 'unknown',
      },
      lifecycle: [
        { event: 'SessionStart', trigger: 'host-push', delivery: 'model-context', frequency: 'session start', output: 'stdout', deduplication: 'required', reentry: 'none', subagents: 'unverified', evidenceRefs: ['kiro-hook-types'] },
        { event: 'UserPromptSubmit', trigger: 'host-push', delivery: 'model-context', frequency: 'each prompt', output: 'stdout', deduplication: 'required', reentry: 'none', subagents: 'unverified', evidenceRefs: ['kiro-hook-types'] },
      ],
      failureMatrix: { missingBinary: 'unknown', spawnError: 'unknown', crash: 'unknown', exit1: 'warn-and-allow', exit2: 'deny', timeout: 'unknown', invalidJson: 'not-applicable', emptyOutput: 'allow', killed: 'unknown', untrusted: 'unknown', disabled: 'not-applicable', headlessAsk: 'unknown' },
      evidenceRefs: ['kiro-hooks', 'kiro-hook-types', 'kiro-hook-actions'],
    },
    proof: proofSet({ sourceContract: proof('not-applicable', 'No authoritative public runner source was identified; official pages conflict on nonzero exits.', ['kiro-hooks', 'kiro-hook-actions']) }),
    ownership: { managedPaths: ['.kiro/hooks/holt.json'], mergeStrategy: 'own one hook file; merge only a Holt server entry in shared MCP JSON', uninstall: 'remove the Holt hook file and Holt MCP entry only', secrets: 'never copy or rewrite secret values' },
    limitations: ['Do not mix legacy CLI v2 embedded hook configuration into CLI v3.', 'The current PreToolUse stdin envelope is insufficiently documented.', 'New and old official pages conflict on whether non-2 nonzero exits proceed.', 'No adapter is installed by this profile.'],
  };
}

const kiroIde = kiroProfile({ id: 'kiro-ide', displayName: 'Kiro IDE', surface: 'ide', version: 'rolling', channel: 'rolling' });
const kiroCli = kiroProfile({ id: 'kiro-cli-v3', displayName: 'Kiro CLI v3', surface: 'cli', version: '3.0 early access', channel: 'early-access' });

const BUILT_INS = [antigravity2, antigravityIde, antigravityCli, qwenCode, auggie, kiroIde, kiroCli];

/** @param {string} path @param {unknown} value @returns {never} */
function fail(path, value) {
  throw new TypeError(`provider profile ${path}: ${String(value)}`);
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** @param {unknown} value @param {string} path @param {Set<object>} [seen] */
function assertJsonSerializable(value, path, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(path, 'numbers must be finite');
    return;
  }
  if (typeof value !== 'object') fail(path, `must be JSON-serializable, got ${typeof value}`);
  if (seen.has(/** @type {object} */ (value))) fail(path, 'must not contain cycles');
  seen.add(/** @type {object} */ (value));
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonSerializable(item, `${path}[${index}]`, seen));
  } else {
    if (!isPlainObject(value)) fail(path, 'must contain plain objects only');
    for (const [key, item] of Object.entries(value)) assertJsonSerializable(item, `${path}.${key}`, seen);
  }
  seen.delete(/** @type {object} */ (value));
}

/** @param {unknown} value @param {string} path @returns {Record<string, any>} */
function objectAt(value, path) {
  if (!isPlainObject(value)) fail(path, 'must be an object');
  return /** @type {Record<string, any>} */ (value);
}

/** @param {Record<string, any>} value @param {string[]} required @param {string[]} optional @param {string} path */
function exactKeys(value, required, optional, path) {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, 'is required');
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${path}.${key}`, `is not part of schema v${PROVIDER_PROFILE_SCHEMA_VERSION}`);
}

/** @param {unknown} value @param {string} path */
function nonEmptyString(value, path) {
  if (typeof value !== 'string' || value.trim() === '') fail(path, 'must be a non-empty string');
}

/** @param {unknown} value @param {readonly string[]} vocabulary @param {string} path */
function oneOf(value, vocabulary, path) {
  if (typeof value !== 'string' || !vocabulary.includes(value)) fail(path, `must be one of: ${vocabulary.join(', ')}`);
}

/** @param {unknown} value @param {string} path @param {{allowEmpty?:boolean}} [options] @returns {string[]} */
function stringArray(value, path, options = {}) {
  if (!Array.isArray(value) || (!options.allowEmpty && value.length === 0)) fail(path, 'must be a non-empty string array');
  for (let index = 0; index < value.length; index += 1) nonEmptyString(value[index], `${path}[${index}]`);
  if (new Set(value).size !== value.length) fail(path, 'must not contain duplicates');
  return /** @type {string[]} */ (value);
}

/** @param {unknown} value @param {string} path */
function validateProofItem(value, path) {
  const item = objectAt(value, path);
  exactKeys(item, ['state', 'evidenceRefs', 'note'], [], path);
  oneOf(item.state, PROVIDER_PROFILE_VOCABULARY.proofStates, `${path}.state`);
  stringArray(item.evidenceRefs, `${path}.evidenceRefs`, { allowEmpty: true });
  nonEmptyString(item.note, `${path}.note`);
}

/** @param {unknown} value @param {string} path */
function validateConfigTargets(value, path) {
  if (!Array.isArray(value)) fail(path, 'must be an array');
  for (let index = 0; index < value.length; index += 1) {
    const target = objectAt(value[index], `${path}[${index}]`);
    exactKeys(target, ['scope', 'path', 'format', 'key'], [], `${path}[${index}]`);
    for (const key of ['scope', 'path', 'format', 'key']) nonEmptyString(target[key], `${path}[${index}].${key}`);
  }
}

/** @param {unknown} value @param {Set<string>} sourceIds @param {string} path */
function validateEvidenceReferences(value, sourceIds, path) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateEvidenceReferences(item, sourceIds, `${path}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (key === 'evidenceRefs') {
      for (const ref of stringArray(item, `${path}.${key}`, { allowEmpty: true })) {
        if (!sourceIds.has(ref)) fail(`${path}.${key}`, `references unknown evidence id ${ref}`);
      }
    } else if (key === 'evidenceRef' || key.endsWith('EvidenceRef')) {
      if (item !== null) {
        nonEmptyString(item, `${path}.${key}`);
        if (!sourceIds.has(/** @type {string} */ (item))) fail(`${path}.${key}`, `references unknown evidence id ${String(item)}`);
      }
    } else {
      validateEvidenceReferences(item, sourceIds, `${path}.${key}`);
    }
  }
}

/**
 * Validate one provider profile. Throws a path-bearing TypeError on the first dishonest or
 * malformed field and returns true otherwise.
 *
 * @param {unknown} candidate
 * @returns {true}
 */
export function validateProviderProfile(candidate) {
  assertJsonSerializable(candidate, '$');
  const profile = objectAt(candidate, '$');
  exactKeys(profile, ['schemaVersion', 'id', 'family', 'surface', 'displayName', 'adapter', 'support', 'version', 'environment', 'evidence', 'discovery', 'rules', 'mcp', 'hooks', 'proof', 'ownership', 'limitations'], [], '$');
  if (profile.schemaVersion !== PROVIDER_PROFILE_SCHEMA_VERSION) fail('$.schemaVersion', `must equal ${PROVIDER_PROFILE_SCHEMA_VERSION}`);
  for (const key of ['id', 'family', 'displayName']) nonEmptyString(profile[key], `$.${key}`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(profile.id)) fail('$.id', 'must be lowercase kebab-case');
  oneOf(profile.surface, PROVIDER_PROFILE_VOCABULARY.surfaces, '$.surface');

  const adapter = objectAt(profile.adapter, '$.adapter');
  exactKeys(adapter, ['implementation', 'verification', 'hostId', 'install', 'capabilities'], [], '$.adapter');
  oneOf(adapter.implementation, PROVIDER_PROFILE_VOCABULARY.adapterImplementations, '$.adapter.implementation');
  oneOf(adapter.verification, PROVIDER_PROFILE_VOCABULARY.adapterVerifications, '$.adapter.verification');
  if (adapter.hostId !== null) nonEmptyString(adapter.hostId, '$.adapter.hostId');
  const install = objectAt(adapter.install, '$.adapter.install');
  const installCommandKeys = ['detectedProject', 'explicitProject', 'detectedUser', 'explicitUser'];
  exactKeys(install, [...installCommandKeys, 'prerequisites', 'scopes', 'note'], [], '$.adapter.install');
  for (const key of installCommandKeys) {
    if (install[key] !== null) nonEmptyString(install[key], `$.adapter.install.${key}`);
  }
  stringArray(install.prerequisites, '$.adapter.install.prerequisites');
  const installScopes = stringArray(install.scopes, '$.adapter.install.scopes', { allowEmpty: true });
  for (const scope of installScopes) oneOf(scope, PROVIDER_PROFILE_VOCABULARY.installScopes, '$.adapter.install.scopes');
  nonEmptyString(install.note, '$.adapter.install.note');

  const capabilities = objectAt(adapter.capabilities, '$.adapter.capabilities');
  exactKeys(capabilities, ['rules', 'mcp', 'lifecycle', 'preTool'], [], '$.adapter.capabilities');
  const expectedInitiation = {
    rules: ['host-discovery', false], mcp: ['model-pull', false],
    lifecycle: ['host-push', true], preTool: ['host-push', true],
  };
  const installedCapabilityScopes = new Set();
  for (const [name, expected] of Object.entries(expectedInitiation)) {
    const capability = objectAt(capabilities[name], `$.adapter.capabilities.${name}`);
    exactKeys(capability, ['state', 'initiation', 'proactive', 'installedScopes', 'note'], [], `$.adapter.capabilities.${name}`);
    oneOf(capability.state, PROVIDER_PROFILE_VOCABULARY.capabilityStates, `$.adapter.capabilities.${name}.state`);
    oneOf(capability.initiation, PROVIDER_PROFILE_VOCABULARY.capabilityInitiators, `$.adapter.capabilities.${name}.initiation`);
    if (capability.initiation !== expected[0]) fail(`$.adapter.capabilities.${name}.initiation`, `must be ${expected[0]}`);
    if (capability.proactive !== expected[1]) fail(`$.adapter.capabilities.${name}.proactive`, `must be ${expected[1]}`);
    const scopes = stringArray(capability.installedScopes, `$.adapter.capabilities.${name}.installedScopes`, { allowEmpty: true });
    for (const scope of scopes) {
      oneOf(scope, PROVIDER_PROFILE_VOCABULARY.installScopes, `$.adapter.capabilities.${name}.installedScopes`);
      installedCapabilityScopes.add(scope);
    }
    if (scopes.length > 0 && !['contract-verified', 'live-verified'].includes(capability.state)) {
      fail(`$.adapter.capabilities.${name}.state`, 'an installed capability must be contract-verified or live-verified');
    }
    nonEmptyString(capability.note, `$.adapter.capabilities.${name}.note`);
  }
  if (installScopes.length !== installedCapabilityScopes.size
    || installScopes.some((scope) => !installedCapabilityScopes.has(scope))) {
    fail('$.adapter.install.scopes', 'must exactly match the scopes of installed capabilities');
  }
  if (adapter.implementation === 'framework-only') {
    if (adapter.hostId !== null) fail('$.adapter.hostId', 'must be null for framework-only profiles');
    if (adapter.verification !== 'unverified') fail('$.adapter.verification', 'framework-only profiles must be unverified');
    if (installCommandKeys.some((key) => install[key] !== null)) fail('$.adapter.install', 'framework-only profiles cannot expose an install command');
    if (installScopes.length > 0) fail('$.adapter.install.scopes', 'framework-only profiles cannot install scopes');
    for (const [name, capability] of Object.entries(capabilities)) {
      if (['contract-verified', 'live-verified'].includes(capability.state)) {
        fail(`$.adapter.capabilities.${name}.state`, 'framework-only capabilities cannot claim adapter verification');
      }
    }
  } else {
    nonEmptyString(adapter.hostId, '$.adapter.hostId');
    if (install.explicitProject === null) fail('$.adapter.install.explicitProject', 'implemented adapters need an explicit project install command');
    if (adapter.verification === 'contract-verified'
      && !Object.values(capabilities).some((capability) => capability.state === 'contract-verified')) {
      fail('$.adapter.verification', 'contract-verified requires a contract-verified capability');
    }
    if (adapter.verification === 'live-verified'
      && !Object.values(capabilities).some((capability) => capability.state === 'live-verified')) {
      fail('$.adapter.verification', 'live-verified requires a live-verified capability');
    }
  }

  const support = objectAt(profile.support, '$.support');
  exactKeys(support, ['grade', 'blockingClaim', 'summary'], [], '$.support');
  oneOf(support.grade, PROVIDER_PROFILE_VOCABULARY.supportGrades, '$.support.grade');
  if (typeof support.blockingClaim !== 'boolean') fail('$.support.blockingClaim', 'must be boolean');
  if (support.blockingClaim !== (support.grade === 'blocking')) fail('$.support.blockingClaim', 'must be true exactly when grade is blocking');
  nonEmptyString(support.summary, '$.support.summary');
  if (support.grade === 'contract-verified' && adapter.verification === 'unverified') {
    fail('$.support.grade', 'contract-verified support requires a verified implemented adapter');
  }
  if (adapter.implementation === 'framework-only' && ['contract-verified', 'blocking'].includes(support.grade)) {
    fail('$.support.grade', 'framework-only profiles cannot claim an implemented support grade');
  }
  if (support.grade === 'blocking' && adapter.verification !== 'live-verified') {
    fail('$.adapter.verification', 'must be live-verified before a blocking claim');
  }

  const version = objectAt(profile.version, '$.version');
  exactKeys(version, ['current', 'channel', 'sourceCommit', 'locallyObserved', 'compatibility', 'releaseEvidenceRef', 'sourceEvidenceRef'], [], '$.version');
  nonEmptyString(version.current, '$.version.current');
  oneOf(version.channel, PROVIDER_PROFILE_VOCABULARY.channels, '$.version.channel');
  for (const key of ['sourceCommit', 'locallyObserved', 'sourceEvidenceRef']) if (version[key] !== null) nonEmptyString(version[key], `$.version.${key}`);
  if (version.sourceCommit !== null && !/^[0-9a-f]{7,64}$/.test(version.sourceCommit)) fail('$.version.sourceCommit', 'must be a lowercase hexadecimal commit id or null');
  stringArray(version.compatibility, '$.version.compatibility');
  nonEmptyString(version.releaseEvidenceRef, '$.version.releaseEvidenceRef');

  const environment = objectAt(profile.environment, '$.environment');
  exactKeys(environment, ['execution', 'platforms', 'workspaceModel', 'rootSelectors', 'multiRoot'], [], '$.environment');
  oneOf(environment.execution, PROVIDER_PROFILE_VOCABULARY.environments, '$.environment.execution');
  const platforms = stringArray(environment.platforms, '$.environment.platforms');
  for (const platform of platforms) oneOf(platform, ['linux', 'macos', 'windows'], '$.environment.platforms');
  oneOf(environment.workspaceModel, PROVIDER_PROFILE_VOCABULARY.workspaceModels, '$.environment.workspaceModel');
  stringArray(environment.rootSelectors, '$.environment.rootSelectors');
  if (typeof environment.multiRoot !== 'boolean') fail('$.environment.multiRoot', 'must be boolean');

  const evidence = objectAt(profile.evidence, '$.evidence');
  exactKeys(evidence, ['fetchedAt', 'sources'], [], '$.evidence');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(evidence.fetchedAt)) fail('$.evidence.fetchedAt', 'must be YYYY-MM-DD');
  if (!Array.isArray(evidence.sources) || evidence.sources.length === 0) fail('$.evidence.sources', 'must be a non-empty array');
  const sourceIds = new Set();
  let hasPinnedVersionOrCommit = false;
  for (let index = 0; index < evidence.sources.length; index += 1) {
    const source = objectAt(evidence.sources[index], `$.evidence.sources[${index}]`);
    exactKeys(source, ['id', 'kind', 'title', 'url', 'fetchedAt', 'version', 'commit', 'note'], [], `$.evidence.sources[${index}]`);
    for (const key of ['id', 'title', 'url', 'fetchedAt', 'note']) nonEmptyString(source[key], `$.evidence.sources[${index}].${key}`);
    if (sourceIds.has(source.id)) fail(`$.evidence.sources[${index}].id`, 'must be unique');
    sourceIds.add(source.id);
    oneOf(source.kind, PROVIDER_PROFILE_VOCABULARY.evidenceKinds, `$.evidence.sources[${index}].kind`);
    if (!source.url.startsWith('https://')) fail(`$.evidence.sources[${index}].url`, 'must be a primary HTTPS URL');
    if (source.fetchedAt !== evidence.fetchedAt) fail(`$.evidence.sources[${index}].fetchedAt`, 'must match profile fetchedAt');
    for (const key of ['version', 'commit']) if (source[key] !== null) nonEmptyString(source[key], `$.evidence.sources[${index}].${key}`);
    if (source.commit !== null && !/^[0-9a-f]{7,64}$/.test(source.commit)) fail(`$.evidence.sources[${index}].commit`, 'must be a lowercase hexadecimal commit id or null');
    if (source.version !== null || source.commit !== null) hasPinnedVersionOrCommit = true;
  }
  if (!hasPinnedVersionOrCommit) fail('$.evidence.sources', 'must include version or commit evidence');

  const discovery = objectAt(profile.discovery, '$.discovery');
  exactKeys(discovery, ['markers', 'trust', 'activation', 'observed'], [], '$.discovery');
  const markers = objectAt(discovery.markers, '$.discovery.markers');
  exactKeys(markers, ['project', 'user'], [], '$.discovery.markers');
  stringArray(markers.project, '$.discovery.markers.project', { allowEmpty: true });
  stringArray(markers.user, '$.discovery.markers.user', { allowEmpty: true });
  oneOf(discovery.trust, PROVIDER_PROFILE_VOCABULARY.trustStates, '$.discovery.trust');
  nonEmptyString(discovery.activation, '$.discovery.activation');
  validateProofItem(discovery.observed, '$.discovery.observed');

  const rules = objectAt(profile.rules, '$.rules');
  exactKeys(rules, ['state', 'files', 'agentsMd', 'mergeStrategy', 'maxBytes', 'evidenceRefs'], [], '$.rules');
  oneOf(rules.state, PROVIDER_PROFILE_VOCABULARY.capabilityStates, '$.rules.state');
  if (!Array.isArray(rules.files)) fail('$.rules.files', 'must be an array');
  for (let index = 0; index < rules.files.length; index += 1) {
    const file = objectAt(rules.files[index], `$.rules.files[${index}]`);
    exactKeys(file, ['scope', 'path', 'format', 'activation', 'precedence'], [], `$.rules.files[${index}]`);
    for (const key of ['scope', 'path', 'format', 'activation']) nonEmptyString(file[key], `$.rules.files[${index}].${key}`);
    if (!Number.isInteger(file.precedence)) fail(`$.rules.files[${index}].precedence`, 'must be an integer');
  }
  const agentsMd = objectAt(rules.agentsMd, '$.rules.agentsMd');
  exactKeys(agentsMd, ['supported', 'autoload', 'scope', 'evidenceRef'], [], '$.rules.agentsMd');
  if (typeof agentsMd.supported !== 'boolean' || typeof agentsMd.autoload !== 'boolean') fail('$.rules.agentsMd', 'supported and autoload must be boolean');
  nonEmptyString(agentsMd.scope, '$.rules.agentsMd.scope');
  nonEmptyString(agentsMd.evidenceRef, '$.rules.agentsMd.evidenceRef');
  nonEmptyString(rules.mergeStrategy, '$.rules.mergeStrategy');
  if (rules.maxBytes !== null && (!Number.isInteger(rules.maxBytes) || rules.maxBytes <= 0)) fail('$.rules.maxBytes', 'must be a positive integer or null');
  stringArray(rules.evidenceRefs, '$.rules.evidenceRefs', { allowEmpty: true });

  const mcp = objectAt(profile.mcp, '$.mcp');
  exactKeys(mcp, ['state', 'trigger', 'delivery', 'configTargets', 'entryShape', 'transports', 'hotReload', 'trust', 'mergeStrategy', 'secrets', 'evidenceRefs'], [], '$.mcp');
  oneOf(mcp.state, PROVIDER_PROFILE_VOCABULARY.capabilityStates, '$.mcp.state');
  if (mcp.trigger !== 'model-pull' || mcp.delivery !== 'model-pull') fail('$.mcp', 'MCP must be model-pull; proactive host-push belongs under lifecycle hooks');
  validateConfigTargets(mcp.configTargets, '$.mcp.configTargets');
  const entryShape = objectAt(mcp.entryShape, '$.mcp.entryShape');
  for (const [transport, keys] of Object.entries(entryShape)) {
    nonEmptyString(transport, `$.mcp.entryShape.${transport}`);
    stringArray(keys, `$.mcp.entryShape.${transport}`);
  }
  stringArray(mcp.transports, '$.mcp.transports');
  if (typeof mcp.hotReload !== 'boolean' && mcp.hotReload !== 'unknown') fail('$.mcp.hotReload', 'must be boolean or unknown');
  oneOf(mcp.trust, PROVIDER_PROFILE_VOCABULARY.trustStates, '$.mcp.trust');
  for (const key of ['mergeStrategy', 'secrets']) nonEmptyString(mcp[key], `$.mcp.${key}`);
  stringArray(mcp.evidenceRefs, '$.mcp.evidenceRefs', { allowEmpty: true });

  const hooks = objectAt(profile.hooks, '$.hooks');
  exactKeys(hooks, ['state', 'trigger', 'delivery', 'packaging', 'configTargets', 'runner', 'preToolUse', 'lifecycle', 'failureMatrix', 'evidenceRefs'], [], '$.hooks');
  oneOf(hooks.state, PROVIDER_PROFILE_VOCABULARY.capabilityStates, '$.hooks.state');
  if (hooks.trigger !== 'host-push' || hooks.delivery !== 'pre-execution-gate') fail('$.hooks', 'pre-tool hooks must be host-push pre-execution gates');
  if (!Array.isArray(hooks.packaging)) fail('$.hooks.packaging', 'must be an array');
  for (let index = 0; index < hooks.packaging.length; index += 1) {
    const packaging = objectAt(hooks.packaging[index], `$.hooks.packaging[${index}]`);
    exactKeys(packaging, ['kind', 'scope', 'path'], [], `$.hooks.packaging[${index}]`);
    for (const key of ['kind', 'scope', 'path']) nonEmptyString(packaging[key], `$.hooks.packaging[${index}].${key}`);
  }
  validateConfigTargets(hooks.configTargets, '$.hooks.configTargets');
  const runner = objectAt(hooks.runner, '$.hooks.runner');
  exactKeys(runner, ['kind', 'commandField', 'timeoutSeconds'], [], '$.hooks.runner');
  nonEmptyString(runner.kind, '$.hooks.runner.kind');
  nonEmptyString(runner.commandField, '$.hooks.runner.commandField');
  if (runner.timeoutSeconds !== null && (typeof runner.timeoutSeconds !== 'number' || runner.timeoutSeconds <= 0)) fail('$.hooks.runner.timeoutSeconds', 'must be a positive number or null');
  const pre = objectAt(hooks.preToolUse, '$.hooks.preToolUse');
  exactKeys(pre, ['event', 'matchers', 'inputEnvelope', 'toolMappings', 'output', 'neutralAllowPreservesNativePermission'], [], '$.hooks.preToolUse');
  nonEmptyString(pre.event, '$.hooks.preToolUse.event');
  stringArray(pre.matchers, '$.hooks.preToolUse.matchers');
  nonEmptyString(pre.inputEnvelope, '$.hooks.preToolUse.inputEnvelope');
  if (!Array.isArray(pre.toolMappings)) fail('$.hooks.preToolUse.toolMappings', 'must be an array');
  if (['contract-verified', 'live-verified'].includes(hooks.state) && pre.toolMappings.length === 0) fail('$.hooks.preToolUse.toolMappings', 'verified hook states require concrete tool mappings');
  for (let index = 0; index < pre.toolMappings.length; index += 1) {
    const mapping = objectAt(pre.toolMappings[index], `$.hooks.preToolUse.toolMappings[${index}]`);
    exactKeys(mapping, ['toolIds', 'argumentPaths', 'coverage', 'note'], [], `$.hooks.preToolUse.toolMappings[${index}]`);
    stringArray(mapping.toolIds, `$.hooks.preToolUse.toolMappings[${index}].toolIds`);
    const argumentPaths = objectAt(mapping.argumentPaths, `$.hooks.preToolUse.toolMappings[${index}].argumentPaths`);
    if (Object.keys(argumentPaths).length === 0) fail(`$.hooks.preToolUse.toolMappings[${index}].argumentPaths`, 'must not be empty');
    for (const [name, argumentPath] of Object.entries(argumentPaths)) {
      nonEmptyString(name, `$.hooks.preToolUse.toolMappings[${index}].argumentPaths`);
      nonEmptyString(argumentPath, `$.hooks.preToolUse.toolMappings[${index}].argumentPaths.${name}`);
    }
    nonEmptyString(mapping.coverage, `$.hooks.preToolUse.toolMappings[${index}].coverage`);
    nonEmptyString(mapping.note, `$.hooks.preToolUse.toolMappings[${index}].note`);
  }
  const output = objectAt(pre.output, '$.hooks.preToolUse.output');
  exactKeys(output, ['dialect', 'allow', 'deny', 'ask', 'neutral'], [], '$.hooks.preToolUse.output');
  for (const key of ['dialect', 'allow', 'deny', 'ask', 'neutral']) nonEmptyString(output[key], `$.hooks.preToolUse.output.${key}`);
  oneOf(pre.neutralAllowPreservesNativePermission, PROVIDER_PROFILE_VOCABULARY.neutralPermissionStates, '$.hooks.preToolUse.neutralAllowPreservesNativePermission');
  if (!Array.isArray(hooks.lifecycle)) fail('$.hooks.lifecycle', 'must be an array');
  for (let index = 0; index < hooks.lifecycle.length; index += 1) {
    const lifecycle = objectAt(hooks.lifecycle[index], `$.hooks.lifecycle[${index}]`);
    exactKeys(lifecycle, ['event', 'trigger', 'delivery', 'frequency', 'output', 'deduplication', 'reentry', 'subagents', 'evidenceRefs'], [], `$.hooks.lifecycle[${index}]`);
    for (const key of ['event', 'frequency', 'output', 'deduplication', 'reentry', 'subagents']) nonEmptyString(lifecycle[key], `$.hooks.lifecycle[${index}].${key}`);
    if (lifecycle.trigger !== 'host-push') fail(`$.hooks.lifecycle[${index}].trigger`, 'lifecycle context must be host-push');
    oneOf(lifecycle.delivery, PROVIDER_PROFILE_VOCABULARY.deliveryModes, `$.hooks.lifecycle[${index}].delivery`);
    stringArray(lifecycle.evidenceRefs, `$.hooks.lifecycle[${index}].evidenceRefs`, { allowEmpty: true });
  }
  const failures = objectAt(hooks.failureMatrix, '$.hooks.failureMatrix');
  exactKeys(failures, FAILURE_KEYS, [], '$.hooks.failureMatrix');
  for (const key of FAILURE_KEYS) oneOf(failures[key], PROVIDER_PROFILE_VOCABULARY.failureOutcomes, `$.hooks.failureMatrix.${key}`);
  stringArray(hooks.evidenceRefs, '$.hooks.evidenceRefs', { allowEmpty: true });

  const allProof = objectAt(profile.proof, '$.proof');
  exactKeys(allProof, PROOF_KEYS, [], '$.proof');
  for (const key of PROOF_KEYS.filter((key) => key !== 'platforms')) validateProofItem(allProof[key], `$.proof.${key}`);
  const proofPlatforms = objectAt(allProof.platforms, '$.proof.platforms');
  exactKeys(proofPlatforms, ['linux', 'macos', 'windows'], [], '$.proof.platforms');
  for (const platform of ['linux', 'macos', 'windows']) validateProofItem(proofPlatforms[platform], `$.proof.platforms.${platform}`);

  const capabilityRank = (state) => PROVIDER_PROFILE_VOCABULARY.capabilityStates.indexOf(state);
  for (const [name, providerState] of [
    ['rules', rules.state], ['mcp', mcp.state], ['preTool', hooks.state],
  ]) {
    if (capabilityRank(capabilities[name].state) > capabilityRank(providerState)) {
      fail(`$.adapter.capabilities.${name}.state`, `cannot outrank the provider contract state ${providerState}`);
    }
  }
  if (['contract-verified', 'live-verified'].includes(adapter.verification)) {
    for (const key of ['configRoundTrip', 'upgradeUninstall']) {
      if (allProof[key].state !== 'pass') {
        fail(`$.proof.${key}.state`, `must pass before adapter verification can be ${adapter.verification}`);
      }
    }
  }
  if (['contract-verified', 'live-verified'].includes(capabilities.preTool.state)
    && allProof.payloadReplay.state !== 'pass') {
    fail('$.proof.payloadReplay.state', 'must pass before the pre-tool capability can be verified');
  }
  if (adapter.verification === 'live-verified') {
    if (allProof.nativeDiscovery.state !== 'pass') {
      fail('$.proof.nativeDiscovery.state', 'must pass before adapter verification can be live-verified');
    }
    if (!['liveAllow', 'liveDeny', 'lifecycleContext', 'mcpRoundTrip']
      .some((key) => allProof[key].state === 'pass')) {
      fail('$.adapter.verification', 'live-verified requires at least one exercised live capability');
    }
    if (capabilities.lifecycle.state === 'live-verified' && allProof.lifecycleContext.state !== 'pass') {
      fail('$.proof.lifecycleContext.state', 'must pass before lifecycle can be live-verified');
    }
    if (capabilities.mcp.state === 'live-verified' && allProof.mcpRoundTrip.state !== 'pass') {
      fail('$.proof.mcpRoundTrip.state', 'must pass before MCP can be live-verified');
    }
    if (capabilities.preTool.state === 'live-verified'
      && !['liveAllow', 'liveDeny'].some((key) => allProof[key].state === 'pass')) {
      fail('$.adapter.capabilities.preTool.state', 'live-verified pre-tool requires a live allow or deny run');
    }
  }

  const ownership = objectAt(profile.ownership, '$.ownership');
  exactKeys(ownership, ['managedPaths', 'mergeStrategy', 'uninstall', 'secrets'], [], '$.ownership');
  stringArray(ownership.managedPaths, '$.ownership.managedPaths', { allowEmpty: true });
  for (const key of ['mergeStrategy', 'uninstall', 'secrets']) nonEmptyString(ownership[key], `$.ownership.${key}`);
  stringArray(profile.limitations, '$.limitations');

  validateEvidenceReferences(profile, sourceIds, '$');

  if (support.grade === 'blocking') {
    if (capabilities.preTool.state !== 'live-verified') {
      fail('$.adapter.capabilities.preTool.state', 'must be live-verified before a blocking claim');
    }
    for (const key of ['liveAllow', 'liveDeny', 'failureInjection']) {
      if (allProof[key].state !== 'pass') fail(`$.proof.${key}.state`, 'must pass before a blocking claim');
    }
    if (hooks.state !== 'live-verified') fail('$.hooks.state', 'must be live-verified before a blocking claim');
    if (pre.neutralAllowPreservesNativePermission !== 'yes') fail('$.hooks.preToolUse.neutralAllowPreservesNativePermission', 'must be proven yes before a blocking claim');
    for (const key of FAILURE_KEYS) if (failures[key] === 'unknown') fail(`$.hooks.failureMatrix.${key}`, 'cannot be unknown for a blocking claim');
  }
  return true;
}

/** @param {unknown} [profiles] @returns {true} */
export function validateProviderProfiles(profiles = PROVIDER_PROFILES) {
  if (!Array.isArray(profiles) || profiles.length === 0) fail('$profiles', 'must be a non-empty array');
  const ids = new Set();
  for (let index = 0; index < profiles.length; index += 1) {
    validateProviderProfile(profiles[index]);
    const id = /** @type {Record<string, any>} */ (profiles[index]).id;
    if (ids.has(id)) fail(`$profiles[${index}].id`, `duplicate profile id ${id}`);
    ids.add(id);
  }
  return true;
}

for (const profile of BUILT_INS) validateProviderProfile(profile);

/** JSON-serializable, deeply immutable built-in profiles. */
export const PROVIDER_PROFILES = deepFreeze(BUILT_INS);

/** @param {string} id @returns {Record<string, any>|null} */
export function getProviderProfile(id) {
  return /** @type {Record<string, any>|null} */ (PROVIDER_PROFILES.find((profile) => profile.id === id) ?? null);
}

/** @param {string} proofState @returns {string} */
function planStatus(proofState) {
  return ({ pass: 'complete', fail: 'failed', blocked: 'blocked', 'not-applicable': 'not-applicable', 'not-run': 'pending' })[proofState] ?? 'pending';
}

/**
 * Build the proof work that remains before a profile can honestly become a blocking adapter.
 * Returned steps are data, not commands: callers can render them, assign them, or feed them into a
 * harness without giving this evidence module filesystem authority.
 *
 * @param {string|unknown} profileOrId
 * @returns {Record<string, any>}
 */
export function buildConformancePlan(profileOrId) {
  const profile = typeof profileOrId === 'string' ? getProviderProfile(profileOrId) : profileOrId;
  if (!profile) throw new TypeError(`unknown provider profile: ${String(profileOrId)}`);
  validateProviderProfile(profile);
  const p = /** @type {Record<string, any>} */ (profile);
  const step = (id, title, proofItem, required, blockedBy = []) => ({
    id, title, required, status: planStatus(proofItem.state), evidenceRefs: [...proofItem.evidenceRefs],
    blockedBy, acceptance: proofItem.note,
  });
  const steps = [
    { id: 'schema-validation', title: 'Validate JSON schema and evidence references', required: true, status: 'complete', evidenceRefs: [], blockedBy: [], acceptance: 'The profile passes strict schema validation.' },
    step('source-contract', 'Verify the current hook contract from primary source', p.proof.sourceContract, true),
    step('config-round-trip', 'Generate, merge, parse, and preserve native configuration', p.proof.configRoundTrip, true, ['source-contract']),
    step('native-discovery', 'Prove the current host discovers and enables the generated config', p.proof.nativeDiscovery, true, ['config-round-trip']),
    step('payload-replay', 'Replay safe, destructive, malformed, and alias payload fixtures', p.proof.payloadReplay, true, ['source-contract']),
    step('failure-injection', 'Inject missing binary, crash, timeout, invalid output, kill, trust, and headless ask failures', p.proof.failureInjection, true, ['native-discovery', 'payload-replay']),
    step('live-allow', 'Drive a harmless operation through the real host without bypassing native permission UX', p.proof.liveAllow, true, ['native-discovery', 'payload-replay']),
    step('live-deny', 'Drive a recoverable destructive decoy and observe refusal before execution', p.proof.liveDeny, true, ['native-discovery', 'payload-replay']),
    step('lifecycle-context', 'Inject a nonce through each host-push lifecycle event and observe it in model context once', p.proof.lifecycleContext, p.hooks.lifecycle.length > 0, ['native-discovery']),
    step('mcp-round-trip', 'Discover Holt MCP and call a harmless tool, while keeping its model-pull claim separate', p.proof.mcpRoundTrip, p.mcp.state !== 'unsupported', ['native-discovery']),
    step('upgrade-uninstall', 'Upgrade and uninstall without changing foreign settings, comments, rules, or secrets', p.proof.upgradeUninstall, true, ['config-round-trip']),
    step('subagent', 'Verify or explicitly bound hook and context propagation into subagents', p.proof.subagent, true, ['live-allow', 'live-deny']),
    ...['linux', 'macos', 'windows'].map((platform) => step(`platform-${platform}`, `Run the contract on ${platform}`, p.proof.platforms[platform], p.environment.platforms.includes(platform), ['native-discovery'])),
  ];
  const canClaimBlocking = p.support.grade === 'blocking';
  return {
    schemaVersion: PROVIDER_PROFILE_SCHEMA_VERSION,
    profileId: p.id,
    family: p.family,
    surface: p.surface,
    generatedFrom: { currentVersion: p.version.current, sourceCommit: p.version.sourceCommit, fetchedAt: p.evidence.fetchedAt },
    currentGrade: p.support.grade,
    canClaimBlocking,
    remainingRequiredSteps: steps.filter((item) => item.required && item.status !== 'complete' && item.status !== 'not-applicable').map((item) => item.id),
    steps,
  };
}

export const generateConformancePlan = buildConformancePlan;

/**
 * Concise public provider inventory used by `holt providers`. The full profile remains available
 * to adapter authors; this report keeps the ordinary user focused on what ships, how it is
 * activated, whether it is reactive or proactive, and what has actually been verified.
 *
 * @param {unknown} [profiles]
 * @returns {Record<string, any>}
 */
export function providersReport(profiles = PROVIDER_PROFILES) {
  validateProviderProfiles(profiles);
  const rows = /** @type {Record<string, any>[]} */ (profiles).map((profile) => {
    const plan = buildConformancePlan(profile);
    return {
      id: profile.id,
      family: profile.family,
      surface: profile.surface,
      name: profile.displayName,
      version: profile.version.current,
      evidenceFetchedAt: profile.evidence.fetchedAt,
      sourceCommit: profile.version.sourceCommit,
      implementation: profile.adapter.implementation,
      verification: profile.adapter.verification,
      liveVerified: profile.adapter.verification === 'live-verified',
      hostId: profile.adapter.hostId,
      supportGrade: profile.support.grade,
      summary: profile.support.summary,
      install: profile.adapter.install,
      capabilities: profile.adapter.capabilities,
      limitations: [...profile.limitations],
      remainingRequiredProof: [...plan.remainingRequiredSteps],
    };
  });
  const implementedHostIds = new Set(rows.filter((row) => row.implementation === 'implemented').map((row) => row.hostId));
  return {
    schemaVersion: PROVIDER_PROFILE_SCHEMA_VERSION,
    definitions: {
      implemented: 'Holt ships an installer/adapter for the named capability surface.',
      frameworkOnly: 'Holt ships evidence and a conformance plan, but no installer for this provider.',
      contractVerified: 'Applicable generated config, merge/uninstall logic, and payload/verdict behavior pass Holt contract tests; this is not a real host run.',
      liveVerified: 'A named current host process discovered and exercised the adapter. No built-in profile currently has this status.',
      modelPull: 'Reactive: the model must choose to call Holt through MCP.',
      hostPush: 'Proactive: the host invokes Holt through a lifecycle or pre-tool hook.',
    },
    counts: {
      profiles: rows.length,
      families: new Set(rows.map((row) => row.family)).size,
      implementedAdapters: implementedHostIds.size,
      implementedProfiles: rows.filter((row) => row.implementation === 'implemented').length,
      contractVerifiedProfiles: rows.filter((row) => row.verification === 'contract-verified').length,
      liveVerifiedProfiles: rows.filter((row) => row.verification === 'live-verified').length,
      frameworkOnlyProfiles: rows.filter((row) => row.implementation === 'framework-only').length,
    },
    providers: rows,
  };
}
