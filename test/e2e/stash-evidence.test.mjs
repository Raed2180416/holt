/**
 * holt — THE STASH AS A STORE OF WORK.
 *
 * THE REFUTATION THIS FILE PINS, in the refuter's own words:
 *
 *   "Nothing in src/scan.mjs, src/discover.mjs, src/analyze.mjs ever inspects refs/stash when
 *    computing safe/at-risk. The moment a stash sweep succeeds the working tree is clean,
 *    report.safe marks the workstream safe:true, and every subsequent stash rule evaluates
 *    holding.length === 0 and returns a flat silent allow. Live proof: staged-only content swept
 *    with git stash push -u; tree and index verified clean; the content's ONLY copy is the stash.
 *    Then: git stash pop -> allow. drop -> allow. clear -> allow."
 *
 * Measured before the fix, on this exact fixture: three allows, and the stash commit went
 * unreachable the instant `drop` ran.
 *
 * EVERY TEST HERE PROVES ITS OWN PREMISE WITH REAL GIT BEFORE ASSERTING A VERDICT — the file
 * verifies that the tree is clean, that the index is clean, that the file is off disk, that
 * `git stash list` really holds the entry, and (with `git fsck`) that the reachability story holt
 * tells about the stash commit is the one git itself tells. An assertion about a fixture nobody
 * checked is a claim about nothing.
 *
 * AND THE NEVER-WORSE HALF IS ASSERTED IN THE SAME BREATH, because the failure mode of a fix like
 * this is a guard that refuses every `drop` forever and gets switched off. An entry whose content
 * is reachable from a ref holds nothing unique, and dropping it must go back to a silent allow.
 */

import { execFile } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { newRepo, standardFixture } from '../fixtures.mjs';
import { assessCommand, cachedReport } from '../../src/agent.mjs';
import { stashState, describeStash, MAX_ENTRIES } from '../../src/stash.mjs';
import { renderRisk } from '../../src/render.mjs';

/** Real git, for establishing premises. Tests must never assume what the command does. */
const gitIn = (args, cwd) => new Promise((res) => {
  execFile('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'holt test', GIT_AUTHOR_EMAIL: 'test@holt.invalid',
      GIT_COMMITTER_NAME: 'holt test', GIT_COMMITTER_EMAIL: 'test@holt.invalid',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', LC_ALL: 'C',
    },
  }, (e, so, se) => res({ code: e?.code ?? 0, out: String(so ?? ''), err: String(se ?? '') }));
});

/** The word that must appear in the stash and nowhere else. */
const ONLY_HERE = 'RESCUE_ME_ONLY_IN_THE_STASH';

/**
 * Which commits reachable from a REAL ref introduce this content?
 *
 * `--all` cannot be used, and the reason is the whole subject of this file: `--all` INCLUDES
 * refs/stash, so it reports the stash's own commit and answers "yes, a ref holds it" about
 * content whose only holder is the thing about to be destroyed. Written with `--all` first, this
 * helper asserted its premise successfully against a fixture where the premise was false.
 */
const inReachableHistory = async (cwd) =>
  (await gitIn(['log', '--exclude=refs/stash', '--all', '-S', ONLY_HERE, '--format=%H'], cwd)).out.trim();

/**
 * THE REFUTER'S EXACT FIXTURE: staged-only content, swept with `git stash push -u`, with every
 * part of the premise verified rather than assumed.
 */
async function sweptFixture(t) {
  const fx = await newRepo('stash-swept');
  t.after(() => fx.cleanup());

  await fx.write('src/rescue_me.js', `export function ${ONLY_HERE}() { return "one copy"; }\n`);
  await gitIn(['add', 'src/rescue_me.js'], fx.root);

  const sweep = await gitIn(['stash', 'push', '-u', '-m', 'wip: the only copy'], fx.root);
  assert.equal(sweep.code, 0, `premise: the sweep must succeed: ${sweep.err}`);

  const st = await gitIn(['status', '--porcelain=v1', '--untracked-files=all'], fx.root);
  assert.equal(st.out, '', `premise: the working tree must be byte-clean after the sweep: ${JSON.stringify(st)}`);
  const idx = await gitIn(['diff', '--cached', '--name-only'], fx.root);
  assert.equal(idx.out, '', `premise: the index must be clean too: ${JSON.stringify(idx)}`);
  assert.equal(
    await fs.stat(path.join(fx.root, 'src/rescue_me.js')).then(() => true, () => false),
    false, 'premise: the file must be off disk — the stash is its only copy',
  );
  assert.match((await gitIn(['stash', 'list'], fx.root)).out, /stash@\{0\}/,
    'premise: the entry must exist');

  // AND THE CONTENT REALLY IS NOWHERE ELSE: grep every commit reachable from every ref.
  const inHistory = await gitIn(['grep', '-a', ONLY_HERE, '--', '.'], fx.root);
  assert.notEqual(inHistory.code, 0, 'premise: the content must not be in the working tree');
  assert.equal(await inReachableHistory(fx.root), '',
    'premise: no commit reachable from a real ref may hold this content');

  return fx;
}

