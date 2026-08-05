/**
 * holt — the audit trail as a COMPLIANCE ARTEFACT, end to end, against real git repositories.
 *
 * The unit suites prove the primitives. This one proves the product claim, and the claim is
 * narrow enough to attack directly: **any edit or deletion of history is detectable, and the
 * verifier names the entry that broke.** So the shape of nearly every test here is: take a
 * journal holt actually wrote, tamper with it the way a person would, and assert holt says
 * exactly what happened and where.
 *
 * The tamper cases are the five that exhaust the space — EDIT one record, DELETE one from the
 * middle, TRUNCATE the tail, INSERT a fabricated record, REORDER two. Truncation is the one a
 * hash chain alone cannot catch (the surviving prefix is a perfectly valid chain), which is the
 * entire reason the C2SP checkpoint exists; it gets its own test and its own honest failure code.
 *
 * And the free/paid line is tested as a line: verification, proofs and one-shot export must work
 * with NO licence, and the sink and fleet audit must refuse without one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { newRepo } from '../fixtures.mjs';
import {
  appendEvent, readJournal, readJournalRaw, readVerifiedJournal, verifyJournal, proveEntry,
  journalPaths, withLock, GENESIS, JOURNALLED_ACTIONS, HOLT_PUBLIC_NAMESPACE,
} from '../../src/journal.mjs';
import { protect, unprotect } from '../../src/actions.mjs';
import { summarizeJournal } from '../../src/roi.mjs';
import { parseCheckpoint, verifyNote, formatCheckpoint, merkleRoot, entryLeaf } from '../../src/attest.mjs';
import { exportJournal } from '../../src/siem.mjs';
import { sinkExport, EntitlementError } from '../../src/team/audit-sink.mjs';
import { fleetAudit, journalEvidenceState } from '../../src/team/fleet.mjs';

const CLI = fileURLToPath(new URL('../../bin/holt.mjs', import.meta.url));

function sh(cmd, args, cwd, env = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      cwd, timeout: 120_000, maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env, ...env,
        GIT_AUTHOR_NAME: 'holt test', GIT_AUTHOR_EMAIL: 't@holt.invalid',
        GIT_COMMITTER_NAME: 'holt test', GIT_COMMITTER_EMAIL: 't@holt.invalid',
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', LC_ALL: 'C', NO_COLOR: '1',
      },
    }, (err, stdout, stderr) => resolve({
      code: err ? (err.code ?? -1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''),
    }));
  });
}
const holt = (args, cwd, env) => sh(process.execPath, [CLI, ...args], cwd, env);

/** A repo with N chained journal entries holt itself wrote. */
async function repoWithJournal(n = 5, label = 'audit') {
  const fx = await newRepo(label);
  for (let i = 0; i < n; i++) {
    const r = await appendEvent(fx.root, { action: i === 2 ? 'unprotect' : 'protect', id: `wt-${i}`, path: `/x/wt-${i}` });
    assert.equal(r.ok, true, `append ${i} failed: ${r.error}`);
  }
  return fx;
}

const readLines = async (p) => (await fs.readFile(p, 'utf8')).split('\n').filter(Boolean);
const writeLines = (p, lines) => fs.writeFile(p, `${lines.join('\n')}\n`, 'utf8');

/* ==================================================== the chain itself ==== */

test('every entry is chained and attributed, and the whole log verifies', async () => {
  const fx = await repoWithJournal(6);
  const events = await readJournal(fx.root);
  assert.equal(events.length, 6);

  for (const [i, e] of events.entries()) {
    assert.equal(e.seq, i, 'seq must be the position in the log');
    assert.ok(e.actor, `entry ${i} has no actor — a trail without WHO is what this replaces`);
    for (const f of ['user', 'host', 'agent', 'session']) {
      assert.equal(typeof e.actor[f], 'string', `actor.${f} missing`);
      assert.ok(e.actor[f].length > 0);
    }
    assert.equal(e.prev, i === 0 ? GENESIS : entryLeaf(events[i - 1]).toString('hex'),
      `entry ${i} does not chain to its predecessor`);
  }

  const v = await verifyJournal(fx.root);
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.code, 'ok');
  assert.equal(v.chained, 6);
  assert.equal(v.legacy, 0);

  // The checkpoint is a real C2SP tlog-checkpoint on disk, parseable by anything that knows it.
  const { checkpoint } = await journalPaths(fx.root);
  const cp = parseCheckpoint(await fs.readFile(checkpoint, 'utf8'));
  assert.equal(cp.size, 6);
  assert.equal(cp.root.toString('hex'), v.root);
  assert.ok(cp.origin.startsWith(`${HOLT_PUBLIC_NAMESPACE}/journal/`), cp.origin);
});

test('an existing checkpoint origin is inherited verbatim when the journal advances', async () => {
  const fx = await repoWithJournal(1, 'legacy-origin');
  const { checkpoint } = await journalPaths(fx.root);
  const cp = parseCheckpoint(await fs.readFile(checkpoint, 'utf8'));
  const historicalOrigin = `${['holt', 'dev'].join('.')}/journal/legacy-origin`;
  await fs.writeFile(checkpoint, formatCheckpoint({
    origin: historicalOrigin, size: cp.size, root: cp.root,
  }), 'utf8');

  const appended = await appendEvent(fx.root, { action: 'protect', id: 'second' });
  assert.equal(appended.ok, true, appended.error);
  const advanced = parseCheckpoint(await fs.readFile(checkpoint, 'utf8'));
  assert.equal(advanced.origin, historicalOrigin,
    'changing the default namespace must not rewrite or invalidate an existing journal identity');
  assert.equal((await verifyJournal(fx.root)).ok, true);
});

