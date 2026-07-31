/**
 * grove — agent integration CORE (agent-neutral).
 *
 * MCP gives an agent tools it must CHOOSE to call. That is not enough for this problem, because
 * the two failures grove exists to prevent both happen when nobody thought to ask:
 *
 *   - an agent deletes a worktree holding the only copy of some work;
 *   - an agent rebuilds something the worktree next door already built.
 *
 * So grove integrates on three levels, and only the third is agent-specific:
 *
 *   1. MCP server            — universal tool access (src/mcp/server.mjs)
 *   2. AGENTS.md             — universal awareness. The Linux Foundation AAIF standard read by
 *                              30+ agents (Codex, Cursor, Copilot, Gemini CLI, Aider, Zed,
 *                              Windsurf, Jules, Factory, Devin…). Any agent that reads the repo
 *                              learns grove exists and that it must check before deleting.
 *   3. Hooks                 — deterministic ENFORCEMENT, where the agent supports it. Every
 *                              agent's hook schema differs, so this file computes agent-neutral
 *                              VERDICTS and src/integrate/adapters/* translate them.
 *
 * Nothing below knows what Claude Code, OpenCode or Codex is. It answers two questions:
 *
 *   assessCommand()  — would running this command destroy work that exists nowhere else?
 *   buildBrief()     — what does an agent working here need to know about its siblings?
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { discover } from './discover.mjs';
import { scan } from './scan.mjs';
import { analyze, contextDigest } from './analyze.mjs';
import { scratchDir } from './symbols.mjs';
import { git } from './git.mjs';

/* ------------------------------------------------------------------ cache ---- */

/**
 * A pre-tool hook runs in the agent's critical path, so a cold 20 s scan on every call is not
 * acceptable. The cache is keyed on a FINGERPRINT of the thing being measured — the worktree
 * list plus every worktree's full status — so it invalidates the moment anything grove reports
 * on changes. A time-based TTL alone would be wrong: answering "safe to delete" from a stale
 * scan is exactly the failure this tool exists to prevent.
 */
async function fingerprint(root) {
  const wl = await git(['worktree', 'list', '--porcelain'], { cwd: root });
  const h = createHash('sha256').update(wl.stdout);

  const paths = wl.stdout.split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice(9));

  for (const p of paths) {
    const st = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: p })
      .catch(() => ({ code: 1, stdout: '' }));
    h.update(p).update(String(st.code)).update(st.stdout);
  }
  return h.digest('hex').slice(0, 32);
}

function cachePath(root) {
  const key = createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16);
  return path.join(scratchDir(), `grove-cache-${key}.json`);
}

export async function cachedReport(cwd, opts = {}) {
  const disc = await discover(cwd, opts);
  if (!disc.root) throw Object.assign(new Error(`not a git repository: ${cwd}`), { code: 'ENOTREPO' });

  const fp = await fingerprint(disc.root);
  const file = cachePath(disc.root);

  try {
    const cached = JSON.parse(await fs.readFile(file, 'utf8'));
    if (cached.fingerprint === fp && cached.version === 1) {
      return { report: cached.report, scanned: cached.scanned, fromCache: true };
    }
  } catch { /* no usable cache */ }

  const scanned = await scan(disc, opts);
  const report = await analyze(scanned, opts);
  await fs.writeFile(file, JSON.stringify({ version: 1, fingerprint: fp, report, scanned }), 'utf8')
    .catch(() => { /* an unwritable cache must never fail the scan */ });

  return { report, scanned, fromCache: false };
}

/* -------------------------------------------------- destructive-command match ---- */

/**
 * Commands that destroy a workstream.
 *
 * Matching is deliberately BROAD: a false positive costs an explained prompt, a false negative
 * costs destroyed work. `rm -rf <path>` is included because that is how worktrees actually get
 * deleted in practice, not just `git worktree remove`.
 */
/**
 * Global git options may take a VALUE (`git -C /repo …`, `git -c k=v …`, `--git-dir <p>`), so a
 * pattern that only skips flag tokens misses `git -C /repo worktree remove`. Found by test.
 */
const GIT_GLOBALS = '(?:-[cC]\\s+\\S+\\s+|--(?:git-dir|work-tree|namespace|exec-path)(?:=\\S+|\\s+\\S+)\\s+|-[a-zA-Z]+\\s+|--[a-z-]+\\s+)*';

const DESTRUCTIVE = [
  { re: new RegExp(`\\bgit\\s+${GIT_GLOBALS}worktree\\s+remove\\s+(?:(?:--force|-f)\\s+)*(?<target>[^\\s;|&]+)`), kind: 'git worktree remove' },
  { re: new RegExp(`\\bgit\\s+${GIT_GLOBALS}worktree\\s+prune\\b`), kind: 'git worktree prune', all: true },
  { re: /\brm\s+(?:-[a-zA-Z]+\s+)*(?<target>[^\s;|&]*(?:worktree|\.worktrees|\bwt[-_/])[^\s;|&]*)/, kind: 'rm of a worktree path' },
];