/* ------------------------------------------------- THE REFUTATION ITSELF ---- */

test('REFUTATION: drop/clear DENY and pop ASKS when the stash holds the only copy', async (t) => {
  const fx = await sweptFixture(t);

  for (const cmd of ['git stash drop', 'git stash clear', 'git stash drop stash@{0}']) {
    const v = await assessCommand(cmd, fx.root);
    assert.equal(v.decision, 'deny',
      `${cmd} destroys the only copy of real content and must be DENIED: ${JSON.stringify(v)}`);
    assert.match(v.reason, /stash@\{0\}/, `it must NAME the entry it would destroy: ${v.reason}`);
    assert.match(v.reason, /src\/rescue_me\.js/,
      `and sample the content that dies with it: ${v.reason}`);
    assert.match(v.reason, /git stash apply/,
      `and name the way to make this safe: ${v.reason}`);
    assert.match(v.reason, /holt rescue/, `and holt's own escape hatch: ${v.reason}`);
  }

  const pop = await assessCommand('git stash pop', fx.root);
  assert.equal(pop.decision, 'ask',
    `pop is the RECOVERY action — it must ask, never block the only way back: ${JSON.stringify(pop)}`);
  assert.match(pop.reason, /stash@\{0\}/, `naming the entry: ${pop.reason}`);
  assert.match(pop.reason, /git stash apply/, `and the entry-preserving equivalent: ${pop.reason}`);
  assert.match(pop.reason, /survives only if|only if the apply succeeds|applying it succeeds/i,
    `pop's specific risk is that the entry is dropped whether or not the apply worked: ${pop.reason}`);
});

test('REFUTATION: `git fsck` agrees with holt about what dropping the entry makes unreachable', async (t) => {
  const fx = await sweptFixture(t);

  // holt's claim, and the object it rests on.
  const state = await stashState(fx.root);
  assert.equal(state.total, 1, `holt must see exactly one entry: ${JSON.stringify(state)}`);
  assert.equal(state.atRisk.length, 1, 'and must call it at risk');
  assert.equal(state.checked, true, 'having actually completed the check');
  const oid = state.entries[0].oid;
  const blob = state.entries[0].unique[0].sha;

  // GIT'S OWN STORY, BEFORE: refs/stash names the commit, so nothing is unreachable.
  const before = await gitIn(['fsck', '--unreachable', '--no-reflogs'], fx.root);
  assert.doesNotMatch(before.out, new RegExp(oid),
    `premise: while refs/stash exists the entry is reachable: ${JSON.stringify(before)}`);
  assert.doesNotMatch(before.out, new RegExp(blob),
    'premise: and so is the blob it carries');

  // …AND AFTER. `drop` is the act holt refuses; run it for real and watch git confirm the loss.
  const dropped = await gitIn(['stash', 'drop'], fx.root);
  assert.equal(dropped.code, 0, `the real drop must succeed: ${dropped.err}`);
  const after = await gitIn(['fsck', '--unreachable', '--no-reflogs'], fx.root);
  assert.match(after.out, new RegExp(`unreachable commit ${oid}`),
    `git itself must now call the stash commit unreachable — this is the loss holt named: ${JSON.stringify(after)}`);

  // And the content is gone from every ref, which is what "no ref holds this" meant.
  assert.equal(await inReachableHistory(fx.root), '', 'the content is reachable from no ref at all');
});

