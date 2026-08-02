#!/usr/bin/env node
// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — the CI supply-chain and coverage gate.
 *
 * THE CLASS, NOT THE INSTANCE. Three defects were found in this repository's workflows, and each
 * of them is a shape that recurs every time somebody adds a job:
 *
 *   1. COVERAGE BY ACCIDENT. test/e2e/adversarial.test.mjs — the suite that puts a repository into
 *      states nobody designed for — was named in no cross-platform job. It reached Windows and
 *      macOS only by being swept up in `npm test`'s `test/** /*.test.mjs` glob. That is not a
 *      guarantee, and its failure mode is silent: `node --test` on a glob that matches nothing
 *      prints `pass 0` and EXITS 0 (reproduced, node 22). Four separate Windows path bugs have
 *      been found in this project; the corpus most likely to expose a fifth was the one whose
 *      cross-platform run nothing asserted.
 *
 *   2. INHERITED TOKEN SCOPE. ci.yml and dco.yml declared no `permissions:` block at all, so
 *      GITHUB_TOKEN took the repository/organisation default — which can be read-write on every
 *      scope. GitHub's hardening guidance: set the default to read-only and raise it per job.
 *
 *   3. MUTABLE ACTION REFS. Every `uses:` pointed at a moving tag (`@v4`). GitHub Docs:
 *      "Pinning an action to a full-length commit SHA is currently the only way to use an action
 *      as an immutable release." A tag is a pointer its owner can repoint; a repoint (or a
 *      compromise of the publishing account) silently runs new code inside this repository's job,
 *      with this repository's token. OWASP CI/CD-SEC-3 (Dependency Chain Abuse) is the same hole.
 *
 * A GATE WITH NO POSITIVE CONTROL HAS PROVEN NOTHING. `--self-test` copies the real workflow tree
 * to a scratch directory, plants one violation of each rule, and requires the checker to go RED on
 * every one of them and GREEN on the untouched copy. If any planted violation is NOT caught, the
 * self-test fails the build — so this checker can never silently stop checking.
 *
 * Usage:
 *   node scripts/check-ci-hardening.mjs             # check this repository, exit 1 on violations
 *   node scripts/check-ci-hardening.mjs --self-test # prove every rule can go RED, then check
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..');

/** The operating systems the guard corpus must be proven on. Linux alone is what let four Windows
 *  path bugs through. */
export const REQUIRED_OS = ['ubuntu-latest', 'macos-latest', 'windows-latest'];

/** The script whose presence in a job is what makes the guard corpus's cross-platform run a fact
 *  rather than a side effect of a glob. */
const CORPUS_RUNNER = 'scripts/run-guard-corpus.mjs';

/** `test/** /*.test.mjs` is the only pattern `npm test` expands. Anything under test/ that looks
 *  like a test but does not match it never runs, and nothing says so. */
const SUITE_GLOB_RE = /^test\/(?:[^/]+\/)*[^/]+\.test\.mjs$/;
const TEST_LOOKALIKE_RE = /\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/;

/** A 40-character lowercase hex object name. Nothing shorter is immutable enough to pin to. */
const SHA_RE = /^[0-9a-f]{40}$/;

/** `uses:` lines, with any trailing comment captured so the pin can be required to say WHICH
 *  version it is — an unreadable hash with no version is a maintenance trap, and a repository full
 *  of them is one nobody updates. */
