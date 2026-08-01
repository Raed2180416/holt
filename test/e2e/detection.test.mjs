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
import { standardFixture, emptyFixture, newRepo } from '../fixtures.mjs';
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