test('journal action vocabulary distinguishes new quarantine from historical physical cleanup', async () => {
  assert.ok(JOURNALLED_ACTIONS.includes('clean-quarantine'));
  assert.ok(JOURNALLED_ACTIONS.includes('clean-restore'));
  assert.ok(JOURNALLED_ACTIONS.includes('clean-purge'),
    'current explicit physical reclamation must have a first-class audit action');
  assert.ok(JOURNALLED_ACTIONS.includes('clean-remove'),
    'older journal entries must remain readable with their original destructive meaning');

  const fx = await newRepo('audit-clean-quarantine');
  const restoreArgv = [
    ['git', 'worktree', 'unlock', '/r/.holt-clean/spent'],
    ['git', 'worktree', 'move', '/r/.holt-clean/spent', '/r/spent'],
  ];
  await appendEvent(fx.root, {
    action: 'clean-quarantine', id: 'spent', path: '/r/spent',
    quarantinePath: '/r/.holt-clean/spent', restoreArgv,
  });
  const snapshot = await readVerifiedJournal(fx.root);
  assert.equal(snapshot.verification.ok, true);
  assert.equal(snapshot.entries[0].action, 'clean-quarantine');
  assert.deepEqual(snapshot.entries[0].restoreArgv, restoreArgv);
});

test('verified journal reader returns events from the exact snapshot it verified', async () => {
  const fx = await repoWithJournal(1);
  const snapshot = await readVerifiedJournal(fx.root);

  // Move the live journal forward after the read. The returned verification and entries must
  // remain one coherent historical snapshot rather than one old verdict paired with newer data.
  await appendEvent(fx.root, { action: 'blocked', id: 'later', command: 'rm -rf later' });
  const now = await verifyJournal(fx.root);

  assert.equal(snapshot.verification.ok, true);
  assert.equal(snapshot.verification.entries, 1);
  assert.equal(snapshot.entries.length, 1);
  assert.equal(snapshot.entries[0].seq, 0);
  assert.equal(now.entries, 2, 'premise: the live journal advanced after the snapshot');
});

test('the journal lives under the COMMON git dir, so it survives worktree deletion', async () => {
  const fx = await repoWithJournal(2);
  const wt = await fx.worktree('side');
  const r = await appendEvent(wt, { action: 'protect', id: 'from-worktree' });
  assert.equal(r.ok, true);
  // Written from the worktree, visible from the root, and still one chain.
  const v = await verifyJournal(fx.root);
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.chained, 3);
  assert.equal((await readJournal(wt)).length, 3);
});

/* =========================================================== TAMPERING ==== */

test('TAMPER (edit): changing one value is caught, and the SUCCESSOR entry is named', async () => {
  const fx = await repoWithJournal(5);
  const { journal } = await journalPaths(fx.root);
  const lines = await readLines(journal);

  const before = await verifyJournal(fx.root);
  assert.equal(before.ok, true, 'control: the untampered log must verify');

  // The most realistic edit of all: quietly rewrite what an action claimed to be.
  const doctored = JSON.parse(lines[1]);
  doctored.id = 'wt-INNOCENT';
  lines[1] = JSON.stringify(doctored);
  await writeLines(journal, lines);

  const v = await verifyJournal(fx.root);
  assert.equal(v.ok, false, 'an edited record verified');
  assert.equal(v.code, 'prev-mismatch');
  // Entry 1 was edited, so entry 2 is the first whose recorded predecessor hash no longer holds.
  assert.equal(v.broken.line, 3, `expected the break at line 3, got ${JSON.stringify(v.broken)}`);
  assert.equal(v.broken.seq, 2);
  assert.match(v.broken.reason, /EDITED/);
});

test('TAMPER (delete from the middle): caught, with the gap located exactly', async () => {
  const fx = await repoWithJournal(5);
  const { journal } = await journalPaths(fx.root);
  const lines = await readLines(journal);
  lines.splice(2, 1); // remove the unprotect — the record someone would most want gone
  await writeLines(journal, lines);

  const v = await verifyJournal(fx.root);
  assert.equal(v.ok, false, 'a deleted record went unnoticed');
  assert.equal(v.code, 'seq-gap');
  assert.equal(v.broken.line, 3);
  assert.equal(v.broken.seq, 3, 'the entry that slid into the gap still claims its original seq');
  assert.match(v.broken.reason, /DELETED/);
});