test('NEVER-WORSE: `git stash apply` + commit RELAXES the same verbs to a silent allow', async (t) => {
  const fx = await sweptFixture(t);

  // Before: denied, because the stash is the only copy.
  assert.equal((await assessCommand('git stash drop', fx.root)).decision, 'deny',
    'premise: it is denied while the stash is the only copy');

  // Do the right thing — exactly what the refusal told the user to do.
  const applied = await gitIn(['stash', 'apply'], fx.root);
  assert.equal(applied.code, 0, `apply must succeed: ${applied.err}`);
  await gitIn(['add', '-A'], fx.root);
  const committed = await gitIn(['commit', '-m', 'rescued the stashed work', '--no-verify'], fx.root);
  assert.equal(committed.code, 0, `commit must succeed: ${committed.err}`);

  // PREMISE, PROVEN: the content is now reachable from a ref.
  assert.notEqual(await inReachableHistory(fx.root), '', 'premise: a commit now holds the content');
  assert.match((await gitIn(['stash', 'list'], fx.root)).out, /stash@\{0\}/,
    'premise: and the entry is still there — apply does not drop it');

  // NOTHING ABOUT THE STASH COMMIT CHANGED. Only the content's reachability did — and that is the
  // whole difference between a guard that relaxes and one that nags.
  for (const cmd of ['git stash drop', 'git stash clear', 'git stash pop']) {
    const v = await assessCommand(cmd, fx.root);
    assert.equal(v.decision, 'allow',
      `${cmd} now destroys nothing unique and must be a SILENT allow: ${JSON.stringify(v)}`);
    assert.equal(v.reason, null, `with no message at all: ${JSON.stringify(v)}`);
  }
});

test('NEVER-WORSE: an empty stash makes every stash verb a silent allow', async (t) => {
  const fx = await newRepo('stash-empty');
  t.after(() => fx.cleanup());
  assert.equal((await gitIn(['stash', 'list'], fx.root)).out, '', 'premise: no entries');

  for (const cmd of ['git stash drop', 'git stash clear', 'git stash pop', 'git stash drop stash@{7}']) {
    const v = await assessCommand(cmd, fx.root);
    assert.equal(v.decision, 'allow',
      `${cmd} against an empty stash cannot lose anything: ${JSON.stringify(v)}`);
  }
});

test('PRECISION: a drop is judged on the entry IT destroys, not on the riskiest entry present', async (t) => {
  // THE DISCRIMINATING ARRANGEMENT, deliberately the awkward way round: the DANGEROUS entry is
  // the OLD one and the harmless entry is the one a bare `drop`/`pop` actually takes. Built the
  // other way round, every wrong implementation — "weigh the whole stash", "weigh stash@{0}",
  // "weigh whichever is worst" — passes. Here only the correct one does.
  const fx = await newRepo('stash-selector');
  t.after(() => fx.cleanup());

  // ---- the OLD entry (ends up stash@{1}): the only copy of real content --------------------
  await fx.write('src/only.js', `export function ${ONLY_HERE}() {}\n`);
  await gitIn(['add', '-A'], fx.root);
  assert.equal((await gitIn(['stash', 'push', '-u', '-m', 'unique-content'], fx.root)).code, 0, 'setup');

  // ---- the NEW entry (stash@{0}): content a commit already holds ---------------------------
  await fx.write('src/shared.js', 'export function SHARED_AND_COMMITTED() { return 1; }\n');
  await gitIn(['add', '-A'], fx.root);
  await gitIn(['commit', '-m', 'version one', '--no-verify'], fx.root);
  await fx.write('src/shared.js', 'export function SHARED_AND_COMMITTED() { return 2; }\n');
  await gitIn(['add', '-A'], fx.root);
  await gitIn(['commit', '-m', 'version two', '--no-verify'], fx.root);
  // Put version ONE back in the working tree. It is a real uncommitted modification, and its
  // content is reachable from HEAD~1 — so stashing it queues an entry that holds nothing unique.
  await gitIn(['checkout', 'HEAD~1', '--', 'src/shared.js'], fx.root);
  assert.equal((await gitIn(['stash', 'push', '-m', 'reachable-content'], fx.root)).code, 0, 'setup');

  const state = await stashState(fx.root);
  assert.equal(state.total, 2,
    `premise: two entries: ${JSON.stringify(state.entries.map((e) => e.selector))}`);
  assert.equal(state.entries[0].uniqueCount, 0,
    `premise: stash@{0}'s content IS reachable from a ref: ${JSON.stringify(state.entries[0])}`);
  assert.ok(state.entries[1].uniqueCount > 0,
    `premise: stash@{1} holds the only copy: ${JSON.stringify(state.entries[1])}`);

  // A bare drop/pop takes stash@{0} — which loses nothing. Refusing it because a DIFFERENT entry
  // is precious is a refusal about work the command cannot touch.
  for (const cmd of ['git stash drop', 'git stash pop', 'git stash drop stash@{0}']) {
    const v = await assessCommand(cmd, fx.root);
    assert.equal(v.decision, 'allow',
      `${cmd} destroys stash@{0}, which holds nothing unique: ${JSON.stringify(v)}`);
  }

  // Naming the precious one is the act that loses work.
  const named = await assessCommand('git stash drop stash@{1}', fx.root);
  assert.equal(named.decision, 'deny', `dropping the only copy must be denied: ${JSON.stringify(named)}`);
  assert.match(named.reason, /stash@\{1\}/, `naming the right entry: ${named.reason}`);
  assert.doesNotMatch(named.reason, /stash@\{0\}/,
    `and not the innocent one: ${named.reason}`);

  // `clear` takes them ALL, so one at-risk entry anywhere is enough.
  const cleared = await assessCommand('git stash clear', fx.root);
  assert.equal(cleared.decision, 'deny',
    `clear destroys every entry, so it is judged on every entry: ${JSON.stringify(cleared)}`);
  assert.match(cleared.reason, /stash@\{1\}/, `naming the one that matters: ${cleared.reason}`);
});

