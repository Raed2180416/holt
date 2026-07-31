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
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Pinned upstream release. `latest` is deliberately NOT used: it would silently change what a
 * given holt version installs, and the checksums below would go stale the moment upstream builds.
 */
const CTAGS_TAG = '2026.07.28+45e7781196f227cc8503e57d0ee45312205dcd28';
const CTAGS_BASE = `https://github.com/universal-ctags/ctags-nightly-build/releases/download/${CTAGS_TAG}`;

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
  return { key, url: `${CTAGS_BASE}/${asset.file}`, file: asset.file, sha256: asset.sha256 };
}

let _pathEnsured = false;

/**
 * Put holt's own bin directory on PATH for this process, so every `execFile('ctags', …)` finds a
 * portable install without a single call site changing. Idempotent and cheap.
 */
export async function ensureOnPath() {
  if (_pathEnsured) return false;
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

const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 180_000, maxBuffer: 32 * 1024 * 1024, ...opts },
    (err, stdout, stderr) => resolve({ code: err?.code ?? (err ? 1 : 0), stdout: String(stdout || ''), stderr: String(stderr || '') }));
});

/**
 * Download the pinned static ctags for this platform into holt's own bin directory.
 *
 * @param {(msg: string) => void} log  progress sink, so the CLI can narrate without this module
 *                                     importing anything that knows about terminals
 * @returns {Promise<{ok: boolean, reason?: string, binary?: string, version?: string}>}
 */
export async function installPortableCtags(log = () => {}) {
  const target = portableTarget();
  if (!target) {
    return { ok: false, reason: `no portable ctags build for ${process.platform}-${process.arch} — install universal-ctags with your package manager` };
  }

  const dir = holtBinDir();
  await fs.mkdir(dir, { recursive: true });
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-toolchain-'));
  const archive = path.join(work, target.file);

  try {
    log(`downloading ${target.file}`);
    // fetch is used rather than curl/wget so this works identically on Windows, where neither is
    // guaranteed to be present.
    let bytes;
    try {
      const res = await fetch(target.url, { redirect: 'follow' });
      if (!res.ok) return { ok: false, reason: `download failed: HTTP ${res.status}` };
      bytes = Buffer.from(await res.arrayBuffer());
    } catch (e) {
      return { ok: false, reason: `download failed: ${e.message} (offline, or a proxy is blocking github.com)` };
    }

    const got = createHash('sha256').update(bytes).digest('hex');
    if (got !== target.sha256) {
      // REFUSE. Not a warning, not a prompt. holt exists to protect work; executing bytes whose
      // identity it cannot confirm would be the single worst thing this file could do.
      return {
        ok: false,
        reason: `checksum mismatch — REFUSING to install.\n      expected ${target.sha256}\n      got      ${got}\n      This means the download was corrupted or tampered with in transit.`,
      };
    }
    log('checksum verified');

    await fs.writeFile(archive, bytes);
    // bsdtar (macOS, Windows 10+) and GNU tar (Linux) all extract .tar.xz with the same flags.
    const ex = await run('tar', ['-xf', archive, '-C', work]);
    if (ex.code !== 0) return { ok: false, reason: `extract failed (is 'tar' available?): ${ex.stderr.trim()}` };

    // The archive nests under a versioned directory; find the binary wherever it landed.
    const found = await findFile(work, process.platform === 'win32' ? 'ctags.exe' : 'ctags');
    if (!found) return { ok: false, reason: 'archive did not contain a ctags binary' };

    const dest = path.join(dir, path.basename(found));
    await fs.copyFile(found, dest);
    if (process.platform !== 'win32') await fs.chmod(dest, 0o755);

    // PROVE IT RUNS before claiming success. An install that produced an unusable binary would
    // otherwise be reported as a fix and discovered later as silence.
    const v = await run(dest, ['--version']);
    if (v.code !== 0 || !/Universal Ctags/i.test(v.stdout)) {
      return { ok: false, reason: `installed binary does not run here: ${(v.stderr || v.stdout).trim().slice(0, 200)}` };
    }
    _pathEnsured = false;
    await ensureOnPath();
    return { ok: true, binary: dest, version: (v.stdout.match(/Universal Ctags ([^,\n]+)/i) || [])[1] || 'unknown' };
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

async function findFile(root, name, depth = 0) {
  if (depth > 6) return null;
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isFile() && e.name === name) return p;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const hit = await findFile(path.join(root, e.name), name, depth + 1);
    if (hit) return hit;
  }
  return null;
}
