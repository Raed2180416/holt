/**
 * holt — detection, against hand-constructed ground truth.
 *
 * Structure follows one rule: PROVE THE INSTRUMENT CAN DETECT PRESENCE BEFORE TRUSTING ITS
 * SILENCE. Each detector is asserted first on a case that MUST be found, and only then on a
 * negative control. A suite that only checked "no false positives" would pass perfectly with
 * every detector returning [] unconditionally.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { standardFixture, emptyFixture, newRepo, backdateWorktreeCreation } from '../fixtures.mjs';
import { discover } from '../../src/discover.mjs';
import { scan } from '../../src/scan.mjs';
import { analyze, contextDigest } from '../../src/analyze.mjs';

async function inspectFixture(fx, opts = {}) {
  const disc = await discover(fx.root, opts);
  const scanned = await scan(disc, opts);
  const report = await analyze(scanned, opts);
  return { report, scanned };
}

const byId = (rows, id) => rows.find((r) => r.id === id);
const pairMatches = (p, a, b) => (p.a === a && p.b === b) || (p.a === b && p.b === a);

/* ------------------------------------------------------------ discovery ---- */

test('discovery: finds every worktree, and the primary is excluded by default', async (t) => {
  const { fx, truth } = await standardFixture();
  t.after(() => fx.cleanup());

  const { report } = await inspectFixture(fx);
  const ids = report.unique.map((u) => u.id).concat(report.skipped.map((s) => s.id));

  for (const w of truth.allWorktrees) {
    assert.ok(ids.includes(w), `worktree '${w}' was not discovered — found: ${ids.join(', ')}`);
  }
  assert.equal(report.counts.scanned, truth.allWorktrees.length);
  assert.equal(report.counts.skipped, 0, 'no worktree should have failed to scan');
});

/* ------------------------------------------------- P0: unique / at-risk ---- */

test('P0 PRESENCE: uncommitted-only work is detected and flagged as at risk', async (t) => {
  const { fx, truth } = await standardFixture();
  t.after(() => fx.cleanup());

  const { report } = await inspectFixture(fx);
  const row = byId(report.unique, 'uniqueUncommitted');

  assert.ok(row, 'uniqueUncommitted missing from the unique-work report');
  assert.equal(row.verdict, 'unique-work-uncommitted');
  assert.ok(row.uncommittedOnlyCount > 0, 'uncommitted-only count should be > 0');

  const found = [...row.byLayer.uncommitted, ...row.byLayer.untracked].map((s) => s.key);
  assert.ok(
    found.includes(truth.uncommittedOnlySymbol),
    `expected ${truth.uncommittedOnlySymbol} in the uncommitted layer, got: ${found.join(', ')}`,
  );
});

test('P0 PRESENCE: committed unique work is detected and NOT confused with at-risk', async (t) => {
  const { fx, truth } = await standardFixture();
  t.after(() => fx.cleanup());

  const { report } = await inspectFixture(fx);
  const row = byId(report.unique, 'uniqueCommitted');

  assert.ok(row, 'uniqueCommitted missing');
  assert.equal(row.verdict, 'unique-work-committed');
  assert.equal(row.uncommittedOnlyCount, 0, 'committed work must not be reported as uncommitted-only');
  assert.ok(row.uniqueSymbols.includes(truth.committedOnlySymbol),
    `expected ${truth.committedOnlySymbol}, got: ${row.uniqueSymbols.join(', ')}`);
});

test('P0: a symbol present in TWO workstreams is not unique to either', async (t) => {
  const { fx, truth } = await standardFixture();
  t.after(() => fx.cleanup());

  const { report } = await inspectFixture(fx);
  for (const id of truth.duplicatePair) {
    const row = byId(report.unique, id);
    assert.ok(!row.uniqueSymbols.includes(truth.duplicateSymbol),
      `${truth.duplicateSymbol} appears in both workstreams so it cannot be unique to ${id}`);
  }
});

/**
 * MEASURED (bench50, 50-language corpus, `unique` question): 100 of 156 recall misses were the
 * SAME planted case repeated once per language — two workstreams that each add a symbol under the
 * IDENTICAL declared name, in a DIFFERENT file with COMPLETELY DIFFERENT content (the corpus's
 * `wt-unique` / `wt-symbol-dup` pair, purpose-built to test exactly this boundary). Before this
 * fix, `uniqueWork()`'s ownership map was keyed on symbol NAME alone: the instant two live
 * workstreams both declared something called, say, `CsClass_nul`, BOTH lost their entire
 * `uniqueSymbolCount` — verdict `committed-delta-no-unique-symbols` for two workstreams that, by
 * the independent oracle's own content-identity definition, each hold committed work found
 * nowhere else. This is not limited to the adversarial fixture: any two agents independently
 * naming a class or function the same thing (`Handler`, `Config`, `parse`) would trip the same
 * false negative on the tool whose entire purpose is "tell me what would be lost".
 *
 * The fix reuses content-identity.mjs (already load-bearing for `safeToDelete`'s file-level
 * redundancy check): a name collision only downgrades a symbol from "unique" when the FILE it
 * lives in also has a content-identity twin in the colliding workstream. A name match that is not
 * also a content match is not the same work — see the P0 test directly above, which pins that a
 * GENUINE content duplicate (byte-identical bodies) must still be excluded from both sides.
 */
test('P0 PRECISION: a symbol name collision across DIFFERENT content is unique to BOTH sides', async (t) => {
  const fx = await newRepo('name-collision');
  t.after(() => fx.cleanup());

  await fx.worktree('finch');
  await fx.write('src/tax.js',
    'export class Handler {\n  computeTax(order) {\n    return order.subtotal * 1.08;\n  }\n}\n',
    fx.wt('finch'));
  await fx.commit('finch builds a tax handler', fx.wt('finch'));

  await fx.worktree('marlin');
  await fx.write('src/sanitize.js',
    'export class Handler {\n  cleanInput(name) {\n    return name.trim().toLowerCase();\n  }\n}\n',
    fx.wt('marlin'));
  await fx.commit('marlin builds an unrelated input handler', fx.wt('marlin'));

  const { report, scanned } = await inspectFixture(fx);
  const finch = byId(report.unique, 'finch');
  const marlin = byId(report.unique, 'marlin');
  const nameKey = 'callable:Handler';

  // ANTI-VACUITY: symbol-identity must actually see the name collision, or this test proves
  // nothing about the fix — it would pass identically against code that never had the bug.
  const finchScan = scanned.workstreams.find((w) => w.id === 'finch');
  const marlinScan = scanned.workstreams.find((w) => w.id === 'marlin');
  assert.ok(finchScan.addedKeys.includes(nameKey), 'finch must add a symbol named Handler');
  assert.ok(marlinScan.addedKeys.includes(nameKey), 'marlin must add a symbol named Handler');

  assert.equal(finch.verdict, 'unique-work-committed',
    `finch holds a real, differently-bodied declaration and must be unique-work-committed, got ` +
    `${finch.verdict} (uniqueSymbols: ${JSON.stringify(finch.uniqueSymbols)})`);
  assert.equal(marlin.verdict, 'unique-work-committed',
    `marlin holds a real, differently-bodied declaration and must be unique-work-committed, got ` +
    `${marlin.verdict} (uniqueSymbols: ${JSON.stringify(marlin.uniqueSymbols)})`);
  assert.ok(finch.uniqueSymbols.includes(nameKey),
    `finch's Handler must count as unique despite the name collision: ${JSON.stringify(finch.uniqueSymbols)}`);
  assert.ok(marlin.uniqueSymbols.includes(nameKey),
    `marlin's Handler must count as unique despite the name collision: ${JSON.stringify(marlin.uniqueSymbols)}`);
});