/* --------------------------------------- THE SWEEP MENTIONS WHAT IS QUEUED ---- */

test('MENTION: a bare `git stash` names the entries already queued, so a pile is not forgotten', async (t) => {
  const fx = await newRepo('stash-mention');
  t.after(() => fx.cleanup());

  // An older entry holding the only copy of something…
  await fx.write('src/old_work.js', `export function ${ONLY_HERE}() {}\n`);
  await gitIn(['add', '-A'], fx.root);
  assert.equal((await gitIn(['stash', 'push', '-u', '-m', 'older work'], fx.root)).code, 0, 'setup');

  // …and a fresh tracked modification about to be swept on top of it.
  await fx.write('src/base.js', 'export function baseline() { return 99; }\n');

  const v = await assessCommand('git stash', fx.root);
  assert.equal(v.decision, 'ask', `a real sweep asks: ${JSON.stringify(v)}`);
  assert.match(v.reason, /src\/base\.js/, `naming what it sweeps: ${v.reason}`);
  assert.match(v.reason, /stash@\{0\}/,
    `and naming the entry ALREADY queued — forgetting a pile is how the stash loses work `
    + `without anyone typing drop: ${v.reason}`);
  assert.match(v.reason, /src\/old_work\.js/, `with a sample of what that entry holds: ${v.reason}`);
});

/* ------------------------------------------------ CLOSING THE REPORT LOOP ---- */

test('REPORT: a stash holding the only copy is a repository-level at-risk row, not silence', async (t) => {
  const fx = await sweptFixture(t);

  const { report } = await cachedReport(fx.root, { includePrimary: true });

  // The workstream really is clean — that is the whole trap, and it stays true.
  assert.equal(report.counts.atRisk, 0,
    'the worktree genuinely holds nothing: this is the state that made holt say "safe"');

  // …and the repository is NOT therefore free of unrecoverable work.
  assert.ok(report.stash, 'the report must carry a stash section');
  assert.equal(report.stash.total, 1, `one entry: ${JSON.stringify(report.stash)}`);
  assert.equal(report.stash.atRisk.length, 1, 'holding content no ref holds');

  const rendered = renderRisk(report);
  assert.match(rendered, /stash@\{0\}/, `\`holt risk\` must show the entry: ${rendered}`);
  assert.match(rendered, /src\/rescue_me\.js/, `and what it holds: ${rendered}`);
  // A REPOSITORY-LEVEL LINE, NOT A FAKE WORKSTREAM. Inventing a workstream row would put a
  // non-existent id into every downstream consumer (gate, rescue, landing plan, the graph).
  assert.equal(report.unique.some((u) => /stash/i.test(u.id)), false,
    'the stash must never be smuggled in as a workstream');
  assert.equal(report.safe.some((s) => /stash/i.test(s.id)), false, 'nor into the safe list');
});