test('TAMPER (truncate the tail): the chain alone CANNOT see it — the checkpoint does', async () => {
  const fx = await repoWithJournal(5);
  const { journal } = await journalPaths(fx.root);
  const lines = await readLines(journal);
  await writeLines(journal, lines.slice(0, 3));

  // Prove the claim in this test's name rather than asserting it: the surviving prefix IS a
  // valid chain. Without a checkpoint this tampering is invisible, which is why one exists.
  const kept = lines.slice(0, 3).map((l) => JSON.parse(l));
  for (let i = 1; i < kept.length; i++) {
    assert.equal(kept[i].prev, entryLeaf(kept[i - 1]).toString('hex'),
      'the truncated prefix is NOT a valid chain — this test is not testing what it claims');
  }

  const v = await verifyJournal(fx.root);
  assert.equal(v.ok, false, 'a truncated log verified');
  assert.equal(v.code, 'checkpoint-size-mismatch');
  assert.match(v.reason, /REMOVED from the end/);
  assert.equal(v.checkpoint.size, 5);
  assert.equal(v.chained, 3);

  // FOUND IN A LIVE RUN: a deleted tail has no entry left to describe, and the report printed
  // "first broken entry: seq 2 · no timestamp · unknown action" — a row of nulls that reads as a
  // parse failure rather than as the deletion it is. It must say what is MISSING.
  assert.equal(v.broken.missing, 2, 'the report does not say how many records are gone');
  assert.equal(v.broken.action, null);
  assert.match(v.broken.reason, /are GONE/);
  const cli = await holt(['journal', '--verify', '--cwd', fx.root], fx.root);
  assert.match(cli.stdout, /2 record\(s\) MISSING from the end/);
  assert.doesNotMatch(cli.stdout, /unknown action/, 'the truncation report still prints a phantom entry');
});

test('TAMPER (insert a fabricated record): caught even when the forger recomputes the chain', async () => {
  const fx = await repoWithJournal(4);
  const { journal, checkpoint } = await journalPaths(fx.root);
  const lines = await readLines(journal);
  const entries = lines.map((l) => JSON.parse(l));

  // A forger who understands the format: insert a record and RE-CHAIN everything after it, so
  // every prev and seq is internally consistent. Only the checkpoint's root can still catch it.
  const fake = { at: entries[2].at, actor: entries[2].actor, action: 'protect', id: 'never-happened', seq: 2, prev: '' };
  const rebuilt = [...entries.slice(0, 2), fake, ...entries.slice(2)];
  for (let i = 0; i < rebuilt.length; i++) {
    rebuilt[i].seq = i;
    rebuilt[i].prev = i === 0 ? GENESIS : entryLeaf(rebuilt[i - 1]).toString('hex');
  }
  await writeLines(journal, rebuilt.map((e) => JSON.stringify(e)));

  const v = await verifyJournal(fx.root);
  assert.equal(v.ok, false, 'a fabricated record with a rebuilt chain verified');
  assert.equal(v.code, 'checkpoint-size-mismatch');

  // Harder still: the forger also fixes the SIZE in the checkpoint but cannot produce the root.
  const cp = parseCheckpoint(await fs.readFile(checkpoint, 'utf8'));
  await fs.writeFile(checkpoint, formatCheckpoint({ origin: cp.origin, size: 5, root: cp.root }), 'utf8');
  const v2 = await verifyJournal(fx.root);
  assert.equal(v2.ok, false, 'a size-patched checkpoint let a fabricated record through');
  assert.equal(v2.code, 'checkpoint-root-mismatch');
});

test('TAMPER (reorder): swapping two records is caught', async () => {
  const fx = await repoWithJournal(5);
  const { journal } = await journalPaths(fx.root);
  const lines = await readLines(journal);
  [lines[1], lines[3]] = [lines[3], lines[1]];
  await writeLines(journal, lines);

  const v = await verifyJournal(fx.root);
  assert.equal(v.ok, false, 'reordered records verified');
  assert.ok(['seq-gap', 'prev-mismatch'].includes(v.code), `unexpected code ${v.code}`);
  assert.equal(v.broken.line, 2);
});

test('TAMPER (delete the head): named as a head deletion, not as an end truncation', async () => {
  // FOUND BY ATTACKING THIS FILE: keying the chain start on "seq === 0" made a head deletion
  // indistinguishable from a pre-chaining legacy log, so holt detected the tampering but
  // reported it as "records removed from the END" — the opposite of what happened. A verifier
  // that misnames the tampering is only half an instrument.
  const fx = await repoWithJournal(4, 'chainhead');
  const { journal } = await journalPaths(fx.root);
  const lines = await readLines(journal);
  await writeLines(journal, lines.slice(1));

  const v = await verifyJournal(fx.root);
  assert.equal(v.ok, false, 'a log with its head removed verified');
  assert.equal(v.code, 'chain-head-removed');
  assert.match(v.reason, /DELETED from the head/);
  assert.equal(v.broken.seq, 1, 'the surviving first record is not identified');
});

test('TAMPER (a half-written line): reported as corrupt at the exact line, not skipped', async () => {
  const fx = await repoWithJournal(3);
  const { journal } = await journalPaths(fx.root);
  const lines = await readLines(journal);
  lines[1] = lines[1].slice(0, 40);
  await writeLines(journal, lines);

  const v = await verifyJournal(fx.root);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'corrupt-line');
  assert.equal(v.broken.line, 2);
});

/* ================================================== FAIL-CLOSED ON GAPS ==== */

test('a DELETED checkpoint is a verification FAILURE — never a silent pass', async () => {
  // Fail-open on missing evidence is the defect class this codebase keeps re-finding. The
  // easiest possible attack on a checkpointed log is to delete the checkpoint.
  const fx = await repoWithJournal(4);
  const { checkpoint } = await journalPaths(fx.root);
  await fs.rm(checkpoint);

  const v = await verifyJournal(fx.root);
  assert.equal(v.ok, false, 'deleting the checkpoint made the log verify');
  assert.equal(v.code, 'checkpoint-missing');
  assert.match(v.reason, /absent/);
});

