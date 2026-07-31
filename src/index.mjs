// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — public API.
 *
 * The landing layer for parallel agent work. One scan answers: what did N agents produce,
 * what's redundant, what collides, what's safe to delete, and what you're about to lose.
 */

export { discover, inferFamily, parseWorktreePorcelain } from './discover.mjs';
export { scan, resolveBase, looksGenerated } from './scan.mjs';
export {
  analyze, uniqueWork, safeToDelete, collisions, duplicates,
  contextDigest, landingPlan, buildGraph, overlappingPairs,
} from './analyze.mjs';
export { classify, git, GitRefused, GitFailed } from './git.mjs';
export {
  resolveBackend, detectCtags, symbolsOnDisk, symbolsAtBase,
  diffSymbols, symbolKey, extractKeys, fallbackExtract,
} from './symbols.mjs';
export { deepDuplicates, detectJscpd } from './deep.mjs';

import { discover } from './discover.mjs';
import { scan } from './scan.mjs';
import { analyze } from './analyze.mjs';

/**
 * One call: discover -> scan -> analyze.
 *
 * @param {string} cwd    any path inside the repository
 * @param {object} opts   {base, strictReadOnly, concurrency, timeout, symbols, includePrimary}
 * @returns {Promise<object>} the full report
 */
export async function inspect(cwd = process.cwd(), opts = {}) {
  const disc = await discover(cwd, opts);
  if (!disc.root) {
    const err = new Error(`holt: not a git repository (searched from ${cwd})`);
    err.code = 'ENOTREPO';
    throw err;
  }
  const scanned = await scan(disc, opts);
  return analyze(scanned, opts);
}
