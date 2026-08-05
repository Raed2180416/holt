// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * Read-only activation diagnostics for agent-host integrations.
 *
 * A config file on disk proves exactly one thing: a config file is on disk. It does not prove
 * that the host loaded the file, that a user trusted it, that the referenced executable exists,
 * or that a real host process exercised the hook/MCP server. Doctor keeps those facts separate so
 * "integrate wrote something" can never silently become "this agent is guarded".
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HOSTS, getHost } from './hosts.mjs';
import { detectHosts, isHoltMcpEntry, mcpTargets } from './adapters.mjs';
import { relativeWithinAsync, samePathAsync } from '../paths.mjs';

/** @param {string} relative */
const file = (relative) => ({ kind: 'file', relative, display: relative });
/**
 * @param {string} relative
 * @param {{suffix?: string|null, display?: string}} options
 */
const directory = (relative, { suffix = null, display = `${relative}/**` } = {}) => ({
  kind: 'directory', relative, suffix, display,
});

/**
 * Files a host actually treats as project instructions. This is deliberately not "AGENTS.md for
 * everyone": several hosts read a different filename, and treating the universal file as proof
 * for Claude/Gemini/Amazon Q is the exact cross-host conflation this diagnostic exists to expose.
 */
const STATIC_ADVISORY_TARGETS = Object.freeze({
  'claude-code': [file('CLAUDE.md')],
  opencode: [file('AGENTS.md')],
  cursor: [file('AGENTS.md'), directory('.cursor/rules', { suffix: '.mdc', display: '.cursor/rules/*.mdc' })],
  'cursor-cloud': [file('AGENTS.md'), directory('.cursor/rules', { suffix: '.mdc', display: '.cursor/rules/*.mdc' })],
  codex: [file('AGENTS.md')],
  'codex-cloud': [file('AGENTS.md')],
  'gemini-cli': [file('GEMINI.md')],
  antigravity: [file('AGENTS.md'), directory('.agents/rules', { suffix: '.md', display: '.agents/rules/*.md' })],
  'qwen-code': [file('AGENTS.md'), file('QWEN.md'), directory('.qwen/rules', { display: '.qwen/rules/**' })],
  copilot: [file('.github/copilot-instructions.md')],
  'copilot-cloud': [file('.github/copilot-instructions.md')],
  // Cline's rules surface is a file named .clinerules. A directory of the same name containing
  // only the generated hook is NOT an advisory file and is reported as the wrong type.
  cline: [file('.clinerules')],
  'cline-cli': [file('AGENTS.md')],
  crush: [file('AGENTS.md')],
  amp: [file('AGENTS.md')],
  goose: [file('.goosehints'), file('AGENTS.md')],
  factory: [file('AGENTS.md')],
  junie: [file('.junie/guidelines.md')],
  'amazon-q': [directory('.amazonq/rules', { suffix: '.md', display: '.amazonq/rules/*.md' })],
  zed: [file('AGENTS.md'), file('.rules')],
  // Presence is useful to report, but Aider still requires an explicit --read/config reference;
  // loadedState therefore stays unknown below even when this file contains Holt commands.
  aider: [file('CONVENTIONS.md')],
  roo: [directory('.roo/rules', { display: '.roo/rules/**' }), file('.roorules')],
  kilo: [file('AGENTS.md')],
  warp: [file('AGENTS.md'), file('WARP.md')],
  'devin-cli': [file('AGENTS.md'), directory('.devin/rules', { display: '.devin/rules/**' })],
  cascade: [file('AGENTS.md'), file('.windsurfrules')],
  jules: [file('AGENTS.md')],
  replit: [file('AGENTS.md')],
  continue: [file('.continuerules')],
  vscode: [file('.github/copilot-instructions.md')],
});

/** Project hook/plugin files Holt currently knows how to install. */
const PROJECT_HOOK_TARGETS = Object.freeze({
  'claude-code': [file('.claude/settings.json')],
  cursor: [file('.cursor/hooks.json')],
  opencode: [file('.opencode/plugins/holt.js')],
  codex: [file('.codex/hooks.json')],
  antigravity: [file('.agents/hooks.json')],
  'qwen-code': [file('.qwen/settings.json')],
  copilot: [file('.github/hooks/holt.json')],
  goose: [file('.agents/plugins/holt/plugin.json'), file('.agents/plugins/holt/hooks/hooks.json')],
  cline: [file('.clinerules/hooks/PreToolUse')],
  'devin-cli': [file('.devin/hooks.v1.json')],
  cascade: [file('.windsurf/hooks.json')],
});

