/**
 * holt — `unprotect --force`, the CLI escape hatch for a lock holt did not place.
 *
 * FINDING: the library's `unprotect()` always accepted a `force` option that silently released a
 * FOREIGN lock (one placed by a human or another tool), but the CLI never parsed a `--force` flag
 * at all — so a user who ran `holt unprotect` against a worktree they legitimately wanted to
 * release got `{ action: 'skipped-foreign-lock' }` and had NO documented way through it from the
 * command line. `--force` typed by hand was rejected outright with "unknown option: --force".
 *
 * holt's whole pitch is an aggressive guard. The ONLY thing that makes an aggressive guard
 * tolerable is a clean, obvious, escape hatch — without one, users disable holt entirely, which
 * is strictly worse than a slightly permissive guard. So this suite proves, against the REAL
 * binary (not the library function directly):
 *
 *   - the guard still refuses a foreign lock with no flag, and the refusal NAMES the way out
 *   - a bare `--force` (no --reason, no --yes) is refused too — a flag typed out of habit must
 *     not silently disarm someone else's protection — and NOTHING is touched when it is refused
 *   - `--force --reason "<why>"` releases the lock and journals the override, verbatim
 *   - `--force --yes` releases the lock without a written reason, and journals that plainly
 *   - releasing holt's OWN lock still needs no flag at all (no regression)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newRepo } from '../fixtures.mjs';
import { readJournal } from '../../src/journal.mjs';
import { protect } from '../../src/actions.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'holt.mjs');

function holt(args, cwd) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args, '--cwd', cwd, '--json'], {
      cwd, timeout: 60_000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1' },
    }, (err, stdout, stderr) => resolve({
      code: err ? (err.code ?? 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''),
    }));
  });
}

/** Whether git itself still reports `wtPath` as locked (ground truth, independent of holt). */
async function isLocked(root, wtPath) {
  const { execFile: ef } = await import('node:child_process');
  const out = await new Promise((resolve) => {
    ef('git', ['worktree', 'list', '--porcelain'], { cwd: root }, (_e, stdout) => resolve(String(stdout ?? '')));
  });
  const idx = out.indexOf(wtPath);
  if (idx === -1) return false;
  const rest = out.slice(idx);
  const nextWorktree = rest.indexOf('\nworktree ', 1);
  const block = nextWorktree === -1 ? rest : rest.slice(0, nextWorktree);
  return /\nlocked/.test(`\n${block}`);
}

test('UNPROTECT --force CLI: refuses a foreign lock with no flag, and NAMES the way out', async (t) => {
  const fx = await newRepo('unprotect-force-refuse');
  t.after(() => fx.cleanup());

  const wt = await fx.worktree('someones-worktree');
  await fx.write('src/only.js', 'export function ONLY() { return 1; }\n', wt);
  await fx.commit('unique work', wt);
  // A human (or another tool) locked this deliberately — NOT holt.
  await fx.git(['worktree', 'lock', '--reason', 'do-not-touch: mid-review', wt]);

  const r = await holt(['unprotect'], fx.root);
  assert.equal(r.code, 0, `holt unprotect must not crash on a foreign lock: ${r.stderr}`);
  const body = JSON.parse(r.stdout);
  const skipped = body.actions.find((a) => a.action === 'skipped-foreign-lock');
  assert.ok(skipped, `expected a skipped-foreign-lock action, got: ${r.stdout}`);

  // THE ACTUAL STRING A USER SEES: the refusal must name the flag, not just say "no".
  assert.match(skipped.hint ?? '', /--force/,
    `refusal must name --force so the user is never stuck: ${JSON.stringify(skipped)}`);
  assert.match(skipped.hint ?? '', /holt unprotect/,
    `refusal should show the actual command, not just the flag name: ${JSON.stringify(skipped)}`);

  assert.ok(await isLocked(fx.root, wt), 'the foreign lock must still be in place — nothing was touched');
  assert.deepEqual(await readJournal(fx.root), [], 'a refused override must not be journalled');
});

