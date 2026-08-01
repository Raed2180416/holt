// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — the CLAIM patterns shared between the cross-surface agreement test
 * (test/unit/published-numbers.test.mjs), the gate that gets proven against a scratch fixture
 * (test/unit/published-numbers-gate.test.mjs), and the CI step that compares published copy
 * against what the suite actually reported (scripts/check-published-numbers.mjs).
 *
 * ONE list, in ONE place, on purpose. Two copies of "every way this repo has ever written N
 * tests passing" drift the instant someone fixes a regex in only one of them — which is exactly
 * the failure class this file exists to close.
 *
 * WHY THESE ARE CONTEXT-SHAPED, NOT BARE NUMBERS. `grep -q "$N" file` matches N wherever it
 * appears — a hex colour, an SVG coordinate, a port number, a year. Every pattern below requires
 * the digits to sit inside a shape this repo actually uses to publish a claim: a shields.io badge
 * URL, the "N tests passing" sentence, a benchmark table row, or a site stat tile. A number found
 * outside every one of these shapes is not a claim and must not satisfy the gate.
 */

/** Every way this repo has ever written "N tests pass". Capture group 1 = the count. */
export const TEST_COUNT_PATTERNS = [
  /tests-(\d+)%20passing/g, // shields badge
  /(\d+)\s+(?:tests?)\s+passing/gi,
  /(\d+)\s+tests?,\s+and\s+the\s+interesting/gi,
  /(\d+)\s+tests\s+\+/gi,
  /tile-num">(\d+)<\/div><div class="tile-label">tests passing/g, // site tile
  /\|\s*tests\s*\|\s*(\d+)\s+passing/gi, // BENCHMARKS table row
];

/** Every way this repo has ever written the mutation score. Capture groups 1/2 = killed/of. */
export const MUTATION_PATTERNS = [
  /mutation%20score-(\d+)%2F(\d+)%20killed/g,
  /(\d+)\/(\d+)\s+(?:deliberate[- ]defects?|mutations?)\s+killed/gi,
  /(\d+)\/(\d+)\s+killed/gi,
  /tile-num">(\d+)\/(\d+)<\/div>/g,
];

/**
 * The falsification history ("the first run scored 10/12") is a deliberate, permanent record of a
 * WORSE past score, not a competing claim about today. It is the one legitimate exception to "all
 * claims must agree / must equal the measured value", and every consumer of MUTATION_PATTERNS
 * must apply it the same way — hence it lives here, not copy-pasted per caller.
 */
export const MUTATION_HISTORICAL_EXCEPTION = '10/12';

/** Pull every match of `patterns` out of `text`. `arity` 2 joins capture groups 1/2 as "a/b". */
export function claims(text, patterns, arity = 1) {
  const found = [];
  for (const re of patterns) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
      found.push(arity === 1 ? m[1] : `${m[1]}/${m[2]}`);
    }
  }
  return found;
}

/**
 * Does `text` publish EXACTLY `expected` as a claim, in one of the recognised shapes, and nothing
 * else? Returns `{ ok, found }` where `found` is the deduplicated list of whatever claims were
 * actually extracted (for error messages) — never a boolean alone, because "no" and "why not" are
 * both needed to fix a failing gate quickly.
 *
 * `ok` requires BOTH: at least one claim found (anti-vacuity — a pattern that stopped matching
 * must not silently pass), and every claim found equal to `expected` (a stale or wrong number
 * elsewhere in a recognised shape fails the gate even if one instance happens to be right).
 */
export function matchesExactClaim(text, patterns, expected, { arity = 1, exceptions = [] } = {}) {
  const found = [...new Set(claims(text, patterns, arity))].filter((c) => !exceptions.includes(c));
  const ok = found.length > 0 && found.every((c) => c === expected);
  return { ok, found };
}
