/**
 * grove — deep duplicate detection (P3), built on jscpd.
 *
 * WHY jscpd AND NOT OUR OWN:
 *   jscpd is a maintained copy/paste detector — Rabin-Karp token matching over 150+ languages,
 *   v5 rewritten in Rust, prebuilt binaries, JSON reporter, optional git-blame enrichment.
 *   Writing a clone detector to sit beside it would be pure reinvention. It is an OPTIONAL
 *   dependency: when absent, grove still reports symbol-identity duplicates and says plainly
 *   that the deep lane did not run.
 *
 * WHAT THIS ADDS OVER SYMBOL IDENTITY:
 *   analyze.duplicates() catches "both workstreams added a symbol named `parseConfig`".
 *   It cannot catch "both workstreams wrote the same 40 lines of logic under different names",
 *   which is the more common shape when two agents independently solve one task. jscpd catches
 *   exactly that.
 *
 * THE CRITICAL DESIGN POINT — feed it ADDED LINES, never whole files:
 *   Two worktrees that each modified a 200 KB registry share ~99% identical BASE content.
 *   Pointed at the files, jscpd would report one enormous clone per pair and the real signal
 *   would be invisible. So each workstream's added lines are materialised into a temp tree
 *   (outside the repository) and jscpd runs over that. A clone spanning two different
 *   workstream directories is then, by construction, duplicated NEW work.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { git, pmap } from './git.mjs';
import { looksGenerated } from './scan.mjs';
import { scratchDir } from './symbols.mjs';

/** Locate the jscpd binary: node_modules/.bin first, then PATH. */
export async function detectJscpd() {
  const candidates = [];
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve('jscpd/package.json');
    candidates.push(path.join(path.dirname(pkg), '..', '.bin', 'jscpd'));
    candidates.push(path.join(path.dirname(pkg), 'bin', 'jscpd'));
  } catch { /* not installed as a dependency */ }
  candidates.push('jscpd');

  for (const bin of candidates) {
    const ok = await new Promise((resolve) => {
      execFile(bin, ['--version'], { timeout: 8000 }, (err, stdout) => {
        resolve(!err && /\d+\.\d+\.\d+/.test(String(stdout)));
      });
    });
    if (ok) {
      const version = await new Promise((resolve) => {
        execFile(bin, ['--version'], { timeout: 8000 }, (e, out) =>
          resolve(String(out ?? '').trim().split(/\s+/).pop() ?? 'unknown'));
      });
      return { available: true, bin, version };
    }
  }
  return { available: false, reason: 'jscpd-not-found' };
}

/** Extract just the '+' lines of a unified diff, per file. */
function addedLinesByFile(unifiedDiff) {
  const byFile = new Map();
  let current = null;
  for (const raw of String(unifiedDiff).split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('diff --git ')) { current = null; continue; }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      current = p === '/dev/null' ? null : p.replace(/^b\//, '');
      if (current && !byFile.has(current)) byFile.set(current, []);
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('@@') || line.startsWith('index ')) continue;
    if (line.startsWith('+') && current) byFile.get(current).push(line.slice(1));
  }
  return byFile;
}

/** Filesystem-safe directory name for a workstream id. */
function safeDirName(id) {
  return String(id).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

/**
 * Materialise every workstream's added lines into a temp tree.
 *
 * `git diff <base> -- <path>` run INSIDE a worktree compares base against the WORKING TREE,
 * so committed and uncommitted additions come back in one call — which is what we want, since
 * duplicated work is duplicated whether or not somebody remembered to commit it.
 */
async function materialiseAdded(scanResult, tmpRoot, { minLines }) {
  const live = scanResult.workstreams.filter((w) => w.ok && w.touched.length);
  const written = [];

  await pmap(live, async (w) => {
    const paths = w.touched.filter((f) => !looksGenerated(f));
    if (!paths.length) return;

    const d = await git(['diff', scanResult.base.oid, '--', ...paths], { cwd: w.path, timeout: 120_000 });
    const byFile = d.code === 0 ? addedLinesByFile(d.stdout) : new Map();

    // Untracked files are wholly added and never appear in a diff.
    for (const u of w.uncommitted.untracked ?? []) {
      if (looksGenerated(u)) continue;
      try {
        const buf = await fs.readFile(path.join(w.path, u));
        if (buf.includes(0)) continue;
        byFile.set(u, buf.toString('utf8').split('\n'));
      } catch { /* unreadable untracked file is not a failure */ }
    }

    for (const [file, lines] of byFile) {
      if (lines.length < minLines) continue;
      const dest = path.join(tmpRoot, safeDirName(w.id), file);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, lines.join('\n'));
      written.push({ workstream: w.id, file, rel: path.join(safeDirName(w.id), file), lines: lines.length });
    }
  }, 6);

  return written;
}

