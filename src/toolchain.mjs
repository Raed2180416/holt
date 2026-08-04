// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — getting the optional backends onto a machine that does not have them.
 *
 * WHY A PORTABLE PATH EXISTS AT ALL. `holt doctor --install` shells out to the system package
 * manager (apt/dnf/pacman/brew/winget), which is the right first choice: system-wide, updatable,
 * and the user's own tooling. But it needs a package manager to be present AND the user to have
 * administrator rights, and the two platforms where holt most often lands without ctags — a
 * locked-down macOS laptop and a corporate Windows box — are exactly where one or both is
 * missing. Telling those users "install ctags yourself" is conceding the capability, and the
 * consequence is not cosmetic: with no ctags, holt falls back to regex extraction and silently
 * relates less work across worktrees.
 *
 * So there is a second path that needs neither: universal-ctags publishes fully static,
 * dependency-free binaries. holt downloads one into its OWN directory and puts that directory on
 * PATH for its own child processes. Nothing system-wide is touched, no elevation is required, and
 * uninstalling is deleting a folder.
 *
 * EVERY DOWNLOAD IS PINNED AND VERIFIED. The release tag is fixed (not "latest", which would make
 * the bytes change under a fixed holt version), and each asset carries a SHA-256 measured from
 * the upstream release. A mismatch REFUSES — it never falls back to "well, run it anyway",
 * because a tool whose job is protecting your work must not execute bytes it cannot identify.
 *
 * WHY THE DOWNLOADER LIVES IN bin/, NOT HERE. holt claims the free tool makes no network calls,
 * and that claim is enforced absolutely by test/unit/no-network.test.mjs, which asserts src/
 * imports no network-capable module and contains no call site — a capability check, not a text
 * search, so it cannot be satisfied by an allowlist of "approved" hosts. That absoluteness is the
 * point: anyone can verify it in one command, with no trust in our judgement about which calls are
 * benign. So this file holds only the parts that
 * touch no network (where the binary lives, putting it on PATH, what this platform would need),
 * and bin/install-ctags.mjs holds the fetch. The analysis engine stays provably offline; the
 * capability is not conceded.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Pinned upstream release. `latest` is deliberately NOT used: it would silently change what a
 * given holt version installs, and the checksums below would go stale the moment upstream builds.
 */
const CTAGS_TAG = '2026.07.28+45e7781196f227cc8503e57d0ee45312205dcd28';
const CTAGS_BASE = `https://github.com/universal-ctags/ctags-nightly-build/releases/download/${CTAGS_TAG}`;

// Windows builds come from a different upstream repo (universal-ctags/ctags-win32) because the
// nightly-build repo does not produce Windows binaries. The win32 repo publishes daily builds as
// zip files; we pin a specific tag and verify the checksum the same way.
const CTAGS_WIN_TAG = 'p6.2.20260802.0';
const CTAGS_WIN_BASE = `https://github.com/universal-ctags/ctags-win32/releases/download/${CTAGS_WIN_TAG}`;

/** Measured from the upstream assets. A mismatch is a refusal, never a warning. */
const CTAGS_ASSETS = {
  'linux-x64': {
    file: 'uctags-2026.07.28-linux-x86_64.release.tar.xz',
    sha256: 'ede680a1f291f63ee535e0126a41e7053e0bcca2fafc6721f5346e4d6cac19d4',
  },
  'linux-arm64': {
    file: 'uctags-2026.07.28-linux-aarch64.release.tar.xz',
    sha256: '240b83ef771220040d58a41227b5603d02d25ec06395b8107648c8fe9b0e8f01',
  },
  'darwin-x64': {
    file: 'uctags-2026.07.28-macos-11.0-x86_64.release.tar.xz',
    sha256: '0bc2b3adb4588033667d96a47bb88b94d2825e1f863a13e71bfd74d398199cb8',
  },
  'darwin-arm64': {
    file: 'uctags-2026.07.28-macos-11.0-arm64.release.tar.xz',
    sha256: 'db28f3840777b50a2d29fa975a92d1a135c309231e3e9529ce455c8ea5e4c5a9',
  },
  'win32-x64': {
    file: `ctags-${CTAGS_WIN_TAG}-x64.zip`,
    sha256: '9189a0f4f7a31f3ba93d30c43229e0bf69bf7fa6bf8927b08511b909bd6e4677',
    zip: true,
    url: `${CTAGS_WIN_BASE}/ctags-${CTAGS_WIN_TAG}-x64.zip`,
  },
};

/** holt's own tool directory. Honours XDG on Linux; never writes outside the user's home. */
export function holtHome() {
  if (process.env.HOLT_HOME) return process.env.HOLT_HOME;
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'holt');
  }
  if (process.platform === 'linux' && process.env.XDG_DATA_HOME) {
    return path.join(process.env.XDG_DATA_HOME, 'holt');
  }
  return path.join(home, '.holt');
}

export function holtBinDir() { return path.join(holtHome(), 'bin'); }

/** What this machine would download, or null if holt ships no portable build for it. */
export function portableTarget() {
  const key = `${process.platform}-${process.arch}`;
  const asset = CTAGS_ASSETS[key];
  if (!asset) return null;
  // Windows assets have their own URL (different upstream repo); others use CTAGS_BASE.
  const url = asset.url || `${CTAGS_BASE}/${asset.file}`;
  return { key, url, file: asset.file, sha256: asset.sha256, zip: !!asset.zip };
}

let _pathEnsured = false;

/**
 * Put holt's own bin directory on PATH for this process, so every `execFile('ctags', …)` finds a
 * portable install without a single call site changing. Idempotent and cheap.
 */
export async function ensureOnPath({ force = false } = {}) {
  if (_pathEnsured && !force) return false;
  _pathEnsured = true;
  const dir = holtBinDir();
  const exe = path.join(dir, process.platform === 'win32' ? 'ctags.exe' : 'ctags');
  try {
    await fs.access(exe);
  } catch {
    return false; // nothing installed here — leave PATH alone
  }
  const sep = process.platform === 'win32' ? ';' : ':';
  const current = process.env.PATH || '';
  if (!current.split(sep).includes(dir)) process.env.PATH = `${dir}${sep}${current}`;
  return true;
}
