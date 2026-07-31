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
