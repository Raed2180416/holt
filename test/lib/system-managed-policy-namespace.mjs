// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * Linux-only system-authority test launcher.
 *
 * No shipped code contains a fixture authority seam. Instead, the real suite runs as uid 0 in an
 * unprivileged user namespace and bind-mounts a disposable directory over /etc in a private mount
 * namespace. The production fixed path and ownership checks therefore remain exactly the checks
 * under test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NAMESPACE_ENV = 'HOLT_SYSTEM_MANAGED_POLICY_TEST_NAMESPACE';
export const inSystemManagedPolicyNamespace = process.env[NAMESPACE_ENV] === '1';
// The outer process registers one wrapper test; inner cases are not misleadingly reported as
// skipped because they execute (and must pass) in the child runner.
const omitInnerRegistration = () => undefined;
export const systemManagedPolicyTest = inSystemManagedPolicyNamespace ? test : omitInnerRegistration;

const execute = (command, args, options) => new Promise((resolve) => {
  execFile(command, args, options, (error, stdout, stderr) => resolve({
    code: error ? (error.code ?? 1) : 0,
    signal: error?.signal ?? null,
    stdout: String(stdout ?? ''),
    stderr: String(stderr ?? ''),
  }));
});

async function makeWritable(entry) {
  const stat = await fs.lstat(entry).catch(() => null);
  if (!stat || stat.isSymbolicLink()) return;
  if (!stat.isDirectory()) {
    await fs.chmod(entry, 0o600);
    return;
  }
  await fs.chmod(entry, 0o700);
  for (const name of await fs.readdir(entry)) await makeWritable(path.join(entry, name));
}

/** Register one outer test that executes this test file inside the private system namespace. */
export function registerSystemManagedPolicyNamespace(testFileUrl, label) {
  if (inSystemManagedPolicyNamespace) return;
  test(label, { skip: process.platform !== 'linux' && 'Linux user/mount namespaces are required' }, async (t) => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-system-policy-namespace-'));
    const privateEtc = path.join(fixture, 'etc');
    const workspaceMount = path.join(fixture, 'workspace');
    await fs.mkdir(privateEtc, { mode: 0o700 });
    await fs.mkdir(workspaceMount, { mode: 0o700 });
    t.after(async () => {
      await makeWritable(fixture).catch(() => {});
      await fs.rm(fixture, { recursive: true, force: true });
    });

    // A nested `node --test` must not inherit its parent's private reporter channel: inherited
    // NODE_TEST_CONTEXT can make a failing nested suite exit zero. The child test runner creates
    // its own context after unshare starts it.
    const env = { ...process.env, [NAMESPACE_ENV]: '1' };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_TEST_PIPE;
    const source = fileURLToPath(testFileUrl);
    // The outer test may itself be running from a temporary bind path, while process.cwd()
    // still names the original checkout. Derive the stable repository-relative test path from
    // the final `/test/` segment instead of joining two unrelated absolute path namespaces.
    const normalizedSource = source.split(path.sep).join('/');
    const testMarker = '/test/';
    const markerIndex = normalizedSource.lastIndexOf(testMarker);
    const relativeSource = markerIndex >= 0
      ? normalizedSource.slice(markerIndex + 1)
      : path.relative(process.cwd(), source).split(path.sep).join('/');
    const namespaceArgs = (isolationMode) => [
      'sh',
      '-c',
      // Make the private mount tree non-propagating before replacing /etc. The ordinary
      // user+mount namespace path already has an isolated root; the sudo fallback below needs
      // this explicit boundary because a root mount namespace may otherwise inherit shared
      // propagation from the runner.
      // Keep the inherited working-directory inode. Some hosted runners expose the checkout
      // through a mount that is reachable by the child only as its inherited cwd, not by the
      // runner's absolute path after sudo creates the private mount namespace. Bind that inode
      // to a stable path before starting Node; otherwise Node resolves a relative test path
      // against a cwd whose absolute name is not addressable in the root mount namespace.
      'mount --make-rprivate / && mount --bind "$1" /etc && workspace="$2" && marker="$8" && if [ -n "$marker" ]; then export NODE_TEST_CONTEXT="$marker"; fi && mount --bind /proc/self/cwd "$workspace" && shift 2 && exec "$1" "$2" "$3" "$4" "$workspace/$5"',
      'holt-system-policy-namespace',
      privateEtc,
      workspaceMount,
      process.execPath,
      '--test',
      '--test-concurrency=1',
      isolationMode === 'process' ? '--experimental-test-isolation=process' : '--experimental-test-isolation=none',
      relativeSource,
      isolationMode === 'process' ? '' : 'child-holt-namespace',
    ];
    const runNamespace = (command, args, runEnv = env) => execute(command, args, {
      cwd: process.cwd(),
      env: runEnv,
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    // GitHub-hosted Linux runners allow passwordless sudo but reject unprivileged user
    // namespaces. Try the single root-owned mount namespace first; this also avoids a failed
    // user-namespace attempt changing the mount/user context in which sudo resolves the runner.
    // Its child runner is serialized because these hosted mounts deny Node's process-isolation
    // re-exec. Developers without sudo still get the stronger process-isolated user namespace.
    const namespaceUnavailable = (output) => /(?:uid_map|user namespaces?|mount namespaces?|operation not permitted|permission denied|EACCES|ENOENT|sudo:)/iu.test(output);
    let result = await runNamespace('sudo', ['-n', 'unshare', '-m', ...namespaceArgs('none')]);
    if (result.code !== 0 && namespaceUnavailable(`${result.stdout}\n${result.stderr}`)) {
      result = await runNamespace('unshare', ['-Urm', ...namespaceArgs('process')]);
    }
    // GitHub-hosted runners and some hardened developer machines disable unprivileged user or
    // mount namespaces. That is a host capability, not a managed-policy product failure. Keep
    // the test authoritative where the real namespace exists, and record an explicit skip when
    // the kernel refuses the namespace before the inner suite can execute.
    if (result.code !== 0 && namespaceUnavailable(`${result.stdout}\n${result.stderr}`)) {
      return t.skip(`Linux user/mount namespaces unavailable on this runner: ${result.stderr.trim()}`);
    }
    assert.equal(
      result.code,
      0,
      `private system-authority suite failed (signal ${result.signal ?? 'none'})\n${result.stdout}\n${result.stderr}`,
    );
  });
}
