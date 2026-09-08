/**
 * Holt's live ownership boundary: content inspection protects bytes that exist; these tests prove
 * a cooperating session can also protect a clean worktree while its next edit is still off disk.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { newRepo } from '../fixtures.mjs';
import { discover } from '../../src/discover.mjs';
import { scan } from '../../src/scan.mjs';
import { analyze } from '../../src/analyze.mjs';
import { clean, unprotect } from '../../src/actions.mjs';
import { landingOrder } from '../../src/order.mjs';
import { cachedReport, buildBrief, assessCommand } from '../../src/agent.mjs';
import {
  inspectWorktreeOwnership, operateWorktreeOwnership, ownershipTarget,
} from '../../src/ownership.mjs';

const inspect = async (root) => analyze(await scan(await discover(root), {}), {});

test('OWNERSHIP: a crashed internal operation releases its mutex without abandoning a session claim', async (t) => {
  const fx = await newRepo('ownership-crashed-operation');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('interrupted');
  const script = `
    import { withUnclaimedWorktreeOwnership } from ${JSON.stringify(new URL('../../src/ownership.mjs', import.meta.url).href)};
    await withUnclaimedWorktreeOwnership(${JSON.stringify(wt)}, async () => {
      process.send({ phase: 'locked' });
      await new Promise(() => setInterval(() => {}, 1000));
    });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`lock holder exited before acquisition: ${code}: ${stderr}`)));
  });
  const competing = await operateWorktreeOwnership(wt, { operation: 'claim', owner: 'session-a' });
  assert.equal(competing.code, 'busy', 'a live critical section still excludes a competing claim');
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  const claimed = await operateWorktreeOwnership(wt, { operation: 'claim', owner: 'session-a' });
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  assert.equal((await inspectWorktreeOwnership(wt)).owner, 'session-a');
  assert.equal((await inspect(fx.root)).safe.find((row) => row.id === 'interrupted').safe, false,
    'recovering an internal mutex does not release the actual session claim');
});

test('OWNERSHIP: claim, heartbeat, handoff and release protect an otherwise-clean linked worktree', async (t) => {
  const fx = await newRepo('ownership-lifecycle');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('mid-edit');
  const removeCommand = `rm -rf ${JSON.stringify(wt)}`;
  assert.equal((await assessCommand(removeCommand, fx.root)).decision, 'allow',
    'the hook permits an otherwise-disposable unclaimed worktree');

  assert.equal((await inspect(fx.root)).safe.find((row) => row.id === 'mid-edit').safe, true,
    'an unclaimed clean worktree retains ordinary disposition');
  assert.ok((await clean(fx.root)).wouldQuarantine.some((row) => row.id === 'mid-edit'),
    'ordinary cleanup can select the unclaimed worktree');

  const claimed = await operateWorktreeOwnership(wt, {
    operation: 'claim', owner: 'codex:session-a', ttlSeconds: 60,
  });
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  assert.equal(claimed.action, 'claimed');
  assert.equal(claimed.ownership.state, 'active');

  const report = await inspect(fx.root);
  const verdict = report.safe.find((row) => row.id === 'mid-edit');
  assert.equal(verdict.safe, false, JSON.stringify(verdict));
  assert.equal(verdict.confidence, 'measured');
  assert.equal(verdict.ownership?.owner, 'codex:session-a');
  assert.match(verdict.reasons.join('\n'), /actively owned/i);
  assert.notEqual((await assessCommand(removeCommand, fx.root)).decision, 'allow',
    'the actual pre-tool guard respects the session claim');
  assert.ok(!report.plan.order.some((row) => row.id === 'mid-edit'),
    'an active clean session is not promoted into the landing plan');
  assert.ok(report.plan.excluded.some((row) => row.id === 'mid-edit' && /owner|session/i.test(row.reason)),
    'the landing plan explains why the live session is deferred');
  assert.ok(!landingOrder(report).parallel.includes('mid-edit'),
    'a live session cannot be recommended for parallel landing');
  assert.ok(landingOrder(report).excluded.some((row) => row.id === 'mid-edit' && /owner|session/i.test(row.reason)));

  const unprotected = await unprotect(fx.root, { id: 'mid-edit' });
  assert.equal(unprotected.unlocked, 0, 'content unprotection cannot end a session ownership lock');

  // The lease is not merely a Holt convention: for linked worktrees it also uses Git's own lock,
  // so a normal force removal is refused before a person can lose the live session by accident.
  await assert.rejects(
    () => fx.git(['worktree', 'remove', '--force', wt]),
    /locked working tree|lock reason/i,
  );

  const renewed = await operateWorktreeOwnership(wt, {
    operation: 'heartbeat', owner: 'codex:session-a', ttlSeconds: 60,
  });
  assert.equal(renewed.ok, true, JSON.stringify(renewed));
  assert.equal((await cachedReport(fx.root)).report.graph.nodes.find((row) => row.id === 'mid-edit').ownership.owner,
    'codex:session-a');
  const handedOff = await operateWorktreeOwnership(wt, {
    operation: 'handoff', owner: 'codex:session-a', toOwner: 'codex:session-b', ttlSeconds: 60,
  });
  assert.equal(handedOff.ok, true, JSON.stringify(handedOff));
  assert.equal(handedOff.ownership.owner, 'codex:session-b');
  assert.equal((await inspectWorktreeOwnership(wt)).owner, 'codex:session-b');
  assert.equal((await cachedReport(fx.root)).report.graph.nodes.find((row) => row.id === 'mid-edit').ownership.owner,
    'codex:session-b', 'a handoff invalidates hook context even when Git and working bytes did not change');
  assert.match(await buildBrief(fx.root), /codex:session-b/, 'normal hook context identifies the current owner');

  const released = await operateWorktreeOwnership(wt, {
    operation: 'release', owner: 'codex:session-b', ttlSeconds: 60,
  });
  assert.equal(released.ok, true, JSON.stringify(released));
  assert.equal(released.ownership.state, 'unclaimed');
  assert.equal(released.nativeGitLockReleased, true);
  const locks = await fx.git(['worktree', 'list', '--porcelain']);
  assert.doesNotMatch(locks, /holt: live ownership lease/, 'release must remove only its matching Git lock');
  assert.equal((await inspect(fx.root)).safe.find((row) => row.id === 'mid-edit').safe, true,
    'release restores ordinary disposition without leaving a stale hold');
  assert.ok((await clean(fx.root)).wouldQuarantine.some((row) => row.id === 'mid-edit'),
    'cleanup can select the worktree again after release');
  assert.equal((await assessCommand(removeCommand, fx.root)).decision, 'allow',
    'the hook resumes ordinary disposition after release');
});

test('OWNERSHIP: expired and malformed records block cleanup until an explicit, journalled takeover', async (t) => {
  const fx = await newRepo('ownership-review');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('needs-review');
  const target = await ownershipTarget(wt);
  assert.equal(target.ok, true, JSON.stringify(target));

  const expired = {
    version: 1, worktreeKey: target.key, owner: 'interrupted-session', nativeLockToken: null,
    claimedAt: '2026-01-01T00:00:00.000Z', heartbeatAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T00:01:00.000Z',
  };
  await fs.mkdir(path.join(target.root, 'records'), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(target.root, 'records', `${target.key}.json`), `${JSON.stringify(expired)}\n`, { mode: 0o600 });

  const report = await inspect(fx.root);
  const verdict = report.safe.find((row) => row.id === 'needs-review');
  assert.equal(verdict.safe, false, JSON.stringify(verdict));
  assert.equal(verdict.confidence, 'unknown');
  assert.equal(verdict.ownership?.state, 'expired');

  const refused = await operateWorktreeOwnership(wt, {
    operation: 'claim', owner: 'new-session', ttlSeconds: 60,
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'expired-needs-takeover');
  const noReason = await operateWorktreeOwnership(wt, {
    operation: 'claim', owner: 'new-session', ttlSeconds: 60, takeover: true,
  });
  assert.equal(noReason.ok, false);
  assert.equal(noReason.code, 'takeover-reason-required');
  const taken = await operateWorktreeOwnership(wt, {
    operation: 'claim', owner: 'new-session', ttlSeconds: 60, takeover: true,
    reason: 'the original session was deliberately retired after review',
  });
  assert.equal(taken.ok, true, JSON.stringify(taken));
  assert.equal(taken.action, 'taken-over');

  // A malformed record has no trustworthy owner who can release it. It must remain blocked,
  // but an accountable person can recover with the same explicit takeover path.
  await fs.writeFile(path.join(target.root, 'records', `${target.key}.json`), '{not-json}\n', { mode: 0o600 });
  assert.equal((await inspectWorktreeOwnership(wt)).state, 'invalid');
  const malformed = await operateWorktreeOwnership(wt, {
    operation: 'claim', owner: 'recovery-session', ttlSeconds: 60,
  });
  assert.equal(malformed.code, 'invalid-needs-takeover');
  const recovered = await operateWorktreeOwnership(wt, {
    operation: 'claim', owner: 'recovery-session', ttlSeconds: 60, takeover: true,
    reason: 'replace malformed local ownership record after review',
  });
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(recovered.ownership.owner, 'recovery-session');
});

test('OWNERSHIP: a claim arriving after clean re-verification wins the final move race', async (t) => {
  const fx = await newRepo('ownership-clean-race');
  t.after(() => fx.cleanup());
  const wt = await fx.worktree('about-to-edit');

  const result = await clean(fx.root, {
    apply: true,
    onAfterVerify: async (candidate) => {
      if (candidate.id === 'about-to-edit') {
        const claim = await operateWorktreeOwnership(candidate.path, {
          operation: 'claim', owner: 'arrived-during-clean', ttlSeconds: 60,
        });
        assert.equal(claim.ok, true, JSON.stringify(claim));
      }
    },
  });

  assert.ok(await fs.stat(wt), 'the session claimed the tree before its recoverable move');
  assert.equal(result.quarantined, 0, JSON.stringify(result));
  assert.ok(result.skipped.some((row) => row.id === 'about-to-edit' && /ownership prevents cleanup/i.test(row.why)), JSON.stringify(result));
  assert.equal((await inspectWorktreeOwnership(wt)).state, 'active');
});