function runJscpd(bin, args, cwd) {
  return new Promise((resolve) => {
    execFile(bin, args, { cwd, timeout: 300_000, maxBuffer: 128 * 1024 * 1024 }, (err, stdout, stderr) => {
      // jscpd exits non-zero when duplicates are found and --exit-code is set; we do not set it,
      // but a non-zero exit still must not be read as "no duplicates".
      resolve({ code: err ? (err.code ?? -1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

/**
 * Deep duplicate detection across workstreams.
 *
 * @returns {{ran: boolean, reason?: string, pairs: Array, clones: number, tool: string}}
 */
export async function deepDuplicates(scanResult, { minTokens = 50, minLines = 5, timeout = 300_000 } = {}) {
  const probe = await detectJscpd();
  if (!probe.available) {
    return {
      ran: false,
      reason: `jscpd unavailable (${probe.reason}) — deep lane did NOT run; symbol-identity duplicates are unaffected`,
      pairs: [], clones: 0, tool: null,
    };
  }

  const tmpRoot = await fs.mkdtemp(path.join(scratchDir(), 'grove-deep-'));
  const outDir = path.join(tmpRoot, '.report');

  try {
    const written = await materialiseAdded(scanResult, tmpRoot, { minLines });
    if (written.length < 2) {
      return {
        ran: true,
        reason: 'fewer than two workstreams had extractable added lines — nothing to compare',
        pairs: [], clones: 0, tool: `jscpd ${probe.version}`, filesCompared: written.length,
      };
    }

    await fs.mkdir(outDir, { recursive: true });
    const res = await runJscpd(
      probe.bin,
      [
        '.', '--reporters', 'json', '--output', outDir,
        '--min-tokens', String(minTokens), '--min-lines', String(minLines),
        '--no-gitignore', '--silent', '--no-colors',
        '--ignore', '**/.report/**',
      ],
      tmpRoot,
    );

    let report = null;
    for (const name of ['jscpd-report.json', 'report.json']) {
      try {
        report = JSON.parse(await fs.readFile(path.join(outDir, name), 'utf8'));
        break;
      } catch { /* try the next known filename */ }
    }
    if (!report) {
      return {
        ran: false,
        reason: `jscpd produced no readable JSON report (exit ${res.code}) — treated as NOT RUN, not as "no duplicates"`,
        pairs: [], clones: 0, tool: `jscpd ${probe.version}`, stderr: res.stderr.slice(0, 500),
      };
    }

    // Attribute each clone to the two workstreams whose directories it spans.
    const ownerOf = (p) => String(p).split(path.sep).filter(Boolean)[0] ?? null;
    const byPair = new Map();
    const clones = report.duplicates ?? report.clones ?? [];

    for (const c of clones) {
      const aPath = c.firstFile?.name ?? c.firstFile?.path ?? c.first?.name;
      const bPath = c.secondFile?.name ?? c.secondFile?.path ?? c.second?.name;
      if (!aPath || !bPath) continue;
      const aw = ownerOf(path.relative(tmpRoot, path.resolve(tmpRoot, aPath)));
      const bw = ownerOf(path.relative(tmpRoot, path.resolve(tmpRoot, bPath)));
      if (!aw || !bw || aw === bw) continue; // a clone inside ONE workstream is not our concern

      const key = aw < bw ? `${aw} ${bw}` : `${bw} ${aw}`;
      if (!byPair.has(key)) byPair.set(key, { a: aw < bw ? aw : bw, b: aw < bw ? bw : aw, clones: [], lines: 0, tokens: 0 });
      const entry = byPair.get(key);
      entry.clones.push({
        aFile: aPath, bFile: bPath,
        lines: c.lines ?? c.linesCount ?? 0,
        tokens: c.tokens ?? c.tokensCount ?? 0,
        fragment: typeof c.fragment === 'string' ? c.fragment.slice(0, 400) : undefined,
      });
      entry.lines += c.lines ?? c.linesCount ?? 0;
      entry.tokens += c.tokens ?? c.tokensCount ?? 0;
    }

    // Map back to families so cross-dispatch waste ranks above expected fan-out overlap.
    const famById = new Map(scanResult.workstreams.map((w) => [safeDirName(w.id), w.family]));
    const realId = new Map(scanResult.workstreams.map((w) => [safeDirName(w.id), w.id]));

    const pairs = [...byPair.values()]
      .map((p) => ({
        a: realId.get(p.a) ?? p.a,
        b: realId.get(p.b) ?? p.b,
        sameFamily: famById.get(p.a) === famById.get(p.b),
        duplicatedLines: p.lines,
        duplicatedTokens: p.tokens,
        cloneCount: p.clones.length,
        classification: famById.get(p.a) === famById.get(p.b) ? 'expected-fanout' : 'cross-dispatch-waste',
        examples: p.clones.slice(0, 3),
      }))
      .sort((x, y) => {
        if (x.sameFamily !== y.sameFamily) return x.sameFamily ? 1 : -1;
        return y.duplicatedLines - x.duplicatedLines;
      });

    return {
      ran: true,
      pairs,
      clones: clones.length,
      filesCompared: written.length,
      tool: `jscpd ${probe.version}`,
      settings: { minTokens, minLines },
    };
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}