/** Only requirements stated by a current host contract are asserted; absence means unknown. */
const TRUST_REQUIREMENTS = Object.freeze({
  codex: {
    required: true,
    reason: 'project hook definitions require user review/trust before they run',
  },
  junie: {
    required: true,
    reason: 'project configuration is untrusted by default and requires opt-in',
  },
});

const HOLT_COMMANDS = new Set([
  'status', 'risk', 'collisions', 'hotspots', 'duplicates', 'context', 'plan', 'impact', 'order',
  'partition', 'branches', 'journal', 'forensics', 'fleet', 'license', 'ci', 'stash', 'gate', 'tui',
  'setup', 'doctor', 'audit', 'auto', 'protect', 'unprotect', 'rescue', 'rescued', 'clean', 'discard',
  'verify', 'hosts', 'integrate', 'uninstall', 'brief', 'mcp', 'hook',
]);

const HOLT_BINARY = /^holt(?:\.(?:mjs|cjs|js|cmd|exe|bat|ps1))?$/i;

function shellTokens(value) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|([^\s]+)/g;
  for (let m = re.exec(String(value ?? '')); m; m = re.exec(String(value ?? ''))) {
    const token = (m[1] ?? m[2] ?? m[3])
      .replace(/^[`([{;,&|]+/, '')
      .replace(/[`\])};,.&|]+$/, '');
    if (token) out.push(token);
  }
  return out;
}

function isHoltBinaryToken(token) {
  const normal = String(token ?? '').replace(/\\/g, '/');
  return HOLT_BINARY.test(normal.slice(normal.lastIndexOf('/') + 1));
}

function tokensRunHolt(tokens, subcommand) {
  for (let i = 0; i < tokens.length - 1; i++) {
    if (isHoltBinaryToken(tokens[i]) && tokens[i + 1] === subcommand) return true;
  }
  return false;
}

/** @param {string} text @param {string|null} [subcommand] */
function textContainsHoltCommand(text, subcommand = null) {
  const candidates = [String(text ?? '')];
  // A raw JSON/JSONC file wraps a whole shell command in quotes. Inspect quoted values too, so a
  // missing optional JSONC parser degrades conservatively rather than making every hook invisible.
  const quoted = /"((?:\\.|[^"\\])*)"|'([^']*)'/g;
  for (let m = quoted.exec(String(text ?? '')); m; m = quoted.exec(String(text ?? ''))) {
    candidates.push((m[1] ?? m[2] ?? '').replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
  }
  for (const candidate of candidates) {
    const tokens = shellTokens(candidate);
    if (subcommand) {
      if (tokensRunHolt(tokens, subcommand)) return true;
      continue;
    }
    for (let i = 0; i < tokens.length - 1; i++) {
      if (isHoltBinaryToken(tokens[i]) && HOLT_COMMANDS.has(tokens[i + 1])) return true;
    }
  }
  return false;
}

/** @type {Promise<any>|null} */
let jsoncModulePromise = null;
async function parseJsonish(text) {
  try { return { value: JSON.parse(text), error: null }; } catch { /* JSONC or invalid */ }
  jsoncModulePromise ??= import('jsonc-parser').catch(() => null);
  const jsonc = await jsoncModulePromise;
  if (!jsonc) return { value: null, error: 'could not parse JSON because the required jsonc-parser runtime dependency is unavailable; reinstall Holt from an intact release' };
  const errors = [];
  const value = jsonc.parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  return errors.length
    ? { value: null, error: `could not parse JSON/JSONC (${errors.length} parse error(s))` }
    : { value, error: null };
}

function hookCommandStrings(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) hookCommandStrings(item, out);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (['command', 'bash', 'powershell'].includes(key) && typeof item === 'string') out.push(item);
      hookCommandStrings(item, out);
    }
  }
  return out;
}

function objectEntriesNamed(value, name, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) objectEntriesNamed(item, name, out);
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  for (const [key, item] of Object.entries(value)) {
    if (key === name && item && typeof item === 'object') out.push(item);
    objectEntriesNamed(item, name, out);
  }
  return out;
}

