/**
 * grove — MCP server.
 *
 * TOOL DESIGN FOLLOWS THE 2026 CONSENSUS, WHICH IS NOT DECORATION:
 * a five-server / 58-tool setup can burn ~55K tokens on schemas alone, and the highest-leverage
 * fix is to return only what the agent needs and to aggregate server-side — expose
 * `get_sales_summary_by_region`, never `get_all_sales_records`.
 *
 * grove's own numbers make the case. Against the repository this was built for, the useful
 * answer was "4 of 69 workstreams hold unique work". A `list_all_worktrees` tool would spend
 * thousands of tokens delivering 69 objects so the model could rediscover that 4 matter.
 * So every tool here returns a DECISION with its evidence, and every list takes a `limit`.
 *
 * All tools are read-only (annotated as such). grove cannot modify a repository — see
 * src/git.mjs and test/unit/safety.test.mjs.
 */
// @ts-nocheck


import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { discover } from '../discover.mjs';
import { scan } from '../scan.mjs';
import { analyze, contextDigest } from '../analyze.mjs';
import { deepDuplicates } from '../deep.mjs';

/* --------------------------------------------------------------- caching ---- */

/**
 * A scan is ~0.3–3 s depending on repo size. An agent asking three questions in a row should
 * not pay for three scans, but a stale answer about what is safe to DELETE is dangerous — so
 * the TTL is short and every response carries the age of the data it came from.
 */
const CACHE_TTL_MS = 15_000;
const cache = new Map();

async function getReport(cwd, opts = {}) {
  const key = `${cwd}::${JSON.stringify(opts)}`;
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_TTL_MS) {
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
    name: 'grove_status',
    title: 'Parallel work status',
    description:
      'The decision surface for all parallel workstreams (git worktrees / jj workspaces): how many hold work that exists nowhere else, how many collide, how many are disposable, and how much review is actually needed. Start here.',
    inputSchema: { type: 'object', properties: { ...REPO_ARG }, additionalProperties: false },
  },
  {
    name: 'grove_at_risk',
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
    name: 'grove_check_workstream',
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
    name: 'grove_collisions',
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
    name: 'grove_duplicates',
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
    name: 'grove_context',
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
    name: 'grove_impact',
    title: 'Who depends on what another workstream changed',
    description:
      'Producer/consumer pairs across workstreams: A defines a symbol, B references it, and they share no file — so collision detection cannot see it. This is a DEPENDENCY relationship, NOT a conflict: it does not tell you the interaction breaks anything. Use before landing a workstream to see whose code will start running against your changes.',
    inputSchema: {
      type: 'object',
      properties: { ...REPO_ARG, limit: { type: 'number', description: 'Max pairs (default 10).' } },
      additionalProperties: false,
    },
  },
  {
    name: 'grove_landing_plan',
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
    case 'grove_status': {
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

    case 'grove_at_risk': {
      const { report } = await getReport(cwd);
      const rows = report.unique.filter((u) => u.uniqueSymbolCount > 0 || u.uncommittedOnlyCount > 0);
      return {
        total: rows.length,
        note: 'uncommittedOnly > 0 means the work exists ONLY as uncommitted changes — no git command can relate it',
        workstreams: rows.slice(0, limit).map(compactUnique),
      };
    }

    case 'grove_check_workstream': {
      const { report } = await getReport(cwd);
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
          ? 'DO NOT DELETE — grove could not scan this workstream, so it cannot be called safe'
          : v.safe ? 'safe to delete' : 'DO NOT DELETE — holds work that would be lost',
      };
    }

    case 'grove_collisions': {
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

    case 'grove_duplicates': {
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

    case 'grove_context': {
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

    case 'grove_impact': {
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
        // be able to conclude grove detected a conflict.
        important: 'These are DEPENDENCIES, not conflicts. grove cannot tell you whether an interaction breaks anything. References are matched textually, so an occurrence in a comment or string counts.',
      };
    }

    case 'grove_landing_plan': {
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
    { name: 'grove', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