test('a MANGLED checkpoint is a failure, not a fallback to "chain only"', async () => {
  const fx = await repoWithJournal(3);
  const { checkpoint } = await journalPaths(fx.root);
  await fs.writeFile(checkpoint, 'not a checkpoint at all\n', 'utf8');
  const v = await verifyJournal(fx.root);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'checkpoint-unreadable');
});

test('a legacy journal (pre-chaining) is reported as UNVERIFIABLE, and never as tampered', async () => {
  // Backwards compatibility that does not lie: an upgrade must not accuse the user of tampering,
  // and must not pretend the old records are covered either.
  const fx = await newRepo('legacy');
  const { dir, journal } = await journalPaths(fx.root);
  await fs.mkdir(dir, { recursive: true });
  await writeLines(journal, [
    JSON.stringify({ at: '2026-07-01T00:00:00.000Z', action: 'protect', id: 'old-1' }),
    JSON.stringify({ at: '2026-07-02T00:00:00.000Z', action: 'rescue', id: 'old-2' }),
  ]);

  const v0 = await verifyJournal(fx.root);
  assert.equal(v0.ok, false, 'an unverifiable legacy log must not report as verified');
  assert.equal(v0.code, 'no-chain');
  assert.equal(v0.legacy, 2, 'both pre-chaining rows must be counted and named as unverifiable');
  assert.equal(v0.chained, 0);

  // Chaining starts from the next action, and the old rows stay visible and honestly labelled.
  await appendEvent(fx.root, { action: 'unprotect', id: 'new-1' });
  await appendEvent(fx.root, { action: 'protect', id: 'new-2' });
  const v = await verifyJournal(fx.root);
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.code, 'ok-with-legacy');
  assert.equal(v.legacy, 2);
  assert.equal(v.chained, 2);
  assert.match(v.reason, /predate hash chaining/);
  assert.equal((await readJournal(fx.root)).length, 4, 'the legacy rows must not be dropped');
});

/* ============================================== UNPROTECT IS JOURNALLED ==== */

test('unprotect is journalled — the hole exactly where the risk is', async () => {
  const fx = await newRepo('unprotect-journal');
  await fx.worktree('risky');
  await fx.write('new-only-here.js', 'export const x = 1;\n', fx.worktrees.get('risky'));

  const p = await protect(fx.root, {});
  assert.ok(p.protected > 0, `nothing was protected, so this test cannot observe a release: ${JSON.stringify(p)}`);

  // PROVE THE INSTRUMENT: before the change there was no unprotect record to find, so assert
  // the protect record IS there first — otherwise "found an unprotect" could be a fluke.
  const before = await readJournal(fx.root);
  assert.ok(before.some((e) => e.action === 'protect'), 'protect was not journalled');
  assert.equal(before.filter((e) => e.action === 'unprotect').length, 0);

  const u = await unprotect(fx.root, {});
  assert.ok(u.unlocked > 0, JSON.stringify(u));

  const after = await readJournal(fx.root);
  const rec = after.filter((e) => e.action === 'unprotect');
  assert.equal(rec.length, u.unlocked, 'not every release was recorded');
  assert.ok(rec[0].id, 'the released workstream is not identified');
  assert.ok(rec[0].path, 'the released path is not recorded');
  assert.ok(rec[0].actor?.user, 'the release has no attributable actor');
  assert.match(rec[0].reason, /holt:/, 'the record does not say what was being protected');
  assert.equal(rec[0].forced, false);

  const v = await verifyJournal(fx.root);
  assert.equal(v.ok, true, `the log stopped verifying after a real action: ${JSON.stringify(v)}`);

  // And it is visible in the ROI view rather than netted away against the protections.
  const s = summarizeJournal(after);
  assert.equal(s.breakdown.protectionsReleased, u.unlocked);
});

test('a FORCED release of a foreign lock is recorded distinctly from an ordinary one', async () => {
  const fx = await newRepo('forced-unprotect');
  const wt = await fx.worktree('other');
  await sh('git', ['worktree', 'lock', '--reason', 'a human locked this deliberately', wt], fx.root);

  // Without --force holt leaves it alone and there is nothing to record.
  const skip = await unprotect(fx.root, {});
  assert.equal(skip.unlocked, 0);
  assert.equal((await readJournal(fx.root)).filter((e) => e.action === 'unprotect').length, 0,
    'a release that never happened was journalled');

  const u = await unprotect(fx.root, { force: true });
  assert.equal(u.unlocked, 1, JSON.stringify(u));
  const rec = (await readJournal(fx.root)).filter((e) => e.action === 'unprotect');
  assert.equal(rec.length, 1);
  assert.equal(rec[0].forced, true, 'overriding someone else’s protection is not distinguishable in the trail');
  assert.match(rec[0].evidence, /did NOT place/);
});

/* ================================================== PARALLEL APPENDERS ==== */

test('twelve concurrent appends produce ONE valid chain, not a fork', async () => {
  // holt exists because agents run in parallel, so this is the normal case. Without the lock,
  // two appenders read the same head, write the same `prev`, and the log reads as TAMPERED
  // when nobody tampered — a false alarm that would destroy trust in the artefact.
  const fx = await newRepo('concurrent');
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) => appendEvent(fx.root, { action: 'protect', id: `p-${i}` })));
  assert.equal(results.filter((r) => r.ok).length, 12, JSON.stringify(results.filter((r) => !r.ok)));

  const v = await verifyJournal(fx.root);
  assert.equal(v.ok, true, `concurrent appends forked the chain: ${JSON.stringify(v)}`);
  assert.equal(v.chained, 12);
  const seqs = (await readJournal(fx.root)).map((e) => e.seq);
  assert.deepEqual(seqs, [...Array(12).keys()], 'sequence numbers were duplicated or skipped');
});

