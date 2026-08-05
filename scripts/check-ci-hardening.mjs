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
 *   4. MUTABLE COMPOSITE BOOTSTRAPS. A composite action can be pinned perfectly by its caller and
 *      then throw that guarantee away by running `npm install github:owner/repo#main` (or `#v1`)
 *      inside a `run:` block. The executable bytes are then chosen by a branch or tag at runtime,
 *      not by the caller's SHA. Root action.yml is checked alongside workflow `uses:` lines.
 *
 *   5. CORPUS OWNERSHIP. The four pinned real repositories are a required 4/4 Linux gate. The
 *      portable matrix excludes exactly that file through a denominator-checking runner; it may
 *      not silently run full `npm test` without fixtures. Supported Node 22/24/26 majors must all
 *      occur in that portable matrix.
 *
 *   6. MUTABLE EXECUTABLE INSTALLS. `go install module@latest`, an unversioned `cargo install`,
 *      and `npm install -g tool` execute whatever a registry serves on that run. Exact versions or
 *      commit objects are required, and the positive controls prove each mutable spelling fires.
 *      `permissions: write-all` is rejected at workflow and job scope for the same reason: merely
 *      having a permissions key is not evidence of least privilege.
 *
 *   7. UNMEASURED GIT RUNTIME. Holt's local evidence boundary requires Git 2.45's
 *      `--no-lazy-fetch`. A runner-image label is not evidence of the executable selected on
 *      PATH, so every CI job that installs Holt's test tree must run the live runtime/capability
 *      check first. The same step carries the non-vacuous `/dev/null` hooks-path proof onto the
 *      Windows matrix rather than assuming Git for Windows behaves like a POSIX build.
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

/** Executable runtime proof required before a CI job installs/runs Holt's test tree. */
export const GIT_RUNTIME_CHECK = 'node scripts/check-git-runtime.mjs --verify-inert-hooks';

/** A complete feature proof is executable evidence, not a prose matrix or an ordinary test glob. */
export const FEATURE_PROOF_COMMAND = 'node scripts/run-feature-proof.mjs --out "$RUNNER_TEMP/feature-proof.json"';

/** The omission check must run before the core smoke against the isolated installed package. */
export const OMIT_OPTIONAL_PROOF = 'node scripts/check-omit-optional-install.mjs --prefix "$OPTIONAL_PREFIX"';

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

/** `write-all` defeats the least-privilege default whether declared for the entire workflow or
 * for one job. Only column zero and direct job-property indentation are YAML permission keys;
 * more deeply indented text can be shell/heredoc content and must not be mistaken for policy. */