async function mcpFileContainsHolt(text) {
  // Codex is TOML. Inspect only the named table and require an executable + mcp argv; a mere word
  // "holt" elsewhere in the user's config is not activation evidence.
  const source = String(text);
  const header = /^\s*\[mcp_servers\.holt\]\s*$/m.exec(source);
  if (header) {
    const afterHeader = source.slice(header.index + header[0].length);
    const nextHeader = /^\s*\[/m.exec(afterHeader);
    const table = nextHeader ? afterHeader.slice(0, nextHeader.index) : afterHeader;
    const command = table.match(/^\s*command\s*=\s*"([^"]+)"/m)?.[1] ?? '';
    const argsLine = table.match(/^\s*args\s*=\s*\[([^\]]*)\]/m)?.[1] ?? '';
    const args = [...argsLine.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    if (tokensRunHolt([...shellTokens(command), ...args.flatMap(shellTokens)], 'mcp')) {
      return { matched: true, inspectionError: null };
    }
  }

  const parsed = await parseJsonish(text);
  if (parsed.value) {
    return {
      matched: objectEntriesNamed(parsed.value, 'holt').some(isHoltMcpEntry),
      inspectionError: null,
    };
  }
  return { matched: false, inspectionError: parsed.error };
}

async function hookFileContainsHolt(text, relative) {
  const parsed = await parseJsonish(text);
  // For structured hook files, only executable command fields count. A description such as
  // "replace the old holt hook" is not a command and must not turn a foreign config green.
  const uncommented = String(text).split('\n')
    .filter((line) => !/^\s*(#|\/\/)/.test(line))
    .join('\n');
  const candidates = parsed.value ? hookCommandStrings(parsed.value) : [uncommented];
  if (candidates.some((candidate) => textContainsHoltCommand(candidate, 'hook'))) {
    return { matched: true, inspectionError: null };
  }

  // OpenCode separates the executable and argv by design. Require all three structural parts;
  // the generated comment alone is not enough to turn an arbitrary holt.js into a configured hook.
  if (relative === '.opencode/plugins/holt.js'
    && /execFile\(HOLT_CMD\s*,/.test(text)
    && /run\(\["hook"\s*,\s*"pre-tool-use"/.test(text)) {
    const configured = text.match(/const \[HOLT_CMD,[^\n]*=\s*("(?:\\.|[^"\\])*")/);
    if (configured) {
      try {
        const bin = JSON.parse(configured[1]);
        if (shellTokens(bin).some(isHoltBinaryToken)) return { matched: true, inspectionError: null };
      } catch { /* malformed generated assignment: not evidence */ }
    }
  }

  return { matched: false, inspectionError: parsed.error };
}

async function staticFileContainsHolt(text) {
  return { matched: textContainsHoltCommand(text), inspectionError: null };
}

function absFrom(repoRoot, target) {
  if (target.absolute) return target.absolute;
  return path.join(repoRoot, ...target.relative.split('/'));
}

async function expandDirectory(repoRoot, target, depth = 0) {
  const root = absFrom(repoRoot, target);
  const rows = [];
  const errors = [];

  async function walk(dir, relative, level) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') errors.push({ path: relative, error: error?.message ?? String(error) });
      return;
    }
    for (const entry of entries) {
      const childAbs = path.join(dir, entry.name);
      const childRel = `${relative}/${entry.name}`;
      if (entry.isDirectory() && level < 2) {
        await walk(childAbs, childRel, level + 1);
      } else if ((entry.isFile() || entry.isSymbolicLink())
        && (!target.suffix || entry.name.endsWith(target.suffix))) {
        rows.push({ absolute: childAbs, relative: childRel, display: childRel });
      }
    }
  }

  await walk(root, target.relative, depth);
  return { rows, errors };
}

async function inspectSurface(repoRoot, targets, checker) {
  if (!targets?.length) {
    return {
      supported: false,
      expectedPaths: [], presentPaths: [], wrongTypePaths: [], unreadablePaths: [],
      present: false, holtCommandPresent: false, holtCommandPaths: [],
      state: 'not-supported',
    };
  }

  const candidates = [];
  const wrongTypePaths = [];
  const unreadablePaths = [];
  for (const target of targets) {
    if (target.kind === 'directory') {
      const expanded = await expandDirectory(repoRoot, target);
      candidates.push(...expanded.rows);
      unreadablePaths.push(...expanded.errors);
      continue;
    }
    const absolute = absFrom(repoRoot, target);
    try {
      const stat = await fs.stat(absolute);
      if (stat.isFile()) candidates.push({ ...target, absolute });
      else wrongTypePaths.push(target.display);
    } catch (error) {
      if (error?.code !== 'ENOENT') unreadablePaths.push({ path: target.display, error: error?.message ?? String(error) });
    }
  }

  const presentPaths = [];
  const holtCommandPaths = [];
  for (const candidate of candidates) {
    let text;
    try {
      text = await fs.readFile(candidate.absolute, 'utf8');
      presentPaths.push(candidate.display);
    } catch (error) {
      unreadablePaths.push({ path: candidate.display, error: error?.message ?? String(error) });
      continue;
    }
    const inspected = await checker(text, candidate.relative);
    if (inspected.inspectionError) {
      unreadablePaths.push({ path: candidate.display, error: inspected.inspectionError });
    }
    if (inspected.matched) holtCommandPaths.push(candidate.display);
  }

  const present = presentPaths.length > 0;
  const holtCommandPresent = holtCommandPaths.length > 0;
  const state = holtCommandPresent
    ? 'configured-on-disk'
    : unreadablePaths.length > 0
      ? 'unknown-unreadable'
      : present
        ? 'present-without-holt-command'
        : 'absent';
  return {
    supported: true,
    expectedPaths: targets.map((target) => target.display),
    presentPaths,
    wrongTypePaths,
    unreadablePaths,
    present,
    holtCommandPresent,
    holtCommandPaths,
    state,
  };
}

function normalizeDetected(detected) {
  if (Array.isArray(detected)) return { all: [...detected], project: [...detected], user: [] };
  const project = [...(detected?.project ?? [])];
  const user = [...(detected?.user ?? [])];
  return {
    all: [...new Set(detected?.all ?? [...project, ...user])],
    project,
    user,
  };
}

async function projectMcpTargets(repoRoot, hostId) {
  const targets = mcpTargets(repoRoot, os.homedir(), { scope: 'project' }).filter((target) => target.host === hostId);
  const out = [];
  for (const target of targets) {
    let relative;
    try { relative = await relativeWithinAsync(repoRoot, target.file); }
    catch { relative = target.file; }
    out.push({ kind: 'file', relative, absolute: target.file, display: relative });
  }
  return out;
}

/**
 * Inspect one checkout without changing it. `detected` is injectable for hermetic fixtures.
 * @param {string} repoRoot
 * @param {{home?: string, detected?: any, id?: string}} [options]
 */
export async function inspectWorktreeActivation(repoRoot, {
  home = os.homedir(), detected = null, id = path.basename(repoRoot),
} = {}) {
  const detection = normalizeDetected(detected ?? await detectHosts(repoRoot, home));
  const ids = new Set(detection.all);
  const ordered = [
    ...HOSTS.filter((host) => ids.has(host.id)).map((host) => host.id),
    ...[...ids].filter((hostId) => !getHost(hostId)),
  ];

  const hosts = [];
  for (const hostId of ordered) {
    const host = getHost(hostId);
    const [staticAdvisory, projectHook, projectMcp] = await Promise.all([
      inspectSurface(repoRoot, STATIC_ADVISORY_TARGETS[hostId] ?? [], staticFileContainsHolt),
      inspectSurface(repoRoot, PROJECT_HOOK_TARGETS[hostId] ?? [], hookFileContainsHolt),
      projectMcpTargets(repoRoot, hostId).then((targets) => inspectSurface(repoRoot, targets, mcpFileContainsHolt)),
    ]);
    const relevant = [staticAdvisory, projectHook, projectMcp].filter((surface) => surface.supported);
    const configured = relevant.filter((surface) => surface.holtCommandPresent).length;
    const configurationState = relevant.length === 0
      ? 'no-project-surface'
      : configured === 0
        ? 'absent'
        : configured === relevant.length
          ? 'configured-on-disk'
          : 'partial';
    const requirement = TRUST_REQUIREMENTS[hostId] ?? {
      required: 'unknown',
      reason: 'no reviewed host contract establishes whether this project surface requires trust',
    };
    hosts.push({
      id: hostId,
      name: host?.name ?? hostId,
      detected: true,
      detectedScope: [
        ...(detection.project.includes(hostId) ? ['project'] : []),
        ...(detection.user.includes(hostId) ? ['user'] : []),
      ],
      staticAdvisory,
      projectHook,
      projectMcp,
      configurationState,
      configuredOnDisk: configurationState === 'configured-on-disk',
      anyHoltCommandOnDisk: configured > 0,
      loadedState: 'unknown',
      runtimeState: 'unknown',
      trust: { ...requirement, state: 'unknown', inferredFromFilePresence: false },
      liveProof: false,
      liveProofState: 'unknown',
      liveProofEvidence: [],
      liveProofReason: 'no durable local evidence records this host loading and exercising these project surfaces',
    });
  }

  const anyConfigured = hosts.some((host) => host.anyHoltCommandOnDisk);
  const state = hosts.length === 0
    ? 'no-host-detected'
    : hosts.every((host) => host.configuredOnDisk)
      ? 'configured-on-disk'
      : anyConfigured
        ? 'partial'
        : 'absent';
  return {
    id,
    path: repoRoot,
    state,
    detectedHosts: detection,
    hosts,
    loadedState: 'unknown',
    runtimeState: 'unknown',
    liveProof: false,
    liveProofState: 'unknown',
  };
}

/**
 * Inspect every checkout that doctor discovered.
 * @param {any[]} workstreams
 * @param {{home?: string, currentRoot?: string|null}} [options]
 */
export async function inspectActivationIntegrity(workstreams, {
  home = os.homedir(), currentRoot = null,
} = {}) {
  const rows = await Promise.all((workstreams ?? [])
    .filter((workstream) => workstream?.path)
    .map((workstream) => inspectWorktreeActivation(workstream.path, { home, id: workstream.id })));

  let currentWorktreeId = rows.find((row) => row.path === currentRoot)?.id ?? null;
  if (!currentWorktreeId && currentRoot) {
    for (const row of rows) {
      if (await samePathAsync(row.path, currentRoot)) { currentWorktreeId = row.id; break; }
    }
  }
  currentWorktreeId ??= rows[0]?.id ?? null;

  const unwiredWorktrees = rows
    .filter((row) => row.state === 'absent' || row.state === 'no-host-detected')
    .map((row) => row.id);
  return {
    schemaVersion: 1,
    claimBoundary: 'on-disk configuration is not evidence that a host loaded, trusted, or exercised it',
    currentWorktreeId,
    worktrees: rows,
    counts: {
      configuredOnDisk: rows.filter((row) => row.state === 'configured-on-disk').length,
      partial: rows.filter((row) => row.state === 'partial').length,
      absent: rows.filter((row) => row.state === 'absent').length,
      noHostDetected: rows.filter((row) => row.state === 'no-host-detected').length,
      liveProven: 0,
    },
    unwiredWorktrees,
    partiallyWiredWorktrees: rows.filter((row) => row.state === 'partial').map((row) => row.id),
    compatibility: {
      unwiredWorktrees: 'retained for compatibility; now means no detected host has a relevant Holt command on disk. It is not a runtime or enforcement verdict.',
    },
  };
}

function shortSurface(surface) {
  if (!surface.supported) return 'n/a';
  if (surface.state === 'configured-on-disk') return 'holt-on-disk';
  if (surface.state === 'present-without-holt-command') return 'file-only';
  if (surface.state === 'unknown-unreadable') return 'unknown';
  return 'absent';
}

/** Plain lines for the human doctor renderer; colour belongs to the CLI, facts live here. */
export function activationIntegrityLines(report) {
  const lines = [
    '  AGENT ACTIVATION  (on-disk inspection; loaded, trusted and live remain separate)',
  ];
  const current = report.worktrees.find((row) => row.id === report.currentWorktreeId) ?? report.worktrees[0];
  if (!current) {
    lines.push('    no checkout is available to inspect');
  } else if (!current.hosts.length) {
    lines.push(`    ${current.id}: no known host detected; runtime activation is unknown`);
  } else {
    lines.push(`    current worktree: ${current.id}  (${current.state}; live proof: no, runtime: unknown)`);
    for (const host of current.hosts) {
      const scopes = host.detectedScope.length ? host.detectedScope.join('+') : 'detected';
      const trust = host.trust.required === true ? 'required/state-unknown' : 'requirement/state-unknown';
      lines.push(`      ${(host.name + '                    ').slice(0, 20)} ${host.configurationState}`
        + `  static=${shortSurface(host.staticAdvisory)}`
        + `  hook=${shortSurface(host.projectHook)}`
        + `  mcp=${shortSurface(host.projectMcp)}`
        + `  trust=${trust}  via=${scopes}`);
    }
  }
  const c = report.counts;
  lines.push(`    all worktrees: ${c.configuredOnDisk} configured-on-disk · ${c.partial} partial · `
    + `${c.absent + c.noHostDetected} without a relevant Holt command · ${c.liveProven} live-proven`);
  if (report.unwiredWorktrees.length) {
    lines.push(`    ${report.unwiredWorktrees.length} worktree(s) are NOT guarded by any proven host activation: `
      + `${report.unwiredWorktrees.slice(0, 5).join(', ')}`
      + `${report.unwiredWorktrees.length > 5 ? ` … +${report.unwiredWorktrees.length - 5}` : ''}`);
    lines.push('    fix on-disk gaps with `holt integrate`; then satisfy host trust/loading and verify live separately');
  }
  lines.push('    "configured-on-disk" never means the host loaded, trusted, or exercised the integration.');
  return lines;
}
