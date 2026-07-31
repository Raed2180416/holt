// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — "what did this workstream ADD?"
 *
 * BUILT ON EXISTING OSS, deliberately.
 *
 *   PRIMARY BACKEND: universal-ctags (164 languages here, JSON output, scope-aware,
 *   maintained since 2015). Writing a symbol extractor per language is exactly the kind of
 *   reinvention that eats a month and ships worse. Measured on this box: 15 ms to emit 1,073
 *   tags from a 210 KB file, and it accepts many files per invocation, so the cost is one
 *   process per workstream rather than one per file.
 *
 *   COMPLEMENT: a small key extractor for the config formats ctags does NOT parse.
 *   Verified: ctags emits nothing for a YAML route table. Since "shared hotspot files
 *   (routes, configs, registries)" is the documented top collision class for parallel agents,
 *   a gap there would be a gap in the case that matters most. So this is a complement to
 *   ctags on formats it skips, NOT a competing implementation of what it already does.
 *
 *   FALLBACK: a minimal declaration regex, used only when ctags is absent entirely, so holt
 *   degrades instead of failing. It is labelled 'regex' in output so nobody mistakes reduced
 *   coverage for a clean result.
 *
 * HOW "ADDED" IS COMPUTED — set difference, not line intersection:
 *   symbols(workstream's file on disk) MINUS symbols(base's version of that file).
 *   Line-range intersection was the obvious alternative and it is wrong here: the committed
 *   layer's post-image line numbers come from a merge-tree result, the uncommitted layer's
 *   come from the working file, and the two disagree the moment a file has both. A set
 *   difference is immune to line shifts and answers the actual question.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, pmap } from './git.mjs';

/* ------------------------------------------------------------------ ctags ---- */

let _ctagsProbe = null;

/** Detect universal-ctags once per process. Exuberant ctags is NOT accepted — no JSON. */
export async function detectCtags() {
  if (_ctagsProbe) return _ctagsProbe;
  _ctagsProbe = new Promise((resolve) => {
    execFile('ctags', ['--version'], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve({ available: false, reason: 'ctags-not-found' });
      const out = String(stdout);
      if (!/Universal Ctags/i.test(out)) {
        return resolve({ available: false, reason: 'not-universal-ctags' });
      }
      const m = out.match(/Universal Ctags ([\d.]+)/i);
      execFile('ctags', ['--list-features'], { timeout: 5000 }, (e2, feats) => {
        const hasJson = !e2 && /\bjson\b/.test(String(feats));
        resolve(
          hasJson
            ? { available: true, version: m ? m[1] : 'unknown' }
            : { available: false, reason: 'ctags-without-json-support' },
        );
      });
    });
  });
  return _ctagsProbe;
}

/**
 * Which languages does the INSTALLED ctags actually parse?
 *
 * holt advertises a language count, but that count is a property of the ctags on THIS machine,
 * not of holt. Stock distro packages lag: Ubuntu 24.04 ships universal-ctags 5.9.0, which has no
 * Terraform or Elm parser, so a user there silently gets fewer languages than the README claims.
 * Guessing from a version number would be fragile; asking the instrument what it supports is
 * exact. That is the whole point — never claim coverage the installed toolchain cannot deliver.
 *
 * Returns the set of language names ctags reports, plus the ones holt's own optlib pack adds.
 */
