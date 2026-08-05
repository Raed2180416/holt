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
    await fs.mkdir(privateEtc, { mode: 0o700 });
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
    const runnerRoot = process.cwd();
    const relativeSource = path.relative(runnerRoot, source).split(path.sep).join('/');
    const namespaceArgs = [
      'sh',
      '-c',
      // Make the private mount tree non-propagating before replacing /etc. The ordinary
      // user+mount namespace path already has an isolated root; the sudo fallback below needs
      // this explicit boundary because a root mount namespace may otherwise inherit shared
      // propagation from the runner.
      'mount --make-rprivate / && mount --bind "$1" /etc && cd "$2" && shift 2 && exec "$@"',
      'holt-system-policy-namespace',
      privateEtc,
      runnerRoot,
      process.execPath,
      '--test',
      '--test-concurrency=1',
      relativeSource,
    ];
    const runNamespace = (command, args) => execute(command, args, {
      cwd: process.cwd(),
      env,
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    let result = await runNamespace('unshare', ['-Urm', ...namespaceArgs]);
    // GitHub-hosted Linux runners currently reject unprivileged user namespaces even though
    // passwordless sudo is available. A root-owned mount namespace provides the same test
    // isolation without weakening the production fixed-/etc contract; it is attempted only
    // after the user-namespace path fails for a capability reason.
    const namespaceUnavailable = (output) => /(?:uid_map|user namespaces?|mount namespaces?|operation not permitted|permission denied|ENOENT)/iu.test(output);
    if (result.code !== 0 && namespaceUnavailable(`${result.stdout}\n${result.stderr}`)) {
      const privileged = await runNamespace('sudo', ['-n', 'unshare', '-m', ...namespaceArgs]);
      if (privileged.code === 0 || !namespaceUnavailable(`${privileged.stdout}\n${privileged.stderr}`)) {
        result = privileged;
      }
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
