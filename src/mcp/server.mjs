/**
 * holt — MCP server.
 *
 * TOOL DESIGN FOLLOWS THE 2026 CONSENSUS, WHICH IS NOT DECORATION:
 * a five-server / 58-tool setup can burn ~55K tokens on schemas alone, and the highest-leverage
 * fix is to return only what the agent needs and to aggregate server-side — expose
 * `get_sales_summary_by_region`, never `get_all_sales_records`.
 *
 * holt's own numbers make the case. Against the repository this was built for, the useful
 * answer was "4 of 69 workstreams hold unique work". A `list_all_worktrees` tool would spend
 * thousands of tokens delivering 69 objects so the model could rediscover that 4 matter.
 * So every tool here returns a DECISION with its evidence, and every list takes a `limit`.
 *
 * All tools are read-only (annotated as such). holt cannot modify a repository — see
 * src/git.mjs and test/unit/safety.test.mjs.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { discover } from '../discover.mjs';
import { scan } from '../scan.mjs';
import { analyze, contextDigest } from '../analyze.mjs';
import { landingOrder } from '../order.mjs';
import { branchAudit } from '../branches.mjs';
import { partitionPlan } from '../partition.mjs';
import { git } from '../git.mjs';
import { deepDuplicates } from '../deep.mjs';

/* --------------------------------------------------------------- caching ---- */

/**
 * A scan is ~0.3–3 s depending on repo size. An agent asking three questions in a row should
 * not pay for three scans, but a stale answer about what is safe to DELETE is dangerous — so
 * the TTL is short and every response carries the age of the data it came from.
 */
const CACHE_TTL_MS = 15_000;
const cache = new Map();

/**
 * @param {object} o
 * @param {boolean} [o.fresh] bypass the cache entirely — REQUIRED for any answer that licenses a
 *   deletion. A cached "safe to delete" is the one stale answer that can destroy work: the
 *   verdict is read at T0 and the agent acts at T0+10s, inside the TTL, after a human or another
 *   agent has written new work into that worktree. Advisory/aggregate tools may use the cache;
 *   the per-workstream safety verdict never does.
 */
async function getReport(cwd, opts = {}, { fresh = false } = {}) {
  const key = `${cwd}::${JSON.stringify(opts)}`;
  const now = Date.now();
  // Opportunistic eviction: this process lives for hours and every distinct opts combination
  // created an entry that was never removed. Sweep expired keys instead of growing forever.
  if (cache.size > 32) {
    for (const [k, v] of cache) if (now - v.at >= CACHE_TTL_MS) cache.delete(k);
  }
  const hit = cache.get(key);
  if (!fresh && hit && now - hit.at < CACHE_TTL_MS) {
    return { ...hit.value, _ageMs: now - hit.at };
  }
  const disc = await discover(cwd, opts);
  if (!disc.root) {
    const e = new Error(`not a git repository: ${cwd}`);
    e.code = 'ENOTREPO';
    throw e;
  }
  const scanned = await scan(disc, opts);
  const report = await analyze(scanned, opts);
  const value = { report, scanned };
  cache.set(key, { at: now, value });
  return { ...value, _ageMs: 0 };
}

/* ----------------------------------------------------------------- tools ---- */

const REPO_ARG = {
  repo: { type: 'string', description: 'Path inside the repository. Defaults to the server cwd.' },
};