let _langProbe = null;
export async function ctagsLanguages() {
  if (_langProbe) return _langProbe;
  const parse = (stdout) => new Set(
    String(stdout).split('\n').map((l) => l.trim().replace(/\s*\[disabled\]$/, '')).filter(Boolean),
  );
  _langProbe = new Promise((resolve) => {
    execFile('ctags', [...optionFlags(), '--list-languages'], { timeout: 8000 }, (err, stdout) => {
      if (err) {
        // An older ctags can reject the optlib pack outright. Retry WITHOUT it rather than
        // reporting "no languages": a failed probe used to make every capability check fall back
        // to asserting the full corpus, which is exactly the false failure this exists to prevent.
        return execFile('ctags', ['--list-languages'], { timeout: 8000 }, (e2, out2) => {
          if (e2) return resolve({ available: false, languages: new Set(), count: 0 });
          const languages = parse(out2);
          return resolve({ available: true, languages, count: languages.size, degraded: true });
        });
      }
      const languages = new Set(
        String(stdout).split('\n')
          .map((l) => l.trim().replace(/\s*\[disabled\]$/, ''))
          .filter(Boolean),
      );
      resolve({ available: true, languages, count: languages.size });
    });
  });
  return _langProbe;
}

/**
 * Honest coverage report: of the languages holt names in its own corpus, which can the installed
 * ctags actually parse? Used by `holt doctor` so the gap is visible rather than silent.
 */
export async function languageCoverage(expected = []) {
  const probe = await ctagsLanguages();
  if (!probe.available) {
    return { available: false, total: probe.count, missing: [], note: 'ctags unavailable — the regex fallback applies to every language' };
  }
  const missing = expected.filter((l) => !probe.languages.has(l));
  return {
    available: true,
    total: probe.count,
    checked: expected.length,
    supported: expected.length - missing.length,
    missing,
    note: missing.length
      ? `this ctags cannot parse ${missing.join(', ')} — upgrade universal-ctags (distro packages lag; 6.x adds these)`
      : 'every language holt names is supported by this ctags',
  };
}

/**
 * Noise filter for ctags output.
 *
 * ctags reports every nesting level of an object literal. For a registry like
 *   { ARC_FOO: { gate: 'eq1', site: '...' } }
 * it emits ARC_FOO (scope: anonymousObject…) AND gate/site (scope: anonymousObject….ARC_FOO).
 * The registry ENTRY is signal; its inner config values are noise that would otherwise make
 * every registry file look like it collides with every other one.
 *
 * Rule, verified against the real shape:
 *   - drop synthetic anonymous containers (name begins 'anonymousObject')
 *   - drop tags nested two or more levels deep (scope contains a '.')
 * This keeps ARC_FOO, top-level functions, classes and their methods; it drops the container
 * and the inner values.
 */
function isNoise(tag) {
  if (!tag || typeof tag.name !== 'string') return true;
  if (tag.name.startsWith('anonymousObject')) return true;
  if (typeof tag.scope === 'string' && tag.scope.includes('.')) return true;
  if (tag.name.length < 2) return true;
  return false;
}

/** Largest file holt will hand to ctags. Beyond this the tags cost more than they inform. */
const MAX_TAG_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Keep only paths that are real, regular, and worth tagging.
 *
 * FOUND BY RUNNING AGAINST A REAL 39-WORKTREE REPOSITORY, where this filled a 7.5 GB tmpfs.
 * ctags recurses when handed a directory, so a single untracked directory entry reaching this
 * argv turned one invocation into a full-tree index — ~133 MB of working file, times ~100
 * concurrent invocations. The scan produced correct output and exhausted the machine doing it.
 *
 * Three guards, because any one of them alone leaves the failure reachable:
 *   1. stat every path and accept only regular files (kills directory recursion at the source);
 *   2. cap file size (one generated lockfile should not dominate a batch);
 *   3. pass --exclude to ctags as defence in depth, for anything the first two miss.
 */
async function tagWorthy(cwd, relPaths) {
  const keep = [];
  await pmap(relPaths, async (rel) => {
    try {
      const st = await fs.stat(path.join(cwd, rel));
      if (st.isFile() && st.size > 0 && st.size <= MAX_TAG_FILE_BYTES) keep.push(rel);
    } catch {
      /* vanished between scan and tag — not an error, just nothing to tag */
    }
  }, 16);
  return keep;
}

const CTAGS_EXCLUDES = [
  '--exclude=node_modules', '--exclude=.git', '--exclude=target', '--exclude=dist',
  '--exclude=build', '--exclude=vendor', '--exclude=__pycache__', '--exclude=.venv',
];