test('UNPROTECT --force CLI: bare --force (no --reason, no --yes) is refused before anything changes', async (t) => {
  const fx = await newRepo('unprotect-force-bare');
  t.after(() => fx.cleanup());

  const wt = await fx.worktree('someones-worktree');
  await fx.write('src/only.js', 'export function ONLY() { return 1; }\n', wt);
  await fx.commit('unique work', wt);
  await fx.git(['worktree', 'lock', '--reason', 'do-not-touch: mid-review', wt]);

  const r = await holt(['unprotect', '--force'], fx.root);
  assert.notEqual(r.code, 0, 'a bare --force must be refused, not silently honoured');
  assert.match(r.stderr, /--reason/, `refusal must tell the user how to supply a reason: ${r.stderr}`);
  assert.match(r.stderr, /--yes/, `refusal must also name the --yes alternative: ${r.stderr}`);

  assert.ok(await isLocked(fx.root, wt), 'nothing may be released when --force is refused for lack of justification');
  assert.deepEqual(await readJournal(fx.root), [], 'a refused override must not be journalled');
});

test('UNPROTECT --force CLI: --reason releases a foreign lock and is journalled verbatim', async (t) => {
  const fx = await newRepo('unprotect-force-reason');
  t.after(() => fx.cleanup());

  const wt = await fx.worktree('someones-worktree');
  await fx.write('src/only.js', 'export function ONLY() { return 1; }\n', wt);
  await fx.commit('unique work', wt);
  await fx.git(['worktree', 'lock', '--reason', 'do-not-touch: mid-review', wt]);

  const why = 'review finished in Slack, forgot to unlock';
  const r = await holt(['unprotect', '--force', '--reason', why], fx.root);
  assert.equal(r.code, 0, `--force --reason must succeed: ${r.stderr}`);
  const body = JSON.parse(r.stdout);
  assert.equal(body.unlocked, 1);
  assert.equal(body.actions[0].action, 'unlocked');

  assert.ok(!(await isLocked(fx.root, wt)), 'the lock must actually be released on disk');

  const events = await readJournal(fx.root);
  assert.equal(events.length, 1);
  const rec = events[0];
  assert.equal(rec.action, 'unprotect');
  assert.equal(rec.forced, true, 'the override must be journalled as forced');
  assert.equal(rec.foreignLock, true, 'the override must be journalled as touching a foreign lock');
  assert.equal(rec.overrideReason, why, "the human's own justification must be recorded verbatim");
});

test('UNPROTECT --force CLI: --yes confirms the override without a written reason', async (t) => {
  const fx = await newRepo('unprotect-force-yes');
  t.after(() => fx.cleanup());

  const wt = await fx.worktree('someones-worktree');
  await fx.write('src/only.js', 'export function ONLY() { return 1; }\n', wt);
  await fx.commit('unique work', wt);
  await fx.git(['worktree', 'lock', '--reason', 'do-not-touch: mid-review', wt]);

  const r = await holt(['unprotect', '--force', '--yes'], fx.root);
  assert.equal(r.code, 0, `--force --yes must succeed: ${r.stderr}`);
  const body = JSON.parse(r.stdout);
  assert.equal(body.unlocked, 1);
  assert.ok(!(await isLocked(fx.root, wt)));

  const events = await readJournal(fx.root);
  assert.equal(events.length, 1);
  assert.equal(events[0].forced, true);
  assert.equal(events[0].foreignLock, true);
  assert.equal(events[0].overrideReason, null, 'no reason was written, so none may be invented');
});

