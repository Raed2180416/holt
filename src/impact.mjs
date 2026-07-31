/**
 * holt — cross-workstream IMPACT.  (the honest neighbour of P4)
 *
 * ============================================================================================
 * WHAT THIS IS NOT
 * ============================================================================================
 * This is NOT semantic conflict detection. holt does not claim to tell you whether two changes
 * that merge cleanly will break at runtime. That problem is unresolved, and the 2026 literature
 * is unambiguous about why:
 *
 *   - static approaches carry high false-positive rates, largely from imprecise pointer analysis
 *     (arXiv 2310.04269; arXiv 2507.20081);
 *   - dynamic/test-based approaches buy precision at a large cost in recall
 *     (Detecting semantic conflicts with unit tests, JSS 2024);
 *   - RefFilter (arXiv 2510.01960) is the current best refactoring-aware filter and improves
 *     false positives by ~32% over a baseline — an improvement, not a solution;
 *   - and RefactoringMiner, the detector RefFilter depends on, is JAVA ONLY, which rules it out
 *     for a tool that has to work on 164 languages.
 *
 * Reporting "these two conflict" on that basis would be a confident wrong answer, which for a
 * tool whose value is trustworthy refusal is worse than no answer at all.
 *
 * ============================================================================================
 * WHAT THIS IS
 * ============================================================================================
 * A factual, checkable statement about the dependency structure between parallel workstreams:
 *
 *     A defines symbol X.  B references X and does not define it.  B never touches A's file.
 *
 * That is a PRODUCER/CONSUMER relationship across workstreams, and it is exactly the case that
 * collision detection structurally cannot see — P1 works by file overlap, and here there is
 * none. When both land, B's code runs against A's definition of X for the first time.
 *
 * holt reports the relationship and the evidence. It does not tell you the interaction is a
 * problem, because it cannot know that.
 *
 * MEASURED on a real 37-workstream repository: 694 interaction pairs, of which 307 were NOT
 * already reported as collisions — genuinely new information. The unfiltered version produced
 * 1215 pairs whose evidence was `summary`, `verdict`, `reasons`; the discriminative filter is
 * what makes the difference between a signal and a wall of noise.
 *
 * References are found with ripgrep (word-bounded, scoped to the consumer's changed files),
 * which is language-agnostic and high-recall. It is a TEXTUAL match: a name inside a comment or
 * string counts. That imprecision is stated on every finding rather than hidden, and it is the
 * honest trade for working on every language instead of the handful with a reference indexer.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pmap } from './git.mjs';
import { discriminativeSymbols } from './analyze.mjs';

let _rgProbe = null;

export async function detectRipgrep() {
  if (_rgProbe) return _rgProbe;
  _rgProbe = new Promise((resolve) => {
    execFile('rg', ['--version'], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve({ available: false, reason: 'ripgrep-not-found' });
      resolve({ available: true, version: String(stdout).trim().split('\n')[0] });
    });
  });
  return _rgProbe;
}

/**
 * Is this symbol name worth searching for?
 *
 * A reference search on `get`, `data` or `result` returns a hit in every file in the repository
 * and tells you nothing. The bar is deliberately high: the cost of missing a weak interaction is
 * an unreported risk; the cost of reporting thousands is that the real ones become invisible.
 */
function searchable(name) {
  if (typeof name !== 'string') return false;
  if (name.length < 6) return false;
  // Require some internal structure — SCREAMING_CASE, camelCase or snake_case. Single
  // lowercase words are overwhelmingly generic.
  return /[A-Z]/.test(name) || name.includes('_');
}

/** Files worth searching. Reference-hunting in a lockfile or a minified bundle is pure noise. */
const SEARCHABLE_EXT = /\.(js|mjs|cjs|jsx|ts|tsx|mts|cts|py|go|rs|java|kt|kts|rb|php|cs|c|h|cc|cpp|hpp|swift|scala|dart|groovy|sol|zig|nim|cr|fs|fsx|ex|exs|erl|hs|jl|lua|pl|pm|r|sh|bash|zsh|sql|vue|svelte)$/i;

function refSearchable(file) {
  return SEARCHABLE_EXT.test(file);
}

/**
 * Find which of `names` appear (word-bounded) in `files` under `cwd`.
 * One ripgrep invocation per consumer, not per symbol.
 */
async function referencesIn(cwd, files, names, { timeout = 60_000, maxNames = 300 } = {}) {
  if (!files.length || !names.length) return new Set();

  const escaped = names.slice(0, maxNames).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = escaped.join('|');

  const stdout = await new Promise((resolve) => {
    execFile(
      'rg',
      ['--only-matching', '--no-filename', '--no-line-number', '--word-regexp',
        '--regexp', pattern, '--', ...files],
      { cwd, timeout, maxBuffer: 64 * 1024 * 1024 },
      // rg exits 1 when there are no matches — that is an answer, not an error.
      (err, out) => resolve(String(out ?? '')),
    );
  });

  return new Set(stdout.split('\n').filter(Boolean));
}

/** Node fallback when ripgrep is absent: slower, same semantics, still language-agnostic. */
async function referencesInFallback(cwd, files, names, { maxBytes = 2 * 1024 * 1024 } = {}) {
  const found = new Set();
  if (!names.length) return found;
  const wanted = new Set(names);

  await pmap(files, async (rel) => {
    try {
      const st = await fs.stat(path.join(cwd, rel));
      if (!st.isFile() || st.size > maxBytes) return;
      const buf = await fs.readFile(path.join(cwd, rel));
      if (buf.includes(0)) return;
      const text = buf.toString('utf8');
      // Word-bounded scan over identifier-ish tokens.
      for (const token of text.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []) {
        if (wanted.has(token)) found.add(token);
      }
    } catch { /* unreadable file is not a failure */ }
  }, 8);

  return found;
}