/**
 * holt's gap-language pack, plus any user pack.
 *
 * Loaded via ctags' own --options, so the 12 languages ctags 6.2.1 does not know
 * (Swift, Scala, Dart, Groovy, Solidity, Zig, Nim, Crystal, F#, Prolog, Dockerfile, GraphQL)
 * flow through the SAME pipeline as the 164 it does. See src/optlib/holt.ctags.
 */
const OPTLIB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'optlib', 'holt.ctags');

function optionFlags() {
  const flags = [`--options=${OPTLIB}`];
  const user = process.env.HOLT_CTAGS_OPTIONS;
  if (user) flags.push(`--options=${user}`); // loaded second, so user definitions win
  return flags;
}

/**
 * Run ctags over a set of files in one invocation.
 * @returns {Promise<Map<string, Array<{name,kind,line,scope}>>>} keyed by the given rel path
 */
export async function ctagsBatch(cwd, relPaths, { timeout = 60_000, chunk = 400, languageForce = null } = {}) {
  const result = new Map();
  if (relPaths.length === 0) return result;

  const usable = await tagWorthy(cwd, relPaths);
  for (const p of relPaths) result.set(p, []); // unusable paths are "no symbols", never "unscanned"
  if (usable.length === 0) return result;

  // argv has an OS limit; chunk so a workstream touching thousands of files still works.
  const chunks = [];
  for (let i = 0; i < usable.length; i += chunk) chunks.push(usable.slice(i, i + chunk));

  for (const group of chunks) {
    const stdout = await new Promise((resolve) => {
      execFile(
        'ctags',
        [
          ...optionFlags(),
          '--output-format=json',
          '--fields=+nKzS',
          // NO `--extras=`. It was here to suppress qualified-name duplicates, and it silently
          // suppressed the fileScope extra too — which is how ctags reports `static` functions
          // and file-local classes. Measured: `class CppClass` came back with "file": true on a
          // default run and VANISHED entirely with `--extras=`. That was a systematic false
          // negative across every language, not just C++: exactly the kind of silence this tool
          // exists to catch, sitting inside the tool. Duplicates are handled by dedup below.
          '--quiet',
          ...(languageForce ? [`--language-force=${languageForce}`] : []),
          ...CTAGS_EXCLUDES,
          '-f', '-',
          ...group,
        ],
        {
          cwd,
          timeout,
          maxBuffer: 128 * 1024 * 1024,
          // ctags writes its own `tags.XXXXXX` working file into TMPDIR. Without this it
          // lands in the system temp filesystem, which on many Linux boxes is RAM-backed.
          env: { ...process.env, TMPDIR: scratchDir() },
        },
        (err, out) => resolve(err && !out ? '' : String(out ?? '')),
      );
    });

    for (const line of stdout.split('\n')) {
      if (!line.startsWith('{')) continue;
      let tag;
      try { tag = JSON.parse(line); } catch { continue; }
      if (tag._type !== 'tag' || isNoise(tag)) continue;
      const file = tag.path;
      if (!result.has(file)) result.set(file, []);
      result.get(file).push({
        name: tag.name,
        kind: tag.kind ?? 'unknown',
        line: tag.line ?? null,
        scope: tag.scope ?? null,
      });
    }
    // Files ctags parsed but found nothing in must still exist as empty, so callers can
    // distinguish "no symbols" from "never scanned". Silence must never mean absence.
    for (const f of group) if (!result.has(f)) result.set(f, []);
  }

  return result;
}

/* ---------------------------------------------- config-format key extractor ---- */

/**
 * ctags does not parse YAML/TOML/INI/env. Those files hold route tables, feature-flag
 * registries and service definitions — precisely the hotspot class. This covers them.
 */
const KEY_FORMATS = new Set(['.yaml', '.yml', '.toml', '.ini', '.env', '.cfg', '.conf', '.properties']);