test('a stale lock is broken open rather than wedging the audit trail forever', async () => {
  const fx = await newRepo('stalelock');
  const { dir, lock } = await journalPaths(fx.root);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(lock, '', 'utf8');
  const old = new Date(Date.now() - 120_000);
  await fs.utimes(lock, old, old);

  const r = await appendEvent(fx.root, { action: 'protect', id: 'after-crash' });
  assert.equal(r.ok, true, `a crashed process wedged the journal: ${r.error}`);
  assert.equal((await verifyJournal(fx.root)).ok, true);
});

test('a LIVE lock makes the append refuse loudly rather than write an unchained entry', async () => {
  // The one deliberate exception to best-effort: an audit GAP is recoverable, a chain that reads
  // as tampering when nobody tampered is not.
  const fx = await repoWithJournal(2, 'livelock');
  const { lock } = await journalPaths(fx.root);
  let inner;
  await withLock(lock, async () => {
    inner = await appendEvent(fx.root, { action: 'protect', id: 'contended' }, {});
  }, { timeoutMs: 1 });
  assert.equal(inner.ok, false, 'the append ignored a held lock');
  assert.match(inner.error, /locked by another holt process/);
  assert.equal((await verifyJournal(fx.root)).ok, true, 'the refusal damaged the chain');
  assert.equal((await readJournal(fx.root)).length, 2, 'a partial record was written');
});

/* =========================================================== CLI SHAPE ==== */

test('CLI: --verify exits 0 on a good log and 1 on a tampered one, naming the entry', async () => {
  const fx = await repoWithJournal(4, 'cli');
  const ok = await holt(['journal', '--verify', '--cwd', fx.root], fx.root);
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /VERIFIED/);

  const { journal } = await journalPaths(fx.root);
  const lines = await readLines(journal);
  const doctored = JSON.parse(lines[0]);
  doctored.id = 'rewritten';
  lines[0] = JSON.stringify(doctored);
  await writeLines(journal, lines);

  const bad = await holt(['journal', '--verify', '--cwd', fx.root], fx.root);
  assert.equal(bad.code, 1, 'a tampered log exited 0 — no CI job would ever catch it');
  assert.match(bad.stdout, /BROKEN \(prev-mismatch\)/);
  assert.match(bad.stdout, /first broken entry/);
  assert.match(bad.stdout, /line 2/);

  const json = await holt(['journal', '--verify', '--json', '--cwd', fx.root], fx.root);
  assert.equal(json.code, 1);
  const v = JSON.parse(json.stdout);
  assert.equal(v.ok, false);
  assert.equal(v.broken.line, 2);
});

test('CLI: --export refuses a tampered log, and --force stamps every record instead', async () => {
  const fx = await repoWithJournal(3, 'cliexport');
  const good = await holt(['journal', '--export', 'ocsf', '--cwd', fx.root], fx.root);
  assert.equal(good.code, 0, good.stderr);
  const docs = good.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(docs.length, 3);
  assert.equal(docs[0].class_uid, 6003);

  const { checkpoint } = await journalPaths(fx.root);
  await fs.rm(checkpoint);

  const refused = await holt(['journal', '--export', 'ocsf', '--cwd', fx.root], fx.root);
  assert.equal(refused.code, 1, 'a log with no checkpoint exported without complaint');
  assert.match(refused.stderr, /does not verify/);
  assert.equal(refused.stdout.trim(), '', 'records were emitted despite the refusal');

  const forced = await holt(['journal', '--export', 'ocsf', '--force', '--cwd', fx.root], fx.root);
  assert.equal(forced.code, 0);
  const f = forced.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(f[0].unmapped.holt_integrity.code, 'checkpoint-missing');
});

test('CLI: every advertised export format produces output, and an unknown one is refused', async () => {
  const fx = await repoWithJournal(2, 'clifmt');
  for (const fmt of ['json', 'csv', 'ocsf', 'ecs', 'cef', 'intoto']) {
    const r = await holt(['journal', '--export', fmt, '--cwd', fx.root], fx.root);
    assert.equal(r.code, 0, `${fmt}: ${r.stderr}`);
    assert.ok(r.stdout.trim().length > 0, `${fmt} produced nothing`);
  }
  const bad = await holt(['journal', '--export', 'splunk', '--cwd', fx.root], fx.root);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /unknown export format/);
});

test('CLI: --prove emits an offline RFC 6962 inclusion proof that verifies', async () => {
  const fx = await repoWithJournal(7, 'cliprove');
  const r = await holt(['journal', '--prove', '3', '--json', '--cwd', fx.root], fx.root);
  assert.equal(r.code, 0, r.stderr);
  const p = JSON.parse(r.stdout);
  assert.equal(p.seq, 3);
  assert.equal(p.size, 7);
  assert.equal(p.verifies, true);
  assert.ok(p.proof.length > 0);

  const oob = await holt(['journal', '--prove', '99', '--cwd', fx.root], fx.root);
  assert.equal(oob.code, 2);
  assert.match(oob.stderr, /no chained entry/);
});