/* ------------------------------------------------------- P1: collisions ---- */

test('P1 PRESENCE: a real registry conflict is detected AND proven by merge-tree', async (t) => {
  const { fx, truth } = await standardFixture();
  t.after(() => fx.cleanup());

  const { report } = await inspectFixture(fx);
  const [a, b] = truth.collisionPair;
  const col = report.collisions.find((c) => pairMatches(c, a, b));

  assert.ok(col, `no collision reported between ${a} and ${b}`);
  assert.equal(col.severity, 'high');
  assert.equal(col.kind, 'proven', 'both sides are committed, so this must be PROVEN, not predicted');
  assert.equal(col.mergeTreeConflict, true);
  assert.ok(col.sharedFiles.includes('config/registry.mjs'));
});

test('P1: workstreams that touch disjoint files produce no collision', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const { report } = await inspectFixture(fx);
  const bogus = report.collisions.find((c) => pairMatches(c, 'uniqueCommitted', 'empty'));
  assert.equal(bogus, undefined, 'disjoint workstreams must not collide');
});

/* ------------------------------------------------------- P3: duplicates ---- */

test('P3 PRESENCE: two dispatches building the same symbol are detected as duplicates', async (t) => {
  const { fx, truth } = await standardFixture();
  t.after(() => fx.cleanup());

  const { report } = await inspectFixture(fx);
  const [a, b] = truth.duplicatePair;
  const dup = report.duplicates.find((d) => pairMatches(d, a, b));

  assert.ok(dup, `no duplicate reported between ${a} and ${b}`);
  assert.ok(dup.sharedSymbols.includes(truth.duplicateSymbol),
    `expected shared symbol ${truth.duplicateSymbol}, got: ${dup.sharedSymbols.join(', ')}`);
  assert.equal(dup.sameFamily, false, 'these are separate dispatches');
  assert.equal(dup.classification, 'cross-dispatch-waste');
});

/**
 * MEASURED (bench50, 50-language corpus): every one of the 50 duplicate false positives
 * scored against the independent oracle is the SAME planted case repeated once per language —
 * two workstreams sharing 100% of their (identical) declared symbols where the pair differs
 * only in bytes the oracle cannot attribute to either declaration. Symbol-name identity alone
 * cannot distinguish that shape from THIS one: two agents who independently pick a common,
 * undiscriminating name (`process`, `handler`, `validate`, ...) for two functions that do
 * different things. `discriminativeSymbols()` only drops a name shared by a large FRACTION of
 * live workstreams (>25%, floor 3) — with a two- or three-way fan-out, a name shared by every
 * side of the fan-out never crosses that floor, so it survives as "discriminative" evidence
 * even though it is really just a coincidence. The fix is not naming this symbol as boilerplate
 * (no list generalises); it is refusing to call two occurrences "shared" unless their actual
 * declared bodies agree, which a genuine duplicate's do and a name coincidence's do not.
 */
test('P3 PRECISION: two workstreams that coincidentally pick the same name for unrelated work are not duplicates', async (t) => {
  const fx = await newRepo('coincidental-name');
  t.after(() => fx.cleanup());

  await fx.worktree('orchid');
  await fx.write('src/tax.js',
    'export function process(order) {\n  return order.subtotal * 1.08;\n}\n', fx.wt('orchid'));
  await fx.commit('orchid computes tax', fx.wt('orchid'));

  await fx.worktree('quokka');
  await fx.write('src/sanitize.js',
    'export function process(name) {\n  return name.trim().toLowerCase();\n}\n', fx.wt('quokka'));
  await fx.commit('quokka sanitizes input', fx.wt('quokka'));

  const { scanned, report } = await inspectFixture(fx);
  const orchid = scanned.workstreams.find((w) => w.id === 'orchid');
  const quokka = scanned.workstreams.find((w) => w.id === 'quokka');
  // Family comes from git provenance (fork point + creation time), not from naming — see
  // discover.mjs's assignFamilies. orchid and quokka really were forked from the same commit and
  // created together in this fixture, so they honestly ARE one family; that fact is irrelevant to
  // this test, which is about duplicate detection using CONTENT (declared body), not about
  // family. Asserting on family here would test the wrong layer.
  assert.equal(orchid.familyRule, 'fork+creation-time', 'the fixture must have real provenance to assign a family from');

  // ANTI-VACUITY: symbol-identity must actually see the coincidence, or this test proves nothing.
  assert.ok(orchid.addedKeys.some((k) => k.endsWith(':process')), 'orchid must add a symbol named process');
  assert.ok(quokka.addedKeys.some((k) => k.endsWith(':process')), 'quokka must add a symbol named process');

  const dup = report.duplicates.find((d) => pairMatches(d, 'orchid', 'quokka'));
  assert.equal(dup, undefined,
    `two unrelated functions that happen to share a name must not be reported as duplicate work: ${JSON.stringify(dup)}`);
});

/* -------------------------------------------------- P6: safe to delete ---- */

test('P6 PRESENCE: an untouched worktree is disposable; one holding work is not', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const { report } = await inspectFixture(fx);

  const empty = byId(report.safe, 'empty');
  assert.ok(empty?.safe, `'empty' should be disposable, reasons: ${empty?.reasons.join('; ')}`);
  assert.equal(empty.confidence, 'measured');

  for (const id of ['uniqueUncommitted', 'uniqueCommitted']) {
    const row = byId(report.safe, id);
    assert.equal(row.safe, false, `'${id}' holds work and must NOT be disposable`);
    assert.ok(row.reasons.length > 0, 'a refusal must say why');
  }
});

test('P6 FAIL-CLOSED: an unscannable workstream is "unknown", never "safe"', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const disc = await discover(fx.root);
  // Simulate the worktree directory having vanished underneath us.
  disc.workstreams = disc.workstreams.map((w) =>
    w.id === 'empty' ? { ...w, path: '/nonexistent/holt/definitely-not-here' } : w);

  const report = await analyze(await scan(disc, {}), {});
  const row = byId(report.safe, 'empty');

  assert.equal(row.safe, false, 'an unscannable workstream must never be reported safe');
  assert.equal(row.confidence, 'unknown');
});

/* ---------------------------------------- THE INSTRUMENT CHECK (merge-tree) ---- */

test('INSTRUMENT: content base already has is NOT reported as stranded', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const { report } = await inspectFixture(fx);
  const row = byId(report.safe, 'alreadyLanded');

  assert.ok(
    row?.safe,
    'alreadyLanded carries content base independently acquired; merge-tree must report ' +
    `nothing to lose. Got: ${row?.reasons.join('; ')}`,
  );
});

test('INSTRUMENT: strict-read-only mode DOES over-report the same case, and says so', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  // This is the point of the test: it proves the two instruments genuinely disagree, so the
  // documented caveat on the three-dot form describes a real defect rather than a hedge.
  const { report } = await inspectFixture(fx, { strictReadOnly: true });
  const row = byId(report.safe, 'alreadyLanded');

  assert.equal(row.safe, false,
    'the three-dot form is expected to over-report here — if it does not, this fixture no longer tests the distinction');
  assert.equal(row.confidence, 'approximate');

  const ws = report.unique.find((u) => u.id === 'alreadyLanded');
  assert.ok(ws.committedFiles > 0, 'three-dot should show a committed delta that merge-tree does not');
});