const KEY_PATTERNS = [
  /^\s*-\s+name\s*:\s*['"]?([A-Za-z_][\w.-]{2,})['"]?\s*$/, // yaml list-of-named-things
  /^\s*\[([A-Za-z_][\w.-]{2,})\]\s*$/,                       // toml/ini section
  /^\s*['"]?([A-Za-z_][\w.-]{2,})['"]?\s*[:=]\s*\S/,         // key: value / key = value
];

const KEY_STOPWORDS = new Set([
  'if', 'for', 'try', 'let', 'var', 'const', 'return', 'else', 'from', 'import', 'export',
  'default', 'true', 'false', 'null', 'none', 'this', 'new', 'and', 'not', 'the', 'type',
  'name', 'value', 'data', 'args', 'opts', 'self', 'http', 'https', 'version', 'description',
]);

export function isKeyFormat(file) {
  const ext = path.extname(String(file)).toLowerCase();
  return KEY_FORMATS.has(ext);
}

/* ------------------------------------------- content-based language detection ---- */

/**
 * Extensions that more than one language legitimately claims.
 *
 * Extension-only mapping is wrong for every one of these, and wrong SILENTLY: ctags maps `.fs`
 * to Forth, so an F# repository yields zero symbols and holt reports "no duplicates" with
 * total confidence. The list comes from Linguist's own ambiguity data; only these pay the cost
 * of content classification, so the common path stays one batched ctags call.
 */
const AMBIGUOUS_EXT = new Set([
  '.fs',   // F# · Forth · GLSL
  '.m',    // Objective-C · MATLAB · Mercury · Mathematica · Limbo
  '.h',    // C · C++ · Objective-C
  '.pl',   // Perl · Prolog
  '.pm',   // Perl · X PixMap
  '.r',    // R · Rebol · Rscript
  '.t',    // Perl · Turing · Terra
  '.v',    // Verilog · Coq · V
  '.d',    // D · DTrace · Makefile
  '.e',    // Eiffel · E
  '.f',    // Fortran · Forth
  '.for',  // Fortran · Forth
  '.inc',  // PHP · Pascal · Assembly · SourcePawn
  '.l',    // Lex · Common Lisp
  '.n',    // Nemerle · Roff
  '.p',    // Pascal · OpenEdge ABL · Gnuplot
  '.pro',  // Prolog · IDL · Qt Project · INI
  '.sc',   // Scala · SuperCollider · Scheme
  '.st',   // Smalltalk · StringTemplate
  '.cls',  // Apex · TeX · OpenEdge ABL · VBA
  '.bas',  // Visual Basic · FreeBasic · BASIC
  '.rpy',  // Ren'Py · Python
  '.spec', // RPM Spec · Ruby
  '.gd',   // GDScript
  '.es',   // JavaScript · Erlang
  '.cs',   // C# · Smalltalk
]);

/** Linguist language name -> universal-ctags language name, where they differ. */
const LINGUIST_TO_CTAGS = new Map(Object.entries({
  'F#': 'FSharp',
  'Objective-C': 'ObjectiveC',
  'Objective-C++': 'C++',
  'C++': 'C++',
  'Common Lisp': 'Lisp',
  'Emacs Lisp': 'Lisp',
  'Shell': 'Sh',
  'Bourne Again Shell': 'Sh',
  'GNU Make': 'Make',
  'Makefile': 'Make',
  'Visual Basic .NET': 'Basic',
  'Visual Basic 6.0': 'Basic',
  'VBA': 'Basic',
  'reStructuredText': 'ReStructuredText',
  'RPM Spec': 'RpmSpec',
  'Gerber Image': null,
}));

let _enryProbe = null;

/** Detect enry (the Go port of GitHub Linguist) once per process. */
export async function detectEnry() {
  if (_enryProbe) return _enryProbe;
  _enryProbe = new Promise((resolve) => {
    execFile('enry', ['-version'], { timeout: 5000 }, (err, stdout, stderr) => {
      const out = `${stdout ?? ''}${stderr ?? ''}`;
      // enry -version prints the version and exits 0; some builds exit non-zero on -version
      // but still print, so presence of output is the real signal.
      if (err && !out.trim()) return resolve({ available: false, reason: 'enry-not-found' });
      // Release builds print a version; `go install`-built binaries print "not-set". Either way
      // the binary works — do not surface a build artefact as if it were the version.
      const raw = out.trim().split('\n')[0] ?? '';
      const version = /not-set|^\s*$/.test(raw) ? '(unversioned build)' : raw;
      resolve({ available: true, version });
    });
  });
  return _enryProbe;
}

/**
 * Resolve ambiguous-extension files to a concrete language by CONTENT.
 * @returns {Promise<Map<string, string|null>>} rel path -> ctags language name (or null)
 */
export async function resolveAmbiguous(cwd, relPaths) {
  const out = new Map();
  if (relPaths.length === 0) return out;

  const probe = await detectEnry();
  if (!probe.available) return out; // caller falls back to extension mapping and reports it

  await pmap(relPaths, async (rel) => {
    const lang = await new Promise((resolve) => {
      execFile('enry', ['-json', rel], { cwd, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => {
          if (err && !stdout) return resolve(null);
          try {
            const parsed = JSON.parse(String(stdout));
            resolve(parsed.language || null);
          } catch { resolve(null); }
        });
    });
    if (!lang) { out.set(rel, null); return; }
    const mapped = LINGUIST_TO_CTAGS.has(lang) ? LINGUIST_TO_CTAGS.get(lang) : lang;
    out.set(rel, mapped);
  }, 12);

  return out;
}

export function isAmbiguous(file) {
  return AMBIGUOUS_EXT.has(path.extname(String(file)).toLowerCase());
}

/**
 * Prose files get NO symbol extraction.
 *
 * ctags indexes Markdown headings as `section` tags, so a repo full of docs yields symbols
 * like "0. What is ALREADY LIVE here — read this before proposing anything". Those are not
 * things two agents collide over in any actionable sense, and on a documentation-heavy repo
 * they swamp the real signal.
 *
 * File-level overlap on prose is still reported — two workstreams both editing README.md is
 * worth knowing. It is only the symbol layer that is suppressed.
 */
const PROSE_FORMATS = new Set(['.md', '.markdown', '.rst', '.txt', '.adoc', '.org']);

export function isProse(file) {
  return PROSE_FORMATS.has(path.extname(String(file)).toLowerCase());
}

export function extractKeys(file, content) {
  const out = [];
  const seen = new Set();
  const lines = String(content).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (!line.trim() || /^\s*[#;]/.test(line)) continue;
    for (const re of KEY_PATTERNS) {
      const m = line.match(re);
      if (m && m[1]) {
        const name = m[1].trim();
        if (KEY_STOPWORDS.has(name.toLowerCase()) || name.length < 3) continue;
        if (seen.has(name)) continue;
        seen.add(name);
        out.push({ name, kind: 'key', line: i + 1, scope: null });
        break;
      }
    }
  }
  return out;
}

/* ------------------------------------------------------- regex fallback ---- */

const FALLBACK_DECL = [
  [/^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, 'function'],
  [/^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class'],
  [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/, 'binding'],
  [/^\s*(?:export\s+)?(?:type|interface|enum)\s+([A-Za-z_$][\w$]*)/, 'type'],
  [/^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)/, 'function'],
  [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/, 'function'],
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/, 'function'],
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+([A-Za-z_][\w]*)/, 'type'],
  [/^\s*['"]?([A-Z][A-Z0-9_]{2,})['"]?\s*[:=]/, 'key'],
];

export function fallbackExtract(file, content) {
  const out = [];
  const seen = new Set();
  const lines = String(content).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (!line.trim()) continue;
    for (const [re, kind] of FALLBACK_DECL) {
      const m = line.match(re);
      if (m && m[1]) {
        const key = `${kind}:${m[1]}`;
        if (!seen.has(key)) { seen.add(key); out.push({ name: m[1], kind, line: i + 1, scope: null }); }
        break;
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------ orchestration ---- */

/**
 * Coarse kind buckets — and this is a correctness fix, not tidiness.
 *
 * MEASURED: universal-ctags reports `export function UNCOMMITTED_ONLY_SYMBOL() {}` as
 * kind "class", not "function". Its JS parser applies a capitalisation heuristic. Keying
 * cross-workstream comparison on the raw kind would therefore mean that two agents who
 * implement the same function with different syntax — `function parseConfig() {}` in one
 * worktree, `const parseConfig = () => {}` in the other — land in different kinds and NEVER
 * match. That is a silent false negative in duplicate and collision detection: holt would
 * report "no duplicates" and be wrong, which is the single worst failure mode for a tool
 * whose whole job is to notice that two agents did the same work.
 *
 * Buckets are deliberately coarse. Distinguishing a class from a function across two
 * independent implementations is not information anyone acts on; knowing both workstreams
 * introduced something called `parseConfig` is.
 */
const KIND_BUCKETS = new Map(Object.entries({
  // callable / declared-entity — ctags conflates these in several languages
  function: 'callable', method: 'callable', class: 'callable', procedure: 'callable',
  subroutine: 'callable', func: 'callable', constructor: 'callable', singletonMethod: 'callable',
  member: 'callable', prototype: 'callable', getter: 'callable', setter: 'callable',
  // types
  struct: 'type', interface: 'type', enum: 'type', typedef: 'type', trait: 'type',
  union: 'type', type: 'type', alias: 'type', record: 'type', protocol: 'type',
  // values, config entries, registry keys
  variable: 'value', constant: 'value', property: 'value', field: 'value', key: 'value',
  macro: 'value', define: 'value', var: 'value', local: 'value', binding: 'value',
  parameter: 'value', enumerator: 'value', section: 'value',
}));

export function normalizeKind(kind) {
  return KIND_BUCKETS.get(String(kind)) ?? 'other';
}

/** Stable identity for cross-workstream comparison. */
export function symbolKey(sym) {
  return `${normalizeKind(sym.kind)}:${sym.name}`;
}

/** Symbols for files as they exist on disk in `dir`. */
export async function symbolsOnDisk(dir, relPaths, backend) {
  const result = new Map();
  if (relPaths.length === 0) return result;

  const ctagsFiles = [];
  const keyFiles = [];
  const ambiguous = [];
  for (const p of relPaths) {
    if (isProse(p)) { result.set(p, []); continue; }
    if (isKeyFormat(p)) { keyFiles.push(p); continue; }
    (isAmbiguous(p) ? ambiguous : ctagsFiles).push(p);
  }

  if (backend.kind === 'ctags' && ambiguous.length) {
    // Ambiguous extensions are classified by content, then tagged with the language FORCED,
    // so ctags cannot fall back to its own (wrong for half of them) extension mapping.
    const resolved = await resolveAmbiguous(dir, ambiguous);
    const byLang = new Map();
    for (const p of ambiguous) {
      const lang = resolved.get(p);
      if (lang === undefined) { ctagsFiles.push(p); continue; } // enry absent: extension mapping
      if (lang === null) { result.set(p, []); continue; }       // classified as not-code
      if (!byLang.has(lang)) byLang.set(lang, []);
      byLang.get(lang).push(p);
    }
    for (const [lang, files] of byLang) {
      const m = await ctagsBatch(dir, files, { languageForce: lang });
      for (const [f, syms] of m) result.set(f, syms);
    }
  } else {
    ctagsFiles.push(...ambiguous);
  }

  if (backend.kind === 'ctags' && ctagsFiles.length) {
    const m = await ctagsBatch(dir, ctagsFiles);
    for (const [f, syms] of m) result.set(f, syms);
  } else if (ctagsFiles.length) {
    await pmap(ctagsFiles, async (p) => {
      const c = await readTextIfSmall(path.join(dir, p));
      result.set(p, c === null ? [] : fallbackExtract(p, c));
    }, 16);
  }

  await pmap(keyFiles, async (p) => {
    const c = await readTextIfSmall(path.join(dir, p));
    result.set(p, c === null ? [] : extractKeys(p, c));
  }, 16);

  for (const p of relPaths) if (!result.has(p)) result.set(p, []);
  return result;
}

const MAX_TEXT_BYTES = 4 * 1024 * 1024;

/**
 * Where holt materialises scratch content.
 *
 * Never inside the repository. Honours HOLT_TMPDIR then TMPDIR before falling back to the
 * platform default, because os.tmpdir() is a RAM-backed tmpfs on many Linux setups and a
 * large scan can fill it — a tool that ENOSPCs the machine it was asked to help with has
 * failed in a way no amount of correct output makes up for.
 */
export function scratchDir() {
  return process.env.HOLT_TMPDIR || process.env.TMPDIR || os.tmpdir();
}

async function readTextIfSmall(abs) {
  try {
    const st = await fs.stat(abs);
    if (!st.isFile() || st.size > MAX_TEXT_BYTES) return null;
    const buf = await fs.readFile(abs);
    if (buf.includes(0)) return null; // binary
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Symbols for files as they exist at `baseOid`.
 *
 * Blobs are materialised into a temp directory OUTSIDE the repository — never into the
 * user's tree — so one batched ctags run can cover them all. The temp dir is always removed.
 */
export async function symbolsAtBase(repoRoot, baseOid, relPaths, backend) {
  const result = new Map();
  if (relPaths.length === 0) return result;

  const tmp = await fs.mkdtemp(path.join(scratchDir(), 'holt-base-'));
  try {
    const materialised = [];
    await pmap(relPaths, async (rel) => {
      const r = await git(['cat-file', '-p', `${baseOid}:${rel}`], { cwd: repoRoot });
      if (r.code !== 0) { result.set(rel, []); return; }  // absent at base = wholly new file
      const dest = path.join(tmp, rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, r.stdout);
      materialised.push(rel);
    }, 12);

    const found = await symbolsOnDisk(tmp, materialised, backend);
    for (const [f, syms] of found) result.set(f, syms);
    for (const p of relPaths) if (!result.has(p)) result.set(p, []);
    return result;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * added = head − base, per file.
 * @returns {Array<{name,kind,file,line,scope}>}
 */
export function diffSymbols(headByFile, baseByFile) {
  const added = [];
  for (const [file, headSyms] of headByFile) {
    const baseKeys = new Set((baseByFile.get(file) ?? []).map(symbolKey));
    for (const s of headSyms) {
      if (!baseKeys.has(symbolKey(s))) added.push({ ...s, file });
    }
  }
  return added;
}

/** Resolve which backend is in play, once. */
export async function resolveBackend({ force } = {}) {
  if (force === 'regex') return { kind: 'regex', label: 'regex-fallback', degraded: true, enry: false };
  const [ctags, enry] = await Promise.all([detectCtags(), detectEnry()]);
  if (!ctags.available) {
    return { kind: 'regex', label: `regex-fallback (${ctags.reason})`, degraded: true, enry: enry.available };
  }
  return {
    kind: 'ctags',
    label: `universal-ctags ${ctags.version}` +
      (enry.available
        ? ' + enry (content-based language detection)'
        : ' — enry ABSENT: ambiguous extensions (.fs .m .h .pl …) fall back to extension mapping and may resolve to the wrong language'),
    degraded: false,
    enry: enry.available,
    ambiguityHandling: enry.available ? 'content-classified' : 'extension-mapped (approximate)',
  };
}