test('REPORT: a repository with no stash says nothing about one', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());
  assert.equal((await gitIn(['stash', 'list'], fx.root)).out, '', 'premise: no entries');

  const { report } = await cachedReport(fx.root, { includePrimary: true });
  assert.equal(report.stash.total, 0, `no entries: ${JSON.stringify(report.stash)}`);
  assert.equal(report.stash.checked, true, 'and holt looked, rather than failing to');
  assert.doesNotMatch(renderRisk(report), /STASH/,
    'so `holt risk` must not print a stash section at all');
});

test('REPORT: the cache notices a stash appearing and disappearing', async (t) => {
  // The report cache is keyed on a fingerprint of the worktree list plus every worktree's status.
  // A `git stash drop` changes NEITHER — so without refs/stash in the fingerprint the warning
  // would outlive the entry, and holt would keep naming a stash that no longer exists.
  const fx = await newRepo('stash-cache');
  t.after(() => fx.cleanup());

  const before = await cachedReport(fx.root, { includePrimary: true });
  assert.equal(before.report.stash.total, 0, 'premise: nothing queued yet');

  await fx.write('src/only.js', `export function ${ONLY_HERE}() {}\n`);
  await gitIn(['add', '-A'], fx.root);
  assert.equal((await gitIn(['stash', 'push', '-u'], fx.root)).code, 0, 'setup');
  const during = await cachedReport(fx.root, { includePrimary: true });
  assert.equal(during.report.stash.total, 1, 'the appearing entry must invalidate the cache');

  assert.equal((await gitIn(['stash', 'drop'], fx.root)).code, 0, 'setup');
  const after = await cachedReport(fx.root, { includePrimary: true });
  assert.equal(after.report.stash.total, 0,
    'and so must its disappearance — a warning about a dropped entry is a false alarm');
});

test('MCP: the channel agents actually read does not stay silent about the stash', async (t) => {
  // holt_status describes itself as "Start here". In the swept state it reports atRisk: 0 and
  // disposable: N — every number true about worktrees, and together an all-clear about a
  // repository whose only copy of real work is a stash commit. This product exists to prevent
  // AI-agent work loss, so the MCP surface is the one that must not go quiet.
  const fx = await sweptFixture(t);
  const { __test } = await import('../../src/mcp/server.mjs');

  __test.clearCache();
  const status = await __test.handle('holt_status', { repo: fx.root });
  assert.equal(status.atRisk, 0, 'premise: no WORKSTREAM is at risk — that is the whole trap');
  assert.equal(status.stashAtRisk, 1, `and the stash must be reported anyway: ${JSON.stringify(status)}`);

  __test.clearCache();
  const risk = await __test.handle('holt_at_risk', { repo: fx.root });
  assert.ok(risk.stash, `holt_at_risk must carry the stash: ${JSON.stringify(risk)}`);
  assert.equal(risk.stash.total, 1);
  assert.equal(risk.stash.entries[0].selector, 'stash@{0}');
  assert.equal(risk.stash.entries[0].sample[0].path, 'src/rescue_me.js');
  assert.match(risk.stash.note, /git stash drop/, 'and name the verb that destroys it');
  // NEVER A SYNTHETIC WORKSTREAM: an agent handed one would try to check, land or delete it.
  assert.equal(risk.workstreams.some((w) => /stash/i.test(w.id ?? '')), false,
    'the stash must not appear as a workstream row');
});

test('MCP: a repository with no stash gets no stash keys at all', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());
  const { __test } = await import('../../src/mcp/server.mjs');

  __test.clearCache();
  const status = await __test.handle('holt_status', { repo: fx.root });
  assert.equal(status.stashAtRisk, undefined, 'no stash, no key — schemas are the token cost');
  __test.clearCache();
  const risk = await __test.handle('holt_at_risk', { repo: fx.root });
  assert.equal(risk.stash, undefined, 'same');
});

/* ----------------------------------------------------------- EFFICIENCY ---- */

