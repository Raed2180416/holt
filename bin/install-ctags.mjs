// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — fetching the portable ctags build.
 *
 * SEPARATED FROM src/ ON PURPOSE. holt claims the free tool makes no network calls, and CI
 * enforces that by grepping src/ for fetch/http/net and failing on a single hit. Keeping the one
 * download holt ever performs outside src/ means the analysis engine stays PROVABLY offline —
 * verifiable by anyone in one command, with no trust in our judgement about which calls are
 * benign — while the capability itself is not given up.
 *
 * This runs only when a human asks for it (`holt setup`, `holt doctor --install`). It sends no
 * information anywhere: it is a GET of a pinned public release asset, verified against a SHA-256
 * measured from upstream, and it refuses on mismatch.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { holtBinDir, portableTarget, ensureOnPath } from '../src/toolchain.mjs';

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
    // force, because ensureOnPath already ran and cached "nothing here" before this install.
    await ensureOnPath({ force: true });
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