export function broadWritePermissions(text) {
  const out = [];
  for (const [index, line] of String(text ?? '').split(/\r?\n/).entries()) {
    if (/^(?:permissions:| {4}permissions:)\s*write-all\s*(?:#.*)?$/.test(line)) {
      out.push({ line: index + 1 });
    }
  }
  return out;
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
 * Executable shell lines from YAML `run:` scalars. Full-line YAML/shell comments are excluded;
 * prose must never count either as evidence or as a violation.
 *
 * @param {string} text
 * @returns {{line:number,text:string}[]}
 */
export function executableRunLines(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const out = [];
  let blockIndent = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    const indent = raw.length - raw.trimStart().length;

    if (blockIndent !== null && trimmed !== '' && indent <= blockIndent) blockIndent = null;
    if (blockIndent !== null) {
      if (trimmed && !trimmed.startsWith('#')) out.push({ line: i + 1, text: trimmed });
      continue;
    }
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = /^\s*(?:-\s*)?run:\s*(.*)$/.exec(raw);
    if (!m) continue;
    const rest = m[1].trim();
    if (/^[|>][-+0-9]*$/.test(rest)) { blockIndent = indent; continue; }
    if (rest && !rest.startsWith('#')) out.push({ line: i + 1, text: rest });
  }
  return out;
}

/** A package-manager install from GitHub selects executable code. It is immutable only when the
 * fragment is a full commit object name; no fragment means the repository's default branch. */
const PACKAGE_INSTALL_RE = /\b(?:npm\s+(?:i|install)|pnpm\s+(?:add|install)|yarn\s+(?:add|global\s+add))\b/i;
const GITHUB_PACKAGE_RE = /(?:github:|git\+(?:https|ssh):\/\/github\.com\/|https:\/\/github\.com\/)[^\s"'`#]+(?:#([^\s"'`]+))?/ig;

/**
 * @param {string} text
 * @returns {{line:number,spec:string,ref:string|null}[]}
 */
export function mutableGitHubInstalls(text) {
  const out = [];
  for (const run of executableRunLines(text)) {
    if (!PACKAGE_INSTALL_RE.test(run.text)) continue;
    PACKAGE_INSTALL_RE.lastIndex = 0;
    for (const m of run.text.matchAll(GITHUB_PACKAGE_RE)) {
      const ref = m[1] ?? null;
      if (!ref || !SHA_RE.test(ref)) out.push({ line: run.line, spec: m[0], ref });
    }
  }
  return out;
}

const EXACT_VERSION_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const unquote = (word) => String(word ?? '').replace(/^["']|["']$/g, '');
const localInstallSpec = (spec) => /^(?:\.?\.?[\\/]|[\\/]|file:|\$|\*)/.test(spec)
  || /[\\/]holt-[^\\/]*\.tgz$/.test(spec);

function exactPackageSpec(raw) {
  const spec = unquote(raw);
  if (!spec || localInstallSpec(spec)) return true;
  if (/^(?:github:|git\+(?:https|ssh):\/\/github\.com\/|https:\/\/github\.com\/)/i.test(spec)) {
    const ref = spec.includes('#') ? spec.slice(spec.lastIndexOf('#') + 1) : '';
    return SHA_RE.test(ref);
  }
  const at = spec.lastIndexOf('@');
  return at > 0 && EXACT_VERSION_RE.test(spec.slice(at + 1));
}

/**
 * Executable package-manager installs whose selected code can move between CI runs.
 * Local tarballs/paths are artifacts built by the workflow and are intentionally accepted.
 *
 * @param {string} text
 * @returns {{line:number,manager:string,spec:string}[]}
 */
export function mutableExecutableInstalls(text) {
  const out = [];
  for (const run of executableRunLines(text)) {
    for (const match of run.text.matchAll(/\bgo\s+install\s+([^\s;|&]+)/g)) {
      const spec = unquote(match[1]);
      if (localInstallSpec(spec)) continue;
      const at = spec.lastIndexOf('@');
      const ref = at >= 0 ? spec.slice(at + 1) : '';
      if (!SHA_RE.test(ref) && !EXACT_VERSION_RE.test(ref)) {
        out.push({ line: run.line, manager: 'go', spec });
      }
    }

    if (/\bcargo\s+install\b/.test(run.text) && !/\s--path(?:=|\s)/.test(run.text)) {
      const hasExactVersion = /\s--version(?:=|\s+)["']?=?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?["']?(?:\s|$)/.test(run.text);
      const hasExactRevision = /\s--rev(?:=|\s+)["']?[0-9a-f]{40}["']?(?:\s|$)/.test(run.text);
      if (!hasExactVersion && !hasExactRevision) {
        out.push({ line: run.line, manager: 'cargo', spec: run.text });
      }
    }

    const words = run.text.match(/"[^"]*"|'[^']*'|[^\s]+/g)?.map(unquote) ?? [];
    for (let i = 0; i + 1 < words.length; i++) {
      if (words[i] !== 'npm' || !['i', 'install'].includes(words[i + 1])) continue;
      const tail = words.slice(i + 2);
      if (!tail.includes('-g') && !tail.includes('--global')) continue;
      const control = tail.findIndex((word) => ['&&', '||', '|', ';'].includes(word));
      const installTail = control === -1 ? tail : tail.slice(0, control);
      const specs = installTail.filter((word) => word && !word.startsWith('-'));
      for (const spec of specs) {
        if (!exactPackageSpec(spec)) out.push({ line: run.line, manager: 'npm', spec });
      }
      break;
    }
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
    for (const hit of broadWritePermissions(text)) {
      v.push({ rule: 'permissions', file: rel, line: hit.line, message: '`permissions: write-all` is not least privilege. Declare only the scopes this workflow or job actually uses.' });
    }

    for (const hit of mutableExecutableInstalls(text)) {
      v.push({
        rule: 'mutable-install', file: rel, line: hit.line,
        message: `${hit.manager} installs executable code from a mutable selector (${hit.spec}). Pin an exact version or full commit object; local artifact paths remain allowed.`,
      });
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

  // RULE: every CI job that installs the reviewed dependency/test tree proves the selected Git
  // first. Checking before `npm ci` makes the ordering unambiguous and keeps every later test,
  // package smoke and installed-artifact run under one measured prerequisite. Executable lines
  // only: a comment saying "Git 2.45" is not a runtime check.
  const ciJobs = allJobs.filter((job) => job.file === '.github/workflows/ci.yml');
  for (const job of ciJobs) {
    const commands = executableRunLines(job.body).map((line) => line.text);
    const npmCiAt = commands.findIndex((line) => /(^|\s)npm\s+ci(?:\s|$)/.test(line));
    if (npmCiAt === -1) continue;
    const runtimeAt = commands.findIndex((line) => line.includes(GIT_RUNTIME_CHECK));
    if (runtimeAt === -1) {
      v.push({
        rule: 'git-runtime', file: job.file, line: null,
        message: `job ${job.id} installs Holt's test tree without executing the Git >=2.45 / --no-lazy-fetch and inert-hooks runtime proof`,
      });
    } else if (runtimeAt > npmCiAt) {
      v.push({
        rule: 'git-runtime', file: job.file, line: null,
        message: `job ${job.id} checks Git only after npm ci; the runtime proof must precede Holt's dependency/test setup`,
      });
    }
  }

  // RULE: a composite action may not defeat its caller's immutable `uses: owner/repo@SHA` by
  // fetching executable package bytes from a tag, branch, or default branch at runtime.
  const actionRel = 'action.yml';
  let actionText = null;
  try { actionText = await fs.readFile(path.join(root, actionRel), 'utf8'); } catch {
    v.push({ rule: 'composite-bootstrap', file: actionRel, line: null, message: 'root action.yml is missing — the published composite action contract cannot be checked' });
  }
  if (actionText !== null) {
    for (const hit of mutableGitHubInstalls(actionText)) {
      v.push({
        rule: 'composite-bootstrap', file: actionRel, line: hit.line,
        message: `composite action installs executable GitHub bytes from ${hit.ref ? `mutable ref \`${hit.ref}\`` : 'the mutable default branch'} (${hit.spec}). Execute the caller's checked-out \`github.action_path\` contents, or pin the fetched package to a full 40-character commit SHA.`,
      });
    }
    for (const u of usesRefs(actionText)) {
      if (u.ref.startsWith('./') || u.ref.startsWith('docker://')) continue;
      const at = u.ref.lastIndexOf('@');
      const ref = at < 0 ? '' : u.ref.slice(at + 1);
      if (at < 0 || !SHA_RE.test(ref)) {
        v.push({ rule: 'pin', file: actionRel, line: u.line, message: `composite action \`uses: ${u.ref}\` is not pinned to a full 40-character commit SHA` });
      } else if (!u.comment || !VERSION_COMMENT_RE.test(u.comment)) {
        v.push({ rule: 'pin', file: actionRel, line: u.line, message: `composite action \`uses: ${u.ref}\` needs a trailing version comment` });
      }
    }
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

  // RULE: one job owns the exact 4/4 network corpus; the cross-platform job owns every other test
  // through a runner that proves its N-1 denominator. Missing fixtures must fail the former and
  // must not make the latter falsely red on macOS/Windows.
  const fullJob = allJobs.find((j) => j.file === '.github/workflows/ci.yml' && j.id === 'full');
  if (!fullJob || !fullJob.body.includes('HOLT_REAL_REPOS:')
      || !runsCommand(fullJob.body, 'bash scripts/clone-fixtures.sh "$HOLT_REAL_REPOS"')
      || !runsCommand(fullJob.body, 'npm test')) {
    v.push({ rule: 'real-corpus-owner', file: '.github/workflows/ci.yml', line: null, message: 'the dedicated Linux full job must export HOLT_REAL_REPOS, clone all pinned fixtures, and execute npm test so real-repos.test.mjs is required 4/4 evidence' });
  }

  // RULE: the bounded feature runner is mandatory in the all-backends owner and its write-once
  // JSON plus checksum survive a red completed run. A comment, ordinary `npm test`, or an upload
  // that runs only on success cannot substitute for the source/runtime/denominator-bound artifact.
  const featureProofUpload = fullJob?.body.indexOf('uses: actions/upload-artifact@') ?? -1;
  const featureProofRun = fullJob?.body.indexOf(`run: ${FEATURE_PROOF_COMMAND}`) ?? -1;
  if (!fullJob || !runsCommand(fullJob.body, FEATURE_PROOF_COMMAND)
      || featureProofUpload < featureProofRun
      || !fullJob.body.includes('if: ${{ always() }}')
      || !fullJob.body.includes('if-no-files-found: error')
      || !fullJob.body.includes('${{ runner.temp }}/feature-proof.json')
      || !fullJob.body.includes('${{ runner.temp }}/feature-proof.json.sha256')) {
    v.push({
      rule: 'feature-proof', file: '.github/workflows/ci.yml', line: null,
      message: 'the all-backends job must execute the complete feature-proof runner and always retain its JSON plus SHA-256 sidecar, including a completed invalid run',
    });
  }

  // RULE: `--omit=optional` is a measured filesystem property. A global npm 10 install can retain
  // the optional tree while exiting zero, so use an outside-checkout non-global prefix, prove every
  // declared optional root absent, then drive the core smoke against that exact package path.
  const packageJob = allJobs.find((j) => j.file === '.github/workflows/ci.yml' && j.id === 'package');
  const packageCommands = executableRunLines(packageJob?.body ?? '').map((line) => line.text);
  const omittedInstallAt = packageCommands.findIndex((line) => /npm\s+install\b/.test(line)
    && /--omit=optional\b/.test(line) && /--prefix\s+"\$OPTIONAL_PREFIX"/.test(line)
    && !/(?:^|\s)-(?:g|-global)(?:\s|$)/.test(line));
  const omissionProofAt = packageCommands.findIndex((line) => line.includes(OMIT_OPTIONAL_PROOF));
  const omittedSmokeAt = packageCommands.findIndex((line) => line.includes('node scripts/smoke-installed.mjs --bin "$HOLT_BIN"'));
  if (!packageJob || omittedInstallAt === -1 || omissionProofAt <= omittedInstallAt
      || omittedSmokeAt <= omissionProofAt
      || !packageJob.body.includes('OPTIONAL_PREFIX: ${{ runner.temp }}/')
      || !packageJob.body.includes('HOLT_BIN="$OPTIONAL_PREFIX/node_modules/holt/bin/holt.mjs"')
      || runsCommand(packageJob.body, 'npm install -g --omit=optional')) {
    v.push({
      rule: 'omit-optional', file: '.github/workflows/ci.yml', line: null,
      message: 'packaging must install into a fresh non-global runner-temp prefix, prove every optional root absent, then smoke that exact installed binary',
    });
  }
  for (const job of allJobs.filter((j) => runsCommand(j.body, 'npm test'))) {
    if (!job.body.includes('HOLT_REAL_REPOS:')
        || !runsCommand(job.body, 'bash scripts/clone-fixtures.sh "$HOLT_REAL_REPOS"')) {
      v.push({
        rule: 'real-corpus-owner', file: job.file, line: null,
        message: `job ${job.id} executes full npm test without exporting HOLT_REAL_REPOS and cloning the exact four pinned fixtures; use the N-1 portable runner or own the full 4/4 corpus`,
      });
    }
  }
  const portableJob = allJobs.find((j) => j.file === '.github/workflows/ci.yml' && j.id === 'crossplat');
  if (!portableJob || !runsCommand(portableJob.body, 'node scripts/run-crossplat-suite.mjs')
      || runsCommand(portableJob.body, 'npm test')) {
    v.push({ rule: 'real-corpus-owner', file: '.github/workflows/ci.yml', line: null, message: 'the cross-platform job must run the N-1 portable-suite enumerator, not full npm test without the pinned real-repository fixtures' });
  }
  for (const version of ['22.23.2', '24.19.0', '26.6.0']) {
    if (!portableJob?.body.includes(`node: '${version}'`)) {
      v.push({ rule: 'node-support', file: '.github/workflows/ci.yml', line: null, message: `the portable matrix does not test pinned supported Node ${version}` });
    }
  }

  // RULE: path portability is checked before release day. The three-platform runtime matrix is
  // the independent oracle; this static gate closes the instance class by refusing new raw path
  // comparisons even when the current runner's filesystem happens to make them compare equal.
  const staticJob = allJobs.find((j) => j.file === '.github/workflows/ci.yml' && j.id === 'static');
  if (!staticJob || !runsCommand(staticJob.body, 'npm run lint:paths')) {
    v.push({
      rule: 'path-lint', file: '.github/workflows/ci.yml', line: null,
      message: 'the static CI job must execute `npm run lint:paths`; release-only path lint cannot protect pull requests from macOS/Windows path regressions',
    });
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
  await fs.copyFile(path.join(src, 'action.yml'), path.join(dst, 'action.yml'));
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
      name: 'a workflow that declares permissions: write-all',
      rule: 'permissions',
      mutate: async (d) => {
        const p = path.join(d, '.github', 'workflows', 'ci.yml');
        const t = await fs.readFile(p, 'utf8');
        await fs.writeFile(p, t.replace('permissions:\n  contents: read', 'permissions: write-all'));
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
      name: 'a composite action that installs executable code from a mutable GitHub tag',
      rule: 'composite-bootstrap',
      mutate: async (d) => {
        const p = path.join(d, 'action.yml');
        const t = await fs.readFile(p, 'utf8');
        await fs.writeFile(p, `${t}\n  # positive-control plant\n  steps:\n    - shell: bash\n      run: npm install -g github:example/tool#v1\n`);
      },
    },
    {
      name: 'go install selects latest executable bytes',
      rule: 'mutable-install',
      mutate: async (d) => {
        const p = path.join(d, '.github', 'workflows', 'ci.yml');
        const t = await fs.readFile(p, 'utf8');
        await fs.writeFile(p, t.replace(
          'github.com/go-enry/go-enry/v2/cmd/enry@v2.9.6',
          'github.com/go-enry/go-enry/v2/cmd/enry@latest',
        ));
      },
    },
    {
      name: 'cargo install has no exact version or revision',
      rule: 'mutable-install',
      mutate: async (d) => {
        const p = path.join(d, '.github', 'workflows', 'ci.yml');
        const t = await fs.readFile(p, 'utf8');
        await fs.writeFile(p, t.replace('jj-cli --version 0.43.0', 'jj-cli'));
      },
    },
    {
      name: 'npm global install selects an unversioned registry package',
      rule: 'mutable-install',
      mutate: async (d) => {
        const p = path.join(d, '.github', 'workflows', 'ci.yml');
        const t = await fs.readFile(p, 'utf8');
        await fs.writeFile(p, t.replace('npm install -g opencode-ai@1.18.13', 'npm install -g opencode-ai'));
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
    {
      name: 'the pinned real-repository clone removed from its required 4/4 owner',
      rule: 'real-corpus-owner',
      mutate: async (d) => {
        const p = path.join(d, '.github', 'workflows', 'ci.yml');
        const t = await fs.readFile(p, 'utf8');
        await fs.writeFile(p, t.replace('bash scripts/clone-fixtures.sh "$HOLT_REAL_REPOS"', 'echo fixtures-removed'));
      },
    },
    {
      name: 'the portable matrix runs full npm test without the pinned fixtures',
      rule: 'real-corpus-owner',
      mutate: async (d) => {
        const p = path.join(d, '.github', 'workflows', 'ci.yml');
        const t = await fs.readFile(p, 'utf8');
        await fs.writeFile(p, t.replace('node scripts/run-crossplat-suite.mjs', 'npm test'));
      },
    },
    {
      name: 'pinned supported Node 26 removed from the portable matrix',
      rule: 'node-support',
      mutate: async (d) => {
        const p = path.join(d, '.github', 'workflows', 'ci.yml');
        const t = await fs.readFile(p, 'utf8');
        await fs.writeFile(p, t.replace("          - { os: ubuntu-latest, node: '26.6.0' }\n", ''));
      },
    },
    {
      name: 'the native-path portability lint is removed from pull-request CI',
      rule: 'path-lint',
      mutate: async (d) => {
        const p = path.join(d, '.github', 'workflows', 'ci.yml');
        const t = await fs.readFile(p, 'utf8');
        await fs.writeFile(p, t.replace('        run: npm run lint:paths', '        run: echo native-path-lint-removed'));
      },
    },
    {
      name: 'one CI job inherits the runner Git without a runtime/capability proof',
      rule: 'git-runtime',
      mutate: async (d) => {
        const p = path.join(d, '.github', 'workflows', 'ci.yml');
        const t = await fs.readFile(p, 'utf8');
        await fs.writeFile(p, t.replace(`        run: ${GIT_RUNTIME_CHECK}`, '        run: echo git-runtime-check-removed'));
      },
    },
    {
      name: 'the mandatory feature-proof execution is replaced by prose',
      rule: 'feature-proof',
      mutate: async (d) => {
        const p = path.join(d, '.github', 'workflows', 'ci.yml');
        const t = await fs.readFile(p, 'utf8');
        await fs.writeFile(p, t.replace(`        run: ${FEATURE_PROOF_COMMAND}`, '        # feature proof removed'));
      },
    },
    {
      name: 'feature-proof evidence is uploaded only after success',
      rule: 'feature-proof',
      mutate: async (d) => {
        const p = path.join(d, '.github', 'workflows', 'ci.yml');
        const t = await fs.readFile(p, 'utf8');
        await fs.writeFile(p, t.replace('        if: ${{ always() }}', '        if: ${{ success() }}'));
      },
    },
    {
      name: 'omit-optional smoke runs without proving package roots absent',
      rule: 'omit-optional',
      mutate: async (d) => {
        const p = path.join(d, '.github', 'workflows', 'ci.yml');
        const t = await fs.readFile(p, 'utf8');
        await fs.writeFile(p, t.replace(`          NODE_PATH= ${OMIT_OPTIONAL_PROOF}`, '          echo optional-absence-not-checked'));
      },
    },
    {
      name: 'omit-optional falls back to the npm global install that retained dependencies',
      rule: 'omit-optional',
      mutate: async (d) => {
        const p = path.join(d, '.github', 'workflows', 'ci.yml');
        const t = await fs.readFile(p, 'utf8');
        await fs.writeFile(p, t.replace(
          'npm install --ignore-scripts --omit=optional --prefix "$OPTIONAL_PREFIX" "$1"',
          'npm install -g --omit=optional "$1"',
        ));
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
    console.log('CI hardening: least privilege, immutable executable inputs, measured Git, cross-platform ownership, retained feature proof, and real omit-optional isolation verified on ' + REQUIRED_OS.join(', ') + '.');
  }
  process.exit(bad ? 1 : 0);
}
/* c8 ignore stop */