/* ---------------------------------------------------- P2: context digest ---- */

test('P2 PRESENCE: the digest names the sibling contesting the same file', async (t) => {
  const { fx, truth } = await standardFixture();
  t.after(() => fx.cleanup());

  const { scanned } = await inspectFixture(fx);
  const [a, b] = truth.collisionPair;
  const digest = contextDigest(scanned, a);

  assert.equal(digest.ok, true);
  const contested = digest.contestedFiles.find((c) => c.workstream === b);
  assert.ok(contested, `digest for ${a} should name ${b} as contesting a file`);
  assert.ok(contested.files.includes('config/registry.mjs'));
  assert.ok(digest.advice.some((s) => s.includes(b)), 'advice should mention the contending workstream');
});

test('P2: an unknown workstream id is an explicit error, not an empty digest', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const { scanned } = await inspectFixture(fx);
  const digest = contextDigest(scanned, 'no-such-workstream');

  assert.equal(digest.ok, false);
  assert.match(digest.error, /no scanned workstream/);
  assert.ok(Array.isArray(digest.known) && digest.known.length > 0, 'should list what IS known');
});

/* ---------------------------------------------- P2/family: provenance, not naming ---- */

/**
 * FAMILY COMES FROM GIT PROVENANCE — fork point (`git merge-base`) plus creation time — NOT
 * FROM NAMING. See assignFamilies/inferFamily in src/discover.mjs for the full design. Naming
 * lies in both directions, and this fixture proves both:
 *
 *   auth-1 / auth-2   NAME says one family (numeric-suffix pattern -> "auth" under the OLD,
 *                     deleted, name-only heuristic). HISTORY says two: auth-2 forks from a
 *                     commit that only exists because an unrelated commit landed on main AFTER
 *                     auth-1 was created, and the two were created four days apart. Real
 *                     dispatches do not straddle an intervening unrelated commit and a
 *                     four-day gap — this is two independent efforts that happened to pick
 *                     similar names.
 *
 *   alpha / zebra / quux   NAME says three singletons (no pattern matches any of them — the OLD
 *                     heuristic would never have grouped these). HISTORY says one: all three
 *                     fork from the identical commit and are created within seconds of each
 *                     other — exactly what a real fan-out dispatch looks like.
 *
 * Creation time is backdated with fs.utimes on the worktree's private `gitdir` file — the exact
 * file creationTimeMs() in discover.mjs reads as its PRIMARY signal (verified empirically there
 * to track worktree-creation to the second) — a plain filesystem call, not a git command, so the
 * fixture exercises production's real code path without an actual four-day wait.
 *
 * The downstream consequence (why any of this matters): a duplicate pair WITHIN the real
 * fan-out (alpha/zebra, sharing FANOUT_SHARED_SYMBOL) must classify as 'expected-fanout'; a
 * duplicate pair ACROSS the two unrelated efforts (auth-1/auth-2, sharing SHARED_TASK_SYMBOL)
 * must classify as 'cross-dispatch-waste' — the reverse of what the deleted name-only heuristic
 * would have said for both pairs.
 */
async function provenanceFixture() {
  const fx = await newRepo('provenance');

  await fx.worktree('auth-1');
  await fx.write('src/auth1_only.js', 'export function AUTH1_ONLY_SYMBOL() { return "one"; }\n', fx.wt('auth-1'));
  await fx.write('src/shared_task.js', 'export function SHARED_TASK_SYMBOL() { return 42; }\n', fx.wt('auth-1'));
  await fx.commit('auth-1 builds its own thing, and (independently) the shared task', fx.wt('auth-1'));
  await backdateWorktreeCreation(fx.wt('auth-1'), 4 * 24 * 60 * 60 * 1000);

  // A real, unrelated commit lands on main BETWEEN the two dispatches — auth-2 forks from a
  // commit auth-1's history never saw. A single fan-out never straddles an intervening commit.
  await fx.write('CHANGELOG.md', '## an unrelated release, days later\n');
  await fx.commit('an unrelated commit lands on main between the two independent efforts');

  await fx.worktree('auth-2');
  await fx.write('src/auth2_only.js', 'export function AUTH2_ONLY_SYMBOL() { return "two"; }\n', fx.wt('auth-2'));
  await fx.write('src/shared_task.js', 'export function SHARED_TASK_SYMBOL() { return 42; }\n', fx.wt('auth-2'));
  await fx.commit('auth-2 independently builds a different thing, and the identical shared task', fx.wt('auth-2'));
  // auth-2 keeps its real (current) creation time — four days after auth-1's backdated one.

  // Yet another unrelated commit, so the fan-out below forks from a THIRD commit — distinct
  // from both auth-1's and auth-2's — rather than accidentally sharing auth-2's fork point.
  await fx.write('NOTES.md', '## more unrelated history, before the real fan-out\n');
  await fx.commit('another unrelated commit precedes the actual fan-out dispatch');

  await fx.worktree('alpha');
  await fx.write('src/fanout_alpha.js', 'export function FANOUT_SHARED_SYMBOL() { return 7; }\n', fx.wt('alpha'));
  await fx.commit('alpha implements the fan-out task', fx.wt('alpha'));

  await fx.worktree('zebra');
  await fx.write('src/fanout_zebra.js', 'export function FANOUT_SHARED_SYMBOL() { return 7; }\n', fx.wt('zebra'));
  await fx.commit('zebra implements the identical fan-out task', fx.wt('zebra'));

  await fx.worktree('quux');
  await fx.write('src/fanout_quux.js', 'export function QUUX_ONLY_SYMBOL() { return 9; }\n', fx.wt('quux'));
  await fx.commit('quux takes a third, disjoint slice of the same fan-out', fx.wt('quux'));

  return fx;
}

test('FAMILY PROVENANCE, presence: a real fan-out (same fork point, created together) is grouped, despite three unrelated-looking names', async (t) => {
  const fx = await provenanceFixture();
  t.after(() => fx.cleanup());

  const { scanned } = await inspectFixture(fx);
  const alpha = scanned.workstreams.find((w) => w.id === 'alpha');
  const zebra = scanned.workstreams.find((w) => w.id === 'zebra');
  const quux = scanned.workstreams.find((w) => w.id === 'quux');

  assert.equal(alpha.familyRule, 'fork+creation-time', 'the fixture must have real provenance, not a name fallback');
  assert.equal(alpha.family, zebra.family,
    `alpha and zebra forked from the same commit within seconds of each other and must be one family, got ${alpha.family} / ${zebra.family}`);
  assert.equal(alpha.family, quux.family,
    `quux is part of the same fan-out and must share the family, got ${alpha.family} / ${quux.family}`);
});

test('FAMILY PROVENANCE, the lie naming tells: a numeric-suffix name pair forked from DIFFERENT commits, days apart, is NOT one family', async (t) => {
  const fx = await provenanceFixture();
  t.after(() => fx.cleanup());

  const { scanned } = await inspectFixture(fx);
  const auth1 = scanned.workstreams.find((w) => w.id === 'auth-1');
  const auth2 = scanned.workstreams.find((w) => w.id === 'auth-2');

  // ANTI-VACUITY: under the OLD (deleted) name-only heuristic, 'auth-1' and 'auth-2' matched the
  // numeric-suffix pattern and were BOTH forced into family 'auth' — the exact wrong answer this
  // test exists to catch. Confirm the naming pattern really would have matched, so a passing test
  // proves the fix rather than an accident of naming.
  assert.notEqual(auth1.id.match(/^(.*?)-\d+$/)?.[1], undefined, 'fixture invalid: auth-1 must match the numeric-suffix pattern');

  assert.equal(auth1.familyRule, 'fork+creation-time', 'the fixture must have real provenance, not a name fallback');
  assert.equal(auth2.familyRule, 'fork+creation-time', 'the fixture must have real provenance, not a name fallback');
  assert.notEqual(auth1.family, auth2.family,
    `different fork commits, four days apart: provenance must keep these separate, got ${auth1.family} / ${auth2.family}`);
});