export function classifyCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  for (const { re, kind, all } of DESTRUCTIVE) {
    const m = command.match(re);
    if (m) {
      return {
        kind,
        target: m.groups?.target ? m.groups.target.replace(/^['"]|['"]$/g, '') : null,
        all: !!all,
      };
    }
  }
  return null;
}

function findWorkstream(report, target, cwd) {
  if (!target) return null;
  const abs = path.resolve(cwd || process.cwd(), target);
  const byPath = report.safe.find((s) => s.path && path.resolve(s.path) === abs);
  if (byPath) return byPath;
  const base = path.basename(abs);
  return report.safe.find((s) => s.id === base || s.id.endsWith(`/${base}`)) ?? null;
}

/* --------------------------------------------------------- neutral verdicts ---- */

/**
 * Would this command destroy work that exists nowhere else?
 *
 * @returns {{decision:'allow'|'deny'|'ask', reason:string|null, kind:string|null, targets:Array}}
 *
 * Agent-neutral by design. Adapters map:  allow/deny/ask -> whatever their host calls it.
 */
export async function assessCommand(command, cwd = process.cwd()) {
  const hit = classifyCommand(command);
  if (!hit) return { decision: 'allow', reason: null, kind: null, targets: [] };

  let report;
  try {
    ({ report } = await cachedReport(cwd));
  } catch (err) {
    // grove could not measure. It must NOT silently allow a destructive command it failed to
    // check — but it must not hard-block work on its own bug either, so it asks.
    return {
      decision: 'ask',
      kind: hit.kind,
      targets: [],
      reason: `grove could not verify what this would destroy (${err.message}). Confirm manually before proceeding.`,
    };
  }

  // `worktree prune` affects every prunable worktree at once, so evaluate all of them.
  const targets = hit.all
    ? report.safe.filter((s) => !s.safe)
    : [findWorkstream(report, hit.target, cwd)].filter(Boolean);

  const holding = targets.filter((s) => !s.safe);
  if (holding.length === 0) {
    return { decision: 'allow', reason: null, kind: hit.kind, targets: targets.map((t) => t.id) };
  }

  const unknown = holding.filter((s) => s.confidence === 'unknown');
  const detail = holding.slice(0, 3).map((s) => {
    const u = report.unique.find((x) => x.id === s.id);
    const sample = u
      ? [...u.byLayer.uncommitted, ...u.byLayer.untracked, ...u.byLayer.committed]
        .slice(0, 3).map((x) => x.key).join(', ')
      : '';
    return `  • ${s.id}: ${s.reasons.join('; ')}${sample ? `\n      e.g. ${sample}` : ''}`;
  }).join('\n');

  return {
    decision: 'deny',
    kind: hit.kind,
    targets: holding.map((h) => h.id),
    reason:
      `grove blocked this: ${hit.kind} would destroy work that exists nowhere else.\n${detail}\n` +
      (unknown.length
        ? `  ${unknown.length} of these could not be scanned, so grove cannot confirm they are safe.\n`
        : '') +
      'Run `grove risk` to inspect, or `grove gate <id>` for one workstream. ' +
      'If the work is genuinely disposable, commit or discard it explicitly first.',
  };
}

/**
 * What does an agent working here need to know about its siblings?
 * @returns {Promise<string|null>} plain text, or null when there is nothing worth saying
 */
export async function buildBrief(cwd = process.cwd()) {
  let report;
  let scanned;
  try {
    ({ report, scanned } = await cachedReport(cwd));
  } catch {
    return null; // no repo, or unscannable: contribute nothing rather than noise
  }

  const here = report.graph.nodes.find(
    (n) => n.path && path.resolve(cwd).startsWith(path.resolve(n.path)),
  );

  const lines = [];
  if (here) {
    const d = contextDigest(scanned, here.id);
    if (d.ok) {
      lines.push(`You are working in workstream '${d.workstream}' (family ${d.family}).`);
      if (d.siblings.length) lines.push(`Siblings from the same dispatch: ${d.siblings.join(', ')}.`);
      for (const a of d.advice) lines.push(`- ${a}`);
      if (d.duplicatedSymbols.length) {
        lines.push('Symbols you added that ALSO exist elsewhere (check before building further):');
        for (const x of d.duplicatedSymbols.slice(0, 5)) {
          lines.push(`  - ${x.workstream}: ${x.symbols.slice(0, 4).join(', ')}`);
        }
      }
    }
  }

  const risky = report.unique.filter((u) => u.uncommittedOnlyCount > 0);
  if (risky.length) {
    lines.push(
      `${risky.length} workstream(s) hold work existing ONLY as uncommitted changes — ` +
      `deleting them loses it: ${risky.slice(0, 5).map((r) => r.id).join(', ')}.`,
    );
  }
  if (report.counts.collisions > 0) {
    const top = report.collisions[0];
    lines.push(
      `${report.counts.collisions} workstream collision(s); highest: ${top.a} <-> ${top.b} (${top.why}).`,
    );
  }

  if (lines.length === 0) return null;

  return `[grove — parallel workstream state]\n${lines.join('\n')}\n` +
    '(Before deleting ANY worktree run: grove gate <id> — exit 0 disposable, 1 holds unique work, 2 unknown.)';
}
