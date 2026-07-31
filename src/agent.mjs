// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — agent integration CORE (agent-neutral).
 *
 * MCP gives an agent tools it must CHOOSE to call. That is not enough for this problem, because
 * the two failures holt exists to prevent both happen when nobody thought to ask:
 *
 *   - an agent deletes a worktree holding the only copy of some work;
 *   - an agent rebuilds something the worktree next door already built.
 *
 * So holt integrates on three levels, and only the third is agent-specific:
 *
 *   1. MCP server            — universal tool access (src/mcp/server.mjs)
 *   2. AGENTS.md             — universal awareness. The Linux Foundation AAIF standard read by
 *                              30+ agents (Codex, Cursor, Copilot, Gemini CLI, Aider, Zed,
 *                              Windsurf, Jules, Factory, Devin…). Any agent that reads the repo
 *                              learns holt exists and that it must check before deleting.
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
 * list plus every worktree's full status — so it invalidates the moment anything holt reports
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
  return path.join(scratchDir(), `holt-cache-${key}.json`);
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

// ORDER MATTERS: the first match wins, so the more specific patterns come first. The general
// `remove` pattern's `(?:--force|-f)*` also matches `-f -f`, which would mislabel the override.
const DESTRUCTIVE = [
  // DISARMING THE PROTECTION IS ITSELF A DESTRUCTIVE ACT.
  //
  // MEASURED: an agent hit `holt protect`, read the lock reason naming the exact symbol at
  // risk, ran `git worktree unlock`, and deleted the worktree anyway — justifying it from the
  // worktree's NAME ("DELETEME-old-experiment"), which is precisely the trap the scenario is
  // built from. A lock is one command away from being undone, so a gate that only watches
  // `remove` watches the wrong step.
  //
  // These are caught with the SAME evidence-bearing refusal as a delete, because by the time
  // someone is unlocking, the interesting question is already "do you know what is in there?".
  { re: new RegExp(`\\bgit\\s+${GIT_GLOBALS}worktree\\s+unlock\\s+(?<target>[^\\s;|&]+)`), kind: 'git worktree unlock (disarms protection)' },
  // `remove -f -f` is git's documented override for a locked worktree. Same treatment.
  { re: new RegExp(`\\bgit\\s+${GIT_GLOBALS}worktree\\s+remove\\s+(?:(?:--force|-f)\\s+){2,}(?<target>[^\\s;|&]+)`), kind: 'git worktree remove --force --force (overrides the lock)' },

  { re: new RegExp(`\\bgit\\s+${GIT_GLOBALS}worktree\\s+remove\\s+(?:(?:--force|-f)\\s+)*(?<target>[^\\s;|&]+)`), kind: 'git worktree remove' },
  { re: new RegExp(`\\bgit\\s+${GIT_GLOBALS}worktree\\s+prune\\b`), kind: 'git worktree prune', all: true },
  // MATCH ANY rm TARGET, then let resolution decide. This rule previously required the path to
  // contain 'worktree', '.worktrees' or 'wt' — so `rm -rf ../my-feature`, the most natural way to
  // delete a worktree, sailed straight through the one defence holt has against rm (git's lock
  // cannot stop a filesystem delete). Broadening is safe because the target is resolved against
  // the actual worktree list below: a path that is not a worktree finds nothing and is allowed,
  // so `rm -rf node_modules` and `rm -rf dist` are unaffected.
  { re: /\brm\s+(?:-[a-zA-Z]+\s+)*(?<target>[^\s;|&]+)/, kind: 'rm of a worktree path' },
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


/**
 * Is this rm target actually a registered worktree? One `git worktree list` call, so the broad
 * rm rule costs nothing on the overwhelmingly common case of deleting build output.
 */
async function targetIsWorktree(target, cwd) {
  const abs = path.resolve(cwd || process.cwd(), target);
  const r = await git(['worktree', 'list', '--porcelain'], { cwd }).catch(() => null);
  if (!r || r.code !== 0) return true; // cannot tell -> fall through to the full check, never skip silently
  for (const line of r.stdout.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const wt = path.resolve(line.slice('worktree '.length).trim());
    // Dangerous iff the target IS a worktree root, or CONTAINS one (deleting a parent directory
    // takes the worktrees under it with it). Deleting something INSIDE a worktree — the common
    // `rm -rf node_modules` — is ordinary file work and must stay allowed; treating it as
    // destruction would flag every delete in the repo, since the repo root is itself a worktree.
    if (wt === abs || wt.startsWith(abs + path.sep)) return true;
  }
  return false;
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

  // CHEAP PRE-CHECK before the expensive scan. The rm rule matches any target so that
  // `rm -rf ../my-feature` is caught, but that would otherwise make every `rm -rf node_modules`
  // in an agent session pay for a full repository scan. `git worktree list` is one fast call:
  // if the target is not a worktree at all, there is nothing holt can protect and we allow it
  // immediately. Only paths that ARE worktrees reach the real analysis.
  if (hit.kind === 'rm of a worktree path' && hit.target) {
    const isWt = await targetIsWorktree(hit.target, cwd);
    if (!isWt) return { decision: 'allow', reason: null, kind: null, targets: [] };
  }

  let report;
  try {
    ({ report } = await cachedReport(cwd));
  } catch (err) {
    // holt could not measure. It must NOT silently allow a destructive command it failed to
    // check — but it must not hard-block work on its own bug either, so it asks.
    return {
      decision: 'ask',
      kind: hit.kind,
      targets: [],
      reason: `holt could not verify what this would destroy (${err.message}). Confirm manually before proceeding.`,
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
      `holt blocked this: ${hit.kind} would destroy work that exists nowhere else.\n${detail}\n` +
      (unknown.length
        ? `  ${unknown.length} of these could not be scanned, so holt cannot confirm they are safe.\n`
        : '') +
      'Run `holt risk` to inspect, or `holt gate <id>` for one workstream. ' +
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

  return `[holt — parallel workstream state]\n${lines.join('\n')}\n` +
    '(Before deleting ANY worktree run: holt gate <id> — exit 0 disposable, 1 holds unique work, 2 unknown.)';
}