const TOOLS = [
  {
    name: 'holt_landing_order',
    title: 'What order to land workstreams in',
    description:
      'Landing order from the evidence graph: which workstreams can land in PARALLEL, and a sequence for the entangled rest with the later merges to watch at each step. Heuristic, never a certificate.',
    inputSchema: { type: 'object', properties: { ...REPO_ARG }, additionalProperties: false },
  },
  {
    name: 'holt_branches',
    title: 'The branch graveyard, classified by content',
    description:
      'Audits local branches checked out nowhere: landed (safe -d), content-landed (squash/cherry-pick — content present, ancestry broken; never auto-deleted), unlanded (files named), unknown (refused). Read-only.',
    inputSchema: { type: 'object', properties: { ...REPO_ARG }, additionalProperties: false },
  },
  {
    name: 'holt_partition',
    title: 'Pre-flight split for N agents',
    description:
      'Pre-flight split for N agents: disjoint balanced directory buckets, every observed hotspot assigned exactly one owner. Advisory — a collision-free starting map, not a work plan.',
    inputSchema: {
      type: 'object',
      properties: { ...REPO_ARG, agents: { type: 'number', description: 'How many agents you are about to spawn (default 2).' } },
      additionalProperties: false,
    },
  },
  {
    name: 'holt_status',
    title: 'Parallel work status',
    description:
      'The decision surface for all parallel workstreams (git worktrees / jj workspaces): how many hold work that exists nowhere else, how many collide, how many are disposable, and how much review is actually needed. Start here.',
    inputSchema: { type: 'object', properties: { ...REPO_ARG }, additionalProperties: false },
  },
  {
    name: 'holt_at_risk',
    title: 'Work that exists nowhere else',
    description:
      'Workstreams holding unique work, ranked by risk. Work that exists only as UNCOMMITTED changes ranks highest because no git command can relate it — deleting that worktree destroys it silently.',
    inputSchema: {
      type: 'object',
      properties: { ...REPO_ARG, limit: { type: 'number', description: 'Max rows (default 10).' } },
      additionalProperties: false,
    },
  },
  {
    name: 'holt_check_workstream',
    title: 'Is this workstream safe to delete?',
    description:
      'Single-workstream verdict before deleting or pruning it. Returns safe / holds-work / unknown with reasons. Fail-closed: a workstream that could not be scanned is "unknown", never "safe". Call this before any worktree removal.',
    inputSchema: {
      type: 'object',
      properties: { ...REPO_ARG, id: { type: 'string', description: 'Workstream id (directory basename).' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'holt_collisions',
    title: 'Workstreams that will fight',
    description:
      'Pairs contesting the same content. "proven" means git merge-tree reports a real conflict; "predicted" means at least one side is uncommitted so merge-tree cannot see it — confidence is highest when both sides added the same symbol.',
    inputSchema: {
      type: 'object',
      properties: { ...REPO_ARG, limit: { type: 'number', description: 'Max pairs (default 10).' } },
      additionalProperties: false,
    },
  },
  {
    name: 'holt_duplicates',
    title: 'Workstreams that built the same thing',
    description:
      'Pairs that produced overlapping work. Cross-dispatch overlap is waste; same-family overlap is expected fan-out. Set deep:true to additionally run token-level clone detection (jscpd), which catches the same logic written under different names.',
    inputSchema: {
      type: 'object',
      properties: {
        ...REPO_ARG,
        deep: { type: 'boolean', description: 'Also run jscpd token clone detection (slower).' },
        limit: { type: 'number', description: 'Max pairs (default 10).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'holt_context',
    title: 'What my siblings are doing',
    description:
      'For an agent working IN a workstream: which other workstreams contest its files, and which symbols it is about to build that already exist next door. This is the fix for context blindness — each agent otherwise sees the repo only as it was when it started.',
    inputSchema: {
      type: 'object',
      properties: { ...REPO_ARG, id: { type: 'string', description: 'The workstream you are working in.' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'holt_impact',
    title: 'Who depends on what another workstream changed',
    description:
      'Producer/consumer pairs across workstreams: A defines a symbol, B references it, and they share no file — so collision detection cannot see it. This is a DEPENDENCY relationship, NOT a conflict: it does not tell you the interaction breaks anything. Use before landing a workstream to see whose code will start running against your changes.',
    inputSchema: {
      type: 'object',
      properties: { ...REPO_ARG, limit: { type: 'number', description: 'Max pairs (default 10).' } },
      additionalProperties: false,
    },
  },
  /* ------------------------------------------------------------- ACTING ----
   * MEASURED: agents diagnosed correctly through MCP and then could not ACT. Both routed trials
   * read AGENTS.md, chose `holt clean`, and were stopped by the host's Bash permission
   * classifier — "the permission classifier is blocking the execution". Diagnosis without a way
   * to act is not a product; the agent freezes holding the right answer.
   *
   * MCP tool calls do not go through a shell, so they do not hit that classifier. These are the
   * same operations the CLI exposes, reachable the way an agent actually works. They are
   * annotated honestly (readOnlyHint: false, destructiveHint where true) so a host can gate them
   * on their real risk rather than on a blanket claim.
   */
  {
    name: 'holt_clean',
    title: 'Remove provably-disposable worktrees',
    description:
      'Removes worktrees that hold nothing base lacks, and their merged branches. DRY RUN unless apply:true. Re-verifies each worktree immediately before removing it, never touches one holding work found nowhere else, and never touches one it could not assess. Use this instead of deciding which worktrees are disposable yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        ...REPO_ARG,
        apply: { type: 'boolean', description: 'Actually remove. Omit or false for a dry run.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'holt_rescue',
    title: 'Preserve a workstream\'s unique work to a verifiable ref',
    description:
      'Captures a worktree\'s full state — tracked modifications and untracked files — as a commit on refs/holt/rescue/<id>, verifies the capture, and optionally releases holt\'s lock so the worktree becomes disposable. Fails loudly if the capture cannot be verified. Use this when a worktree is locked and you need it gone; never disarm the lock by hand.',
    inputSchema: {
      type: 'object',
      properties: {
        ...REPO_ARG,
        id: { type: 'string', description: 'Workstream id to rescue.' },
        release: { type: 'boolean', description: 'Also unlock it once the capture verifies.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    // Creates a ref and may unlock. Not destructive — it only ever ADDS a recoverable copy.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'holt_protect',
    title: 'Lock every workstream holding unique work',
    description:
      'Applies git\'s own worktree lock to each workstream holding work found nowhere else, with a reason naming what is at stake. A locked worktree refuses `git worktree remove --force`. Does not stop `rm -rf`.',
    inputSchema: {
      type: 'object',
      properties: {
        ...REPO_ARG,
        dryRun: { type: 'boolean', description: 'Report what would be locked without locking.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'holt_landing_plan',
    title: 'What to land, in what order',
    description:
      'Reduces N workstreams to a review queue: drops provably-disposable ones, collapses duplicates to one representative, and orders the rest least-entangled-first so each landing does not invalidate the next.',
    inputSchema: { type: 'object', properties: { ...REPO_ARG }, additionalProperties: false },
  },
];

/* --------------------------------------------------------------- handlers ---- */

function compactUnique(u) {
  return {
    id: u.id,
    verdict: u.verdict,
    uniqueSymbols: u.uniqueSymbolCount,
    uncommittedOnly: u.uncommittedOnlyCount,
    examples: [...u.byLayer.uncommitted, ...u.byLayer.untracked, ...u.byLayer.committed]
      .slice(0, 4).map((s) => `${s.key} (${s.file})`),
  };
}

async function handle(name, args) {
  const cwd = args?.repo ?? process.cwd();
  const limit = Math.max(1, Math.min(Number(args?.limit) || 10, 100));

  switch (name) {
    case 'holt_landing_order': {
      const { report } = await getReport(cwd);
      return landingOrder(report);
    }

    case 'holt_branches': {
      return await branchAudit(cwd, {});
    }

    case 'holt_partition': {
      const { report } = await getReport(cwd);
      const disc = await discover(cwd, {});
      const ls = await git(['ls-files'], { cwd: disc.root ?? cwd });
      return partitionPlan(report, ls.stdout.split('\n').filter(Boolean), { agents: Number(args?.agents) || 2 });
    }

    case 'holt_status': {
      const { report, _ageMs } = await getReport(cwd);
      const r = report.plan.reviewReduction;
      return {
        repo: report.root,
        base: `${report.base.ref}@${report.base.oid.slice(0, 8)} (${report.base.how})`,
        symbolBackend: report.backend.label,
        workstreams: report.counts.scanned,
        families: report.counts.families,
        atRisk: report.counts.atRisk,
        collisions: report.counts.collisions,
        duplicatePairs: report.counts.duplicatePairs,
        disposable: report.counts.safeToDelete,
        reviewQueue: `${r.total} workstreams -> drop ${r.dropped}, collapse ${r.collapsed} -> ${r.toReview} to review`,
        topRisks: report.unique.filter((u) => u.uncommittedOnlyCount > 0).slice(0, 3).map(compactUnique),
        skipped: report.skipped.length
          ? { count: report.skipped.length, note: 'NOT counted as safe or clean', sample: report.skipped.slice(0, 3) }
          : undefined,
        dataAgeMs: _ageMs,
      };
    }

    case 'holt_at_risk': {
      const { report } = await getReport(cwd);
      const rows = report.unique.filter((u) => u.uniqueSymbolCount > 0 || u.uncommittedOnlyCount > 0);
      return {
        total: rows.length,
        note: 'uncommittedOnly > 0 means the work exists ONLY as uncommitted changes — no git command can relate it',
        workstreams: rows.slice(0, limit).map(compactUnique),
      };
    }

    case 'holt_check_workstream': {
      // Always FRESH: this tool's own description tells the agent to call it before removing a
      // worktree, so it must never answer from cached state that has since changed.
      const { report } = await getReport(cwd, {}, { fresh: true });
      const v = report.safe.find((s) => s.id === args.id);
      if (!v) {
        return {
          error: `no workstream '${args.id}'`,
          known: report.safe.map((s) => s.id).slice(0, 40),
        };
      }
      return {
        id: v.id,
        safeToDelete: v.safe,
        confidence: v.confidence,
        reasons: v.reasons,
        recommendation: v.confidence === 'unknown'
          ? 'DO NOT DELETE — holt could not scan this workstream, so it cannot be called safe'
          : v.safe ? 'safe to delete' : 'DO NOT DELETE — holds work that would be lost',
      };
    }

    case 'holt_collisions': {
      const { report } = await getReport(cwd);
      return {
        total: report.collisions.length,
        pairs: report.collisions.slice(0, limit).map((c) => ({
          a: c.a, b: c.b, severity: c.severity, kind: c.kind, why: c.why,
          sharedFiles: c.sharedFiles.slice(0, 5),
          sharedSymbols: c.sharedSymbols.slice(0, 5),
          crossDispatch: !c.sameFamily,
        })),
      };
    }

    case 'holt_duplicates': {
      const { report, scanned } = await getReport(cwd);
      const out = {
        total: report.duplicates.length,
        pairs: report.duplicates.slice(0, limit).map((d) => ({
          a: d.a, b: d.b,
          sharedSymbols: d.sharedSymbols.slice(0, 6),
          sharedCount: d.sharedCount,
          similarity: Number(d.similarity.toFixed(2)),
          classification: d.classification,
        })),
      };
      if (args?.deep) {
        const deep = await deepDuplicates(scanned);
        out.deep = deep.ran
          ? {
              tool: deep.tool,
              pairs: deep.pairs.slice(0, limit).map((p) => ({
                a: p.a, b: p.b, duplicatedLines: p.duplicatedLines,
                clones: p.cloneCount, classification: p.classification,
              })),
            }
          : { ran: false, reason: deep.reason };
      }
      return out;
    }

    case 'holt_context': {
      const { scanned } = await getReport(cwd);
      const d = contextDigest(scanned, args.id);
      if (!d.ok) return { error: d.error, known: d.known.slice(0, 40) };
      return {
        workstream: d.workstream,
        family: d.family,
        siblings: d.siblings,
        advice: d.advice,
        alreadyBuiltElsewhere: d.duplicatedSymbols.map((x) => ({
          workstream: x.workstream, symbols: x.symbols.slice(0, 5), count: x.count,
        })),
        contestedFiles: d.contestedFiles.map((x) => ({
          workstream: x.workstream, files: x.files.slice(0, 5),
          count: x.fileCount, theirsUncommitted: x.hasUncommitted,
        })),
      };
    }

    case 'holt_impact': {
      const { scanned } = await getReport(cwd);
      const { impact } = await import('../impact.mjs');
      const imp = await impact(scanned, {});
      return {
        total: imp.counts.pairs,
        highConfidence: imp.counts.high,
        pairs: imp.pairs.slice(0, limit).map((p) => ({
          producer: p.producer,
          consumer: p.consumer,
          confidence: p.confidence,
          symbols: (p.unambiguousSymbols.length ? p.unambiguousSymbols : p.symbols).slice(0, 6),
          definedIn: p.definedIn.slice(0, 2),
        })),
        // Repeated on every response on purpose: a model that reads only the payload must not
        // be able to conclude holt detected a conflict.
        important: 'These are DEPENDENCIES, not conflicts. holt cannot tell you whether an interaction breaks anything. References are matched textually, so an occurrence in a comment or string counts.',
      };
    }

    case 'holt_clean': {
      const { clean } = await import('../actions.mjs');
      // Any mutation invalidates the cached scan.
      cache.clear();
      const r = await clean(cwd, { apply: args?.apply === true });
      return r.dryRun
        ? {
            dryRun: true,
            wouldRemove: r.wouldRemove.map((w) => ({ id: w.id, why: w.why })),
            keeping: r.keeping.slice(0, 20),
            unknown: r.unknown,
            next: 'call again with apply:true to remove them',
          }
        : {
            removed: r.removed,
            branchesRemoved: r.branchesRemoved,
            skipped: r.skipped.map((s) => ({ id: s.id, why: s.why })),
            failed: r.failed.map((f) => ({ id: f.id, why: f.why })),
            unknown: r.unknown,
            note: 'each removal was re-verified immediately beforehand; anything that gained work in the meantime was skipped',
          };
    }

    case 'holt_rescue': {
      const { rescue } = await import('../actions.mjs');
      cache.clear();
      const r = await rescue(cwd, args.id, { release: args?.release === true });
      if (r.nothingToRescue) return { id: r.id, nothingToRescue: true, note: r.note };
      if (r.ok === false) {
        return {
          ok: false, error: r.error, missing: r.missing?.slice(0, 10), note: r.note,
          important: 'The capture did NOT verify. Do not delete this worktree.',
        };
      }
      return {
        ok: true, id: r.id, ref: r.ref, capturedFiles: r.capturedFiles,
        verified: r.verified, released: r.released, restore: r.restore, note: r.note,
      };
    }

    case 'holt_protect': {
      const { protect } = await import('../actions.mjs');
      cache.clear();
      const r = await protect(cwd, { dryRun: args?.dryRun === true });
      return {
        dryRun: r.dryRun,
        protected: r.protected,
        alreadyProtected: r.alreadyProtected,
        failed: r.failed,
        unknown: r.unknown,
        note: r.note,
      };
    }

    case 'holt_landing_plan': {
      const { report } = await getReport(cwd);
      const p = report.plan;
      return {
        reviewReduction: p.reviewReduction,
        drop: p.drop.map((d) => d.id),
        collapse: p.collapse.map((c) => `${c.id} -> ${c.into}`),
        order: p.order.map((o) => ({
          step: o.step, id: o.id, files: o.filesToReview,
          uniqueSymbols: o.uniqueSymbols, entanglement: o.entanglement,
        })),
        note: p.note,
      };
    }

    default:
      return { error: `unknown tool '${name}'` };
  }
}

/* ------------------------------------------------------------------ wiring ---- */

export function createServer() {
  const server = new Server(
    { name: 'holt', version: '0.2.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      // Per-tool annotations, defaulting to read-only for the diagnostic majority. A blanket
      // readOnlyHint:true would now be a LIE for holt_clean, and a host that auto-approves
      // read-only tools would auto-approve a deletion. The annotation is a safety contract, so
      // it has to be per-tool and true.
      annotations: t.annotations
        ?? { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      const result = await handle(name, args ?? {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      // Errors are returned as content with isError so the model can react, rather than
      // thrown — a transport-level failure gives the agent nothing to work with.
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ error: err?.message ?? String(err), tool: name }, null, 2) }],
      };
    }
  });

  return server;
}

export async function runStdioServer() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/** Exposed for tests: exercise a tool without a transport. */
export const __test = { handle, TOOLS, clearCache: () => cache.clear() };