test('FAMILY CONSEQUENCE: duplicate work inside the real fan-out is expected-fanout; across the two unrelated efforts is cross-dispatch-waste', async (t) => {
  const fx = await provenanceFixture();
  t.after(() => fx.cleanup());

  const { scanned, report } = await inspectFixture(fx);

  // BEFORE (the deleted name-only heuristic) would have gotten BOTH of these backwards:
  // auth-1/auth-2 named like a fan-out -> 'expected-fanout' (wrong: two unrelated efforts);
  // alpha/zebra shared no naming pattern -> 'cross-dispatch-waste' (wrong: one real fan-out).
  // AFTER (provenance) gets both right.
  const authDup = report.duplicates.find((d) => pairMatches(d, 'auth-1', 'auth-2'));
  assert.ok(authDup, 'auth-1/auth-2 share SHARED_TASK_SYMBOL and must be found as duplicate work');
  assert.equal(authDup.sameFamily, false, 'they forked from different commits four days apart');
  assert.equal(authDup.classification, 'cross-dispatch-waste',
    `two unrelated efforts duplicating work is waste, got ${JSON.stringify(authDup)}`);

  const fanoutDup = report.duplicates.find((d) => pairMatches(d, 'alpha', 'zebra'));
  assert.ok(fanoutDup, 'alpha/zebra share FANOUT_SHARED_SYMBOL and must be found as duplicate work');
  assert.equal(fanoutDup.sameFamily, true, 'they forked from the identical commit, created together');
  assert.equal(fanoutDup.classification, 'expected-fanout',
    `siblings from one dispatch duplicating work is expected, got ${JSON.stringify(fanoutDup)}`);

  // The context digest agrees: alpha is told about its real sibling zebra, and about quux (same
  // family, no shared content) — but NOT about auth-1/auth-2, which are a different family.
  const digest = contextDigest(scanned, 'alpha');
  assert.ok(digest.siblings.includes('zebra'), `alpha's siblings must include zebra: ${digest.siblings}`);
  assert.ok(digest.siblings.includes('quux'), `alpha's siblings must include quux: ${digest.siblings}`);
  assert.ok(!digest.siblings.includes('auth-1') && !digest.siblings.includes('auth-2'),
    `alpha's siblings must not include the unrelated auth pair: ${digest.siblings}`);
});

test('FAMILY BOUNDARY: a genuine fan-out staggered by 20 minutes stays ONE family', async (t) => {
  // THE REFUTATION FIXTURE, verbatim. Adversarial review built a real single dispatch — two
  // worktrees forked from the IDENTICAL commit, zero intervening commits — whose only oddity was
  // a 20-minute gap between the two `git worktree add` calls: a human reviewing between spawns,
  // a rate-limited API, CI provisioning in waves. The first provenance implementation's 5-minute
  // window split them, and the duplicate between them flipped from 'expected-fanout' to a
  // confidently wrong 'cross-dispatch-waste'. A window is a guess about orchestration speed;
  // this pins that ordinary staggering never pays for that guess.
  const fx = await newRepo('staggered-dispatch');
  t.after(() => fx.cleanup());

  // Deliberately UNSTEMMED names (no shared prefix, no numeric suffix): a stemmed pair would be
  // rescued by the corroboration step at ANY window, making this test vacuous about the window
  // itself — verified by running it against the refuted 5-minute constant and watching it stay
  // green until the names lost their stem. The stem path has its own test below; this one pins
  // the window alone.
  await fx.worktree('karl');
  await fx.write('src/karl.js', 'export function STAGGERED_SHARED() { return 3; }\n', fx.wt('karl'));
  await fx.commit('first half of the staggered dispatch', fx.wt('karl'));
  // 20 minutes older than mira — inside the widened window, far outside the refuted 5-minute one.
  await backdateWorktreeCreation(fx.wt('karl'), 20 * 60 * 1000);

  await fx.worktree('mira');
  await fx.write('src/mira.js', 'export function STAGGERED_SHARED() { return 3; }\n', fx.wt('mira'));
  await fx.commit('second half, twenty minutes later, same fork point', fx.wt('mira'));

  const { scanned, report } = await inspectFixture(fx);
  const one = scanned.workstreams.find((w) => w.id === 'karl');
  const two = scanned.workstreams.find((w) => w.id === 'mira');
  assert.equal(one.familyRule, 'fork+creation-time', 'must be a provenance answer, not a name fallback');
  assert.equal(one.family, two.family,
    `same fork point, 20-minute stagger: one dispatch, got ${one.family} / ${two.family}`);

  const dup = report.duplicates.find((d) => pairMatches(d, 'karl', 'mira'));
  assert.ok(dup, 'the pair shares STAGGERED_SHARED and must be found as duplicate work');
  assert.equal(dup.classification, 'expected-fanout',
    `a staggered dispatch duplicating its own work is expected, got ${JSON.stringify(dup)}`);
});

test('FAMILY BOUNDARY: a naming stem bridges time-clusters of the SAME fork point, and only the same fork point', async (t) => {
  // The corroboration step: when the timer says "two dispatches" but provenance already put both
  // on ONE fork commit and the names carry one fan-out stem (auth-1/auth-2), two independent
  // witnesses outvote the timer. The control matters more than the positive: the same stem must
  // bridge NOTHING across different fork points — otherwise this reintroduces name-derived
  // grouping through the back door, which is the exact heuristic provenance replaced.
  const fx = await newRepo('stem-bridge');
  t.after(() => fx.cleanup());

  await fx.worktree('auth-1');
  await fx.write('src/a1.js', 'export function STEM_A1() { return 1; }\n', fx.wt('auth-1'));
  await fx.commit('first, backdated past any window', fx.wt('auth-1'));
  await backdateWorktreeCreation(fx.wt('auth-1'), 3 * 60 * 60 * 1000); // 3h — outside even 60min

  await fx.worktree('auth-2');
  await fx.write('src/a2.js', 'export function STEM_A2() { return 2; }\n', fx.wt('auth-2'));
  await fx.commit('second, three hours later, SAME fork point, same stem', fx.wt('auth-2'));

  // Control: same stem, DIFFERENT fork point (an intervening commit separates them).
  await fx.write('WALL.md', 'an intervening commit — the next worktree forks from a different commit\n');
  await fx.commit('intervening commit on main');
  await fx.worktree('auth-3');
  await fx.write('src/a3.js', 'export function STEM_A3() { return 3; }\n', fx.wt('auth-3'));
  await fx.commit('same stem, different fork point — must NOT be bridged', fx.wt('auth-3'));

  const { scanned } = await inspectFixture(fx);
  const byId = Object.fromEntries(scanned.workstreams.map((w) => [w.id, w]));
  assert.equal(byId['auth-1'].family, byId['auth-2'].family,
    'same fork point + same stem: the stem bridges the 3-hour gap');
  assert.notEqual(byId['auth-2'].family, byId['auth-3'].family,
    'different fork points: the stem must bridge NOTHING — this is what keeps names from becoming the primary signal again');
});

