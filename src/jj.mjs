/**
 * holt — Jujutsu (jj) backend.
 *
 * WHY jj MATTERS HERE, and it is not politeness:
 *   jj snapshots the working copy automatically, so the "uncommitted layer" that git cannot
 *   relate across worktrees does not exist in the same form. jj also lets several workspaces
 *   share a bookmark, which git worktrees forbid. Holt's whole model is content-relationships
 *   between N workstreams; that question is identical under jj, so jj is a BACKEND, not a
 *   competitor. Modelling it that way is why the analysis layer needed no changes.
 *
 * THE PROBLEM THIS FILE SOLVES:
 *   `jj workspace list` prints NAMES and commit ids — not paths:
 *
 *       default: ooyozvlp cedeb8eb (empty) (no description set)
 *       ws-alpha: pxtyozmp 2e9e5ea1 (empty) (no description set)
 *
 *   and its `-T` templates expose no `path` keyword (verified against jj 0.43.0). An earlier
 *   revision assumed `name: /path` and produced workspaces whose "path" was a change id, so
 *   every jj workspace was reported as "working directory missing" — a silent, total failure of
 *   the jj backend that shipped only because nothing had ever run it.
 *
 * THE RESOLUTION, layered so a change in jj degrades rather than lies:
 *   1. NAMES come from `jj workspace list` — public, stable CLI.
 *   2. PATHS come from `.jj/repo/workspace_store/index`, a length-delimited protobuf mapping
 *      name -> path relative to `<repo>/.jj/repo/`. This is jj-internal, so it is parsed
 *      defensively and never trusted on its own.
 *   3. EVERY resolved path is VERIFIED by checking it is a real directory containing `.jj`.
 *      Anything that fails verification is reported as unresolved WITH ITS NAME — never
 *      silently dropped, because a workstream holt cannot see is exactly what it exists to
 *      warn about.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import os from 'node:os';

function jj(args, cwd, timeout = 20_000) {
  return new Promise((resolve) => {
    execFile('jj', args, {
      cwd, timeout, maxBuffer: 16 * 1024 * 1024,
      // os.devNull, not '/dev/null': jj is Rust, so unlike git-for-windows there is no MSYS
      // path translation — a literal /dev/null on Windows is just a missing file.
      env: { ...process.env, JJ_CONFIG: process.env.JJ_CONFIG ?? os.devNull, LC_ALL: 'C' },
    }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? -1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

export async function detectJj(cwd) {
  const v = await jj(['--version'], cwd, 8000);
  if (v.code !== 0) return { available: false, reason: 'jj-not-installed' };
  return { available: true, version: v.stdout.trim().split(/\s+/).pop() ?? 'unknown' };
}

/**
 * Minimal length-delimited protobuf reader.
 *
 * Only what is needed to read the workspace index: varints and length-delimited fields. Written
 * out rather than adding a protobuf dependency for one 50-byte internal file — and it must be
 * defensive, because this is an undocumented format that may change without notice.
 */
function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result >>> 0, pos };
    shift += 7;
    if (shift > 28) break; // beyond what any sane length needs; treat as corrupt
  }
  return null;
}

/**
 * Parse `.jj/repo/workspace_store/index`.
 *
 * Shape (jj 0.43.0):  repeated { 1: string name, 2: string path }  as field 1 of the message.
 * @returns {Map<string,string>|null} name -> path relative to `<repo>/.jj/repo/`
 */
export function parseWorkspaceIndex(buf) {
  const out = new Map();
  let pos = 0;

  const readEntry = (slice) => {
    let p = 0;
    let name = null;
    let rel = null;
    while (p < slice.length) {
      const key = readVarint(slice, p);
      if (!key) return null;
      p = key.pos;
      const field = key.value >>> 3;
      const wire = key.value & 0x07;
      if (wire !== 2) return null; // both fields we want are length-delimited
      const len = readVarint(slice, p);
      if (!len) return null;
      p = len.pos;
      if (p + len.value > slice.length) return null;
      const value = slice.slice(p, p + len.value).toString('utf8');
      p += len.value;
      if (field === 1) name = value;
      else if (field === 2) rel = value;
    }
    return name ? { name, rel } : null;
  };

  while (pos < buf.length) {
    const key = readVarint(buf, pos);
    if (!key) break;
    pos = key.pos;
    if ((key.value & 0x07) !== 2) break;
    const len = readVarint(buf, pos);
    if (!len) break;
    pos = len.pos;
    if (pos + len.value > buf.length) break;
    const entry = readEntry(buf.slice(pos, pos + len.value));
    pos += len.value;
    if (entry?.name && entry.rel !== null) out.set(entry.name, entry.rel);
  }

  return out.size ? out : null;
}

