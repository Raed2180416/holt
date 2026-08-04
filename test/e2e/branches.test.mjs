/**
 * holt branches + journal — the branch graveyard gets worktree-grade honesty.
 *
 * The cases that matter are exactly the ones `git branch -d` gets wrong in both directions:
 * a squash-merged branch (content landed, ancestry says unmerged) and the requirement that
 * --apply never force-deletes anything. Plus the audit journal: mutating actions leave a
 * record that survives, and a journal failure never breaks the action.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newRepo } from '../fixtures.mjs';
import { branchAudit } from '../../src/branches.mjs';
import { readJournal, appendEvent } from '../../src/journal.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'holt.mjs');

function sh(cmd, args, cwd) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      cwd, timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'holt test', GIT_AUTHOR_EMAIL: 't@holt.invalid',
        GIT_COMMITTER_NAME: 'holt test', GIT_COMMITTER_EMAIL: 't@holt.invalid',
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', LC_ALL: 'C',
      },
    }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? -1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }));
  });
}

async function graveyardFixture() {
  const fx = await newRepo('branches');

  // landed: branched at HEAD, main then moves on — tip is an ancestor, delta empty.
  await sh('git', ['branch', 'landed-ancestor'], fx.root);

  // squashed: real work on the branch, then the IDENTICAL content lands on main as a separate
  // commit — the squash-merge shape. Ancestry says unmerged; content says landed.
  await sh('git', ['checkout', '-q', '-b', 'squashed'], fx.root);
  await fx.write('src/feature.js', 'export function squashLanded() { return 42; }\n');
  await fx.commit('feature on branch');
  await sh('git', ['checkout', '-q', 'main'], fx.root);
  await fx.write('src/feature.js', 'export function squashLanded() { return 42; }\n');
  await fx.commit('squash-merge of feature');

  // wip: holds a file main does not have, in any form.
  await sh('git', ['checkout', '-q', '-b', 'wip'], fx.root);
  await fx.write('src/only-here.js', 'export function ONLY_ON_WIP() {}\n');
  await fx.commit('unlanded work');
  await sh('git', ['checkout', '-q', 'main'], fx.root);

  // active: checked out in a worktree — belongs to the worktree layer, not this audit.
  await sh('git', ['worktree', 'add', '-q', '-b', 'active', path.join(fx.root, 'wt', 'active-wt')], fx.root);

  return fx;
}

test('BRANCHES: landed vs content-landed vs unlanded, classified by content not ancestry', async (t) => {
  const fx = await graveyardFixture();
  t.after(() => fx.cleanup());

  const audit = await branchAudit(fx.root, { base: 'main' });
  assert.equal(audit.ok, true);

  assert.ok(audit.landed.some((b) => b.name === 'landed-ancestor'));
  const landed = audit.landed.find((b) => b.name === 'landed-ancestor');
  assert.equal(landed.safe, true);
  assert.match(landed.command, /branch -d landed-ancestor/);

  assert.ok(audit.contentLanded.some((b) => b.name === 'squashed'));
  const contentLanded = audit.contentLanded.find((b) => b.name === 'squashed');
  assert.equal(contentLanded.safe, false, 'content-landed is evidence, never auto-safe');
  assert.match(contentLanded.reason, /NOT an ancestor/);

  assert.ok(audit.unlanded.some((b) => b.name === 'wip'));
  const unlanded = audit.unlanded.find((b) => b.name === 'wip');
  assert.ok(unlanded.files.some((f) => f.includes('only-here')),
    `unlanded must name the held files: ${JSON.stringify(unlanded)}`);

  assert.ok(audit.excludedCheckedOut.includes('active'), 'checked-out branches remain marked report-only');
  const active = [...audit.landed, ...audit.contentLanded, ...audit.unlanded, ...audit.unknown]
    .find((b) => b.name === 'active');
  assert.ok(active, 'a checked-out branch must be audited in a fan-out');
  assert.equal(active.checkedOut, true);
  assert.equal(active.safe, false, 'checked-out branches are never auto-deletable');
});

test('BRANCHES: --apply deletes ONLY the landed bucket with -d, and records it in the journal', async (t) => {
  const fx = await graveyardFixture();
  t.after(() => fx.cleanup());

  const audit = await branchAudit(fx.root, { base: 'main', apply: true });
  assert.deepEqual(audit.applied.map((a) => a.name), ['landed-ancestor']);
  assert.equal(audit.applied[0].ok, true);

  const refs = (await sh('git', ['for-each-ref', 'refs/heads', '--format=%(refname:short)'], fx.root)).stdout;
  assert.ok(!refs.includes('landed-ancestor'), 'landed branch must be gone');
  assert.ok(refs.includes('squashed'), 'content-landed branch must SURVIVE --apply');
  assert.ok(refs.includes('wip'), 'unlanded branch must survive');

  const events = await readJournal(fx.root);
  const del = events.filter((e) => e.action === 'branch-delete');
  assert.equal(del.length, 1);
  assert.equal(del[0].name, 'landed-ancestor');
  assert.ok(del[0].evidence, 'a recorded deletion must carry its evidence');
});

test('BRANCHES: instrument failure yields UNKNOWN, never a safe bucket', async (t) => {
  // A one-sided ADD never makes merge-tree open the blob, so the missing object must sit on a
  // path that forces a CONTENT merge: divergent edits to the same file on branch and main.
  const fx = await newRepo('branches-ghost');
  t.after(() => fx.cleanup());

  await sh('git', ['checkout', '-q', '-b', 'ghost'], fx.root);
  await fx.write('README.md', '# fixture\nghost version\n');
  await fx.commit('ghost edit');
  await sh('git', ['checkout', '-q', 'main'], fx.root);
  await fx.write('README.md', '# fixture\nmain version\n');
  await fx.commit('main edit');

  const oid = (await sh('git', ['rev-parse', 'ghost:README.md'], fx.root)).stdout.trim();
  await fs.rm(path.join(fx.root, '.git', 'objects', oid.slice(0, 2), oid.slice(2)));

  const audit = await branchAudit(fx.root, { base: 'main' });
  const ghost = [...audit.unknown, ...audit.unlanded, ...audit.landed, ...audit.contentLanded]
    .find((b) => b.name === 'ghost');
  assert.ok(ghost, 'ghost must still be reported');
  assert.equal(ghost.safe, false);
  assert.equal(ghost.status, 'unknown', `missing object must refuse classification: ${JSON.stringify(ghost)}`);
  assert.match(ghost.reason, /instrument failed/);
});

test('CLI: order / partition / branches / journal are wired, exit 0, and emit valid JSON', async (t) => {
  const fx = await graveyardFixture();
  t.after(() => fx.cleanup());

  for (const args of [['order'], ['partition', '--agents', '3'], ['hotspots'], ['branches'], ['journal'], ['plan', '--collapse']]) {
    const r = await sh(process.execPath, [BIN, ...args, '--json', '--cwd', fx.root], fx.root);
    assert.equal(r.code, 0, `holt ${args.join(' ')} exited ${r.code}: ${r.stderr}`);
    assert.doesNotThrow(() => JSON.parse(r.stdout), `holt ${args.join(' ')} must emit JSON`);
  }
});

test('JOURNAL: a journal failure is loud but never breaks the action', async (t) => {
  const fx = await newRepo('journal-fail');
  t.after(() => fx.cleanup());

  // Make the journal path unwritable by occupying it with a FILE where the dir must go.
  await fs.writeFile(path.join(fx.root, '.git', 'holt'), 'not a directory', 'utf8');
  const r = await appendEvent(fx.root, { action: 'protect', id: 'x' });
  assert.equal(r.ok, false, 'append must report failure');

  // And reading an absent journal is an empty list, not a crash.
  await fs.rm(path.join(fx.root, '.git', 'holt'));
  assert.deepEqual(await readJournal(fx.root), []);
});

test('JOURNAL FAILURE: branchAudit --apply tells the caller AND still deletes the landed branch', async (t) => {
  // appendEvent() itself was already proven loud on stderr above — this is the gap that mattered:
  // branchAudit() did `await appendEvent(...)` and threw its {ok, error} away, so a caller reading
  // only the RESULT (an MCP client, a `--json` script) saw a clean success with no way to know the
  // branch-delete it just performed has no audit record. Both halves matter: the branch really
  // went (never-worse: a broken journal must not make holt refuse to clean up), and the response
  // says so (the whole point of this fix).
  const fx = await graveyardFixture();
  t.after(() => fx.cleanup());

  await fs.writeFile(path.join(fx.root, '.git', 'holt'), 'not a directory', 'utf8');

  const audit = await branchAudit(fx.root, { base: 'main', apply: true });

  // THE DELETE STILL HAPPENED.
  assert.deepEqual(audit.applied.map((a) => a.name), ['landed-ancestor']);
  assert.equal(audit.applied[0].ok, true);
  const refs = (await sh('git', ['for-each-ref', 'refs/heads', '--format=%(refname:short)'], fx.root)).stdout;
  assert.ok(!refs.includes('landed-ancestor'), 'the branch must actually be gone, journal or no journal');

  // AND THE CALLER IS TOLD, by name, in the result itself.
  assert.ok(audit.journalWarning, `a journal failure must be reported in the result: ${JSON.stringify(audit)}`);
  assert.ok(Array.isArray(audit.journalFailures) && audit.journalFailures.length >= 1);
  assert.equal(audit.journalFailures[0].action, 'branch-delete');
  assert.equal(audit.journalFailures[0].name, 'landed-ancestor', 'the failure must name WHICH branch');
});

test('CI GATE: report-only by default; policy flags fail honestly; ignore exempts the PR head', async (t) => {
  const fx = await graveyardFixture();
  t.after(() => fx.cleanup());

  const plain = await sh(process.execPath, [BIN, 'ci', '--json', '--cwd', fx.root], fx.root);
  assert.equal(plain.code, 0, `report-only must exit 0: ${plain.stderr}`);
  assert.equal(JSON.parse(plain.stdout).ok, true);

  const strict = await sh(process.execPath, [BIN, 'ci', '--fail-on-unlanded', '--json', '--cwd', fx.root], fx.root);
  assert.equal(strict.code, 1, 'unlanded work must fail the gate');
  const body = JSON.parse(strict.stdout);
  assert.ok(body.failures.some((f) => f.includes('wip')), `the failure must NAME the branch: ${JSON.stringify(body.failures)}`);

  const exempt = await sh(process.execPath, [BIN, 'ci', '--fail-on-unlanded', '--ignore', 'wip', '--json', '--cwd', fx.root], fx.root);
  assert.equal(exempt.code, 0, `an exempted branch must not fail the gate: ${exempt.stdout}`);
});

/**
 * A SHALLOW CLONE CANNOT ANSWER THIS QUESTION, AND `ok: true` IS THE WORST POSSIBLE ANSWER.
 *
 * WHEN THIS BITES, and it is not an edge case: `actions/checkout` defaults to `fetch-depth: 1`.
 * That is a SHALLOW clone, so the DEFAULT GitHub Actions installation of holt's team gate produced
 * a gate that always passed. A team adopts `holt ci` specifically to stop work being abandoned,
 * sees green on every PR, and concludes they are protected.
 *
 * MEASURED on one repository, same command, two clones:
 *     full     holt ci --fail-on-unlanded  -> exit 1, unlanded work correctly reported
 *     shallow  holt ci --fail-on-unlanded  -> exit 0, {"ok":true,"unlanded":[],"unknown":[]}
 * and the string "shallow" appeared nowhere in the output — the "requires full refs" note is
 * printed unconditionally, so it is boilerplate rather than a detection.
 *
 * Absence of evidence reported as evidence of absence, inside the one command whose entire purpose
 * is to fail. It is now treated exactly like `audit.unknown`: the instrument could not measure, so
 * the policy refuses to pass. `holt gate` already had this right, returning 2 for unknown.
 */