test('EFFICIENCY: the hot path pays nothing, and a stash verb pays no full scan', async (t) => {
  // TWO SEPARATE CLAIMS, and the honest version of each matters.
  //
  // (1) A command holt resolves WITHOUT a repository scan must not touch refs/stash at all. The
  //     guard runs before every agent tool call, and `rm -rf dist` can never need stash evidence.
  //
  // (2) A stash verb must not trigger a full repository analysis. Its evidence is the reflog; the
  //     scan's expensive instrument (`merge-tree`, which is what makes a cold scan cost seconds)
  //     has nothing to say about a stash entry.
  //
  // What is NOT claimed: that a command which already pays for a full scan avoids the stash. It
  // does not, and it must not — the report now describes the stash, so the report's cache key has
  // to move when the stash moves, or holt would keep naming an entry that was already rescued.
  // One reflog read beside a repository scan is not a hot-path cost; asserting otherwise would be
  // pinning a property this design deliberately does not have.
  const fx = await newRepo('stash-cost');
  t.after(() => fx.cleanup());
  await fx.write('src/only.js', `export function ${ONLY_HERE}() {}\n`);
  await gitIn(['add', '-A'], fx.root);
  assert.equal((await gitIn(['stash', 'push', '-u'], fx.root)).code, 0, 'setup');

  const trace = path.join(os.tmpdir(), `holt-stash-trace-${process.pid}-${Date.now()}`);
  const runWithTrace = async (cmd) => {
    await fs.rm(trace, { force: true });
    const saved = process.env.GIT_TRACE;
    process.env.GIT_TRACE = trace;
    try { await assessCommand(cmd, fx.root); } finally {
      if (saved === undefined) delete process.env.GIT_TRACE; else process.env.GIT_TRACE = saved;
    }
    const log = await fs.readFile(trace, 'utf8').catch(() => '');
    await fs.rm(trace, { force: true });
    return log;
  };

  const stashVerb = await runWithTrace('git stash drop');
  assert.match(stashVerb, /refs\/stash/,
    'premise: a stash verb DOES read refs/stash — otherwise this test proves nothing');
  assert.doesNotMatch(stashVerb, /merge-tree/,
    'a stash verb is answered from the reflog and must not pay for a repository scan');

  for (const cmd of ['rm -rf dist', 'npm test', 'ls -la']) {
    const log = await runWithTrace(cmd);
    assert.doesNotMatch(log, /refs\/stash/,
      `${cmd} resolves without a scan and must never pay for a stash read`);
  }
});

/* ----------------------------------------------------- MAX_ENTRIES loud break ---- */
//
// holt caps stash scanning at MAX_ENTRIES (25). If a repo has more, holt stops scanning —
// and entries beyond the cap might hold the only copy of real work. Silently stopping is the
// exact "silence that loses work" this module exists to end. The `truncated` flag must be
// surfaced so the guard and the brief can warn.

test('STASH: more than MAX_ENTRIES entries → truncated flag is set and describeStash warns', async (t) => {
  const fx = await newRepo('stash-truncated');
  t.after(() => fx.cleanup());

  // Create MAX_ENTRIES + 5 stash entries, each holding a unique untracked file.
  for (let i = 0; i < MAX_ENTRIES + 5; i++) {
    await fs.writeFile(path.join(fx.root, `file-${i}.txt`), `unique content ${i}`);
    const r = await gitIn(['stash', 'push', '-u', '-m', `entry-${i}`], fx.root);
    assert.equal(r.code, 0, `stash push ${i} failed: ${r.err}`);
  }

  const state = await stashState(fx.root);
  assert.equal(state.truncated, true, 'truncated flag must be set when there are more than MAX_ENTRIES entries');
  assert.equal(state.total, MAX_ENTRIES, `total must be exactly MAX_ENTRIES (${MAX_ENTRIES}), got ${state.total}`);

  // describeStash must include a warning about the truncation
  const desc = describeStash(state);
  assert.match(desc, /scanned only the first.*stash entries/i, 'describeStash must warn about truncated entries');
  assert.match(desc, /review.*manually/i, 'describeStash must tell the user to review the rest manually');
});

test('STASH: fewer than MAX_ENTRIES entries → no truncation, no warning', async (t) => {
  const fx = await newRepo('stash-not-truncated');
  t.after(() => fx.cleanup());

  for (let i = 0; i < 3; i++) {
    await fs.writeFile(path.join(fx.root, `file-${i}.txt`), `unique content ${i}`);
    const r = await gitIn(['stash', 'push', '-u', '-m', `entry-${i}`], fx.root);
    assert.equal(r.code, 0, `stash push ${i} failed: ${r.err}`);
  }

  const state = await stashState(fx.root);
  assert.equal(state.truncated, false, 'truncated flag must not be set when under MAX_ENTRIES');
  assert.equal(state.total, 3);

  const desc = describeStash(state);
  assert.doesNotMatch(desc, /more stash entries/i, 'no truncation warning when under the cap');
});