test('UNPROTECT: releasing holt\'s OWN lock still needs no flag at all (no regression)', async (t) => {
  const fx = await newRepo('unprotect-force-own-lock');
  t.after(() => fx.cleanup());

  const wt = await fx.worktree('holds-unique-work');
  await fx.write('src/only.js', 'export function ONLY() { return 1; }\n', wt);
  await fx.commit('unique work', wt);
  const p = await protect(fx.root, {});
  assert.equal(p.protected, 1, 'setup: holt must have locked this worktree itself');

  const r = await holt(['unprotect'], fx.root);
  assert.equal(r.code, 0, `holt's own lock must release without --force: ${r.stderr}`);
  const body = JSON.parse(r.stdout);
  assert.equal(body.unlocked, 1);
  assert.ok(!(await isLocked(fx.root, wt)));

  const events = await readJournal(fx.root);
  const rec = events.find((e) => e.action === 'unprotect');
  assert.ok(rec);
  assert.equal(rec.forced, false);
  assert.equal(rec.foreignLock, false);
});

test("UNPROTECT --force on holt's OWN locks is a no-op flag, NOT a refusal", async (t) => {
  // REFUTATION OF THE FIRST FIX, found by adversarial review: the justification gate fired on the
  // mere PRESENCE of `--force`, so `holt unprotect --force` against locks holt placed itself was
  // refused with exit 2 and the message "overriding a lock holt did not place needs
  // justification" — an assertion that is simply untrue of that invocation. Nothing was being
  // overridden; the flag changes nothing when every lock is holt's own.
  //
  // This is the failure mode the whole escape-hatch exists to avoid, arriving one level up:
  // refusing a legitimate action for a reason that does not apply to it is how a person learns
  // the tool cannot be trusted about when it says no, and then stops running it.
  const fx = await newRepo('unprotect-force-own-noop');
  t.after(() => fx.cleanup());

  const wt = await fx.worktree('holds-unique-work');
  await fx.write('src/only.js', 'export function ONLY() { return 1; }\n', wt);
  await fx.commit('unique work', wt);
  const p = await protect(fx.root, {});
  assert.equal(p.protected, 1, 'setup: holt must have locked this worktree itself');

  const r = await holt(['unprotect', '--force'], fx.root);
  assert.equal(r.code, 0,
    `--force over holt's own locks must not be refused (exit ${r.code}): ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /needs justification/,
    'a justification was demanded for an override that is not happening');

  const body = JSON.parse(r.stdout);
  assert.equal(body.unlocked, 1, `the lock should have been released: ${r.stdout}`);
  assert.ok(!(await isLocked(fx.root, wt)), 'git still reports the worktree as locked');
});

test('UNPROTECT --force: the foreign-lock probe RELEASES NOTHING while it counts', async (t) => {
  // The gate now runs a dry pass to decide whether justification is owed. A "probe" that mutates
  // is not a probe: it would release holt's own locks as a side effect of deciding whether to
  // refuse, and the refusal would then leave the repository half-unprotected.
  const fx = await newRepo('unprotect-force-probe-inert');
  t.after(() => fx.cleanup());

  const mine = await fx.worktree('holt-locks-this');
  await fx.write('src/a.js', 'export function A() { return 1; }\n', mine);
  await fx.commit('unique work', mine);

  const theirs = await fx.worktree('someone-else-locked-this');
  await fx.write('src/b.js', 'export function B() { return 2; }\n', theirs);
  await fx.commit('unique work', theirs);

  await protect(fx.root, {});
  await fx.git(['worktree', 'unlock', theirs]).catch(() => {});
  await fx.git(['worktree', 'lock', '--reason', 'human: mid-review', theirs]);

  const r = await holt(['unprotect', '--force'], fx.root);
  assert.match(r.stderr, /not placed by holt/, `expected the refusal, got: ${r.stderr}${r.stdout}`);

  // BOTH must still be locked. The refusal happens before anything is touched — including the
  // worktree the probe was perfectly entitled to unlock.
  assert.ok(await isLocked(fx.root, mine), "holt's own lock was released by the probe");
  assert.ok(await isLocked(fx.root, theirs), 'the foreign lock was released despite the refusal');
});