test('CI: a shallow clone cannot pass a policy it could not verify', async (t) => {
  const fx = await graveyardFixture();
  t.after(() => fx.cleanup());

  const shallowDir = path.join(path.dirname(fx.root), `shallow-${Date.now()}`);
  t.after(() => fs.rm(shallowDir, { recursive: true, force: true }));
  // `file://` forces the transport — a plain local clone HARDLINKS and ignores --depth entirely,
  // which silently produces a full clone and a test that proves nothing. Measured while writing
  // this: `git clone --depth 1 <path>` gave 218 commits.
  await sh('git', ['clone', '-q', '--depth', '1', `file://${fx.root}`, shallowDir], path.dirname(fx.root));

  const isShallow = await sh('git', ['rev-parse', '--is-shallow-repository'], shallowDir);
  assert.equal(isShallow.stdout.trim(), 'true',
    'PREMISE: the fixture must actually be shallow, or this test proves nothing');

  // A shallow clone REFUSES (exit 2) rather than reporting a green it could not verify. The
  // history completeness check fires before any mode branch, so this is the same for inline
  // flags, policy, and report-only — a shallow clone cannot answer the question at all.
  const strict = await sh(process.execPath, [BIN, 'ci', '--fail-on-unlanded', '--json', '--cwd', shallowDir], shallowDir);
  assert.equal(strict.code, 2, `a shallow clone must REFUSE, not pass: ${strict.stdout}`);
  const body = JSON.parse(strict.stdout);
  assert.equal(body.ok, false);
  assert.equal(body.code, 'incomplete-history:shallow');
  assert.match(`${body.reason} ${body.fix}`, /fetch-depth: 0/,
    'the refusal must name the fix, so a CI log tells someone what to change');
});

test('CI: NEVER-WORSE — report-only on a shallow clone still REFUSES, and says it was shallow', async (t) => {
  const fx = await graveyardFixture();
  t.after(() => fx.cleanup());

  const shallowDir = path.join(path.dirname(fx.root), `shallow-ro-${Date.now()}`);
  t.after(() => fs.rm(shallowDir, { recursive: true, force: true }));
  await sh('git', ['clone', '-q', '--depth', '1', `file://${fx.root}`, shallowDir], path.dirname(fx.root));

  // Report-only mode also refuses on a shallow clone: a green from a shallow clone is the worst
  // failure this command has, because it tells a team they are protected when the gate could not
  // see anything. The refusal is a property of the EVIDENCE, not of the flags.
  const plain = await sh(process.execPath, [BIN, 'ci', '--json', '--cwd', shallowDir], shallowDir);
  assert.equal(plain.code, 2, `report-only must refuse on shallow: ${plain.stderr}`);
  const body = JSON.parse(plain.stdout);
  assert.equal(body.ok, false);
  assert.equal(body.code, 'incomplete-history:shallow');
});