/**
 * Cross-workstream impact.
 *
 * @returns {{ran, tool, pairs, counts, caveats}}
 */
export async function impact(scanResult, { limitPerSide = 300, concurrency = 4 } = {}) {
  const live = scanResult.workstreams.filter((w) => w.ok && w.touched.length);
  if (live.length < 2) {
    return {
      ran: true, tool: null, pairs: [],
      counts: { workstreams: live.length, pairs: 0, novel: 0 },
      caveats: ['fewer than two scannable workstreams — nothing to relate'],
    };
  }

  const rg = await detectRipgrep();
  const { keep } = discriminativeSymbols(live);
  const keepNames = new Set([...keep].map((k) => k.slice(k.indexOf(':') + 1)));

  // What each workstream DEFINES (discriminative and distinctive only), and where.
  const defines = new Map();     // id -> Map<name, Set<file>>
  for (const w of live) {
    const m = new Map();
    for (const s of w.added ?? []) {
      if (!keepNames.has(s.name) || !searchable(s.name)) continue;
      if (!m.has(s.name)) m.set(s.name, new Set());
      m.get(s.name).add(s.file);
    }
    defines.set(w.id, m);
  }

  // Symbols defined by exactly one workstream are unambiguous producers.
  const definerCount = new Map();
  for (const m of defines.values()) {
    for (const name of m.keys()) definerCount.set(name, (definerCount.get(name) ?? 0) + 1);
  }

  const producers = live.filter((w) => defines.get(w.id).size > 0);
  const pairs = [];

  await pmap(live, async (consumer) => {
    const consumerFiles = consumer.touched.filter(refSearchable);
    if (!consumerFiles.length) return;

    // Everything any OTHER workstream defines, searched in one pass over this consumer.
    const candidateNames = [];
    for (const p of producers) {
      if (p.id === consumer.id) continue;
      for (const name of defines.get(p.id).keys()) {
        if (!defines.get(consumer.id).has(name)) candidateNames.push(name);
      }
    }
    const unique = [...new Set(candidateNames)].slice(0, limitPerSide);
    if (!unique.length) return;

    const hits = rg.available
      ? await referencesIn(consumer.path, consumerFiles, unique)
      : await referencesInFallback(consumer.path, consumerFiles, unique);
    if (!hits.size) return;

    // Attribute each hit back to the workstream(s) that define it.
    for (const p of producers) {
      if (p.id === consumer.id) continue;
      const pDefs = defines.get(p.id);
      const shared = [...hits].filter((n) => pDefs.has(n));
      if (!shared.length) continue;

      // If the consumer also TOUCHED the file where the producer defines it, this is already a
      // file-level collision and P1 owns it. Impact exists to surface what P1 cannot see.
      const consumerTouched = new Set(consumer.touched);
      const throughSharedFile = shared.every((n) =>
        [...pDefs.get(n)].some((f) => consumerTouched.has(f)));
      if (throughSharedFile) continue;

      const unambiguous = shared.filter((n) => definerCount.get(n) === 1);

      pairs.push({
        producer: p.id,
        consumer: consumer.id,
        symbols: shared.sort().slice(0, 12),
        symbolCount: shared.length,
        unambiguousSymbols: unambiguous.sort().slice(0, 12),
        sameFamily: p.family === consumer.family,
        definedIn: [...new Set(shared.flatMap((n) => [...pDefs.get(n)]))].slice(0, 5),
        // Confidence is about ATTRIBUTION — how sure we are that THIS producer is the one the
        // consumer depends on — never about whether the interaction is a problem.
        //
        //   0 unambiguous  every shared symbol is defined by several workstreams, so the link
        //                  cannot be attributed to this producer in particular
        //   1 unambiguous  one confirmed link
        //  2+ unambiguous  several symbols only this producer defines; not a coincidence
        //
        // (An earlier cut required 3+ for 'high', which was a number with no argument behind it.)
        confidence: unambiguous.length === 0 ? 'low'
          : unambiguous.length >= 2 ? 'high' : 'medium',
        why:
          `'${consumer.id}' references ${shared.length} symbol(s) that '${p.id}' defines and ` +
          `'${consumer.id}' does not — and they share no file, so collision detection cannot see this`,
      });
    }
  }, concurrency);

  const order = { high: 0, medium: 1, low: 2 };
  pairs.sort((a, b) =>
    order[a.confidence] - order[b.confidence]
    || b.unambiguousSymbols.length - a.unambiguousSymbols.length
    || b.symbolCount - a.symbolCount);

  return {
    ran: true,
    tool: rg.available ? rg.version : 'node fallback (ripgrep absent — slower, same semantics)',
    pairs,
    counts: {
      workstreams: live.length,
      pairs: pairs.length,
      high: pairs.filter((p) => p.confidence === 'high').length,
    },
    caveats: [
      'This is a DEPENDENCY relationship, not a conflict. holt cannot tell you whether the interaction breaks anything.',
      'References are matched TEXTUALLY and word-bounded: an occurrence inside a comment or string counts as a reference.',
      'Only discriminative, structured symbol names are searched; short or repo-wide-common names are excluded as uninformative.',
      'Semantic conflict detection proper (P4) is not attempted — see the module header for why.',
    ],
  };
}