test('CLI: the human journal view shows WHO, and flags unprotect', async () => {
  const fx = await repoWithJournal(4, 'clihuman');
  const r = await holt(['journal', '--cwd', fx.root], fx.root);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /unprotect/);
  assert.match(r.stdout, /unknown@unknown/, 'the actor is shown (unknown is the honest answer when no host identified itself)');
  assert.match(r.stdout, /--verify/, 'the human view does not tell anyone integrity can be checked');
});

/* ================================================== THE PAID BOUNDARY ==== */

test('FREE: verify, prove and export all work with NO licence whatsoever', async () => {
  // The most important assertion in this file for the pricing to be honest: a tamper-evident log
  // whose owner cannot check it would be selling a lock and charging for the key.
  const fx = await repoWithJournal(3, 'freetier');
  const noLicence = { HOLT_LICENSE: '', XDG_CONFIG_HOME: await fs.mkdtemp(path.join(os.tmpdir(), 'holt-nolic-')) };
  for (const args of [['journal', '--verify'], ['journal', '--prove', '0'], ['journal', '--export', 'ocsf'],
    ['journal', '--export', 'cef'], ['journal', '--summary']]) {
    const r = await holt([...args, '--cwd', fx.root], fx.root, noLicence);
    assert.equal(r.code, 0, `${args.join(' ')} was gated or failed without a licence: ${r.stderr}`);
  }
});

test('PAID: the continuous sink refuses without an entitlement, at the API and at the CLI', async () => {
  const fx = await repoWithJournal(3, 'sinkgate');
  const dest = path.join(fx.root, '..', 'sink.ndjson');
  await assert.rejects(
    () => sinkExport(fx.root, { to: dest, env: {} }),
    (e) => e instanceof EntitlementError && /team/.test(e.message),
    'the sink ran without a licence when imported directly');
  assert.equal(await fs.access(dest).then(() => true, () => false), false, 'the refused sink still wrote');

  const noLicence = { HOLT_LICENSE: '', XDG_CONFIG_HOME: await fs.mkdtemp(path.join(os.tmpdir(), 'holt-nolic2-')) };
  const cli = await holt(['journal', '--sink', dest, '--cwd', fx.root], fx.root, noLicence);
  assert.equal(cli.code, 3, cli.stdout + cli.stderr);
  assert.match(cli.stderr, /team license/);
  // The refusal must point at the free path rather than dead-ending.
  assert.match(cli.stderr, /--export ocsf/);
});

test('PAID: fleet audit refuses without an entitlement', async () => {
  const fx = await repoWithJournal(2, 'fleetgate');
  await assert.rejects(() => fleetAudit([path.dirname(fx.root)], { env: {} }),
    (e) => e.name === 'EntitlementError');
});

/* ---- with an entitlement, minted with a throwaway licence key ---- */

// The production licence key's private half does not exist in this repository, by design. The
// paid path is therefore exercised with a throwaway pair passed as an ARGUMENT (never an env
// var — that would be a forgery hole), which is the same mechanism src/license.mjs already
// documents for its own tests. The GATE is proven by the refusal tests above and exhaustively
// by test/unit/license.test.mjs; these tests prove the FEATURE behind it.
const { publicKey: LIC_PUB, privateKey: LIC_PRIV } = generateKeyPairSync('ed25519');
const TEST_PUB = LIC_PUB.export({ type: 'spki', format: 'der' }).toString('base64');
const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function teamLicence() {
  const claims = {
    v: 1, id: 'lic-test', tier: 'team', org: 'Test Co',
    iat: Date.now() - 86_400_000, exp: Date.now() + 86_400_000,
  };
  const payload = b64url(JSON.stringify(claims));
  return `holt_team_${payload}.${b64url(edSign(null, Buffer.from(payload, 'utf8'), LIC_PRIV))}`;
}
const LICENCED = { HOLT_LICENSE: teamLicence() };
const PAID = { env: LICENCED, publicKeyB64: TEST_PUB };