/** Locate the repo directory (`<main>/.jj/repo`) from anywhere inside any workspace. */
async function resolveRepoDir(start) {
  let dir = path.resolve(start);
  for (let i = 0; i < 40; i++) {
    const marker = path.join(dir, '.jj', 'repo');
    try {
      const st = await fs.stat(marker);
      if (st.isDirectory()) return marker;
      if (st.isFile()) {
        // A linked workspace: the file holds a path (relative to the workspace's .jj/) to the
        // main repo's .jj/repo.
        const rel = (await fs.readFile(marker, 'utf8')).trim();
        const resolved = path.resolve(path.join(dir, '.jj'), rel);
        const st2 = await fs.stat(resolved).catch(() => null);
        if (st2?.isDirectory()) return resolved;
        return null;
      }
    } catch { /* keep walking up */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Is this a usable workspace root? */
async function verifyWorkspace(p) {
  try {
    const st = await fs.stat(p);
    if (!st.isDirectory()) return false;
    await fs.stat(path.join(p, '.jj'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Discover jj workspaces.
 *
 * @returns {{available:boolean, reason:string|null, workstreams:Array, unresolved:Array}}
 */
export async function discoverJjWorkspaces(cwd) {
  const probe = await detectJj(cwd);
  if (!probe.available) {
    return { available: false, reason: probe.reason, workstreams: [], unresolved: [] };
  }

  // 1. Names from the public CLI. A template keeps the output parseable across versions.
  const listed = await jj(['workspace', 'list', '-T', 'name ++ "\\n"'], cwd);
  if (listed.code !== 0) {
    // Fall back to the default human format, then give up cleanly.
    const plain = await jj(['workspace', 'list'], cwd);
    if (plain.code !== 0) {
      return { available: true, reason: 'not-a-jj-repo', workstreams: [], unresolved: [] };
    }
    listed.stdout = plain.stdout.split('\n')
      .map((l) => (l.includes(':') ? l.slice(0, l.indexOf(':')) : ''))
      .filter(Boolean).join('\n');
  }

  const names = listed.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) {
    return { available: true, reason: 'no-workspaces', workstreams: [], unresolved: [] };
  }

  // 2. Paths from the internal index, resolved against the repo dir.
  const repoDir = await resolveRepoDir(cwd);
  let index = null;
  if (repoDir) {
    try {
      index = parseWorkspaceIndex(await fs.readFile(path.join(repoDir, 'workspace_store', 'index')));
    } catch { index = null; }
  }

  const workstreams = [];
  const unresolved = [];

  for (const name of names) {
    const rel = index?.get(name);
    if (!rel || !repoDir) {
      unresolved.push({
        name,
        reason: index ? 'name not present in the jj workspace index' : 'jj workspace index unreadable',
      });
      continue;
    }
    // 3. Verify. An unverifiable path is reported, never guessed at.
    const abs = path.resolve(repoDir, rel);
    if (!(await verifyWorkspace(abs))) {
      unresolved.push({ name, reason: `resolved path is not a jj workspace: ${abs}` });
      continue;
    }
    workstreams.push({
      id: name,
      path: abs,
      vcs: 'jj',
      head: await workspaceCommit(cwd, name),
      branch: null,
      detached: false,
      locked: false,
      prunable: false,
      isPrimary: name === 'default',
      snapshotBased: true,
    });
  }

  return { available: true, reason: null, version: probe.version, workstreams, unresolved };
}

/**
 * The git commit id for a workspace's working-copy commit (`<name>@`).
 *
 * VERIFIED: in a colocated repo jj's `commit_id` IS a git commit — `git cat-file -t` returns
 * "commit" for it. That is what lets every downstream stage (merge-tree, diff, symbol
 * extraction) work on jj workspaces with no changes at all.
 *
 * `--ignore-working-copy` IS LOAD-BEARING, not a performance flag. jj snapshots the working copy
 * on almost any command, which creates a new commit and appends to the operation log — a WRITE.
 * holt promises never to modify the repository it inspects, and that promise has to hold for
 * jj too. The cost is that jj workstreams are analysed as of their last snapshot, which is
 * reported (`snapshotBased`) rather than hidden.
 */
async function workspaceCommit(cwd, name) {
  const r = await jj(
    ['log', '-r', `${name}@`, '--ignore-working-copy', '--no-graph', '-T', 'commit_id'],
    cwd,
  );
  if (r.code !== 0) return null;
  const id = r.stdout.trim();
  return /^[0-9a-f]{40,64}$/.test(id) ? id : null;
}