test('FAMILY BOUNDARY: the primary worktree is never swept into a dispatch family', async (t) => {
  // Found live by adversarial review: the repo root's reflog-derived "creation time" fell inside
  // a dispatch's clustering window and the PRIMARY worktree — which was never dispatched and has
  // no dispatch-mates by definition — joined the family. The old naming heuristic could
  // essentially never produce this (roots are not named `agent-3`), so it was a regression
  // introduced by provenance, not a pre-existing miss.
  const fx = await newRepo('primary-excluded');
  t.after(() => fx.cleanup());

  await fx.worktree('agent-1');
  await fx.write('src/w1.js', 'export function PRIM_W1() { return 1; }\n', fx.wt('agent-1'));
  await fx.commit('dispatched work', fx.wt('agent-1'));
  await fx.worktree('agent-2');
  await fx.write('src/w2.js', 'export function PRIM_W2() { return 2; }\n', fx.wt('agent-2'));
  await fx.commit('more dispatched work', fx.wt('agent-2'));

  const { scanned } = await inspectFixture(fx, { includePrimary: true });
  const primary = scanned.workstreams.find((w) => w.isPrimary);
  const agents = scanned.workstreams.filter((w) => !w.isPrimary && w.id.startsWith('agent-'));
  assert.ok(primary, 'the fixture must scan the primary worktree or this test proves nothing');
  assert.equal(agents.length, 2, 'both dispatched worktrees must be present');
  assert.equal(primary.familyRule, 'primary-worktree', `got ${primary.familyRule}`);
  for (const a of agents) {
    assert.notEqual(primary.family, a.family,
      `the repository root is not a dispatch-mate of ${a.id}: ${primary.family}`);
  }
  assert.equal(agents[0].family, agents[1].family, 'the real dispatch still groups normally');
});

/* ------------------------------------------------------- P5: landing plan ---- */

test('P5: the plan drops disposables, collapses duplicates, and orders the rest', async (t) => {
  const { fx, truth } = await standardFixture();
  t.after(() => fx.cleanup());

  const { report } = await inspectFixture(fx);
  const plan = report.plan;

  const dropped = plan.drop.map((d) => d.id);
  assert.ok(dropped.includes('empty'), 'empty should be dropped');
  assert.ok(dropped.includes('alreadyLanded'), 'alreadyLanded should be dropped');

  const inPlan = new Set([...plan.order.map((o) => o.id), ...plan.collapse.map((c) => c.id), ...dropped]);
  for (const w of truth.allWorktrees) {
    assert.ok(inPlan.has(w), `'${w}' vanished from the plan — every workstream must be accounted for`);
  }

  assert.equal(
    plan.reviewReduction.dropped + plan.reviewReduction.collapsed + plan.reviewReduction.toReview,
    plan.reviewReduction.total,
    'the review-reduction arithmetic must balance',
  );
  assert.ok(plan.order.every((o, i) => i === 0 || plan.order[i - 1].entanglement <= o.entanglement),
    'order must be ascending by entanglement');
});

/* ------------------------------------------------------ negative control ---- */

test('NEGATIVE CONTROL: a quiet repo yields no findings of any kind', async (t) => {
  const fx = await emptyFixture();
  t.after(() => fx.cleanup());

  const { report } = await inspectFixture(fx);

  assert.equal(report.counts.scanned, 2, 'both quiet worktrees should still be scanned');
  assert.equal(report.collisions.length, 0, 'no collisions expected');
  assert.equal(report.duplicates.length, 0, 'no duplicates expected');
  assert.equal(report.counts.atRisk, 0, 'nothing at risk expected');
  assert.equal(report.counts.safeToDelete, 2, 'both should be disposable');
  assert.equal(report.plan.order.length, 0, 'nothing to land');
});

/* -------------------------------------------------------------- the graph ---- */

test('graph: every edge references nodes that exist', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const { report } = await inspectFixture(fx);
  const ids = new Set(report.graph.nodes.map((n) => n.id));

  assert.ok(report.graph.nodes.length > 0, 'graph should have nodes');
  for (const e of report.graph.edges) {
    assert.ok(ids.has(e.source), `edge source '${e.source}' is not a node`);
    assert.ok(ids.has(e.target), `edge target '${e.target}' is not a node`);
  }
  assert.ok(report.graph.edges.some((e) => e.type === 'collision'), 'expected a collision edge');
  assert.ok(report.graph.edges.some((e) => e.type === 'duplicate'), 'expected a duplicate edge');
});

test('HEADLINE CLAIM: a worktree whose only content is an untracked file with NO symbols is AT RISK', async (t) => {
  // The product's marquee anecdote is an agent deleting worktrees that "only contained untracked
  // files". Symbol extraction finds nothing in notes.md / .env / a CSV / an image, so a
  // symbol-only count reported "0 at risk" and `holt risk` printed "Nothing unique anywhere" for
  // exactly that case — while `gate` was refusing to call it safe. The report must never
  // contradict the guard.
  const fx = await newRepo('file-only-risk');
  t.after(() => fx.cleanup());

  const wt = await fx.worktree('notes-only');
  await fx.write('research.md', '# findings that exist nowhere else\n', wt);

  const { report } = await inspectFixture(fx);
  const u = report.unique.find((x) => x.id === 'notes-only' || x.id.endsWith('/notes-only'));
  assert.ok(u, 'the workstream must appear in the unique report');
  assert.ok(u.uncommittedOnlyCount > 0,
    `a symbol-less untracked file must still count as at-risk: ${JSON.stringify(u)}`);
  assert.equal(u.verdict, 'unique-work-uncommitted');

  // And the safety verdict must agree with the counter — both directions.
  const s = report.safe.find((x) => x.id === u.id);
  assert.equal(s.safe, false, 'and it must never be reported safe to delete');

  // The rendered report must not claim there is nothing unique.
  const { renderRisk } = await import('../../src/render.mjs');
  const text = renderRisk(report);
  assert.ok(!/Nothing unique anywhere/.test(text),
    'the human-readable report must not contradict the guard');
  assert.match(text, /notes-only/, 'and must name the workstream at risk');
});

test('SAFETY: a worktree carrying gitignored content is NEVER "provably nothing to lose"', async (t) => {
  // git does not track ignored files, so holt cannot prove anything about them — but deleting
  // the worktree destroys them anyway. A .env of live credentials was being reported disposable.
  const fx = await newRepo('ignored-secrets');
  t.after(() => fx.cleanup());
  await fx.write('.gitignore', '.env\nnode_modules/\n');
  await fx.commit('add gitignore');

  const wt = await fx.worktree('has-secrets');
  await fx.write('.env', 'STRIPE_SECRET=sk_live_realmoney\n', wt);

  const { report } = await inspectFixture(fx);
  const s = report.safe.find((x) => x.id === 'has-secrets' || x.id.endsWith('/has-secrets'));
  assert.ok(s, 'the workstream must be reported');
  assert.equal(s.safe, false, `a worktree holding a gitignored .env must not be called disposable: ${JSON.stringify(s)}`);
  assert.equal(s.confidence, 'unverifiable', 'and the confidence must say WHY it is not measured');
  assert.match(s.reasons.join(' '), /gitignored/, 'the reason must name the cause');
  assert.match(s.reasons.join(' '), /\.env/, 'and name the actual file, so the user can judge');
});