test('PAID: the sink emits once, then is idempotent — a SIEM is not double-billed for a re-run', async () => {
  const fx = await repoWithJournal(4, 'sinkrun');
  const dest = path.join(path.dirname(fx.root), 'sink.ndjson');

  const r1 = await sinkExport(fx.root, { to: dest, format: 'ocsf', ...PAID });
  assert.equal(r1.emitted, 4, JSON.stringify(r1));
  assert.equal(r1.fromSeq, 0);
  const docs = (await fs.readFile(dest, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(docs.length, 4);
  assert.equal(docs[0].class_uid, 6003);
  assert.ok(docs.every((d) => d.metadata.uid), 'records carry no id, so a SIEM cannot de-duplicate them');

  const r2 = await sinkExport(fx.root, { to: dest, format: 'ocsf', ...PAID });
  assert.equal(r2.emitted, 0, 're-running the sink re-shipped the whole history');
  assert.equal((await fs.readFile(dest, 'utf8')).trim().split('\n').length, 4);

  // New activity ships incrementally, and only the new activity.
  await appendEvent(fx.root, { action: 'unprotect', id: 'wt-late' });
  const r3 = await sinkExport(fx.root, { to: dest, format: 'ocsf', ...PAID });
  assert.equal(r3.emitted, 1);
  assert.equal(r3.fromSeq, 4);
  const all = (await fs.readFile(dest, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(all.length, 5);
  assert.equal(all[4].api.operation, 'unprotect');
});

test('PAID: the sink REFUSES a journal that does not verify, and writes nothing', async () => {
  const fx = await repoWithJournal(3, 'sinkbroken');
  const dest = path.join(path.dirname(fx.root), 'sink2.ndjson');
  const { journal } = await journalPaths(fx.root);
  const lines = await readLines(journal);
  const doctored = JSON.parse(lines[0]);
  doctored.action = 'protect';
  doctored.id = 'laundered';
  lines[0] = JSON.stringify(doctored);
  await writeLines(journal, lines);

  // Pinned on the SINK's own message, not merely on the code. FOUND BY THE RED PROOF: there are
  // two independent gates here — the sink's, and exportJournal's — and both raise EINTEGRITY with
  // "does not verify". Asserting only that let the sink's own gate be deleted with the test still
  // green, because the second one caught it. Defence in depth is good; a test that cannot tell
  // which layer is doing the work is not.
  await assert.rejects(() => sinkExport(fx.root, { to: dest, ...PAID }),
    (e) => e.code === 'EINTEGRITY' && /audit sink REFUSED/.test(e.message),
    'a rewritten log was shipped into a SIEM, laundering the tampering');
  assert.equal(await fs.access(dest).then(() => true, () => false), false, 'the refused sink still wrote records');
});

test('PAID: BOTH gates are live — the sink refuses first, and the encoder refuses independently', async () => {
  // The layer the red proof exposed: prove each gate can refuse ON ITS OWN, so deleting either
  // one is a detectable regression rather than a silent loss of redundancy.
  const fx = await repoWithJournal(3, 'sinkdepth');
  const { checkpoint } = await journalPaths(fx.root);
  await fs.rm(checkpoint);
  const v = await verifyJournal(fx.root);
  assert.equal(v.ok, false);

  // Gate 2 alone: the encoder, called directly with a failed verification.
  const events = await readJournal(fx.root);
  assert.throws(() => exportJournal(events, 'ocsf', { verification: v }),
    (e) => e.code === 'EINTEGRITY', 'the encoder does not refuse a failed verification on its own');

  // Gate 1 alone: the sink, which must refuse before it reaches the encoder at all.
  await assert.rejects(() => sinkExport(fx.root, { to: path.join(path.dirname(fx.root), 's.ndjson'), ...PAID }),
    (e) => /audit sink REFUSED/.test(e.message), 'the sink delegated its refusal to the encoder');
});

test('PAID: a rewrite BEHIND the cursor is caught — the property a plain tail cannot give you', async () => {
  const fx = await repoWithJournal(4, 'sinkrewrite');
  const dest = path.join(path.dirname(fx.root), 'sink3.ndjson');
  const first = await sinkExport(fx.root, { to: dest, ...PAID });
  assert.equal(first.emitted, 4);

  // Rewrite an ALREADY-EXPORTED record and re-chain everything so the journal itself verifies.
  // A naive "tail the file from where I left off" exporter sees nothing wrong; the cursor's
  // recorded leaf hash is what catches it.
  const { journal, checkpoint } = await journalPaths(fx.root);
  const entries = (await readLines(journal)).map((l) => JSON.parse(l));
  entries[1].id = 'quietly-changed';
  for (let i = 0; i < entries.length; i++) {
    entries[i].seq = i;
    entries[i].prev = i === 0 ? GENESIS : entryLeaf(entries[i - 1]).toString('hex');
  }
  await writeLines(journal, entries.map((e) => JSON.stringify(e)));
  const cp = parseCheckpoint(await fs.readFile(checkpoint, 'utf8'));
  await fs.writeFile(checkpoint, formatCheckpoint({
    origin: cp.origin, size: entries.length, root: merkleRoot(entries.map((e) => entryLeaf(e))),
  }), 'utf8');

  // Control: the doctored log now verifies on its own terms — so verification alone would pass it.
  assert.equal((await verifyJournal(fx.root)).ok, true,
    'the doctored log does not self-verify, so this test is not testing what it claims');

  await assert.rejects(() => sinkExport(fx.root, { to: dest, ...PAID }),
    (e) => e.code === 'EREWRITE' && /REWRITTEN behind the sink/.test(e.message),
    'history was rewritten behind the sink and the export continued');
});

test('PAID: the batch checkpoint is signed on the aggregation host, and verifies', async () => {
  const fx = await repoWithJournal(3, 'sinksign');
  const dest = path.join(path.dirname(fx.root), 'sink4.ndjson');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');

  const unsigned = await sinkExport(fx.root, { to: dest, ...PAID });
  assert.equal(unsigned.signed, false);
  // An unsigned checkpoint must SAY it proves integrity and not origin, rather than implying more.
  assert.match(unsigned.signingNote, /UNSIGNED/);
  assert.equal(verifyNote(await fs.readFile(unsigned.checkpointFile, 'utf8'), { keys: [publicKey] }).valid, false);

  await appendEvent(fx.root, { action: 'protect', id: 'more' });
  const signed = await sinkExport(fx.root, {
    to: dest, ...PAID,
    signingKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), signerName: 'audit-host-1',
  });
  assert.equal(signed.signed, true);
  assert.equal(signed.signedBy, 'audit-host-1');
  const note = await fs.readFile(signed.checkpointFile, 'utf8');
  const v = verifyNote(note, { keys: [publicKey] });
  assert.equal(v.valid, true, JSON.stringify(v));
  assert.equal(parseCheckpoint(note).size, 4);
  // A different key must not verify it — otherwise the signature proves nothing about origin.
  assert.equal(verifyNote(note, { keys: [LIC_PUB] }).valid, false);
});

test('PAID: an unreadable cursor REFUSES rather than silently re-shipping the whole history', async () => {
  const fx = await repoWithJournal(3, 'sinkcursor');
  const dest = path.join(path.dirname(fx.root), 'sink5.ndjson');
  const r = await sinkExport(fx.root, { to: dest, ...PAID });
  assert.equal(r.emitted, 3);
  const { dir } = await journalPaths(fx.root);
  const cursors = await fs.readdir(path.join(dir, 'sink'));
  await fs.writeFile(path.join(dir, 'sink', cursors[0]), 'not json', 'utf8');
  await assert.rejects(() => sinkExport(fx.root, { to: dest, ...PAID }), /refusing to guess/);
});

test('PAID: --dry-run computes the batch and writes nothing at all', async () => {
  const fx = await repoWithJournal(3, 'sinkdry');
  const dest = path.join(path.dirname(fx.root), 'sink6.ndjson');
  const r = await sinkExport(fx.root, { to: dest, dryRun: true, ...PAID });
  assert.equal(r.emitted, 3);
  assert.equal(await fs.access(dest).then(() => true, () => false), false);
  // And because nothing was committed, the next real run still ships everything.
  assert.equal((await sinkExport(fx.root, { to: dest, ...PAID })).emitted, 3);
});

test('PAID: fleet audit verifies every repo and NEVER folds a broken one into the totals', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-fleet-audit-'));
  const clean1 = await newRepo('fa-clean1');
  const clean2 = await newRepo('fa-clean2');
  const broken = await newRepo('fa-broken');
  for (const [fx, actions] of [[clean1, ['protect', 'unprotect']], [clean2, ['protect']], [broken, ['protect', 'unprotect', 'unprotect']]]) {
    for (const a of actions) await appendEvent(fx.root, { action: a, id: `${a}-x` });
  }
  // Tamper with exactly one repository.
  const { journal } = await journalPaths(broken.root);
  const lines = await readLines(journal);
  await writeLines(journal, lines.slice(0, 2));

  for (const fx of [clean1, clean2, broken]) {
    await fs.cp(fx.root, path.join(rootDir, path.basename(path.dirname(fx.root))), { recursive: true });
  }

  const f = await fleetAudit([rootDir], PAID);
  assert.equal(f.repositories, 3, JSON.stringify(f.repos.map((r) => r.name)));
  assert.equal(f.verifiedRepositories, 2);
  assert.equal(f.unverifiedRepositories.length, 1);
  assert.equal(f.unverifiedRepositories[0].code, 'checkpoint-size-mismatch');
  // The broken repo held 3 events including 2 unprotects. None of them may appear in the totals.
  assert.equal(f.totals.events, 3, 'a broken repository was folded into the fleet totals');
  assert.equal(f.totals.unprotects, 1);
  assert.match(f.note, /not clean, they are unaccounted for/);
  // The failing repo is still listed, named, and sorted first — never hidden.
  assert.equal(f.repos[0].verified, false);
  assert.ok(f.actors.length > 0, 'the fleet view has no actor breakdown');
});

test('fleet audit evidence states distinguish absence, empty-valid, populated, and broken journals', async () => {
  // Classification is deliberately a separate, total contract: a future verifier may support a
  // checkpointed zero-entry journal, but it still is not event evidence and must not enter totals.
  assert.equal(journalEvidenceState({ ok: true, code: 'empty', entries: 0 }), 'no-journal');
  assert.equal(journalEvidenceState({ ok: true, code: 'ok', entries: 0 }), 'empty-valid');
  assert.equal(journalEvidenceState({ ok: true, code: 'ok', entries: 1, legacy: 0 }), 'valid-populated');
  assert.equal(journalEvidenceState({ ok: false, code: 'checkpoint-missing', entries: 1 }), 'tampered-or-unverifiable');
  assert.equal(journalEvidenceState({ ok: false, code: 'empty', entries: 0 }), 'tampered-or-unverifiable',
    'a contradictory verifier result must fail closed; a label must not outrank ok:false');

  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-fleet-evidence-'));
  const populated = await repoWithJournal(1, 'fa-populated');
  const absent = await newRepo('fa-absent');
  const broken = await repoWithJournal(1, 'fa-broken-evidence');
  const { checkpoint } = await journalPaths(broken.root);
  await fs.rm(checkpoint);
  for (const fx of [populated, absent, broken]) {
    await fs.cp(fx.root, path.join(rootDir, path.basename(path.dirname(fx.root))), { recursive: true });
  }

  const f = await fleetAudit([rootDir], PAID);
  assert.equal(f.verifiedRepositories, 1, 'only a populated, fully verified chain is trusted evidence');
  assert.equal(f.totals.events, 1);
  assert.deepEqual(f.unverifiedRepositories.map((r) => r.journalState).sort(),
    ['no-journal', 'tampered-or-unverifiable']);
  assert.ok(f.repos.every((r) => r.verified || r.entries === 0),
    'untrusted rows must not carry derived event totals that look confirmed');
});

test('the ROI summary counts releases without netting them against protections', async () => {
  const events = [
    { action: 'protect' }, { action: 'protect' }, { action: 'unprotect' },
    { action: 'blocked' }, { action: 'rescue' },
  ];
  const s = summarizeJournal(events);
  assert.equal(s.breakdown.workstreamsProtected, 2);
  assert.equal(s.breakdown.protectionsReleased, 1);
  assert.equal(s.preventedLosses, 2, 'a release must not be subtracted from prevented losses');
});
