#!/usr/bin/env node
/**
 * holt — social-proof gate.
 *
 * A README that displays "8 stars · 21 downloads/week" argues against the project. Below a
 * credible threshold, showing nothing is strictly better than showing the truth badly. So the
 * marketing block lives in the README as an HTML comment from day one and switches itself on,
 * once, when the numbers can carry it.
 *
 * THRESHOLD (either, not both):
 *   - 500 GitHub stars, or
 *   - 1,000 npm downloads in the last week
 *
 * Both are points where a reader's reaction flips from "who else uses this?" to "this is
 * established". Below them the badges are a liability; above them they are the strongest thing
 * on the page.
 *
 *   node scripts/milestone.mjs --check     # report the numbers, exit 0 if the gate is met
 *   node scripts/milestone.mjs --apply     # switch the block on if the gate is met
 */

import fs from 'node:fs/promises';

export const THRESHOLDS = { stars: 500, weeklyDownloads: 1000 };

export const BEGIN = '<!-- HOLT:SOCIAL-PROOF:BEGIN';
export const END = 'HOLT:SOCIAL-PROOF:END -->';
const BEGIN_ON = '<!-- HOLT:SOCIAL-PROOF:BEGIN -->';
const END_ON = '<!-- HOLT:SOCIAL-PROOF:END -->';

/** Pure: given counts, is the gate met and why. */
export function evaluate({ stars = 0, weeklyDownloads = 0 } = {}) {
  const reasons = [];
  if (stars >= THRESHOLDS.stars) reasons.push(`${stars} stars ≥ ${THRESHOLDS.stars}`);
  if (weeklyDownloads >= THRESHOLDS.weeklyDownloads) reasons.push(`${weeklyDownloads} weekly downloads ≥ ${THRESHOLDS.weeklyDownloads}`);
  return {
    met: reasons.length > 0,
    reasons,
    stars,
    weeklyDownloads,
    shortfall: {
      stars: Math.max(0, THRESHOLDS.stars - stars),
      weeklyDownloads: Math.max(0, THRESHOLDS.weeklyDownloads - weeklyDownloads),
    },
  };
}

/** Is the block currently commented out? Pure string work, so it is exhaustively testable. */
export function isDisabled(readme) {
  return readme.includes(BEGIN) && !readme.includes(BEGIN_ON);
}

/**
 * Switch the block on by closing the comment immediately after the BEGIN marker and opening it
 * again immediately before the END marker. Idempotent: enabling an already-enabled README is a
 * no-op, which matters because this runs on a schedule.
 */
export function enable(readme) {
  if (!readme.includes(BEGIN)) return { changed: false, readme, reason: 'no social-proof block found' };
  if (!isDisabled(readme)) return { changed: false, readme, reason: 'already enabled' };
  const next = readme.replace(BEGIN, BEGIN_ON).replace(END, END_ON);
  return { changed: true, readme: next, reason: 'social-proof block enabled' };
}

async function fetchCounts({ repo, pkg, fetchImpl = fetch } = {}) {
  let stars = 0;
  let weeklyDownloads = 0;
  const errors = [];
  try {
    const r = await fetchImpl(`https://api.github.com/repos/${repo}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'holt-milestone' },
    });
    if (r.ok) stars = (await r.json()).stargazers_count ?? 0;
    else errors.push(`github ${r.status}`);
  } catch (e) { errors.push(`github ${e.message}`); }
  try {
    const r = await fetchImpl(`https://api.npmjs.org/downloads/point/last-week/${pkg}`);
    if (r.ok) weeklyDownloads = (await r.json()).downloads ?? 0;
    else errors.push(`npm ${r.status}`);
  } catch (e) { errors.push(`npm ${e.message}`); }
  // A failed lookup must never be read as "threshold met" — counts stay at zero and the
  // errors are reported, so a rate-limited API cannot flip the README on by accident.
  return { stars, weeklyDownloads, errors };
}

async function main() {
  const repo = process.env.HOLT_REPO || 'raed2180416/holt';
  const pkg = process.env.HOLT_PKG || 'holt';
  const counts = await fetchCounts({ repo, pkg });
  const verdict = evaluate(counts);

  if (counts.errors.length) process.stderr.write(`milestone: lookup issues — ${counts.errors.join(', ')}\n`);
  process.stdout.write(JSON.stringify({ ...verdict, errors: counts.errors }, null, 2) + '\n');

  if (!process.argv.includes('--apply')) {
    process.exit(verdict.met ? 0 : 1);
  }
  if (!verdict.met) {
    process.stdout.write('milestone: not met — README unchanged\n');
    process.exit(1);
  }
  const readme = await fs.readFile('README.md', 'utf8');
  const res = enable(readme);
  if (res.changed) {
    await fs.writeFile('README.md', res.readme);
    process.stdout.write(`milestone: ${res.reason} (${verdict.reasons.join('; ')})\n`);
  } else {
    process.stdout.write(`milestone: ${res.reason}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { process.stderr.write(`${e.stack}\n`); process.exit(2); });
}