/**
 * MEASURED (bench50, 50-language corpus, `unique` question): 50 of 156 recall misses were
 * `wt-ignored` — a worktree whose ONLY content is a gitignored file, in every one of the 50
 * languages. `uniqueWork()` (`risk --json`'s `unique[]`, P0 "what would be lost") builds its file
 * count from `w.uncommitted` only, which NEVER includes the ignored layer — so the verdict came
 * back `nothing-unique` for a worktree the very next command, `safeToDelete`, correctly refuses to
 * call disposable (see the test directly above). Two commands disagreeing about whether the exact
 * same content is "nothing" or "unverifiable" is the specific failure `contentAtRisk()`'s doc
 * comment already names for gate vs rescue — this is the same disagreement, one layer over, in
 * the report that is supposed to say what is irreplaceable.
 */
test('P0 SAFETY: a worktree carrying ONLY gitignored content is reported as holding unique work', async (t) => {
  const fx = await newRepo('ignored-unique');
  t.after(() => fx.cleanup());
  await fx.write('.gitignore', 'secret/\n');
  await fx.commit('add gitignore');

  const wt = await fx.worktree('secret-keeper');
  await fx.write('secret/only.py', 'def secret_only_fn():\n    return 42\n', wt);

  const { report } = await inspectFixture(fx);
  const u = byId(report.unique, 'secret-keeper');
  assert.ok(u, 'secret-keeper missing from the unique-work report');
  assert.notEqual(u.verdict, 'nothing-unique',
    `a worktree whose only content is gitignored must not be reported as holding nothing unique: ${JSON.stringify(u)}`);
  assert.ok(u.uncommittedOnlyCount > 0,
    `gitignored-only content is invisible to git and must count as at-risk: ${JSON.stringify(u)}`);
});

test('SAFETY: recognisable build output does NOT block cleanup — the gate must stay usable', async (t) => {
  // The negative control. If ANY ignored file blocked deletion, every worktree with a dist/ or
  // node_modules/ would be unclearable and the command would be useless.
  const fx = await newRepo('ignored-build');
  t.after(() => fx.cleanup());
  await fx.write('.gitignore', 'node_modules/\ndist/\n');
  await fx.commit('add gitignore');

  const wt = await fx.worktree('just-build-output');
  await fx.write('node_modules/left-pad/index.js', 'module.exports=1\n', wt);
  await fx.write('dist/bundle.js', 'console.log(1)\n', wt);

  const { report } = await inspectFixture(fx);
  const s = report.safe.find((x) => x.id === 'just-build-output' || x.id.endsWith('/just-build-output'));
  assert.equal(s.safe, true, `build output alone must remain disposable: ${JSON.stringify(s)}`);
});

test('P1 UNCOMMITTED CONFLICT: a conflict in work nobody has committed is PROVEN, not missed', async (t) => {
  // THE DEFECT THIS PINS, and it was the flagship answer being wrong in the simplest case.
  // Collisions used to run `merge-tree` against the two committed HEADS, on the stated grounds
  // that "merge-tree cannot see uncommitted sides". Two worktrees editing the SAME LINE of the
  // same file, uncommitted, therefore produced: "No collisions. No two workstreams contest the
  // same content." A provable conflict, reported as no conflict.
  //
  // The premise was false. Every worktree shares one object database, so each side's working
  // state becomes a real commit and git's own merge machinery answers for real — which is what
  // `holt rescue` had been doing all along, 200 lines away in the same package.
  const fx = await newRepo('uncommitted-conflict');
  t.after(() => fx.cleanup());
  await fx.write('shared.txt', 'line1\nline2\nline3\nline4\nline5\n');
  await fx.commit('base');

  const a = await fx.worktree('side-a');
  const b = await fx.worktree('side-b');
  // Same line, opposite content, NEITHER committed.
  await fx.write('shared.txt', 'line1\nline2\nAAA\nline4\nline5\n', a);
  await fx.write('shared.txt', 'line1\nline2\nBBB\nline4\nline5\n', b);

  const { report } = await inspectFixture(fx);
  const hit = (report.collisionsAll ?? report.collisions).find((c) => pairMatches(c, 'side-a', 'side-b'));
  assert.ok(hit, 'two worktrees editing the same line must be related at all');
  assert.equal(hit.kind, 'proven',
    `this conflict is provable by merge-tree, so it must not be downgraded to a guess: ${JSON.stringify(hit)}`);
  assert.equal(hit.severity, 'high', 'a proven conflict is high severity');
  assert.equal(hit.mergeTreeConflict, true, 'and git itself must be the thing that said so');
});