const USES_RE = /^\s*(?:-\s+)?uses:\s*(?:["']?)([^"'#\s]+)(?:["']?)\s*(?:#\s*(.*?))?\s*$/;

/** A pin's comment must name a version. `# pinned` is not a version. */
const VERSION_COMMENT_RE = /(?:^|\s)v?\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?(?:\s|$)/;

/**
 * @typedef {{ rule: string, file: string, line: number|null, message: string }} Violation
 */

/**
 * Split a workflow into its top-level job blocks.
 *
 * This is a deliberately small, exact reader for the shape GitHub Actions workflows actually have
 * — `jobs:` at column 0, each job id at one indent level below it — rather than a general YAML
 * parser, because the repository has no YAML dependency and adding one to a gate would put the
 * gate itself on the supply chain this file exists to protect.
 *
 * A READER THAT SEES NOTHING MUST NOT REPORT "CLEAN". `checkAll` refuses to pass when zero jobs
 * were found in a workflow that plainly has a `jobs:` key; see the vacuity rule below.
 *
 * @param {string} text
 * @returns {{ id: string, startLine: number, body: string }[]}
 */
export function jobBlocks(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let inJobs = false;
  let jobIndent = null;
  /** @type {{id:string,startLine:number,lines:string[]}|null} */
  let cur = null;
  const flush = () => { if (cur) out.push({ id: cur.id, startLine: cur.startLine, body: cur.lines.join('\n') }); cur = null; };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (/^jobs:\s*(#.*)?$/.test(raw)) { flush(); inJobs = true; jobIndent = null; continue; }
    if (!inJobs) continue;
    if (raw.trim() === '' || /^\s*#/.test(raw)) { if (cur) cur.lines.push(raw); continue; }
    const indent = raw.length - raw.trimStart().length;
    if (indent === 0) { flush(); inJobs = false; continue; }   // back to a top-level key
    if (jobIndent === null) jobIndent = indent;
    if (indent === jobIndent) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_-]*):\s*(#.*)?$/.exec(raw);
      if (m) { flush(); cur = { id: m[1], startLine: i + 1, lines: [raw] }; continue; }
    }
    if (cur) cur.lines.push(raw);
  }
  flush();
  return out;
}

/**
 * Does this job body actually EXECUTE `needle`, as opposed to merely mentioning it?
 *
 * The distinction is the whole point. A job body carries comments and `name:` strings, and a
 * substring test over the raw text counts those as proof the command runs. It is the same mistake
 * the rest of this file exists to catch: text that resembles evidence, accepted as evidence.
 *
 * A shell only runs what is in a `run:` scalar — either inline (`run: node x.mjs`) or inside a
 * block scalar (`run: |` followed by more-indented lines). Comments are never executed, in either
 * position: `run: |` bodies are shell, and `# …` there is a shell comment.
 *
 * @param {string} body  raw job text, comments included
 * @param {string} needle  the command fragment that must actually execute
 * @returns {boolean}
 */
export function runsCommand(body, needle) {
  const lines = String(body ?? '').split(/\r?\n/);
  let blockIndent = null;   // indent of the `run:` key whose block scalar we are inside, or null

  for (const raw of lines) {
    const trimmed = raw.trim();
    const indent = raw.length - raw.trimStart().length;

    // A block scalar ends at the first non-blank line indented no deeper than its `run:` key.
    if (blockIndent !== null && trimmed !== '' && indent <= blockIndent) blockIndent = null;

    if (blockIndent !== null) {
      // Inside `run: |` — real shell. A `#` comment here is still not executed.
      if (!trimmed.startsWith('#') && raw.includes(needle)) return true;
      continue;
    }

    if (trimmed.startsWith('#')) continue;   // a YAML comment executes nothing

    const m = /^\s*(?:-\s*)?run:\s*(.*)$/.exec(raw);
    if (!m) continue;
    const rest = m[1].trim();
    if (/^[|>][-+0-9]*$/.test(rest)) { blockIndent = indent; continue; }   // `run: |` opens a block
    if (rest.includes(needle)) return true;                                 // inline `run: <cmd>`
  }
  return false;
}

/**
 * The operating systems a job block can run on: every `runs-on:` literal plus every entry of a
 * matrix `os:` list, in either flow (`[a, b]`) or block (`- a`) form.
 *
 * @param {string} body
 * @returns {string[]}
 */
export function jobOperatingSystems(body) {
  const found = new Set();
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const flow = /^\s*os:\s*\[(.+)\]\s*(#.*)?$/.exec(line);
    if (flow) { for (const p of flow[1].split(',')) { const v = p.trim().replace(/^["']|["']$/g, ''); if (v) found.add(v); } continue; }
    if (/^\s*os:\s*(#.*)?$/.test(line)) {
      const base = line.length - line.trimStart().length;
      for (let j = i + 1; j < lines.length; j++) {
        const nxt = lines[j];
        if (nxt.trim() === '' || /^\s*#/.test(nxt)) continue;
        const ind = nxt.length - nxt.trimStart().length;
        const item = /^\s*-\s*(.+?)\s*(#.*)?$/.exec(nxt);
        if (ind > base && item) { found.add(item[1].replace(/^["']|["']$/g, '')); continue; }
        break;
      }
      continue;
    }
    const ro = /^\s*runs-on:\s*(.+?)\s*(#.*)?$/.exec(line);
    if (ro) { const v = ro[1].replace(/^["']|["']$/g, ''); if (!v.includes('${{')) found.add(v); }
  }
  return [...found];
}

/**
 * A workflow declares a top-level `permissions:` key (column 0) — the only place that overrides
 * the inherited repository default for every job in the file.
 *
 * @param {string} text
 */
export function hasTopLevelPermissions(text) {
  return text.split(/\r?\n/).some((l) => /^permissions:\s*(\{\s*\}\s*)?(#.*)?$/.test(l) || /^permissions:\s*\S/.test(l));
}

/**
 * Every `uses:` reference in a workflow, with its trailing version comment.
 *
 * @param {string} text
 * @returns {{ line: number, ref: string, comment: string|null }[]}
 */
export function usesRefs(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = USES_RE.exec(lines[i]);
    if (!m) continue;
    out.push({ line: i + 1, ref: m[1], comment: m[2] ? m[2].trim() : null });
  }
  return out;
}

/**
 * Walk a directory tree, returning POSIX-relative paths.
 *
 * @param {string} root
 * @param {string} rel
 * @returns {Promise<string[]>}
 */
async function walk(root, rel = '') {
  const dir = path.join(root, rel);
  /** @type {string[]} */
  const out = [];
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...await walk(root, child));
    else out.push(child);
  }
  return out;
}

/**
 * Run every rule against a repository root.
 *
 * @param {string} [root]
 * @returns {Promise<Violation[]>}
 */
export async function checkAll(root = REPO_ROOT) {
  /** @type {Violation[]} */
  const v = [];
  const wfDir = path.join(root, '.github', 'workflows');
  let names = [];
  try {
    names = (await fs.readdir(wfDir)).filter((n) => /\.ya?ml$/.test(n)).sort();
  } catch {
    v.push({ rule: 'vacuity', file: '.github/workflows', line: null, message: 'no .github/workflows directory — refusing to report a clean CI tree that does not exist' });
    return v;
  }
  // VACUITY. A checker that found no input must fail, not pass. This is the same defect the rules
  // below exist to catch, one level up.
  if (names.length === 0) {
    v.push({ rule: 'vacuity', file: '.github/workflows', line: null, message: 'no workflow files found — refusing to report "all workflows hardened" having read none' });
    return v;
  }

  let totalUses = 0;
  let totalJobs = 0;
  /** @type {{file:string,id:string,body:string}[]} */
  const allJobs = [];

  for (const name of names) {
    const rel = `.github/workflows/${name}`;
    const text = await fs.readFile(path.join(wfDir, name), 'utf8');

    // RULE: least privilege. Omitting `permissions:` inherits the enterprise/org/repository
    // default, which is broader than any of these workflows needs.
    if (!hasTopLevelPermissions(text)) {
      v.push({ rule: 'permissions', file: rel, line: null, message: 'no workflow-level `permissions:` block — GITHUB_TOKEN inherits the repository default. Declare the minimum this workflow needs (contents: read for a workflow that only reads the repo).' });
    }

    // RULE: immutable action pins.
    for (const u of usesRefs(text)) {
      totalUses++;
      if (u.ref.startsWith('./') || u.ref.startsWith('docker://')) continue; // local / container, not a fetched ref
      const at = u.ref.lastIndexOf('@');
      if (at < 0) {
        v.push({ rule: 'pin', file: rel, line: u.line, message: `\`uses: ${u.ref}\` has no ref at all` });
        continue;
      }
      const ref = u.ref.slice(at + 1);
      if (!SHA_RE.test(ref)) {
        v.push({ rule: 'pin', file: rel, line: u.line, message: `\`uses: ${u.ref}\` is pinned to a MUTABLE ref. A tag or branch can be repointed by whoever owns it; a full-length commit SHA cannot. Use \`${u.ref.slice(0, at)}@<40-char sha> # ${ref}\`.` });
        continue;
      }
      if (!u.comment || !VERSION_COMMENT_RE.test(u.comment)) {
        v.push({ rule: 'pin', file: rel, line: u.line, message: `\`uses: ${u.ref}\` is pinned but does not say to WHAT. Add a trailing version comment (\`# v4.2.2\`) so the pin is reviewable and updatable.` });
      }
    }

    const jobs = jobBlocks(text);
    // VACUITY, per file: a workflow that has a `jobs:` key must yield at least one job, or the
    // reader is broken and every job-level rule below is silently checking nothing.
    if (/^jobs:\s*(#.*)?$/m.test(text) && jobs.length === 0) {
      v.push({ rule: 'vacuity', file: rel, line: null, message: 'the workflow declares `jobs:` but no job block could be read — the checker would silently skip every job-level rule here' });
    }
    totalJobs += jobs.length;
    for (const j of jobs) allJobs.push({ file: rel, id: j.id, body: j.body });
  }

  if (totalUses === 0) {
    v.push({ rule: 'vacuity', file: '.github/workflows', line: null, message: 'no `uses:` line was read from any workflow — the pin rule checked nothing' });
  }
  if (totalJobs === 0) {
    v.push({ rule: 'vacuity', file: '.github/workflows', line: null, message: 'no job was read from any workflow — the cross-platform rule checked nothing' });
  }

  // RULE: the guard corpus exists and is real.
  const manifestPath = path.join(root, '.github', 'guard-corpus.txt');
  /** @type {string[]} */
  let corpus = [];
  try {
    corpus = (await fs.readFile(manifestPath, 'utf8')).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  } catch {
    v.push({ rule: 'corpus', file: '.github/guard-corpus.txt', line: null, message: 'the guard-corpus manifest is missing — the cross-platform guard run has nothing to name' });
  }
  if (corpus.length === 0) {
    v.push({ rule: 'corpus', file: '.github/guard-corpus.txt', line: null, message: 'the guard-corpus manifest names no files. `node --test` with no files exits 0, so an empty corpus would be a GREEN build on every OS having proven nothing.' });
  }
  for (const f of corpus) {
    try {
      const st = await fs.stat(path.join(root, f));
      if (!st.isFile() || st.size === 0) throw new Error('not a usable file');
    } catch {
      v.push({ rule: 'corpus', file: '.github/guard-corpus.txt', line: null, message: `guard-corpus entry does not exist (or is empty): ${f}` });
    }
  }

  // RULE: the corpus is run on every required OS.
  //
  // MATCHED IN EXECUTABLE POSITION ONLY. This filter used to be `j.body.includes(CORPUS_RUNNER)`
  // over the RAW job text — and the job body deliberately carries comment lines (see the parser
  // above, which pushes them so line numbers stay honest). So a PROSE COMMENT naming the runner
  // satisfied the rule. That is not hypothetical: ci.yml already carries such a comment directly
  // above the real step. Deleting only the `run:` line and keeping the comment left this gate
  // printing "the guard corpus runs on ubuntu-latest, macos-latest, windows-latest" and exiting 0
  // while it ran nowhere — the exact absence-of-evidence defect this file exists to catch, inside
  // the check written to catch it, guarding the most platform-sensitive suite in the project.
  //
  // Stripping comments alone would still accept `name: "we run scripts/run-guard-corpus.mjs"`, so
  // the test is stronger: the runner must appear in a line that a shell will actually execute —
  // a `run:` scalar, or a continuation line inside a `run: |` block.
  const runners = allJobs.filter((j) => runsCommand(j.body, CORPUS_RUNNER));
  if (runners.length === 0) {
    v.push({ rule: 'crossplat', file: '.github/workflows/ci.yml', line: null, message: `no job runs ${CORPUS_RUNNER}. The guard corpus would reach Windows and macOS only through \`npm test\`'s glob, which exits 0 when it matches nothing.` });
  } else {
    const covered = new Set();
    for (const j of runners) for (const o of jobOperatingSystems(j.body)) covered.add(o);
    for (const need of REQUIRED_OS) {
      if (!covered.has(need)) {
        v.push({ rule: 'crossplat', file: '.github/workflows/ci.yml', line: null, message: `the guard corpus is never run on ${need} (jobs running it cover: ${[...covered].sort().join(', ') || 'nothing'}). Four Windows path bugs have been found in this project; this corpus is where a fifth shows.` });
      }
    }
  }

  // RULE: no test file may be invisible to the suite. A file named `foo.spec.mjs` or `foo.test.js`
  // under test/ is never expanded by `test/** /*.test.mjs`, so it never runs and nothing reports
  // that it did not — the same absence-of-evidence shape as an empty glob, at file-naming level.
  for (const f of await walk(path.join(root, 'test'))) {
    const rel = `test/${f}`;
    if (!TEST_LOOKALIKE_RE.test(rel)) continue;
    if (!SUITE_GLOB_RE.test(rel)) {
      v.push({ rule: 'invisible-test', file: rel, line: null, message: `looks like a test file but does not match the suite glob \`test/**/*.test.mjs\`, so \`npm test\` never runs it and never says so. Rename it to \`*.test.mjs\` or move it out of test/.` });
    }
  }

  return v;
}

/* ── positive control ─────────────────────────────────────────────────────────────────────── */

/**
 * Copy the parts of the repository this checker reads into a scratch directory.
 *
 * @param {string} src
 * @param {string} dst
 */
async function stage(src, dst) {
  await fs.mkdir(path.join(dst, '.github', 'workflows'), { recursive: true });
  const wfDir = path.join(src, '.github', 'workflows');
  for (const n of await fs.readdir(wfDir)) {
    if (!/\.ya?ml$/.test(n)) continue;
    await fs.copyFile(path.join(wfDir, n), path.join(dst, '.github', 'workflows', n));
  }
  await fs.copyFile(path.join(src, '.github', 'guard-corpus.txt'), path.join(dst, '.github', 'guard-corpus.txt'));
  // The corpus files themselves only need to EXIST and be non-empty for the rules under test.
  const corpus = (await fs.readFile(path.join(src, '.github', 'guard-corpus.txt'), 'utf8'))
    .split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  for (const f of corpus) {
    await fs.mkdir(path.join(dst, path.posix.dirname(f)), { recursive: true });
    await fs.writeFile(path.join(dst, f), '// staged copy for the self-test\n');
  }
}

/**
 * Plant one violation of each rule and require the checker to catch every one.
 *
 * @returns {Promise<{ ok: boolean, lines: string[] }>}
 */
export async function selfTest() {
  const lines = [];
  let ok = true;
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-ci-gate-'));

  /** @type {{name:string, rule:string, mutate:(d:string)=>Promise<void>}[]} */
  const plants = [
    {
      name: 'a workflow with no permissions: block',
      rule: 'permissions',
      mutate: async (d) => {
        const p = path.join(d, '.github', 'workflows', 'ci.yml');
        const t = await fs.readFile(p, 'utf8');
        await fs.writeFile(p, t.split(/\r?\n/).filter((l) => !/^permissions:/.test(l) && !/^ {2}contents: read\s*$/.test(l)).join('\n'));
      },
    },
    {
      name: 'an action pinned to a mutable tag (@v4)',
      rule: 'pin',
      mutate: async (d) => {
        const p = path.join(d, '.github', 'workflows', 'ci.yml');
        const t = await fs.readFile(p, 'utf8');
        await fs.writeFile(p, t.replace(/uses: actions\/checkout@[0-9a-f]{40}[^\n]*/, 'uses: actions/checkout@v4'));
      },
    },
    {
      name: 'a SHA pin with no version comment',
      rule: 'pin',
      mutate: async (d) => {
        const p = path.join(d, '.github', 'workflows', 'ci.yml');
        const t = await fs.readFile(p, 'utf8');
        await fs.writeFile(p, t.replace(/(uses: actions\/checkout@[0-9a-f]{40})[^\n]*/, '$1'));
      },
    },
    {
      name: 'the guard corpus emptied',
      rule: 'corpus',
      mutate: async (d) => { await fs.writeFile(path.join(d, '.github', 'guard-corpus.txt'), '# nothing left\n'); },
    },
    {
      name: 'a guard-corpus entry that does not exist',
      rule: 'corpus',
      mutate: async (d) => {
        const p = path.join(d, '.github', 'guard-corpus.txt');
        await fs.appendFile(p, 'test/e2e/does-not-exist.test.mjs\n');
      },
    },
    {
      name: 'windows-latest dropped from the guard-corpus job',
      rule: 'crossplat',
      mutate: async (d) => {
        const p = path.join(d, '.github', 'workflows', 'ci.yml');
        const t = await fs.readFile(p, 'utf8');
        await fs.writeFile(p, t.replace('os: [ubuntu-latest, macos-latest, windows-latest]', 'os: [ubuntu-latest, macos-latest]'));
      },
    },
    {
      name: 'the guard-corpus step deleted from ci.yml',
      rule: 'crossplat',
      mutate: async (d) => {
        const p = path.join(d, '.github', 'workflows', 'ci.yml');
        const t = await fs.readFile(p, 'utf8');
        await fs.writeFile(p, t.split(/\r?\n/).filter((l) => !l.includes(CORPUS_RUNNER)).join('\n'));
      },
    },
    {
      // THE PLANT THAT PROVES THE RULE THE CHECK ACTUALLY NEEDS. The plant above deletes EVERY
      // line naming the runner, comment included — so it passes even when the check is satisfied
      // by prose, which is a strictly weaker proposition than "the corpus runs". This one deletes
      // ONLY the executable step and leaves the comment standing, which is exactly the state that
      // used to slip through: the gate announced the corpus ran on all three platforms, and exited
      // 0, while nothing ran it.
      name: 'only the guard-corpus RUN step deleted, its comment left in place',
      rule: 'crossplat',
      mutate: async (d) => {
        const p = path.join(d, '.github', 'workflows', 'ci.yml');
        const t = await fs.readFile(p, 'utf8');
        const kept = t.split(/\r?\n/)
          .filter((l) => !(l.includes(CORPUS_RUNNER) && !l.trim().startsWith('#')));
        if (!kept.some((l) => l.includes(CORPUS_RUNNER))) {
          throw new Error('self-test plant is vacuous: no comment naming the runner survived, so '
            + 'this plant is indistinguishable from the delete-every-line plant above');
        }
        await fs.writeFile(p, kept.join('\n'));
      },
    },
    {
      name: 'a test file named so the suite glob can never see it',
      rule: 'invisible-test',
      mutate: async (d) => {
        await fs.mkdir(path.join(d, 'test', 'e2e'), { recursive: true });
        await fs.writeFile(path.join(d, 'test', 'e2e', 'ghost.spec.mjs'), 'export default 1;\n');
      },
    },
  ];

  // NEVER-WORSE, first: the untouched copy must be clean. A checker that fails on a correct tree
  // is as useless as one that never fires, and it is the failure mode that gets gates deleted.
  const clean = path.join(base, 'clean');
  await stage(REPO_ROOT, clean);
  const cleanV = await checkAll(clean);
  if (cleanV.length === 0) {
    lines.push('  GREEN on the unmodified tree (no violation invented)');
  } else {
    ok = false;
    lines.push('  FAILED: the checker reports violations on the UNMODIFIED tree:');
    for (const x of cleanV) lines.push(`    - [${x.rule}] ${x.file}: ${x.message}`);
  }

  for (let i = 0; i < plants.length; i++) {
    const p = plants[i];
    const dir = path.join(base, `plant-${i}`);
    await stage(REPO_ROOT, dir);
    await p.mutate(dir);
    const got = await checkAll(dir);
    const hit = got.filter((x) => x.rule === p.rule);
    if (hit.length > 0) {
      lines.push(`  RED on: ${p.name}  ->  [${p.rule}] ${hit[0].message.slice(0, 96)}`);
    } else {
      ok = false;
      lines.push(`  FAILED: planted "${p.name}" and the checker did NOT report rule "${p.rule}" (reported: ${got.map((x) => x.rule).join(', ') || 'nothing'})`);
    }
  }

  await fs.rm(base, { recursive: true, force: true });
  return { ok, lines };
}

/* c8 ignore start — CLI wrapper */
if (process.argv[1]?.endsWith('check-ci-hardening.mjs')) {
  let bad = false;
  if (process.argv.includes('--self-test')) {
    console.log('positive control — every rule must be able to go RED:');
    const { ok, lines } = await selfTest();
    for (const l of lines) console.log(l);
    if (!ok) {
      console.error('::error::the CI hardening gate failed its own positive control — it cannot be trusted to fire');
      bad = true;
    } else {
      console.log(`positive control passed: ${lines.length - 1} planted violations, all caught`);
    }
  }
  const violations = await checkAll();
  if (violations.length) {
    for (const x of violations) {
      console.error(`::error file=${x.file}${x.line ? `,line=${x.line}` : ''}::[${x.rule}] ${x.message}`);
    }
    console.error(`\n${violations.length} CI hardening violation(s).`);
    bad = true;
  } else {
    console.log('CI hardening: every workflow declares least-privilege permissions, every action is pinned to an immutable SHA, and the guard corpus runs on ' + REQUIRED_OS.join(', ') + '.');
  }
  process.exit(bad ? 1 : 0);
}
/* c8 ignore stop */
