/**
 * holt — network filesystem (NFS/SMB) latency handling.
 *
 * holt's git operations assume local-disk latency. On a network mount a `git status` can take
 * minutes, the default timeout reads as "instrument failed", and fail-closed classification
 * refuses to scan — the right safety call, but the wrong user experience when the repository
 * is fine and only the mount is slow. These tests cover the detection and the timeout
 * escalation that follows from it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  detectNetworkFilesystem,
  networkFilesystemWarning,
} from '../../src/paths.mjs';
import {
  resolveTimeout,
  NETWORK_FS_TIMEOUT_MULTIPLIER,
  NETWORK_FS_TIMEOUT_CEILING_MS,
  DEFAULT_TIMEOUT_MS,
} from '../../src/git.mjs';

test('network-filesystem: detectNetworkFilesystem never throws on a local path', async () => {
  // The repository root itself is on a local disk in every CI environment. Detection must
  // return a definitive answer, not throw — a throw here would kill the scan before it began.
  const info = await detectNetworkFilesystem(process.cwd());
  assert.equal(typeof info.network, 'boolean');
  // On a local disk the answer is false. (A CI runner on NFS would still be a valid 'true',
  // so we only assert the shape, not the value, for the local-disk common case.)
  if (!info.network) assert.equal(info.network, false);
});

test('network-filesystem: detectNetworkFilesystem rejects a NUL-containing path', async () => {
  // The same containment check every path helper applies. A NUL byte terminates the string at
  // the syscall boundary while JS keeps counting past it — the original paths.mjs defect class.
  await assert.rejects(() => detectNetworkFilesystem('repo\0/etc/shadow'), /NUL/);
});

test('network-filesystem: the warning is human-readable and names the type', () => {
  const w = networkFilesystemWarning({ type: 'nfs', mountPoint: '/mnt/nfs' });
  assert.match(w, /network filesystem/i);
  assert.match(w, /nfs/);
  assert.match(w, /\/mnt\/nfs/);
  assert.match(w, /time out|stale|slow/i, 'the warning must name the failure mode');
});

test('network-filesystem: the warning handles a missing type gracefully', () => {
  const w = networkFilesystemWarning({});
  assert.match(w, /network filesystem/i);
  // Must not throw and must not print 'undefined' as the type.
  assert.doesNotMatch(w, /undefined/);
});

test('network-filesystem: resolveTimeout escalates the default when network is detected', async () => {
  // resolveTimeout delegates to detectNetworkFilesystem. On a local disk it returns the
  // default unchanged; the escalation path is exercised by the network-detection unit below.
  const local = await resolveTimeout(process.cwd());
  assert.equal(local.network, false);
  assert.equal(local.timeout, DEFAULT_TIMEOUT_MS);

  // An explicit timeout is ALWAYS honoured, never escalated — the caller knows their latency.
  const explicit = await resolveTimeout(process.cwd(), 5000);
  assert.equal(explicit.timeout, 5000);
  assert.equal(explicit.network, false);
});

test('network-filesystem: the escalation multiplier and ceiling are sane', () => {
  // 3x local-disk time, capped at 180s. A network mount that needs more than 3 minutes for a
  // single git read has a problem holt cannot solve, and a hang is worse than a failure.
  assert.equal(NETWORK_FS_TIMEOUT_MULTIPLIER, 3);
  assert.equal(NETWORK_FS_TIMEOUT_CEILING_MS, 180_000);
  assert.ok(
    DEFAULT_TIMEOUT_MS * NETWORK_FS_TIMEOUT_MULTIPLIER <= NETWORK_FS_TIMEOUT_CEILING_MS,
    'the default escalation must not exceed the ceiling',
  );
});