test('P1 PRECISION: sharing a file is not a conflict when the edits actually merge', async (t) => {
  // The other half, and the one that keeps this useful. Proving conflicts is worthless if
  // everything that touches a shared file gets called a conflict — a near-complete graph of
  // findings is strictly worse than none, because the real ones become unreachable.
  const fx = await newRepo('uncommitted-clean');
  t.after(() => fx.cleanup());
  await fx.write('shared.txt', 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n');
  await fx.commit('base');

  const a = await fx.worktree('top');
  const b = await fx.worktree('bottom');
  // Same file, far-apart lines: git merges this cleanly.
  await fx.write('shared.txt', 'TOP\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n', a);
  await fx.write('shared.txt', 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nBOTTOM\n', b);

  const { report } = await inspectFixture(fx);
  const hit = (report.collisionsAll ?? report.collisions).find((c) => pairMatches(c, 'top', 'bottom'));
  if (hit) {
    assert.notEqual(hit.kind, 'proven',
      `these merge cleanly, so calling it proven is a false positive: ${JSON.stringify(hit)}`);
    assert.notEqual(hit.severity, 'high', 'a clean merge must never be high severity');
  }
  const visible = report.collisions.find((c) => pairMatches(c, 'top', 'bottom'));
  assert.equal(visible, undefined,
    'a pair git proves merges cleanly must not appear in the default collision report');
});

test('P1 PRECISION: a pair git PROVES merges cleanly is not a conflict, even when both added the same symbol', async (t) => {
  // THE PROOF MUST BEAT THE HEURISTIC IN BOTH DIRECTIONS.
  //
  // The severity ladder consulted `proven === false` only AFTER the shared-symbol heuristic, so
  // git answering "these merge cleanly" was discarded whenever the sides happened to share an
  // added symbol — and sharing an added symbol is the single most common way two agents touch one
  // registry. Measured on holt's own repository: all 22 pairs git had PROVEN clean were reported
  // as collisions anyway, 10 of them HIGH. The doc comment three lines above the ladder already
  // said "this is git's own answer, not a heuristic".
  //
  // The pre-existing precision test could not catch it: its fixture edits a symbol-free .txt, so
  // sharedSymbols is empty and it never reaches the branch that was wrong.
  const fx = await newRepo('clean-but-shared-symbol');
  t.after(() => fx.cleanup());
  const filler = Array.from({ length: 40 }, (_, i) => `export const pad${i} = ${i};`).join('\n');
  await fx.write('config/registry.mjs', `${filler}\n`);
  await fx.commit('a registry with room at both ends');

  const a = await fx.worktree('reg-top');
  const b = await fx.worktree('reg-bottom');
  // The registry-hotspot signature: both register the SAME handler, far enough apart in the file
  // that git merges them without a murmur. Uncommitted, which is where agents actually leave it.
  await fx.write('config/registry.mjs',
    `export function sharedHandler() { return 'top'; }\n${filler}\n`, fx.wt('reg-top'));
  await fx.write('config/registry.mjs',
    `${filler}\nexport function sharedHandler() { return 'bottom'; }\n`, fx.wt('reg-bottom'));

  const { report } = await inspectFixture(fx);
  const hit = (report.collisionsAll ?? report.collisions).find((c) => pairMatches(c, 'reg-top', 'reg-bottom'));
  assert.ok(hit, 'the pair must still be related — this test is about the VERDICT, not about hiding it');
  assert.ok(hit.sharedSymbols.length > 0,
    `the fixture is void unless both sides really added the same symbol: ${JSON.stringify(hit.sharedSymbols)}`);
  assert.equal(hit.mergeTreeConflict, false,
    `the fixture is void unless git really proved these merge cleanly: ${JSON.stringify(hit)}`);
  assert.notEqual(hit.severity, 'high',
    `git proved this merges cleanly, so HIGH is a false positive: ${JSON.stringify(hit)}`);
  assert.notEqual(hit.kind, 'predicted',
    `'predicted' claims merge-tree could not see the sides; it saw them and said clean: ${JSON.stringify(hit)}`);
  assert.match(hit.why, /merge/i, 'the reason must state what git actually proved');
});

test('P1 PRECISION: two worktrees on the IDENTICAL commit are a duplicate, never a collision', async (t) => {
  // Six pairs in holt's own repository sit on the same commit — the ordinary result of checking
  // one branch out twice to review it. Their trees are byte-identical, so merging them is a no-op
  // and no conflict is reachable in principle. holt reported them HIGH, quoting 247 shared
  // symbols: it had compared each side against BASE and found, correctly, that they added the
  // same things — which is the definition of a duplicate, and `duplicates` already says so.
  const fx = await newRepo('same-commit-twice');
  t.after(() => fx.cleanup());

  const a = await fx.worktree('twin-a');
  await fx.write('src/feature.js', 'export function twinFeature() { return 42; }\n', fx.wt('twin-a'));
  const sha = await fx.commit('the work, committed once', fx.wt('twin-a'));

  // The same commit, checked out a second time — no new work of any kind.
  const bPath = `${fx.wt('twin-a')}-mirror`;
  await fx.git(['worktree', 'add', '--detach', bPath, sha]);

  const { report } = await inspectFixture(fx);
  const all = report.collisionsAll ?? report.collisions;
  const hit = all.find((c) => pairMatches(c, 'twin-a', 'twin-a-mirror'));
  assert.equal(hit, undefined,
    `two checkouts of one commit cannot conflict; reporting it is a false positive: ${JSON.stringify(hit)}`);

  // ANTI-VACUITY: the pair must be visible to holt at all, or this asserts nothing. It is a
  // duplicate, and that is exactly what the duplicate layer is for.
  const dup = report.duplicates.find((d) => pairMatches(d, 'twin-a', 'twin-a-mirror'));
  assert.ok(dup, `the pair must still be REPORTED, as the duplicate it is: ${JSON.stringify(report.duplicates)}`);
});

test('P0 PRECISION: a bare generated entry is not "work found nowhere else"', async (t) => {
  // THE FORM GIT PRINTS DECIDED THE VERDICT. holt's GENERATED filter anchored every directory on
  // a trailing slash, so it matched `node_modules/react/index.js` and never the BARE entry
  // `node_modules`. Git prints the bare form whenever what it found is not a directory it can
  // descend into. The entry survived into the at-risk set and the worktree was declared to hold
  // the only copy of work: measured on holt's own repository, `holt gate` exited 1 (HOLDS UNIQUE
  // WORK) and `protect` locked the tree with the reason "holds work found nowhere else" — for a
  // 29-byte pointer at content that lives elsewhere and survives the deletion untouched.
  //
  // TWO WORKTREES, because the mechanism that produces the bare entry is PLATFORM-DEPENDENT and
  // the property is not:
  //   bare-entry — a plain file of that name. Produces `?? node_modules` on every platform, so
  //                the exact regression is pinned everywhere, including windows-latest.
  //   linked     — the real-world case: a symlink (POSIX) or junction (Windows). CI proved these
  //                differ — git descends into a Windows junction and `.gitignore`'s
  //                `node_modules/` then matches it, so nothing is reported at all. Both outcomes
  //                are correct; what must hold on every platform is holt's VERDICT, so that is
  //                what is asserted here while `bare-entry` above pins the git output shape.
  const fx = await newRepo('generated-bare-entry');
  t.after(() => fx.cleanup());
  await fx.write('.gitignore', 'node_modules/\n');
  await fx.commit('ignore dependencies the way every JS repo does');

  const realDeps = path.join(fx.root, 'node_modules');
  await fsp.mkdir(realDeps, { recursive: true });
  await fsp.writeFile(path.join(realDeps, 'index.js'), 'module.exports = 1;\n');

  const bare = await fx.worktree('bare-entry');
  await fsp.writeFile(path.join(bare, 'node_modules'), 'not a directory\n');

  const linked = await fx.worktree('linked');
  try {
    await fsp.symlink(realDeps, path.join(linked, 'node_modules'), 'junction');
  } catch {
    // A platform that refuses both symlinks and junctions still has the `bare-entry` worktree,
    // which is the one carrying the regression pin.
    await fsp.writeFile(path.join(linked, 'node_modules'), 'not a directory\n');
  }

  // FIXTURE VALIDITY, portable: git must really report the bare entry for the plain-file form.
  const porcelain = (await fx.git(['status', '--porcelain'], bare)).trim();
  assert.equal(porcelain, '?? node_modules',
    `the fixture is void unless git reports the BARE entry: ${JSON.stringify(porcelain)}`);

  const { report } = await inspectFixture(fx);
  for (const id of ['bare-entry', 'linked']) {
    const row = report.unique.find((u) => u.id === id);
    assert.ok(row, `the worktree '${id}' must still be scanned`);
    assert.deepEqual(row.pathsByLayer.untracked, [],
      `a dependency tree is not unique work (${id}): ${JSON.stringify(row.pathsByLayer)}`);
    assert.notEqual(row.verdict, 'unique-work-uncommitted',
      `nothing in '${id}' exists only there: ${JSON.stringify(row)}`);
    const safe = report.safe.find((s) => s.id === id);
    assert.equal(safe?.safe, true,
      `an empty worktree carrying only dependencies is disposable (${id}): ${JSON.stringify(safe)}`);
  }
});


test('P1 CORRECTNESS: a rename/rename conflict is FOUND, not reported as no collision', async (t) => {
  // THE WORST SHAPE OF WRONG: not noise, an active all-clear on a conflict git had already proven.
  //
  // `git diff --name-only` reports ONLY the destination when it detects a rename, so a worktree
  // that renamed shared.js -> alpha.js recorded touching only alpha.js. The collision prefilter
  // pairs workstreams by shared touched path, so against a sibling that renamed the same file to
  // beta.js there was no intersection, no pair, and merge-tree — the thing that proves conflicts —
  // was never run on them. git says `CONFLICT (rename/rename)`; holt printed "No collisions. No
  // two workstreams contest the same content."
  const fx = await newRepo('rename-rename');
  t.after(() => fx.cleanup());
  await fx.write('shared.js', 'export function shared() { return 1; }\n');
  await fx.commit('base');

  const a = await fx.worktree('ren-a');
  const b = await fx.worktree('ren-b');
  await fx.git(['mv', 'shared.js', 'alpha.js'], a);
  await fx.commit('rename to alpha', a);
  await fx.git(['mv', 'shared.js', 'beta.js'], b);
  await fx.commit('rename to beta', b);

  // FIXTURE VALIDITY: git itself must consider this a conflict, or the test proves nothing.
  const aHead = (await fx.git(['rev-parse', 'HEAD'], a)).trim();
  const bHead = (await fx.git(['rev-parse', 'HEAD'], b)).trim();
  // merge-tree exits 1 on conflict, which the fixture helper surfaces as a rejection.
  let gitSaysConflict = false;
  try {
    await fx.git(['merge-tree', '--write-tree', aHead, bHead]);
  } catch {
    gitSaysConflict = true;
  }
  assert.ok(gitSaysConflict, 'the fixture is void unless git itself proves a rename/rename conflict');

  const { report } = await inspectFixture(fx);
  const hit = (report.collisionsAll ?? report.collisions).find((c) => pairMatches(c, 'ren-a', 'ren-b'));
  assert.ok(hit, 'a proven rename/rename conflict must not be reported as no collision');
  assert.equal(hit.mergeTreeConflict, true, `and git must be what says so: ${JSON.stringify(hit)}`);
  // The ORIGINAL path is what the two sides contest, so it must be the evidence shown.
  assert.ok((hit.sharedFiles ?? []).includes('shared.js'),
    `the contested path is the original name: ${JSON.stringify(hit.sharedFiles)}`);
});

test('P1 PRECISION: a machine-local gitignored file cannot manufacture a proven conflict', async (t) => {
  // A PROOF THAT PROVES THE WRONG THING IS WORSE THAN NOISE, because it cannot be argued with —
  // it says git said so.
  //
  // worktreeSnapshot used `git add --all --force`, sweeping gitignored files into the commit that
  // merge-tree compares. Two developers each have their own `.env.local`; those are not shared
  // work and can never be reconciled. Reproduced: two worktrees editing ONE file at far-apart
  // lines — which git merges cleanly — reported `HIGH ... proven by merge-tree ... a real
  // conflict`, and the file it NAMED was the one that merges fine.
  //
  // Rescue still captures ignored content, deliberately: a capture that dropped someone's .env
  // would be the very loss this product exists to prevent. The two callers want opposite answers,
  // which is why the snapshot takes a flag rather than picking one globally.
  const fx = await newRepo('ignored-no-conflict');
  t.after(() => fx.cleanup());
  await fx.write('.gitignore', '.env.local\n');
  await fx.write('app.js', Array.from({ length: 40 }, (_, i) => `const pad${i} = ${i};`).join('\n') + '\n');
  await fx.commit('base');

  const a = await fx.worktree('env-a');
  const b = await fx.worktree('env-b');
  const pad = Array.from({ length: 40 }, (_, i) => `const pad${i} = ${i};`);
  await fx.write('app.js', ['const TOP = 1;', ...pad.slice(1)].join('\n') + '\n', a);
  await fx.write('app.js', [...pad.slice(0, 39), 'const BOTTOM = 1;'].join('\n') + '\n', b);
  await fx.write('.env.local', 'API_KEY=alice\n', a);
  await fx.write('.env.local', 'API_KEY=bob\n', b);

  const { report } = await inspectFixture(fx);
  const hit = (report.collisionsAll ?? report.collisions).find((c) => pairMatches(c, 'env-a', 'env-b'));
  if (hit) {
    assert.notEqual(hit.mergeTreeConflict, true,
      `far-apart edits merge cleanly; only each developer's own .env.local differs: ${JSON.stringify(hit)}`);
    assert.notEqual(hit.severity, 'high', `and it must not be HIGH: ${JSON.stringify(hit)}`);
  }

  // NEVER-WORSE: a REAL conflict in uncommitted work is still proven. Without this the fix above
  // could have been "stop snapshotting", which would blind the flagship capability entirely.
  const fx2 = await newRepo('ignored-real-conflict');
  t.after(() => fx2.cleanup());
  await fx2.write('s.txt', 'l1\nl2\nl3\nl4\nl5\n');
  await fx2.commit('base');
  const c = await fx2.worktree('con-a');
  const d = await fx2.worktree('con-b');
  await fx2.write('s.txt', 'l1\nl2\nAAA\nl4\nl5\n', c);
  await fx2.write('s.txt', 'l1\nl2\nBBB\nl4\nl5\n', d);
  const r2 = await inspectFixture(fx2);
  const real = (r2.report.collisionsAll ?? r2.report.collisions).find((x) => pairMatches(x, 'con-a', 'con-b'));
  assert.ok(real, 'two worktrees editing the same line must still collide');
  assert.equal(real.mergeTreeConflict, true, 'and it must still be PROVEN by git');
});


test('SECURITY: a repository cannot name a file into a ctags option', async (t) => {
  // A REPOSITORY CONTROLS ITS OWN FILENAMES, and holt hands them to ctags as bare positional
  // arguments. `-L` is a legal filename and, passed positionally, is parsed as ctags' own
  // "read the list of files to scan from this file" option — which consumes the NEXT argument and
  // opens whatever paths it finds INSIDE it. Reproduced against real ctags 6.2:
  //
  //     ctags ... -f - -L app.py
  //     ctags: Warning: cannot open input file "def ordinary(): pass"
  //
  // The CONTENTS of app.py became filenames. Aimed at a file listing a real path, ctags reads a
  // file outside the batch and its source line comes back in the `pattern` field of the JSON holt
  // parses. That is content disclosure driven by an attacker-chosen filename, in a tool whose
  // entire premise is being pointed at repositories written by agents and pull requests.
  //
  // `--` is NOT the fix and was tried: ctags rejects it outright with `Unknown option: --`.
  const { argSafePath } = await import('../../src/symbols.mjs');

  // Anything that could begin an option is neutralised...
  assert.equal(argSafePath('-L'), './-L');
  assert.equal(argSafePath('--options=/etc/passwd'), './--options=/etc/passwd');
  assert.equal(argSafePath('src/a.js'), './src/a.js');
  // ...and paths that are already unambiguous are left exactly alone, or the fix would break
  // every absolute path holt passes.
  assert.equal(argSafePath('/abs/x.js'), '/abs/x.js');
  assert.equal(argSafePath('./already.js'), './already.js');
  assert.equal(argSafePath('C:\\win\\x.js'), 'C:\\win\\x.js');

  // END TO END: a worktree containing a file named `-L` must scan without ctags ever being
  // steered by it, and holt must still extract the real symbols around it.
  const fx = await newRepo('ctags-argv');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('hostile-name');
  await fx.write('real.py', 'def REAL_SYMBOL_HERE():\n    pass\n', wt);
  try {
    await fx.write('-L', '/etc/hostname\n', wt);
  } catch {
    return t.skip('this platform will not create a file named -L');
  }

  const { report } = await inspectFixture(fx);
  const row = report.unique.find((u) => u.id === 'hostile-name');
  assert.ok(row, 'the worktree must still scan');

  // The scan still WORKS — a fix that broke extraction would be its own defect.
  const all = JSON.stringify(report);
  assert.match(all, /REAL_SYMBOL_HERE/, 'the genuine symbol beside the hostile filename must still be found');
  // And nothing from outside the worktree leaked into the report.
  assert.ok(!/\/etc\/hostname/.test(all), `a path from the hostile file must never reach the report: ${all.slice(0, 300)}`);
});
